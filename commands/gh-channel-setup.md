---
description: Interactive bootstrap for the claude-gh-channel plugin — generate webhook secret, start cloudflared tunnel, register GH webhook on a chosen repo, write config files. Idempotent. Does NOT auto-start a persistent background session — that's a separate step.
---

# /gh-channel-setup

You're configuring the `claude-gh-channel` plugin. Drive this step-by-step, confirming with the user at each major choice. Do not skip the confirmation prompts — this command writes secrets to disk and registers a webhook with real network effect.

## Preconditions to verify before doing anything

Run these in parallel; if any fail, stop and report what's missing.

- `cloudflared --version` — needed for the tunnel. If missing, instruct: `brew install cloudflared`.
- `gh auth status` — needed to register the webhook. If not logged in, instruct: `gh auth login --scopes repo`.
- `bun --version` — needed by the server. If missing, instruct: `brew install bun` or `curl -fsSL https://bun.sh/install | bash`.

If `~/.config/claude-gh-channel/secret` already exists and `~/.config/claude-gh-channel/config.json` already exists, this is a re-run. Ask the user whether to:
1. Reuse the existing secret + config (just refresh the tunnel + verify webhook still wired)
2. Wipe and start over (delete existing webhook on the repo first if you can find it)

## Step 1 — Choose target repo

Ask the user (use AskUserQuestion):
- Which GitHub repo should this watch? Default to `${user.github_username}/<repo>` — they'll usually want a personal repo for v1.
- Confirm they own it or have webhook-creation permission (`gh api repos/<owner>/<repo>` should return without 404; check `permissions.admin`).

Save the chosen repo as `repo` in the config.

## Step 2 — Generate or reuse webhook secret

```bash
mkdir -p ~/.config/claude-gh-channel
if [ ! -f ~/.config/claude-gh-channel/secret ]; then
  openssl rand -hex 32 > ~/.config/claude-gh-channel/secret
  chmod 600 ~/.config/claude-gh-channel/secret
fi
```

Never print the secret value back to the user verbatim. Confirm with `wc -c < ~/.config/claude-gh-channel/secret` (should be 65, including trailing newline).

## Step 3 — Start cloudflared quick tunnel

For v1, use a quick tunnel (no Cloudflare account needed). Spawn it as a background process and capture the public URL from stdout. The URL pattern is `https://<random>.trycloudflare.com`.

```bash
nohup cloudflared tunnel --url http://localhost:8788 --no-autoupdate \
  > ~/.config/claude-gh-channel/cloudflared.log 2>&1 &
echo $! > ~/.config/claude-gh-channel/cloudflared.pid
```

Then poll the log file for up to 15 seconds:
```bash
for i in $(seq 1 15); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' ~/.config/claude-gh-channel/cloudflared.log | head -1)
  [ -n "$URL" ] && break
  sleep 1
done
echo "$URL" > ~/.config/claude-gh-channel/tunnel-url
```

If no URL appears in 15s, abort and surface the log contents — cloudflared likely failed.

**Caveat to mention to the user**: quick-tunnel URLs rotate every time cloudflared restarts. For a persistent URL you'd use a named tunnel (`cloudflared tunnel create …`) — out of scope for v1.

## Step 4 — Register the webhook on the repo

Use `gh api` with a JSON input file (avoids zsh bracket expansion on `config[url]`):

```bash
SECRET=$(cat ~/.config/claude-gh-channel/secret)
TUNNEL=$(cat ~/.config/claude-gh-channel/tunnel-url)

cat > /tmp/gh-channel-hook.json <<EOF
{
  "name": "web",
  "active": true,
  "events": ["pull_request","issue_comment","pull_request_review","pull_request_review_comment"],
  "config": {
    "url": "$TUNNEL/webhook",
    "content_type": "json",
    "secret": "$SECRET",
    "insecure_ssl": "0"
  }
}
EOF

gh api -X POST repos/<owner>/<repo>/hooks --input /tmp/gh-channel-hook.json --jq '{id, url: .config.url, events, active}'
rm /tmp/gh-channel-hook.json
```

Capture the returned webhook `id` and store it in the config file. The user needs this to delete or modify the hook later. **Before creating, check whether a hook already exists** with `config.url` containing `trycloudflare.com` or pointing at this tunnel — if so, prompt the user to delete or update rather than creating a duplicate.

## Step 5 — Write config file

```bash
cat > ~/.config/claude-gh-channel/config.json <<EOF
{
  "version": 1,
  "repo": "<owner>/<repo>",
  "tunnel_url": "<URL>",
  "webhook_id": <id>,
  "events": ["pull_request","issue_comment","pull_request_review","pull_request_review_comment"],
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
chmod 600 ~/.config/claude-gh-channel/config.json
```

## Step 6 — Verify the wire-up

GitHub sends a `ping` event automatically when a webhook is created. Confirm receipt:

1. Boot the server briefly in test mode:
   ```bash
   GH_WEBHOOK_SECRET=$(cat ~/.config/claude-gh-channel/secret) \
     bun ${CLAUDE_PLUGIN_ROOT}/server/index.ts > /tmp/gh-channel-verify.log 2>&1 &
   ```
   Wait 3s, then:
   ```bash
   curl -s localhost:8788/health
   ```
   You should see `{"received": >=1, "rejected": 0}` if the ping landed.

2. Trigger a no-op event by re-pinging:
   ```bash
   gh api -X POST repos/<owner>/<repo>/hooks/<webhook_id>/pings
   ```
   Wait a few seconds, re-check `/health`. `received` should increment.

3. Kill the verify server: `kill $(cat /tmp/gh-channel-verify.pid)` or `pkill -f "bun.*server/index.ts"`.

## Step 7 — Report back

Tell the user, in one paragraph:
- Where config lives (`~/.config/claude-gh-channel/`)
- The webhook ID (so they can manage it via gh api)
- That the tunnel URL is in `~/.config/claude-gh-channel/tunnel-url` and will rotate if cloudflared restarts
- How to attach a watching session: open a new terminal/cmux pane, run `claude --channels plugin:claude-gh-channel:gh-channel` from anywhere — the plugin's `.mcp.json` will spawn the server, which reads the secret from `~/.config/claude-gh-channel/secret`
- That events will be silently dropped if no Claude session is attached when GH delivers (M3 will fix this with a SQLite queue; not in v1)
- Cleanup: to tear everything down, run `gh api -X DELETE repos/<owner>/<repo>/hooks/<webhook_id>` and `kill $(cat ~/.config/claude-gh-channel/cloudflared.pid)`

## What this command does NOT do (v1 boundaries)

- Does not install a launchd plist or auto-start the tunnel on login.
- Does not start a persistent Claude watcher session — user attaches one manually.
- Does not configure routing hints, CEL filters, or per-event skill mappings — only the default subscription (all 4 PR events) is wired up.
- Does not handle multiple repos. To watch a second repo, re-run this command and accept that you'll get a second webhook + the same tunnel URL.

Those belong to milestones M2/M3/M4 in the design doc.
