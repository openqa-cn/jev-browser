import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { execute, settle } from "./act.js";
import type { BrowserSession } from "./browser.js";
import { DecisionError, StalePage } from "./errors.js";
import { actionMarkLabel, asCandidate, contentKey, controlSnapshot, elementLabel } from "./observe/snapshot.js";
import { JevProvider, createDecisionProvider, decisionModelLabel, jevAssert, jevConfirmDone } from "./jev.js";
import { retrieveKnowledge } from "./knowledge.js";
import { applyHistoryGuards, buildSpace, confirmDone, decide, guideGoal, planTask, resolveDecision, ScriptedProvider, searchQueryFromGoal, selectedIndex, type DecisionProvider } from "./policy.js";
import { emptyCase, ReportWriter } from "./report.js";
import { assessActionEffect } from "./verify.js";
import type { CaseResult, ControlSnapshot, Decision, ModelUsage, PageState, PilotConfig, StepResult, TaskPlan } from "./types.js";
import { elapsedMs, isSecretControl, publicValue } from "./util.js";

export function loadScript(file: string): Record<string, unknown>[] {
  const raw = readFileSync(file, "utf8");
  const data = file.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
  if (!Array.isArray(data)) throw new Error("decision script must be a list");
  return data as Record<string, unknown>[];
}

export class Agent {
  provider: DecisionProvider;
  pendingText: { context: string; text: string; helper: Record<string, unknown> } | null = null;
  private knowledge = "";
  private prepared?: TaskPlan;
  private predictedContent = "";

  constructor(
    private session: BrowserSession,
    private writer: ReportWriter,
    private config: PilotConfig,
    options: { provider?: DecisionProvider; script?: Record<string, unknown>[] } = {},
  ) {
    this.provider = options.provider ?? createDecisionProvider(config, options.script);
  }

  /** Plan before the browser opens the case, so the page does not sit idle. */
  async plan(url: string, goal: string): Promise<TaskPlan | undefined> {
    if (this.provider instanceof ScriptedProvider) return undefined;
    this.knowledge = retrieveKnowledge({ url, goal });
    this.prepared = await planTask(goal, this.config, this.knowledge);
    return this.prepared;
  }

