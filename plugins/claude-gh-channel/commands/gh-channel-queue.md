---
description: List recent and pending events in the claude-gh-channel SQLite queue. Supports --pending (unemitted only) and --repo <owner/name> filters. Read-only.
---

# /gh-channel-queue

Inspect what GitHub has delivered and what's still waiting to emit. The queue lives in `~/.local/share/claude-gh-channel/events.db` (bun:sqlite, WAL mode). Reading it directly via `sqlite3` is safe even while the server has it open.

## Step 1 — Parse arguments

Support these flags in `$ARGUMENTS`:

| Flag                       | Effect                                                       |
| -------------------------- | ------------------------------------------------------------ |
| `--pending`                | Only rows where `emitted = 0`                                |
| `--repo <owner/name>`      | Filter to one repo (matches the `repo` column exactly)       |
| `--limit <N>` (default 20) | Cap row count                                                |
| `--since <duration>`       | e.g. `1h`, `24h`, `7d` — only rows received in that window   |

If `--pending` and no `--limit`, default to 50 (queue depth is the more interesting question than recent activity).

## Step 2 — Prefer the running server's /queue endpoint

If a watcher is attached, hit `/queue` so we get the server's view (includes in-memory state like "currently delivering"):

```bash
if curl -fsS --max-time 2 "http://localhost:8788/queue?limit=${LIMIT:-20}${PENDING:+&pending=1}${REPO:+&repo=$REPO}${SINCE:+&since=$SINCE}" 2>/dev/null; then
  exit 0
fi
```

The endpoint returns JSON; pretty-print with `jq`. If it 404s or the watcher isn't up, fall through to direct sqlite.

## Step 3 — Direct sqlite read (fallback)

```bash
DB=~/.local/share/claude-gh-channel/events.db
test -f "$DB" || { echo "No queue DB yet — no events have been received"; exit 0; }
```

Build a WHERE clause from flags. Use parameterized queries via heredoc to avoid quoting hell:

```bash
WHERE="1=1"
[ -n "$PENDING" ] && WHERE="$WHERE AND emitted = 0"
[ -n "$REPO" ]    && WHERE="$WHERE AND repo = '$REPO'"
[ -n "$SINCE" ]   && WHERE="$WHERE AND received_at >= datetime('now','-${SINCE}')"

sqlite3 -header -column "$DB" <<SQL
SELECT
  substr(delivery_id, 1, 8)        AS id,
  event_type                        AS event,
  COALESCE(action, '-')             AS action,
  repo,
  sender,
  datetime(received_at, 'localtime') AS received,
  CASE emitted WHEN 1 THEN 'yes' ELSE 'no' END AS emitted
FROM events
WHERE $WHERE
ORDER BY received_at DESC
LIMIT ${LIMIT:-20};
SQL
```

Notes on the columns:
- `id` is truncated to first 8 chars of the GitHub delivery UUID. `/gh-channel-replay <id>` accepts either the prefix (if unambiguous) or the full id.
- `emitted=no` means the row is queued but no attached Claude session has consumed it yet. That's normal if the watcher isn't running.
- `action` is null for events like `ping`; we coerce to `-` for table alignment.

## Step 4 — Summary footer

After the table, print a one-line summary:
```bash
sqlite3 "$DB" <<SQL
SELECT printf(
  'total=%d pending=%d oldest_pending=%s newest=%s',
  COUNT(*),
  SUM(CASE WHEN emitted=0 THEN 1 ELSE 0 END),
  COALESCE(MIN(CASE WHEN emitted=0 THEN received_at END), '-'),
  COALESCE(MAX(received_at), '-')
) FROM events;
SQL
```

## Step 5 — Suggested next steps

Based on what you see, add at most one actionable line:
- Pending > 0 AND no watcher attached → "Attach a session with `claude --channels plugin:claude-gh-channel:gh-channel` to drain."
- Pending > 100 → "Queue is large — consider `/gh-channel-pause resume` if you intended to be receiving, or `/gh-channel-disable` if you didn't."
- Specific row of interest → "Replay with `/gh-channel-replay <delivery_id>`."

Otherwise, no editorializing. This command is a `cat`, not a `fix`.
