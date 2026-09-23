import { afterEach, describe, expect, it, vi } from "vitest";
import { buildJevRequest, createDecisionProvider, decisionModelLabel, JevProvider, jevAssert, jevConfirmDone, parseJevAnswers } from "../src/jev.js";
import { buildSpace, ScriptedProvider } from "../src/policy.js";
import { defaultConfig } from "../src/config.js";
import * as modelHttp from "../src/model-http.js";
import type { ObservedElement, PageState } from "../src/types.js";

function page(...elements: ObservedElement[]): PageState {
  return {
    url: "https://www.baidu.com/",
    title: "百度",
    text: "",
    elements,
    scroll: {},
    pageKey: "k",
    marker: "m",
    guards: {},
    fingerprint: "f",
  };
}

function el(partial: Partial<ObservedElement> & Pick<ObservedElement, "index" | "node" | "role">): ObservedElement {
  return { name: "", value: "", operations: [], within: "", nearby: "", options: [], ...partial };
}

describe("jev provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers Jev in the model label when a TypeSafe key exists", () => {
    const config = defaultConfig();
    config.model.typesafeApiKey = "apikey_test";
    config.model.typesafeModel = "jev-latest";
    expect(decisionModelLabel(config)).toBe("jev-latest");
    expect(createDecisionProvider(config).constructor.name).toBe("JevProvider");
  });

  it("keeps scripted decisions ahead of Jev", () => {
    const config = defaultConfig();
    config.model.typesafeApiKey = "apikey_test";
    const provider = createDecisionProvider(config, [{ operation: "DONE" }]);
    expect(provider).toBeInstanceOf(ScriptedProvider);
  });

  it("builds a systemone choice request without page news text", () => {
    const space = buildSpace(
      page(
        el({ index: "13", node: 13, role: "textbox", name: "", operations: ["TYPE", "CLICK"] }),
        el({ index: "14", node: 14, role: "button", name: "百度一下", operations: ["CLICK"] }),
        el({
          index: "15",
          node: 15,
          role: "link",
          name: "1某个很长的时政新闻标题不要发给网关",
          operations: ["CLICK"],
        }),
      ),
    );
    const config = defaultConfig();
    config.model.typesafeModel = "jev-latest";
    const body = buildJevRequest(config, { url: "https://www.baidu.com/", title: "百度" }, "搜索携程", [], space);
    const questions = body.questions as Record<string, { criteria: Record<string, unknown> }>;
    expect(body.model).toBe("jev-latest");
    expect((body.state as { page: { text?: string } }).page.text).toBeUndefined();
    expect(Object.keys(questions.operation.criteria)).toContain("CLICK");
    expect(Object.keys(questions.click_target.criteria)).toEqual(["13", "14", "15"]);
    expect(Object.keys(questions.type_target.criteria)).toEqual(["13"]);
    expect(Object.keys(questions.text_13.criteria)).toContain("携程");
    expect(JSON.stringify(body.state)).toContain("时政新闻");
  });

  it("asks Jev whether the action took effect", async () => {
    vi.spyOn(modelHttp, "modelFetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { questions: { verdict: { criteria: Record<string, string> } } };
      expect(Object.keys(body.questions.verdict.criteria)).toEqual(["pass", "fail"]);
      return new Response(
        JSON.stringify({
          answers: { verdict: { choice: "pass", confidence: 0.8 } },
          model: "jev-1.13.0",
          usage: { input_tokens: 20, output_tokens: 4 },
        }),
        { status: 200 },
      );
    });
    const config = defaultConfig();
    config.model.typesafeApiKey = "apikey_test";
    config.model.typesafeBaseUrl = "https://typesafe.example/v1";
    const judged = await jevAssert(config, {
      op: "type",
      value: "携程旅行网",
      after: {
        url: "https://www.baidu.com/",
        title: "百度一下",
        elements: [{ index: "1", role: "textbox", name: "搜索", value: "携程旅行网", operations: [], within: "" }],
      },
    });
    expect(judged.verdict).toBe("pass");
    expect(judged.model).toBe("jev-1.13.0");
    expect(judged.reply).toContain("verdict: pass");
  });

  it("omits secret field values from the Jev payload", () => {
    const space = buildSpace(
      page(
        el({ index: "1", node: 1, role: "textbox", name: "密码", value: "super-secret", operations: ["TYPE"] }),
        el({ index: "2", node: 2, role: "textbox", name: "用户名", value: "demo", operations: ["TYPE"] }),
      ),
    );
    const body = buildJevRequest(
      defaultConfig(),
      { url: "https://example.com/login", title: "login" },
      "登录",
      [{ op: "type", text: "super-secret", matched: { name: "密码" } }],
      space,
    );
    const state = body.state as {
      elements: { name: string; value: string }[];
      recent_actions: { text?: string }[];
    };
    expect(state.elements.find((item) => item.name === "密码")?.value).toBe("");
    expect(state.elements.find((item) => item.name === "用户名")?.value).toBe("demo");
    expect(state.recent_actions[0].text).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("super-secret");
  });

  it("labels a click target with the link host", () => {
    const space = buildSpace(
      page(
        el({
          index: "15",
          node: 15,
          role: "link",
          name: "携程官网",
          operations: ["CLICK"],
          href: "https://www.baidu.com/s?wd=%E6%90%BA%E7%A8%8B%E5%AE%98%E7%BD%91",
        }),
        el({
          index: "22",
          node: 22,
          role: "link",
          name: "www.ctrip.com",
          operations: ["CLICK"],
          href: "https://www.ctrip.com/",
        }),
      ),
    );
    const body = buildJevRequest(defaultConfig(), { url: "https://www.baidu.com/s", title: "携程_百度搜索" }, "打开携程官网", [], space);
    const criteria = (body.questions as { click_target: { criteria: Record<string, { element: string }> } }).click_target.criteria;
    expect(criteria["15"].element).toContain("baidu.com/s");
    expect(criteria["22"].element).toContain("ctrip.com");
  });

  it("maps Jev answers onto a CLICK decision", () => {
    const decision = parseJevAnswers({
      operation: { choice: "CLICK" },
      click_target: { choice: "14" },
    });
    expect(decision.operation).toBe("CLICK");
    expect(decision.clickTarget).toBe("14");
  });

  it("asks Jev whether the done condition is visible", async () => {
    vi.spyOn(modelHttp, "modelFetch").mockImplementation(async (url, init) => {
      expect(String(url)).toContain("/systemone");
      const body = JSON.parse(String(init?.body)) as { questions: { done: { criteria: Record<string, string> } } };
      expect(Object.keys(body.questions.done.criteria)).toEqual(["met", "unmet"]);
      return new Response(
        JSON.stringify({
          answers: { done: { choice: "met", confidence: 0.8 } },
          model: "jev-1.13.0",
          usage: { input_tokens: 30, output_tokens: 6 },
        }),
        { status: 200 },
      );
    });
    const config = defaultConfig();
    config.model.typesafeApiKey = "apikey_test";
    config.model.typesafeBaseUrl = "https://typesafe.example/v1";
    const checked = await jevConfirmDone(
      config,
      { url: "https://flights.ctrip.com/online/list/round-bjs-kmg?depdate=2026-10-01_2026-10-07", title: "北京到昆明", text: "", elements: [] },
      "页面上可见北京到昆明的航班列表",
    );
    expect(checked.met).toBe(true);
    expect(checked.model).toBe("jev-1.13.0");
    expect(checked.reply).toContain("done: met");
  });

  it("maps the typed characters chosen for that field", () => {
    const decision = parseJevAnswers({
      operation: { choice: "TYPE" },
      type_target: { choice: "13" },
      text_13: { choice: "携程" },
      text_14: { choice: "北京" },
    });
    expect(decision.operation).toBe("TYPE");
    expect(decision.typeTarget).toBe("13");
    expect(decision.text).toBe("携程");
  });

  it("attaches Jev consume time and token usage", async () => {
    vi.spyOn(modelHttp, "modelFetch").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(
        JSON.stringify({
          answers: {
            operation: { choice: "CLICK", reasoning: "The search button is the next step." },
            click_target: {
              choice: "14",
              confidence: 0.91,
              probabilities: { "14": 0.91, "2": 0.09 },
            },
          },
          reasoning: "Need to open search.",
          model: "jev-1.13.0",
          usage: { input_tokens: 1200, output_tokens: 20 },
        }),
        { status: 200 },
      );
    });
    const config = defaultConfig();
    config.model.typesafeApiKey = "apikey_test";
    config.model.typesafeModel = "jev-latest";
    const space = buildSpace(
      page(el({ index: "14", node: 14, role: "button", name: "百度一下", operations: ["CLICK"] })),
    );
    const decision = await new JevProvider(config).choose(page(), "搜索携程", [], space);
    expect(decision.operation).toBe("CLICK");
    expect(decision.model).toBe("jev-1.13.0");
    expect(decision.modelMs).toBeGreaterThanOrEqual(20);
    expect(decision.modelUsage).toEqual({ inputTokens: 1200, outputTokens: 20, totalTokens: 1220 });
    expect(decision.thought).toContain("Need to open search.");
    expect(decision.thought).toContain("operation: The search button is the next step.");
    expect(decision.reply).toContain("operation: CLICK");
    expect(decision.reply).toContain("14 0.91");
    expect(decision.input).toContain("goal: 搜索携程");
  });

});