  async run(
    url: string,
    goal: string,
    caseId = "auto",
    hooks: { onStep?: (result: CaseResult) => void } = {},
  ): Promise<{ result: CaseResult; history: Record<string, unknown>[] }> {
    if (!this.knowledge) this.knowledge = retrieveKnowledge({ url, goal });
    const plan =
      this.provider instanceof ScriptedProvider ? undefined : (this.prepared ?? (await planTask(goal, this.config, this.knowledge)));
    const guidedGoal = guideGoal(goal, plan, this.knowledge);
    const history: Record<string, unknown>[] = [];
    const result = emptyCase({ id: caseId, name: goal.slice(0, 80) || caseId, source: "auto", goal, plan });
    const opening = this.session.url && this.session.url !== "about:blank" ? this.session.observe() : this.session.goto(url);
    let page = await opening;
    const started = Date.now();
    let unchanged = 0;
    let sameContentSkips = 0;
    let emptyFieldSkips = 0;
    let staleRetries = 0;
    let waitRetries = 0;
    let status = "pass";
    let error: string | undefined;
    result.steps.push(
      await this.record(caseId, 1, "open", page, {
        value: page.url,
        durationMs: this.session.lastObserveMs,
        observeMs: this.session.lastObserveMs,
        observed: controlSnapshot(page),
      }),
    );
    hooks.onStep?.(result);
    for (let stepIndex = 2; stepIndex <= this.config.maxSteps; stepIndex += 1) {
      const key = contentKey(page);
      if (this.predictedContent === key) {
        sameContentSkips += 1;
        if (sameContentSkips >= 3) {
          if (await this.passIfDoneVisible(caseId, stepIndex, page, result, hooks)) {
            status = "pass";
            error = undefined;
            break;
          }
          status = "blocked";
          error = "page did not change after 3 actions";
          break;
        }
        await settle(this.session);
        page = await this.session.observe();
        continue;
      }
      sameContentSkips = 0;
      this.predictedContent = key;
      const stepStarted = performance.now();
      const observeMs = this.session.lastObserveMs;
      const observed = controlSnapshot(page);
      let decision: Decision | undefined;
      let modelMs: number | undefined;
      const decideStarted = performance.now();
      try {
        ({ decision } = await decide(page, guidedGoal, history, this.provider));
        modelMs = decision.modelMs ?? (decision.model ? elapsedMs(decideStarted) : undefined);
      } catch (err) {
        status = "fail";
        error = err instanceof Error ? err.message : String(err);
        result.steps.push(
          await this.record(caseId, stepIndex, "decide", page, {
            status: "fail",
            error,
            durationMs: elapsedMs(stepStarted),
            observeMs,
            observed,
            modelMs: elapsedMs(decideStarted),
            model: decisionModelLabel(this.config),
          }),
        );
        hooks.onStep?.(result);
        break;
      }
      if (!decision) break;
      const model = decision.model ?? decisionModelLabel(this.config);
      const modelUsage = decision.modelUsage ?? undefined;
      if (decision.operation === "DONE") {
        const doneWhen = result.plan?.doneWhen;
        const checked = doneWhen ? await this.checkDone(page, doneWhen) : { met: true };
        const met = checked.met;
        if (!met) {
          status = "fail";
          error = `done condition is not visible: ${doneWhen}`;
        }
        result.steps.push(
          await this.record(caseId, stepIndex, "done", page, {
            decision,
            status: met ? "pass" : "fail",
            error: met ? undefined : error,
            durationMs: elapsedMs(stepStarted),
            observeMs,
            observed,
            modelMs,
            model,
            modelUsage,
            confirmMs: checked.modelMs,
            confirmModel: checked.model,
            confirmUsage: checked.modelUsage,
          }),
        );
        hooks.onStep?.(result);
        break;
      }
      if (decision.operation === "BLOCKED") {
        status = "blocked";
        error = decision.reason ?? "blocked";
        result.steps.push(
          await this.record(caseId, stepIndex, "blocked", page, {
            decision,
            status: "blocked",
            error,
            durationMs: elapsedMs(stepStarted),
            observeMs,
            observed,
            modelMs,
            model,
            modelUsage,
          }),
        );
        hooks.onStep?.(result);
        break;
      }
      try {
        const acted = await this.act(page, goal, decision, history);
        if (acted.skippedEmpty) {
          history.push(acted.item);
          emptyFieldSkips += 1;
          result.steps.push(
            await this.record(caseId, stepIndex, "type", page, {
              decision,
              status: "skip",
              error: "no text for this field",
              durationMs: elapsedMs(stepStarted),
              observeMs,
              observed,
              modelMs,
              model,
              modelUsage,
            }),
          );
          hooks.onStep?.(result);
          if (emptyFieldSkips >= 3) {
            status = "fail";
            error = "Text model returned no field value; nothing typed";
            break;
          }
          page = await this.session.observe();
          this.predictedContent = "";
          continue;
        }
        emptyFieldSkips = 0;
        page = acted.page;
        history.push(acted.item);
        result.steps.push(
          await this.record(caseId, stepIndex, String(acted.item.op), page, {
            decision,
            value: acted.item.text as string | undefined,
            matched: acted.item.matched as Record<string, unknown> | undefined,
            durationMs: elapsedMs(stepStarted),
            observeMs,
            observed,
            modelMs,
            textMs: acted.textMs,
            textModel: acted.textModel,
            textUsage: acted.textUsage,
            textThought: acted.textThought,
            actMs: acted.actMs,
            observeAfterMs: acted.observeAfterMs,
            screenshotBuffer: acted.screenshotBuffer,
            screenshotMs: acted.screenshotMs,
            screenshotIncluded: this.writer.screenshots,
            model,
            modelUsage,
          }),
        );
        hooks.onStep?.(result);
        const actedStep = result.steps.at(-1);
        if (actedStep?.status === "fail") error = actedStep.error ?? "action had no visible effect";
        else if (actedStep?.status === "pass") error = undefined;
        if (acted.item.op === "wait") {
          waitRetries += 1;
          if (waitRetries >= 3) {
            if (await this.passIfDoneVisible(caseId, stepIndex, page, result, hooks)) {
              status = "pass";
              error = undefined;
              break;
            }
            status = "blocked";
            error = "stopped after 3 waits";
            break;
          }
        } else {
          waitRetries = 0;
        }
        staleRetries = 0;
        if (acted.item.page_changed === false && acted.item.op !== "wait") unchanged += 1;
        else unchanged = 0;
        if (unchanged >= 3) {
          if (await this.passIfDoneVisible(caseId, stepIndex, page, result, hooks)) {
            status = "pass";
            error = undefined;
            break;
          }
          status = "blocked";
          error = "page did not change after 3 actions";
          break;
        }
      } catch (err) {
        if (err instanceof StalePage) {
          page = await this.session.observe();
          result.steps.push(
            await this.record(caseId, stepIndex, "stale", page, {
              decision,
              status: "skip",
              error: "stale page, observed again",
              durationMs: elapsedMs(stepStarted),
              observeMs,
              observed,
              modelMs,
              model,
              modelUsage,
            }),
          );
          hooks.onStep?.(result);
          staleRetries += 1;
          if (staleRetries >= 3) {
            status = "blocked";
            error = "stopped after 3 retries";
            break;
          }
          continue;
        }
        status = "fail";
        error = err instanceof Error ? err.message : String(err);
        result.steps.push(
          await this.record(caseId, stepIndex, decision.operation.toLowerCase(), page, {
            decision,
            status: "fail",
            error,
            durationMs: elapsedMs(stepStarted),
            observeMs,
            observed,
            modelMs,
            model,
            modelUsage,
          }),
        );
        hooks.onStep?.(result);
        break;
      }
      if (stepIndex === this.config.maxSteps) {
        status = "blocked";
        error = `stopped at ${this.config.maxSteps} steps`;
      }
    }
    if (status === "pass" && !result.steps.some((step) => step.op === "done") && result.steps.length >= this.config.maxSteps) {
      status = "blocked";
      error = `stopped at ${this.config.maxSteps} steps`;
    }
    result.status = status;
    result.error = error;
    result.durationMs = Date.now() - started;
    return { result, history };
  }

