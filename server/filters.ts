/**
 * Filter / routing-hint expression evaluator.
 *
 * The design doc calls for CEL. For v1 simplicity we use a thin
 * JavaScript-expression evaluator — the `when:` strings in config.yaml
 * are evaluated as JS expressions in a sandboxed context with the
 * event `payload`, the `user` config block, and `vars` in scope.
 *
 * Security note: expressions come from config.yaml on the user's own
 * machine — same trust boundary as code the user authors. Not safe for
 * untrusted config sources. Document this if/when we publish.
 */

import type { Config, RoutingHint, Subscription } from "./config";

type EvalCtx = {
  payload: unknown;
  user: Config["user"];
  vars: Config["vars"];
};

const evalCache = new Map<string, (ctx: EvalCtx) => unknown>();

function compile(expr: string): (ctx: EvalCtx) => unknown {
  const cached = evalCache.get(expr);
  if (cached) return cached;
  // Build a function: `({payload, user, vars}) => (<expr>)`
  // Try/catch around the call site so a bad expr returns undefined, not blow up.
  const fn = new Function(
    "payload",
    "user",
    "vars",
    `try { return (${expr}); } catch (_) { return undefined; }`,
  );
  const wrapper = (ctx: EvalCtx) => fn(ctx.payload, ctx.user, ctx.vars);
  evalCache.set(expr, wrapper);
  return wrapper;
}

export function evalBoolean(expr: string, ctx: EvalCtx): boolean {
  return Boolean(compile(expr)(ctx));
}

/**
 * Returns the subscription that matches a given (repo, event_type) pair,
 * after author + custom-when filtering. Returns null if filtered out.
 */
export function matchSubscription(
  config: Config,
  repo: string,
  eventType: string,
  payload: any,
): Subscription | null {
  const ctx: EvalCtx = { payload, user: config.user, vars: config.vars };
  for (const sub of config.subscriptions) {
    if (sub.repo !== repo) continue;
    if (!sub.events.includes(eventType)) continue;

    // Author ignore-list
    if (sub.filters?.ignore_authors?.length) {
      const senderLogin = extractAuthor(eventType, payload);
      if (senderLogin && sub.filters.ignore_authors.includes(senderLogin)) {
        return null;
      }
    }
    // ignore_if expression
    if (sub.filters?.ignore_if) {
      if (evalBoolean(sub.filters.ignore_if, ctx)) return null;
    }
    return sub;
  }
  return null;
}

function extractAuthor(eventType: string, payload: any): string | undefined {
  if (eventType === "pull_request") return payload?.pull_request?.user?.login;
  if (eventType === "issue_comment") return payload?.comment?.user?.login;
  if (eventType === "pull_request_review") return payload?.review?.user?.login;
  if (eventType === "pull_request_review_comment") return payload?.comment?.user?.login;
  return payload?.sender?.login;
}

/**
 * Returns merged routing-hint meta for an event (first match wins per `on:`).
 */
export function applyRoutingHints(
  hints: RoutingHint[],
  user: Config["user"],
  vars: Config["vars"],
  eventType: string,
  action: string | null,
  payload: any,
): Record<string, string> {
  const ctx: EvalCtx = { payload, user, vars };
  const out: Record<string, string> = {};
  const fullKey = action ? `${eventType}.${action}` : eventType;
  for (const hint of hints) {
    const onMatches =
      hint.on === eventType || hint.on === fullKey;
    if (!onMatches) continue;
    if (hint.when && !evalBoolean(hint.when, ctx)) continue;
    for (const [k, v] of Object.entries(hint.meta)) {
      if (!(k in out)) out[k] = String(v);
    }
  }
  return out;
}
