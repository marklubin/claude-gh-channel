# Spike 0.2 — Evidence of PASS

**Date:** 2026-05-22
**Builds on:** Spike 0.1

## What was added

- `tools: {}` capability declaration
- `ListToolsRequestSchema` / `CallToolRequestSchema` handlers
- `reply` tool with inputSchema { chat_id, text }
- In-memory `replies[]` log surfaced via `GET /replies`
- `chat_id` flowed through meta so Claude can echo it back

## E2E test

```bash
# Trigger
$ curl -s -X POST localhost:8788/tick \
    -H "content-type: application/json" \
    -d '{"message":"test reply","chat_id":"chat-test-1"}'
{"ok":true,"counter":1,"chat_id":"chat-test-1","message":"test reply"}

# Claude pane (instructed: "call reply tool with chat_id and text 'ack counter=N'")
← spike: [spike-tick #1] test reply
  Called spike
⏺ Replied.

# Verify
$ curl -s localhost:8788/replies | jq
{
  "count": 1,
  "replies": [
    {
      "chat_id": "chat-test-1",
      "text": "ack counter=1",
      "received_at": "2026-05-22T23:46:41.084Z"
    }
  ]
}
```

## Findings

1. **Tool registration via standard MCP works inside a channel server.**
   No channel-specific tool ceremony — just `ListToolsRequestSchema` +
   `CallToolRequestSchema`.
2. **Claude correctly extracts meta fields** (`chat_id`, `counter`)
   and passes them to the tool call as instructed by the brief.
3. **Tool name appears as "Called spike"** in the terminal renderer
   (since tools live under the server's namespace), not "Called reply".
   Not a problem for functionality.
4. **Tool result was returned with `content: [{ type: "text", text: "..." }]`**
   per standard MCP — Claude saw it and reported "Replied."

## What this means for the design

The `channel_reply` MCP tool in the plugin design is straightforward —
this exact pattern. Multiple action types (`triage` / `review_draft` /
`comment_draft` / `flagged` / etc.) can be implemented as one tool with a
`action_type` arg, or as separate tools. The spike shows either works.

## What's still to validate

- P0.3: 24h persistent session viability (next)
- P0.4: multi-session broadcast filtering