  private async passIfDoneVisible(
    caseId: string,
    stepIndex: number,
    page: PageState,
    result: CaseResult,
    hooks: { onStep?: (result: CaseResult) => void },
  ): Promise<boolean> {
    const doneWhen = result.plan?.doneWhen;
    if (!doneWhen) return false;
    let checked: { met: boolean; model?: string; modelMs?: number; modelUsage?: ModelUsage };
    try {
      checked = await this.checkDone(page, doneWhen);
      if (!checked.met) return false;
    } catch {
      return false;
    }
    result.steps.push(
      await this.record(caseId, stepIndex, "done", page, {
        status: "pass",
        observeMs: this.session.lastObserveMs,
        observed: controlSnapshot(page),
        confirmMs: checked.modelMs,
        confirmModel: checked.model,
        confirmUsage: checked.modelUsage,
      }),
    );
    hooks.onStep?.(result);
    return true;
  }

  private async checkDone(
    page: PageState,
    doneWhen: string,
  ): Promise<{ met: boolean; model?: string; modelMs?: number; modelUsage?: ModelUsage }> {
    if (this.config.model.typesafeApiKey) return jevConfirmDone(this.config, page, doneWhen);
    const started = performance.now();
    const met = await confirmDone(page, doneWhen, this.config);
    return { met, model: this.config.model.model, modelMs: elapsedMs(started) };
  }

