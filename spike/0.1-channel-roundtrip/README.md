# Spike 0.1 — Channel capability + notification round-trip

**Goal:** validate that an MCP server declaring `claude/channel` capability
can push events into a Claude Code session attached via
`--dangerously-load-development-channels`, and that those events visibly
appear in Claude's `<channel>` tag.

## Files

- `server.ts` — MCP stdio server + Bun HTTP listener on `:8788`
- `.mcp.json` — registers `spike` server pointing at `./server.ts`
- This README

## Run

In one terminal, from this directory:

```bash
claude --dangerously-load-development-channels server:spike
```

Claude Code spawns `server.ts` as a subprocess (over stdio MCP).
The HTTP listener inside the server comes up on `localhost:8788`.

In another terminal:

```bash
# Health check
curl -s localhost:8788/health | jq

# Trigger a tick — Claude should see this as a <channel source="spike"> event
curl -s -X POST localhost:8788/tick \
  -H "content-type: application/json" \
  -d '{"message":"hello from curl"}' | jq
```

In the Claude pane, you should see a `<channel source="spike">`
event with content like `[spike-tick #1] hello from curl` and
attributes including `event_type="tick"`, `counter="1"`, etc.

## Pass criteria

- HTTP `POST /tick` returns 200 with `{ ok: true, counter: N }`
- Claude session shows the channel event in context
- Claude can describe what it received (counter value, message text)

## Fail modes & diagnosis

- **`curl` returns connection refused**: server didn't bind. Check Claude
  session for spawn errors. Look at `~/.claude/debug/<session>.txt`.
- **`curl` succeeds, no event in Claude**: `/mcp` in Claude session to
  check server status. "Failed to connect" → import or dependency error.
- **Channel listed but events ignored**: capability declaration wrong, or
  `channelsEnabled` org policy blocking.

## Done when

E2E proof captured via cmux read-screen of a secondary Claude pane
receiving a tick event.
