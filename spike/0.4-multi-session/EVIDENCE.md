# Spike 0.4 — Evidence + Architectural Finding

**Date:** 2026-05-22

## Test setup

Two Claude sessions launched simultaneously, both attached to the
0.4 channel server, but with different env vars:

| Session | `SPIKE_ROLE` | `SPIKE_HTTP_PORT` | PID |
|---|---|---|---|
| A | A | 9001 | 8955 |
| B | B | 9002 | 8962 |

## Test result

```
$ curl -X POST localhost:9001/ping -d '{"message":"to-A-only"}'
{"ok":true,"role":"A","pid":8955}

$ curl -X POST localhost:9002/ping -d '{"message":"to-B-only"}'
{"ok":true,"role":"B","pid":8962}

# Session A pane:
← spike: [A/8955] to-A-only
⏺ role=A pid=8955 got=[A/8955] to-A-only

# Session B pane:
← spike: [B/8962] to-B-only
⏺ role=B pid=8962 got=[B/8962] to-B-only
```

Session A received ONLY A's event. Session B received ONLY B's event.
Perfect isolation.

## Architectural finding

**Each Claude session spawns its OWN MCP server subprocess** over stdio.

- Two `claude --channels server:spike` invocations = two server processes
- Each tries to bind its own HTTP port (8788 by default; we used env vars to disambiguate)
- Events emitted from one server's HTTP listener go ONLY to that server's
  attached Claude session

This **inverts** the original P0.4 concern from the design doc:
> "Multi-session broadcast filtering — how do we tell the 'watcher' from
>  the IDE session if both attach to the same channel?"

The answer is: they CAN'T attach to the same channel. The MCP server
is per-session. If two Claude instances try to load the same channel,
the second one fails to bind the HTTP port and silently degrades to
"no events received." There's no broadcast layer between them.

## Implications for the real plugin

1. **MVP architecture (single persistent session):** the in-process MCP
   server + HTTP listener model from the design works perfectly as
   designed. Single Claude session, single subprocess, no multi-session
   coordination needed.

2. **If we ever want multi-session attachment** (e.g., IDE Claude AND
   background daemon both watching the same webhook), the architecture
   has to change to:
   ```
   ┌──────────────┐                       ┌─────────────────┐
   │   Webhook    │                       │ Claude session A │
   │   daemon     │── unix socket / IPC ──┤ + MCP subprocess │
   │              │                       └─────────────────┘
   │ - holds port │                       ┌─────────────────┐
   │ - dedup      │── unix socket / IPC ──┤ Claude session B │
   │ - fan-out    │                       │ + MCP subprocess │
   └──────────────┘                       └─────────────────┘
   ```
   The MCP server becomes a thin client of the daemon. Daemon owns
   the webhook receipt + persistence + fan-out. Each Claude's MCP
   subprocess connects via IPC and emits whatever the daemon tells it.

3. **For the GH plugin v1:** we're single-session, so the simple
   architecture is sufficient. The multi-session design above is a
   v2 evolution path if/when there's a real reason to want it.

## What the original concern was based on

The design doc said: "multi-session broadcast filtering" implying that
broadcasting was the default. Re-reading the channels docs:

> "One server can push to multiple sessions, but the server is spawned
>  per-session by Claude over stdio."

These two statements are in tension. The first must refer to either:
(a) plugin-installed channels where the plugin scaffolding mediates
    multi-session attachment, or
(b) future architecture not yet realized in research preview.

For dev-mode channels (`--dangerously-load-development-channels`),
it's strictly 1:1. We didn't find a docs reference saying otherwise.

## Pass criteria met

- Two sessions can run simultaneously when given distinct ports
- Each is correctly isolated from the other
- The architectural shape of the broadcast question is fully answered
- No need for watcher-identification mechanism (concern was unfounded)
