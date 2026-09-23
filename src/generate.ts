import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { CanonicalCase, CaseResult, Step, Target } from "./types.js";
import { resolveStartUrl, slug } from "./util.js";

export function compileCase(
  result: CaseResult,
  startUrl: string,
  goal?: string,
  caseId?: string,
): CanonicalCase {
  const steps: Step[] = [];
  let lastUrl = resolveStartUrl(startUrl) ?? startUrl;
  for (const item of result.steps) {
    if (item.status === "skip" || item.status === "blocked" || item.status === "fail") continue;
    if (["wait", "decide", "stale", "done", "blocked"].includes(item.op)) {
      if (item.op === "done" && item.title && !steps.some((step) => step.titleIncludes === item.title)) {
        steps.push({ op: "assert", titleIncludes: item.title });
      }
      continue;
    }
    const target = targetFromMatched(item.matched);
    if (item.op === "click" && target) {
      steps.push({
        op: "click",
        target,
        waitMs: item.url && pageKey(item.url) !== pageKey(lastUrl) ? 2000 : undefined,
      });
    } else if (item.op === "type" && target) steps.push({ op: "type", target, value: item.value });
    else if (item.op === "select" && target) steps.push({ op: "select", target, value: item.value });
    else if (item.op === "scroll_up" || item.op === "scroll_down") steps.push({ op: item.op });
    else if (item.op === "scroll") steps.push({ op: "scroll_down" });
    if (item.url && pageKey(item.url) !== pageKey(lastUrl)) {
      steps.push({ op: "assert", urlIncludes: urlHint(item.url, lastUrl) });
      lastUrl = item.url;
    }
  }
  if (!steps.some((step) => step.op === "assert") && result.steps.length) {
    const last = result.steps[result.steps.length - 1];
    if (last.title) steps.push({ op: "assert", titleIncludes: last.title });
  }
  return {
    id: caseId ?? slug(result.id),
    name: result.name,
    start: { url: startUrl },
    goal: goal ?? result.goal,
    tags: ["generated"],
    steps,
    teardown: [],
    source: "generated",
  };
}

export function writeCase(caseItem: CanonicalCase, dest: string, markdown = false): string[] {
  mkdirSync(path.dirname(dest), { recursive: true });
  const payload = {
    id: caseItem.id,
    name: caseItem.name,
    start: { url: caseItem.start.url },
    goal: caseItem.goal,
    tags: caseItem.tags.length ? caseItem.tags : ["generated"],
    steps: caseItem.steps.map(dumpStep),
  };
  writeFileSync(dest, stringifyYaml(payload));
  const written = [dest];
  if (markdown) {
    const md = dest.replace(/\.ya?ml$/i, ".md");
    writeFileSync(md, renderMarkdownCase(caseItem));
    written.push(md);
  }
  return written;
}

export function renderMarkdownCase(caseItem: CanonicalCase): string {
  const lines = [`# ${caseItem.name}`, "", `- id: ${caseItem.id}`, `- start: ${caseItem.start.url ?? ""}`];
  if (caseItem.goal) lines.push(`- goal: ${caseItem.goal}`);
  lines.push("", "## Steps");
  caseItem.steps.forEach((step, index) => lines.push(`${index + 1}. ${mdStep(step)}`));
  lines.push("");
  return lines.join("\n");
}

function dumpStep(step: Step): Record<string, unknown> {
  const data: Record<string, unknown> = { op: step.op };
  if (step.target) {
    const target: Record<string, unknown> = {};
    if (step.target.role) target.role = step.target.role;
    if (step.target.name) target.name = step.target.name;
    if (step.target.value) target.value = step.target.value;
    if (step.target.within) target.within = step.target.within;
    if ((step.target.nth ?? 1) !== 1) target.nth = step.target.nth;
    data.target = target;
  }
  if (step.value) data.value = step.value;
  if (step.waitMs) data.wait_ms = step.waitMs;
  if (step.urlIncludes) data.url_includes = step.urlIncludes;
  if (step.urlEquals) data.url_equals = step.urlEquals;
  if (step.titleIncludes) data.title_includes = step.titleIncludes;
  if (step.visibleText) data.visible_text = step.visibleText;
  if (step.hiddenText) data.hidden_text = step.hiddenText;
  return data;
}

function targetFromMatched(matched?: Record<string, unknown>): Target | undefined {
  if (!matched) return undefined;
  return {
    role: matched.role as string | undefined,
    name: (matched.name as string | undefined) || undefined,
    within: (matched.within as string | undefined) || undefined,
  };
}

function pageKey(url: string): string {
  try {
    const parsed = new URL(url, "file:///");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function urlHint(current: string, previous: string): string {
  const tail = current.replace(/\/$/, "").split("/").pop();
  if (tail && !previous.includes(tail)) return tail;
  return current;
}

function mdStep(step: Step): string {
  if (step.op === "type" && step.target) return `Type "${step.value ?? ""}" into ${step.target.role ?? "textbox"} "${step.target.name ?? ""}"`;
  if (step.op === "click" && step.target) return `Click ${step.target.role ?? "button"} "${step.target.name ?? ""}"`;
  if (step.op === "select" && step.target) return `Select "${step.value ?? ""}" in ${step.target.role ?? "combobox"} "${step.target.name ?? ""}"`;
  if (step.op === "assert") {
    const parts = [];
    if (step.urlIncludes) parts.push(`url contains \`${step.urlIncludes}\``);
    if (step.visibleText) parts.push(`text "${step.visibleText}"`);
    if (step.titleIncludes) parts.push(`title contains "${step.titleIncludes}"`);
    return `Assert ${parts.join(" and ") || "page changed"}`;
  }
  if (step.op.startsWith("scroll")) return `Scroll ${step.op.split("_").pop()}`;
  return step.op;
}
