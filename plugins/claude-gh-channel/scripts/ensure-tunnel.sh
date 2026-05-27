#!/usr/bin/env bash
#
# ensure-tunnel.sh — idempotent: guarantees a live cloudflared quick tunnel
# pointing at the channel server's port, with the GitHub webhook repointed
# to match. Safe to run before every watcher launch.
#
# Behavior:
#   - tunnel reachable (any HTTP response, even 502 "server down")  → no-op
#   - tunnel dead (connection refused / timeout / no URL on file)   → provision
#     a fresh tunnel, capture its URL, and PATCH the repo webhook to it
#
# A 502 means the cloudflared edge is alive but localhost:PORT isn't bound
# yet (the server only binds while a watcher is attached) — that's fine, we
# don't refresh on it. Only a dead edge (000 / timeout) triggers a refresh.
#
# Non-interactive. Requires: cloudflared, gh (authed), jq, curl, openssl.
set -euo pipefail

CONFIG_DIR="${GH_CHANNEL_CONFIG_DIR:-$HOME/.config/claude-gh-channel}"
PORT="${GH_CHANNEL_HTTP_PORT:-8788}"
SECRET_FILE="$CONFIG_DIR/secret"
URL_FILE="$CONFIG_DIR/tunnel-url"
LOG="$CONFIG_DIR/cloudflared.log"
PIDFILE="$CONFIG_DIR/cloudflared.pid"

log() { echo "[ensure-tunnel] $*" >&2; }

CONFIG_JSON="$CONFIG_DIR/config.json"

# ── Tunnel mode (named | quick). Default quick for back-compat. ─────────────
tunnel_get() {  # $1 = jq path under .tunnel
  [ -f "$CONFIG_JSON" ] || { echo ""; return; }
  jq -r ".tunnel.$1 // empty" "$CONFIG_JSON" 2>/dev/null || echo ""
}
TUNNEL_MODE="$(tunnel_get mode)"
TUNNEL_MODE="${TUNNEL_MODE:-quick}"

# ── Named-tunnel path ───────────────────────────────────────────────────────
# A named cloudflared tunnel has a permanent hostname + DNS record. We never
# provision a new one or repoint the webhook — we just make sure the tunnel
# process is running and the hostname routes.
if [ "$TUNNEL_MODE" = "named" ]; then
  NAME="$(tunnel_get name)"
  HOSTNAME="$(tunnel_get hostname)"
  if [ -z "$NAME" ] || [ -z "$HOSTNAME" ]; then
    log "FATAL: tunnel.mode=named but tunnel.name/hostname missing in $CONFIG_JSON"
    exit 1
  fi
  URL="https://$HOSTNAME"

  # Health semantics for a Cloudflare-proxied named tunnel:
  #   200/404/etc → connector up + server reachable (healthy)
  #   502/504     → connector up, but localhost server not bound (FINE — the
  #                 server attaches with the watcher; don't restart the tunnel)
  #   530         → Cloudflare error 1033: no connector registered → tunnel
  #                 process is DOWN → restart
  #   000         → DNS not resolving (shouldn't happen for a named tunnel)
  named_tunnel_down() {  # true (0) if the connector is down
    local c="$1"
    [ "$c" = "000" ] || [ "$c" = "530" ]
  }

  code=$(curl -s -o /dev/null -m 8 -w "%{http_code}" "$URL/health" 2>/dev/null || echo "000")
  if ! named_tunnel_down "$code"; then
    log "named tunnel healthy: $URL (HTTP $code)"
    echo "$URL" > "$URL_FILE"
    exit 0
  fi

  log "named tunnel '$NAME' connector down (HTTP $code) — starting it"
  # Prefer the launchd service if installed; else run in background.
  PLIST_LABEL="com.marklubin.claude-gh-channel.named-tunnel"
  if launchctl print "gui/$(id -u)/$PLIST_LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
    log "kickstarted launchd service $PLIST_LABEL"
  else
    if ! pgrep -f "cloudflared tunnel run $NAME" >/dev/null 2>&1; then
      nohup cloudflared tunnel run "$NAME" > "$LOG" 2>&1 &
      echo $! > "$PIDFILE"
      log "started cloudflared tunnel run $NAME (pid $(cat "$PIDFILE"))"
    fi
  fi

  # Wait for the connector to register + route
  for _ in $(seq 1 15); do
    code=$(curl -s -o /dev/null -m 6 -w "%{http_code}" "$URL/health" 2>/dev/null || echo "000")
    named_tunnel_down "$code" || break
    sleep 2
  done
  if named_tunnel_down "$code"; then
    log "WARN: named tunnel still down after start (HTTP $code). Check: cloudflared tunnel info $NAME"
    exit 1
  fi
  log "named tunnel up: $URL (HTTP $code)"
  echo "$URL" > "$URL_FILE"
  exit 0
