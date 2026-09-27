/**
 * pi-thinking-compact-lite: pure core (no pi imports, no I/O, no network)
 *
 * One transform, applied idempotently to every request's view:
 *   every assistant thinking block is head-truncated (default 600 chars + marker)
 *   or dropped, and truncated blocks re-carry the reasoning carrier field.
 *
 * Why idempotency is the whole design: pi re-delivers the PRISTINE transcript on
 * every request (the transform result is never written back), so the same pristine
 * input + the same rule must always produce the same output — that is exactly the
 * condition for the provider prefix cache to keep hitting while thinking shrinks.
 */

import { createHash } from "node:crypto";

// ============================================================================
// Structural detection
// ============================================================================

export interface ThinkingLike {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}

export function isThinkingBlock(block: unknown): block is ThinkingLike {
  if (typeof block !== "object" || block === null) return false;
  const b = block as Record<string, unknown>;
  return b.type === "thinking" && typeof b.thinking === "string";
}

export function isAssistantMessage(message: unknown): message is { role: "assistant"; content: unknown[] } {
  if (typeof message !== "object" || message === null) return false;
  const m = message as Record<string, unknown>;
  return m.role === "assistant" && Array.isArray(m.content);
}

export interface ThinkingRef {
  msgIndex: number;
  blockIndex: number;
  hash: string;
  text: string;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** Every thinking block in the message array, in order */
export function collectThinkingBlocks(messages: readonly unknown[]): ThinkingRef[] {
  const out: ThinkingRef[] = [];
  for (let mi = 0; mi < messages.length; mi += 1) {
    const message = messages[mi];
    if (!isAssistantMessage(message)) continue;
    for (let bi = 0; bi < message.content.length; bi += 1) {
      const block = message.content[bi];
      if (isThinkingBlock(block)) {
        out.push({ msgIndex: mi, blockIndex: bi, hash: hashText(block.thinking), text: block.thinking });
      }
    }
  }
  return out;
}

// ============================================================================
// The transform
// ============================================================================

export type Action = "truncate" | "drop";

/** Marker appended to a truncated thinking block */
export const TRUNCATE_MARKER = "\n[... thinking truncated by pi-thinking-compact ...]";

/** Default excerpt size in characters (≈150 tokens at ~4 chars/token) */
export const DEFAULT_TRUNCATE_CHARS = 600;

export function truncateThinking(text: string, maxChars: number = DEFAULT_TRUNCATE_CHARS): { text: string; truncated: boolean } {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, Math.max(0, maxChars)) + TRUNCATE_MARKER, truncated: true };
}

export interface AppliedInfo {
  hash: string;
  action: Action | "kept-short";
  originalChars: number;
  outChars: number;
  savedChars: number;
}

/**
 * Apply the rule to EVERY thinking block, returning a new message array
 * (originals untouched). Idempotent by construction: same input + same params
 * => same output. A drop that would empty an assistant message falls back to
 * keep (an empty content array is malformed downstream).
 */
export function applyToAll(
  messages: readonly unknown[],
  action: Action = "truncate",
  maxChars: number = DEFAULT_TRUNCATE_CHARS,
): { messages: unknown[]; applied: AppliedInfo[] } {
  const out = [...messages];
  const applied: AppliedInfo[] = [];
  for (let mi = 0; mi < out.length; mi += 1) {
    const message = out[mi];
    if (!isAssistantMessage(message)) continue;
    let changed = false;
    const nextContent = message.content.map((block) => {
      if (!isThinkingBlock(block)) return block;
      if (action === "drop") {
        changed = true;
        return null;
      }
      const cut = truncateThinking(block.thinking, maxChars);
      applied.push({
        hash: hashText(block.thinking),
        action: cut.truncated ? "truncate" : "kept-short",
        originalChars: block.thinking.length,
        outChars: cut.text.length,
        savedChars: block.thinking.length - cut.text.length,
      });
      changed = true;
      // pi-ai decides the wire carrier from thinkingSignature: keeping "reasoning_content"
      // makes the excerpt ride the SAME field the pristine block used (instead of vanishing)
      return { type: "thinking", thinking: cut.text, thinkingSignature: "reasoning_content" } as ThinkingLike;
    });
    if (!changed) continue;
    const kept = nextContent.filter((b): b is unknown => b !== null);
    if (kept.length === 0) continue; // empty-content guard: the message stays as-is (no record)
    if (action === "drop") {
      for (const block of message.content) {
        if (!isThinkingBlock(block)) continue;
        applied.push({ hash: hashText(block.thinking), action: "drop", originalChars: block.thinking.length, outChars: 0, savedChars: block.thinking.length });
      }
    }
    out[mi] = { ...(message as Record<string, unknown>), content: kept };
  }
  return { messages: out, applied };
}

// ============================================================================
// Model gate (allowlist with per-segment wildcards)
// ============================================================================

/** Case-insensitive segment match with per-segment `*` wildcards (prefix-style: `glm-*`) */
function wildcardMatch(pattern: string, value: string): boolean {
  const p = pattern.trim().toLowerCase();
  const v = value.trim().toLowerCase();
  if (!p || !v) return false;
  if (p === "*") return true;
  return p.endsWith("*") ? v.startsWith(p.slice(0, -1)) : p === v;
}

/**
 * Resolve the allowlist from the environment.
 *  - unset / null          -> null (the extension is fully off: no transform, no logs)
 *  - empty or only commas  -> [] (a kill switch: every model stops here)
 *  - anything else         -> parsed on commas (provider/id entries)
 */
export function resolveAllowedModels(raw: string | null | undefined): string[] | null {
  if (raw === undefined || raw === null) return null;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.includes("/"));
}

export function modelAllowed(label: string | undefined, allowlist: readonly string[] | null): boolean {
  if (!allowlist || !label) return false;
  const slash = label.indexOf("/");
  if (slash <= 0) return false;
  const provider = label.slice(0, slash);
  const id = label.slice(slash + 1);
  if (!id) return false;
  return allowlist.some((entry) => {
    const at = entry.indexOf("/");
    const p = entry.slice(0, at);
    const i = entry.slice(at + 1);
    return wildcardMatch(p, provider) && wildcardMatch(i, id);
  });
}

// ============================================================================
// Formatting helpers (display only)
// ============================================================================

export function approxTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4));
}

export function fmtChars(chars: number): string {
  if (chars < 1000) return String(chars);
  return `${(chars / 1000).toFixed(1)}k`;
}
