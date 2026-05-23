/**
 * Spike 0.2 — Two-way reply tool round-trip.
 *
 * Extends Spike 0.1 by adding a `reply` MCP tool that Claude can call.
 * Server logs every reply it receives. This validates the two-way path
 * needed for "Claude posts a comment back" or "Claude surfaces a draft
 * to the sidebar" in the real plugin.
 *
 * Test flow:
 *   1. Curl POST /tick with { message, chat_id } → server emits notification
 *   2. Claude reads the channel event, calls `reply` tool with chat_id + text
 *   3. Server records the reply in memory (visible via GET /replies and stderr)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const HTTP_PORT = Number(process.env.SPIKE_HTTP_PORT ?? 8788);
const log = (...args: unknown[]) => console.error("[spike-0.2]", ...args);

const server = new Server(
  {
    name: "claude-gh-channel-spike",
    version: "0.2.0",
  },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
      },
      tools: {},
    },
    instructions:
      "Spike 0.2: two-way reply test. Events arrive as <channel source='claude-gh-channel-spike' chat_id='...' event_type='tick'>. " +
      "When you receive a tick event, call the `reply` tool with the chat_id from the meta and a one-line acknowledgment text that includes the counter value. " +
      "Do not run any other tools or take any other actions.",
  },
);

server.oninitialized = () => {
  log("client initialized; channel + reply tool ready");
};

// In-memory reply log for verification
type ReplyRecord = {
  chat_id: string;
  text: string;
  received_at: string;
};
const replies: ReplyRecord[] = [];

// Tool: reply — Claude calls this to send a message back
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send a one-line acknowledgment back over the channel. Use the chat_id from the inbound event.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: {
            type: "string",
            description: "The conversation/chat ID from the inbound event meta",
          },
          text: {
            type: "string",
            description: "The reply text to send",
          },
        },
        required: ["chat_id", "text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "reply") {
    throw new Error(`unknown tool: ${req.params.name}`);
  }
  const args = req.params.arguments as { chat_id: string; text: string };
  const record: ReplyRecord = {
    chat_id: args.chat_id,
    text: args.text,
    received_at: new Date().toISOString(),
  };
  replies.push(record);
  log("received reply:", record);
  return {
    content: [
      {
        type: "text",
        text: `reply recorded for chat_id=${args.chat_id}`,
      },
    ],
  };
});

let tickCounter = 0;

async function emitTick(message: string, chatId: string) {
  tickCounter += 1;
  const content = `[spike-tick #${tickCounter}] ${message}`;
  const meta = {
    event_type: "tick",
    counter: String(tickCounter),
    chat_id: chatId,
    emitted_at: new Date().toISOString(),
  };
  log("emitting notification", { counter: tickCounter, chat_id: chatId });
  await server.notification({
    method: "notifications/claude/channel",
    params: { content, meta },
  } as any);
  log("notification sent");
}

const transport = new StdioServerTransport();
await server.connect(transport);
log("MCP stdio transport connected");

const httpServer = Bun.serve({
  port: HTTP_PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/tick") {
      let body: { message?: string; chat_id?: string } = {};
      try {
        body = (await req.json()) as { message?: string; chat_id?: string };
      } catch {
        /* ok */
      }
      const message = body.message ?? "ping";
      const chatId = body.chat_id ?? `chat-${tickCounter + 1}`;
      await emitTick(message, chatId);
      return Response.json({
        ok: true,
        counter: tickCounter,
        chat_id: chatId,
        message,
      });
    }

    if (req.method === "GET" && url.pathname === "/replies") {
      return Response.json({ count: replies.length, replies });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        tickCounter,
        replyCount: replies.length,
        port: HTTP_PORT,
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

log(`HTTP up on http://localhost:${httpServer.port}`);
log(`  POST /tick { message, chat_id } -> emit notification`);
log(`  GET  /replies -> view replies Claude has sent`);
log(`  GET  /health -> status`);
