import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Agent, loadScript } from "../src/agent.js";
import { BrowserSession } from "../src/browser.js";
import { loadCases, normalizeCase } from "../src/cases.js";
import { defaultConfig } from "../src/config.js";
import { DEFAULT_DENY, explore } from "../src/explore.js";
import { compileCase } from "../src/generate.js";
import { emptyReport, failedCount, ReportWriter } from "../src/report.js";
import { CaseRunner } from "../src/runner.js";
import { isoformat, runId } from "../src/util.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "examples/app/index.html");

describe("live browser flows", () => {
  it("observes the demo app", async () => {
    const session = new BrowserSession({ ...defaultConfig(), headless: true });
    try {
      const page = await session.start(app);
      const names = new Set(page?.elements.map((item) => item.name));
      expect(names.has("搜索")).toBe(true);
      expect(names.has("Pilot 入门")).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("leaves footer and offscreen controls out of the snapshot", async () => {
    const session = new BrowserSession({ ...defaultConfig(), headless: true });
    try {
      const page = await session.start(path.join(root, "examples/app/viewport-filter.html"));
      const names = page?.elements.map((item) => item.name) ?? [];
      expect(names).toContain("可见");
      expect(names).not.toContain("沪ICP备");
      expect(names).not.toContain("屏外链接");
    } finally {
      await session.close();
    }
  });

  it("does not use a rotating placeholder as the control name", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-ph-"));
    const file = path.join(dir, "placeholder.html");
    writeFileSync(
      file,
      "<!DOCTYPE html><title>placeholder</title><input type='search' placeholder='西藏甘肃青海省委书记调整'>",
    );
    const session = new BrowserSession({ ...defaultConfig(), headless: true });
    try {
      const page = await session.start(file);
      const names = page?.elements.map((item) => item.name) ?? [];
      expect(names).not.toContain("西藏甘肃青海省委书记调整");
      expect(page?.elements.some((item) => item.role === "searchbox" && item.operations.includes("TYPE"))).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("fails the step when the action has no visible effect", async () => {
    const config = { ...defaultConfig(), headless: true, reportsDir: mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-fx-")) };
    const writer = new ReportWriter(config.reportsDir, "effect-1", false);
    const session = new BrowserSession(config);
    try {
      await session.start();
      const agent = new Agent(session, writer, config, {
        script: [{ operation: "CLICK", target: { role: "button", name: "退出登录" } }],
      });
      const { result } = await agent.run(app, "点一个没有效果的按钮");
      expect(result.status).not.toBe("pass");
      expect(result.steps.some((step) => step.assertVerdict === "fail" && step.status === "fail")).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("keeps a departure caption on a city field whose accessible name is only the placeholder", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-city-"));
    const file = path.join(dir, "cities.html");
    writeFileSync(
      file,
      "<!DOCTYPE html><title>cities</title><div><div>出发地</div><input aria-label='可输入城市或机场' value='北京(BJS)'></div><div><div>目的地</div><input aria-label='可输入城市或机场' value='北京(BJS)'></div>",
    );
    const session = new BrowserSession({ ...defaultConfig(), headless: true });
    try {
      const page = await session.start(file);
      const names = page?.elements.map((item) => item.name) ?? [];
      expect(names).toContain("出发地 可输入城市或机场");
      expect(names).toContain("目的地 可输入城市或机场");
    } finally {
      await session.close();
    }
  });

  it("names the icon beside a search field as the search button", async () => {
    const session = new BrowserSession({ ...defaultConfig(), headless: true });
    try {
      const page = await session.start(path.join(root, "examples/app/search-submit.html"));
      const search = page?.elements.find((item) => item.role === "button" && item.name === "搜索");
      expect(search?.operations).toContain("CLICK");
      const submit = page?.elements.find((item) => item.role === "button" && item.name === "百度一下");
      expect(submit?.operations).toContain("CLICK");
      expect(page?.elements.some((item) => item.name === "附近文字")).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("waits for controls that appear after a navigation", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-late-"));
    const file = path.join(dir, "late.html");
    writeFileSync(
      file,
      "<!DOCTYPE html><title>late</title><button id='go'>打开</button><script>document.getElementById('go').onclick=()=>{location.hash='opened';setTimeout(()=>{const input=document.createElement('input');input.setAttribute('aria-label','后来出现');document.body.appendChild(input);},900);};</script>",
    );
    const config = { ...defaultConfig(), headless: true, reportsDir: mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-late-report-")) };
    const writer = new ReportWriter(config.reportsDir, "late-1", false);
    const session = new BrowserSession(config);
    try {
      await session.start(file);
      const agent = new Agent(session, writer, config, {
        script: [
          { operation: "CLICK", target: { role: "button", name: "打开" } },
          { operation: "TYPE", text: "好", target: { role: "textbox", name: "后来出现" } },
          { operation: "DONE" },
        ],
      });
      const { result } = await agent.run(file, "点打开后等输入框出现再填写");
      expect(result.status).toBe("pass");
      expect(result.steps.some((step) => step.op === "type" && step.value === "好")).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("indexes overlay chooser leaves as clickable options", async () => {
    const session = new BrowserSession({ ...defaultConfig(), headless: true });
    try {
      const page = await session.start(path.join(root, "examples/app/chooser.html"));
      const options = page?.elements.filter((item) => item.role === "option") ?? [];
      const names = options.map((item) => item.name);
      expect(names).toContain("上海");
      expect(names).toContain("成都");
      expect(names).toContain("2026年10月 7");
      expect(names).toContain("2026年11月 7");
      expect(names).not.toContain("7");
      expect(names).not.toContain("2026年9月 日一二三四五六");
      expect(names).not.toContain("2026年10月");
      expect(options.every((item) => item.within === "chooser" && item.operations.includes("CLICK"))).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("replays YAML and Markdown and writes a screenshot report", async () => {
    const config = { ...defaultConfig(), headless: true, reportsDir: mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-run-")) };
    const cases = await loadCases(
      [path.join(root, "cases/examples/search-docs.yaml"), path.join(root, "cases/examples/search-docs.md")],
      { config },
    );
    const writer = new ReportWriter(config.reportsDir, runId(), true);
    const report = emptyReport({ runId: "live", mode: "run", name: "offline demo", startedAt: isoformat() });
    const session = new BrowserSession(config);
    try {
      await session.start();
      const runner = new CaseRunner(session, writer);
      for (const item of cases) report.cases.push(await runner.runCase(item));
    } finally {
      await session.close();
    }
    const paths = writer.write(report);
    expect(failedCount(report)).toBe(0);
    expect(report.cases).toHaveLength(2);
    expect(require("node:fs").readFileSync(paths.html, "utf8")).toContain("search-docs");
    expect(report.cases[0].steps.some((step) => step.screenshot)).toBe(true);
  });

  it("runs a scripted auto flow and compiles a case", async () => {
    const config = { ...defaultConfig(), headless: true, reportsDir: mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-auto-")) };
    const writer = new ReportWriter(config.reportsDir, "auto-1", false);
    const session = new BrowserSession(config);
    try {
      await session.start();
      const agent = new Agent(session, writer, config, {
        script: loadScript(path.join(root, "cases/scripts/decisions-search.yaml")),
      });
      const { result, history } = await agent.run(app, "搜索 Pilot 并打开文档");
      expect(result.status).toBe("pass");
      expect(history.length).toBeGreaterThan(0);
      expect(result.steps.filter((step) => step.op !== "done").every((step) => step.durationMs > 0)).toBe(true);
      expect(result.steps[0].observeMs).toBeGreaterThanOrEqual(0);
      const compiled = compileCase(result, app, "搜索 Pilot 并打开文档");
      expect(compiled.steps[0].op).toBe("type");
      expect(compiled.steps[0].value).toBe("Pilot");
    } finally {
      await session.close();
    }
  });

  it("explores without clicking denylist controls", async () => {
    const config = { ...defaultConfig(), headless: true, reportsDir: mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-exp-")) };
    const writer = new ReportWriter(config.reportsDir, "exp-1", false);
    const session = new BrowserSession(config);
    try {
      await session.start();
      const { graph, result, compiled } = await explore(session, writer, app, {
        maxStates: 8,
        maxSteps: 10,
        maxMinutes: 1,
      });
      const names = graph.edges.map((edge) => edge.name);
      expect(names).not.toContain("退出登录");
      expect(names).not.toContain("删除账号");
      expect(names.join(" ").toLowerCase()).not.toContain("logout");
      expect(compiled.length).toBeGreaterThan(0);
      expect(DEFAULT_DENY.join(" ")).toContain("删除");
      expect(result.steps.length).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it("clicks a control inside a same-origin iframe", async () => {
    const host = path.join(root, "examples/app/iframe-host.html");
    const config = { ...defaultConfig(), headless: true, reportsDir: mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-iframe-")) };
    const writer = new ReportWriter(config.reportsDir, "iframe-1", false);
    const session = new BrowserSession(config);
    try {
      await session.start();
      const runner = new CaseRunner(session, writer);
      const result = await runner.runCase(
        normalizeCase({
          id: "iframe-click",
          start: { url: host },
          steps: [
            { op: "wait", wait_ms: 400 },
            { op: "click", target: { role: "button", name: "iframe 确认" } },
            { op: "assert", visible_text: "iframe 已点击" },
          ],
        }),
      );
      expect(result.status).toBe("pass");
    } finally {
      await session.close();
    }
  });

  it("runs teardown after a failed step and expands http save vars", async () => {
    const config = { ...defaultConfig(), headless: true, reportsDir: mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-td-")) };
    const writer = new ReportWriter(config.reportsDir, "td-1", false);
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/token")) return new Response(JSON.stringify({ token: "abc" }), { status: 200 });
      if (url.endsWith("/abc")) return new Response("ok", { status: 200 });
      return new Response("missing", { status: 404 });
    };
    const session = new BrowserSession(config);
    try {
      await session.start();
      const runner = new CaseRunner(session, writer);
      const result = await runner.runCase(
        normalizeCase({
          id: "teardown-http",
          start: { url: app },
          steps: [
            { op: "http", url: "https://example.test/token", save: { token: "$.token" } },
            { op: "http", url: "https://example.test/${token}", expect_status: 200 },
            { op: "assert", visible_text: "___missing___" },
            { op: "click", target: { role: "button", name: "进入工作台" } },
          ],
          teardown: [{ op: "click", target: { role: "button", name: "进入工作台" }, wait_ms: 80 }],
        }),
      );
      expect(result.status).toBe("fail");
      expect(result.steps[1].status).toBe("pass");
      expect(result.steps[1].http?.url).toBe("https://example.test/abc");
      expect(result.steps[2].status).toBe("fail");
      expect(result.steps[3].status).toBe("skip");
      expect(result.steps[4].status).toBe("pass");
      expect(result.steps[4].op).toBe("click");
      expect(result.steps[4].durationMs).toBeGreaterThanOrEqual(80);
    } finally {
      globalThis.fetch = original;
      await session.close();
    }
  });
});
