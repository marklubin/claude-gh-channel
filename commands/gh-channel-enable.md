---
description: Turn the claude-gh-channel ON — start cloudflared if needed, flip GH webhook active=true, set runtime.enabled=true in config, verify with a ping. Idempotent.
---

# /gh-channel-enable

Master switch back to ON. Safe to run when already enabled — every step checks current state first.

## Step 1 — Preconditions

```bash
test -f ~/.config/claude-gh-channel/config.json || { echo "Not configured — run /gh-channel-setup first"; exit 1; }

REPO=$(jq -r '.repo' ~/.config/claude-gh-channel/config.json)
HOOK_ID=$(jq -r '.webhook_id' ~/.config/claude-gh-channel/config.json)
test -n "$REPO" -a "$HOOK_ID" != "null" || { echo "Config missing repo or webhook_id"; exit 1; }
```

If `gh auth status` fails, stop and tell the user to `gh auth login --scopes repo`.

## Step 2 — Start cloudflared if not running

Check for a live pid first:
```bash
PID_FILE=~/.config/claude-gh-channel/cloudflared.pid
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "cloudflared already running pid=$(cat "$PID_FILE")"
else
  rm -f "$PID_FILE"
fi
```

If not running, prefer launchd when a plist is installed (M2 territory — check it exists), else fall back to nohup:

```bash
PLIST=~/Library/LaunchAgents/com.marklubin.claude-gh-channel.plist
if [ -f "$PLIST" ]; then
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl kickstart -k "gui/$(id -u)/com.marklubin.claude-gh-channel"
else
  nohup cloudflared tunnel --url http://localhost:8788 --no-autoupdate \
    > ~/.config/claude-gh-channel/cloudflared.log 2>&1 &
  echo $! > "$PID_FILE"
fi
```

Poll the log for the public URL (up to 15s). If it rotated (differs from the value in `~/.config/claude-gh-channel/tunnel-url`), update the file AND warn the user — the GH webhook URL still points at the old one and will need `/gh-channel-reload` + a webhook URL patch:

```bash
for i in $(seq 1 15); do
  NEW_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' ~/.config/claude-gh-channel/cloudflared.log | tail -1)
  [ -n "$NEW_URL" ] && break
  sleep 1
done
OLD_URL=$(cat ~/.config/claude-gh-channel/tunnel-url 2>/dev/null || echo "")
echo "$NEW_URL" > ~/.config/claude-gh-channel/tunnel-url
if [ -n "$OLD_URL" ] && [ "$OLD_URL" != "$NEW_URL" ]; then
  echo "WARN: tunnel URL rotated. GH webhook still points at $OLD_URL — patching it now."
  jq --arg u "$NEW_URL/webhook" '.config.url = $u' <<<'{}' > /tmp/gh-channel-url-patch.json
  gh api -X PATCH "repos/$REPO/hooks/$HOOK_ID" \
    -f "config[url]=$NEW_URL/webhook" \
    -f "config[content_type]=json" >/dev/null
fi
```

If no URL appears in 15s, surface `~/.config/claude-gh-channel/cloudflared.log` and stop.

## Step 3 — Flip GH webhook active=true

Skip the API call if already active:
```bash
ACTIVE=$(gh api "repos/$REPO/hooks/$HOOK_ID" --jq '.active' 2>/dev/null)
if [ "$ACTIVE" = "true" ]; then
  echo "Webhook already active"
else
  gh api -X PATCH "repos/$REPO/hooks/$HOOK_ID" -F active=true --jq '{id, active}'
fi
```

## Step 4 — Flip runtime.enabled and clear pause_until

```bash
TMP=$(mktemp)
jq '.runtime = (.runtime // {}) | .runtime.enabled = true | del(.runtime.pause_until)' \
  ~/.config/claude-gh-channel/config.json > "$TMP" \
  && mv "$TMP" ~/.config/claude-gh-channel/config.json
chmod 600 ~/.config/claude-gh-channel/config.json
```

We deliberately clear `pause_until` here — enable means "fully on." `quiet_mode` and `disabled_repos` are left alone (those are scoped controls, not the master switch).

## Step 5 — Verify with a ping

```bash
gh api -X POST "repos/$REPO/hooks/$HOOK_ID/pings" 2>&1
```

Then check delivery status after ~3s:
```bash
sleep 3
gh api "repos/$REPO/hooks/$HOOK_ID" --jq '.last_response'
```

`last_response.code` should be 2xx. If 5xx or 0, the watcher session is probably not attached — that's fine, the webhook still fires and events buffer to SQLite once a watcher comes up, but the immediate ping won't reach a handler.

## Step 6 — Report

One paragraph: tunnel state (started fresh or already up), webhook active=true confirmed, runtime.enabled=true, public URL, and whether a watcher is attached (`lsof -nP -iTCP:8788 -sTCP:LISTEN`). If no watcher, remind the user to `claude --channels plugin:claude-gh-channel:gh-channel` in a fresh pane.
