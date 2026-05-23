# claude-gh-channel

A Claude Code plugin that surfaces GitHub PR/issue/review events into a persistent background Claude session via the experimental MCP **channels** API.

**Status:** v0.1.0. M0-M4 of the design doc are landed; M5 is partial. See [docs/walkthrough.md](docs/walkthrough.md) for the end-to-end tour.

## What it does

```
GitHub.com ──webhook──► cloudflared tunnel ──► localhost:8788 (HMAC verify)
                                                       │
                                       subscription filter + routing hints
                                                       │                         ┌── SQLite queue
                                                       ├─persist─────────────────┤   (drains on
                                                       │                         │    re-attach)
                                                       ▼
                                       notifications/claude/channel
                                                       │
                                                Claude session (watcher pane)
                                                       │
                                              ┌────────┴────────┐
                                              │                 │
                                       handler skills      channel_reply tool
                                       (pr-triage,        (drafts + cmux
                                        pr-review-prep,    sidebar + notify)
                                        pr-comment-respond,
                                        pr-merge-followup)
```

## Features

### Real GH webhook pipeline (proven E2E)
- HMAC-SHA256 verification on every delivery (`X-Hub-Signature-256`)
- 4 event types summarized: `pull_request`, `issue_comment` (PR-only), `pull_request_review`, `pull_request_review_comment`
- Per-event-type structured `meta` so skills can reason without re-parsing payloads
- Latency: ~1-2s GitHub → Claude pane

### Config-driven steering
- `~/.config/claude-gh-channel/config.yaml` is the source of truth
- Per-subscription `ignore_authors` + `ignore_if` JS-expression filters
- `routing_hints` attach `suggested_skill` + `priority` meta when conditions match
- Templated `agent_brief` — file or inline, `${user.*}` / `${vars.*}` / `${brief_vars.*}` interpolation

