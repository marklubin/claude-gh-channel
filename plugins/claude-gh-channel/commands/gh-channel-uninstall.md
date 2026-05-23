---
description: Tear down claude-gh-channel — delete GH webhook, stop cloudflared, remove launchd plist if present, archive the SQLite queue. REQUIRES confirmation. Leaves config.yaml + secret on disk for easy reinstall.
---

# /gh-channel-uninstall

Destructive. The only command in this plugin that mutates remote state (the GH webhook) and kills running processes without restarting them. Always confirm before acting.

We deliberately leave the user's config + secret in place so reinstall is a single `/gh-channel-setup` away (it will detect the existing secret and offer to reuse it). If they want a true scorched-earth reset, they delete `~/.config/claude-gh-channel/` by hand.

## Step 1 — Gather what will be removed

```bash
test -f ~/.config/claude-gh-channel/config.json || { echo "Nothing installed — config file not found"; exit 0; }

REPO=$(jq -r '.repo' ~/.config/claude-gh-channel/config.json)
HOOK_ID=$(jq -r '.webhook_id' ~/.config/claude-gh-channel/config.json)
PID_FILE=~/.config/claude-gh-channel/cloudflared.pid
PLIST=~/Library/LaunchAgents/com.marklubin.claude-gh-channel.plist
DB=~/.local/share/claude-gh-channel/events.db

TUNNEL_PID=""
[ -f "$PID_FILE" ] && TUNNEL_PID=$(cat "$PID_FILE")

QUEUE_TOTAL=0
[ -f "$DB" ] && QUEUE_TOTAL=$(sqlite3 "$DB" "SELECT COUNT(*) FROM events;" 2>/dev/null || echo 0)
```

## Step 2 — Confirm with the user (MANDATORY)

Use `AskUserQuestion` with a clear summary of what's about to happen. Do not proceed if the user picks anything other than the explicit "yes, uninstall" option.

Question text should include:
- "Delete webhook id `$HOOK_ID` on `$REPO` (irreversible — re-setup creates a new one with a different id)"
- "Stop cloudflared (pid `$TUNNEL_PID`)"
- "Remove launchd plist at `$PLIST` if it exists"
- "Archive SQLite queue (`$QUEUE_TOTAL` events) to a timestamped file — not deleted"
- "Keep config.json and the webhook secret on disk for easy reinstall"

Options:
- "Yes, uninstall" → proceed.
- "Cancel" → exit cleanly.

If the user wants to keep the webhook configured but just turn things off, redirect them to `/gh-channel-disable` and exit.

## Step 3 — Delete the GitHub webhook

```bash
if [ "$HOOK_ID" != "null" ] && [ -n "$HOOK_ID" ]; then
  gh api -X DELETE "repos/$REPO/hooks/$HOOK_ID" 2>&1 || echo "WARN: webhook delete failed (already gone? check gh api repos/$REPO/hooks)"
fi
```

A 404 here is not an error — it means the webhook is already gone. A 403 means the token lacks `repo` scope; surface it but continue with local cleanup.

## Step 4 — Stop cloudflared

```bash
if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
  kill -TERM "$TUNNEL_PID"
  for i in 1 2 3; do kill -0 "$TUNNEL_PID" 2>/dev/null || break; sleep 1; done
  kill -KILL "$TUNNEL_PID" 2>/dev/null || true
fi
rm -f "$PID_FILE"

# Also kill any orphaned cloudflared targeting our port
pkill -f "cloudflared tunnel --url http://localhost:8788" 2>/dev/null || true
```

## Step 5 — Remove launchd plist if installed

```bash
if [ -f "$PLIST" ]; then
  launchctl bootout "gui/$(id -u)/com.marklubin.claude-gh-channel" 2>/dev/null || true
  rm -f "$PLIST"
fi
```

`bootout` returning non-zero is fine — the service may already be stopped. We just want the plist gone so it doesn't auto-start on next login.

## Step 6 — Kill any attached watcher

```bash
PORT_PID=$(lsof -nP -iTCP:8788 -sTCP:LISTEN -t 2>/dev/null || true)
[ -n "$PORT_PID" ] && kill -TERM $PORT_PID 2>/dev/null || true
```

The user's Claude session that was attached to this channel will lose its channel — that's expected.

## Step 7 — Archive the SQLite queue

Don't delete the DB outright — events may be useful for postmortem. Move it aside with a timestamp:

```bash
if [ -f "$DB" ]; then
  ARCHIVE=~/.local/share/claude-gh-channel/events.archive-$(date +%Y%m%d-%H%M%S).db
  mv "$DB" "$ARCHIVE"
  rm -f "$DB-wal" "$DB-shm"
  echo "Queue archived to $ARCHIVE"
fi
```

## Step 8 — Report (be explicit)

Print a checklist of exactly what happened:

```
Uninstalled:
  [x] GitHub webhook <id> on <repo>   (or: already gone)
  [x] cloudflared tunnel (pid <pid>)
  [x] launchd plist (or: was not installed)
  [x] Attached watcher on :8788 (or: none was attached)
  [x] SQLite queue archived to <path>

Kept (for easy reinstall):
  ~/.config/claude-gh-channel/config.json
  ~/.config/claude-gh-channel/secret
  ~/.config/claude-gh-channel/tunnel-url (stale — will be regenerated on reinstall)
  ~/.local/share/claude-gh-channel/events.archive-*.db

To reinstall: /gh-channel-setup (will detect existing secret and offer to reuse).
To fully wipe: rm -rf ~/.config/claude-gh-channel ~/.local/share/claude-gh-channel
```

If any step failed, mark it `[!]` instead of `[x]` and include the error inline. Never silently swallow a failure — the user needs to know what's still hanging around.