  private async act(page: PageState, goal: string, decision: Decision, history: Record<string, unknown>[] = []) {
    const beforeKey = contentKey(page);
    const space = buildSpace(page);
    const { element, optionValue } = resolveDecision(space, decision);
    const kind =
      {
        CLICK: "click",
        TYPE: "type",
        SELECT: "select",
        SCROLL_UP: "scroll",
        SCROLL_DOWN: "scroll",
        WAIT: "wait",
      }[decision.operation] ?? "";
    let text: string | undefined;
    let textMs: number | undefined;
    let textModel: string | undefined;
    let textUsage: ModelUsage | undefined;
    let textThought: string | undefined;
    if (kind === "type" && element) {
      const context = {
        goal,
        field: { role: element.role, name: element.name, value: publicValue(element.name, element.value), nearby: element.nearby },
        other_fields: page.elements
          .filter((item) => item.operations.includes("TYPE"))
          .slice(0, 12)
          .map((item) => ({ name: item.name, value: publicValue(item.name, item.value) })),
        recent_actions: history.slice(-6).map((item) => ({
          op: item.op,
          action: item.action,
          text: isSecretControl((item.matched as { name?: string } | undefined)?.name) ? undefined : item.text,
        })),
        page: { title: page.title, url: page.url },
        ...(this.knowledge ? { knowledge: this.knowledge } : {}),
      };
      const key = JSON.stringify(context);
      if (this.pendingText?.context === key) {
        text = this.pendingText.text;
        ({ textMs, textModel, textUsage, textThought } = readTextHelper(this.pendingText.helper));
      } else if (decision.text) {
        text = decision.text;
        textMs = 0;
        textModel = "decision";
      } else {
        const fromGoal = searchQueryFromGoal(goal, element);
        if (fromGoal) {
          text = fromGoal;
          textMs = 0;
          textModel = "goal";
        }
      }
      if (kind === "type" && element && text == null) {
        return {
          page,
          skippedEmpty: true,
          item: {
            op: "type",
            action: elementLabel(element),
            text: "",
            page_changed: false,
            matched: asCandidate(element),
            operation: decision.operation,
          },
        };
      }
    }
    const opts = {
      text,
      optionValue,
      delta: decision.operation === "SCROLL_UP" ? -600 : decision.operation === "SCROLL_DOWN" ? 600 : 0,
    };
    const actStarted = performance.now();
    let target = element;
    try {
      await execute(this.session, page, target, kind, opts);
    } catch (err) {
      if (!(err instanceof StalePage) || !target) throw err;
      const missed = target;
      page = await this.session.observe();
      const rebound =
        resolveDecision(applyHistoryGuards(buildSpace(page), history), decision).element ??
        page.elements.find((item) => item.role === missed.role && item.name === missed.name);
      if (!rebound) throw err;
      target = rebound;
      await execute(this.session, page, target, kind, opts);
    }
    const actMs = elapsedMs(actStarted);
    const next = await this.session.observe();
    const shot = this.writer.screenshots
      ? await timedScreenshot(this.session, target ? { node: target.node, label: actionMarkLabel(target) } : undefined)
      : undefined;
    return {
      page: next,
      skippedEmpty: false,
      textMs,
      textModel,
      textUsage,
      textThought,
      actMs,
      observeAfterMs: this.session.lastObserveMs,
      screenshotBuffer: shot?.buffer,
      screenshotMs: shot?.ms,
      item: {
        op:
          decision.operation === "SCROLL_UP"
            ? "scroll_up"
            : decision.operation === "SCROLL_DOWN"
              ? "scroll_down"
              : kind,
        action: element ? elementLabel(element) : decision.operation,
        text,
        page_changed: contentKey(next) !== beforeKey,
        matched: element ? asCandidate(element) : undefined,
        operation: decision.operation,
      },
    };
  }

