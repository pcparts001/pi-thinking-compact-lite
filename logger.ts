/**
 * pi-thinking-compact-lite: run log (JSONL). Append-only, rotated once past 5 MB,
 * write failures swallowed, and thinking / prompt bodies are NEVER written
 * (hashes and lengths only).
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_LOG_PATH = join(homedir(), ".pi/agent/thinking-compact/runs.jsonl");
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_ENV = "THINKING_COMPACT_LOG";

export type LogRecord = {
  ts: string;
  event: "apply" | "skip" | "error";
  sessionId?: string;
  model?: string;
  hash?: string;
  chars?: number;
  savedChars?: number;
  action?: string;
  [key: string]: unknown;
};

export function resolveLogPath(raw: string | null | undefined = process.env[LOG_ENV]): string | undefined {
  const value = raw === undefined || raw === null ? DEFAULT_LOG_PATH : raw.trim();
  if (!value || value.toLowerCase() === "off") return undefined;
  return value;
}

export function appendLogRecord(record: LogRecord, path: string | null | undefined = resolveLogPath()): boolean {
  if (!path) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    try {
      if (existsSync(path) && statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // rotation failure must never stop the request
    }
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
