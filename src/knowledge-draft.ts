import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { defaultKnowledgeRoot } from "./knowledge.js";
import type { StepResult } from "./types.js";

export function draftKnowledgeNote(input: {
  url?: string;
  goal?: string;
  steps: StepResult[];
}): string | undefined {
  const failed = [...input.steps].reverse().find((step) => step.status === "fail" && step.matched);
  const matched = controlName(failed?.matched);
  if (!matched) return undefined;
  const host = siteHost(input.url);
  const keywords = goalKeywords(input.goal);
  const lines = [
    "---",
    `app: ${appName(host)}`,
    `title: ${yamlString((input.goal ?? "失败步骤").slice(0, 40))}`,
    "hosts:",
    host ? `  - ${host}` : "  - ",
    "keywords:",
    ...(keywords.length ? keywords.map((item) => `  - ${yamlString(item)}`) : []),
    "---",
    "",
    "参考，不是可执行步骤。",
    "",
    noteLine(matched, failed?.error),
    "",
  ];
  return lines.join("\n");
}

export function acceptKnowledgeDraft(draftPath: string, root = defaultKnowledgeRoot()): string {
  const text = readFileSync(draftPath, "utf8");
  const draft = draftKnowledgeFields(text);
  const app = sanitizeApp(draft.app || "app");
  const dest = path.resolve(root, app, noteFileName(draft.title || app));
  const rootResolved = path.resolve(root);
  if (dest !== rootResolved && !dest.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error("knowledge note must stay inside the knowledge directory");
  }
  if (existsSync(dest)) throw new Error(`knowledge note already exists: ${dest}`);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, text.endsWith("\n") ? text : `${text}\n`);
  return dest;
}

function draftKnowledgeFields(text: string): { app: string; title: string } {
  if (!text.startsWith("---\n")) return { app: "app", title: "note" };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { app: "app", title: "note" };
  const raw = parseYaml(text.slice(4, end));
  const meta = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    app: String(meta.app ?? "app").trim() || "app",
    title: String(meta.title ?? "note").trim() || "note",
  };
}

function noteLine(matched: string, error?: string): string {
  if (/no visible effect|没有可见效果/i.test(error ?? "")) {
    return `- ${matched} 这一步没有留下可见效果，不要把它当成已经完成。`;
  }
  return `- 不要点 ${matched}。`;
}

const multiPartTlds = new Set(["co.uk", "com.cn", "com.au", "co.jp", "com.hk", "com.tw"]);

function siteHost(url?: string): string {
  const host = hostname(url);
  if (!host) return "";
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  const tail2 = parts.slice(-2).join(".");
  const multi = multiPartTlds;
  if (multi.has(tail2) && parts.length >= 3) return parts.slice(-3).join(".");
  return tail2;
}

function appName(host: string): string {
  if (!host) return "app";
  const parts = host.split(".").filter(Boolean);
  const tail2 = parts.slice(-2).join(".");
  if (multiPartTlds.has(tail2) && parts.length >= 3) return sanitizeApp(parts[parts.length - 3]);
  if (parts.length >= 2) return sanitizeApp(parts[parts.length - 2]);
  return sanitizeApp(parts[0] || "app");
}

function sanitizeApp(app: string): string {
  const cleaned = app.replace(/[\\/]/g, "").replace(/\.\./g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "app";
  return cleaned;
}

function noteFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|「」“”'"]/g, "").replace(/\s+/g, "").slice(0, 40);
  return `${cleaned || "note"}.md`;
}

function controlName(raw: Record<string, unknown> | undefined): string | undefined {
  if (!raw) return undefined;
  const role = String(raw.role ?? "").trim();
  const name = String(raw.name ?? "").trim();
  if (!role && !name) return undefined;
  return [role, name && `「${name}」`].filter(Boolean).join("");
}

function hostname(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function goalKeywords(goal?: string): string[] {
  const source = (goal ?? "").split(/\n\s*Planned steps:/)[0].split(/\n\s*Business notes/)[0];
  const found: string[] = [];
  const add = (value: string) => {
    const text = value.trim();
    if (!text || text.length < 2 || text.length > 40 || found.includes(text)) return;
    found.push(text);
  };
  for (const match of source.matchAll(/[「“"']([^」”"']+)[」”"']/g)) add(match[1]);
  if (found.length) return found.slice(0, 6);
  const fallback = source.replace(/\s+/g, " ").trim().slice(0, 40);
  if (fallback.length >= 2 && fallback !== "失败") found.push(fallback);
  return found.slice(0, 6);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
