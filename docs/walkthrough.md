# Walkthrough

A guided tour of `claude-gh-channel` from first install to first PR-event-in-Claude-pane, end-to-end. Assumes macOS + bun + cloudflared + `gh` CLI.

## TL;DR

```bash
# 1. Clone
git clone https://github.com/marklubin/claude-gh-channel ~/claude-gh-channel

# 2. Install bun deps
(cd ~/claude-gh-channel/server && bun install)

# 3. In a Claude Code session
/plugin install file://$HOME/claude-gh-channel
/gh-channel-setup

# 4. In another terminal, attach a watcher session
claude --channels plugin:claude-gh-channel:gh-channel

# 5. Trigger a GH event (open a PR, leave a comment, etc.) and watch it land in the watcher pane.
```

That's the happy path. The rest of this doc walks each piece in detail.

## What you'll have running after setup

```
┌─────────────────┐           ┌────────────────────┐         ┌──────────────────┐
│  GitHub repo    │ webhook   │  cloudflared       │ HTTP    │  bun server.ts   │
│  <your/repo>    ├──────────►│  quick tunnel      ├────────►│  (MCP subprocess │
│  (4 events sub) │  HMAC     │  *.trycloudflare   │ :8788   │   of Claude)     │
└─────────────────┘  signed   └────────────────────┘         └────────┬─────────┘
                                                                       │ stdio
                                                                       │ notifications/claude/channel
                                                                       ▼
                                                              ┌────────────────┐
                                                              │ Claude session │
                                                              │ (watcher pane) │
                                                              └────────────────┘
```

And on disk:

```
~/.config/claude-gh-channel/
├── config.yaml          # Declarative config (subscriptions, brief, hints)
├── config.json          # Operational state (webhook id, tunnel url, timestamps)
├── secret               # 32-byte hex, mode 0600
├── tunnel-url           # Current cloudflared URL (rotates on restart)
├── cloudflared.log      # Tunnel logs
├── cloudflared.pid      # Tunnel pid for kill
└── drafts/              # Where channel_reply writes review/triage/comment drafts

~/.local/share/claude-gh-channel/
├── events.db            # SQLite event queue (WAL)
└── server.log           # Channel server stderr
```

## Step-by-step

### 1. Pre-flight

Check you have the deps:

```bash
bun --version          # ≥ 1.3
cloudflared --version  # ≥ 2026
gh auth status         # logged in with `repo` scope
```

If any missing, install: `brew install bun cloudflared gh && gh auth login --scopes repo`.

### 2. Install the plugin

From a Claude Code session anywhere:

```
/plugin install file:///Users/<you>/claude-gh-channel
```

That registers:
- The MCP server (`gh-channel`) from the plugin's `.mcp.json`
- The `/gh-channel-*` slash commands from `commands/`
- The handler skills from `skills/`

### 3. Bootstrap

```
/gh-channel-setup
```

This walks you through:
- Which repo to watch
- Generating a webhook secret to `~/.config/claude-gh-channel/secret`
- Starting a cloudflared quick tunnel
- Registering the GH webhook (4 events: pull_request, issue_comment, pull_request_review, pull_request_review_comment)
- Writing `config.yaml` + `config.json`
- Optionally installing the launchd auto-start plist (so cloudflared restarts on reboot)

The command is idempotent — re-running it updates the tunnel URL on the webhook if the URL has changed.

### 4. Attach a watcher session

In a new terminal or cmux pane:

```bash
claude --channels plugin:claude-gh-channel:gh-channel
```

This spawns `bun ${CLAUDE_PLUGIN_ROOT}/server/index.ts` as a subprocess. The server:
- Reads config + secret from `~/.config/claude-gh-channel/`
- Binds `127.0.0.1:8788`
- Opens the SQLite queue
- Drains anything pending (events received before this attach)
- Begins receiving webhooks

Prime the watcher with whatever standing instructions you want — the `agent_brief` from your config.yaml is already in its context as MCP `instructions`. You can layer on top, e.g.:

```
Watch for PR events. When pr-review-prep is suggested, run it. Otherwise just acknowledge each event in one line.
```

### 5. Trigger an event

From anywhere:

```bash
gh pr create --title "test" --body "watching..."
```

Within 1-2 seconds, the watcher pane shows:

```
← gh-channel: [PR opened] you/repo#42 "test" by you — https://github.com/you/repo/pull/42
⏺ pull_request | opened | running pr-triage skill
```

(or whatever your `agent_brief` directs.)

## Lifecycle commands

