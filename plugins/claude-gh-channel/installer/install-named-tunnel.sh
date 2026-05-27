#!/usr/bin/env bash
#
# install-named-tunnel.sh — install a LaunchAgent that keeps a pre-created
# NAMED cloudflared tunnel running across reboots.
#
# Prereqs (do these first, one-time):
#   cloudflared tunnel login
#   cloudflared tunnel create <name>
#   cloudflared tunnel route dns <name> <hostname>
#   # + ~/.cloudflared/config.yml with the ingress rule, OR the tunnel's
#   #   credentials JSON in place.
# And config.json should have:
#   {"tunnel": {"mode": "named", "name": "<name>", "hostname": "<hostname>"}}
#
# This script reads the tunnel name from config.json, renders the plist,
# and bootstraps it. Idempotent.
set -euo pipefail

CONFIG_DIR="${GH_CHANNEL_CONFIG_DIR:-$HOME/.config/claude-gh-channel}"
LOG_DIR="${GH_CHANNEL_LOG_DIR:-$HOME/.local/share/claude-gh-channel}"
CONFIG_JSON="$CONFIG_DIR/config.json"
LABEL="com.marklubin.claude-gh-channel.named-tunnel"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/launchd.named-tunnel.plist.template"

log() { echo "[install-named-tunnel] $*" >&2; }

command -v cloudflared >/dev/null 2>&1 || { log "FATAL: cloudflared not installed"; exit 1; }
[ -f "$CONFIG_JSON" ] || { log "FATAL: $CONFIG_JSON not found — run /gh-channel-setup first"; exit 1; }
[ -f "$TEMPLATE" ] || { log "FATAL: template missing at $TEMPLATE"; exit 1; }

NAME=$(jq -r '.tunnel.name // empty' "$CONFIG_JSON")
HOSTNAME=$(jq -r '.tunnel.hostname // empty' "$CONFIG_JSON")
MODE=$(jq -r '.tunnel.mode // empty' "$CONFIG_JSON")
if [ "$MODE" != "named" ] || [ -z "$NAME" ] || [ -z "$HOSTNAME" ]; then
  log "FATAL: config.json must have tunnel.mode=named + tunnel.name + tunnel.hostname"
  exit 1
fi

# Verify the tunnel can run locally. `cloudflared tunnel run` needs either a
# config.yml (with tunnel: + credentials-file:) or a credentials JSON whose
# TunnelName matches — NOT necessarily a cert.pem (that's only for the
# account-level `tunnel info`/`create`/`route` API lookups). When the tunnel
# was provisioned via the Cloudflare API (no `tunnel login`), there's no
# cert.pem, so we check for the run-time files instead.
CF_DIR="$HOME/.cloudflared"
have_creds=false
if [ -f "$CF_DIR/config.yml" ] && grep -q "credentials-file:" "$CF_DIR/config.yml" 2>/dev/null; then
  have_creds=true
fi
# Or a credentials JSON naming this tunnel
if ls "$CF_DIR"/*.json >/dev/null 2>&1; then
  if grep -lq "\"TunnelName\": *\"$NAME\"" "$CF_DIR"/*.json 2>/dev/null; then
    have_creds=true
  fi
fi
if [ "$have_creds" != true ]; then
  log "FATAL: no runnable tunnel config for '$NAME'."
  log "  Expected $CF_DIR/config.yml (with credentials-file:) or a *.json naming the tunnel."
  log "  Provision with: cloudflared tunnel create $NAME  (or the API flow in docs/walkthrough.md)"
  exit 1
fi

CLOUDFLARED_BIN="$(command -v cloudflared)"
mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"

sed \
  -e "s|__CLOUDFLARED_BIN__|$CLOUDFLARED_BIN|g" \
  -e "s|__TUNNEL_NAME__|$NAME|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  -e "s|__CONFIG_DIR__|$CONFIG_DIR|g" \
  "$TEMPLATE" > "$PLIST"
chmod 644 "$PLIST"
log "wrote $PLIST (tunnel=$NAME → $HOSTNAME)"

# Reload: bootout any prior, then bootstrap + kickstart
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
log "LaunchAgent $LABEL bootstrapped + started"

# Confirm it routes
URL="https://$HOSTNAME"
for _ in $(seq 1 15); do
  code=$(curl -s -o /dev/null -m 6 -w "%{http_code}" "$URL/health" 2>/dev/null || echo "000")
  { [ "$code" != "000" ] && [ "$code" != "530" ]; } && break
  sleep 2
done
if [ "$code" = "000" ] || [ "$code" = "530" ]; then
  log "WARN: tunnel installed but not routing yet (HTTP $code). Check logs at $LOG_DIR/cloudflared.log"
  exit 1
fi
log "named tunnel live: $URL (HTTP $code). Survives reboot."
