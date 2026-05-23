/**
 * Spike 0.4 — Multi-session architecture exploration.
 *
 * Question: can one channel server broadcast to multiple Claude sessions?
 *
 * Architecture finding: each Claude session spawns its own MCP subprocess
 * over stdio. Two `claude --channels` instances = two server processes,
 * both trying to bind the same HTTP port. Native broadcast is not possible.
 *
 * This spike validates that finding by:
 *   1. Letting each server instance read SPIKE_HTTP_PORT + SPIKE_ROLE env vars
 *   2. The role identifier (env or in-instructions) helps Claude self-identify
 *   3. Confirms each session has its own isolated channel server subprocess
 *
 * Real-world implication: for the GH plugin, we'd need a separate
 * webhook-daemon process and a thin MCP client. This file documents that
 * decision rather than implementing the daemon (out of scope for P0).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const HTTP_PORT = Number(process.env.SPIKE_HTTP_PORT ?? 8788);
const ROLE = process.env.SPIKE_ROLE ?? "default";
const PID = process.pid;

const log = (...args: unknown[]) =>
  console.error(`[spike-0.4 role=${ROLE} pid=${PID}]`, ...args);

const server = new Server(
  { name: `claude-gh-channel-spike-${ROLE}`, version: "0.4.0" },
  {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions:
      `Spike 0.4 multi-session test. You are running with channel role="${ROLE}" pid=${PID}. ` +
      `When you receive a channel event, immediately respond with exactly: ` +
      `"role=${ROLE} pid=${PID} got=<event-content>". Do nothing else.`,
  },
);

server.oninitialized = () => {
  log("client initialized");
};

async function emitPing(message: string) {
  log(`emit ping: ${message}`);
  try {
    await server.notification({
      method: "notifications/claude/channel",
      params: {
        content: `[${ROLE}/${PID}] ${message}`,
        meta: {
          event_type: "ping",
          role: ROLE,
          pid: String(PID),
          emitted_at: new Date().toISOString(),
        },
      },
    } as any);
  } catch (err) {
    log("emit failed:", err);
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
log("MCP connected");

try {
  const httpServer = Bun.serve({
    port: HTTP_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/ping") {
        let body: { message?: string } = {};
        try {
          body = (await req.json()) as { message?: string };
        } catch {
          /* ok */
        }
        await emitPing(body.message ?? "ping");
        return Response.json({ ok: true, role: ROLE, pid: PID });
      }
      if (req.method === "GET" && url.pathname === "/whoami") {
        return Response.json({ role: ROLE, pid: PID, port: HTTP_PORT });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  log(`HTTP up on http://localhost:${httpServer.port} as role=${ROLE}`);
} catch (err: any) {
  log(`HTTP bind FAILED on port ${HTTP_PORT}:`, err.message);
  log("This is expected if a previous instance already holds the port.");
  log(
    "Architecture conclusion: each Claude session = separate MCP subprocess.",
  );
  // Still keep the MCP transport alive even without HTTP — Claude can still get notifications
  // emitted through stderr-based debugging.
}