| Command | What it does |
|---|---|
| `/gh-channel-status` | Snapshot: tunnel up? webhook active? session attached? queue depth? |
| `/gh-channel-enable` | Master ON — tunnel up, webhook active, runtime.enabled=true |
| `/gh-channel-disable` | Master OFF — webhook inactive, tunnel can stay up. Reversible. |
| `/gh-channel-pause 2h` | Queue events but don't emit for the window |
| `/gh-channel-pause quiet` | Quiet mode — same effect, no time window |
| `/gh-channel-pause pause-repo <r>` | Skip one repo |
| `/gh-channel-pause resume` | Clear all pause/quiet/disabled-repo state |
| `/gh-channel-reload` | Reload config.yaml; user re-attaches |
| `/gh-channel-queue` | Show pending + recent queue rows |
| `/gh-channel-replay <delivery_id>` | Re-emit a specific event from the queue |
| `/gh-channel-uninstall` | Tear it all down (with confirmation) |

## What the handler skills do

Out of the box you get four skills. They're triggered by the watcher Claude reading the event's `suggested_skill` meta field (set by `routing_hints` in your config):

- **pr-triage** — On `pull_request.opened` you authored: read diff, flag risks, draft a triage note.
- **pr-review-prep** — On `pull_request.review_requested` for you: read diff, draft 2-3 review questions.
- **pr-comment-respond** — On `issue_comment.created` by someone else on your PR: draft a reply.
- **pr-merge-followup** — On `pull_request.closed` (merged) you authored: scan PR description for follow-up tasks, add to your todo.

All four are **drafts-only**. Nothing gets posted to GitHub. Drafts land in `~/.config/claude-gh-channel/drafts/`.

## Tunnel URL rotation (real, watch for it)

Cloudflared **quick tunnels** rotate URLs on every restart. Practical consequence: every time cloudflared restarts (laptop reboot, crash, manual kill), the webhook on GitHub now points at a dead URL. GH retries for ~8h then gives up.

Two fixes, by effort:

- **Cheap**: re-run `/gh-channel-setup` after reboot. It detects the new URL and updates the webhook.
- **Right**: switch to a cloudflared **named tunnel** with a DNS record you control. That's a one-time setup, stable URL, no rotation. Not in v1.

`/gh-channel-status` will tell you if the configured webhook URL doesn't match the currently-running tunnel.

## When events drop (and how you know)

The MCP server lives inside the Claude session. When no session is attached:
- Tunnel still up → GH delivers → tunnel forwards to `localhost:8788` → no listener → connection refused
- GH retries on its own schedule for ~8h
- During those retries, the queue doesn't grow (we never received the event)

Symptoms:
- `gh api repos/<repo>/hooks/<id>/deliveries --jq '.[] | select(.status_code != 200)'` shows non-200 deliveries
- `/gh-channel-status` reports "no watcher attached"

Workaround for v1: keep a watcher session pinned. The launchd plist can keep cloudflared up, but launchd can't sensibly keep an interactive `claude` going — that's why the design doc's full daemon split (separate webhook receiver process + thin MCP clients) is the right v2 fix.

## Compaction strategy for long-running sessions

The watcher Claude accumulates context as events stream in. Two practical strategies:

1. **Periodic restart**: `cmd-shift-c` (compact) the session daily, or run `/gh-channel-reload` weekly. Drains the queue on re-attach so nothing is lost.
2. **Skill discipline**: Skills must NOT echo huge diffs into the channel response. They write drafts to disk and emit only short status messages. This keeps the conversation channel lean even when handling 50 events/day.

## Cleanup

To wipe completely:

```
/gh-channel-uninstall
```

That deletes the webhook, stops cloudflared (and removes plist if installed), archives the SQLite DB. It leaves `config.yaml` and the secret so reinstall is one command.

To nuke the config too:

```bash
rm -rf ~/.config/claude-gh-channel ~/.local/share/claude-gh-channel
```

## Debugging

### Events show up in `/queue` but the watcher pane is silent

The MCP notification was sent but Claude's context isn't reading it. Usually means Claude is mid-tool-call or compaction. Wait a tick or `cmd-shift-c` and check again.

### `/gh-channel-status` says webhook returns 401

Secret mismatch between `~/.config/claude-gh-channel/secret` and the GH webhook config. Either:
- Run `/gh-channel-setup` again to regenerate + update GH side
- Or manually: `gh api -X PATCH repos/<repo>/hooks/<id> -f config[secret]="$(cat ~/.config/claude-gh-channel/secret)"`

### Tunnel URL changed but webhook still points at the old one

Run `/gh-channel-setup` — it's idempotent and will update the URL on the existing webhook.

### Server won't start: "config: ~/.config/claude-gh-channel/config.yaml not found"

You haven't run `/gh-channel-setup` yet. Run it.

### Server crashed mid-session

Re-attach with `claude --channels plugin:claude-gh-channel:gh-channel`. The queue will replay anything that hadn't emitted.

## What's NOT in v1

Things the design doc covers but this version doesn't:
- Linear / Slack adapter siblings (just GitHub for now)
- Multi-machine session coordination
- Named tunnel auto-provisioning
- Web UI for config editing
- Compaction-aware context budgets
- Per-skill cost tracking

Most are M5+ or v2 features. Open issues on GitHub for any of them that bite.
