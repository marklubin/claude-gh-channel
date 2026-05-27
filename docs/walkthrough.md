# Walkthrough

A guided tour of `claude-gh-channel` from first install to first PR-event-in-Claude-pane, end-to-end. Assumes macOS + bun + cloudflared + `gh` CLI.

## TL;DR

```bash
# Prereqs
brew install bun cloudflared gh jq && gh auth login --scopes repo

# 1. In a Claude Code session: add marketplace + install (server ships
#    pre-bundled — no `bun install` needed).
/plugin marketplace add marklubin/claude-gh-channel
/plugin install claude-gh-channel@marklubin
/reload-plugins

# 2. Bootstrap (interactive)
/claude-gh-channel:gh-channel-setup

# 3. In another terminal/pane, attach a watcher. The dev-channels flag is
#    required for self-published channel plugins (see Known limitations).
claude --dangerously-load-development-channels plugin:claude-gh-channel@marklubin --dangerously-skip-permissions

# 4. Trigger a GH event (open a PR, leave a comment, etc.) and watch it land.
```

(The watcher command is long — the README's `ghwatch` alias wraps it and
self-heals the tunnel first.)

That's the happy path. The rest of this doc walks each piece in detail.

## What you'll have running after setup

```
┌─────────────────┐           ┌────────────────────┐         ┌──────────────────┐
│  GitHub repo    │ webhook   │  cloudflared       │ HTTP    │ server.bundle.js │
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
├── config.yaml          # Declarative config (subscriptions, brief, hints, auto_watch)
├── config.json          # Operational state (webhook id, tunnel url, timestamps)
├── secret               # 32-byte hex, mode 0600
├── tunnel-url           # Current cloudflared URL (rotates on restart)
├── watchlist.json       # Persistent watchlist (entries + hard/soft mode)
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
/plugin marketplace add marklubin/claude-gh-channel
/plugin install claude-gh-channel@marklubin
/reload-plugins
```

That registers:
- The MCP server (`gh-channel`) from the plugin's `.mcp.json`, declared as a channel in `plugin.json`
- The slash commands from `commands/` (namespaced as `/claude-gh-channel:<name>` in your session)
- The handler skills from `skills/`

The server is pre-bundled (`server/server.bundle.js`), so there's no `bun install` step in the cache — it just runs.

### 3. Bootstrap

