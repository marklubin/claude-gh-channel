#!/usr/bin/env bash
# uninstall-launchd.sh — tear down the cloudflared LaunchAgent for claude-gh-channel.
#
# Idempotent: succeeds even if nothing is installed.

set -euo pipefail

LABEL="com.marklubin.claude-gh-channel.tunnel"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"

err() { printf 'error: %s\n' "$*" >&2; }
info() { printf '%s\n' "$*"; }

if [[ "$(uname -s)" != "Darwin" ]]; then
    err "uninstall-launchd.sh is macOS-only (uname=$(uname -s))."
    exit 1
fi

UID_NUM="$(id -u)"
SERVICE_TARGET="user/${UID_NUM}/${LABEL}"

# bootout returns non-zero if the service isn't loaded; that's fine.
if launchctl bootout "${SERVICE_TARGET}" 2>/dev/null; then
    info "unloaded launchd agent: ${LABEL}"
else
    info "launchd agent was not loaded (nothing to unload): ${LABEL}"
fi

if [[ -f "${PLIST_PATH}" ]]; then
    rm -f "${PLIST_PATH}"
    info "removed plist: ${PLIST_PATH}"
else
    info "plist already absent: ${PLIST_PATH}"
fi

info "uninstall complete."
info "note: config (~/.config/claude-gh-channel) and logs (~/.local/share/claude-gh-channel) were left in place."
