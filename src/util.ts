import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ModelUsage } from "./types.js";

export function utcNow(): Date {
  return new Date();
}

export function isoformat(moment = utcNow()): string {
  return moment.toISOString();
}

export function runId(moment = utcNow()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${moment.getFullYear()}${pad(moment.getMonth() + 1)}${pad(moment.getDate())}-${pad(moment.getHours())}${pad(moment.getMinutes())}${pad(moment.getSeconds())}`;
}

export function stableHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function slug(text: string, fallback = "case"): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

const SECRET_CONTROL = /password|passwd|secret|api[_-]?key|access[_-]?token|密码|口令/i;

export function isSecretControl(name?: string): boolean {
  return SECRET_CONTROL.test(name ?? "");
}

/** Field values that must not be sent to a model or written into a report index. */
export function publicValue(name: string | undefined, value: string | undefined): string {
  if (!value || isSecretControl(name)) return "";
  return value;
}

export function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Only absolute http and https URLs are allowed");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http and https URLs are allowed, got ${parsed.protocol}`);
  }
}

export function assertHttpsUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Download URL must be an absolute https URL");
  }
  if (parsed.protocol !== "https:") throw new Error("Download URL must use https");
}

export function expandVars(
  text: string,
  extra: Record<string, unknown> = {},
  options: { keepMissing?: boolean } = {},
): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    if (name in extra && extra[name] != null) return String(extra[name]);
    const fromEnv = process.env[name];
    if (fromEnv) return fromEnv;
    return options.keepMissing ? match : (fromEnv ?? "");
  });
}

export function expandDeep(value: unknown, extra: Record<string, unknown> = {}, keepMissing = false): unknown {
  if (typeof value === "string") return expandVars(value, extra, { keepMissing });
  if (Array.isArray(value)) return value.map((item) => expandDeep(item, extra, keepMissing));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandDeep(v, extra, keepMissing)]));
  }
  return value;
}

export function jsonpath(data: unknown, rawPath?: string | null): unknown {
  if (!rawPath || rawPath === "$") return data;
  if (!rawPath.startsWith("$")) throw new Error(`JSONPath must start with $: ${rawPath}`);
  const tokenRe = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]|\["([^"]+)"\]|\['([^']+)'\]/g;
  let current: unknown = data;
  let cursor = 1;
  while (cursor < rawPath.length) {
    tokenRe.lastIndex = cursor;
    const match = tokenRe.exec(rawPath);
    if (!match || match.index !== cursor) throw new Error(`Unsupported JSONPath: ${rawPath}`);
    const key = match[1] ?? match[3] ?? match[4];
    const index = match[2];
    if (index !== undefined) {
      if (!Array.isArray(current)) return null;
      current = current[Number(index)];
    } else {
      if (!current || typeof current !== "object") return null;
      current = (current as Record<string, unknown>)[key!];
    }
    cursor = tokenRe.lastIndex;
  }
  return current;
}

export function truncate(text: string | null | undefined, limit = 2000): string {
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function resolveStartUrl(url?: string | null): string | undefined {
  if (!url) return url ?? undefined;
  if (/^(https?:|file:|about:|data:)/.test(url)) return url;
  const abs = path.resolve(url);
  if (existsSync(abs)) return pathToFileURL(abs).href;
  return url;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function elapsedMs(started: number): number {
  const ms = performance.now() - started;
  if (ms <= 0) return 0;
  if (ms < 1) return Math.round(ms * 10) / 10;
  return Math.round(ms);
}

export function parseModelUsage(usage: unknown): ModelUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const raw = usage as Record<string, unknown>;
  const asNum = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const inputTokens = asNum(raw.input_tokens ?? raw.prompt_tokens ?? raw.inputTokens);
  const outputTokens = asNum(raw.output_tokens ?? raw.completion_tokens ?? raw.outputTokens);
  const totalTokens =
    asNum(raw.total_tokens ?? raw.totalTokens) ??
    (inputTokens != null || outputTokens != null ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);
  if (inputTokens == null && outputTokens == null && totalTokens == null) return undefined;
  return { inputTokens, outputTokens, totalTokens };
}
