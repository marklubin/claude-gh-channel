# Spike 0.5 — Evidence of PASS (real GitHub → Claude E2E)

**Date:** 2026-05-22
**Claude Code:** v2.1.149 (Opus 4.7)
**Bun:** 1.3.13
**Tunnel:** cloudflared 2026.5.0 (quick tunnel — `https://marked-motor-fat-hear.trycloudflare.com`)
**Repo:** `marklubin/claude-gh-channel` (private), webhook id `628940455`
**Test PR:** `marklubin/claude-gh-channel#1`

## What's new vs 0.1/0.2/0.4

All prior spikes drove the HTTP listener with `curl localhost:8788/tick`. That
proved the channel mechanic but not the actual integration target. 0.5 closes
the loop:

```
GitHub.com ── HTTPS POST + X-Hub-Signature-256 ──► cloudflared quick tunnel
                                                           │
                                                  localhost:8788/webhook
                                                           │
                                         HMAC verify + event-type summarize
                                                           │
                                             notifications/claude/channel
                                                           │
                                                  Claude session (Opus 4.7)
```

Every hop is real: real GH POSTs, real HMAC-SHA256 signature on each delivery,
real Cloudflare tunnel, real MCP subprocess spawned by Claude.

## Setup

1. Generated 32-byte hex webhook secret to `~/.config/claude-gh-channel/spike-0.5-secret` (mode 0600).
2. Started cloudflared quick tunnel pointed at `http://localhost:8788`.
3. Registered repo webhook via `gh api -X POST repos/marklubin/claude-gh-channel/hooks` with:
   - `events: [pull_request, issue_comment, pull_request_review, pull_request_review_comment]`
   - `content_type: json`
   - `secret: <generated>`
4. Launched Claude in a cmux side pane:
   ```
   GH_WEBHOOK_SECRET=… claude --dangerously-load-development-channels server:gh-roundtrip
   ```
   The MCP server (`spike/0.5-gh-roundtrip/server.ts`) is registered in this
   spike's `.mcp.json` as `gh-roundtrip`. Claude spawned `bun ./server.ts` as
   a subprocess; that subprocess bound `127.0.0.1:8788`.
5. Primed the Claude session with: "Wait for channel events. When one arrives,
   reply with a single line containing: event_type, repo, action, sender,
   html_url. Do not call any tools."

## Test triggers

All triggered from outside the Claude pane via `gh` CLI / `gh api`:

| # | Event | Trigger | GH delivery_id |
|---|---|---|---|
| 1 | `pull_request` action=opened | `gh pr create` | `12f5a460-5640-11f1-81aa-adcbca6a5d58` |
| 2 | `issue_comment` action=created (on PR) | `gh pr comment 1 --body …` | `1bb04ab0-5640-11f1-96c2-7975c81d89df` |
| 3 | `pull_request_review` action=submitted (state=commented) | `gh pr review 1 --comment --body …` | `2211ca00-5640-11f1-82fa-8583d4fc3462` |
| 4 | `pull_request_review` action=submitted (auto from inline) | `gh api … pulls/1/comments` (side-effect) | `2bf2ac9c-5640-11f1-89ca-87857fe908d7` |
| 5 | `pull_request_review_comment` action=created | `gh api -X POST repos/…/pulls/1/comments` (inline) | `2c17d0d0-5640-11f1-8e4a-cee3fe8bbfb1` |

5 deliveries; 4 distinct event types (the 4 we subscribed to).

## Server counters at end

```json
{"ok":true,"port":8788,"received":5,"emitted":5,"rejected":0}
```

- `received=5` — all 5 GH deliveries reached the tunnel + server
- `emitted=5` — all 5 produced a `notifications/claude/channel` to the Claude session
- `rejected=0` — every GH signature verified on first attempt; no HMAC fights

(The earlier GH `ping` event from webhook creation also arrived and was
handled separately — `received=1, rejected=0` before any PR triggers.)

## Claude pane transcript

Captured via `cmux read-screen --surface surface:36 --scrollback`:

```
❯ Wait for channel events. When one arrives, reply with a single line
  containing: event_type, repo, action, sender, html_url. Do not call any
  tools.

⏺ Ready. Waiting for channel events.

← gh-roundtrip: [PR opened] marklubin/claude-gh-channel#1 "Spike 0.5 E2E te…

⏺ pull_request | marklubin/claude-gh-channel | opened | marklubin |
  https://github.com/marklubin/claude-gh-channel/pull/1

← gh-roundtrip: [PR comment created] marklubin/claude-gh-channel#1 by markl…

⏺ issue_comment | marklubin/claude-gh-channel | created | marklubin |
  https://github.com/marklubin/claude-gh-channel/pull/1#issuecomment-4523564116

← gh-roundtrip: [PR review submitted state=commented] marklubin/claude-gh-c…

⏺ pull_request_review | marklubin/claude-gh-channel | submitted | marklubin |
  https://github.com/marklubin/claude-gh-channel/pull/1#pullrequestreview-4349396794

← gh-roundtrip: [PR review submitted state=commented] marklubin/claude-gh-c…

⏺ pull_request_review | marklubin/claude-gh-channel | submitted | marklubin |
  https://github.com/marklubin/claude-gh-channel/pull/1#pullrequestreview-4349397460

← gh-roundtrip: [PR review comment created] marklubin/claude-gh-channel#1 s…

⏺ pull_request_review_comment | marklubin/claude-gh-channel | created | marklubin |
  https://github.com/marklubin/claude-gh-channel/pull/1#discussion_r3291744141
```