```
/claude-gh-channel:gh-channel-setup
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

In a new terminal or cmux pane (the `--dangerously-load-development-channels` flag is required for self-published channel plugins):

```bash
claude --dangerously-load-development-channels plugin:claude-gh-channel@marklubin --dangerously-skip-permissions
```

This spawns `bun ${CLAUDE_PLUGIN_ROOT}/server/server.bundle.js` as a subprocess. The server:
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
| `/claude-gh-channel:gh-channel-status` | Snapshot: tunnel up? webhook active? session attached? queue depth? |
| `/claude-gh-channel:gh-channel-enable` | Master ON — tunnel up, webhook active, runtime.enabled=true |
| `/claude-gh-channel:gh-channel-disable` | Master OFF — webhook inactive, tunnel can stay up. Reversible. |
| `/claude-gh-channel:gh-channel-pause 2h` | Queue events but don't emit for the window |
| `/claude-gh-channel:gh-channel-pause quiet` | Quiet mode — same effect, no time window |
| `/claude-gh-channel:gh-channel-pause pause-repo <r>` | Skip one repo |
| `/claude-gh-channel:gh-channel-pause resume` | Clear all pause/quiet/disabled-repo state |
| `/claude-gh-channel:gh-channel-reload` | Reload config.yaml; user re-attaches |
| `/claude-gh-channel:gh-channel-queue` | Show pending + recent queue rows |
| `/claude-gh-channel:gh-channel-replay <delivery_id>` | Re-emit a specific event from the queue |
| `/claude-gh-channel:gh-channel-pin pr <url> --hard\|--soft` | Focus the watcher on one PR (auto-clears on close) |
| `/claude-gh-channel:gh-channel-uninstall` | Tear it all down (with confirmation) |

## What the handler skills do

Out of the box you get four skills. They're triggered by the watcher Claude reading the event's `suggested_skill` meta field (set by `routing_hints` in your config):

- **pr-triage** — On `pull_request.opened` you authored: read diff, flag risks, draft a triage note.
- **pr-review-prep** — On `pull_request.review_requested` for you: read diff, draft 2-3 review questions.
- **pr-comment-respond** — On `issue_comment.created` by someone else on your PR: draft a reply.
- **pr-merge-followup** — On `pull_request.closed` (merged) you authored: scan PR description for follow-up tasks, add to your todo.

All four are **drafts-only**. Nothing gets posted to GitHub. Drafts land in `~/.config/claude-gh-channel/drafts/`.

## The watchlist + auto-watch

Beyond the standing `subscriptions` + `routing_hints`, you can focus the watcher on a specific set of PRs:

- **Manual**: `/claude-gh-channel:gh-channel-watch add pr <url> [--as <skill>]`, plus `remove` / `show` / `clear` / `mode hard|soft`. Backed by `~/.config/claude-gh-channel/watchlist.json` (survives restart). `soft` mode flags watched-PR events as `priority: critical`; `hard` mode drops everything not on the list. Entries auto-remove when their PR closes.
- **Automatic** (`runtime.auto_watch` in config.yaml): auto-add PRs when you're requested as reviewer (`on_review_requested`) or open your own PR (`on_opened_by_me`), each with an optional default `as_skill` and a `cmux notify` desktop ping. The `notify` path runs server-side and works even when channels are gated by org policy — so on a Team/Enterprise plan without `channelsEnabled`, you still get a desktop notification when a review lands.

`/claude-gh-channel:gh-channel-pin pr <url> --hard|--soft` is the single-PR shorthand (clear + set mode + add one).

## Tunnel flakiness (the #1 thing that breaks a live setup)

Cloudflared **quick tunnels** are account-less and have no uptime guarantee. They rotate URLs on restart, drop mid-session, and their DNS can take minutes to propagate or fail outright (`NXDOMAIN` / `530` under Cloudflare service load — observed repeatedly). When the tunnel's URL is dead, the webhook on GitHub points at nothing; GH retries for ~8h then gives up.

Fixes, by effort:

- **Built-in self-heal (default):** `ghwatch` runs `scripts/ensure-tunnel.sh` before attaching, and `/claude-gh-channel:gh-channel-tunnel` (or `ghtunnel`) does it on demand. The script health-checks the current tunnel and, if it's dead, provisions a fresh one + repoints the webhook automatically. A real HTTP response (even a 502 "server down") counts as alive; only a dead edge (timeout / no URL) triggers a refresh.
- **If a fresh tunnel won't resolve:** that's Cloudflare's edge being slow to assign/propagate the hostname — not a config problem. Wait 30-60s and re-run `ghtunnel`.
- **Durable fix: a named tunnel** with a DNS record you control — stable URL, no rotation, no NXDOMAIN roulette, multiple redundant edge connections. This is the recommended setup for anything you rely on. See [Named tunnel setup](#named-tunnel-setup-recommended) below.

`/claude-gh-channel:gh-channel-status` reports whether the configured webhook URL matches the currently-running tunnel and whether it's reachable.

## Named tunnel setup (recommended)

A named cloudflared tunnel gives you a permanent hostname (e.g. `gh-gateway.yourdomain.com`) that never rotates. The webhook points at it once, forever. Requires a Cloudflare account + a domain on Cloudflare DNS.

### One-time provisioning

Two ways to create the tunnel + DNS record:

**A. cloudflared CLI (browser OAuth):**

```bash
cloudflared tunnel login                                    # authorize your zone in the browser
cloudflared tunnel create gh-gateway                        # writes ~/.cloudflared/<UUID>.json
cloudflared tunnel route dns gh-gateway gh-gateway.yourdomain.com
cat > ~/.cloudflared/config.yml <<YAML
tunnel: gh-gateway
credentials-file: $HOME/.cloudflared/<UUID>.json
ingress:
  - hostname: gh-gateway.yourdomain.com
    service: http://localhost:8788
  - service: http_status:404
