import { describe, expect, it, vi } from "vitest";
import * as modelHttp from "../src/model-http.js";
import { retrieveKnowledge } from "../src/knowledge.js";
import { confirmDone, fieldText, guideGoal, planTask, searchQueryFromGoal, typeCandidates } from "../src/policy.js";
import { assessActionEffect } from "../src/verify.js";
import { defaultConfig } from "../src/config.js";

const sanyaGoal =
  "从百度搜索「携程旅行网」并打开携程官网。进入国内机票。选择往返。出发地北京，目的地三亚（不是上海、不是深圳）。去程2026-10-01，返程2026-10-07。";

describe("step timing shortcuts", () => {
  it("reads a search query from the goal only for the search box", () => {
    const jd = "打开京东，搜索 iPhone 18 Pro Max，进入搜索结果并看到价格。";
    expect(searchQueryFromGoal(jd, { role: "textbox", name: "搜索" })).toBe("iPhone 18 Pro Max");
    expect(searchQueryFromGoal("在百度搜索携程，打开携程官网。", { role: "searchbox", name: "" })).toBe("携程");
    expect(searchQueryFromGoal("搜索「AI 新闻」，进入结果。", { role: "textbox", name: "搜索" })).toBe("AI 新闻");
    expect(searchQueryFromGoal(jd, { role: "textbox", name: "出发地 可输入城市或机场" })).toBeUndefined();
    expect(searchQueryFromGoal("出发地填北京，目的地填昆明。", { role: "textbox", name: "搜索" })).toBeUndefined();
  });

  it("lists typeable phrases from the goal for Jev to choose", () => {
    const goal = "在百度搜索携程，打开携程官网。出发地填北京，目的地填昆明。去程日期选2026年10月1日。";
    expect(typeCandidates(goal)).toEqual(["携程", "北京", "昆明", "2026年10月1日"]);
    const guided = `${goal}\n\nBusiness notes (reference only):\n不要输入「上海」`;
    expect(typeCandidates(guided)).not.toContain("上海");
  });

  it("attaches matching business notes for the text model", async () => {
    const notes = retrieveKnowledge({ goal: sanyaGoal, url: "https://www.baidu.com/" });
    expect(notes).toContain("携程国内机票");
    expect(notes).toContain("出现登录弹窗，就停止");
    expect(notes).toContain("不要点相邻月");
    expect(notes).toContain("不要再点「机票」");
    expect(notes).toContain("低价速报");
    expect(notes).toContain("e.baidu.com");
    expect(notes).toContain("星期表头");
    expect(notes).toContain("百度搜索");
    expect(notes).not.toContain("官方旗舰");
    const fetchMock = vi.spyOn(modelHttp, "modelFetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: "随便写一点" }) } }], model: "small-text" }), {
        status: 200,
      }),
    );
    const unmatched = await fieldText(
      { goal: sanyaGoal, field: { role: "textbox", name: "备注", value: "" }, knowledge: notes },
      { ...defaultConfig(), model: { ...defaultConfig().model, apiKey: "test-key", textModel: "small-text", baseUrl: "https://text.example/v1" } },
    );
    expect(unmatched.text).toBe("随便写一点");
    expect(unmatched.helper.model).toBe("small-text");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe("small-text");
    expect(body.messages[1].content).toContain("不要点相邻月");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("checks the page after the action, not whether the whole goal is done", () => {
    const before = {
      url: "https://www.baidu.com/",
      title: "百度一下，你就知道",
      elements: [{ index: "1", role: "button", name: "百度一下", value: "", operations: ["CLICK"], within: "" }],
    };
    expect(
      assessActionEffect({
        op: "click",
        before,
        after: {
          url: "https://www.baidu.com/s?wd=携程",
          title: "携程旅行网_百度搜索",
          text: "",
          elements: [],
        },
      }),
    ).toBe("pass");
    expect(
      assessActionEffect({
        op: "click",
        before,
        after: {
          url: before.url,
          title: before.title,
          text: "",
          elements: [{ name: "百度一下", value: "", role: "button" }],
        },
      }),
    ).toBe("fail");
    expect(
      assessActionEffect({
        op: "type",
        value: "携程旅行网",
        before,
        after: {
          url: before.url,
          title: before.title,
          text: "",
          elements: [{ name: "搜索", value: "携程旅行网" }],
        },
      }),
    ).toBe("pass");
  });

  it("turns a goal into planned steps and a visible done condition", async () => {
    vi.spyOn(modelHttp, "modelFetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  steps: ["搜索携程并打开官网", "进入国内机票并选择往返", "填写北京到三亚和日期", "搜索并看到航班列表"],
                  done_when: "页面上能看到北京到三亚、去程2026-10-01、返程2026-10-07的往返航班列表或报价",
                }),
              },
            },
          ],
          model: "glm-5.3-flash",
        }),
        { status: 200 },
      ),
    );
    const config = defaultConfig();
    config.model.apiKey = "test-key";
    config.model.baseUrl = "https://planner.example/v1";
    const plan = await planTask(sanyaGoal, config);
    expect(plan.steps).toHaveLength(4);
    expect(plan.doneWhen).toContain("往返航班列表或报价");
    expect(plan.model).toBe("glm-5.3-flash");
    expect(plan.modelMs).toBeGreaterThanOrEqual(0);
    const guided = guideGoal(sanyaGoal, plan);
    expect(guided).toContain("1. 搜索携程并打开官网");
    expect(guided).toContain("Done only when this is visibly true: 页面上能看到北京到三亚");
    expect(guided).toContain("Choose DONE only when that evidence is on the current page");
    vi.restoreAllMocks();
  });

  it("asks the planner model whether the done condition is visible", async () => {
    const fetchMock = vi.spyOn(modelHttp, "modelFetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ met: true }) } }] }), { status: 200 }),
    );
    const config = defaultConfig();
    config.model.apiKey = "test-key";
    config.model.baseUrl = "https://planner.example/v1";
    const page = {
      url: "https://www.xiaohongshu.com/search_result_ai?keyword=AI",
      title: "AI最新新闻 - 小红书搜索",
      text: "",
      elements: [{ role: "link", name: "2026年9月22日 AI 早间重磅新闻", value: "" }],
    };
    const doneWhen = "屏幕上清晰显示了包含至少5条带有标题的笔记搜索结果列表。";
    await expect(confirmDone(page, doneWhen, config)).resolves.toBe(true);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const user = JSON.parse(body.messages[1].content);
    expect(user.done_when).toBe(doneWhen);
    expect(user.page.title).toBe(page.title);
    expect(user.page.controls[0].name).toBe("2026年9月22日 AI 早间重磅新闻");
    expect(body.messages[0].content).toContain("not a sentence that must appear verbatim");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ met: false }) } }] }), { status: 200 }),
    );
    await expect(confirmDone(page, doneWhen, config)).resolves.toBe(false);
    await expect(confirmDone(page, "   ", config)).resolves.toBe(false);
    vi.restoreAllMocks();
  });
});