### SQLite-backed durability
- Every accepted event persists to `~/.local/share/claude-gh-channel/events.db` (WAL)
- Dedup on `delivery_id` (GH retries don't double-fire)
- Drain pending events when a session re-attaches
- `/gh-channel-replay <id>` re-emits any past event

### Lifecycle controls
- `/gh-channel-setup` — interactive bootstrap (secret + tunnel + webhook + config)
- `/gh-channel-status` — health snapshot
- `/gh-channel-enable` / `disable` — master switch (webhook active flip)
- `/gh-channel-pause <dur>` / `quiet` / `pause-repo` / `resume` — scoped throttles
- `/gh-channel-reload` — reload config.yaml hot (subscriptions + hints + filters)
- `/gh-channel-queue` — inspect SQLite queue
- `/gh-channel-replay <id>` — re-emit a delivery
- `/gh-channel-uninstall` — confirmed teardown (archives DB, leaves config)

### Auto-start on macOS
- `installer/launchd.plist.template` + `installer/install-launchd.sh` install a LaunchAgent that keeps cloudflared up across reboots (with caveats — see "Tunnel URL rotation")
- `installer/uninstall-launchd.sh` to remove

### 4 default handler skills
- `pr-triage` — opened-by-you-in-your-repo → diff scan + risk flags + label suggestions + triage draft
- `pr-review-prep` — `review_requested` for you → 2-3 key questions + suggested reading order
- `pr-comment-respond` — comment on your PR by someone else → drafted reply in your voice
- `pr-merge-followup` — your merged PR → scan body for TODO/Followup markers, append to `~/command-center/todo.md`

All four are **drafts-only**. Nothing gets posted to GitHub. Drafts land in `~/.config/claude-gh-channel/drafts/`.

### `channel_reply` MCP tool
Single tool for skills to write back, with action_type ∈ {triage, review_draft, comment_draft, flagged, notify, status}. Routes to draft files + cmux sidebar with consistent slug/path conventions.

## What v1 still doesn't do

| Gap | Why |
|---|---|
| Standalone daemon (separate from Claude session) | The MCP server is per-session. When no watcher is attached, GH POSTs fail at the tunnel hop. Workaround: keep a watcher pinned. v2 architecture in `spike/0.4-multi-session/EVIDENCE.md` is the fix. |
| Named cloudflared tunnel with stable URL | Quick tunnels rotate URLs on every cloudflared restart. After reboot, re-run `/gh-channel-setup` to update the webhook. Named tunnel + DNS is M4.1. |
| Linear / Slack adapter siblings | Sibling MCP servers — design supports it but only GitHub is built. |
| Multi-machine session coordination | One Claude session per machine; no cross-device fan-out. |
| Per-skill cost / context budgets | Skills enforce size discipline manually (handler-contract.md). No system-level budget. |
| Linux/systemd auto-start | macOS-only launchd for now. |
| Schema validation beyond required fields | `config.yaml` validation is lightweight (required fields + version check). Full JSON-schema validation against `config/schema.json` is M5+. |

## Install

```bash
# 1. Clone
git clone https://github.com/marklubin/claude-gh-channel ~/claude-gh-channel
cd ~/claude-gh-channel

# 2. Install deps
(cd server && bun install)

# 3. From a Claude Code session, install the plugin
# /plugin install file://$HOME/claude-gh-channel

# 4. Bootstrap (from a Claude session that has the plugin installed)
# /gh-channel-setup

# 5. Attach a watcher session (any terminal)
# claude --channels plugin:claude-gh-channel:gh-channel
```

Full walkthrough: [docs/walkthrough.md](docs/walkthrough.md).

## Layout

```
claude-gh-channel/
├── .claude-plugin/plugin.json   # Plugin manifest
├── .mcp.json                    # Registers `gh-channel` MCP server
├── server/
│   ├── index.ts                 # MCP + HTTP listener
│   ├── config.ts                # YAML loader + templating
│   ├── filters.ts               # subscription + routing-hint expr evaluator
│   ├── queue.ts                 # bun:sqlite queue + dedup
│   └── reply.ts                 # channel_reply tool implementation
├── config/
│   ├── schema.json              # JSON schema for config.yaml
│   ├── example.yaml             # Starter config (substituted by setup)
│   └── default-brief.md         # Templated agent_brief
├── commands/                    # 9 slash commands
│   ├── gh-channel-setup.md
│   ├── gh-channel-status.md
│   ├── gh-channel-enable.md
│   ├── gh-channel-disable.md
│   ├── gh-channel-pause.md
│   ├── gh-channel-reload.md
│   ├── gh-channel-queue.md
│   ├── gh-channel-replay.md
│   └── gh-channel-uninstall.md
├── skills/                      # 4 handler skills + shared contract
│   ├── _shared/handler-contract.md
│   ├── pr-triage/SKILL.md
│   ├── pr-review-prep/SKILL.md
│   ├── pr-comment-respond/SKILL.md
│   └── pr-merge-followup/SKILL.md
├── installer/
│   ├── launchd.plist.template   # LaunchAgent template
│   ├── install-launchd.sh
│   └── uninstall-launchd.sh
├── docs/walkthrough.md          # End-to-end tour
├── spike/                       # M0-M1 evidence — keep
│   ├── 0.1-channel-roundtrip/   → channel capability round-trip (PASS)
│   ├── 0.2-reply-tool/          → MCP tool round-trip (PASS)
│   ├── 0.3-bg-session-viability/ → 24h heartbeat (server built, full burn-in deferred)
│   ├── 0.4-multi-session/       → channels are per-session (architectural finding)
│   └── 0.5-gh-roundtrip/        → real-GH E2E (PASS — 5/5 deliveries, 0 rejects)
└── README.md
```

## Design doc

Full design (config schema, milestone plan, future siblings) lives at:

`~/command-center/research/gh-pr-channel-plugin-design.md`

Not in this repo intentionally — personal planning artifact, not a public spec.

## Architecture & limitations

See [docs/walkthrough.md](docs/walkthrough.md) for:
- The exact process tree at runtime
- Where files live on disk
- Tunnel URL rotation handling
- "Why events drop and how you know"
- Compaction strategy for long-running sessions
- Debugging recipes

## License

MIT (eventual). Personal-use scaffold for now.
