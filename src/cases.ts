import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { LocatorMiss } from "./errors.js";
import { asCandidate } from "./observe/snapshot.js";
import type { CanonicalCase, ObservedElement, PageState, PilotConfig, Start, Step, Target } from "./types.js";
import { ALL_OPS } from "./types.js";
import { assertHttpUrl, expandDeep, expandVars, jsonpath, slug } from "./util.js";

export function targetDisplay(target?: Target): string {
  if (!target) return "";
  const parts = [target.role || "*", target.name || "*"];
  if (target.value) parts.push(`value=${target.value}`);
  if (target.within) parts.push(`within=${target.within}`);
  if ((target.nth ?? 1) !== 1) parts.push(`nth=${target.nth}`);
  return parts.join(" ");
}

export function normalizeOp(value: string): string {
  const aliases: Record<string, string> = { type_text: "type", scrollup: "scroll_up", scrolldown: "scroll_down" };
  const op = aliases[value.trim().toLowerCase().replace(/-/g, "_")] ?? value.trim().toLowerCase().replace(/-/g, "_");
  if (!ALL_OPS.has(op)) throw new Error(`Unknown op: ${value}`);
  return op;
}

export function expandStep(step: Step, extra: Record<string, unknown> = {}): Step {
  return expandDeep(step, extra, false) as Step;
}

export function normalizeStep(raw: Record<string, unknown>, extra: Record<string, unknown> = {}): Step {
  const data = expandDeep(raw, extra, true) as Record<string, unknown>;
  let target: Target | undefined;
  if (typeof data.target === "string") target = { name: data.target };
  else if (data.target && typeof data.target === "object") target = data.target as Target;
  const op = normalizeOp(String(data.op ?? ""));
  const step: Step = {
    op,
    target,
    value: data.value as string | undefined,
    waitMs: (data.wait_ms ?? data.waitMs) as number | undefined,
    urlIncludes: (data.url_includes ?? data.urlIncludes) as string | undefined,
    urlEquals: (data.url_equals ?? data.urlEquals) as string | undefined,
    titleIncludes: (data.title_includes ?? data.titleIncludes) as string | undefined,
    visibleText: (data.visible_text ?? data.visibleText) as string | undefined,
    hiddenText: (data.hidden_text ?? data.hiddenText) as string | undefined,
    elementState: (data.element_state ?? data.elementState) as Record<string, unknown> | undefined,
    method: data.method as string | undefined,
    url: data.url as string | undefined,
    headers: (data.headers as Record<string, string>) ?? {},
    json: data.json,
    body: data.body as string | undefined,
    save: (data.save as Record<string, string>) ?? {},
    expectStatus: (data.expect_status ?? data.expectStatus) as number | undefined,
    jsonpath: data.jsonpath as string | undefined,
    jsonpathEquals: data.jsonpath_equals ?? data.jsonpathEquals,
  };
  if (["click", "type", "select"].includes(op) && !step.target) throw new Error(`${op} requires target`);
  return step;
}

export function normalizeStart(raw: unknown, extra: Record<string, unknown> = {}): Start {
  if (typeof raw === "string") return { url: expandVars(raw, extra, { keepMissing: true }) };
  const data = (expandDeep(raw ?? {}, extra, true) as Record<string, unknown>) ?? {};
  const url = typeof data.url === "string" ? data.url : undefined;
  const storageState = (data.storageState ?? data.storage_state) as string | undefined;
  const headers = (data.headers as Record<string, string> | undefined) ?? {};
  return { url, storageState, headers };
}

export function normalizeCase(item: Record<string, unknown>, source = "", extra: Record<string, unknown> = {}): CanonicalCase {
  const start = normalizeStart(item.start, extra);
  const name = String(item.name ?? item.id ?? "unnamed");
  return {
    id: String(item.id ?? slug(name)),
    name,
    start,
    goal: item.goal as string | undefined,
    tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
    steps: ((item.steps as Record<string, unknown>[]) ?? []).map((step) => normalizeStep(step, extra)),
    teardown: ((item.teardown as Record<string, unknown>[]) ?? []).map((step) => normalizeStep(step, extra)),
    source,
  };
}

export function loadYamlCases(file: string, extra: Record<string, unknown> = {}): CanonicalCase[] {
  const raw = parseYaml(readFileSync(file, "utf8"));
  if (raw == null) return [];
  if (isPlan(raw)) return loadPlan(file, raw as Record<string, unknown>, extra);
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map((item) => normalizeCase(item as Record<string, unknown>, file, extra));
}

export function readPlanTitle(file: string): string | undefined {
  try {
    const raw = parseYaml(readFileSync(path.resolve(file), "utf8"));
    if (!isPlan(raw)) return undefined;
    const name = (raw as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) return name.trim();
    return path.basename(file, path.extname(file));
  } catch {
    return undefined;
  }
}

