/**
 * Spike 0.3 — Long-running background session viability.
 *
 * Server auto-emits heartbeat notifications every HEARTBEAT_INTERVAL_MS.
 * Claude is instructed to call `heartbeat_ack` tool on each one.
 * Server tracks: emits, acks, lag distribution, last-ack age.
 *
 * Pass criteria (initial, ~30 min):
 *   - All emits get acked within 30s
 *   - Round-trip lag stable (not growing)
 *   - No transport errors / silent drops
 *
 * Pass criteria (24h):
 *   - All / nearly all emits still acked
 *   - Claude session still responsive
 *   - Process memory stable
 *
 * Test:
 *   - GET /metrics returns counters + lag distribution
 *   - GET /health returns ok if last ack within 2x interval
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const HTTP_PORT = Number(process.env.SPIKE_HTTP_PORT ?? 8788);
const HEARTBEAT_INTERVAL_MS = Number(
  process.env.SPIKE_HEARTBEAT_INTERVAL_MS ?? 60_000, // 60s default for spike sanity
);
const START_DELAY_MS = Number(process.env.SPIKE_START_DELAY_MS ?? 10_000);

const log = (...args: unknown[]) => console.error("[spike-0.3]", ...args);

const server = new Server(
  { name: "claude-gh-channel-spike", version: "0.3.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      "Spike 0.3: long-running viability. " +
      "Heartbeat events arrive every minute as <channel source='claude-gh-channel-spike' " +
      "event_type='heartbeat' beat_id='...'>. " +
      "On every heartbeat, immediately call the `heartbeat_ack` tool with the beat_id from the meta. " +
      "Do not say anything, do not run any other tools, do not call reply. Just ack the beat_id. " +
      "Keep doing this for as long as heartbeats arrive.",
  },
);

server.oninitialized = () => {
  log("client initialized; starting heartbeat after start delay");
  setTimeout(startHeartbeat, START_DELAY_MS);
};

// Metrics
type Beat = {
  beat_id: string;
  emitted_at: number;
  acked_at: number | null;
};
const beats: Beat[] = [];
let totalAcks = 0;
let totalLagMs = 0;
let maxLagMs = 0;
const startedAt = Date.now();

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "heartbeat_ack",
      description:
        "Acknowledge a heartbeat event. Pass the beat_id from the inbound event meta.",
      inputSchema: {
        type: "object",
        properties: {
          beat_id: {
            type: "string",
            description: "The beat_id from the heartbeat event meta",
          },
        },
        required: ["beat_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "heartbeat_ack") {
    throw new Error(`unknown tool: ${req.params.name}`);
  }
  const args = req.params.arguments as { beat_id: string };
  const beat = beats.find((b) => b.beat_id === args.beat_id);
  const now = Date.now();
  if (!beat) {
    log("ack for unknown beat_id:", args.beat_id);
    return {
      content: [{ type: "text", text: `unknown beat_id: ${args.beat_id}` }],
    };
  }
  if (beat.acked_at !== null) {
    log("duplicate ack for beat_id:", args.beat_id);
    return {
      content: [{ type: "text", text: `already acked: ${args.beat_id}` }],
    };
  }
  beat.acked_at = now;
  const lag = now - beat.emitted_at;
  totalAcks += 1;
  totalLagMs += lag;
  if (lag > maxLagMs) maxLagMs = lag;
  log(
    `ack beat_id=${args.beat_id} lag=${lag}ms acks=${totalAcks}/${beats.length}`,
  );
  return {
    content: [{ type: "text", text: `acked beat_id=${args.beat_id}` }],
  };
});

async function emitHeartbeat() {
  const beat_id = `beat-${beats.length + 1}-${Math.random().toString(36).slice(2, 8)}`;
  const beat: Beat = { beat_id, emitted_at: Date.now(), acked_at: null };
  beats.push(beat);
  log(`emitting heartbeat beat_id=${beat_id} (#${beats.length})`);
  try {
    await server.notification({
      method: "notifications/claude/channel",
      params: {
        content: `heartbeat #${beats.length} beat_id=${beat_id}`,
        meta: {
          event_type: "heartbeat",
          beat_id,
          sequence: String(beats.length),
          emitted_at: new Date(beat.emitted_at).toISOString(),
        },
      },
    } as any);
  } catch (err) {
    log("heartbeat emit failed:", err);
  }
}

function startHeartbeat() {
  log(`heartbeat starting; interval=${HEARTBEAT_INTERVAL_MS}ms`);
  void emitHeartbeat(); // first one immediately
  setInterval(() => void emitHeartbeat(), HEARTBEAT_INTERVAL_MS);
}

const transport = new StdioServerTransport();
await server.connect(transport);
log("MCP stdio transport connected");

const httpServer = Bun.serve({
  port: HTTP_PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/metrics") {
      const unacked = beats.filter((b) => b.acked_at === null);
      const avgLag = totalAcks > 0 ? Math.round(totalLagMs / totalAcks) : 0;
      const lastBeat = beats[beats.length - 1];
      const ageOfLastAck = lastBeat?.acked_at
        ? Date.now() - lastBeat.acked_at
        : null;
      return Response.json({
        runtime_ms: Date.now() - startedAt,
        runtime_human: humanize(Date.now() - startedAt),
        heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
        emits: beats.length,
        acks: totalAcks,
        unacked: unacked.length,
        ack_rate: beats.length > 0 ? totalAcks / beats.length : 0,
        avg_lag_ms: avgLag,
        max_lag_ms: maxLagMs,
        last_ack_age_ms: ageOfLastAck,
        unacked_beats: unacked.map((b) => ({
          beat_id: b.beat_id,
          age_ms: Date.now() - b.emitted_at,
        })),
      });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      const lastBeat = beats[beats.length - 1];
      const healthy =
        beats.length === 0 ||
        (lastBeat?.acked_at !== null &&
          Date.now() - lastBeat.acked_at < HEARTBEAT_INTERVAL_MS * 2);
      return Response.json({ ok: healthy, emits: beats.length, acks: totalAcks });
    }

    if (req.method === "POST" && url.pathname === "/emit-now") {
      await emitHeartbeat();
      return Response.json({ ok: true, emits: beats.length });
    }

    return new Response("Not found", { status: 404 });
  },
});

log(`HTTP up on http://localhost:${httpServer.port}`);
log(`  GET /metrics, GET /health, POST /emit-now`);

function humanize(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h${m}m${sec}s`;
}
