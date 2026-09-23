import { execute, runHttp } from "./act.js";
import type { BrowserSession } from "./browser.js";
import { expandStep, resolveTarget, targetDisplay } from "./cases.js";
import { elapsedMs, expandVars } from "./util.js";
import { LocatorMiss, PilotError, StalePage } from "./errors.js";
import { actionMarkLabel, asCandidate, controlSnapshot } from "./observe/snapshot.js";
import { ReportWriter } from "./report.js";
import type { CanonicalCase, CaseResult, ObservedElement, PageState, PilotConfig, Step, StepResult } from "./types.js";
import { assertStep } from "./verify.js";

export class CaseRunner {
  page: PageState | null = null;
  httpLast: Record<string, unknown> | null = null;

  constructor(
    private session: BrowserSession,
    private writer: ReportWriter,
    private extra: Record<string, unknown> = {},
  ) {}

  async runCase(caseItem: CanonicalCase): Promise<CaseResult> {
    const result: CaseResult = {
      id: caseItem.id,
      name: caseItem.name,
      source: caseItem.source,
      goal: caseItem.goal,
      status: "pass",
      durationMs: 0,
      steps: [],
    };
    const started = Date.now();
    const vars = { ...this.extra };
    this.httpLast = null;
    let failed = false;
    try {
      if (caseItem.start.url) this.page = await this.session.goto(expandVars(caseItem.start.url, vars));
      else this.page ??= await this.session.observe();
      for (const [offset, step] of caseItem.steps.entries()) {
        const index = offset + 1;
        if (failed) {
          result.steps.push(skippedStep(index, step));
          continue;
        }
        const stepResult = await this.runStep(caseItem.id, index, step, vars);
        result.steps.push(stepResult);
        if (stepResult.status === "fail" || stepResult.status === "blocked") {
          failed = true;
          result.status = stepResult.status;
          result.error = stepResult.error;
        }
      }
      for (const [offset, step] of caseItem.teardown.entries()) {
        const index = caseItem.steps.length + offset + 1;
        const stepResult = await this.runStep(caseItem.id, index, step, vars);
        result.steps.push(stepResult);
        if ((stepResult.status === "fail" || stepResult.status === "blocked") && result.status === "pass") {
          failed = true;
          result.status = stepResult.status;
          result.error = stepResult.error;
        }
      }
    } catch (error) {
      result.status = "fail";
      result.error = error instanceof Error ? error.message : String(error);
    }
    result.durationMs = Date.now() - started;
    if (!failed && result.status === "pass" && !result.steps.length) {
      result.status = "fail";
      result.error = "case has no steps";
    }
    return result;
  }

  async runStep(caseId: string, index: number, raw: Step, vars: Record<string, unknown> = this.extra): Promise<StepResult> {
    const step = expandStep(raw, vars);
    const started = performance.now();
    let mark: { node: number; label: string } | undefined;
    const record: StepResult = {
      index,
      op: step.op,
      status: "pass",
      target: targetDisplay(step.target) || step.url,
      value: step.value,
      durationMs: 0,
    };
    try {
      this.page ??= await this.session.observe();
      record.observeMs = this.session.lastObserveMs;
      record.observed = controlSnapshot(this.page);
      if (step.op === "http") {
        const payload = await runHttp(step, vars);
        this.httpLast = payload;
        record.http = { method: payload.method, url: payload.url, status: payload.status, body: payload.body, saved: payload.saved };
        this.writer.saveHttp(caseId, index, payload);
        if (!payload.ok) {
          record.status = "fail";
          record.error = String(payload.error ?? "http failed");
        }
      } else if (step.op === "assert") {
        const outcome = await assertStep(this.session, this.page, step, this.httpLast);
        record.expected = outcome.expected;
        record.actual = outcome.actual;
        if (!outcome.ok) {
          record.status = "fail";
          record.error = outcome.failures.join("; ");
        }
      } else if (step.op === "wait") {
        await execute(this.session, this.page, undefined, "wait", { waitMs: step.waitMs ?? 100 });
        this.page = await this.session.observe();
      } else if (step.op === "scroll_up" || step.op === "scroll_down") {
        await execute(this.session, this.page, undefined, "scroll", { delta: step.op === "scroll_up" ? -600 : 600 });
        await pause(this.session, this.page, step.waitMs);
        this.page = await this.session.observe();
      } else {
        if (!step.target || !this.page) throw new PilotError(`${step.op} requires a target`);
        const { element } = resolveTarget(this.page, step.target);
        record.matched = asCandidate(element);
        mark = { node: element.node, label: actionMarkLabel(element) };
        await this.act(element, step);
        await pause(this.session, this.page, step.waitMs);
        this.page = await this.session.observe();
      }
      record.url = this.session.url;
      record.title = await this.session.title();
      record.observeMs = this.session.lastObserveMs;
    } catch (error) {
      record.status = "fail";
      record.error = error instanceof Error ? error.message : String(error);
      if (error instanceof LocatorMiss) record.candidates = error.candidates;
      if (error instanceof StalePage) {
        try {
          this.page = await this.session.observe();
          record.observeMs = this.session.lastObserveMs;
        } catch {
          /* keep previous */
        }
      }
    }
    record.durationMs = elapsedMs(started);
    if (this.writer.screenshots && step.op !== "http") {
      try {
        record.screenshot = this.writer.saveScreenshot(caseId, index, step.op, await this.session.screenshot(mark));
      } catch {
        record.screenshot = undefined;
      }
    }
    return record;
  }

  private async act(element: ObservedElement, step: Step): Promise<void> {
    if (!this.page) throw new PilotError("page not observed");
    if (step.op === "click") await execute(this.session, this.page, element, "click");
    else if (step.op === "type") await execute(this.session, this.page, element, "type", { text: step.value });
    else if (step.op === "select") {
      await execute(this.session, this.page, element, "select", { optionValue: optionValue(element, step.value) });
    } else throw new PilotError(`Cannot execute ${step.op}`);
  }
}

function skippedStep(index: number, step: Step): StepResult {
  return {
    index,
    op: step.op,
    status: "skip",
    target: targetDisplay(step.target) || step.url,
    durationMs: 0,
    skipped: true,
  };
}

async function pause(session: BrowserSession, page: PageState | null, waitMs?: number): Promise<void> {
  if (!waitMs || waitMs <= 0 || !page) return;
  await execute(session, page, undefined, "wait", { waitMs });
}

function optionValue(element: ObservedElement, wanted?: string): string {
  if (wanted == null) throw new Error("select requires value");
  for (const option of element.options) {
    if (option.value === wanted || option.label === wanted || option.label.toLowerCase().includes(wanted.toLowerCase())) {
      return option.value;
    }
  }
  return wanted;
}

export function unusedConfig(_config: PilotConfig): void {
  /* reserved for future runner options */
}
