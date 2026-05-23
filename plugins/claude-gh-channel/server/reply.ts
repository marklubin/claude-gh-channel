/**
 * channel_reply MCP tool.
 *
 * Surface for Claude to write back to:
 *   - cmux sidebar (status + log + notify)
 *   - local scratch files (drafts/<repo>-<n>-<kind>.md)
 *   - audit trail (we record each call)
 *
 * action_type values (v1):
 *   triage          → drafts a triage summary; writes to drafts dir
 *   review_draft    → drafts review notes; writes to drafts dir
 *   comment_draft   → drafts a comment reply; writes to drafts dir
 *   flagged         → cmux set-status + log; no file written
 *   notify          → cmux notify (use sparingly for high-priority surfaces)
 *   status          → cmux set-status only (transient progress)
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

import type { Config } from "./config";

const log = (...args: unknown[]) => console.error("[gh-channel:reply]", ...args);

type Reply = {
  action_type: "triage" | "review_draft" | "comment_draft" | "flagged" | "notify" | "status";
  text: string;
  delivery_id?: string;
  repo?: string;
  number?: number;
  status_key?: string;
  status_icon?: string;
  status_color?: string;
  notify_title?: string;
};

export const REPLY_TOOL = {
  name: "channel_reply",
  description:
    "Write back from the watcher session: surface drafts, flag concerns, " +
    "or update the cmux sidebar. Use this instead of writing files yourself — " +
    "it handles paths, naming, and audit logging.",
  inputSchema: {
    type: "object",
    properties: {
      action_type: {
        type: "string",
        enum: ["triage", "review_draft", "comment_draft", "flagged", "notify", "status"],
        description: "What kind of reply this is.",
      },
      text: {
        type: "string",
        description:
          "The main payload. For *_draft actions: the markdown draft body. " +
          "For flagged: a short reason. For notify: the body. For status: the status text.",
      },
      delivery_id: {
        type: "string",
        description: "The event's delivery_id (from channel event meta). Strongly recommended for audit.",
      },
      repo: { type: "string", description: "owner/name — needed for *_draft actions." },
      number: { type: "number", description: "PR number — needed for *_draft actions." },
      status_key: {
        type: "string",
        description: "cmux status key (default: 'gh-channel'). Used for status/flagged/notify.",
      },
      status_icon: { type: "string", description: "SF Symbol name. Optional." },
      status_color: { type: "string", description: "Hex color like #22cc88. Optional." },
      notify_title: { type: "string", description: "For action_type=notify, the title (default: derived from repo/number)." },
    },
    required: ["action_type", "text"],
  },
} as const;

export function makeHandler(config: Config) {
  const draftsDir = (config.sidecar as any)?.drafts_dir
    ? String((config.sidecar as any).drafts_dir).replace(/^~/, homedir())
    : join(homedir(), ".config", "claude-gh-channel", "drafts");
  const statusTarget = (config.sidecar as any)?.cmux_status_target ?? "gh-channel";

  return async function handle(args: Reply): Promise<{ content: Array<{ type: string; text: string }> }> {
    const slug = (s: string) => s.replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase();

    if (args.action_type === "triage" || args.action_type === "review_draft" || args.action_type === "comment_draft") {
      if (!args.repo || !args.number) {
        return {
          content: [{ type: "text", text: `channel_reply: ${args.action_type} requires repo + number` }],
        };
      }
      mkdirSync(draftsDir, { recursive: true });
      const file = join(draftsDir, `${slug(args.repo)}-${args.number}-${args.action_type}.md`);
      const header = `<!-- delivery_id: ${args.delivery_id ?? "unknown"}, written: ${new Date().toISOString()} -->\n\n`;
      writeFileSync(file, header + args.text + "\n", "utf8");
      log(`wrote draft ${file}`);

      // Mirror to cmux sidebar as status
      cmux([
        "set-status",
        args.status_key ?? statusTarget,
        `draft ready: ${args.repo}#${args.number} (${args.action_type})`,
        ...(args.status_icon ? ["--icon", args.status_icon] : ["--icon", "doc.text"]),
        ...(args.status_color ? ["--color", args.status_color] : ["--color", "#22cc88"]),
      ]);
      return { content: [{ type: "text", text: `wrote draft to ${file}` }] };
    }

    if (args.action_type === "flagged") {
      cmux([
        "set-status",
        args.status_key ?? statusTarget,
        `flagged: ${args.text}`,
        ...(args.status_icon ? ["--icon", args.status_icon] : ["--icon", "exclamationmark.triangle.fill"]),
        ...(args.status_color ? ["--color", args.status_color] : ["--color", "#dc2626"]),
      ]);
      cmux(["log", "--level", "warn", "--source", "gh-channel", args.text]);
      return { content: [{ type: "text", text: "flagged" }] };
    }

    if (args.action_type === "notify") {
      const title =
        args.notify_title ??
        (args.repo && args.number ? `gh-channel: ${args.repo}#${args.number}` : "gh-channel");
      cmux(["notify", "--title", title, "--body", args.text]);
      return { content: [{ type: "text", text: "notified" }] };
    }

    if (args.action_type === "status") {
      cmux([
        "set-status",
        args.status_key ?? statusTarget,
        args.text,
        ...(args.status_icon ? ["--icon", args.status_icon] : []),
        ...(args.status_color ? ["--color", args.status_color] : []),
      ]);
      return { content: [{ type: "text", text: "status updated" }] };
    }

    return { content: [{ type: "text", text: `channel_reply: unknown action_type ${args.action_type}` }] };
  };
}

function cmux(args: string[]): void {
  const r = spawnSync("cmux", args, { stdio: ["ignore", "ignore", "pipe"] });
  if (r.status !== 0) {
    log(`cmux ${args.join(" ")} -> exit ${r.status}: ${r.stderr?.toString().trim().slice(0, 200)}`);
  }
}