fi

# ── Resolve the repo to repoint the webhook on ──────────────────────────────
resolve_repo() {
  if [ -f "$CONFIG_DIR/config.json" ]; then
    local r
    r=$(jq -r '.repo // empty' "$CONFIG_DIR/config.json" 2>/dev/null || true)
    [ -n "$r" ] && { echo "$r"; return 0; }
  fi
  # Fallback: first subscription repo in config.yaml
  if [ -f "$CONFIG_DIR/config.yaml" ]; then
    grep -E '^[[:space:]]*-[[:space:]]*repo:' "$CONFIG_DIR/config.yaml" \
      | head -1 \
      | sed -E 's/^[[:space:]]*-[[:space:]]*repo:[[:space:]]*//; s/["'"'"']//g; s/[[:space:]].*$//'
    return 0
  fi
  echo ""
}

# ── Health check: is the current tunnel edge alive? ─────────────────────────
tunnel_alive() {
  [ -f "$URL_FILE" ] || return 1
  local url
  url=$(cat "$URL_FILE" 2>/dev/null || true)
  [ -n "$url" ] || return 1
  local code
  code=$(curl -s -o /dev/null -m 6 -w "%{http_code}" "$url/health" 2>/dev/null || echo "000")
  # Any real HTTP status (200, 404, 502, ...) = edge alive. 000 = dead.
  [ "$code" != "000" ]
}

if tunnel_alive; then
  log "tunnel healthy: $(cat "$URL_FILE")"
  exit 0
fi

log "tunnel down or missing — provisioning a fresh one"

# Kill any stale cloudflared for this port
if [ -f "$PIDFILE" ]; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
fi
pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null || true
sleep 1

mkdir -p "$CONFIG_DIR"
nohup cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate > "$LOG" 2>&1 &
echo $! > "$PIDFILE"

# Wait for the URL to appear (cloudflared's edge handshake can take a few seconds)
URL=""
for _ in $(seq 1 25); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "$URL" ]; then
  log "FATAL: cloudflared produced no URL in 25s. Last log lines:"
  tail -8 "$LOG" >&2 || true
  exit 1
fi

echo "$URL" > "$URL_FILE"
log "fresh tunnel: $URL"

# ── Repoint the GitHub webhook ──────────────────────────────────────────────
REPO=$(resolve_repo)
if [ -z "$REPO" ]; then
  log "WARN: couldn't resolve repo from config; tunnel is up but webhook NOT repointed."
  log "      Run /gh-channel-setup to wire a webhook, or set repo in config.json."
  exit 0
fi

if [ ! -f "$SECRET_FILE" ]; then
  log "WARN: no secret at $SECRET_FILE; cannot repoint webhook. Run /gh-channel-setup."
  exit 0
fi
SECRET=$(cat "$SECRET_FILE")

# Find an existing webhook on the repo whose URL looks like ours
HOOK_ID=$(gh api "repos/$REPO/hooks" \
  --jq '.[] | select(.config.url | test("trycloudflare|/webhook$")) | .id' 2>/dev/null | head -1 || true)

if [ -z "$HOOK_ID" ]; then
  log "WARN: no matching webhook on $REPO. Tunnel up but nothing to repoint."
  log "      Run /gh-channel-setup to create the webhook."
  exit 0
fi

# PATCH via --input to avoid shell bracket-expansion on config[url]
PATCH_JSON=$(mktemp)
cat > "$PATCH_JSON" <<EOF
{"config": {"url": "$URL/webhook", "content_type": "json", "secret": "$SECRET", "insecure_ssl": "0"}, "active": true}
EOF
gh api -X PATCH "repos/$REPO/hooks/$HOOK_ID" --input "$PATCH_JSON" >/dev/null
rm -f "$PATCH_JSON"
log "repointed webhook $HOOK_ID on $REPO → $URL/webhook"

exit 0