function isPlan(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const cases = (raw as { cases?: unknown }).cases;
  return Array.isArray(cases) && cases.length > 0 && cases.every((item) => typeof item === "string");
}

function loadPlan(file: string, raw: Record<string, unknown>, extra: Record<string, unknown>): CanonicalCase[] {
  const dir = path.dirname(file);
  const cases: CanonicalCase[] = [];
  for (const item of raw.cases as string[]) {
    const target = path.resolve(dir, item);
    cases.push(...loadOne(target, extra));
  }
  return cases;
}

const TYPE_RE = /^Type\s+"([^"]*)"\s+into\s+(\w+)\s+"([^"]*)"(?:\s+within\s+"([^"]*)")?$/i;
const CLICK_RE = /^Click\s+(\w+)\s+"([^"]*)"(?:\s+within\s+"([^"]*)")?$/i;
const SELECT_RE = /^Select\s+"([^"]*)"\s+in\s+(\w+)\s+"([^"]*)"$/i;
const SCROLL_RE = /^Scroll\s+(up|down)$/i;
const WAIT_RE = /^Wait(?:\s+(\d+)\s*ms)?$/i;
const HTTP_RE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)(?:\s+expect\s+(\d+))?$/i;
const ASSERT_URL = /url\s+(?:contains|includes)\s+['"`]?([^'"`]+)['"`]?/i;
const ASSERT_URL_EQ = /url\s+(?:equals|is)\s+['"`]?([^'"`]+)['"`]?/i;
const ASSERT_TEXT = /(?:text|visible(?:\s+text)?)\s+['"]([^'"]+)['"]/i;
const ASSERT_HIDDEN = /hidden(?:\s+text)?\s+['"]([^'"]+)['"]/i;
const ASSERT_TITLE = /title\s+(?:contains|includes)\s+['"]([^'"]+)['"]/i;

export function parseMarkdownCase(text: string, source = "", extra: Record<string, unknown> = {}): CanonicalCase {
  const meta: Record<string, string> = {};
  const steps: string[] = [];
  let name = "unnamed";
  let inSteps = false;
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith("# ")) {
      name = stripped.slice(2).trim();
      continue;
    }
    if (/^##\s+steps\s*$/i.test(stripped)) {
      inSteps = true;
      continue;
    }
    if (stripped.startsWith("## ")) {
      inSteps = false;
      continue;
    }
    if (inSteps) {
      const match = /^\d+\.\s+(.*)$/.exec(stripped);
      if (match) steps.push(match[1].trim());
      continue;
    }
    const metaMatch = /^-\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/.exec(stripped);
    if (metaMatch) meta[metaMatch[1].toLowerCase()] = metaMatch[2].trim();
  }
  return normalizeCase(
    {
      id: meta.id || slug(name),
      name,
      start: { url: unwrap(meta.start || meta.url) },
      goal: unwrap(meta.goal),
      tags: (meta.tags ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      steps: steps.map(parseMdStep) as unknown as Record<string, unknown>[],
    },
    source,
    extra,
  );
}

export function parseMdStep(text: string): Step {
  let match: RegExpExecArray | null;
  if ((match = TYPE_RE.exec(text))) {
    return { op: "type", value: match[1], target: { role: match[2], name: match[3], within: match[4] } };
  }
  if ((match = CLICK_RE.exec(text))) {
    return { op: "click", target: { role: match[1], name: match[2], within: match[3] } };
  }
  if ((match = SELECT_RE.exec(text))) {
    return { op: "select", value: match[1], target: { role: match[2], name: match[3] } };
  }
  if ((match = SCROLL_RE.exec(text))) return { op: `scroll_${match[1].toLowerCase()}` };
  if ((match = WAIT_RE.exec(text))) return { op: "wait", waitMs: match[1] ? Number(match[1]) : 100 };
  if ((match = HTTP_RE.exec(text))) {
    return { op: "http", method: match[1].toUpperCase(), url: match[2], expectStatus: match[3] ? Number(match[3]) : undefined };
  }
  if (text.toLowerCase().startsWith("assert")) {
    const body = text.slice(6);
    return {
      op: "assert",
      urlIncludes: ASSERT_URL.exec(body)?.[1]?.trim(),
      urlEquals: ASSERT_URL_EQ.exec(body)?.[1]?.trim(),
      visibleText: ASSERT_TEXT.exec(body)?.[1]?.trim(),
      hiddenText: ASSERT_HIDDEN.exec(body)?.[1]?.trim(),
      titleIncludes: ASSERT_TITLE.exec(body)?.[1]?.trim(),
    };
  }
  throw new Error(`Unrecognized markdown step: ${text}`);
}

export function loadMdCases(file: string, extra: Record<string, unknown> = {}): CanonicalCase[] {
  return [parseMarkdownCase(readFileSync(file, "utf8"), file, extra)];
}

export async function loadApiCases(
  url: string,
  config: PilotConfig,
  extra: Record<string, unknown> = {},
): Promise<CanonicalCase[]> {
  const headers = Object.fromEntries(
    Object.entries(config.api.headers).map(([key, value]) => [key, expandVars(value, extra)]),
  );
  const target = expandVars(url, extra);
  assertHttpUrl(target);
  const response = await fetch(target, { headers });
  if (!response.ok) throw new Error(`API ${url} returned HTTP ${response.status}`);
  const payload = await response.json();
  let items = jsonpath(payload, config.api.map.items ?? "$");
  if (items && typeof items === "object" && !Array.isArray(items) && Array.isArray((items as { data?: unknown }).data)) {
    items = (items as { data: unknown[] }).data;
  } else if (items && typeof items === "object" && !Array.isArray(items)) {
    items = [items];
  }
  if (!Array.isArray(items)) throw new Error("API items must be a list or object");
  return items.map((item, index) => {
    const record = item as Record<string, unknown>;
    return normalizeCase(
      {
        id: jsonpath(record, config.api.map.id) ?? `api-${index + 1}`,
        name: jsonpath(record, config.api.map.name) ?? jsonpath(record, config.api.map.id),
        start: jsonpath(record, config.api.map.start) ?? {},
        goal: jsonpath(record, config.api.map.goal),
        tags: jsonpath(record, config.api.map.tags) ?? [],
        steps: jsonpath(record, config.api.map.steps) ?? [],
        teardown: jsonpath(record, config.api.map.teardown) ?? [],
      } as Record<string, unknown>,
      url,
      extra,
    );
  });
}

export async function loadCases(
  paths: string[] = [],
  options: { fromApi?: string; config: PilotConfig; extra?: Record<string, unknown> },
): Promise<CanonicalCase[]> {
  const extra = options.extra ?? {};
  const cases: CanonicalCase[] = [];
  if (options.fromApi) cases.push(...(await loadApiCases(options.fromApi, options.config, extra)));
  for (const raw of paths) {
    const abs = path.resolve(raw);
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        const file = path.join(abs, name);
        if (/\.(ya?ml|md)$/i.test(name) && statSync(file).isFile()) {
          try {
            cases.push(...loadOne(file, extra));
          } catch {
            /* skip scripts that are not cases */
          }
        }
      }
      continue;
    }
    cases.push(...loadOne(abs, extra));
  }
  if (!cases.length) throw new Error("No cases loaded. Pass YAML/MD paths or --from-api.");
  return cases;
}

