/**
 * claude-gh-channel — plugin server.
 *
 * Promoted from spike/0.5-gh-roundtrip/server.ts after that spike proved
 * real GH → cloudflared → HMAC verify → notifications/claude/channel
 * round-trip end-to-end. See spike/0.5-gh-roundtrip/EVIDENCE.md for the
 * proof transcript.
 *
 * Architecture:
 *   GitHub.com ──HTTPS POST──► tunnel ──► localhost:8788/webhook
 *                                              │
 *                                  verify HMAC + summarize
 *                                              │
 *                               notifications/claude/channel
 *                                              │
 *                                       Claude session
 *
 * Secret resolution (first hit wins):
 *   1. process.env.GH_WEBHOOK_SECRET
 *   2. ~/.config/claude-gh-channel/secret
 *
 * Run via plugin:
 *   The plugin's .mcp.json registers this as the `gh-channel` MCP server.
 *   When a Claude session loads with `--channels plugin:claude-gh-channel:gh-channel`
 *   (or via /gh-channel-setup), Claude spawns `bun ${CLAUDE_PLUGIN_ROOT}/server/index.ts`
 *   over stdio.
 *
 * IMPORTANT: do NOT log to stdout — that's the MCP transport. Use stderr.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HTTP_PORT = Number(process.env.GH_CHANNEL_HTTP_PORT ?? 8788);
const CONFIG_DIR = join(homedir(), ".config", "claude-gh-channel");
const SECRET_FILE = join(CONFIG_DIR, "secret");

const log = (...args: unknown[]) => console.error("[gh-channel]", ...args);

function resolveSecret(): string {
  if (process.env.GH_WEBHOOK_SECRET) return process.env.GH_WEBHOOK_SECRET;
  if (existsSync(SECRET_FILE)) {
    return readFileSync(SECRET_FILE, "utf8").trim();
  }
  log(
    `FATAL: no secret found. Set GH_WEBHOOK_SECRET env or write one to ${SECRET_FILE}. ` +
      `Run /gh-channel-setup from a Claude session inside this plugin to bootstrap.`,
  );
  process.exit(1);
}

const WEBHOOK_SECRET = resolveSecret();

const server = new Server(
  {
    name: "claude-gh-channel",
    version: "0.1.0",
  },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
    },
    instructions:
      "Background watcher for GitHub PR/issue/review events. Events arrive tagged " +
      "with event_type ∈ {pull_request, issue_comment, pull_request_review, " +
      "pull_request_review_comment}. Each event includes meta: delivery_id, repo, " +
      "action, sender, number, author, html_url, title, plus event-specific fields. " +
      "When you receive one, decide whether to invoke a skill (e.g. pr-review-prep " +
      "when Mark is review-requested) or just acknowledge and wait. Never push, " +
      "merge, approve, or post on GitHub on behalf of the user without confirmation.",
  },
);

server.oninitialized = () => {
  log("client initialized; webhook channel ready");
};

const transport = new StdioServerTransport();
await server.connect(transport);
log("MCP stdio transport connected");

// ────────────────────────────────────────────────────────────────────────────
// HMAC verification (GitHub's `X-Hub-Signature-256: sha256=<hex>`)
// ────────────────────────────────────────────────────────────────────────────

async function verifySignature(body: string, header: string | null): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  const provided = header.slice("sha256=".length);

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const expected = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Event-type-specific summarizers
// ────────────────────────────────────────────────────────────────────────────

type Summary = {
  content: string;
  meta: Record<string, string>;
};

function summarize(
  eventType: string,
  deliveryId: string,
  payload: any,
): Summary | null {
  const repo: string = payload?.repository?.full_name ?? "?";
  const sender: string = payload?.sender?.login ?? "?";
  const action: string = payload?.action ?? "?";

  if (eventType === "pull_request") {
    const pr = payload.pull_request;
    return {
      content: `[PR ${action}] ${repo}#${pr.number} "${pr.title}" by ${pr.user.login}${pr.draft ? " (draft)" : ""} — ${pr.html_url}`,
      meta: {
        delivery_id: deliveryId,
        event_type: eventType,
        summary_kind: "pull_request",
        repo,
        action,
        sender,
        number: String(pr.number),
        author: pr.user.login,
        draft: String(!!pr.draft),
        html_url: pr.html_url,
        title: pr.title,
      },
    };
  }

  if (eventType === "issue_comment") {
    const issue = payload.issue;
    const comment = payload.comment;
    if (!issue?.pull_request) return null; // skip non-PR issue comments
    const snippet = (comment.body ?? "").slice(0, 140).replace(/\s+/g, " ");
    return {
      content: `[PR comment ${action}] ${repo}#${issue.number} by ${comment.user.login}: ${snippet} — ${comment.html_url}`,
      meta: {
        delivery_id: deliveryId,
        event_type: eventType,
        summary_kind: "pr_issue_comment",
        repo,
        action,
        sender,
        number: String(issue.number),
        author: comment.user.login,
        html_url: comment.html_url,
        title: issue.title ?? "",
      },
    };
  }

  if (eventType === "pull_request_review") {
    const pr = payload.pull_request;
    const review = payload.review;
    const snippet = (review.body ?? "").slice(0, 140).replace(/\s+/g, " ");
    return {
      content: `[PR review ${action} state=${review.state}] ${repo}#${pr.number} "${pr.title}" by ${review.user.login}: ${snippet} — ${review.html_url}`,
      meta: {
        delivery_id: deliveryId,
        event_type: eventType,
        summary_kind: "pull_request_review",
        repo,
        action,
        sender,
        number: String(pr.number),
        review_state: review.state ?? "",
        author: review.user.login,
        html_url: review.html_url,
        title: pr.title,
      },
    };
  }

  if (eventType === "pull_request_review_comment") {
    const pr = payload.pull_request;
    const comment = payload.comment;
    const snippet = (comment.body ?? "").slice(0, 140).replace(/\s+/g, " ");
    return {
      content: `[PR review comment ${action}] ${repo}#${pr.number} ${comment.path ?? ""} by ${comment.user.login}: ${snippet} — ${comment.html_url}`,
      meta: {
        delivery_id: deliveryId,
        event_type: eventType,
        summary_kind: "pull_request_review_comment",
        repo,
        action,
        sender,
        number: String(pr.number),
        path: comment.path ?? "",
        author: comment.user.login,
        html_url: comment.html_url,
        title: pr.title,
      },
    };
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP listener
// ────────────────────────────────────────────────────────────────────────────

type DeliveryLog = {
  delivery_id: string;
  event_type: string;
  action: string;
  repo: string;
  sender: string;
  received_at: string;
  emitted: boolean;
  emit_error?: string;
};
const deliveries: DeliveryLog[] = [];
let totalReceived = 0;
let totalEmitted = 0;
let totalRejected = 0;

const httpServer = Bun.serve({
  port: HTTP_PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        port: HTTP_PORT,
        received: totalReceived,
        emitted: totalEmitted,
        rejected: totalRejected,
      });
    }

    if (req.method === "GET" && url.pathname === "/deliveries") {
      return Response.json({
        count: deliveries.length,
        deliveries: deliveries.slice(-50),
      });
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      totalReceived += 1;
      const deliveryId = req.headers.get("x-github-delivery") ?? "no-delivery-id";
      const eventType = req.headers.get("x-github-event") ?? "unknown";
      const sigHeader = req.headers.get("x-hub-signature-256");
      const rawBody = await req.text();

      const ok = await verifySignature(rawBody, sigHeader);
      if (!ok) {
        totalRejected += 1;
        log(`REJECTED delivery_id=${deliveryId} event=${eventType} (bad signature)`);
        return new Response("invalid signature", { status: 401 });
      }

      let payload: any;
      try {
        payload = JSON.parse(rawBody);
      } catch (err) {
        log(`bad JSON for delivery_id=${deliveryId}:`, err);
        return new Response("invalid json", { status: 400 });
      }

      log(
        `received delivery_id=${deliveryId} event=${eventType} action=${payload.action ?? "?"} repo=${payload.repository?.full_name ?? "?"}`,
      );

      if (eventType === "ping") {
        log(`ping zen="${payload.zen}"`);
        return Response.json({ ok: true, pong: true });
      }

      const summary = summarize(eventType, deliveryId, payload);
      const logEntry: DeliveryLog = {
        delivery_id: deliveryId,
        event_type: eventType,
        action: payload.action ?? "",
        repo: payload.repository?.full_name ?? "",
        sender: payload.sender?.login ?? "",
        received_at: new Date().toISOString(),
        emitted: false,
      };
      deliveries.push(logEntry);

      if (!summary) {
        log(`no summary for event=${eventType} action=${payload.action ?? "?"} — skipping emit`);
        return Response.json({ ok: true, emitted: false, reason: "no summary" });
      }

      try {
        await server.notification({
          method: "notifications/claude/channel",
          params: { content: summary.content, meta: summary.meta },
        } as any);
        totalEmitted += 1;
        logEntry.emitted = true;
        log(`emitted notification for delivery_id=${deliveryId}`);
        return Response.json({ ok: true, emitted: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logEntry.emit_error = msg;
        log(`emit failed for delivery_id=${deliveryId}:`, msg);
        return Response.json({ ok: false, error: msg }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

log(`HTTP listener up on http://localhost:${httpServer.port}`);
log(`  POST /webhook  — GitHub webhook receiver (HMAC verified)`);
log(`  GET  /health   — counters`);
log(`  GET  /deliveries — last 50 deliveries`);
