---
description: Validate config.yaml against schema, then restart the channel server so changes take effect. User must re-attach a Claude session afterward. Idempotent.
---

# /gh-channel-reload

Use after editing `~/.config/claude-gh-channel/config.yaml` or `config.json` by hand, or when you suspect the running server has drifted from disk state. This kills the per-session server bound to localhost:8788; the user re-attaches in a fresh pane.

## Step 1 — Locate and lint config

Prefer `config.yaml` if present (richer schema, M3+), fall back to `config.json` (v1 minimal):

```bash
CFG_YAML=~/.config/claude-gh-channel/config.yaml
CFG_JSON=~/.config/claude-gh-channel/config.json
SCHEMA=${CLAUDE_PLUGIN_ROOT}/server/schema.json

if [ -f "$CFG_YAML" ]; then
  CFG="$CFG_YAML"
elif [ -f "$CFG_JSON" ]; then
  CFG="$CFG_JSON"
else
  echo "No config found — run /gh-channel-setup first"; exit 1
fi
```

Parse-check first (this catches the most common breakage: a stray tab or trailing comma):
```bash
case "$CFG" in
  *.yaml) bun -e "import {parse} from 'yaml'; parse(require('fs').readFileSync('$CFG','utf8'))" ;;
  *.json) jq empty "$CFG" ;;
esac
```

If parse fails, print the error and stop. **Do not** restart the server with a broken config — that would leave the user with no listener AND no clear recovery.

If `$SCHEMA` exists, schema-validate (best-effort — the schema file is M3 territory and may be absent in v1):
```bash
if [ -f "$SCHEMA" ]; then
  bun -e "
    import Ajv from 'ajv';
    import {parse} from 'yaml';
    import fs from 'fs';
    const schema = JSON.parse(fs.readFileSync('$SCHEMA','utf8'));
    const data = '$CFG'.endsWith('.yaml')
      ? parse(fs.readFileSync('$CFG','utf8'))
      : JSON.parse(fs.readFileSync('$CFG','utf8'));
    const ajv = new Ajv({allErrors: true});
    const ok = ajv.validate(schema, data);
    if (!ok) { console.error(JSON.stringify(ajv.errors, null, 2)); process.exit(1); }
    console.log('schema ok');
  " || { echo "Schema validation failed — fix config before reloading"; exit 1; }
fi
```

## Step 2 — Identify the running server

```bash
SERVER_PIDS=$(pgrep -f "bun.*${CLAUDE_PLUGIN_ROOT}/server/index.ts" || true)
PORT_PID=$(lsof -nP -iTCP:8788 -sTCP:LISTEN -t 2>/dev/null || true)
```

If both are empty, no server is attached — just tell the user "config is valid; nothing to restart; attach a fresh session." Skip to Step 4.

If `SERVER_PIDS` and `PORT_PID` disagree, prefer `PORT_PID` (whatever owns 8788 is the active server) but mention it in the report — it may indicate a stale `bun` process worth cleaning up.

## Step 3 — Try /reload first, then fall back to SIGTERM

Many runtime changes (pause/quiet/disabled_repos) don't actually need a full restart. Give the server a chance to hot-reload:

```bash
if curl -fsS -X POST --max-time 2 "http://localhost:8788/reload" >/dev/null 2>&1; then
  echo "Hot-reload succeeded — no restart needed"
  exit 0
fi
```

If the server doesn't expose `/reload` or returns non-2xx, do a clean kill:
```bash
for pid in $PORT_PID $SERVER_PIDS; do
  [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null
done
# Give it 3s to flush WAL and close cleanly
for i in 1 2 3; do
  lsof -nP -iTCP:8788 -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 1
done
# Hard kill if still alive
lsof -nP -iTCP:8788 -sTCP:LISTEN -t 2>/dev/null | xargs -r kill -KILL
```

The SQLite WAL means in-flight events are safe across a restart — they'll redeliver when the new server starts.

## Step 4 — Tell the user how to re-attach

Crucial: the plugin's channel server is launched **by the Claude session** that subscribes to the channel. Killing the server effectively detaches that session's channel. To get back to a watching state, the user opens a fresh pane and runs:

```
claude --channels plugin:claude-gh-channel:gh-channel
```

…from any directory. The plugin's `.mcp.json` re-spawns `bun ${CLAUDE_PLUGIN_ROOT}/server/index.ts`, which reads the just-validated config and binds 8788.

## Step 5 — Report

One paragraph: which config file was loaded, schema status (validated / no schema / skipped), whether hot-reload succeeded OR the server was restarted (with old pid), current queue depth pulled from sqlite, and the exact re-attach command above. If anything in Step 1 failed, the report is just the lint error — nothing was restarted, the old server is still serving the old config.
