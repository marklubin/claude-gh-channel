# claude-gh-channel

A Claude Code plugin that surfaces GitHub PR/issue/review events into a persistent background Claude session via the experimental MCP **channels** API.

**Status:** v0.1.0 — minimal scaffold. End-to-end pipe (real GH webhook → tunnel → HMAC verify → channel notification → Claude session) is proven (see `spike/0.5-gh-roundtrip/EVIDENCE.md`). Most of the design-doc surface (config schema, CEL filters, SQLite queue, multi-skill catalog, launchd auto-start) is NOT yet implemented.

## What works today

- **The pipe.** Real GitHub webhooks land in an attached Claude session in ~1-2s, HMAC-verified.
- **4 event types summarized**: `pull_request`, `issue_comment` (PR-only), `pull_request_review`, `pull_request_review_comment`.
- **One bootstrap command**: `/gh-channel-setup` walks through secret generation, tunnel creation, webhook registration, and config write.
- **One skill**: `pr-review-prep` — drafts review notes locally when Mark is requested as a reviewer.

## What does NOT work yet (intentional v1 boundaries)

| Missing | Why deferred |
|---|---|
| SQLite queue + drain on attach | Events drop silently if no Claude attached at delivery time. M3 in the design doc. |
| Persistent named tunnel | Quick tunnels rotate URLs on restart. M4 will set up a named cloudflared tunnel + DNS. |
| `/gh-channel-enable` / `disable` / `pause` / `status` / `reload` / `replay` | M4. v1 manages webhook state via raw `gh api`. |
| Launchd plist auto-start | M4. v1 requires manual `claude --channels …` attach. |
| Routing hints, CEL filters, `agent_brief` templating | M2 in design doc. |
| `pr-triage`, `pr-comment-respond`, `pr-merge-followup` skills | M3. Only `pr-review-prep` is in v1. |
| Multi-repo support | One webhook per setup-command run. Re-run for a second repo (no first-class config). |

## Install (local dev)

```bash
# 1. Clone
git clone https://github.com/marklubin/claude-gh-channel ~/claude-gh-channel
cd ~/claude-gh-channel

# 2. Install deps
(cd server && bun install)

# 3. Install plugin
# Option A: marketplace install (when published)
# Option B: local install — from a Claude Code session:
#   /plugin install file://$HOME/claude-gh-channel

# 4. Bootstrap (from a Claude session that has the plugin installed)
/gh-channel-setup

# 5. Attach a watcher session (any terminal)
claude --channels plugin:claude-gh-channel:gh-channel
```

## How attachment works

`.mcp.json` at plugin root registers a `gh-channel` MCP server that runs `bun ${CLAUDE_PLUGIN_ROOT}/server/index.ts`. The server:

- Declares `experimental['claude/channel']: {}` capability — that's what makes it a channel
- Reads webhook secret from `GH_WEBHOOK_SECRET` env or `~/.config/claude-gh-channel/secret`
- Binds `127.0.0.1:8788` for the GitHub webhook receiver
- On each verified webhook, calls `notifications/claude/channel` over the stdio MCP transport

Any Claude session launched with `--channels plugin:claude-gh-channel:gh-channel` will spawn this server as a subprocess (per-session — see `spike/0.4-multi-session/EVIDENCE.md` for the architectural finding that channels are 1:1).

## Layout

```
claude-gh-channel/
├── .claude-plugin/
│   └── plugin.json           # Plugin manifest
├── .mcp.json                 # Registers `gh-channel` MCP server
├── server/
│   ├── index.ts              # The channel server (HMAC + summarizers + HTTP)
│   ├── package.json
│   └── tsconfig.json
├── commands/
│   └── gh-channel-setup.md   # Interactive bootstrap
├── skills/
│   └── pr-review-prep/
│       └── SKILL.md          # First handler skill
├── spike/                    # M0 evidence — DO NOT delete
│   ├── 0.1-channel-roundtrip/  → channel capability round-trip (PASS)
│   ├── 0.2-reply-tool/         → MCP tool round-trip (PASS)
│   ├── 0.3-bg-session-viability/  → 24h heartbeat (server built, full burn-in not run)
│   ├── 0.4-multi-session/       → multi-session isolation (PASS — channels are 1:1)
│   └── 0.5-gh-roundtrip/        → real-GH E2E (PASS, 5/5 deliveries, 0 rejects)
└── README.md
```

## Design doc

The full design (config schema, CEL filters, skill catalog, milestones) lives at:

`~/command-center/research/gh-pr-channel-plugin-design.md`

It's not in this repo intentionally — it's a personal planning artifact, not a public spec.

## License

MIT (eventual). Personal-use scaffold for now.
