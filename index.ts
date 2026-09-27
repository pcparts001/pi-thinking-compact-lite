/**
 * pi-thinking-compact-lite — uniform thinking compaction for Pi Agent.
 *
 * What it does: on every LLM request, every assistant thinking block in the outgoing
 * view is head-truncated (default 600 chars + marker) or dropped. No judgements, no
 * network calls of its own — the whole policy is one deterministic rule, applied
 * idempotently to the pristine transcript pi re-delivers each request, which is what
 * keeps the provider prefix cache hitting (measured: 94–96% cache hit with −26…31%
 * input on thinking-heavy zai sessions; see the README).
 *
 * Scope note (measured): thinking history is context-counted only on the zai route
 * (Coding Plan "Preserved Thinking", always on there — clear_thinking cannot turn it
 * off). DeepSeek-family servers ignore thinking fields entirely, so on those routes
 * this extension changes nothing (harmless, but pointless — keep the allowlist tight).
 *
 * Environment:
 *   THINKING_COMPACT_MODELS   allowlist; UNSET or null = fully off (no transform, no logs).
 *                             comma-separated `provider/id`; `*` wildcards per segment
 *                             (zai/*, zai/glm-5.3-flash). Empty string = kill switch.
 *   THINKING_COMPACT_ACTION   truncate (default) | drop
 *   THINKING_COMPACT_CHARS    excerpt length (default 600 ≈ 150 tok)
 *   THINKING_COMPACT_LOG      run log (default ~/.pi/agent/thinking-compact/runs.jsonl; off)
 *   THINKING_COMPACT_NOTIFY   off disables the one-line UI notice
 *   THINKING_COMPACT_DUMP     debug: write the outgoing payload to a file
 *
 * Commands:
 *   /thinking-compact         status
 *   /thinking-compact on|off  toggle (off stops transforming; the first request after
 *                             re-enabling rewrites the prefix once — by design)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  approxTokens,
  applyToAll,
  collectThinkingBlocks,
  fmtChars,
  modelAllowed,
  resolveAllowedModels,
  type Action,
} from "./core.ts";
import { appendLogRecord, resolveLogPath } from "./logger.ts";

export const ENTRY_TYPE = "pi-thinking-compact";

const MODELS_ENV = "THINKING_COMPACT_MODELS";
const ACTION_ENV = "THINKING_COMPACT_ACTION";
const CHARS_ENV = "THINKING_COMPACT_CHARS";
const NOTIFY_ENV = "THINKING_COMPACT_NOTIFY";
const DUMP_ENV = "THINKING_COMPACT_DUMP";

interface Config {
  allowlist: string[] | null;
  action: Action;
  truncateChars: number;
  notify: boolean;
  dumpPath: string | undefined;
  logPath: string | undefined;
}

function resolveConfig(): Config {
  const actionRaw = (process.env[ACTION_ENV] ?? "").trim().toLowerCase();
  const charsRaw = Number(process.env[CHARS_ENV]);
  return {
    allowlist: resolveAllowedModels(process.env[MODELS_ENV]),
    action: actionRaw === "drop" ? "drop" : "truncate",
    truncateChars: Number.isFinite(charsRaw) && charsRaw > 0 ? Math.floor(charsRaw) : 600,
    notify: (process.env[NOTIFY_ENV] ?? "").trim().toLowerCase() !== "off",
    dumpPath: (process.env[DUMP_ENV] ?? "").trim() || undefined,
    logPath: resolveLogPath(),
  };
}

/** ctx.model is a Model object: build the canonical "provider/id" label */
function modelLabel(ctx: ExtensionContext | undefined): string | undefined {
  const model = ctx?.model as { provider?: unknown; id?: unknown } | undefined;
  if (!model) return undefined;
  const provider = typeof model.provider === "string" ? model.provider.trim() : "";
  const id = typeof model.id === "string" ? model.id.trim() : "";
  return provider && id ? `${provider}/${id}` : undefined;
}

