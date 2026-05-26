---
description: Ensure a live cloudflared tunnel pointing at the channel server, repointing the GitHub webhook if the tunnel rotated. Runs scripts/ensure-tunnel.sh — idempotent, non-interactive. Use when events stopped arriving (likely a dead/rotated tunnel) or before attaching a watcher.
---

# /gh-channel-tunnel

Guarantee a working tunnel. Self-healing: checks the current tunnel, and if it's dead or missing, provisions a fresh cloudflared quick tunnel and repoints the GitHub webhook to the new URL automatically.

## What it does

Runs the bundled script:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/ensure-tunnel.sh
```

The script:
1. Reads the current tunnel URL from `~/.config/claude-gh-channel/tunnel-url`.
2. Health-checks it. A real HTTP response (including 502 "server down") means the tunnel edge is alive — no action. Only a dead edge (connection refused / timeout / no URL) triggers a refresh.
3. On refresh: kills the stale cloudflared, starts a fresh quick tunnel, captures the new `*.trycloudflare.com` URL, writes it to `tunnel-url`, and PATCHes the repo webhook's `config.url` to match.

It's safe to run any time — if the tunnel is fine, it's a no-op.

## When to run

- **Events stopped arriving.** Most common cause is a rotated/dead quick tunnel. Run this first.
- **After a reboot.** cloudflared quick tunnels don't survive restart and get a new URL.
- **Before attaching a watcher** if you're unsure of tunnel state. (The `ghwatch` alias already chains this — see README.)

## Output

Report to the user:
- Whether the tunnel was already healthy (no-op) or got refreshed.
- The current tunnel URL.
- Whether the webhook was repointed (and to what).

If the script exits non-zero, surface the tail of `~/.config/claude-gh-channel/cloudflared.log` — the usual cause is the trycloudflare service being slow to assign/propagate a hostname, in which case waiting 30-60s and re-running usually works.

## Known limitation

Cloudflare **quick** tunnels have no uptime guarantee and their DNS can take time to propagate (sometimes minutes, occasionally failing under service load). The script provisions correctly, but a freshly-created hostname may `NXDOMAIN` for a bit before becoming reachable. The durable fix is a **named tunnel** with a DNS record you control — on the roadmap, not in v1. If a fresh tunnel won't resolve after a couple minutes, that's a Cloudflare-side issue, not a config problem.

## Verify after running

```bash
curl -s "$(cat ~/.config/claude-gh-channel/tunnel-url)/health"
```

A 200 with the health JSON means the tunnel routes to the server (watcher attached). A 502 means tunnel-up-but-no-watcher — attach one. `Could not resolve host` means the hostname hasn't propagated yet — wait and retry.
