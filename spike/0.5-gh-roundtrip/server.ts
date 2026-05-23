/**
 * Spike 0.5 — Real GitHub webhook → channel notification, end-to-end.
 *
 * Builds on spikes 0.1/0.2: same MCP-channel-server-over-stdio shape, but the
 * HTTP listener is now a real GH webhook receiver (HMAC-verified) and emits
 * event-type-specific summaries with structured meta.
 *
 * Architecture:
 *   GitHub ──HTTPS POST──► cloudflared tunnel ──► localhost:8788
 *                                                       │
 *                                          verify HMAC + summarize
 *                                                       │
 *                                       notifications/claude/channel
 *                                                       │
 *                                                Claude session
 *
 * Run:
 *   GH_WEBHOOK_SECRET=... claude --dangerously-load-development-channels \
 *     server:bun:/Users/mark/claude-gh-channel/spike/0.5-gh-roundtrip/server.ts
 *
 * IMPORTANT: do NOT log to stdout — that's the MCP transport. Use stderr.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const HTTP_PORT = Number(process.env.SPIKE_HTTP_PORT ?? 8788);
const WEBHOOK_SECRET = process.env.GH_WEBHOOK_SECRET;

const log = (...args: unknown[]) => console.error("[spike-0.5]", ...args);

if (!WEBHOOK_SECRET) {
  log("FATAL: GH_WEBHOOK_SECRET env var is required.");
  process.exit(1);
}

const server = new Server(
  {
    name: "claude-gh-channel-spike",
    version: "0.5.0",
  },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
    },
    instructions:
      "Spike 0.5: real GitHub webhook → channel notifications. " +
      "Events arrive tagged with event_type ∈ {pull_request, issue_comment, " +
      "pull_request_review, pull_request_review_comment}. Each event includes " +
      "meta fields: delivery_id, repo, action, sender, number, html_url, summary_kind. " +
      "When you receive one, briefly state: event_type, repo, action, sender, and " +
      "the html_url. Do not call any tools. Just acknowledge each event in one line.",
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
    enc.encode(WEBHOOK_SECRET!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const expected = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected.length !== provided.length) return false;
  // constant-time compare
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

function summarize(eventType: string, deliveryId: string, payload: any): Summary | null {
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
    const isPR = !!issue?.pull_request;
    if (!isPR) {
      // skip non-PR issue comments for this spike; design doc subscribes
      // only to PR-related event traffic
      return null;
    }
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

      // ping events: GH sends one on webhook creation. Acknowledge and skip.
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