export default function thinkingCompact(pi: ExtensionAPI) {
  const config = resolveConfig();
  let allowlist = config.allowlist;
  let enabled = true;
  /** hashes already reported (notice/log once per block identity, not per request) */
  const seen = new Set<string>();
  let savedTotal = 0;

  const gated = (ctx: ExtensionContext | undefined): boolean =>
    enabled && modelAllowed(modelLabel(ctx), allowlist);

  const logContext = (ctx: ExtensionContext | undefined) => {
    const base: Record<string, unknown> = { ts: new Date().toISOString(), cwd: ctx?.cwd };
    try {
      base.sessionId = ctx?.sessionManager?.getSessionId?.();
    } catch {
      // tests / no session info: keep the rest of the record
    }
    const label = modelLabel(ctx);
    if (label) base.model = label;
    return base;
  };

  pi.on("context_with_system", (event, ctx) => {
    if (!gated(ctx)) return undefined;
    const messages: unknown[] = event.messages;
    const blocks = collectThinkingBlocks(messages);
    if (!blocks.length) return undefined;

    const { messages: out, applied } = applyToAll(messages, config.action, config.truncateChars);

    // First-seen bookkeeping: notice + log once per content hash (kept-short blocks are
    // recorded too — they were seen and the rule did not shrink them)
    const fresh = applied.filter((a) => !seen.has(a.hash));
    const savedNow = fresh.reduce((s, a) => s + (a.originalChars - a.outChars), 0);
    for (const a of applied) seen.add(a.hash);
    savedTotal += savedNow;

    if (fresh.length && config.notify && ctx?.hasUI) {
      const shrunken = fresh.filter((a) => a.action !== "kept-short");
      if (shrunken.length) {
        ctx.ui.notify(
          `thinking-compact: ${shrunken.length} block(s) ${config.action === "drop" ? "dropped" : "truncated"}, ` +
            `~${fmtChars(savedNow)} chars (~${approxTokens(savedNow)} tok) off this request`,
          "info",
        );
      }
    }
    for (const a of fresh) {
      appendLogRecord(
        {
          ...logContext(ctx),
          event: "apply",
          hash: a.hash,
          action: a.action,
          chars: a.originalChars,
          savedChars: a.originalChars - a.outChars,
        },
        config.logPath,
      );
    }
    pi.appendEntry(ENTRY_TYPE, {
      at: Date.now(),
      action: config.action,
      blocks: applied.length,
      savedCharsNow: savedNow,
      savedCharsTotal: savedTotal,
    });
    if (JSON.stringify(out) === JSON.stringify(messages)) return undefined; // nothing shrank (all kept-short)
    return { messages: out };
  });

  // Diagnostics only: dump the outgoing payload after this extension's rewrite
  pi.on("before_provider_request", (event) => {
    if (!config.dumpPath) return undefined;
    try {
      mkdirSync(dirname(config.dumpPath), { recursive: true });
      writeFileSync(config.dumpPath, `${JSON.stringify({ at: Date.now(), payload: event.payload }, null, 2)}\n`, "utf8");
    } catch {
      // diagnostics only
    }
    return undefined;
  });

  pi.on("session_start", () => {
    allowlist = resolveAllowedModels(process.env[MODELS_ENV]);
    seen.clear();
    savedTotal = 0;
  });

  pi.registerCommand("thinking-compact", {
    description: "pi-thinking-compact status / on / off (uniform thinking compaction, one deterministic rule)",
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        enabled = arg === "on";
        if (ctx.hasUI) ctx.ui.notify(`thinking-compact: ${arg}`, "info");
        return;
      }
      const label = modelLabel(ctx);
      const lines = [
        `pi-thinking-compact ${enabled ? "enabled" : "disabled"}`,
        `model: ${label ?? "?"} | allowlist: ${allowlist ? allowlist.join(", ") || "(empty = off)" : "(unset = off)"}`,
        `allowed: ${modelAllowed(label, allowlist) ? "yes" : "no"} | action: ${config.action} | chars: ${config.truncateChars}`,
        `blocks seen: ${seen.size} | saved so far: ~${fmtChars(savedTotal)} chars (~${approxTokens(savedTotal)} tok)`,
        `log: ${config.logPath ?? "off"}`,
      ];
      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
