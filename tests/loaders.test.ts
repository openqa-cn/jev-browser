import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runHttp } from "../src/act.js";
import { expandStep, loadApiCases, loadMdCases, loadYamlCases, normalizeCase, readPlanTitle } from "../src/cases.js";
import { defaultConfig } from "../src/config.js";
import { expandVars, jsonpath } from "../src/util.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("case loaders", () => {
  it("loads YAML", () => {
    const cases = loadYamlCases(path.join(root, "cases/examples/search-docs.yaml"));
    expect(cases).toHaveLength(1);
    expect(cases[0].id).toBe("search-docs");
    expect(cases[0].steps[0].op).toBe("type");
    expect(cases[0].steps[0].target?.name).toBe("搜索");
    expect(cases[0].steps.at(-1)?.urlIncludes).toBe("docs.html");
  });

  it("loads a test plan that points at case files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-plan-"));
    const plan = path.join(dir, "plan.yaml");
    writeFileSync(
      plan,
      ["name: 示例计划", "cases:", `  - ${path.join(root, "cases/examples/search-docs.yaml")}`, `  - ${path.join(root, "cases/examples/login.yaml")}`, ""].join("\n"),
    );
    expect(readPlanTitle(plan)).toBe("示例计划");
    expect(loadYamlCases(plan).map((item) => item.id)).toEqual(["search-docs", "login-workbench"]);
  });

  it("loads Markdown", () => {
    const cases = loadMdCases(path.join(root, "cases/examples/search-docs.md"));
    expect(cases[0].id).toBe("search-docs-md");
    expect(cases[0].steps.map((step) => step.op)).toEqual(["type", "click", "assert"]);
    expect(cases[0].steps[0].value).toBe("Pilot");
    expect(cases[0].steps[2].visibleText).toBe("入门");
  });

  it("loads API fixture", async () => {
    const original = globalThis.fetch;
    const payload = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(root, "cases/examples/api-suite.json"), "utf8"),
    );
    globalThis.fetch = async () =>
      new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
    try {
      const cases = await loadApiCases("https://qa.example.com/cases", defaultConfig());
      expect(cases[0].id).toBe("api-search-docs");
      expect(cases[0].steps[1].op).toBe("click");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("evaluates jsonpath", () => {
    const data = { data: [{ id: "a", nested: { ok: true } }] };
    expect(jsonpath(data, "$.data[0].id")).toBe("a");
    expect(jsonpath(data, "$.data[0].nested.ok")).toBe(true);
    expect(jsonpath(data, "$")).toEqual(data);
  });

  it("maps storage_state and keeps unresolved ${vars} for runtime", () => {
    const item = normalizeCase({
      id: "auth",
      start: { url: "https://example.com/${UI_PILOT_PATH}", storage_state: "auth.json" },
      steps: [
        { op: "http", url: "https://example.com/${UI_PILOT_HTTP_TOKEN}", json: { token: "${UI_PILOT_HTTP_TOKEN}" } },
        { op: "type", target: { name: "q" }, value: "${UI_PILOT_HTTP_TOKEN}", wait_ms: 250 },
      ],
    });
    expect(item.start.storageState).toBe("auth.json");
    expect(item.start.url).toBe("https://example.com/${UI_PILOT_PATH}");
    expect(item.steps[0].url).toBe("https://example.com/${UI_PILOT_HTTP_TOKEN}");
    expect(item.steps[1].value).toBe("${UI_PILOT_HTTP_TOKEN}");
    expect(item.steps[1].waitMs).toBe(250);
    expect(expandStep(item.steps[0], { UI_PILOT_HTTP_TOKEN: "abc" }).url).toBe("https://example.com/abc");
    expect(expandStep(item.steps[1], { UI_PILOT_HTTP_TOKEN: "abc" }).value).toBe("abc");
    expect(expandVars("keep ${missing}", {}, { keepMissing: true })).toBe("keep ${missing}");
  });

  it("rejects case URLs that are not http or https", async () => {
    await expect(runHttp({ op: "http", url: "file:///tmp/cases.json" })).rejects.toThrow(/https/);
    await expect(loadApiCases("file:///tmp/cases.json", defaultConfig())).rejects.toThrow(/https/);
  });
});
