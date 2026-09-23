import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { PilotConfig } from "./types.js";
import { expandVars } from "./util.js";

export function defaultConfig(): PilotConfig {
  return {
    headless: false,
    browserEngine: "chromium",
    viewportWidth: 1120,
    viewportHeight: 780,
    timeoutMs: 15_000,
    maxSteps: 60,
    maxElements: 250,
    reportsDir: "reports",
    model: {
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY ?? "",
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      textModel: process.env.TEXT_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
      timeoutMs: 90_000,
      typesafeApiKey: process.env.TYPESAFE_API_KEY ?? "",
      typesafeModel: process.env.TYPESAFE_MODEL || "jev-latest",
      typesafeBaseUrl: process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai/v1",
    },
    api: {
      headers: {},
      map: {
        items: "$",
        id: "$.id",
        name: "$.name",
        start: "$.start",
        goal: "$.goal",
        tags: "$.tags",
        steps: "$.steps",
        teardown: "$.teardown",
      },
    },
  };
}

/** cwd/.env first, then the repo-root .env. Existing process.env keys win. */
export function loadEnv(cwd = process.cwd()): string | undefined {
  const file = resolveEnvFile(cwd);
  if (!file) return undefined;
  applyEnvFile(file);
  return file;
}

export function resolveEnvFile(cwd = process.cwd()): string | undefined {
  const cwdEnv = path.resolve(cwd, ".env");
  if (existsSync(cwdEnv)) return cwdEnv;
  const root = findRepoRoot(cwd);
  if (!root) return undefined;
  const rootEnv = path.join(root, ".env");
  return existsSync(rootEnv) ? rootEnv : undefined;
}

export function applyCliOverrides(
  config: PilotConfig,
  flags: { model?: string; baseUrl?: string },
): PilotConfig {
  if (flags.model) config.model.model = flags.model;
  if (flags.baseUrl) config.model.baseUrl = flags.baseUrl;
  return config;
}

export function loadConfig(file?: string): PilotConfig {
  const candidates = file
    ? [file]
    : ["codexqa-jev-browser.config.yaml", "codexqa-jev-browser.config.yml", "codexqa_jev_browser.config.yaml"].map((name) =>
        path.resolve(name),
      );
  const found = candidates.find((item) => existsSync(item));
  if (!found) return defaultConfig();
  const raw = parseYaml(readFileSync(found, "utf8")) as Record<string, unknown> | null;
  return mergeConfig(defaultConfig(), expandDeep(raw ?? {}) as Record<string, unknown>);
}

function findRepoRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  while (true) {
    if (existsSync(path.join(dir, ".git")) || existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function applyEnvFile(file: string): void {
  const preserved = { ...process.env };
  if (typeof process.loadEnvFile !== "function") {
    throw new Error("Node 20.12+ is required to load .env (process.loadEnvFile)");
  }
  process.loadEnvFile(file);
  for (const [key, value] of Object.entries(preserved)) {
    process.env[key] = value;
  }
}

function mergeConfig(base: PilotConfig, raw: Record<string, unknown>): PilotConfig {
  const browser = (raw.browser as Record<string, unknown> | undefined) ?? {};
  const model = (raw.model as Record<string, unknown> | undefined) ?? {};
  const sources = (raw.sources as Record<string, unknown> | undefined) ?? {};
  const api = (sources.api as Record<string, unknown> | undefined) ?? {};
  return {
    ...base,
    headless: (browser.headless as boolean | undefined) ?? base.headless,
    browserEngine: parseEngine(browser.engine, process.env.UI_PILOT_BROWSER, base.browserEngine),
    executablePath: pickOptional(browser.executable_path, process.env.CLOAKBROWSER_BINARY_PATH, process.env.CLOAK_EXECUTABLE),
    userDataDir: pickOptional(browser.user_data_dir, process.env.CLOAK_USER_DATA_DIR),
    fingerprintSeed: pickOptional(browser.fingerprint_seed, process.env.CLOAK_FINGERPRINT_SEED),
    viewportWidth: (browser.viewport_width as number | undefined) ?? base.viewportWidth,
    viewportHeight: (browser.viewport_height as number | undefined) ?? base.viewportHeight,
    timeoutMs: (browser.timeout_ms as number | undefined) ?? base.timeoutMs,
    maxSteps: (raw.max_steps as number | undefined) ?? base.maxSteps,
    maxElements: (raw.max_elements as number | undefined) ?? (browser.max_elements as number | undefined) ?? base.maxElements,
    reportsDir: (raw.reports_dir as string | undefined) ?? base.reportsDir,
    model: {
      ...base.model,
      baseUrl: pickString(model.base_url, base.model.baseUrl),
      apiKey: pickString(model.api_key, base.model.apiKey),
      model: pickString(model.model, base.model.model),
      textModel: pickString(model.text_model, base.model.textModel),
      typesafeApiKey: pickString(model.typesafe_api_key, base.model.typesafeApiKey),
      typesafeModel: pickString(model.typesafe_model, base.model.typesafeModel),
      typesafeBaseUrl: pickString(model.typesafe_base_url, base.model.typesafeBaseUrl),
    },
    api: {
      headers: { ...base.api.headers, ...((api.headers as Record<string, string>) ?? {}) },
      map: { ...base.api.map, ...((api.map as Record<string, string>) ?? {}) },
    },
  };
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function pickOptional(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function parseEngine(
  yamlValue: unknown,
  envValue: string | undefined,
  fallback: PilotConfig["browserEngine"],
): PilotConfig["browserEngine"] {
  const raw = pickOptional(envValue, yamlValue) ?? fallback;
  if (raw === "cloak" || raw === "auto" || raw === "chromium") return raw;
  return fallback;
}

function expandDeep(value: unknown): unknown {
  if (typeof value === "string") return expandVars(value);
  if (Array.isArray(value)) return value.map(expandDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandDeep(v)]));
  }
  return value;
}
