import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { applyCliOverrides, defaultConfig, loadConfig, loadEnv, resolveEnvFile } from "../src/config.js";
import { DecisionError } from "../src/errors.js";
import { missingApiKeyMessage, OpenAIProvider } from "../src/policy.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRACKED = ["UI_PILOT_ENV_A", "UI_PILOT_ENV_B", "UI_PILOT_ENV_C"] as const;
const MODEL_ENV = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "TEXT_MODEL"] as const;

afterEach(() => {
  for (const key of TRACKED) delete process.env[key];
});

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("model env and config", () => {
  it("loads cwd .env without overriding existing variables", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-env-"));
    writeFileSync(path.join(dir, ".env"), "UI_PILOT_ENV_A=from-file\nUI_PILOT_ENV_B=from-file\n");
    process.env.UI_PILOT_ENV_A = "from-shell";
    expect(loadEnv(dir)).toBe(path.resolve(dir, ".env"));
    expect(process.env.UI_PILOT_ENV_A).toBe("from-shell");
    expect(process.env.UI_PILOT_ENV_B).toBe("from-file");
  });

  it("falls back to the repo-root .env when cwd has none", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-repo-"));
    writeFileSync(path.join(repo, "package.json"), "{}");
    writeFileSync(path.join(repo, ".env"), "UI_PILOT_ENV_C=from-root\n");
    const nested = path.join(repo, "src", "nested");
    mkdirSync(nested, { recursive: true });
    expect(resolveEnvFile(nested)).toBe(path.join(repo, ".env"));
    expect(loadEnv(nested)).toBe(path.join(repo, ".env"));
    expect(process.env.UI_PILOT_ENV_C).toBe("from-root");
  });

  it("keeps defaults when yaml model placeholders expand to empty", () => {
    const empty = Object.fromEntries(MODEL_ENV.map((key) => [key, undefined]));
    withEnv(empty, () => {
      const config = loadConfig(path.join(root, "codexqa-jev-browser.config.yaml"));
      expect(config.model.apiKey).toBe("");
      expect(config.model.baseUrl).toBe("https://api.openai.com/v1");
      expect(config.model.model).toBe("gpt-4o-mini");
      expect(config.model.textModel).toBe("gpt-4o-mini");
    });
  });

  it("lets --model and --base-url override non-secret fields", () => {
    const config = applyCliOverrides(defaultConfig(), {
      model: "gpt-test",
      baseUrl: "https://example.test/v1",
    });
    expect(config.model.model).toBe("gpt-test");
    expect(config.model.baseUrl).toBe("https://example.test/v1");
  });

  it("names the three env vars and --config when the key is missing", () => {
    const message = missingApiKeyMessage("auto");
    expect(message).toContain("OPENAI_API_KEY");
    expect(message).toContain("OPENAI_BASE_URL");
    expect(message).toContain("OPENAI_MODEL");
    expect(message).toContain("--config");
    const config = defaultConfig();
    config.model.apiKey = "";
    expect(() => new OpenAIProvider(config)).toThrow(DecisionError);
    expect(() => new OpenAIProvider(config)).toThrow(/OPENAI_API_KEY[\s\S]*OPENAI_BASE_URL[\s\S]*OPENAI_MODEL[\s\S]*--config/);
  });
});

describe("cli help", () => {
  it("documents model flags and env vars", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      expect(await main(["--help"])).toBe(0);
    } finally {
      console.log = original;
    }
    const text = lines.join("\n");
    expect(text).toContain("--model");
    expect(text).toContain("--base-url");
    expect(text).toContain("OPENAI_API_KEY");
    expect(text).toContain("OPENAI_BASE_URL");
    expect(text).toContain("OPENAI_MODEL");
    expect(text).toContain("TYPESAFE_API_KEY");
    expect(text).toContain("install-browser");
    expect(text).toContain("CLOAKBROWSER_DOWNLOAD_URL");
    expect(text).toContain("CLOAKBROWSER_SHA256");
    expect(text).not.toContain("dadangai");
  });
});
