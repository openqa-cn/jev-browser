import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileCase, writeCase } from "../src/generate.js";
import { emptyReport, formatClock, formatDateTime, formatStepTimes, modelConsumeLabel, passRate, renderHtml, renderMarkdown, ReportWriter } from "../src/report.js";
import { isoformat, parseModelUsage, runId } from "../src/util.js";

describe("compiler and report", () => {
  it("compiles semantic targets", () => {
    const compiled = compileCase(
      {
        id: "auto",
        name: "search",
        source: "auto",
        status: "pass",
        durationMs: 10,
        steps: [
          {
            index: 1,
            op: "type",
            status: "pass",
            value: "Pilot",
            durationMs: 1,
            matched: { role: "searchbox", name: "搜索", within: "" },
          },
          {
            index: 2,
            op: "click",
            status: "pass",
            url: "file:///tmp/docs.html",
            title: "Pilot 入门",
            durationMs: 1,
            matched: { role: "link", name: "Pilot 入门" },
          },
          { index: 3, op: "done", status: "pass", url: "file:///tmp/docs.html", title: "Pilot 入门", durationMs: 1 },
        ],
      },
      "examples/app/index.html",
      "search",
    );
    expect(compiled.steps[0].op).toBe("type");
    expect(compiled.steps[0].target?.role).toBe("searchbox");
    expect(compiled.steps.some((step) => step.op === "assert")).toBe(true);
  });

  it("keeps scroll direction and drops failed steps", () => {
    const compiled = compileCase(
      {
        id: "scroll",
        name: "scroll",
        source: "auto",
        status: "fail",
        durationMs: 10,
        steps: [
          { index: 1, op: "scroll_up", status: "pass", durationMs: 1 },
          { index: 2, op: "click", status: "fail", durationMs: 1, matched: { role: "button", name: "X" } },
        ],
      },
      "https://example.com",
      "scroll",
    );
    expect(compiled.steps.some((step) => step.op === "scroll_up")).toBe(true);
    expect(compiled.steps.some((step) => step.op === "click")).toBe(false);
    const dest = path.join(mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-")), "out.yaml");
    const written = writeCase(compiled, dest, true);
    expect(written[1].endsWith(".md")).toBe(true);
  });

  it("writes html json and markdown reports", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-report-"));
    const writer = new ReportWriter(root, "run-1", true);
    const shot = writer.saveScreenshot("search-docs", 1, "type", Buffer.from("\x89PNG"));
    const report = emptyReport({
      runId: "run-1",
      mode: "run",
      name: "demo",
      startedAt: isoformat(),
      cases: [
        {
          id: "search-docs",
          name: "搜索",
          source: "yaml",
          status: "pass",
          durationMs: 12,
          steps: [{ index: 1, op: "type", status: "pass", target: "searchbox 搜索", screenshot: shot, durationMs: 5 }],
        },
      ],
    });
    const paths = writer.write(report);
    const html = require("node:fs").readFileSync(paths.html, "utf8") as string;
    expect(html).toContain("搜索");
    expect(html).toContain(shot);
    expect(html).toContain('lang="en"');
    expect(html).not.toContain(">Test plan</h2>");
    expect(html).not.toContain("测试计划");
    expect(html).toContain("Pass rate");
    expect(html).not.toContain("Quality Control");
    expect(html).not.toContain("Case tempo");
    expect(passRate(report)).toBe(100);
    expect(renderMarkdown(report)).toContain("demo");
  });

  it("shows observe and Jev consume times on each step", () => {
    const report = emptyReport({
      runId: "run-times",
      mode: "auto",
      name: "demo",
      startedAt: isoformat(),
      model: "jev-latest",
      cases: [
        {
          id: "auto",
          name: "搜索",
          source: "auto",
          status: "pass",
          durationMs: 2400,
          steps: [
            {
              index: 1,
              op: "type",
              status: "pass",
              target: "13",
              value: "携程",
              durationMs: 1240,
              observeMs: 186,
              observed: {
                url: "https://example.com",
                title: "搜索",
                elements: [
                  { index: "2", role: "searchbox", name: "搜索", value: "", operations: ["TYPE", "CLICK"], within: "" },
                  { index: "8", role: "button", name: "登录", value: "", operations: ["CLICK"], within: "登录框" },
                ],
              },
              modelMs: 920,
              textMs: 140,
              textModel: "glm-5.3",
              textUsage: { inputTokens: 80, outputTokens: 6, totalTokens: 86 },
              actMs: 200,
              observeAfterMs: 40,
              assertVerdict: "pass",
              url: "https://example.com",
              title: "搜索",
              screenshotMs: 80,
              model: "jev-latest",
              modelUsage: { inputTokens: 1200, outputTokens: 86, totalTokens: 1286 },
              modelInput: "goal: 搜索",
              modelReply: "operation: TYPE\n  13 0.88",
              modelThought: "The search field is empty, so type the query.",
            },
          ],
        },
      ],
    });
    expect(formatStepTimes(report.cases[0].steps[0])).toBe(
      "Total 1.24s · Page elements 186 ms · Jev 920 ms · in 1,200 · out 86 · Glm 140 ms · in 80 · out 6 · Act 200 ms · Assert 40 ms · Screenshot 80 ms",
    );
    expect(formatStepTimes(report.cases[0].steps[0], "zh")).toBe(
      "总 1.24s · 获取页面元素 186 ms · Jev 920 ms · 输入 1,200 · 输出 86 · Glm 140 ms · 输入 80 · 输出 6 · 执行 200 ms · Jev 断言 40 ms · 截图 80 ms",
    );
    expect(modelConsumeLabel("qwen2.5")).toBe("Qwen");
    const html = renderHtml(report);
    expect(html).toContain('class="step-row no-shot"');
    expect(html).not.toContain('class="shots"');
    const row = html.slice(html.indexOf('class="step-row no-shot"'), html.indexOf('class="step-row no-shot"') + 500);
    expect(row).toContain("01 TYPE");
    expect(row).toContain("Type “携程”");
    expect(html).toContain('data-zh="输入「携程」"');
    expect(html).toContain('class="phase"');
    expect(html).toContain('data-zh="获取页面元素"');
    expect(html).toContain('data-en="Page elements"');
    expect(html).toContain("[2] searchbox 搜索 · TYPE, CLICK");
    expect(html).toContain("[8] button 登录 · CLICK");
    expect(html).toContain("登录框");
    expect(html).toContain(">186 ms</b>");
    expect(html).toContain('data-en="Decide"');
    expect(html).toContain('data-zh="Jev 决策"');
    expect(html).toContain(">Decide</em>");
    expect(html).toContain("in 1,200");
    expect(html).toContain("out 86");
    expect(html).toContain(">Glm</em>");
    expect(html).toContain("in 80");
    expect(html).toContain("out 6");
    expect(html).toContain('data-en="Type “携程”"');
    expect(html).toContain('data-zh="输入「携程」"');
    expect(html).not.toContain("avg 1.24s");
    expect(html).toContain('class="card-detail"');
    expect(html).toContain("The search field is empty, so type the query.");
    expect(html).toContain("operation: TYPE");
    expect(html).toContain("goal: 搜索");
    expect(html).toContain('data-zh="符合预期"');
    expect(html).toContain('data-en="As expected"');
    expect(html).toContain("预期：页面出现「携程」");
    expect(html).toContain("Expected “携程” to appear");
    expect(html).not.toContain("未完成");
    expect(html).not.toContain("Not recorded for this run");
    expect(html).not.toContain("这次运行没有记录");
    expect(html).not.toContain(">Test plan</h2>");
    expect(html).toContain('data-set-lang="zh"');
    expect(html).not.toContain('class="facts"');
    expect(html).not.toContain("jev-latest · 920 ms");
    expect(renderMarkdown(report)).toContain("jev: 920 ms");
  });

  it("keeps the task breakdown collapsed until opened", () => {
    const report = emptyReport({
      runId: "run-plan",
      mode: "auto",
      name: "demo",
      startedAt: isoformat(),
      cases: [
        {
          id: "auto",
          name: "搜航班",
          source: "auto",
          status: "fail",
          durationMs: 1000,
          plan: {
            steps: ["在百度搜索框中输入携程", "点击搜索"],
            doneWhen: "页面上显示了北京到昆明的航班列表",
            model: "deepseek-v4.1-flash",
            modelMs: 1200,
          },
          steps: [],
        },
      ],
    });
    const html = renderHtml(report);
    expect(html).toContain('<details class="outline">');
    expect(html).not.toContain('<details class="outline" open');
    expect(html).toContain("在百度搜索框中输入携程");
    expect(html).toContain("Done when: 页面上显示了北京到昆明的航班列表");
    expect(html).toContain('data-zh="任务拆解"');
    expect(html).toContain("Deepseek 1.2s");
  });

  it("shows suite start and end times", () => {
    const startedAt = "2026-09-22T02:47:37.891Z";
    const finishedAt = "2026-09-22T02:47:48.809Z";
    const report = emptyReport({
      runId: "run-clock",
      mode: "auto",
      name: "demo",
      startedAt,
      finishedAt,
    });
    const html = renderHtml(report);
    expect(formatClock("")).toBe("—");
    expect(formatDateTime("nope")).toBe("—");
    expect(html).toContain(`>${formatClock(startedAt)}</b>`);
    expect(html).toContain(`>${formatClock(finishedAt)}</b>`);
    expect(html).toContain(`title="${formatDateTime(startedAt)}"`);
    expect(html).toContain(`title="${formatDateTime(finishedAt)}"`);
    expect(html).toContain('data-en="Start"');
    expect(html).toContain('data-zh="开始"');
    expect(html).toContain('data-en="End"');
    expect(html).toContain('data-zh="结束"');
    expect(renderMarkdown(report)).toContain(`- started: ${formatDateTime(startedAt)}`);
    expect(renderMarkdown(report)).toContain(`- finished: ${formatDateTime(finishedAt)}`);
  });

  it("names the report folder with local time", () => {
    const moment = new Date(Date.UTC(2026, 8, 22, 13, 22, 6));
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = `${moment.getFullYear()}${pad(moment.getMonth() + 1)}${pad(moment.getDate())}-${pad(moment.getHours())}${pad(moment.getMinutes())}${pad(moment.getSeconds())}`;
    expect(runId(moment)).toBe(local);
  });

  it("parses Jev and OpenAI usage payloads", () => {
    expect(parseModelUsage({ input_tokens: 12, output_tokens: 3 })).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
    });
    expect(parseModelUsage({ prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 })).toEqual({
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 10,
    });
  });
});
