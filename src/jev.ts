import { DecisionError } from "./errors.js";
import { modelFetch } from "./model-http.js";
import { elapsedMs, isSecretControl, parseModelUsage, publicValue } from "./util.js";
import {
  NEXT_ACTION,
  OpenAIProvider,
  ScriptedProvider,
  TARGET,
  typeCandidates,
  bindNamedTargets,
  packForModel,
  parseDecision,
  validateDecision,
  type ActionSpace,
  type DecisionProvider,
} from "./policy.js";
import type { ControlSnapshot, Decision, ModelUsage, PageState, PilotConfig } from "./types.js";

export function decisionModelLabel(config: PilotConfig): string {
  if (config.model.typesafeApiKey) return config.model.typesafeModel || "jev-latest";
  return config.model.model;
}

export function createDecisionProvider(
  config: PilotConfig,
  script?: Record<string, unknown>[],
): DecisionProvider {
  if (script?.length) return new ScriptedProvider(script);
  if (config.model.typesafeApiKey) return new JevProvider(config);
  return new OpenAIProvider(config);
}

export class JevProvider implements DecisionProvider {
  constructor(private config: PilotConfig) {
    if (!config.model.typesafeApiKey) {
      throw new DecisionError("TYPESAFE_API_KEY is required for Jev / TypeSafe decisions.");
    }
  }

