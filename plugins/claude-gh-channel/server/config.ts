/**
 * Config loader for claude-gh-channel.
 *
 * Reads ~/.config/claude-gh-channel/config.yaml (overridable via
 * GH_CHANNEL_CONFIG env), templates ${env:*} + ${user.*} + ${vars.*}
 * references, validates required shape, returns a frozen Config.
 *
 * Templating happens once at load time. Result is cached. Reload via /gh-channel-reload.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "claude-gh-channel", "config.yaml");
const CONFIG_PATH = process.env.GH_CHANNEL_CONFIG ?? DEFAULT_CONFIG_PATH;

export type Subscription = {
  repo: string;
  events: string[];
  filters?: {
    ignore_authors?: string[];
    ignore_if?: string;
  };
};

export type RoutingHint = {
  on: string; // "event_type" or "event_type.action"
  when?: string;
  meta: Record<string, string>;
};

export type Config = {
  version: 1;
  user: {
    github_username: string;
    display_name?: string;
    tunnel_url?: string;
  };
  vars: Record<string, unknown>;
  sidecar: Record<string, unknown>;
  subscriptions: Subscription[];
  agent_brief: string; // resolved (file loaded + templated)
  brief_vars: Record<string, unknown>;
  routing_hints: RoutingHint[];
  runtime: {
    enabled: boolean;
    http_port: number;
    sqlite_path: string;
    log_path: string;
    background_session: {
      enabled: boolean;
      auto_start: boolean;
      restart_on_crash: boolean;
    };
    quiet_mode: boolean;
    pause_until: string | null;
    disabled_repos: string[];
  };
  // Raw config for debug/inspection
  _raw: unknown;
};

const TEMPLATE_RE = /\$\{(env:|user\.|vars\.|brief_vars\.|CLAUDE_PLUGIN_ROOT)([A-Z0-9_]*|[a-zA-Z0-9_.-]*)?\}/g;

function applyTemplating(
  input: unknown,
  ctx: { env: NodeJS.ProcessEnv; user: any; vars: any; brief_vars: any; plugin_root: string },
  inBrief = false,
): unknown {
  if (typeof input === "string") {
    return input.replace(/\$\{([^}]+)\}/g, (_, expr) => {
      const trimmed = expr.trim();
      if (trimmed === "CLAUDE_PLUGIN_ROOT") return ctx.plugin_root;
      if (trimmed.startsWith("env:")) {
        const v = ctx.env[trimmed.slice(4)];
        if (v == null) throw new Error(`config: missing env var ${trimmed.slice(4)}`);
        return v;
      }
      if (trimmed.startsWith("user.")) {
        return resolvePath(ctx.user, trimmed.slice(5)) ?? "";
      }
      if (trimmed.startsWith("vars.")) {
        return resolvePath(ctx.vars, trimmed.slice(5)) ?? "";
      }
      if (trimmed.startsWith("brief_vars.")) {
        if (!inBrief) {
          throw new Error(`config: \${brief_vars.*} only allowed inside agent_brief; saw \${${trimmed}}`);
        }
        const val = resolvePath(ctx.brief_vars, trimmed.slice(11));
        return Array.isArray(val) ? val.join(", ") : String(val ?? "");
      }
      return ""; // unknown templating syntax — silently drop
    });
  }
  if (Array.isArray(input)) return input.map((x) => applyTemplating(x, ctx, inBrief));
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) out[k] = applyTemplating(v, ctx, inBrief);
    return out;
  }
  return input;
}

function resolvePath(obj: any, dotPath: string): any {
  return dotPath.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

let cached: Config | null = null;

export function loadConfig(force = false): Config {
  if (cached && !force) return cached;

  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `config: ${CONFIG_PATH} not found. Run /gh-channel-setup or copy config/example.yaml to ${CONFIG_PATH} and edit.`,
    );
  }

  const raw = parseYaml(readFileSync(CONFIG_PATH, "utf8")) as any;
  if (raw == null || typeof raw !== "object") {
    throw new Error(`config: ${CONFIG_PATH} is not a valid YAML mapping`);
  }
  if (raw.version !== 1) {
    throw new Error(`config: unsupported version ${raw.version} (only 1 is supported)`);
  }
  if (!raw.user?.github_username) {
    throw new Error("config: user.github_username is required");
  }
  if (!Array.isArray(raw.subscriptions) || raw.subscriptions.length === 0) {
    throw new Error("config: at least one subscription is required");
  }

  // CLAUDE_PLUGIN_ROOT is set by Claude Code when the plugin is loaded normally.
  // For standalone runs (e.g. smoke tests, manual bun server/index.ts), derive
  // it from this file's location: server/config.ts lives at <plugin-root>/server/config.ts.
  const pluginRoot =
    process.env.CLAUDE_PLUGIN_ROOT ??
    (typeof import.meta !== "undefined" && (import.meta as any).dir
      ? join((import.meta as any).dir, "..")
      : join(homedir(), "claude-gh-channel"));

  const templateCtx = {
    env: process.env,
    user: raw.user,
    vars: raw.vars ?? {},
    brief_vars: raw.brief_vars ?? {},
    plugin_root: pluginRoot,
  };

  // Template top-level (excluding agent_brief, which needs brief_vars resolution)
  const templated = applyTemplating(
    { ...raw, agent_brief: undefined, agent_brief_file: undefined },
    templateCtx,
  ) as any;

  // Resolve + template agent_brief (file or inline)
  let briefSource: string;
  if (raw.agent_brief_file) {
    const briefPath = applyTemplating(raw.agent_brief_file, templateCtx) as string;
    const expanded = expandHome(briefPath);
    if (!existsSync(expanded)) {
      throw new Error(`config: agent_brief_file not found: ${expanded}`);
    }
    briefSource = readFileSync(expanded, "utf8");
  } else if (typeof raw.agent_brief === "string") {
    briefSource = raw.agent_brief;
  } else {
    briefSource = "(no agent_brief configured)";
  }
  const agent_brief = applyTemplating(briefSource, templateCtx, true) as string;

  // Defaults
  const runtime = {
    enabled: false,
    http_port: 8788,
    sqlite_path: expandHome("~/.local/share/claude-gh-channel/events.db"),
    log_path: expandHome("~/.local/share/claude-gh-channel/server.log"),
    background_session: {
      enabled: false,
      auto_start: true,
      restart_on_crash: true,
    },
    quiet_mode: false,
    pause_until: null,
    disabled_repos: [] as string[],
    ...(templated.runtime ?? {}),
  };
  if (typeof runtime.sqlite_path === "string") runtime.sqlite_path = expandHome(runtime.sqlite_path);
  if (typeof runtime.log_path === "string") runtime.log_path = expandHome(runtime.log_path);

  const cfg: Config = {
    version: 1,
    user: templated.user,
    vars: templated.vars ?? {},
    sidecar: templated.sidecar ?? {},
    subscriptions: templated.subscriptions,
    agent_brief,
    brief_vars: raw.brief_vars ?? {},
    routing_hints: templated.routing_hints ?? [],
    runtime,
    _raw: raw,
  };

  cached = Object.freeze(cfg);
  return cached;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
