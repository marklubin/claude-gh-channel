# claude-gh-channel

GitHub PR events, surfaced live inside a Claude Code session.

If you live in a terminal and most of your GitHub time goes to a few repos you care about, this gives you a watcher that sits in a side pane, sees every PR / review / comment as it happens, and decides what — if anything — needs a human reaction. Drafts replies, flags risky diffs, tracks merged-PR follow-ups. Nothing it does is destructive: every output is a local file or a status badge. You're still the one who posts, merges, and approves.

It's a personal tool. macOS, single laptop, one watcher Claude at a time.

> [!IMPORTANT]
> **Two things will bite you before anything else — read these first:**
>
> 1. **Cloudflare quick tunnels are flaky.** This plugin uses cloudflared's free, account-less "quick tunnels" to get GitHub webhooks into your laptop. They rotate URLs on restart, drop mid-session, and their DNS sometimes fails to propagate for minutes (observed `NXDOMAIN` and `530`s under service load). The plugin **self-heals** — `ghwatch` / `/gh-channel-tunnel` auto-provision a fresh tunnel and repoint the webhook — but if a freshly-created hostname won't resolve, that's Cloudflare's side, not yours. The durable fix is a **named tunnel** with your own DNS (on the roadmap). See [Known limitations](#known-limitations-v1).
> 2. **Channels are gated on Team/Enterprise plans.** If your Claude Code plan is "Claude Team" or "Enterprise", an admin must set `channelsEnabled: true` in [managed settings](https://code.claude.com/docs/en/server-managed-settings) or channel notifications are silently dropped before reaching the watcher. Everything server-side (watchlist, auto-watch, `cmux notify`) still works without it — you just won't get events injected into Claude's reasoning context. See [Known limitations](#known-limitations-v1).

## What you get

- **Live feed.** GitHub webhook fires → tunneled into your laptop → shows up in your watcher Claude pane in ~1-2 seconds. No tab-switching to github.com to check what happened.
- **Steering, not just streaming.** A YAML config tells the watcher what to care about: which repos, which authors to ignore, which events should trigger which prep work. You configure once and forget.
- **A watchlist.** Focus the watcher on a specific set of PRs — `hard` mode filters out everything else, `soft` mode flags watched-PR events as critical. Persists across restarts. Auto-removes a PR when it closes.
- **Auto-watch.** Optionally auto-add PRs to the watchlist when you're requested as reviewer or open your own PR, with a `cmux notify` desktop ping. Works even when channels are gated.
- **Four built-in skills** for the most common PR moments: triage a PR you just opened, prep for a review you've been requested on, draft a reply to someone's comment, scan a merged PR's description for follow-up TODOs.
- **Drafts only.** Skills write to `~/.config/claude-gh-channel/drafts/` and surface status to your cmux sidebar. They never post to GitHub.
- **Durable queue.** Every event lands in SQLite first. If your watcher session died, restart it and it replays what you missed. Same for `/gh-channel-pause 2h` — events queue but don't emit until you un-pause.
- **Self-healing tunnel.** `ghwatch` ensures a live tunnel before attaching — provisions a fresh one + repoints the webhook automatically if the tunnel rotated or died.
- **Lifecycle commands** for everything operational: status, enable/disable, pause, reload config, inspect the queue, replay an event, manage the watchlist, refresh the tunnel, uninstall.

## What it looks like

After install + bootstrap, you open a side pane and attach a watcher (use the `ghwatch` alias below, or the full command):

```bash
claude --dangerously-load-development-channels plugin:claude-gh-channel@marklubin --dangerously-skip-permissions
```

Tell the watcher its job in one sentence ("watch for review requests; otherwise just acknowledge each event in one line"), then do whatever you were doing.

When someone opens a PR in a repo you're watching, the side pane lights up:

```
← gh-channel: [PR opened] marklubin/claude-gh-channel#2 "Bump grpc to v1.62"
⏺ pull_request | marklubin/claude-gh-channel#2 | opened | marklubin | pr-triage | normal
```

That last line is the watcher echoing back fields from the event: event type, repo + PR number, action, sender, the **routing hint** (`pr-triage` skill suggested), and **priority**. All came out of the config you wrote. The watcher then decides whether to actually invoke `pr-triage` based on the standing brief you gave it.

When a comment lands on one of your PRs and the skill kicks in, you'll find a draft reply at:

```
~/.config/claude-gh-channel/drafts/marklubin-claude-gh-channel-2-comment_draft.md
```

You read it, edit if needed, paste into the GitHub UI. The skill never speaks for you.

## Quick start

Plan on 10 minutes the first time.

Prereqs (one-time, with Homebrew):

```bash
brew install bun cloudflared gh jq
gh auth login --scopes repo
```

Then from any Claude Code session:

```bash
# 1. Add the marketplace + install. The plugin's server ships pre-bundled
#    so there's no manual `bun install` step.
/plugin marketplace add marklubin/claude-gh-channel
/plugin install claude-gh-channel@marklubin
/reload-plugins

# 2. Bootstrap — generates the webhook secret, starts cloudflared,
#    registers the GH webhook on a repo you pick, writes config.yaml.
/claude-gh-channel:gh-channel-setup

# 3. Attach a watcher in any terminal or cmux pane.
#    The --dangerously-load-development-channels flag is REQUIRED for any
#    self-published channel plugin during the research preview (Anthropic
#    curates the allowlist; community marketplaces aren't on it). It will
#    prompt for confirmation once per launch.
claude --dangerously-load-development-channels plugin:claude-gh-channel@marklubin --dangerously-skip-permissions
```

That's it. Open a PR in the repo you wired up and watch it land.

The watcher command is long. Drop this in your `~/.zshrc`. `ghwatch` first ensures a live tunnel (self-healing — fresh tunnel + repointed webhook if the old one rotated or died), then attaches:

```bash
GH_CHANNEL_DIR="$HOME/.claude/plugins/cache/marklubin/claude-gh-channel"
_gh_channel_script() { ls -d $GH_CHANNEL_DIR/*/scripts/ensure-tunnel.sh 2>/dev/null | sort -V | tail -1; }
alias ghtunnel='bash "$(_gh_channel_script)"'
alias ghwatch='bash "$(_gh_channel_script)"; claude --dangerously-load-development-channels plugin:claude-gh-channel@marklubin --dangerously-skip-permissions'
alias ghstatus='curl -s localhost:8788/health 2>/dev/null | jq || echo "no watcher running"'
```

Then it's just `ghwatch`. (The `ls ... | sort -V | tail -1` picks the highest installed version's script, so the alias survives plugin updates.)

(Detailed walkthrough with file layouts, what each step writes where, and how to verify it worked: [docs/walkthrough.md](docs/walkthrough.md). Full punch list of onboarding rough edges: [FOLLOWUPS.md](FOLLOWUPS.md).)

## Configure what you watch

Your config lives at `~/.config/claude-gh-channel/config.yaml`. The setup command scaffolds it from [`config/example.yaml`](plugins/claude-gh-channel/config/example.yaml), substituting your GitHub login and the chosen repo. Edit it any time and run `/gh-channel-reload` to apply changes without restarting the watcher.

The sections that matter:

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

### `runtime.auto_watch` — auto-add PRs to the watchlist

```yaml
runtime:
  auto_watch:
    on_review_requested:    # fires when you're requested as reviewer
      enabled: true
      as_skill: pr-review-prep
      notify: true          # cmux notify desktop ping on auto-add
    on_opened_by_me:        # fires when you open a PR
      enabled: false
      as_skill: null
      notify: false
```

Each trigger has `enabled` / `as_skill` (default skill for entries it adds) / `notify` (fire a `cmux notify` desktop notification). The `notify` path runs server-side and works **regardless of whether channels are enabled** — so it's a useful real-time ping even on a gated Team/Enterprise plan.

### `runtime` — operational knobs

```yaml
runtime:
  http_port: 8788
  quiet_mode: false       # toggle with /gh-channel-pause quiet
  pause_until: null       # set by /gh-channel-pause 2h
  disabled_repos: []      # set by /gh-channel-pause pause-repo
```

You don't usually edit these directly — the lifecycle commands write them for you.

## The watchlist

Focus the watcher on a specific set of PRs. Backed by `~/.config/claude-gh-channel/watchlist.json` (persists across restarts).

- **`soft` mode** (default): every event still flows, but events on watched PRs arrive flagged with `watched: true`, `priority: critical`, and an optional per-entry `suggested_skill`.
- **`hard` mode**: only events on watched PRs reach the watcher — everything else is dropped.
- Auto-removes a PR's entry when the PR closes. Mode is preserved.
- `runtime.auto_watch` can add entries automatically (see above).

```
/claude-gh-channel:gh-channel-watch add pr <url> [--as <skill>]
/claude-gh-channel:gh-channel-watch remove pr <url>
/claude-gh-channel:gh-channel-watch mode hard|soft
/claude-gh-channel:gh-channel-watch show
/claude-gh-channel:gh-channel-watch clear
```

`/gh-channel-pin pr <url> --hard|--soft` is a one-shot shorthand: clear the watchlist, set the mode, add one entry.

## The four skills

| Skill | Triggers on | What it produces |
|---|---|---|
| **pr-triage** | You open a PR in a repo you maintain | Risk flags (migrations, security-adjacent files, large diffs), suggested labels, a triage summary saved to `drafts/` |
| **pr-review-prep** | You're requested as reviewer | 2-3 key questions grounded in the diff, a suggested reading order, all saved to `drafts/` |
| **pr-comment-respond** | Someone comments on your PR | A drafted reply in your voice, saved to `drafts/`. Never posted. |
| **pr-merge-followup** | Your PR merges | Scans the PR body for `TODO:` / `Followup:` markers and Linear ticket IDs; appends them to `~/command-center/todo.md` |

All four follow the rules in [`skills/_shared/handler-contract.md`](plugins/claude-gh-channel/skills/_shared/handler-contract.md): read-only on GitHub, drafts go to local scratch files, never post, never push, bail on huge diffs rather than auto-drafting a half-baked review.

Skills use one MCP tool — `channel_reply` — to write back. That tool handles draft file paths, slugs, timestamping, and cmux sidebar updates. Skills don't write files directly; they call `channel_reply` and the server figures out where things go.

## Commands

All commands are **namespaced** under the plugin name — Claude Code prefixes plugin-provided commands with `<plugin-name>:` to avoid collisions. So in your session you type `/claude-gh-channel:<name>`, not `/<name>`. Examples below use the namespaced form.

| Command | What it does |
|---|---|
| `/claude-gh-channel:gh-channel-setup` | One-time interactive bootstrap. Idempotent — re-run to update tunnel URL or repo. |
| `/claude-gh-channel:gh-channel-status` | Snapshot: tunnel up + reachable? webhook active on GitHub? watcher attached? queue depth? |
| `/claude-gh-channel:gh-channel-tunnel` | Ensure a live tunnel — self-heals (fresh tunnel + repointed webhook) if the current one is dead. Run when events stop arriving. |
| `/claude-gh-channel:gh-channel-enable` | Master ON: tunnel up + webhook `active: true` + runtime flag. |
| `/claude-gh-channel:gh-channel-disable` | Master OFF: webhook `active: false`. Reversible. Tunnel kept up. |
| `/claude-gh-channel:gh-channel-pause 2h` | Time-windowed pause. Events queue but don't emit. Also `quiet` / `pause-repo OWNER/NAME` / `resume`. |
| `/claude-gh-channel:gh-channel-reload` | Re-read `config.yaml`. Subscriptions, routing hints, filters, auto_watch update live; brief + port need a watcher restart. |
| `/claude-gh-channel:gh-channel-watch` | Manage the watchlist: `add pr <url> [--as <skill>]`, `remove`, `show`, `clear`, `mode hard\|soft`. Persists to disk. |
| `/claude-gh-channel:gh-channel-pin pr <url> --hard\|--soft [--as <skill>]` | One-shot shorthand for a single-PR watchlist. |
| `/claude-gh-channel:gh-channel-queue` | Show pending + recent events from the SQLite queue. |
| `/claude-gh-channel:gh-channel-replay <delivery_id>` | Re-emit a past event to the watcher. Accepts a prefix if unambiguous. |
| `/claude-gh-channel:gh-channel-uninstall` | Confirmed teardown: delete GH webhook, stop tunnel, remove launchd plist, archive SQLite DB. Leaves config + secret. |

## How it actually works

```
┌──────────────┐ webhook   ┌───────────────────┐ HTTP    ┌──────────────────────┐
│  GitHub.com  │──────────►│ cloudflared tunnel │────────►│ server.bundle.js      │
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
                                                          ▼                     ▼
                                                  drafts/...md        cmux sidebar / notify
```

The server lives **inside** your Claude session as an MCP subprocess. When you attach with `--dangerously-load-development-channels`, Claude spawns `bun ${CLAUDE_PLUGIN_ROOT}/server/server.bundle.js` (pre-bundled — no `node_modules` needed in the cache), which:

1. Reads your config, secret, and watchlist
2. Binds `127.0.0.1:8788`
3. Opens the SQLite queue
4. Drains anything pending from past sessions
5. Waits for webhook POSTs

When a webhook arrives, the server: verifies the HMAC, checks subscriptions + filters, runs auto-watch hooks, applies the watchlist gate + routing hints, persists to SQLite (idempotent on `delivery_id` so GH retries are safe), and emits an MCP notification. The notification flows up the stdio transport into your watcher's context — which is why it shows up as `← gh-channel: ...` in the pane.

**Only the final hop uses Claude Code's channels feature.** Everything else — HMAC verify, filtering, watchlist, SQLite, `cmux notify` — runs server-side and works regardless of the `channelsEnabled` org policy. That's why auto-watch + `cmux notify` is a usable real-time surface even on a gated plan.

Deep dive (process tree, file locations, sequence diagrams, debugging recipes): [docs/walkthrough.md](docs/walkthrough.md).

## Troubleshooting

**Q: My PR doesn't show up in the watcher pane.**
Run `/gh-channel-status` or `ghstatus`. Most common causes, in order:
1. **Dead/rotated tunnel** (most common). Run `/gh-channel-tunnel` or `ghtunnel` — it self-heals and repoints the webhook. If the fresh tunnel won't resolve (`NXDOMAIN`), that's Cloudflare's quick-tunnel service lagging; wait a minute and retry.
2. **No watcher attached.** Launch one with `ghwatch`.
3. **Channels gated by org policy** (Team/Enterprise). See the next question.

**Q: The watcher pane says "blocked by org policy / inbound messages will be silently dropped."**
Your Claude Code org (Team or Enterprise) hasn't enabled channels. An admin needs to set `channelsEnabled: true` in [managed settings](https://code.claude.com/docs/en/server-managed-settings). It syncs to `~/.claude/remote-settings.json`; restart the watcher after it lands. Until then, channel-into-pane is off, but `auto_watch` + `cmux notify` still surface events.

**Q: Events show up in `/gh-channel-queue` but the watcher pane is silent.**
Usually means Claude is mid-tool-call or about to compact. Wait a tick or `cmd-shift-c` to compact and check again.

**Q: I rebooted / left it overnight. Nothing's working.**
The cloudflared quick tunnel rotated or died. Run `ghtunnel` (or `ghwatch`, which does it for you). It provisions a fresh tunnel and repoints the webhook automatically.

**Q: `/gh-channel-status` says the webhook is returning 401.**
Secret mismatch. Run `/gh-channel-setup` again (regenerates + syncs), or `/gh-channel-tunnel` (repoints with the on-disk secret).

**Q: I want to watch a second repo.**
Add another entry under `subscriptions:` in `config.yaml`, then register a webhook on that repo with the same secret + tunnel URL (`gh api -X POST repos/<owner>/<repo>/hooks --input -`). Re-run `/gh-channel-reload`. Multi-repo first-class support is on the roadmap.

**Q: I want it to stop bothering me for an hour.**
`/gh-channel-pause 1h`. Events still queue; they drain when the window passes.

**Q: I want to nuke it.**
`/gh-channel-uninstall`. Confirms, then deletes the GitHub webhook, stops the tunnel, removes the launchd plist, archives the SQLite DB. Config + secret are left in place — to wipe completely, also `rm -rf ~/.config/claude-gh-channel ~/.local/share/claude-gh-channel`.

## Known limitations (v1)

| Limitation | What it means in practice |
|---|---|
| **Cloudflare quick-tunnel flakiness** | This is the single most likely thing to break a live setup. Account-less `*.trycloudflare.com` tunnels have no uptime guarantee: they rotate URLs on restart, drop mid-session, and their DNS can take minutes to propagate or fail outright (`NXDOMAIN` / `530` under service load). The plugin self-heals (`ghtunnel` / `ghwatch` provision fresh + repoint the webhook), but it can't fix Cloudflare's edge being slow to assign a hostname. **Durable fix: a named cloudflared tunnel with a DNS record you control** (stable URL, no rotation) — on the roadmap, needs a Cloudflare account + domain. |
| **`channelsEnabled` org policy on Team/Enterprise plans** | Channel notifications gated by managed settings. The watcher boots and shows `blocked by org policy / Inbound messages will be silently dropped`. Fix: admin sets `channelsEnabled: true` in [managed settings](https://code.claude.com/docs/en/server-managed-settings). Until then, channel-into-pane is off but `auto_watch` + `cmux notify` still surface events. |
| **Plain `--channels` (no `--dangerously-load-development-channels`)** | Anthropic curates the channels allowlist; self-published channel plugins always need the dev flag during the research preview. Out of our control. Use the `ghwatch` alias to make it ergonomic. |
| Server runs inside the Claude session (no separate daemon) | If no watcher is attached when GitHub fires a webhook, the tunnel hop fails and GitHub retries for ~8 hours. Workaround: keep a watcher attached. v2 will split the daemon from the Claude session. |
| macOS only | Launchd auto-start, cmux integration. Linux/systemd support not in v1. |
| One Claude watcher per machine | Channels are 1:1 (proven in `spike/0.4-multi-session/EVIDENCE.md`). Multi-watcher fan-out needs the v2 daemon split. |
| Multi-repo first-class config | Subscriptions can list multiple repos in `config.yaml`, but `/gh-channel-setup` only registers one webhook. Add more by hand. |
| Lightweight config validation | Required fields + version check. Full JSON-schema validation against `config/schema.json` is on the roadmap. |
| GitHub only | The architecture supports sibling adapters (Linear, Slack, Recall) but only GitHub is built. |

## Repository layout

```
claude-gh-channel/                       # marketplace root (this repo)
├── .claude-plugin/
│   └── marketplace.json                 # Marketplace manifest
├── plugins/
│   └── claude-gh-channel/               # The plugin itself
│       ├── .claude-plugin/plugin.json   # Plugin manifest (declares the channel)
│       ├── .mcp.json                    # Registers the `gh-channel` MCP server
│       ├── server/                      # Channel server: HTTP + MCP stdio
│       │   ├── index.ts                 # Main loop + HTTP endpoints
│       │   ├── config.ts                # YAML loader + templating
│       │   ├── filters.ts               # Subscription + routing-hint evaluator
│       │   ├── queue.ts                 # bun:sqlite queue + dedup
│       │   ├── watchlist.ts             # Persistent watchlist + modes
│       │   ├── reply.ts                 # `channel_reply` MCP tool
│       │   └── server.bundle.js         # Pre-bundled server (what .mcp.json runs)
│       ├── config/
│       │   ├── schema.json              # JSON schema for config.yaml
│       │   ├── example.yaml             # Starter config
│       │   └── default-brief.md         # Templated agent_brief
│       ├── commands/                    # 12 slash commands (setup + lifecycle)
│       ├── skills/                      # Four handler skills + shared contract
│       ├── scripts/
│       │   └── ensure-tunnel.sh         # Self-healing tunnel provisioner
│       └── installer/                   # macOS launchd template + install/uninstall
├── docs/walkthrough.md                  # Deep dive with file layouts + debugging
├── spike/                               # M0-M5 evidence — read these to understand decisions
│   ├── 0.1-channel-roundtrip/           # Channel capability proven
│   ├── 0.2-reply-tool/                  # MCP tool round-trip proven
│   ├── 0.3-bg-session-viability/        # 24h heartbeat (not run to completion)
│   ├── 0.4-multi-session/               # Why channels are per-session
│   ├── 0.5-gh-roundtrip/                # Real-GH end-to-end proof
│   └── M2-M5-INTEGRATION-EVIDENCE.md    # Full M2-M4 layer + install/pin E2E
├── CLAUDE.md                            # Contributor guide (E2E-through-cmux policy)
├── FOLLOWUPS.md                         # Onboarding rough edges + fix sizing
└── README.md
```

## Status

**v0.1.7.** Bootstrap, the four built-in skills, the lifecycle commands, the SQLite queue, the config-driven steering layer, the persistent watchlist + auto-watch, the self-bundled server, and the self-healing tunnel are all landed and end-to-end tested (see `spike/M2-M5-INTEGRATION-EVIDENCE.md` + the commit history).

Roadmap (not in v1):
- **Named cloudflared tunnel + DNS** — the durable fix for the quick-tunnel flakiness. The biggest remaining reliability gap.
- Standalone daemon so events don't drop when no watcher is attached
- Multi-repo first-class config (`/gh-channel-setup` registering N webhooks)
- Sibling adapters for Linear / Slack / Recall
- Linux / systemd support
- Strict JSON-schema validation of `config.yaml`

See [FOLLOWUPS.md](FOLLOWUPS.md) for the full punch list with fix sizing.

## Credits

Plugin built against the experimental Claude Code MCP **channels** API. The design doc that drove this (and that holds the longer-term roadmap) is private — it lives in the author's `~/command-center/research/` rather than this repo, because it's a personal planning artifact, not a public spec.

## License

MIT (eventual). For now: personal-use scaffold, no formal license declared.
