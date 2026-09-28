import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, finishAutoStatus } from "../src/agent.js";
import * as act from "../src/act.js";
import type { BrowserSession } from "../src/browser.js";
import { defaultConfig } from "../src/config.js";
import { StalePage } from "../src/errors.js";
import { acceptKnowledgeDraft, draftKnowledgeNote } from "../src/knowledge-draft.js";
import { retrieveKnowledge } from "../src/knowledge.js";
import * as modelHttp from "../src/model-http.js";
import { OpenAIProvider, ScriptedProvider, type ActionSpace } from "../src/policy.js";
import { ReportWriter } from "../src/report.js";
import type { Decision, PageState } from "../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auto result", () => {
  it("does not pass a run that never reached DONE", () => {
    expect(finishAutoStatus("pass", [{ op: "open", status: "pass" }], 4)).toEqual({
      status: "blocked",
      error: "stopped at 4 steps",
    });
    expect(
      finishAutoStatus(
        "pass",
        [{ op: "type", status: "fail", error: "action had no visible effect" }],
        4,
        "action had no visible effect",
      ),
    ).toEqual({ status: "fail", error: "action had no visible effect" });
    expect(finishAutoStatus("pass", [{ op: "done", status: "pass" }], 4)).toEqual({ status: "pass", error: undefined });
  });

  it("asks the text model for a field the goal did not name", async () => {
    const fetchMock = vi.spyOn(modelHttp, "modelFetch").mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: "北京" }) } }], model: "small-text" }),
        { status: 200 },
      ),
    );
    const state: PageState = {
      url: "https://example.com/form",
      title: "Form",
      text: "",
      elements: [
        {
          index: "1",
          node: 1,
          role: "textbox",
          name: "备注",
          value: "",
          operations: ["TYPE"],
          within: "",
          nearby: "",
          options: [],
        },
      ],
      scroll: {},
      pageKey: "k",
      marker: "m",
      guards: {},
      fingerprint: "f",
    };
    const session = {
      url: state.url,
      lastObserveMs: 1,
      page: null,
      observe: async () => state,
      title: async () => state.title,
      screenshot: async () => Buffer.from("x"),
    } as unknown as BrowserSession;
    const config = defaultConfig();
    config.model.apiKey = "test-key";
    config.model.baseUrl = "https://text.example/v1";
    config.model.textModel = "small-text";
    config.maxSteps = 3;
    const writer = new ReportWriter(mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-agent-")), "agent-1", false);
    const agent = new Agent(session, writer, config, {
      script: [{ operation: "TYPE", target: { role: "textbox", name: "备注" } }],
    });
    const { result } = await agent.run(state.url, "在备注里填写出发城市");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).not.toBe("pass");
    expect(result.steps.some((step) => step.op === "type" && step.status === "skip")).toBe(true);
  });

  it("does not type OpenAI text that is not already in the goal", async () => {
    let calls = 0;
    vi.spyOn(modelHttp, "modelFetch").mockImplementation(async () => {
      calls += 1;
      const content =
        calls === 1
          ? JSON.stringify({ steps: ["填写北京", "看到北京"], done_when: "页面上有北京" })
          : calls === 2
            ? JSON.stringify({ operation: "TYPE", type_target: "1", text: "完全不相关的句子" })
            : JSON.stringify({ text: "另一句不相关" });
      return new Response(JSON.stringify({ choices: [{ message: { content } }], model: "gpt-test" }), { status: 200 });
    });
    const state: PageState = {
      url: "https://example.com/form",
      title: "Form",
      text: "",
      elements: [
        {
          index: "1",
          node: 1,
          role: "textbox",
          name: "备注",
          value: "",
          operations: ["TYPE"],
          within: "",
          nearby: "",
          options: [],
        },
      ],
      scroll: {},
      pageKey: "k",
      marker: "m",
      guards: {},
      fingerprint: "f",
    };
    const session = {
      url: state.url,
      lastObserveMs: 1,
      page: null,
      observe: async () => state,
      title: async () => state.title,
      screenshot: async () => Buffer.from("x"),
    } as unknown as BrowserSession;
    const config = defaultConfig();
    config.model.apiKey = "test-key";
    config.model.baseUrl = "https://text.example/v1";
    config.maxSteps = 3;
    const writer = new ReportWriter(mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-openai-")), "agent-2", false);
    const agent = new Agent(session, writer, config, { provider: new OpenAIProvider(config) });
    const { result } = await agent.run(state.url, "填写北京");
    expect(result.steps.some((step) => step.op === "type" && step.status === "skip")).toBe(true);
    expect(result.steps.some((step) => step.value === "完全不相关的句子")).toBe(false);
  });

  it("asks the decision model again after a stale click on the same snapshot", async () => {
    const provider = new RecordingScript([
      { operation: "CLICK", target: { role: "button", name: "搜索" } },
      { operation: "DONE" },
    ]);
    let attempts = 0;
    vi.spyOn(act, "execute").mockImplementation(async () => {
      attempts += 1;
      if (attempts <= 2) throw new StalePage("Target changed, is covered, or is no longer actionable");
    });
    const state = flightPage();
    const session = fakeSession(state);
    const writer = new ReportWriter(mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-stale-")), "agent-stale", false);
    const agent = new Agent(session, writer, defaultConfig(), { provider });
    const { result, history } = await agent.run(state.url, "从天津到上海并搜索航班");
    expect(provider.spaces).toHaveLength(2);
    expect(provider.spaces[0]?.clickTargets["18"]).toBeDefined();
    expect(provider.spaces[1]?.clickTargets["18"]).toBeUndefined();
    expect(provider.spaces[1]?.clickTargets["7"]).toBeDefined();
    expect(history).toContainEqual({ op: "stale", matched: { index: "18" }, page_changed: false });
    expect(result.steps.some((step) => step.op === "done" && step.status === "pass")).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("still stops after three identical snapshots when an executed action changes nothing", async () => {
    const provider = new RecordingScript([
      { operation: "CLICK", target: { role: "button", name: "搜索" } },
      { operation: "CLICK", target: { role: "button", name: "10月 1" } },
      { operation: "CLICK", target: { role: "button", name: "10月 1" } },
      { operation: "DONE" },
    ]);
    const execute = vi.spyOn(act, "execute").mockResolvedValue(undefined);
    const state = flightPage();
    const session = fakeSession(state);
    const writer = new ReportWriter(mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-same-")), "agent-same", false);
    const agent = new Agent(session, writer, defaultConfig(), { provider });
    const { result } = await agent.run(state.url, "从天津到上海并搜索航班");
    expect(provider.spaces).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("blocked");
    expect(result.error).toBe("page did not change after 3 actions");
  });
});

class RecordingScript extends ScriptedProvider {
  spaces: ActionSpace[] = [];

  choose(page: PageState, goal: string, history: Record<string, unknown>[], space: ActionSpace): Decision {
    this.spaces.push(space);
    return super.choose(page, goal, history, space);
  }
}

function flightPage(): PageState {
  return {
    url: "https://flights.example/home",
    title: "机票",
    text: "",
    elements: [
      {
        index: "18",
        node: 18,
        role: "button",
        name: "搜索",
        value: "",
        operations: ["CLICK"],
        within: "",
        nearby: "",
        options: [],
      },
      {
        index: "7",
        node: 7,
        role: "button",
        name: "10月 1",
        value: "",
        operations: ["CLICK"],
        within: "",
        nearby: "",
        options: [],
      },
    ],
    scroll: {},
    pageKey: "k",
    marker: "m",
    guards: {},
    fingerprint: "f",
  };
}

function fakeSession(state: PageState): BrowserSession {
  return {
    url: state.url,
    lastObserveMs: 1,
    page: null,
    observe: async () => state,
    title: async () => state.title,
    screenshot: async () => Buffer.from("x"),
  } as unknown as BrowserSession;
}

describe("knowledge draft", () => {
  it("drafts a note from the failed control and writes it only when accepted", () => {
    const note = draftKnowledgeNote({
      url: "https://www.example.com/login",
      goal: "打开「工作台」并不要点退出",
      steps: [
        {
          index: 2,
          op: "click",
          status: "fail",
          durationMs: 1,
          matched: { role: "button", name: "退出" },
          candidates: [{ role: "link", name: "工作台" }],
        },
      ],
    });
    expect(note).toContain("hosts:\n  - example.com");
    expect(note).toContain("不要点 button「退出」");
    expect(note).not.toContain("使用 link");
    const root = mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-draft-"));
    const draft = path.join(root, "knowledge-draft.md");
    writeFileSync(draft, note ?? "");
    const dest = acceptKnowledgeDraft(draft, root);
    expect(dest).toContain(`${path.sep}example${path.sep}`);
    expect(path.basename(dest)).toContain("工作台");
    expect(path.basename(dest)).not.toBe("case.md");
    expect(readFileSync(dest, "utf8")).toContain("不要点 button「退出」");
    expect(() => acceptKnowledgeDraft(draft, root)).toThrow(/already exists/);

    const moved = draftKnowledgeNote({
      url: "https://flights.ctrip.com/home",
      goal: "打开「机票」",
      steps: [
        {
          index: 2,
          op: "type",
          status: "fail",
          error: "action had no visible effect",
          durationMs: 1,
          matched: { role: "textbox", name: "出发地" },
          candidates: [{ role: "textbox", name: "目的地" }],
        },
      ],
    });
    expect(moved).toContain("hosts:\n  - ctrip.com");
    expect(moved).toContain("app: ctrip");
    expect(moved).toContain("没有留下可见效果");
    expect(moved).not.toContain("不要点");
    expect(moved).not.toContain("目的地");

    const plain = draftKnowledgeNote({
      url: "https://shop.example.co.uk/home",
      goal: "登录并打开首页",
      steps: [{ index: 2, op: "click", status: "fail", durationMs: 1, matched: { role: "button", name: "登录" } }],
    });
    expect(plain).toContain("hosts:\n  - example.co.uk");
    expect(plain).toContain("app: example");
    expect(plain).toContain("登录并打开首页");
    expect(plain).not.toContain("失败");

    const english = draftKnowledgeNote({
      url: "https://example.com/docs",
      goal: "Open the Pilot docs",
      steps: [{ index: 2, op: "click", status: "fail", durationMs: 1, matched: { role: "link", name: "Docs" } }],
    });
    expect(english).toContain("Open the Pilot docs");
    expect(english).not.toContain("OpenthePilot");

    const escaped = path.join(root, "escape.md");
    writeFileSync(escaped, "---\napp: ../../outside\ntitle: 越界\n---\n\n不要写到外面。\n");
    const kept = acceptKnowledgeDraft(escaped, root);
    expect(kept.startsWith(root)).toBe(true);
    expect(kept).not.toContain("..");
  });
});

describe("knowledge keywords", () => {
  it("matches English keywords without requiring the goal to already be lowercase", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codexqa-jev-browser-notes-"));
    const dir = path.join(root, "demo");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "pilot.md"), "---\napp: demo\nkeywords:\n  - Pilot\n---\n\nUse the Pilot doc link.\n");
    expect(retrieveKnowledge({ goal: "Open the Pilot docs", root })).toContain("Use the Pilot doc link.");
  });
});