export function loadOne(file: string, extra: Record<string, unknown> = {}): CanonicalCase[] {
  const suffix = path.extname(file).toLowerCase();
  if (suffix === ".yaml" || suffix === ".yml") return loadYamlCases(file, extra);
  if (suffix === ".md") return loadMdCases(file, extra);
  throw new Error(`Unsupported case file: ${file}`);
}

export function resolveTarget(page: PageState, target: Target): { element: ObservedElement; matches: ObservedElement[] } {
  const matches = page.elements.filter((item) => {
    if (target.role && item.role.toLowerCase() !== target.role.toLowerCase()) return false;
    if (target.name && !nameMatch(item.name, target.name)) return false;
    if (target.value != null && !nameMatch(item.value, target.value)) return false;
    if (target.within && !nameMatch(item.within, target.within)) return false;
    return true;
  });
  const nth = Math.max(target.nth ?? 1, 1);
  if (!matches.length) {
    throw new LocatorMiss(`No element matched ${targetDisplay(target)}`, page.elements.slice(0, 20).map(asCandidate));
  }
  if (nth > matches.length) {
    throw new LocatorMiss(
      `${targetDisplay(target)} matched ${matches.length} element(s); nth=${nth} is out of range`,
      matches.map(asCandidate),
    );
  }
  if (matches.length > 1 && (target.nth ?? 1) === 1 && target.name) {
    const exact = matches.filter((item) => item.name === target.name);
    if (exact.length === 1) return { element: exact[0], matches };
    throw new LocatorMiss(
      `${targetDisplay(target)} matched ${matches.length} elements; add nth or within`,
      matches.map(asCandidate),
    );
  }
  return { element: matches[nth - 1], matches };
}

function nameMatch(actual: string, expected: string): boolean {
  const left = (actual || "").trim().toLowerCase();
  const right = (expected || "").trim().toLowerCase();
  return left === right || left.includes(right);
}

function unwrap(value?: string): string | undefined {
  return value?.trim().replace(/^['"]|['"]$/g, "");
}

export function exists(file: string): boolean {
  return existsSync(file);
}
