/**
 * Spike 0.1 — Channel capability + notification round-trip.
 *
 * Goal: validate that an MCP server declaring `claude/channel` capability
 * can push events into a Claude Code session attached via --channels, and
 * that those events visibly appear in Claude's `<channel>` tag.
 *
 * Architecture:
 *   - MCP server over stdio (spawned by `claude --channels`)
 *   - Side HTTP listener on port 8788 (POST /tick) to manually trigger emits
 *   - When /tick fires, server sends a notifications/claude/channel
 *
 * IMPORTANT: do NOT log to stdout — that's the MCP transport. Use stderr.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const HTTP_PORT = Number(process.env.SPIKE_HTTP_PORT ?? 8788);

const log = (...args: unknown[]) => console.error("[spike-0.1]", ...args);

const server = new Server(
  {
    name: "claude-gh-channel-spike",
    version: "0.1.0",
  },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
      },
    },
    instructions:
      "Spike 0.1: this is the channel round-trip test. When you receive a notification " +
      "tagged 'spike-tick', acknowledge it by stating the value of the meta.counter field. " +
      "This proves notifications/claude/channel round-trip from this server's HTTP tick " +
      "endpoint into your session.",
  },
);

server.oninitialized = () => {
  log("client initialized; channel ready");
};

let tickCounter = 0;

async function emitTick(message: string) {
  tickCounter += 1;
  const content = `[spike-tick #${tickCounter}] ${message}`;
  // Note: `source` is auto-set from server name (per channels-reference); don't include it.
  // Meta keys must be letters/digits/underscores; hyphens are silently dropped.
  const meta = {
    event_type: "tick",
    counter: String(tickCounter),
    emitted_at: new Date().toISOString(),
  };
  log("emitting notification", { counter: tickCounter, message });
  try {
    await server.notification({
      method: "notifications/claude/channel",
      params: {
        content,
        meta,
      },
    } as any);
    log("notification sent");
  } catch (err) {
    log("notification failed:", err);
    throw err;
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
log("MCP stdio transport connected; listening on stdin/stdout");

const httpServer = Bun.serve({
  port: HTTP_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/tick") {
      let body: { message?: string } = {};
      try {
        body = (await req.json()) as { message?: string };
      } catch {
        // no body or invalid JSON is fine; use default message
      }
      const message = body.message ?? "ping";
      await emitTick(message);
      return new Response(
        JSON.stringify({ ok: true, counter: tickCounter, message }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return new Response(
        JSON.stringify({ ok: true, tickCounter, port: HTTP_PORT }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response("Not found", { status: 404 });
  },
});

log(`HTTP listener up on http://localhost:${httpServer.port}`);
log(`  POST /tick { "message": "..." } to emit a notification`);
log(`  GET  /health for status`);
