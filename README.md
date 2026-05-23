# claude-gh-channel

GitHub PR events, surfaced live inside a Claude Code session.

If you live in a terminal and most of your GitHub time goes to a few repos you care about, this gives you a watcher that sits in a side pane, sees every PR / review / comment as it happens, and decides what — if anything — needs a human reaction. Drafts replies, flags risky diffs, tracks merged-PR follow-ups. Nothing it does is destructive: every output is a local file or a status badge. You're still the one who posts, merges, and approves.

It's a personal tool. macOS, single laptop, one watcher Claude at a time.

## What you get

- **Live feed.** GitHub webhook fires → tunneled into your laptop → shows up in your watcher Claude pane in ~1-2 seconds. No tab-switching to github.com to check what happened.
- **Steering, not just streaming.** A YAML config tells the watcher what to care about: which repos, which authors to ignore, which events should trigger which prep work. You configure once and forget.
- **Four built-in skills** for the most common PR moments: triage a PR you just opened, prep for a review you've been requested on, draft a reply to someone's comment, scan a merged PR's description for follow-up TODOs.
- **Drafts only.** Skills write to `~/.config/claude-gh-channel/drafts/` and surface status to your cmux sidebar. They never post to GitHub.
- **Durable queue.** Every event lands in SQLite first. If your watcher session died, restart it and it replays what you missed. Same for `/gh-channel-pause 2h` — events queue but don't emit until you un-pause.
- **Lifecycle commands** for everything you'd want to do operationally: status, enable/disable, pause, reload config, inspect the queue, replay a specific event, uninstall.

## What it looks like

After install + bootstrap, you open a side pane and run:

```bash
claude --channels plugin:claude-gh-channel:gh-channel
```

Tell the watcher its job in one sentence ("watch for review requests; otherwise just acknowledge each event in one line"), then do whatever you were doing.

When someone opens a PR in a repo you're watching, the side pane lights up:

```
← gh-channel: [PR opened] marklubin/claude-gh-channel#2 "Bump grpc to v1.62"
⏺ pull_request | marklubin/claude-gh-channel#2 | opened | marklubin | pr-triage | normal
```

That last line is the watcher echoing back five fields from the event: event type, repo + PR number, action, sender, the **routing hint** (`pr-triage` skill suggested), and **priority** (normal). All five came out of the config you wrote. The watcher then decides whether to actually invoke `pr-triage` based on the standing brief you gave it.

When a comment lands on one of your PRs and the skill kicks in, you'll find a draft reply at:

```
~/.config/claude-gh-channel/drafts/marklubin-claude-gh-channel-2-comment_draft.md
```

You read it, edit if needed, paste into the GitHub UI. The skill never speaks for you.

## Quick start

Prereqs (one-time, with Homebrew):

```bash
brew install bun cloudflared gh
gh auth login --scopes repo
```

Then:

```bash
# 1. Clone the plugin somewhere stable
git clone https://github.com/marklubin/claude-gh-channel ~/claude-gh-channel
cd ~/claude-gh-channel && (cd server && bun install)

# 2. Tell Claude Code about the plugin
#    (from any Claude session)
/plugin install file:///$HOME/claude-gh-channel

# 3. Bootstrap — generates a webhook secret, starts a cloudflared tunnel,
#    registers the GH webhook on a repo you choose, writes config.yaml.
#    The command walks you through it interactively.
/gh-channel-setup

# 4. Attach a watcher session in any terminal or cmux pane:
claude --channels plugin:claude-gh-channel:gh-channel
```

That's it. Open a PR in the repo you wired up and watch it land.

(Detailed walkthrough with file layouts, what each step writes where, and how to verify it worked: [docs/walkthrough.md](docs/walkthrough.md).)

## Configure what you watch

Your config lives at `~/.config/claude-gh-channel/config.yaml`. The setup command scaffolds it from [`config/example.yaml`](config/example.yaml), substituting your GitHub login and the chosen repo. Edit it any time and run `/gh-channel-reload` to apply changes without restarting the watcher.

