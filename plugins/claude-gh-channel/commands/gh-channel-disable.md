---
description: Turn the claude-gh-channel OFF — flip GH webhook active=false and set runtime.enabled=false. Tunnel stays up. Fully reversible with /gh-channel-enable. Idempotent.
---

# /gh-channel-disable

Stop receiving events without tearing anything down. The webhook stays registered (just inactive) and the cloudflared tunnel keeps running — this is the "I want a clean inbox for a few days" lever, not the uninstall path.

For full teardown, use `/claude-gh-channel:gh-channel-uninstall`. For a time-boxed pause, use `/claude-gh-channel:gh-channel-pause`.

## Step 1 — Preconditions

```bash
test -f ~/.config/claude-gh-channel/config.json || { echo "Not configured — nothing to disable"; exit 0; }

REPO=$(jq -r '.repo' ~/.config/claude-gh-channel/config.json)
HOOK_ID=$(jq -r '.webhook_id' ~/.config/claude-gh-channel/config.json)
test -n "$REPO" -a "$HOOK_ID" != "null" || { echo "Config missing repo or webhook_id"; exit 1; }
```

If `gh auth status` fails, stop and instruct `gh auth login --scopes repo`.

## Step 2 — Flip GH webhook active=false

Idempotent — skip the PATCH if already inactive:
```bash
ACTIVE=$(gh api "repos/$REPO/hooks/$HOOK_ID" --jq '.active' 2>/dev/null)
if [ "$ACTIVE" = "false" ]; then
  echo "Webhook already inactive on GitHub"
else
  gh api -X PATCH "repos/$REPO/hooks/$HOOK_ID" -F active=false --jq '{id, active}'
fi
```

If the GH API returns 404, the webhook has been deleted out from under us. Tell the user and stop — they probably want `/claude-gh-channel:gh-channel-setup` to re-register, not `/claude-gh-channel:gh-channel-disable`.

## Step 3 — Set runtime.enabled=false in config

```bash
TMP=$(mktemp)
jq '.runtime = (.runtime // {}) | .runtime.enabled = false' \
  ~/.config/claude-gh-channel/config.json > "$TMP" \
  && mv "$TMP" ~/.config/claude-gh-channel/config.json
chmod 600 ~/.config/claude-gh-channel/config.json
```

This is the second line of defense: even if GitHub redelivers a buffered event, the running server will see `runtime.enabled=false` and refuse to emit. The two are belt-and-suspenders intentionally.

## Step 4 — Leave the tunnel alone

Do NOT kill cloudflared. Do NOT remove the webhook. The whole point of disable (vs uninstall) is that re-enabling is one command.

If a watcher session is attached and you want it to pick up the new config without a restart, tell the user to run `/claude-gh-channel:gh-channel-reload`. Otherwise the server will see the flag on its next config-poll cycle (or next process start).

## Step 5 — Report

One short paragraph:
- Webhook on `$REPO`: now inactive (GH will not deliver until re-enabled).
- `runtime.enabled` in config: false.
- Tunnel + watcher: left running. Public URL still in `~/.config/claude-gh-channel/tunnel-url`.
- To turn back on: `/claude-gh-channel:gh-channel-enable` (idempotent, ~5s).
- To tear down fully: `/claude-gh-channel:gh-channel-uninstall`.

Surface the current queue depth in passing so the user knows whether to drain it before re-enabling:
```bash
sqlite3 ~/.local/share/claude-gh-channel/events.db \
  "SELECT COUNT(*) FROM events WHERE emitted=0;" 2>/dev/null
```
