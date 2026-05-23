/**
 * claude-gh-channel — plugin server.
 *
 * Config-driven via ~/.config/claude-gh-channel/config.yaml (see config/example.yaml).
 * Real-GH E2E proven by spike/0.5-gh-roundtrip/EVIDENCE.md before M2 rewire.
 *
 * Architecture:
 *   GitHub.com ──HTTPS POST──► tunnel ──► localhost:<http_port>/webhook
 *                                              │
 *                              verify HMAC + subscription-filter + summarize + routing-hints
 *                                              │
 *                               notifications/claude/channel
 *                                              │
 *                                       Claude session
 *
 * Secret resolution (first hit wins):
 *   1. process.env.GH_WEBHOOK_SECRET
 *   2. ~/.config/claude-gh-channel/secret
 *
 * IMPORTANT: do NOT log to stdout — that's the MCP transport. Use stderr.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadConfig, type Config } from "./config";
import { matchSubscription, applyRoutingHints } from "./filters";
import { EventQueue } from "./queue";
import { REPLY_TOOL, makeHandler } from "./reply";

const CONFIG_DIR = join(homedir(), ".config", "claude-gh-channel");
const SECRET_FILE = join(CONFIG_DIR, "secret");

const log = (...args: unknown[]) => console.error("[gh-channel]", ...args);

function resolveSecret(): string {
  if (process.env.GH_WEBHOOK_SECRET) return process.env.GH_WEBHOOK_SECRET;
  if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, "utf8").trim();
  log(
    `FATAL: no secret found. Set GH_WEBHOOK_SECRET or write one to ${SECRET_FILE}. ` +
      `Run /gh-channel-setup to bootstrap.`,
  );
  process.exit(1);
}

const WEBHOOK_SECRET = resolveSecret();

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  log(`FATAL config load: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Hot-reloadable view: code reads from this, /reload swaps it. The frozen
// initial `config` is kept for fields that can't be hot-changed
// (agent_brief baked into MCP instructions, http_port bound on listener).
let live = config;

const HTTP_PORT = Number(process.env.GH_CHANNEL_HTTP_PORT ?? config.runtime.http_port);

const queue = new EventQueue(config.runtime.sqlite_path);

const server = new Server(
  { name: "claude-gh-channel", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: config.agent_brief,
  },
);

const replyHandler = makeHandler(config);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [REPLY_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "channel_reply") {
    throw new Error(`unknown tool: ${req.params.name}`);
  }
  return await replyHandler(req.params.arguments as any);
});

server.oninitialized = async () => {
  log(
    `client initialized; ${live.subscriptions.length} subscription(s), ${live.routing_hints.length} routing hint(s)`,
  );
  // Drain anything queued from a prior session (or that was queued during quiet/pause)
  if (!isQuiet()) {
    const pending = queue.pending();
    if (pending.length > 0) {
      log(`draining ${pending.length} queued event(s) on attach`);
      for (const ev of pending) {
        try {
          const meta = JSON.parse(ev.meta_json) as Record<string, string>;
          // Mark replayed events so Claude knows these are catch-up, not live
          meta["replayed_at"] = new Date().toISOString();
          await server.notification({
            method: "notifications/claude/channel",
            params: { content: ev.content, meta },
          } as any);
          queue.markEmitted(ev.delivery_id);
        } catch (err) {
          log(`drain failed for ${ev.delivery_id}:`, err);
        }
      }
      log(`drain complete`);
    }
  }
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
// Pause / quiet / disabled-repo gates
// ────────────────────────────────────────────────────────────────────────────

function isQuiet(now: number = Date.now()): boolean {
  if (live.runtime.quiet_mode) return true;
  if (live.runtime.pause_until) {
    const until = Date.parse(live.runtime.pause_until);
    if (!Number.isNaN(until) && now < until) return true;
  }
  return false;
}

function isRepoDisabled(repo: string): boolean {
  return live.runtime.disabled_repos.includes(repo);
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
    if (!issue?.pull_request) return null;
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
  filtered_reason?: string;
  emit_error?: string;
};
const deliveries: DeliveryLog[] = [];
let totalReceived = 0;
let totalEmitted = 0;
let totalRejected = 0;
let totalFiltered = 0;
let totalQueued = 0;

const httpServer = Bun.serve({
  port: HTTP_PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      const qstats = queue.stats();
      return Response.json({
        ok: true,
        port: HTTP_PORT,
        received: totalReceived,
        emitted: totalEmitted,
        rejected: totalRejected,
        filtered: totalFiltered,
        queued_in_session: totalQueued,
        quiet: isQuiet(),
        paused_until: live.runtime.pause_until,
        subscriptions: live.subscriptions.length,
        queue: qstats,
      });
    }

    if (req.method === "GET" && url.pathname === "/deliveries") {
      return Response.json({ count: deliveries.length, deliveries: deliveries.slice(-50) });
    }

    if (req.method === "GET" && url.pathname === "/queue") {
      return Response.json({
        stats: queue.stats(),
        pending: queue.pending(50).map(({ meta_json, ...row }) => ({
          ...row,
          meta: JSON.parse(meta_json),
        })),
        recent: queue.recent(20).map(({ meta_json, ...row }) => ({
          ...row,
          meta: JSON.parse(meta_json),
        })),
      });
    }

    if (req.method === "POST" && url.pathname === "/reload") {
      try {
        const fresh = loadConfig(true);
        // Hot-reload via reference swap. Anything that captured `live`
        // at module-init time (subscription filter, routing hints,
        // quiet/pause gates) picks up the new value on next call.
        // The agent_brief baked into MCP `instructions` and the HTTP
        // port bound on Bun.serve are NOT hot-swappable — restart for those.
        live = fresh;
        log(`reloaded config from disk; subs=${fresh.subscriptions.length} hints=${fresh.routing_hints.length}`);
        return Response.json({
          ok: true,
          subscriptions: fresh.subscriptions.length,
          routing_hints: fresh.routing_hints.length,
          note: "agent_brief + http_port changes require server restart",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`reload failed: ${msg}`);
        return Response.json({ ok: false, error: msg }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/replay") {
      const body = (await req.json().catch(() => ({}))) as { delivery_id?: string };
      if (!body.delivery_id) {
        return new Response("delivery_id required", { status: 400 });
      }
      const ev = queue.get(body.delivery_id);
      if (!ev) return new Response("not found", { status: 404 });
      try {
        const meta = JSON.parse(ev.meta_json) as Record<string, string>;
        meta["replayed_at"] = new Date().toISOString();
        meta["replay_reason"] = "manual";
        await server.notification({
          method: "notifications/claude/channel",
          params: { content: ev.content, meta },
        } as any);
        queue.markEmitted(ev.delivery_id);
        log(`replayed delivery_id=${ev.delivery_id}`);
        return Response.json({ ok: true, replayed: ev.delivery_id });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      }
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

      const repo = payload.repository?.full_name ?? "?";
      const logEntry: DeliveryLog = {
        delivery_id: deliveryId,
        event_type: eventType,
        action: payload.action ?? "",
        repo,
        sender: payload.sender?.login ?? "",
        received_at: new Date().toISOString(),
        emitted: false,
      };
      deliveries.push(logEntry);

      // Gate: disabled repo
      if (isRepoDisabled(repo)) {
        totalFiltered += 1;
        logEntry.filtered_reason = "repo_disabled";
        log(`filter: delivery_id=${deliveryId} repo=${repo} is in disabled_repos`);
        return Response.json({ ok: true, emitted: false, reason: "repo_disabled" });
      }

      // Filter: subscription + author + ignore_if
      const sub = matchSubscription(live, repo, eventType, payload);
      if (!sub) {
        totalFiltered += 1;
        logEntry.filtered_reason = "no_subscription_match";
        log(`filter: delivery_id=${deliveryId} no matching subscription (or filtered by author/ignore_if)`);
        return Response.json({ ok: true, emitted: false, reason: "no_subscription_match" });
      }

      const summary = summarize(eventType, deliveryId, payload);
      if (!summary) {
        totalFiltered += 1;
        logEntry.filtered_reason = "no_summary";
        log(`filter: delivery_id=${deliveryId} no summary for event=${eventType} action=${payload.action}`);
        return Response.json({ ok: true, emitted: false, reason: "no_summary" });
      }

      // Routing hints → merge into meta
      const hintMeta = applyRoutingHints(
        live.routing_hints,
        live.user,
        live.vars,
        eventType,
        payload.action ?? null,
        payload,
      );
      Object.assign(summary.meta, hintMeta);

      // Persist to queue (idempotent by delivery_id; GH dedup)
      const newlyQueued = queue.enqueue({
        delivery_id: deliveryId,
        event_type: eventType,
        action: payload.action ?? "",
        repo,
        sender: payload.sender?.login ?? "",
        content: summary.content,
        meta: summary.meta,
      });
      if (!newlyQueued) {
        log(`duplicate delivery_id=${deliveryId} — already in queue, acknowledging`);
        return Response.json({ ok: true, emitted: false, reason: "duplicate" });
      }

      // Gate: quiet / paused → keep in queue, don't emit
      if (isQuiet()) {
        totalQueued += 1;
        logEntry.filtered_reason = "queued_quiet_or_paused";
        log(`queued (quiet/paused): delivery_id=${deliveryId}`);
        return Response.json({ ok: true, emitted: false, queued: true });
      }

      try {
        await server.notification({
          method: "notifications/claude/channel",
          params: { content: summary.content, meta: summary.meta },
        } as any);
        queue.markEmitted(deliveryId);
        totalEmitted += 1;
        logEntry.emitted = true;
        log(
          `emitted notification for delivery_id=${deliveryId}${hintMeta.suggested_skill ? ` skill=${hintMeta.suggested_skill}` : ""}`,
        );
        return Response.json({ ok: true, emitted: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logEntry.emit_error = msg;
        log(`emit failed for delivery_id=${deliveryId}:`, msg);
        // Event stays in queue with emitted=0; next attach drains it.
        return Response.json({ ok: false, error: msg, queued: true }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

log(`HTTP listener up on http://localhost:${httpServer.port}`);
log(`  config=${process.env.GH_CHANNEL_CONFIG ?? join(homedir(), ".config", "claude-gh-channel", "config.yaml")}`);
log(`  POST /webhook  — GitHub webhook receiver (HMAC verified)`);
log(`  GET  /health   — counters + state`);
log(`  GET  /deliveries — last 50 deliveries`);