  private async record(
    caseId: string,
    index: number,
    op: string,
    page: PageState,
    extra: {
      decision?: Decision;
      value?: string;
      matched?: Record<string, unknown>;
      status?: string;
      error?: string;
      durationMs?: number;
      observeMs?: number;
      observed?: ControlSnapshot;
      modelMs?: number;
      textMs?: number;
      textModel?: string;
      textUsage?: ModelUsage;
      textThought?: string;
      actMs?: number;
      observeAfterMs?: number;
      screenshotMs?: number;
      screenshotBuffer?: Buffer;
      screenshotIncluded?: boolean;
      model?: string;
      modelUsage?: ModelUsage;
      confirmMs?: number;
      confirmModel?: string;
      confirmUsage?: ModelUsage;
    } = {},
  ): Promise<StepResult> {
    let screenshot: string | undefined;
    let screenshotMs = extra.screenshotMs;
    if (extra.screenshotIncluded) {
      if (extra.screenshotBuffer) {
        try {
          screenshot = this.writer.saveScreenshot(caseId, index, op, extra.screenshotBuffer);
        } catch {
          screenshot = undefined;
        }
      }
    } else if (this.writer.screenshots) {
      const shotStarted = performance.now();
      try {
        screenshot = this.writer.saveScreenshot(caseId, index, op, await this.session.screenshot());
      } catch {
        screenshot = undefined;
      }
      screenshotMs = elapsedMs(shotStarted);
    }
    const shouldAssert = extra.observeAfterMs != null && (extra.status ?? "pass") === "pass";
    const judged =
      shouldAssert && this.provider instanceof JevProvider
        ? await jevAssert(this.config, {
            op,
            value: extra.value,
            before: extra.observed,
            after: page,
          }).catch(() => undefined)
        : undefined;
    const verdict =
      judged?.verdict ??
      (shouldAssert
        ? assessActionEffect({
            op,
            value: extra.value,
            before: extra.observed,
            after: page,
          })
        : undefined);
    const failedEffect = (extra.status ?? "pass") === "pass" && verdict === "fail";
    return {
      index,
      op,
      status: failedEffect ? "fail" : (extra.status ?? "pass"),
      target: extra.decision ? selectedIndex(extra.decision) : undefined,
      value: extra.value,
      url: page.url,
      title: page.title,
      matched: extra.matched,
      error: failedEffect ? "action had no visible effect" : extra.error,
      screenshot,
      durationMs: (extra.durationMs ?? 0) + (extra.screenshotIncluded ? 0 : (screenshotMs ?? 0)),
      observeMs: extra.observeMs,
      observed: extra.observed,
      observeAfterMs: extra.observeAfterMs,
      modelMs: extra.modelMs,
      textMs: extra.textMs,
      textModel: extra.textModel,
      textUsage: extra.textUsage,
      actMs: extra.actMs,
      screenshotMs,
      model: extra.model ?? extra.decision?.model ?? undefined,
      modelUsage: extra.modelUsage ?? extra.decision?.modelUsage ?? undefined,
      modelInput: extra.decision?.input?.trim() || undefined,
      modelReply: extra.decision?.reply?.trim() || undefined,
      modelThought: extra.decision?.thought?.trim() || undefined,
      textThought: extra.textThought,
      assertVerdict: verdict,
      assertMs: judged?.modelMs,
      assertModel: judged?.model,
      assertUsage: judged?.modelUsage,
      assertInput: judged?.input,
      assertReply: judged?.reply,
      assertThought: judged?.thought,
      confirmMs: extra.confirmMs,
      confirmModel: extra.confirmModel,
      confirmUsage: extra.confirmUsage,
    };
  }
}

export async function timedScreenshot(
  session: BrowserSession,
  mark?: { node: number; label: string },
): Promise<{ buffer?: Buffer; ms: number }> {
  const started = performance.now();
  try {
    return { buffer: await session.screenshot(mark), ms: elapsedMs(started) };
  } catch {
    return { ms: elapsedMs(started) };
  }
}

export function readTextHelper(helper: Record<string, unknown> | undefined): {
  textMs?: number;
  textModel?: string;
  textUsage?: ModelUsage;
  textThought?: string;
} {
  if (!helper) return {};
  const usage = helper.modelUsage as ModelUsage | undefined;
  const hasUsage = usage && (usage.inputTokens != null || usage.outputTokens != null || usage.totalTokens != null);
  return {
    textMs: typeof helper.modelMs === "number" ? helper.modelMs : undefined,
    textModel: typeof helper.model === "string" ? helper.model : undefined,
    textUsage: hasUsage ? usage : undefined,
    textThought: typeof helper.thought === "string" && helper.thought.trim() ? helper.thought.trim() : undefined,
  };
}

export { DecisionError };
