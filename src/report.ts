import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CaseResult, ModelUsage, StepResult, SuiteReport, TaskPlan } from "./types.js";
import { escapeHtml, isoformat, slug, utcNow } from "./util.js";

const TEMPLATE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "report/template.html"), "utf8");

export function emptyCase(partial: Partial<CaseResult> & Pick<CaseResult, "id" | "name">): CaseResult {
  return {
    source: "",
    status: "pass",
    durationMs: 0,
    steps: [],
    ...partial,
  };
}

export function emptyReport(partial: Partial<SuiteReport> & Pick<SuiteReport, "runId" | "mode" | "name" | "startedAt">): SuiteReport {
  return {
    finishedAt: "",
    durationMs: 0,
    browser: "chromium",
    viewport: "1120x780",
    path: "",
    cases: [],
    ...partial,
  };
}

export function totals(report: SuiteReport): Record<string, number> {
  const counts = { pass: 0, fail: 0, skip: 0, blocked: 0 };
  for (const item of report.cases) {
    const key = item.status as keyof typeof counts;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function failedCount(report: SuiteReport): number {
  const t = totals(report);
  return (t.fail ?? 0) + (t.blocked ?? 0);
}

export function passRate(report: SuiteReport): number {
  return report.cases.length ? ((totals(report).pass ?? 0) / report.cases.length) * 100 : 0;
}

export function finishReport(report: SuiteReport): void {
  const now = utcNow();
  report.finishedAt = isoformat(now);
  const started = Date.parse(report.startedAt);
  report.durationMs = Number.isNaN(started)
    ? report.cases.reduce((sum, item) => sum + item.durationMs, 0)
    : now.getTime() - started;
}

export class ReportWriter {
  root: string;
  constructor(
    reportsDir: string,
    runId: string,
    public screenshots = true,
  ) {
    this.root = path.resolve(reportsDir, runId);
    mkdirSync(path.join(this.root, "cases"), { recursive: true });
  }

  saveScreenshot(caseId: string, stepIndex: number, op: string, data: Buffer): string {
    const rel = `cases/${slug(caseId)}/steps/${String(stepIndex).padStart(3, "0")}-${slug(op, "step")}.png`;
    const dest = path.join(this.root, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    return rel;
  }

  saveRecording(source: string, index: number, total: number): string {
    const ext = path.extname(source) || ".mp4";
    const rel = total === 1 ? `recording${ext}` : `recording-${index + 1}${ext}`;
    const dest = path.join(this.root, rel);
    try {
      renameSync(source, dest);
    } catch {
      copyFileSync(source, dest);
      rmSync(source, { force: true });
    }
    return rel;
  }

  saveHttp(caseId: string, stepIndex: number, payload: unknown): string {
    const rel = `cases/${slug(caseId)}/steps/${String(stepIndex).padStart(3, "0")}-http.json`;
    const dest = path.join(this.root, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, JSON.stringify(payload, null, 2));
    return rel;
  }

  write(report: SuiteReport): { html: string; json: string; md: string; root: string } {
    report.path = this.root;
    finishReport(report);
    const jsonPath = path.join(this.root, "report.json");
    const mdPath = path.join(this.root, "report.md");
    const htmlPath = path.join(this.root, "report.html");
    writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    writeFileSync(mdPath, renderMarkdown(report));
    writeFileSync(htmlPath, renderHtml(report));
    for (const item of report.cases) {
      const dest = path.join(this.root, "cases", slug(item.id), "case.json");
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, JSON.stringify(item, null, 2));
    }
    return { html: htmlPath, json: jsonPath, md: mdPath, root: this.root };
  }
}

export function renderMarkdown(report: SuiteReport): string {
  const t = totals(report);
  const lines = [
    `# ${report.name}`,
    "",
    `- run: \`${report.runId}\``,
    `- mode: ${report.mode}`,
    `- duration: ${report.durationMs} ms`,
    `- started: ${formatDateTime(report.startedAt)}`,
    `- finished: ${formatDateTime(report.finishedAt)}`,
    `- cases: ${report.cases.length}  pass=${t.pass ?? 0} fail=${t.fail ?? 0} skip=${t.skip ?? 0} blocked=${t.blocked ?? 0}`,
    `- pass rate: ${passRate(report).toFixed(1)}%`,
    ...markdownTimingLines(report),
    "",
  ];
  const failed = report.cases.filter((item) => item.status === "fail" || item.status === "blocked");
  if (failed.length) {
    lines.push("## Failed");
    for (const item of failed) lines.push(`- ${item.id}: ${item.error || item.status}`);
    lines.push("");
  }
  for (const item of report.cases) {
    lines.push(`## ${item.name} (${item.status})`);
    if (item.source) lines.push(`source: \`${item.source}\``);
    for (const step of item.steps) {
      const mark = { pass: "ok", fail: "FAIL", skip: "skip", blocked: "blocked" }[step.status] ?? step.status;
      const times = formatStepTimes(step);
      lines.push(
        `${step.index}. [${mark}] ${stepTask(step, "en")} · ${times}${step.error ? ` — ${step.error}` : ""}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 56;

export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatClock(iso)}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0 ms";
  if (ms < 1) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) {
    const seconds = ms / 1000;
    const digits = seconds >= 10 ? 1 : 2;
    return `${seconds.toFixed(digits).replace(/\.?0+$/, "")}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

const SYNTHETIC_TEXT_MODELS = new Set(["goal", "override", "decision"]);

export type ReportLang = "en" | "zh";

const COPY = {
  en: {
    total: "Total",
    observe: "Page elements",
    fill: "Fill",
    act: "Act",
    observeAfter: "Assert",
    screenshot: "Screenshot",
    input: "in",
    output: "out",
    tokens: "tokens",
    doneCheck: "Done check",
    fromGoal: "from goal",
    override: "given text",
    decision: "from decision",
    model: "Model",
  },
  zh: {
    total: "总",
    observe: "获取页面元素",
    fill: "填字",
    act: "执行",
    observeAfter: "Jev 断言",
    screenshot: "截图",
    input: "输入",
    output: "输出",
    tokens: "token",
    doneCheck: "结束确认",
    fromGoal: "从目标读取",
    override: "指定文案",
    decision: "决策已给出",
    model: "模型",
  },
} as const;

export function formatStepTimes(step: StepResult, lang: ReportLang = "en"): string {
  const copy = COPY[lang];
  const parts = [`${copy.total} ${formatDuration(step.durationMs)}`];
  if (typeof step.observeMs === "number") parts.push(`${copy.observe} ${formatDuration(step.observeMs)}`);
  if (typeof step.modelMs === "number" || hasUsage(step.modelUsage)) {
    parts.push(formatModelSpend(step.model, step.modelMs ?? 0, step.modelUsage, lang));
  }
  if (typeof step.confirmMs === "number" || hasUsage(step.confirmUsage)) {
    parts.push(`${copy.doneCheck} ${formatModelSpend(step.confirmModel, step.confirmMs ?? 0, step.confirmUsage, lang)}`);
  }
  if (isModelCall(step.textModel) && (typeof step.textMs === "number" || hasUsage(step.textUsage))) {
    parts.push(formatModelSpend(step.textModel, step.textMs ?? 0, step.textUsage, lang));
  } else if (typeof step.textMs === "number") {
    parts.push(`${copy.fill} ${formatDuration(step.textMs)}${fillNote(step.textModel, lang)}${formatTokenUsage(step.textUsage, lang)}`);
  }
  if (typeof step.actMs === "number") parts.push(`${copy.act} ${formatDuration(step.actMs)}`);
  if (typeof step.observeAfterMs === "number") parts.push(`${copy.observeAfter} ${formatDuration(step.observeAfterMs)}`);
  if (typeof step.screenshotMs === "number") parts.push(`${copy.screenshot} ${formatDuration(step.screenshotMs)}`);
  return parts.join(" · ");
}

export function modelConsumeLabel(model?: string | null, lang: ReportLang = "en"): string {
  const head = (model ?? "").trim().split(/[^A-Za-z]+/).find(Boolean);
  if (!head) return COPY[lang].model;
  return head.charAt(0).toUpperCase() + head.slice(1).toLowerCase();
}

function isModelCall(model?: string): boolean {
  const name = model?.trim();
  return Boolean(name) && !SYNTHETIC_TEXT_MODELS.has(name!);
}

function hasUsage(usage?: ModelUsage): boolean {
  return Boolean(usage && (usage.inputTokens != null || usage.outputTokens != null || usage.totalTokens != null));
}

function formatModelSpend(model: string | undefined, ms: number, usage: ModelUsage | undefined, lang: ReportLang): string {
  return `${modelConsumeLabel(model, lang)} ${formatDuration(ms)}${formatTokenUsage(usage, lang)}`;
}

function tokenNote(usage: ModelUsage | undefined, lang: ReportLang): string {
  if (!usage) return "";
  const copy = COPY[lang];
  const lines: string[] = [];
  if (usage.inputTokens != null) lines.push(`${copy.input} ${formatTokenCount(usage.inputTokens)}`);
  if (usage.outputTokens != null) lines.push(`${copy.output} ${formatTokenCount(usage.outputTokens)}`);
  if (!lines.length && usage.totalTokens != null) lines.push(`${formatTokenCount(usage.totalTokens)} ${copy.tokens}`);
  return lines.join("\n");
}

function phaseChip(
  labelEn: string,
  labelZh: string,
  value: string,
  noteEn = "",
  noteZh = "",
  kind = "",
  detailEn = "",
  detailZh = "",
): string {
  const enLines = noteEn ? noteEn.split("\n") : [];
  const zhLines = noteZh ? noteZh.split("\n") : [];
  const count = Math.max(enLines.length, zhLines.length);
  const rows = Array.from({ length: count }, (_, index) => {
    const en = enLines[index] ?? "";
    const zh = zhLines[index] ?? "";
    return `<span ${bilingual(en, zh)}>${escapeHtml(en)}</span>`;
  });
  const detail = detailEn
    ? ` data-detail-en="${attrMultiline(detailEn)}" data-detail-zh="${attrMultiline(detailZh)}" role="button" tabindex="0"`
    : "";
  const cls = `${kind ? `phase ${kind}` : "phase"}${detailEn ? " can-open" : ""}`;
  return `<span class="${cls}"${detail}><em ${bilingual(labelEn, labelZh)}>${escapeHtml(labelEn)}</em><b>${escapeHtml(value)}</b><small>${rows.join("")}</small></span>`;
}

function attrMultiline(text: string): string {
  return escapeHtml(text).replaceAll("\n", "&#10;");
}

function modelDetail(
  input: string | undefined,
  reply: string | undefined,
  thought: string | undefined,
  lang: ReportLang,
): string {
  const sections: [string, string | undefined][] = [
    [lang === "zh" ? "输入" : "Input", input],
    [lang === "zh" ? "回复" : "Reply", reply],
    [lang === "zh" ? "思考" : "Thinking", thought],
  ];
  const lines: string[] = [];
  for (const [label, value] of sections) {
    const text = value?.trim();
    if (!text) continue;
    lines.push(label, text);
  }
  return lines.join("\n");
}

function stepTimesHtml(step: StepResult): string {
  const copy = COPY;
  const chips = [];
  if (typeof step.observeMs === "number") {
    chips.push(
      phaseChip(
        copy.en.observe,
        copy.zh.observe,
        formatDuration(step.observeMs),
        "",
        "",
        "capture",
        observeDetail(step, "en"),
        observeDetail(step, "zh"),
      ),
    );
  }
  if (typeof step.modelMs === "number" || hasUsage(step.modelUsage)) {
    const label = modelConsumeLabel(step.model, "en");
    chips.push(
      phaseChip(
        "Decide",
        `${label} 决策`,
        formatDuration(step.modelMs ?? 0),
        tokenNote(step.modelUsage, "en"),
        tokenNote(step.modelUsage, "zh"),
        "model",
        modelDetail(step.modelInput, step.modelReply, step.modelThought, "en"),
        modelDetail(step.modelInput, step.modelReply, step.modelThought, "zh"),
      ),
    );
  }
  if (typeof step.confirmMs === "number" || hasUsage(step.confirmUsage)) {
    const label = modelConsumeLabel(step.confirmModel, "en");
    chips.push(
      phaseChip(
        copy.en.doneCheck,
        copy.zh.doneCheck,
        formatDuration(step.confirmMs ?? 0),
        [label, tokenNote(step.confirmUsage, "en")].filter(Boolean).join(" · "),
        [modelConsumeLabel(step.confirmModel, "zh"), tokenNote(step.confirmUsage, "zh")].filter(Boolean).join(" · "),
        "model",
      ),
    );
  }
  if (isModelCall(step.textModel) && (typeof step.textMs === "number" || hasUsage(step.textUsage))) {
    const label = modelConsumeLabel(step.textModel, "en");
    chips.push(
      phaseChip(
        label,
        label,
        formatDuration(step.textMs ?? 0),
        tokenNote(step.textUsage, "en"),
        tokenNote(step.textUsage, "zh"),
        "model",
        modelDetail(undefined, undefined, step.textThought, "en"),
        modelDetail(undefined, undefined, step.textThought, "zh"),
      ),
    );
  } else if (typeof step.textMs === "number") {
    const noteEn = [fillNote(step.textModel, "en").replace(/^ · /, ""), tokenNote(step.textUsage, "en")].filter(Boolean).join(" · ");
    const noteZh = [fillNote(step.textModel, "zh").replace(/^ · /, ""), tokenNote(step.textUsage, "zh")].filter(Boolean).join(" · ");
    chips.push(phaseChip(copy.en.fill, copy.zh.fill, formatDuration(step.textMs), noteEn, noteZh));
  }
  if (typeof step.actMs === "number") {
    const actionEn = stepTask(step, "en");
    const actionZh = stepTask(step, "zh");
    chips.push(
      phaseChip(
        copy.en.act,
        copy.zh.act,
        formatDuration(step.actMs),
        actionEn,
        actionZh,
        "act",
        `${langLabel("Action", "动作", "en")}\n${actionEn}`,
        `${langLabel("Action", "动作", "zh")}\n${actionZh}`,
      ),
    );
  }
  if (typeof step.observeAfterMs === "number" || step.assertVerdict) {
    const verdict = assertVerdictLabel(step.assertVerdict);
    chips.push(
      phaseChip(
        copy.en.observeAfter,
        copy.zh.observeAfter,
        formatDuration(step.observeAfterMs ?? 0),
        verdict.en,
        verdict.zh,
        "",
        assertDetail(step, "en"),
        assertDetail(step, "zh"),
      ),
    );
  }
  if (typeof step.screenshotMs === "number") chips.push(phaseChip(copy.en.screenshot, copy.zh.screenshot, formatDuration(step.screenshotMs)));
  return `<div class="times">${chips.join("")}</div><div class="card-detail" hidden></div>`;
}

function assertVerdictLabel(verdict: StepResult["assertVerdict"]): { en: string; zh: string } {
  if (verdict === "pass") return { en: "As expected", zh: "符合预期" };
  if (verdict === "fail") return { en: "Not as expected", zh: "不符合预期" };
  return { en: "", zh: "" };
}

function assertDetail(step: StepResult, lang: ReportLang): string {
  if (!step.assertVerdict) return "";
  const verdict = assertVerdictLabel(step.assertVerdict);
  const lines = [lang === "zh" ? verdict.zh : verdict.en];
  if (step.assertReply) lines.push(step.assertReply);
  if ((step.op === "type" || step.op === "select") && step.value) {
    lines.push(lang === "zh" ? `预期：页面出现「${step.value}」` : `Expected “${step.value}” to appear`);
  } else if (step.op === "click") {
    lines.push(lang === "zh" ? "预期：点击后页面发生变化" : "Expected the page to change after the click");
  } else if (step.op === "scroll_up" || step.op === "scroll_down") {
    lines.push(lang === "zh" ? "预期：页面位置发生变化" : "Expected the page to move");
  } else if (step.op === "wait") {
    lines.push(lang === "zh" ? "预期：等待结束" : "Expected the wait to finish");
  }
  const before = step.observed?.title?.trim();
  const after = step.title?.trim();
  if (before || after) {
    lines.push(lang === "zh" ? `实际：${before || "—"} → ${after || "—"}` : `Actual: ${before || "—"} → ${after || "—"}`);
  }
  return lines.join("\n");
}

function observeDetail(step: StepResult, lang: ReportLang): string {
  const shot = step.observed;
  if (!shot) return "";
  const lines: string[] = [];
  if (shot.url) lines.push(shot.url);
  if (shot.title) lines.push(shot.title);
  const root = lang === "zh" ? "页面" : "Page";
  const unnamed = lang === "zh" ? "(未命名)" : "(unnamed)";
  const groups = new Map<string, typeof shot.elements>();
  for (const item of shot.elements) {
    const key = item.within.trim() || root;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  if (lines.length) lines.push("");
  if (!shot.elements.length) {
    lines.push(lang === "zh" ? "没有可操作控件" : "No controls");
    return lines.join("\n");
  }
  let first = true;
  for (const [group, items] of groups) {
    if (!first) lines.push("");
    first = false;
    lines.push(group);
    for (const item of items) {
      const name = item.name.trim() || unnamed;
      const value = item.value.trim() ? ` = ${item.value.trim()}` : "";
      const ops = item.operations.length ? ` · ${item.operations.join(", ")}` : "";
      lines.push(`  [${item.index}] ${item.role} ${name}${value}${ops}`);
    }
  }
  return lines.join("\n");
}

function langLabel(en: string, zh: string, lang: ReportLang): string {
  return lang === "zh" ? zh : en;
}

export function formatTokenUsage(usage?: ModelUsage, lang: ReportLang = "en"): string {
  if (!usage) return "";
  const copy = COPY[lang];
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  if (input != null && output != null) return ` · ${copy.input} ${formatTokenCount(input)} · ${copy.output} ${formatTokenCount(output)}`;
  if (usage.totalTokens != null) return ` · ${formatTokenCount(usage.totalTokens)} ${copy.tokens}`;
  return "";
}

function formatTokenCount(count: number): string {
  return count.toLocaleString("zh-CN");
}

function fillNote(model: string | undefined, lang: ReportLang): string {
  if (!model) return "";
  const copy = COPY[lang];
  if (model === "goal") return ` · ${copy.fromGoal}`;
  if (model === "override") return ` · ${copy.override}`;
  if (model === "decision") return ` · ${copy.decision}`;
  return ` · ${model}`;
}

export function timingTotals(report: SuiteReport): {
  observeMs: number;
  observeAfterMs: number;
  modelMs: number;
  textMs: number;
  sawFill: boolean;
  textUsage: ModelUsage;
  actMs: number;
  screenshotMs: number;
} {
  let observeMs = 0;
  let observeAfterMs = 0;
  let modelMs = 0;
  let textMs = 0;
  let sawFill = false;
  let actMs = 0;
  let screenshotMs = 0;
  const textUsage: ModelUsage = {};
  for (const item of report.cases) {
    for (const step of item.steps) {
      observeMs += step.observeMs ?? 0;
      observeAfterMs += step.observeAfterMs ?? 0;
      modelMs += step.modelMs ?? 0;
      if (typeof step.textMs === "number") sawFill = true;
      textMs += step.textMs ?? 0;
      actMs += step.actMs ?? 0;
      screenshotMs += step.screenshotMs ?? 0;
      addUsage(textUsage, step.textUsage);
    }
  }
  return { observeMs, observeAfterMs, modelMs, textMs, sawFill, textUsage, actMs, screenshotMs };
}

function addUsage(total: ModelUsage, usage?: ModelUsage): void {
  if (!usage) return;
  if (usage.inputTokens != null) total.inputTokens = (total.inputTokens ?? 0) + usage.inputTokens;
  if (usage.outputTokens != null) total.outputTokens = (total.outputTokens ?? 0) + usage.outputTokens;
  if (usage.totalTokens != null) total.totalTokens = (total.totalTokens ?? 0) + usage.totalTokens;
}

function modelBuckets(report: SuiteReport): { label: string; ms: number; usage: ModelUsage }[] {
  const buckets = new Map<string, { label: string; ms: number; usage: ModelUsage }>();
  const remember = (model: string | undefined, ms?: number, usage?: ModelUsage) => {
    if (!isModelCall(model) || (typeof ms !== "number" && !hasUsage(usage))) return;
    const label = modelConsumeLabel(model);
    const current = buckets.get(label) ?? { label, ms: 0, usage: {} };
    if (typeof ms === "number") current.ms += ms;
    addUsage(current.usage, usage);
    buckets.set(label, current);
  };
  for (const item of report.cases) {
    remember(item.plan?.model, item.plan?.modelMs, item.plan?.modelUsage);
    for (const step of item.steps) {
      remember(step.model, step.modelMs, step.modelUsage);
      remember(step.confirmModel, step.confirmMs, step.confirmUsage);
      remember(step.textModel, step.textMs, step.textUsage);
    }
  }
  return [...buckets.values()];
}

function markdownTimingLines(report: SuiteReport): string[] {
  const timings = timingTotals(report);
  const lines: string[] = [];
  if (timings.observeMs) lines.push(`- observe: ${timings.observeMs} ms`);
  for (const bucket of modelBuckets(report)) {
    lines.push(`- ${bucket.label.toLowerCase()}: ${bucket.ms} ms${formatTokenUsage(bucket.usage, "en")}`);
  }
  if (timings.actMs) lines.push(`- act: ${timings.actMs} ms`);
  if (timings.observeAfterMs) lines.push(`- assert: ${timings.observeAfterMs} ms`);
  if (timings.screenshotMs) lines.push(`- screenshot: ${timings.screenshotMs} ms`);
  for (const file of report.recordings ?? []) lines.push(`- recording: ${file}`);
  return lines;
}

export function renderHtml(report: SuiteReport): string {
  const t = totals(report);
  const rate = passRate(report);
  const chip = suiteChip(report);
  const stepCount = report.cases.reduce((sum, item) => sum + item.steps.length, 0);
  const failCount = (t.fail ?? 0) + (t.blocked ?? 0);
  const cases = report.cases
    .map((item, index) =>
      caseHtml(item, index, item.status === "fail" || item.status === "blocked", report.recordings?.[0]),
    )
    .join("");
  const replacements: Record<string, string> = {
    "{{title}}": escapeHtml(`${report.name} · ${report.runId}`),
    "{{name}}": escapeHtml(report.name),
    "{{run_id}}": escapeHtml(report.runId),
    "{{mode_label}}": escapeHtml(report.mode.toUpperCase()),
    "{{duration_label}}": escapeHtml(formatDuration(report.durationMs)),
    "{{started_label}}": escapeHtml(formatClock(report.startedAt)),
    "{{started_full}}": escapeHtml(formatDateTime(report.startedAt)),
    "{{finished_label}}": escapeHtml(formatClock(report.finishedAt)),
    "{{finished_full}}": escapeHtml(formatDateTime(report.finishedAt)),
    "{{total}}": String(report.cases.length),
    "{{passed}}": String(t.pass ?? 0),
    "{{failed}}": String(failCount),
    "{{failed_class}}": failCount ? "fail" : "",
    "{{steps}}": String(stepCount),
    "{{pass_rate}}": escapeHtml(formatPassRate(rate)),
    "{{ring_offset}}": String(RING_CIRCUMFERENCE * (1 - Math.min(100, Math.max(0, rate)) / 100)),
    "{{chip}}": escapeHtml(chip.label),
    "{{chip_class}}": chip.className,
    "{{chip_icon}}": chip.icon,
    "{{outcome}}": failCount ? "fail" : report.cases.length ? "pass" : "empty",
    "{{browser}}": escapeHtml(formatBrowser(report.browser)),
    "{{viewport}}": escapeHtml(report.viewport || "—"),
    "{{cases}}": cases,
  };
  let html = TEMPLATE;
  for (const key of Object.keys(replacements).sort((a, b) => b.length - a.length)) {
    html = html.replaceAll(key, replacements[key]);
  }
  return html;
}

function bilingual(en: string, zh: string): string {
  return `data-en="${escapeHtml(en)}" data-zh="${escapeHtml(zh)}"`;
}

function formatPassRate(rate: number): string {
  if (!Number.isFinite(rate)) return "0%";
  return `${Number.isInteger(rate) ? String(rate) : rate.toFixed(1)}%`;
}

function formatBrowser(browser: string): string {
  const name = browser?.trim();
  if (!name) return "—";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function sourceLabel(source: string): string {
  if (!source) return "-";
  return source.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? source;
}

function statusLabel(status: string): string {
  return ({ pass: "PASS", fail: "FAIL", skip: "SKIP", blocked: "BLOCKED" }[status] ?? status).toUpperCase();
}

function suiteChip(report: SuiteReport): { label: string; className: string; icon: string } {
  const t = totals(report);
  const failed = (t.fail ?? 0) + (t.blocked ?? 0);
  const check =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M8 12.2 11 15l5-6"/></svg>';
  const cross =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>';
  if (!report.cases.length) return { label: "NO CASES", className: "chip-muted", icon: "" };
  if (failed) return { label: "FAILED", className: "chip-fail", icon: cross };
  if ((t.skip ?? 0) === report.cases.length) return { label: "SKIPPED", className: "chip-skip", icon: "" };
  if ((t.pass ?? 0) === report.cases.length) return { label: "ALL PASSED", className: "chip-pass", icon: check };
  return { label: "PARTIAL", className: "chip-skip", icon: "" };
}

function recordingButton(file?: string): string {
  if (!file) return "";
  return `<button type="button" class="rec-row" data-video="${escapeHtml(file)}"><span ${bilingual("Recording", "录屏")}>录屏</span></button>`;
}

function planHtml(plan?: TaskPlan): string {
  if (!plan?.steps.length) return "";
  const items = plan.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("");
  const doneEn = `Done when: ${plan.doneWhen}`;
  const doneZh = `结束：${plan.doneWhen}`;
  const timing =
    typeof plan.modelMs === "number"
      ? `${modelConsumeLabel(plan.model)} ${formatDuration(plan.modelMs)}${formatTokenUsage(plan.modelUsage)}`
      : "";
  const timingHtml = timing ? `<span class="plan-time">${escapeHtml(timing)}</span>` : "";
  return `<details class="outline">
    <summary>
      <span class="kicker" ${bilingual("Task breakdown", "任务拆解")}>Task breakdown</span>
      ${timingHtml}
      <span class="chevron"></span>
    </summary>
    <ol>${items}</ol>
    <p ${bilingual(doneEn, doneZh)}>${escapeHtml(doneEn)}</p>
  </details>`;
}

function repeatsTitle(name: string, goal?: string): boolean {
  const title = name.trim();
  const text = goal?.trim() ?? "";
  if (!title || !text) return false;
  return text === title || text.startsWith(title) || title.startsWith(text);
}

function caseHtml(item: CaseResult, index: number, open: boolean, recording?: string): string {
  const source = sourceLabel(item.source);
  const goal = item.goal && !repeatsTitle(item.name, item.goal)
    ? `<div class="goal"><span ${bilingual("Goal: ", "目标：")}>Goal: </span>${escapeHtml(item.goal)}</div>`
    : "";
  const heading = item.goal && repeatsTitle(item.name, item.goal) ? item.goal : item.name;
  const plan = planHtml(item.plan);
  const rows = item.steps.map(stepRow).join("");
  const stepCountEn = `${item.steps.length} steps`;
  const stepCountZh = `${item.steps.length} 步`;
  return `
    <details class="case status-${escapeHtml(item.status)}"${open ? " open" : ""}>
      <summary>
        <span class="case-no">${String(index + 1).padStart(2, "0")}</span>
        <span class="grow">
          <h3 title="${escapeHtml(heading)}">${escapeHtml(item.name)}</h3>
          <small title="${escapeHtml(item.source || item.id)}">${escapeHtml(source)} · <span ${bilingual(stepCountEn, stepCountZh)}>${escapeHtml(stepCountEn)}</span></small>
        </span>
        ${recordingButton(recording)}
        <span class="pill ${escapeHtml(item.status)}">${escapeHtml(statusLabel(item.status))}</span>
        <span class="time">${escapeHtml(formatDuration(item.durationMs))}</span>
        <span class="chevron"></span>
      </summary>
      <div class="body">
        ${goal}
        ${plan}
        <div class="steps">${rows || `<div class="goal" ${bilingual("No steps", "没有步骤")}>No steps</div>`}</div>
      </div>
    </details>`;
}

function stepRow(step: StepResult): string {
  const shot = shotCard(step);
  const taskEn = stepTask(step, "en");
  const taskZh = stepTask(step, "zh");
  const http = step.http
    ? `<div class="http">${escapeHtml(String(step.http.method ?? ""))} ${escapeHtml(String(step.http.status ?? ""))} ${escapeHtml(String(step.http.url ?? ""))}</div>`
    : "";
  const err = step.error ? `<div class="err">${escapeHtml(step.error)}</div>` : "";
  const open = step.status === "fail" || step.status === "blocked";
  return `<details class="step-row${shot ? "" : " no-shot"}"${open ? " open" : ""}>
    <summary class="t-item ${escapeHtml(step.status)}">
      <span class="grow">
        <b>${String(step.index).padStart(2, "0")} ${escapeHtml(step.op.toUpperCase())}</b>
        <p ${bilingual(taskEn, taskZh)}>${escapeHtml(taskEn)}</p>
      </span>
      <span class="time">${escapeHtml(formatDuration(step.durationMs))}</span>
      <span class="chevron"></span>
    </summary>
    <div class="step-body">
      ${stepTimesHtml(step)}
      ${shot}
      ${http}${err}
    </div>
  </details>`;
}

function stepTask(step: StepResult, lang: ReportLang): string {
  const name = typeof step.matched?.name === "string" ? step.matched.name.trim() : "";
  const value = step.value?.trim() ?? "";
  const named = name ? quoteTask(name, lang) : "";
  const valued = value ? quoteTask(value, lang) : "";
  if (step.op === "type") {
    if (lang === "zh") {
      if (named && valued) return `在${named}输入${valued}`;
      if (valued) return `输入${valued}`;
      if (named) return `在${named}输入`;
    } else {
      if (named && valued) return `Type ${valued} into ${named}`;
      if (valued) return `Type ${valued}`;
      if (named) return `Type into ${named}`;
    }
  }
  if (step.op === "click") {
    if (lang === "zh") return named ? `点击${named}` : "点击";
    return named ? `Click ${named}` : "Click";
  }
  if (step.op === "select") {
    if (lang === "zh") {
      if (named && valued) return `在${named}选择${valued}`;
      return valued ? `选择${valued}` : "选择";
    }
    if (named && valued) return `Select ${valued} in ${named}`;
    return valued ? `Select ${valued}` : "Select";
  }
  if (step.op === "wait") return lang === "zh" ? "等待页面" : "Wait for the page";
  if (step.op === "open") {
    const target = step.url || step.value || "";
    return lang === "zh" ? `打开 ${target}` : `Open ${target}`;
  }
  if (step.op === "done") return lang === "zh" ? "完成" : "Done";
  if (step.op === "scroll_up") return lang === "zh" ? "向上滚动" : "Scroll up";
  if (step.op === "scroll_down" || step.op === "scroll") return lang === "zh" ? "向下滚动" : "Scroll down";
  if (step.op === "stale") return lang === "zh" ? "页面变了，重新识别" : "Page changed, observe again";
  if (step.op === "blocked") return lang === "zh" ? "无法继续" : "Blocked";
  return stepDetail(step);
}

function quoteTask(text: string, lang: ReportLang): string {
  return lang === "zh" ? `「${text}」` : `“${text}”`;
}

function stepDetail(step: StepResult): string {
  if (step.target) return step.target;
  if (step.expected && typeof step.expected === "object") {
    const expected = step.expected;
    const parts: string[] = [];
    if (expected.url_includes || expected.url_equals) parts.push("url");
    if (expected.title_includes) parts.push("title");
    if (expected.visible_text) parts.push(String(expected.visible_text));
    if (expected.hidden_text) parts.push("hidden");
    if (parts.length) return parts.join(" / ");
  }
  if (step.http) return `${String(step.http.method ?? "HTTP")} ${String(step.http.status ?? "")}`.trim();
  return step.op;
}

function shotCard(step: StepResult): string {
  if (!step.screenshot) return "";
  const label = `${String(step.index).padStart(2, "0")} ${step.op.toUpperCase()}`;
  const captionEn = `${label} · ${stepTask(step, "en")}`;
  const captionZh = `${label} · ${stepTask(step, "zh")}`;
  return `<div class="shot">
    <img class="shot" src="${escapeHtml(step.screenshot)}" alt="${escapeHtml(captionEn)}">
    <i ${bilingual(captionEn, captionZh)}>${escapeHtml(captionEn)}</i>
  </div>`;
}