  async choose(
    page: { url: string; title: string },
    goal: string,
    history: Record<string, unknown>[],
    space: ActionSpace,
  ): Promise<Decision> {
    const started = performance.now();
    const body = buildJevRequest(this.config, page, goal, history, space);
    const response = await modelFetch(`${this.config.model.typesafeBaseUrl.replace(/\/$/, "")}/systemone`, {
      method: "POST",
      timeoutMs: this.config.model.timeoutMs,
      headers: {
        Authorization: `Bearer ${this.config.model.typesafeApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new DecisionError(await jevHttpError(response));
    const raw = (await response.json()) as {
      answers?: Record<string, { choice?: string }>;
      usage?: unknown;
      model?: string;
    };
    const decision = validateDecision(bindNamedTargets(parseJevAnswers(raw.answers ?? {}), space), space);
    decision.modelMs = elapsedMs(started);
    decision.model = raw.model || this.config.model.typesafeModel || "jev-latest";
    decision.modelUsage = parseModelUsage(raw.usage) ?? null;
    decision.input = clipText(`goal: ${goal}\n${formatJevInput(body)}`);
    decision.reply = formatJevReply(raw.answers) ?? null;
    decision.thought = extractThought(raw) ?? null;
    return decision;
  }
}

export function buildJevRequest(
  config: PilotConfig,
  page: { url: string; title: string },
  goal: string,
  history: Record<string, unknown>[],
  space: ActionSpace,
): Record<string, unknown> {
  const packed = packForModel(space);
  const operations = Object.fromEntries(packed.operations.map((name) => [name, operationHint(name)]));
  const questions: Record<string, unknown> = {
    operation: {
      type: "choice",
      criteria: operations,
      instructions: { goal, rules: NEXT_ACTION },
    },
  };
  addTargetQuestion(questions, "click_target", "CLICK", pickPool(packed.click_targets, space.clickTargets), goal);
  addTargetQuestion(questions, "type_target", "TYPE", pickPool(packed.type_targets, space.typeTargets), goal);
  addTypeTextQuestions(questions, packed.type_targets, space, goal);
  if (Object.keys(space.selectTargets).length) {
    questions.select_target = {
      type: "choice",
      criteria: Object.fromEntries(
        Object.entries(space.selectTargets).map(([index, item]) => [
          index,
          {
            element: `[${index}] ${item.element.role} ${item.option.label}`,
            current_value: item.option.value,
          },
        ]),
      ),
      instructions: { goal, operation: "SELECT", rules: [NEXT_ACTION, TARGET] },
    };
  }
  return {
    model: config.model.typesafeModel || "jev-latest",
    state: {
      page: { url: page.url, title: page.title },
      elements: space.elements
        .filter((item) => packed.elements.some((line) => line.startsWith(`[${item.index}]`)))
        .slice(0, 80)
        .map((item) => ({
        index: item.index,
        role: item.role,
        name: (item.name || "").slice(0, 40),
        value: publicValue(item.name, item.value).slice(0, 40),
        operations: item.operations,
      })),
      recent_actions: history.slice(-10).map((item) => {
        const name = (item.matched as { name?: string } | undefined)?.name;
        return {
          action: item.action,
          op: item.op,
          text: isSecretControl(name) ? undefined : item.text,
          page_changed: item.page_changed,
          name,
        };
      }),
    },
    questions,
  };
}

const THOUGHT_KEYS = ["reasoning", "reasoning_content", "thought", "thinking", "rationale", "explanation"];

export function formatJevReply(answers: unknown): string | undefined {
  if (!answers || typeof answers !== "object") return undefined;
  const lines: string[] = [];
  for (const [key, value] of Object.entries(answers as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const answer = value as Record<string, unknown>;
    const picked = answer.choice ?? answer.noul ?? answer.score;
    const confidence = answer.confidence;
    lines.push(
      `${key}: ${picked ?? ""}${confidence != null ? ` (confidence ${confidence})` : ""}`.trim(),
    );
    if (answer.probabilities && typeof answer.probabilities === "object") {
      const ranked = Object.entries(answer.probabilities as Record<string, unknown>)
        .map(([name, score]) => [name, Number(score)] as const)
        .filter(([, score]) => Number.isFinite(score))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, score]) => `${name} ${score.toFixed(2)}`);
      if (ranked.length) lines.push(`  ${ranked.join(", ")}`);
    }
  }
  const reply = lines.join("\n").trim();
  return reply || undefined;
}

function formatJevInput(body: Record<string, unknown>): string {
  const state = (body.state ?? {}) as {
    page?: { url?: string; title?: string };
    elements?: { index?: string; role?: string; name?: string }[];
  };
  const questions = Object.keys((body.questions ?? {}) as Record<string, unknown>).join(", ");
  const elements = (state.elements ?? [])
    .slice(0, 12)
    .map((item) => `[${item.index}] ${item.role ?? ""} ${item.name ?? ""}`.trim())
    .join("\n");
  return [`page: ${state.page?.url ?? ""}`, state.page?.title ?? "", `questions: ${questions}`, elements]
    .filter(Boolean)
    .join("\n");
}

function clipText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 8000 ? `${trimmed.slice(0, 8000)}…` : trimmed;
}

export function extractThought(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const direct = firstText(record, THOUGHT_KEYS);
  const answers = record.answers;
  const pieces: string[] = [];
  if (direct) pieces.push(direct);
  if (answers && typeof answers === "object") {
    for (const [key, value] of Object.entries(answers as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const text = firstText(value as Record<string, unknown>, THOUGHT_KEYS);
      if (text) pieces.push(`${key}: ${text}`);
    }
  }
  const thought = pieces.join("\n").trim();
  if (!thought) return undefined;
  return thought.length > 8000 ? `${thought.slice(0, 8000)}…` : thought;
}

function firstText(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function parseJevAnswers(answers: Record<string, { choice?: string }>): Decision {
  const operation = String(answers.operation?.choice ?? "");
  const raw: Record<string, unknown> = { operation };
  if (operation === "CLICK") raw.click_target = answers.click_target?.choice;
  if (operation === "TYPE" || operation === "TYPE_TEXT") {
    raw.type_target = answers.type_target?.choice;
    const typed = answers[`text_${raw.type_target}`]?.choice;
    if (typed) raw.text = typed;
  }
  if (operation === "SELECT") raw.select_target = answers.select_target?.choice;
  return parseDecision(raw);
}

function addTypeTextQuestions(
  questions: Record<string, unknown>,
  indexes: string[],
  space: ActionSpace,
  goal: string,
): void {
  const candidates = typeCandidates(goal);
  if (!candidates.length) return;
  const criteria = Object.fromEntries(candidates.map((item) => [item, item]));
  for (const index of indexes.slice(0, 8)) {
    const field = space.typeTargets[index];
    if (!field) continue;
    questions[`text_${index}`] = {
      type: "choice",
      criteria,
      instructions: {
        goal,
        field: `${field.role} ${field.name || "(unnamed)"}`.trim(),
        current_value: publicValue(field.name, field.value),
        rules: "Choose the exact characters to type into this field. Use only an offered value the field still needs. Do not invent text.",
      },
    };
  }
}

function pickPool<T>(indexes: string[], pool: Record<string, T>): Record<string, T> {
  return Object.fromEntries(indexes.filter((index) => pool[index]).map((index) => [index, pool[index]]));
}

function linkHint(href?: string | null): string {
  if (!href || !/^https?:/i.test(href)) return "";
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, "");
    const segment = url.pathname.split("/").filter(Boolean)[0];
    return segment ? `${host}/${segment}` : host;
  } catch {
    return "";
  }
}

function addTargetQuestion(
  questions: Record<string, unknown>,
  key: string,
  operation: string,
  pool: Record<string, { index: string; name: string; role: string; value: string; href?: string | null }>,
  goal: string,
): void {
  const entries = Object.entries(pool);
  if (!entries.length) return;
  questions[key] = {
    type: "choice",
    criteria: Object.fromEntries(
      entries.map(([index, item]) => [
        index,
        {
          element: [`[${index}] ${item.role} ${item.name || "(unnamed)"}`.trim(), linkHint(item.href)]
            .filter(Boolean)
            .join(" · "),
          current_value: publicValue(item.name, item.value),
        },
      ]),
    ),
    instructions: { goal, operation, rules: [NEXT_ACTION, TARGET] },
  };
}

function operationHint(name: string): string {
  if (name === "CLICK") return "Click a visible control.";
  if (name === "TYPE") return "Type into an editable field. The characters are chosen with this same decision.";
  if (name === "SELECT") return "Choose an observed native option.";
  if (name === "SCROLL_DOWN") return "Scroll down to reveal more controls.";
  if (name === "SCROLL_UP") return "Scroll up to reveal more controls.";
  if (name === "WAIT") return "Wait only if the needed control is still loading.";
  if (name === "DONE") return "Every requirement is already visible.";
  if (name === "BLOCKED") return "No supported operation can make progress.";
  return name;
}

const ASSERT_RULES = `Judge only whether this one action took effect on the after page.
pass: typed or selected text is visible, a click or scroll changed the page, or a wait finished.
fail: the after page does not show that effect.
Do not judge whether the whole task is finished.
Choose only pass or fail.`;

function briefPage(page: { url?: string; title?: string; elements?: { role?: string; name?: string; value?: string }[] }) {
  return {
    url: page.url ?? "",
    title: page.title ?? "",
    controls: (page.elements ?? []).slice(0, 40).map((item) => ({
      role: item.role ?? "",
      name: (item.name ?? "").slice(0, 40),
      value: (item.value ?? "").slice(0, 40),
    })),
  };
}

export async function jevAssert(
  config: PilotConfig,
  input: {
    op: string;
    value?: string;
    before?: ControlSnapshot;
    after: Pick<PageState, "url" | "title" | "elements">;
  },
): Promise<{
  verdict: "pass" | "fail";
  model?: string;
  modelMs: number;
  modelUsage?: ModelUsage;
  input: string;
  reply?: string;
  thought?: string;
}> {
  if (!config.model.typesafeApiKey) {
    throw new DecisionError("TYPESAFE_API_KEY is required for Jev assertions.");
  }
  const started = performance.now();
  const state = {
    action: { op: input.op, value: input.value ?? "" },
    before: input.before ? briefPage(input.before) : undefined,
    after: briefPage(input.after),
  };
  const body = {
    model: config.model.typesafeModel || "jev-latest",
    state,
    questions: {
      verdict: {
        type: "choice",
        criteria: {
          pass: "This action's effect is visible on the after page.",
          fail: "This action's effect is not visible on the after page.",
        },
        instructions: { rules: ASSERT_RULES },
      },
    },
  };
  const response = await modelFetch(`${config.model.typesafeBaseUrl.replace(/\/$/, "")}/systemone`, {
    method: "POST",
    timeoutMs: config.model.timeoutMs,
    headers: {
      Authorization: `Bearer ${config.model.typesafeApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new DecisionError(await jevHttpError(response));
  const raw = (await response.json()) as {
    answers?: Record<string, { choice?: string }>;
    usage?: unknown;
    model?: string;
  };
  const choice = raw.answers?.verdict?.choice;
  return {
    verdict: choice === "pass" ? "pass" : "fail",
    model: raw.model || config.model.typesafeModel || "jev-latest",
    modelMs: elapsedMs(started),
    modelUsage: parseModelUsage(raw.usage) ?? undefined,
    input: clipText(JSON.stringify(state)),
    reply: formatJevReply(raw.answers),
    thought: extractThought(raw),
  };
}

const DONE_RULES = `Decide whether the done condition is already visible on this page.
Choose only met or unmet.
The condition describes the outcome, not a sentence that must appear verbatim.
Use the URL, title, visible text, and controls.
The same place, date, or result may appear in another form, including inside the URL.
A results page for those facts is enough, even without the condition's exact words.
If the URL or title already contains the places and dates in the condition, choose met.
Do not demand a separate price list when the page is already the results page for that query.
Choose unmet only when the page is still an earlier step, or the route, date, or result contradicts the condition.`;

export async function jevConfirmDone(
  config: PilotConfig,
  page: Pick<PageState, "url" | "title" | "text" | "elements">,
  doneWhen: string,
): Promise<{ met: boolean; model?: string; modelMs: number; modelUsage?: ModelUsage; reply?: string }> {
  if (!config.model.typesafeApiKey) {
    throw new DecisionError("TYPESAFE_API_KEY is required for Jev done checks.");
  }
  const started = performance.now();
  const state = {
    done_when: doneWhen,
    page: { ...briefPage(page), text: page.text.slice(0, 1500) },
  };
  const response = await modelFetch(`${config.model.typesafeBaseUrl.replace(/\/$/, "")}/systemone`, {
    method: "POST",
    timeoutMs: config.model.timeoutMs,
    headers: {
      Authorization: `Bearer ${config.model.typesafeApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model.typesafeModel || "jev-latest",
      state,
      questions: {
        done: {
          type: "choice",
          criteria: {
            met: "The done condition is already visible on this page.",
            unmet: "The page is still an earlier step, or it contradicts the condition.",
          },
          instructions: { rules: DONE_RULES },
        },
      },
    }),
  });
  if (!response.ok) throw new DecisionError(await jevHttpError(response));
  const raw = (await response.json()) as {
    answers?: Record<string, { choice?: string }>;
    usage?: unknown;
    model?: string;
  };
  return {
    met: raw.answers?.done?.choice === "met",
    model: raw.model || config.model.typesafeModel || "jev-latest",
    modelMs: elapsedMs(started),
    modelUsage: parseModelUsage(raw.usage) ?? undefined,
    reply: formatJevReply(raw.answers),
  };
}

async function jevHttpError(response: Response): Promise<string> {
  const body = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 240);
  return body ? `Jev returned HTTP ${response.status}: ${body}` : `Jev returned HTTP ${response.status}`;
}
