import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export interface KnowledgeDoc {
  app: string;
  title: string;
  hosts: string[];
  keywords: string[];
  general: boolean;
  body: string;
  file: string;
}

export function defaultKnowledgeRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "knowledge");
}

export function loadKnowledge(root = defaultKnowledgeRoot()): KnowledgeDoc[] {
  return walk(root)
    .filter((file) => file.endsWith(".md") && path.basename(file) !== "README.md")
    .map(readDoc)
    .filter((doc): doc is KnowledgeDoc => Boolean(doc));
}

export function retrieveKnowledge(input: { url?: string; goal?: string; root?: string; limit?: number } = {}): string {
  const host = hostname(input.url);
  const haystack = `${input.goal ?? ""}\n${input.url ?? ""}`;
  const docs = loadKnowledge(input.root);
  const general = docs.filter((doc) => doc.general).sort((a, b) => a.app.localeCompare(b.app));
  const ranked = docs
    .filter((doc) => !doc.general)
    .map((doc) => ({ doc, score: scoreDoc(doc, host, haystack) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.app.localeCompare(b.doc.app))
    .slice(0, input.limit ?? 3)
    .map((item) => item.doc);
  const selected = [...general, ...ranked];
  if (!selected.length) return "";
  return selected.map((doc) => doc.body.trim()).join("\n\n");
}

function scoreDoc(doc: KnowledgeDoc, host: string, haystack: string): number {
  const hostScore = host && doc.hosts.some((item) => host === item || host.endsWith(`.${item}`)) ? 2 : 0;
  const keywordScore = doc.keywords.filter((item) => item && haystack.includes(item)).length;
  return hostScore + keywordScore;
}

function hostname(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function walk(dir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of entries) {
    const full = path.join(dir, name);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function readDoc(file: string): KnowledgeDoc | undefined {
  const text = readFileSync(file, "utf8");
  const split = splitFrontmatter(text);
  const meta = split.meta;
  const hosts = stringList(meta.hosts);
  const keywords = stringList(meta.keywords);
  const body = split.body.trim();
  const general = meta.general === true;
  if (!body || (!general && !hosts.length && !keywords.length)) return undefined;
  return {
    app: String(meta.app ?? path.basename(path.dirname(file))),
    title: String(meta.title ?? ""),
    hosts,
    keywords,
    general,
    body,
    file,
  };
}

function splitFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  if (!text.startsWith("---\n")) return { meta: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { meta: {}, body: text };
  const raw = parseYaml(text.slice(4, end));
  const meta = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { meta, body: text.slice(end + 5) };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}