Every event landed in Claude with its full summary line + structured meta.
Claude extracted exactly the requested fields on each, including the
`html_url` distinct per event type (PR url, comment anchor, review anchor,
inline-discussion anchor).

## Findings

1. **HMAC verification was clean on first attempt.** No GH↔Bun-WebCrypto
   signing mismatch. (Smoke test against `openssl` had an unrelated bash
   quoting issue, but the server's `crypto.subtle.sign` matches GH's
   `sha256=<hex>` exactly.)

2. **Channel name format requires `.mcp.json`.** The `--dangerously-load-development-channels`
   flag takes `server:<name>` where `<name>` is registered in the project's
   `.mcp.json`. Passing a raw `bun:<path>` is accepted with a warning but
   the MCP server isn't actually spawned. Fixed by adding `.mcp.json` with
   `mcpServers.gh-roundtrip` → `bun ./server.ts`.

3. **GH webhook creation auto-sends a `ping` event.** Server got it as
   `received=1` immediately after `gh api … /hooks` returned. Handled by
   short-circuiting in the receiver (`if (eventType === "ping") return pong`).
   Useful free signal that the tunnel + signature path is healthy before any
   user-triggered events.

4. **Single inline-comment API call produces 2 webhook deliveries.** GH fires
   both `pull_request_review_comment.created` AND a synthesized
   `pull_request_review.submitted`. Worth knowing for dedup design — the
   plugin's M3 SQLite queue should treat these as a pair, not two
   independent events.

5. **Notification ordering matches delivery order.** Even when GH delivered
   the auto-review + inline-comment 200ms apart, Claude saw them in order
   and reasoned about each independently. No reordering observed.

6. **Render format in terminal is `← gh-roundtrip: <content>`** with the
   server name as prefix (matching 0.1's observation that `<channel>` tags
   render as readable lines).

7. **Latency end-to-end ≈ 1-2 sec.** From `gh pr create` returning to the
   channel event surfacing in Claude was visually indistinguishable from
   "instant" in cmux read-screen polling at 6-second intervals.

## What this means for the design

The architecture from `~/command-center/research/gh-pr-channel-plugin-design.md`
works as drawn. No surprises:

- HMAC verify + reject path is straightforward (one `crypto.subtle.sign` call)
- Event-type summarizers as a switch over `X-GitHub-Event` is the right shape
- `meta` dict carries enough structured data (delivery_id, repo, action,
  sender, number, html_url, etc.) for the steering brief + skills to make
  decisions
- Cloudflared quick tunnel is a perfectly fine dev / personal-use tunnel
  (need to revisit for prod or shared use — quick tunnels rotate URLs on
  restart)

M0 → M1 transition is unblocked.

## Limitations of this spike (not blockers)

- **Tunnel URL is ephemeral.** A persistent cloudflared named tunnel
  (`cloudflared tunnel create … && tunnel route dns …`) is the v1
  expectation; quick tunnels are dev-only.
- **No dedup, no SQLite queue, no retry.** Design doc has these for M3.
  Current spike server holds an in-memory `deliveries[]` array — fine for
  a 5-event test, not real durability.
- **One subscription, one channel.** Linear / Slack adapters would be
  siblings (separate MCP servers + .mcp.json entries), not multiplexed
  through this server.
- **Webhook stays configured until manually deleted.** Cleanup steps in
  README of this spike.

## Cleanup performed

After capturing this evidence:

1. Deleted webhook 628940455 from `marklubin/claude-gh-channel`.
2. Stopped cloudflared tunnel process.
3. Closed test PR #1 (left branch `spike/0.5-test-trigger` pushed for repro).
4. Exited Claude session in the side pane.

## Files

- `server.ts` — channel-server + webhook-receiver (HMAC verify, 4 summarizers)
- `package.json` / `tsconfig.json` / `bun.lock` — bun project metadata
- `.mcp.json` — registers `gh-roundtrip` MCP server pointing at `./server.ts`
- This `EVIDENCE.md`

## Reproduction

From this directory, after re-creating webhook + tunnel:

```bash
SECRET=$(openssl rand -hex 32)
cloudflared tunnel --url http://localhost:8788 &  # capture URL from stdout
gh api -X POST repos/<owner>/<repo>/hooks --input - <<EOF
{"name":"web","active":true,
 "events":["pull_request","issue_comment","pull_request_review","pull_request_review_comment"],
 "config":{"url":"<TUNNEL>/webhook","content_type":"json","secret":"$SECRET","insecure_ssl":"0"}}
EOF
GH_WEBHOOK_SECRET=$SECRET claude --dangerously-load-development-channels server:gh-roundtrip
# Trigger from another shell: gh pr create / comment / review
```
