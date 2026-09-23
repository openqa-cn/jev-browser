export interface Target {
  role?: string;
  name?: string;
  value?: string;
  nth?: number;
  within?: string;
}

export interface Step {
  op: string;
  target?: Target;
  value?: string;
  waitMs?: number;
  urlIncludes?: string;
  urlEquals?: string;
  titleIncludes?: string;
  visibleText?: string;
  hiddenText?: string;
  elementState?: Record<string, unknown>;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  json?: unknown;
  body?: string;
  save?: Record<string, string>;
  expectStatus?: number;
  jsonpath?: string;
  jsonpathEquals?: unknown;
}

export interface Start {
  url?: string;
  storageState?: string;
  headers?: Record<string, string>;
}

export interface CanonicalCase {
  id: string;
  name: string;
  start: Start;
  goal?: string;
  tags: string[];
  steps: Step[];
  teardown: Step[];
  source: string;
}

export interface ObservedOption {
  index: string;
  label: string;
  value: string;
}

export interface ObservedElement {
  index: string;
  node: number;
  role: string;
  name: string;
  value: string;
  operations: string[];
  checked?: boolean | null;
  selected?: boolean | null;
  expanded?: string | null;
  within: string;
  frame?: string | null;
  href?: string | null;
  nearby: string;
  options: ObservedOption[];
}

export interface ControlNode {
  index: string;
  role: string;
  name: string;
  value: string;
  operations: string[];
  within: string;
}

export interface ControlSnapshot {
  url: string;
  title: string;
  elements: ControlNode[];
}

export interface PageState {
  url: string;
  title: string;
  text: string;
  elements: ObservedElement[];
  scroll: Record<string, number>;
  pageKey: string;
  marker: string;
  guards: Record<string, string>;
  fingerprint: string;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface StepResult {
  index: number;
  op: string;
  status: string;
  target?: string;
  value?: string;
  url?: string;
  title?: string;
  durationMs: number;
  observeMs?: number;
  observed?: ControlSnapshot;
  observeAfterMs?: number;
  assertMs?: number;
  assertModel?: string;
  assertUsage?: ModelUsage;
  assertInput?: string;
  assertReply?: string;
  assertThought?: string;
  assertVerdict?: "pass" | "fail";
  confirmMs?: number;
  confirmModel?: string;
  confirmUsage?: ModelUsage;
  modelMs?: number;
  textMs?: number;
  textModel?: string;
  textUsage?: ModelUsage;
  actMs?: number;
  screenshotMs?: number;
  model?: string;
  modelUsage?: ModelUsage;
  modelInput?: string;
  modelReply?: string;
  modelThought?: string;
  textThought?: string;
  matched?: Record<string, unknown>;
  candidates?: Record<string, unknown>[];
  expected?: Record<string, unknown>;
  actual?: Record<string, unknown>;
  error?: string;
  screenshot?: string;
  http?: Record<string, unknown>;
  skipped?: boolean;
}

export interface TaskPlan {
  steps: string[];
  doneWhen: string;
  model?: string;
  modelMs?: number;
  modelUsage?: ModelUsage;
}

export interface CaseResult {
  id: string;
  name: string;
  source: string;
  status: string;
  durationMs: number;
  error?: string;
  goal?: string;
  plan?: TaskPlan;
  steps: StepResult[];
}

export interface SuiteReport {
  runId: string;
  mode: string;
  name: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  browser: string;
  viewport: string;
  model?: string;
  startUrl?: string;
  plan?: string;
  path: string;
  recordings?: string[];
  cases: CaseResult[];
}

export interface Decision {
  operation: string;
  clickTarget?: string | null;
  typeTarget?: string | null;
  selectTarget?: string | null;
  confidence?: number | null;
  reason?: string | null;
  text?: string | null;
  target?: Target;
  modelMs?: number | null;
  model?: string | null;
  modelUsage?: ModelUsage | null;
  input?: string | null;
  reply?: string | null;
  thought?: string | null;
}

export interface PilotConfig {
  headless: boolean;
  browserEngine: "auto" | "cloak" | "chromium";
  executablePath?: string;
  userDataDir?: string;
  fingerprintSeed?: string;
  viewportWidth: number;
  viewportHeight: number;
  timeoutMs: number;
  maxSteps: number;
  maxElements: number;
  reportsDir: string;
  model: {
    baseUrl: string;
    apiKey: string;
    model: string;
    textModel: string;
    timeoutMs: number;
    typesafeApiKey: string;
    typesafeModel: string;
    typesafeBaseUrl: string;
  };
  api: {
    headers: Record<string, string>;
    map: Record<string, string>;
  };
}

export const UI_OPS = new Set(["click", "type", "select", "scroll_up", "scroll_down", "wait"]);
export const ALL_OPS = new Set([...UI_OPS, "http", "assert"]);
