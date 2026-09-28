import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, finishAutoStatus } from "../src/agent.js";
import type { BrowserSession } from "../src/browser.js";
import { defaultConfig } from "../src/config.js";
import { retrieveKnowledge } from "../src/knowledge.js";
import * as modelHttp from "../src/model-http.js";
import { ReportWriter } from "../src/report.js";
import type { PageState } from "../src/types.js";

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
    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe("small-text");
    expect(body.messages[0].content).toContain("characters to type");
    expect(result.status).toBe("fail");
    expect(result.steps.some((step) => step.op === "type")).toBe(true);
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
