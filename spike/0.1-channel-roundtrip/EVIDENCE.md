# Spike 0.1 — Evidence of PASS

**Date:** 2026-05-22
**Claude Code version:** v2.1.149
**Bun version:** 1.3.13

## Setup verified

- Server: `claude-gh-channel-spike v0.1.0`
- Capability: `experimental['claude/channel']: {}`
- Notification method: `notifications/claude/channel`
- Spawned via: `claude --dangerously-load-development-channels server:spike`
- HTTP listener: `localhost:8788` (POST /tick, GET /health)

## E2E test result

Two ticks fired sequentially via curl, both arrived in Claude's session
as `← spike:` channel events. Claude parsed and reported back exactly as
instructed.

### Trigger 1

```
curl -X POST localhost:8788/tick -d '{"message":"hello from spike test"}'
# Response: {"ok":true,"counter":1,"message":"hello from spike test"}
```

### Claude session (surface:28) captured output

```
❯ Wait for channel events to arrive. When one does, immediately tell me:
  (a) the counter value from meta, (b) the message text from the content.
  Reply with just those two values in a one-line format like
  "counter=N message=...". Do not run any tools.

⏺ Waiting for channel events.

← spike: [spike-tick #1] hello from spike test

⏺ counter=1 message=hello from spike test

← spike: [spike-tick #2] second tick

⏺ counter=2 message=second tick
```

## Findings

1. **Channel events render as `← spike:` lines in the interactive terminal**,
   not as raw `<channel>` tags. The tag form is in Claude's context; the
   terminal shows a readable rendering with the configured `name` as prefix.
2. **Events queue while Claude is processing** and deliver together on
   the next turn. Confirmed by firing tick 2 before sending the "wait for
   next event" prompt — Claude reported tick 2 anyway because it was
   queued and visible on the next turn.
3. **The dev-channel flag is real**, gates with a confirmation prompt,
   spawns the MCP server as a subprocess automatically. No need to start
   the server independently.
4. **Meta `event_type` (with underscore) preserved**; `counter` preserved.
   No additional source key needed — `source="spike"` auto-set from
   server name (per docs).
5. **`mcp.notification()` does NOT return per-message ACK** — it returns
   when written to transport. If Claude isn't attached, events silently
   drop. (Not directly tested here; documented design assumption confirmed.)

## What's still to validate

P0.1 was the cheapest spike — capability declaration + one-way notification.
Still need:

- P0.2: two-way reply tool round-trip
- P0.3: 24h persistent session viability
- P0.4: multi-session broadcast filtering

## Photographic evidence

Terminal screen captures via cmux read-screen captured in this session's
chat log; not separately saved as image files. Reproducible from this
spike dir.