YAML
```

**B. Cloudflare API (no browser):** create the tunnel via `POST /accounts/{id}/cfd_tunnel` (needs an API token with **Account → Cloudflare Tunnel → Edit**), write the credentials JSON + config.yml yourself, then create the CNAME via `POST /zones/{zone_id}/dns_records` pointing `gh-gateway` → `<UUID>.cfargotunnel.com` (proxied). The DNS step needs **Zone → DNS → Edit** scoped to the zone — note that "DNS Write" attached to an *account* resource is NOT the same thing and won't work for zone records.

### Tell the plugin to use it

Add a `tunnel` block to `~/.config/claude-gh-channel/config.json`:

```json
{
  "tunnel": { "mode": "named", "name": "gh-gateway", "hostname": "gh-gateway.yourdomain.com" },
  "tunnel_url": "https://gh-gateway.yourdomain.com"
}
```

Repoint the webhook once (permanent):

```bash
gh api -X PATCH repos/<owner>/<repo>/hooks/<id> --input - <<EOF
{"config": {"url": "https://gh-gateway.yourdomain.com/webhook", "content_type": "json", "secret": "$(cat ~/.config/claude-gh-channel/secret)"}, "active": true}
EOF
```

### Keep it running across reboots

```bash
bash "$(ls -d ~/.claude/plugins/cache/marklubin/claude-gh-channel/*/installer/install-named-tunnel.sh | sort -V | tail -1)"
```

That installs a LaunchAgent (`com.marklubin.claude-gh-channel.named-tunnel`) that runs `cloudflared tunnel run gh-gateway` with `KeepAlive`, so the tunnel comes back on crash and on login.

### How named mode changes the self-heal

With `tunnel.mode: named`, `ensure-tunnel.sh` (via `ghtunnel` / `ghwatch`) no longer provisions quick tunnels or repoints the webhook. It just checks the named hostname:
- `200`/`404`/etc → healthy, no-op
- `502` → connector up, server not bound yet (fine — attaches with the watcher)
- `530` (Cloudflare error 1033) → connector down → kickstart the LaunchAgent / restart `cloudflared tunnel run`
- `000` → DNS not resolving (shouldn't happen for a named tunnel)

## When events drop (and how you know)

The MCP server lives inside the Claude session. When no session is attached:
- Tunnel still up → GH delivers → tunnel forwards to `localhost:8788` → no listener → connection refused
- GH retries on its own schedule for ~8h
- During those retries, the queue doesn't grow (we never received the event)

Symptoms:
- `gh api repos/<repo>/hooks/<id>/deliveries --jq '.[] | select(.status_code != 200)'` shows non-200 deliveries
- `/claude-gh-channel:gh-channel-status` reports "no watcher attached"

Workaround for v1: keep a watcher session pinned. The launchd plist can keep cloudflared up, but launchd can't sensibly keep an interactive `claude` going — that's why the design doc's full daemon split (separate webhook receiver process + thin MCP clients) is the right v2 fix.

## Compaction strategy for long-running sessions

The watcher Claude accumulates context as events stream in. Two practical strategies:

1. **Periodic restart**: `cmd-shift-c` (compact) the session daily, or run `/claude-gh-channel:gh-channel-reload` weekly. Drains the queue on re-attach so nothing is lost.
2. **Skill discipline**: Skills must NOT echo huge diffs into the channel response. They write drafts to disk and emit only short status messages. This keeps the conversation channel lean even when handling 50 events/day.

## Cleanup

To wipe completely:

```
/claude-gh-channel:gh-channel-uninstall
```

That deletes the webhook, stops cloudflared (and removes plist if installed), archives the SQLite DB. It leaves `config.yaml` and the secret so reinstall is one command.

To nuke the config too:

```bash
rm -rf ~/.config/claude-gh-channel ~/.local/share/claude-gh-channel
```

## Debugging

### Events show up in `/queue` but the watcher pane is silent

The MCP notification was sent but Claude's context isn't reading it. Usually means Claude is mid-tool-call or compaction. Wait a tick or `cmd-shift-c` and check again.

### `/claude-gh-channel:gh-channel-status` says webhook returns 401

Secret mismatch between `~/.config/claude-gh-channel/secret` and the GH webhook config. Either:
- Run `/claude-gh-channel:gh-channel-setup` again to regenerate + update GH side
- Or manually: `gh api -X PATCH repos/<repo>/hooks/<id> -f config[secret]="$(cat ~/.config/claude-gh-channel/secret)"`

### Tunnel URL changed but webhook still points at the old one

Run `/claude-gh-channel:gh-channel-tunnel` (or `ghtunnel`) — it self-heals: fresh tunnel + repointed webhook. `/claude-gh-channel:gh-channel-setup` also works.

### Watcher pane shows "blocked by org policy / inbound messages will be silently dropped"

Your Claude Code org (Team or Enterprise) hasn't enabled channels. An admin must set `channelsEnabled: true` in [managed settings](https://code.claude.com/docs/en/server-managed-settings); it syncs to `~/.claude/remote-settings.json`. Restart the watcher after it lands (the policy is read at session start — restarting in the same minute as the sync can race and read the stale value). Until then, channel-into-pane is off, but `auto_watch` + `cmux notify` still surface events server-side.

### Server won't start: "config: ~/.config/claude-gh-channel/config.yaml not found"

You haven't run `/claude-gh-channel:gh-channel-setup` yet. Run it.

### Server crashed mid-session

Re-attach with `ghwatch` (or `claude --dangerously-load-development-channels plugin:claude-gh-channel@marklubin --dangerously-skip-permissions`). The queue will replay anything that hadn't emitted.

## What's NOT in v1

Things the design doc covers but this version doesn't:
- Linear / Slack adapter siblings (just GitHub for now)
- Multi-machine session coordination
- Named tunnel auto-provisioning
- Web UI for config editing
- Compaction-aware context budgets
- Per-skill cost tracking

Most are M5+ or v2 features. Open issues on GitHub for any of them that bite.