The four important sections:

### `subscriptions` — what events to receive

```yaml
subscriptions:
  - repo: marklubin/my-app
    events: [pull_request, pull_request_review, issue_comment, pull_request_review_comment]
    filters:
      ignore_authors: ["dependabot[bot]", "renovate[bot]"]
      ignore_if: 'payload.pull_request != null && payload.pull_request.draft === true'
```

The server gates events at this layer — anything filtered here never reaches the watcher. `ignore_if` is a JavaScript expression evaluated against the webhook payload (yours, on your machine — same trust as code you'd write).

### `routing_hints` — suggest which skill to use

```yaml
routing_hints:
  - on: pull_request.review_requested
    when: 'payload.requested_reviewer.login === user.github_username'
    meta:
      suggested_skill: pr-review-prep
      priority: high
```

When the condition matches, the meta is attached to the event before it's sent to the watcher. The watcher reads `suggested_skill` from meta and (usually) invokes that skill. The hint is advisory — the watcher's brief tells it when to override.

### `agent_brief` — the standing instructions for the watcher

This is the system prompt baked into the channel server's `instructions` field. You can write it inline, or point at a file:

```yaml
agent_brief_file: ${CLAUDE_PLUGIN_ROOT}/config/default-brief.md
brief_vars:
  active_workstreams: [event-mesh, mock-infra]
  notification_style: terse
```

Variables interpolate into the brief at load time: `${user.github_username}`, `${vars.notification_style}`, `${brief_vars.active_workstreams}`. Useful for tailoring the watcher's tone or pointing it at your `todo.md`.

### `runtime` — operational knobs

```yaml
runtime:
  http_port: 8788
  quiet_mode: false       # toggle with /gh-channel-pause quiet
  pause_until: null       # set by /gh-channel-pause 2h
  disabled_repos: []      # set by /gh-channel-pause pause-repo
```

You don't usually edit these directly — the `/gh-channel-pause` command writes them for you.

## The four skills

| Skill | Triggers on | What it produces |
|---|---|---|
| **pr-triage** | You open a PR in a repo you maintain | Risk flags (migrations, security-adjacent files, large diffs), suggested labels, a triage summary saved to `drafts/` |
| **pr-review-prep** | You're requested as reviewer | 2-3 key questions grounded in the diff, a suggested reading order, all saved to `drafts/` |
| **pr-comment-respond** | Someone comments on your PR | A drafted reply in your voice, saved to `drafts/`. Never posted. |
| **pr-merge-followup** | Your PR merges | Scans the PR body for `TODO:` / `Followup:` markers and Linear ticket IDs; appends them to `~/command-center/todo.md` |

All four follow the rules in [`skills/_shared/handler-contract.md`](skills/_shared/handler-contract.md): read-only on GitHub, drafts go to local scratch files, never post, never push, bail on huge diffs rather than auto-drafting a half-baked review.

Skills use one MCP tool — `channel_reply` — to write back. That tool handles draft file paths, slugs, timestamping, and cmux sidebar updates. Skills don't write files directly; they call `channel_reply` and the server figures out where things go.

## Commands

| Command | What it does |
|---|---|
| `/gh-channel-setup` | One-time interactive bootstrap. Idempotent — re-run to update tunnel URL or repo. |
| `/gh-channel-status` | Snapshot: is the tunnel up? webhook active on GitHub? watcher attached? queue depth? |
| `/gh-channel-enable` | Master ON: tunnel up + webhook `active: true` + runtime flag. |
| `/gh-channel-disable` | Master OFF: webhook `active: false`. Reversible. Tunnel kept up. |
| `/gh-channel-pause 2h` | Time-windowed pause. Events queue but don't emit. |
| `/gh-channel-pause quiet` | Same, no time window — flip back with `unquiet`. |
| `/gh-channel-pause pause-repo OWNER/NAME` | Skip one repo, keep others. |
| `/gh-channel-pause resume` | Clear all pause / quiet / disabled-repo state. |
| `/gh-channel-reload` | Re-read `config.yaml`. Subscriptions, routing hints, and filter expressions update live; brief + port need a watcher restart. |
| `/gh-channel-queue` | Show pending + recent events from the SQLite queue. |
| `/gh-channel-replay <delivery_id>` | Re-emit a past event to the watcher. Accepts a prefix if unambiguous. |
| `/gh-channel-uninstall` | Confirmed teardown: delete GH webhook, stop tunnel, remove launchd plist, archive SQLite DB. Leaves config + secret. |

## How it actually works

```
┌──────────────┐ webhook   ┌───────────────────┐ HTTP    ┌──────────────────────┐
│  GitHub.com  │──────────►│ cloudflared tunnel │────────►│ server/index.ts       │
│  (your repo) │ HMAC      │ *.trycloudflare    │ :8788   │ (MCP subprocess of   │
└──────────────┘ signed    └───────────────────┘         │  your Claude session)│
                                                          └──────────┬───────────┘
                                                                     │ stdio
                                                                     │ notifications/
                                                                     │ claude/channel
                                                                     ▼
                                                          ┌─────────────────────┐
                                                          │  Claude (watcher    │
                                                          │  pane)              │
                                                          │                     │
                                                          │  Reads meta,        │
                                                          │  invokes a skill if │
                                                          │  needed, calls      │
                                                          │  channel_reply tool │
                                                          └──────────┬──────────┘
                                                                     │
                                                          ┌──────────┴──────────┐
                                                          │                     │
                                                          ▼                     ▼
                                                  drafts/...md        cmux sidebar status
```

The server lives **inside** your Claude session as an MCP subprocess. When you start the watcher with `--channels`, Claude spawns `bun ${CLAUDE_PLUGIN_ROOT}/server/index.ts`, which:

1. Reads your config and secret
2. Binds `127.0.0.1:8788`
3. Opens the SQLite queue
4. Drains anything pending from past sessions
5. Waits for webhook POSTs

When a webhook arrives, the server: verifies the HMAC, checks subscriptions + filters, applies routing hints, persists to SQLite (idempotent on `delivery_id` so GH retries are safe), and emits an MCP notification. The notification flows up the stdio transport into your watcher's context — which is why it shows up as `← gh-channel: ...` in the pane.

Deep dive (process tree, file locations, sequence diagrams, debugging recipes): [docs/walkthrough.md](docs/walkthrough.md).

## Troubleshooting

**Q: My PR doesn't show up in the watcher pane.**
Run `/gh-channel-status`. Most common causes: tunnel URL on GitHub doesn't match the running tunnel (cloudflared restarted and rotated the URL — re-run `/gh-channel-setup`), or no watcher is attached (`claude --channels plugin:claude-gh-channel:gh-channel`).

**Q: Events show up in `/gh-channel-queue` but the watcher pane is silent.**
Usually means Claude is mid-tool-call or about to compact. Wait a tick or `cmd-shift-c` to compact and check again.

**Q: I rebooted. Nothing's working.**
The cloudflared LaunchAgent (if installed) auto-starts but gets a new `*.trycloudflare.com` URL. The webhook on GitHub still points at the old one. Re-run `/gh-channel-setup` — it's idempotent and will patch the webhook to the new URL.

**Q: `/gh-channel-status` says the webhook is returning 401.**
Secret mismatch. Either run `/gh-channel-setup` again (it'll regenerate + sync), or manually: `gh api -X PATCH repos/<repo>/hooks/<id> -f config[secret]="$(cat ~/.config/claude-gh-channel/secret)"`.

**Q: I want to watch a second repo.**
Edit `~/.config/claude-gh-channel/config.yaml`, add another entry under `subscriptions`. Then register a webhook on that repo manually with the same secret + tunnel URL (`gh api -X POST repos/<owner>/<repo>/hooks --input -` with the appropriate JSON — see what setup did the first time, or copy-paste from your shell history). Re-run `/gh-channel-reload`. Multi-repo first-class support is on the roadmap.

**Q: I want it to stop bothering me for an hour.**
`/gh-channel-pause 1h`. Events still queue. They drain when the window passes.

**Q: I want to nuke it.**
`/gh-channel-uninstall`. It'll ask for confirmation, then delete the GitHub webhook, stop the tunnel, remove the launchd plist, and archive the SQLite database. Your config and secret are left in place — to wipe completely, also `rm -rf ~/.config/claude-gh-channel ~/.local/share/claude-gh-channel`.

## Known limitations (v1)

| Limitation | What it means in practice |
|---|---|
| Server runs inside the Claude session (no separate daemon) | If no watcher is attached when GitHub fires a webhook, the tunnel hop fails and GitHub retries for ~8 hours. Workaround: keep a watcher attached. v2 will split the daemon from the Claude session. |
| Cloudflared **quick** tunnel URLs rotate | Every cloudflared restart gets a new `*.trycloudflare.com`. After a reboot, run `/gh-channel-setup` to patch the webhook. Named tunnel + DNS support is on the roadmap. |
| macOS only | Launchd auto-start, cmux integration. Linux/systemd support not in v1. |
| One Claude watcher per machine | Channels are 1:1 (proven in `spike/0.4-multi-session/EVIDENCE.md`). Multi-watcher fan-out needs the v2 daemon split. |
| Lightweight config validation | Required fields + version check. Full JSON-schema validation against `config/schema.json` is on the roadmap. |
| GitHub only | The architecture supports sibling adapters (Linear, Slack, Recall) but only GitHub is built. |

## Repository layout

```
claude-gh-channel/
├── .claude-plugin/plugin.json   # Plugin manifest
├── .mcp.json                    # Registers the `gh-channel` MCP server
├── server/                      # Channel server: HTTP + MCP stdio
│   ├── index.ts                 # Main loop + HTTP endpoints
│   ├── config.ts                # YAML loader + templating
│   ├── filters.ts               # Subscription + routing-hint evaluator
│   ├── queue.ts                 # bun:sqlite queue + dedup
│   └── reply.ts                 # `channel_reply` MCP tool
├── config/
│   ├── schema.json              # JSON schema for config.yaml
│   ├── example.yaml             # Starter config (setup substitutes placeholders)
│   └── default-brief.md         # Templated agent_brief
├── commands/                    # Nine slash commands (setup + lifecycle)
├── skills/                      # Four handler skills + shared contract
├── installer/                   # macOS launchd template + install/uninstall
├── docs/walkthrough.md          # Deep dive with file layouts + debugging
├── spike/                       # M0-M5 evidence — read these to understand decisions
│   ├── 0.1-channel-roundtrip/   # Channel capability proven
│   ├── 0.2-reply-tool/          # MCP tool round-trip proven
│   ├── 0.3-bg-session-viability/ # 24h heartbeat (not run to completion)
│   ├── 0.4-multi-session/       # Why channels are per-session
│   ├── 0.5-gh-roundtrip/        # Real-GH end-to-end proof
│   └── M2-M5-INTEGRATION-EVIDENCE.md  # Full M2-M4 layer + final E2E
└── README.md
```

## Status

v0.1.0. Bootstrap, the four built-in skills, the nine lifecycle commands, the SQLite queue, the launchd auto-start, and the config-driven steering layer are all landed and end-to-end tested (see `spike/M2-M5-INTEGRATION-EVIDENCE.md`).

Things on the roadmap that v1 doesn't have yet:
- Standalone daemon so events don't drop when no watcher is attached
- Named-tunnel + DNS so the URL doesn't rotate on restart
- Multi-repo first-class config
- Sibling adapters for Linear / Slack / Recall
- Linux / systemd support
- Strict JSON-schema validation of `config.yaml`

## Credits

Plugin built against the experimental Claude Code MCP **channels** API. The design doc that drove this (and that holds the longer-term roadmap) is private — it lives in the author's `~/command-center/research/` rather than this repo, because it's a personal planning artifact, not a public spec.

## License

MIT (eventual). For now: personal-use scaffold, no formal license declared.
