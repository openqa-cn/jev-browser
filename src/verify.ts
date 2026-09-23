import type { BrowserSession } from "./browser.js";
import { resolveTarget } from "./cases.js";
import { LocatorMiss } from "./errors.js";
import type { ControlSnapshot, PageState, Step, Target } from "./types.js";
import { jsonpath } from "./util.js";

export function assessActionEffect(input: {
  op: string;
  value?: string;
  before?: ControlSnapshot;
  after: Pick<PageState, "url" | "title" | "text" | "elements">;
}): "pass" | "fail" {
  const afterText = [
    input.after.text,
    input.after.title,
    input.after.url,
    ...input.after.elements.map((item) => `${item.name} ${item.value}`),
  ].join("\n");
  const changed =
    !input.before ||
    input.before.url !== input.after.url ||
    input.before.title !== input.after.title ||
    input.before.elements.map((item) => `${item.role}|${item.name}|${item.value}`).join("\n") !==
      input.after.elements.map((item) => `${item.role}|${item.name}|${item.value}`).join("\n");
  if (input.op === "wait") return "pass";
  if (input.op === "type" || input.op === "select") {
    const wanted = input.value?.replace(/\s+/g, "") ?? "";
    if (wanted && afterText.replace(/\s+/g, "").includes(wanted)) return "pass";
    return "fail";
  }
  return changed ? "pass" : "fail";
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
