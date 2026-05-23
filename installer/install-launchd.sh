#!/usr/bin/env bash
# install-launchd.sh — install and start the cloudflared LaunchAgent for claude-gh-channel.
#
# Manages the cloudflared quick-tunnel process only. The Claude watcher session
# is started interactively by the user (cmux pane + `claude --channels ...`).
#
# Idempotent: re-running will tear down any prior agent and reinstall.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/launchd.plist.template"

LABEL="com.marklubin.claude-gh-channel.tunnel"
CONFIG_DIR="${HOME}/.config/claude-gh-channel"
LOG_DIR="${HOME}/.local/share/claude-gh-channel"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
TUNNEL_LOG="${LOG_DIR}/cloudflared.log"
TUNNEL_ERR="${LOG_DIR}/cloudflared.err"

err() { printf 'error: %s\n' "$*" >&2; }
info() { printf '%s\n' "$*"; }

# --- Preconditions -----------------------------------------------------------

if [[ "$(uname -s)" != "Darwin" ]]; then
    err "install-launchd.sh is macOS-only (uname=$(uname -s)). Use systemd on linux (M5+)."
    exit 1
fi

if [[ ! -f "${TEMPLATE}" ]]; then
    err "plist template not found at: ${TEMPLATE}"
    exit 1
fi

CLOUDFLARED_BIN="$(command -v cloudflared || true)"
if [[ -z "${CLOUDFLARED_BIN}" ]]; then
    err "cloudflared not found on PATH. Install with: brew install cloudflared"
    exit 1
fi

if [[ ! -d "${CONFIG_DIR}" ]]; then
    err "config dir does not exist: ${CONFIG_DIR}"
    err "run /gh-channel-setup first to bootstrap the plugin."
    exit 1
fi

mkdir -p "${LOG_DIR}"
mkdir -p "${PLIST_DIR}"

# --- Render plist ------------------------------------------------------------

# Use a temp file then move into place atomically so a partial write can't
# leave a malformed plist that launchctl chokes on.
TMP_PLIST="$(mktemp -t claude-gh-channel-launchd.XXXXXX)"
trap 'rm -f "${TMP_PLIST}"' EXIT

# sed delimiter is `|` to avoid escaping paths.
sed \
    -e "s|__CLOUDFLARED_BIN__|${CLOUDFLARED_BIN}|g" \
    -e "s|__LOG_DIR__|${LOG_DIR}|g" \
    -e "s|__CONFIG_DIR__|${CONFIG_DIR}|g" \
    "${TEMPLATE}" > "${TMP_PLIST}"

if command -v plutil >/dev/null 2>&1; then
    if ! plutil -lint "${TMP_PLIST}" >/dev/null; then
        err "rendered plist failed plutil -lint:"
        plutil -lint "${TMP_PLIST}" >&2 || true
        exit 1
    fi
fi

mv "${TMP_PLIST}" "${PLIST_PATH}"
trap - EXIT
chmod 644 "${PLIST_PATH}"

info "installed plist: ${PLIST_PATH}"

# --- Load via launchctl ------------------------------------------------------

UID_NUM="$(id -u)"
DOMAIN_TARGET="user/${UID_NUM}"
SERVICE_TARGET="${DOMAIN_TARGET}/${LABEL}"

# Truncate prior log so we can scan cleanly for the tunnel URL.
: > "${TUNNEL_LOG}"
: > "${TUNNEL_ERR}"

# Idempotent unload: bootout returns non-zero if the service isn't loaded.
launchctl bootout "${SERVICE_TARGET}" 2>/dev/null || true

if ! launchctl bootstrap "${DOMAIN_TARGET}" "${PLIST_PATH}"; then
    err "launchctl bootstrap failed for ${SERVICE_TARGET}"
    err "check plist syntax and try: launchctl bootstrap ${DOMAIN_TARGET} ${PLIST_PATH}"
    exit 1
fi

if ! launchctl kickstart "${SERVICE_TARGET}" >/dev/null 2>&1; then
    err "launchctl kickstart failed for ${SERVICE_TARGET}"
    err "agent loaded but did not start; inspect: launchctl print ${SERVICE_TARGET}"
    exit 1
fi

info "launchd agent loaded and kickstarted: ${LABEL}"

# --- Wait for tunnel URL -----------------------------------------------------

URL=""
for _ in $(seq 1 15); do
    if [[ -s "${TUNNEL_LOG}" ]]; then
        URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "${TUNNEL_LOG}" | head -1 || true)"
        [[ -n "${URL}" ]] && break
    fi
    if [[ -s "${TUNNEL_ERR}" ]]; then
        URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "${TUNNEL_ERR}" | head -1 || true)"
        [[ -n "${URL}" ]] && break
    fi
    sleep 1
done

if [[ -z "${URL}" ]]; then
    err "cloudflared did not emit a trycloudflare.com URL within 15s"
    err "tail of ${TUNNEL_LOG}:"
    tail -n 40 "${TUNNEL_LOG}" >&2 || true
    err "tail of ${TUNNEL_ERR}:"
    tail -n 40 "${TUNNEL_ERR}" >&2 || true
    exit 1
fi

printf '%s\n' "${URL}" > "${CONFIG_DIR}/tunnel-url"
info "captured tunnel URL: ${URL}"
info "wrote: ${CONFIG_DIR}/tunnel-url"

# --- Done --------------------------------------------------------------------

cat <<EOF

launchd auto-start installed.

  label:      ${LABEL}
  plist:      ${PLIST_PATH}
  stdout log: ${TUNNEL_LOG}
  stderr log: ${TUNNEL_ERR}
  tunnel URL: ${URL}

Note: quick-tunnel URLs rotate every time cloudflared restarts (including on
reboot). After a reboot you must re-run /gh-channel-setup to update the
GitHub webhook with the new URL, OR migrate to a named tunnel (M4.1) for a
stable URL.

To stop and remove: bash ${SCRIPT_DIR}/uninstall-launchd.sh
EOF
