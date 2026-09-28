import type { BrowserSession } from "./browser.js";
import { resolveTarget } from "./cases.js";
import { LocatorMiss } from "./errors.js";
import type { ControlNode, ControlSnapshot, PageState, Step, Target } from "./types.js";
import { isSecretControl, jsonpath } from "./util.js";

export function assessActionEffect(input: {
  op: string;
  value?: string;
  before?: ControlSnapshot;
  after: Pick<PageState, "url" | "title" | "text" | "elements" | "marker">;
  matched?: { node?: number; role?: string; name?: string; within?: string };
}): "pass" | "fail" {
  const changed =
    !input.before ||
    input.before.url !== input.after.url ||
    input.before.title !== input.after.title ||
    input.before.elements.map((item) => `${item.role}|${item.name}|${item.value}|${item.filled ? 1 : 0}`).join("\n") !==
      input.after.elements.map((item) => `${item.role}|${item.name}|${item.value}|${item.filled ? 1 : 0}`).join("\n");
  const sameDocument = !input.before?.marker || !input.after.marker || input.before.marker === input.after.marker;
  if (input.op === "wait") return "pass";
  if (input.op === "type" || input.op === "select") {
    const wanted = input.value ?? "";
    if (!sameDocument) return freshPageShows(wanted, input.before, input.after) ? "pass" : "fail";
    if (input.matched) {
      const located = locateField(input.matched, input.before?.elements ?? [], input.after.elements);
      if (!located) return "fail";
      return fieldLanded(wanted, located.before, located.after) ? "pass" : "fail";
    }
    const gained = input.after.elements.filter((item) => {
      const previous = input.before?.elements.find((old) => old.node != null && old.node === item.node) ??
        input.before?.elements.find((old) => sameField(old, item));
      return fieldLanded(wanted, previous, item);
    });
    return gained.length === 1 ? "pass" : "fail";
  }
  return changed ? "pass" : "fail";
}

function fieldLanded(wanted: string, before: ControlNode | undefined, after: ControlNode): boolean {
  if (isSecretControl(after.name) || after.filled != null || before?.filled != null) {
    return !before?.filled && after.filled === true;
  }
  if (!valueShows(wanted, after.value ?? "")) return false;
  if (before && valueShows(wanted, before.value ?? "")) return false;
  return true;
}

/** Short numbers must match a whole token. Longer text may appear inside the field value. */
export function valueShows(wanted: string, actual: string): boolean {
  const foldedWanted = wanted.replace(/\s+/g, "");
  const foldedActual = actual.replace(/\s+/g, "");
  if (!foldedWanted || !foldedActual) return false;
  if (/^\d{1,2}$/.test(foldedWanted)) return new RegExp(`(^|[^0-9])${foldedWanted}([^0-9]|$)`).test(actual);
  return foldedActual.includes(foldedWanted);
}

function locateField(
  matched: { node?: number; role?: string; name?: string; within?: string },
  before: ControlNode[],
  after: ControlNode[],
): { before?: ControlNode; after: ControlNode } | undefined {
  if (matched.node != null) {
    const current = after.find((item) => item.node === matched.node);
    if (current) return { before: before.find((item) => item.node === matched.node), after: current };
  }
  const matches = after.filter((item) => sameField(item, matched));
  const changed = matches.find((item) => {
    const previous = before.find((old) => sameField(old, item));
    return (item.value ?? "") !== (previous?.value ?? "") || Boolean(item.filled) !== Boolean(previous?.filled);
  });
  const current = changed ?? (matches.length === 1 ? matches[0] : undefined);
  if (!current) return undefined;
  return { before: before.find((item) => sameField(item, current)), after: current };
}

function freshPageShows(
  wanted: string,
  before: { url?: string; title?: string; text?: string; elements?: { value?: string }[] } | undefined,
  after: { url?: string; title?: string; text?: string; elements?: { value?: string }[] },
): boolean {
  if (newlyShows(wanted, before?.url, after.url)) return true;
  if (newlyShows(wanted, before?.title, after.title)) return true;
  if (newlyShows(wanted, before?.text, after.text)) return true;
  const afterValue = (after.elements ?? []).some((item) => valueShows(wanted, item.value ?? ""));
  const beforeValue = (before?.elements ?? []).some((item) => valueShows(wanted, item.value ?? ""));
  return afterValue && !beforeValue;
}

function newlyShows(wanted: string, before: string | undefined, after: string | undefined): boolean {
  const next = decodeText(after ?? "");
  const prev = decodeText(before ?? "");
  return valueShows(wanted, next) && !valueShows(wanted, prev);
}

function decodeText(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sameField(
  left: { role?: string; name?: string; within?: string },
  right: { role?: string; name?: string; within?: string },
): boolean {
  return (left.role ?? "") === (right.role ?? "") && (left.name ?? "") === (right.name ?? "") && (left.within ?? "") === (right.within ?? "");
}

export async function assertStep(
  session: BrowserSession,
  page: PageState,
  step: Step,
  httpLast?: Record<string, unknown> | null,
): Promise<{ ok: boolean; expected: Record<string, unknown>; actual: Record<string, unknown>; failures: string[] }> {
  const title = await session.title();
  const expected: Record<string, unknown> = {};
  const actual: Record<string, unknown> = { url: session.url, title, visible_text: page.text };
  const failures: string[] = [];
  const check = (name: string, want: unknown, got: unknown, ok: boolean) => {
    expected[name] = want;
    actual[name] = got;
    if (!ok) failures.push(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  };
  if (step.urlIncludes) check("url_includes", step.urlIncludes, session.url, session.url.includes(step.urlIncludes));
  if (step.urlEquals) check("url_equals", step.urlEquals, session.url, session.url === step.urlEquals);
  if (step.titleIncludes) check("title_includes", step.titleIncludes, title, title.includes(step.titleIncludes));
  if (step.visibleText) check("visible_text", step.visibleText, page.text, page.text.includes(step.visibleText));
  if (step.hiddenText) check("hidden_text", `absent:${step.hiddenText}`, page.text, !page.text.includes(step.hiddenText));
  if (step.elementState) {
    try {
      const { element } = resolveTarget(page, step.elementState as Target);
      for (const key of ["value", "role", "name"] as const) {
        if (key in step.elementState && element[key] !== step.elementState[key]) {
          failures.push(`element_state.${key}: expected ${JSON.stringify(step.elementState[key])}, got ${JSON.stringify(element[key])}`);
        }
      }
      actual.element = { role: element.role, name: element.name, value: element.value };
    } catch (error) {
      if (error instanceof LocatorMiss) failures.push(error.message);
      else throw error;
    }
  }
  if (step.expectStatus != null) {
    check("http_status", step.expectStatus, httpLast?.status, httpLast?.status === step.expectStatus);
  }
  if (step.jsonpath) {
    const got = jsonpath(httpLast?.json, step.jsonpath);
    actual.jsonpath = got;
    if (step.jsonpathEquals !== undefined) check("jsonpath", step.jsonpathEquals, got, got === step.jsonpathEquals);
    else if (got == null || got === "" || (Array.isArray(got) && !got.length)) failures.push(`jsonpath ${step.jsonpath} was empty`);
  }
  if (
    !step.urlIncludes &&
    !step.urlEquals &&
    !step.titleIncludes &&
    !step.visibleText &&
    !step.hiddenText &&
    !step.elementState &&
    step.expectStatus == null &&
    !step.jsonpath
  ) {
    failures.push("assert step had no checks");
  }
  return { ok: !failures.length, expected, actual, failures };
}
