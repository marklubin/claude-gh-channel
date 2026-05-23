---
description: Re-emit a specific event from the claude-gh-channel queue by delivery_id. Requires an attached Claude session on localhost:8788. Idempotent — replaying an already-emitted event is fine.
---

# /gh-channel-replay

Manually re-trigger an event that's already in the SQLite queue. Use this when:
- The event was received while no watcher was attached and you want to handle it now.
- You're debugging a routing/skill rule and want to fire the same payload repeatedly.
- An attached session crashed mid-handle and you want to retry.

## Step 1 — Parse argument

Single positional arg: the delivery id (full UUID or 8-char prefix as shown by `/gh-channel-queue`).

```bash
DID="${ARGUMENTS%% *}"
test -n "$DID" || { echo "Usage: /gh-channel-replay <delivery_id>"; exit 1; }
```

If the user pasted multiple ids, only the first is replayed. If they want all, they re-run.

## Step 2 — Resolve the id from the queue

```bash
DB=~/.local/share/claude-gh-channel/events.db
test -f "$DB" || { echo "No queue DB at $DB — nothing to replay"; exit 1; }

# Match full id or prefix
MATCHES=$(sqlite3 -separator '|' "$DB" \
  "SELECT delivery_id, event_type, action, repo, sender, received_at, emitted
   FROM events
   WHERE delivery_id = '$DID' OR delivery_id LIKE '$DID%'
   LIMIT 5;")

COUNT=$(echo "$MATCHES" | grep -c . || true)
```

Handle the three cases:

- `COUNT = 0` → "No event matches `$DID`. Run `/gh-channel-queue` to see available delivery ids." Exit.
- `COUNT = 1` → continue to Step 3.
- `COUNT > 1` → print all matches in a small table and ask the user to disambiguate by providing more of the id. Exit without replaying.

Capture the resolved full id:
```bash
FULL_ID=$(echo "$MATCHES" | head -1 | cut -d'|' -f1)
```

Print the event metadata so the user sees exactly what's about to fire (event_type, action, repo, sender, received_at, emitted status).

## Step 3 — Verify a watcher is attached

The replay endpoint lives on the per-session server. If no session is attached, there's nowhere to deliver:

```bash
if ! curl -fsS --max-time 2 "http://localhost:8788/health" >/dev/null 2>&1; then
  cat <<MSG
No attached Claude session detected on localhost:8788.

The replay endpoint runs inside the channel server, which is spawned by:
  claude --channels plugin:claude-gh-channel:gh-channel

Open a fresh pane, run that command, then re-run /gh-channel-replay $DID.
MSG
  exit 1
fi
```

Do NOT try to spawn a server yourself — that would create a server with no consuming Claude session, and the event would be re-queued. The attach has to come from a user-initiated Claude process.

## Step 4 — POST to /replay

```bash
curl -fsS -X POST "http://localhost:8788/replay" \
  -H 'content-type: application/json' \
  -d "{\"delivery_id\": \"$FULL_ID\"}" \
  --max-time 10
```

Expected response shape (per design doc M3):
```json
{"replayed": true, "delivery_id": "...", "emitted_at": "..."}
```

If the server returns non-2xx:
- `404` on `/replay` → server is an older v1 build without replay support; tell the user to `/gh-channel-reload` after pulling latest.
- `409 already_in_flight` → another replay of the same id is currently delivering; safe to ignore, do not retry.
- `5xx` → surface the body; suggest `/gh-channel-status` to see if the server is wedged.

## Step 5 — Report

One short paragraph:
- Resolved delivery id (full UUID).
- Event summary (type/action/repo).
- Whether the replay succeeded.
- If the row had `emitted=0` previously, note that the queue now marks it `emitted=1` — subsequent natural drains won't re-fire it.
- If you want it fired again, just re-run `/gh-channel-replay <id>` — the endpoint is explicitly idempotent-friendly (re-emit is the whole point).

Do not modify the SQLite row directly. The server owns writes to `events.db`; clobbering `emitted` from outside risks a torn write against the WAL.
