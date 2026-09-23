import { execute } from "./act.js";
import type { BrowserSession } from "./browser.js";
import { StalePage } from "./errors.js";
import { compileCase } from "./generate.js";
import { actionMarkLabel, asCandidate, controlSnapshot } from "./observe/snapshot.js";
import { emptyCase, ReportWriter } from "./report.js";
import type { CanonicalCase, CaseResult, ObservedElement, PageState } from "./types.js";
import { elapsedMs, normalizeUrl, stableHash } from "./util.js";

export const DEFAULT_DENY = [
  "logout",
  "log out",
  "sign out",
  "退出",
  "登出",
  "delete",
  "删除",
  "remove",
  "pay",
  "支付",
  "checkout",
  "结账",
  "password",
  "危险",
  "确认删除",
];

export interface ExploreNode {
  id: string;
  url: string;
  title: string;
  controls: [string, string, string][];
}

export interface ExploreEdge {
  source: string;
  target: string;
  op: string;
  name: string;
  role: string;
}

export interface StateGraph {
  nodes: Record<string, ExploreNode>;
  edges: ExploreEdge[];
}

export function stateKey(page: PageState): string {
  const controls = page.elements.map((item) => [item.role, item.name, item.value] as [string, string, string]).sort();
  return stableHash({ url: normalizeUrl(page.url), controls }).slice(0, 16);
}

export function nodeFromPage(page: PageState): ExploreNode {
  return {
    id: stateKey(page),
    url: page.url,
    title: page.title,
    controls: page.elements.map((item) => [item.role, item.name, item.value] as [string, string, string]).sort(),
  };
}

export async function explore(
  session: BrowserSession,
  writer: ReportWriter,
  url: string,
  options: { maxStates?: number; maxSteps?: number; maxMinutes?: number; deny?: string[]; allow?: string[] } = {},
): Promise<{ graph: StateGraph; result: CaseResult; compiled: CanonicalCase[] }> {
  const deny = (options.deny ?? DEFAULT_DENY).map((item) => item.toLowerCase());
  const allow = (options.allow ?? []).map((item) => item.toLowerCase());
  const graph: StateGraph = { nodes: {}, edges: [] };
  const result = emptyCase({ id: "explore", name: `Explore ${url}`, source: "explore", goal: `Explore ${url}` });
  let page = await session.goto(url);
  const started = Date.now();
  const visited = new Set<string>();
  let stepIndex = 0;
  const maxStates = options.maxStates ?? 12;
  const maxSteps = options.maxSteps ?? 30;
  const budget = (options.maxMinutes ?? 3) * 60_000;
  while (stepIndex < maxSteps && Object.keys(graph.nodes).length < maxStates && Date.now() - started < budget) {
    const source = addNode(graph, page);
    const target = nextTarget(page, visited, deny, allow);
    if (!target) break;
    visited.add(`${stateKey(page)}|${target.role}|${target.name}`);
    stepIndex += 1;
    const kind = "click";
    let status = "pass";
    let error: string | undefined;
    const stepStarted = performance.now();
    const observeMs = session.lastObserveMs;
    const observed = controlSnapshot(page);
    try {
      await execute(session, page, target, kind);
      page = await session.observe();
      const dest = addNode(graph, page);
      graph.edges.push({ source: source.id, target: dest.id, op: kind, name: target.name, role: target.role });
    } catch (err) {
      try {
        page = await session.observe();
      } catch {
        /* keep */
      }
      const dest = addNode(graph, page);
      graph.edges.push({ source: source.id, target: dest.id, op: "error", name: target.name, role: target.role });
      status = "fail";
      error = err instanceof Error ? err.message : String(err);
      if (!(err instanceof StalePage) && status === "fail") {
        /* already recorded */
      }
    }
    let screenshot: string | undefined;
    if (writer.screenshots) {
      try {
        screenshot = writer.saveScreenshot(
          "explore",
          stepIndex,
          target.role,
          await session.screenshot({ node: target.node, label: actionMarkLabel(target) }),
        );
      } catch {
        screenshot = undefined;
      }
    }
    result.steps.push({
      index: stepIndex,
      op: kind,
      status,
      target: `${target.role} ${target.name}`,
      value: undefined,
      url: page.url,
      title: page.title,
      matched: asCandidate(target),
      error,
      screenshot,
      durationMs: elapsedMs(stepStarted),
      observeMs,
      observed,
    });
    if (status === "fail") break;
  }
  result.durationMs = Date.now() - started;
  result.status = result.steps.length
    ? result.steps.every((step) => step.status === "pass")
      ? "pass"
      : result.steps.some((step) => step.status === "fail")
        ? "fail"
        : "blocked"
    : "blocked";
  if (!result.steps.length) result.error = "no safe controls to explore";
  const compiled = result.steps.length
    ? [compileCase(result, url, `Explored path from ${url}`, "explore-path")]
    : [];
  return { graph, result, compiled };
}

function addNode(graph: StateGraph, page: PageState): ExploreNode {
  const node = nodeFromPage(page);
  graph.nodes[node.id] ??= node;
  return graph.nodes[node.id];
}

function nextTarget(
  page: PageState,
  visited: Set<string>,
  deny: string[],
  allow: string[],
): ObservedElement | undefined {
  const key = stateKey(page);
  const ranked = [...page.elements].sort((a, b) => priority(a) - priority(b) || a.name.localeCompare(b.name));
  for (const item of ranked) {
    const label = `${item.name} ${item.value}`.toLowerCase();
    if (deny.some((term) => label.includes(term)) && !allow.some((term) => label.includes(term))) continue;
    if (item.role === "textbox" && (item.name || "").toLowerCase().includes("password")) continue;
    if (visited.has(`${key}|${item.role}|${item.name}`)) continue;
    if (item.operations.includes("CLICK")) return item;
  }
  return undefined;
}

function priority(item: ObservedElement): number {
  return { link: 0, tab: 1, button: 2, searchbox: 3, textbox: 4, combobox: 5, checkbox: 6 }[item.role] ?? 9;
}
