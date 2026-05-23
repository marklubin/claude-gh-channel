---
description: Read-only snapshot of claude-gh-channel health — tunnel up, watcher attached, webhook active on GitHub, queue depth, pause/quiet state. Idempotent, makes no changes.
---

# /gh-channel-status

Print a single status report. Run all checks in parallel where possible. Do not attempt to fix anything — this is a diagnostic only. If something looks broken, point at the right command (`/gh-channel-enable`, `/gh-channel-reload`, etc.) rather than acting.

## Step 1 — Verify config exists

```bash
test -f ~/.config/claude-gh-channel/config.json || echo "NOT_CONFIGURED"
```

If missing, stop and tell the user to run `/gh-channel-setup` first. Do not continue.

Load the basics for later steps:
```bash
REPO=$(jq -r '.repo' ~/.config/claude-gh-channel/config.json)
HOOK_ID=$(jq -r '.webhook_id' ~/.config/claude-gh-channel/config.json)
TUNNEL=$(cat ~/.config/claude-gh-channel/tunnel-url 2>/dev/null || echo "")
RUNTIME_ENABLED=$(jq -r '.runtime.enabled // true' ~/.config/claude-gh-channel/config.json)
PAUSE_UNTIL=$(jq -r '.runtime.pause_until // empty' ~/.config/claude-gh-channel/config.json)
QUIET=$(jq -r '.runtime.quiet_mode // false' ~/.config/claude-gh-channel/config.json)
DISABLED_REPOS=$(jq -r '.runtime.disabled_repos // [] | join(",")' ~/.config/claude-gh-channel/config.json)
```

## Step 2 — Parallel checks

Run these concurrently; gather all results before printing.

**Tunnel process (cloudflared):**
```bash
if [ -f ~/.config/claude-gh-channel/cloudflared.pid ] && kill -0 "$(cat ~/.config/claude-gh-channel/cloudflared.pid)" 2>/dev/null; then
  echo "TUNNEL=up pid=$(cat ~/.config/claude-gh-channel/cloudflared.pid)"
else
  pgrep -fl "cloudflared tunnel --url http://localhost:8788" || echo "TUNNEL=down"
fi
```

**Watcher session attached (server bound to 8788):**
```bash
lsof -nP -iTCP:8788 -sTCP:LISTEN 2>/dev/null | tail -n +2 || pgrep -fl "bun.*server/index.ts" || echo "WATCHER=none"
```

**Server /health (only meaningful if a watcher is attached):**
```bash
curl -fsS --max-time 3 "http://localhost:8788/health" 2>/dev/null || echo "HEALTH=unreachable"
```

**Tunnel public URL reachable** (only run if watcher is up — otherwise it will 502 even on a healthy tunnel, which is expected and not a failure):
```bash
[ -n "$TUNNEL" ] && curl -fsS --max-time 5 "$TUNNEL/health" 2>/dev/null || echo "PUBLIC=skipped_or_unreachable"
```

**GitHub webhook state:**
```bash
gh api "repos/$REPO/hooks/$HOOK_ID" --jq '{active, last_response: .last_response, events}' 2>/dev/null || echo "GH_HOOK=error"
```

**Queue stats** — prefer the running server's `/queue` summary; fall back to direct sqlite read if no watcher is attached:
```bash
if curl -fsS --max-time 2 "http://localhost:8788/queue?summary=1" >/dev/null 2>&1; then
  curl -fsS "http://localhost:8788/queue?summary=1"
else
  sqlite3 ~/.local/share/claude-gh-channel/events.db \
    "SELECT COUNT(*) total, SUM(CASE WHEN emitted=0 THEN 1 ELSE 0 END) pending, MAX(received_at) latest FROM events;" 2>/dev/null \
    || echo "QUEUE=db_missing"
fi
```

## Step 3 — Print the report

Format as a compact table. Example layout:

```
claude-gh-channel status

Component       State
─────────────── ──────────────────────────────────────────────
Repo            <REPO>
Runtime         enabled=<RUNTIME_ENABLED> quiet=<QUIET> pause_until=<PAUSE_UNTIL or "—">
Disabled repos  <DISABLED_REPOS or "—">
Tunnel          <up|down> pid=<pid>  url=<tunnel-url>
Watcher         <attached|none>  port 8788
Public URL      <reachable|unreachable|skipped (no watcher)>
GH webhook      active=<bool>  last=<code or "none">  events=<n>
Queue           total=<n>  pending=<n>  latest=<ts or "—">
```

Below the table, surface red flags as bullets:
- Tunnel down → suggest `/gh-channel-enable`.
- Watcher none → tell user `claude --channels plugin:claude-gh-channel:gh-channel` in a fresh pane (events queue to SQLite regardless; they won't be lost).
- GH webhook `active=false` → `/gh-channel-enable` will flip it.
- GH `last_response.code` ≥ 400 → tunnel URL may have rotated; suggest `/gh-channel-reload` after restarting cloudflared.
- `pause_until` in the future → mention how long until it lifts.

Do not modify anything. The whole command is read-only.
