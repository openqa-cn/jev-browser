import { describe, expect, it } from "vitest";
import { resolveTarget } from "../src/cases.js";
import { DecisionError, LocatorMiss } from "../src/errors.js";
import { contentKey } from "../src/observe/snapshot.js";
import { applyHistoryGuards, buildSpace, packForModel, parseDecision, parseModelJson, ScriptedProvider, validateDecision } from "../src/policy.js";
import type { ObservedElement, PageState } from "../src/types.js";

function page(...elements: ObservedElement[]): PageState {
  return {
    url: "https://example.com",
    title: "t",
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
  return {
    name: "",
    value: "",
    operations: [],
    within: "",
    nearby: "",
    options: [],
    ...partial,
  };
}

describe("locator and policy", () => {
  it("matches unique names and fails closed on ambiguity", () => {
    const state = page(
      el({ index: "1", node: 1, role: "button", name: "Save", operations: ["CLICK"] }),
      el({ index: "2", node: 2, role: "button", name: "Save draft", operations: ["CLICK"] }),
      el({ index: "3", node: 3, role: "searchbox", name: "搜索", operations: ["TYPE", "CLICK"] }),
    );
    expect(resolveTarget(state, { role: "searchbox", name: "搜索" }).element.index).toBe("3");
    expect(resolveTarget(state, { role: "button", name: "Save" }).element.index).toBe("1");
    expect(resolveTarget(state, { role: "button", name: "Save draft" }).element.index).toBe("2");
    const twins = page(
      el({ index: "1", node: 1, role: "button", name: "OK", operations: ["CLICK"] }),
      el({ index: "2", node: 2, role: "button", name: "OK", operations: ["CLICK"] }),
    );
    expect(() => resolveTarget(twins, { role: "button", name: "OK" })).toThrow(LocatorMiss);
  });

  it("rejects bad indexes and selector-like decisions", () => {
    const space = buildSpace(page(el({ index: "1", node: 1, role: "button", name: "Go", operations: ["CLICK"] })));
    expect(() => validateDecision({ operation: "CLICK", clickTarget: "99" }, space)).toThrow(DecisionError);
    expect(() =>
      validateDecision({ operation: "CLICK", clickTarget: "1", reason: "document.querySelector('a')" }, space),
    ).toThrow(DecisionError);
  });

  it("binds scripted semantic targets to live indexes", () => {
    const state = page(el({ index: "4", node: 4, role: "link", name: "Pilot 入门", operations: ["CLICK"] }));
    const space = buildSpace(state);
    const provider = new ScriptedProvider([{ operation: "CLICK", target: { role: "link", name: "Pilot 入门" } }]);
    expect(provider.choose(state, "open", [], space).clickTarget).toBe("4");
  });

  it("maps a generic target index onto TYPE/CLICK", () => {
    const space = buildSpace(page(el({ index: "1", node: 1, role: "searchbox", name: "搜索", operations: ["TYPE", "CLICK"] })));
    const typed = validateDecision(parseDecision({ operation: "TYPE", target: "1", text: "携程" }), space);
    expect(typed.typeTarget).toBe("1");
    expect(typed.text).toBe("携程");
    expect(validateDecision(parseDecision({ operation: "CLICK", target: 1 }), space).clickTarget).toBe("1");
  });

  it("treats animation as the same page when the controls stay put", () => {
    const controls = [el({ index: "1", node: 1, role: "button", name: "搜索", operations: ["CLICK"] })];
    const left = page(...controls);
    const right = page(...controls);
    right.text = "轮播 00:01";
    right.scroll = { y: 12 };
    right.elements = controls.map((item) => ({ ...item, index: "9", node: 9 }));
    expect(contentKey(left)).toBe(contentKey(right));
  });

  it("keeps named links in the model payload regardless of length", () => {
    const space = buildSpace(
      page(
        el({ index: "1", node: 1, role: "searchbox", name: "搜索", operations: ["TYPE", "CLICK"] }),
        el({ index: "2", node: 2, role: "button", name: "百度一下", operations: ["CLICK"] }),
        el({
          index: "3",
          node: 3,
          role: "link",
          name: "1某个很长的时政新闻标题不要发给网关",
          operations: ["CLICK"],
        }),
      ),
    );
    const packed = packForModel(space);
    expect(packed.elements.join("\n")).toContain("搜索");
    expect(packed.elements.join("\n")).toContain("时政新闻");
    expect(packed.click_targets).toEqual(["1", "2", "3"]);
  });

  it("keeps long product links and drops unnamed links", () => {
    const space = buildSpace(
      page(
        el({ index: "1", node: 1, role: "link", name: "", href: "https://www.jd.com/", operations: ["CLICK"] }),
        el({
          index: "2",
          node: 2,
          role: "link",
          name: "Apple iPhone 17 Pro Max 256GB",
          href: "https://item.jd.com/1001.html",
          operations: ["CLICK"],
        }),
      ),
    );
    const packed = packForModel(space);
    expect(packed.elements.join("\n")).toContain("iPhone 17 Pro Max");
    expect(packed.elements.join("\n")).toContain("item.jd.com");
    expect(packed.click_targets).toEqual(["2"]);
  });

  it("parses model JSON wrapped in whitespace", () => {
    expect(parseModelJson('\n{"operation":"WAIT","reason":"probe"}\n')).toEqual({
      operation: "WAIT",
      reason: "probe",
    });
  });

  it("after TYPE into a chooser, requires clicking a list option before another TYPE", () => {
    const space = buildSpace(
      page(
        el({ index: "38", node: 38, role: "textbox", name: "请输入出发地", operations: ["TYPE", "CLICK"] }),
        el({ index: "39", node: 39, role: "textbox", name: "请输入目的地", operations: ["TYPE", "CLICK"] }),
        el({ index: "51", node: 51, role: "textbox", name: "可输入城市或机场", operations: ["TYPE", "CLICK"] }),
        el({ index: "40", node: 40, role: "option", name: "上海", operations: ["CLICK"], within: "chooser" }),
      ),
    );
    const guarded = applyHistoryGuards(space, [
      {
        op: "type",
        page_changed: false,
        text: "北京",
        action: "textbox 请输入出发地",
        matched: { index: "38", role: "textbox", name: "请输入出发地", operations: ["TYPE", "CLICK"] },
      },
    ]);
    expect(guarded.typeTargets["38"]).toBeUndefined();
    expect(guarded.typeTargets["39"]).toBeUndefined();
    expect(guarded.typeTargets["51"]).toBeUndefined();
    expect(guarded.clickTargets["40"]).toBeDefined();
  });

  it("does not treat a filled chooser as done just because it has a value", () => {
    const space = buildSpace(
      page(
        el({
          index: "38",
          node: 38,
          role: "textbox",
          name: "请输入出发地",
          value: "北京(BJS)",
          operations: ["TYPE", "CLICK"],
        }),
        el({
          index: "39",
          node: 39,
          role: "textbox",
          name: "请输入目的地",
          value: "北京(BJS)",
          operations: ["TYPE", "CLICK"],
        }),
      ),
    );
    const guarded = applyHistoryGuards(space, []);
    expect(guarded.typeTargets["38"]).toBeDefined();
    expect(guarded.typeTargets["39"]).toBeDefined();
  });

  it("while a chooser is open, does not re-click the trigger field", () => {
    const space = buildSpace(
      page(
        el({ index: "44", node: 44, role: "textbox", name: "请选择日期", operations: ["TYPE", "CLICK"] }),
        el({ index: "45", node: 45, role: "textbox", name: "请选择日期", operations: ["TYPE", "CLICK"] }),
        el({ index: "70", node: 70, role: "option", name: "10月 7", operations: ["CLICK"], within: "chooser" }),
      ),
    );
    const guarded = applyHistoryGuards(space, [
      { op: "click", matched: { index: "44", role: "textbox", name: "请选择日期", operations: ["TYPE", "CLICK"] } },
    ]);
    expect(guarded.clickTargets["44"]).toBeUndefined();
    expect(guarded.clickTargets["45"]).toBeUndefined();
    expect(guarded.clickTargets["70"]).toBeDefined();
  });

  it("allows the next chooser TYPE after an option is clicked", () => {
    const space = buildSpace(
      page(
        el({
          index: "38",
          node: 38,
          role: "textbox",
          name: "请输入出发地",
          value: "北京(BJS)",
          operations: ["TYPE", "CLICK"],
        }),
        el({ index: "39", node: 39, role: "textbox", name: "请输入目的地", operations: ["TYPE", "CLICK"] }),
        el({ index: "40", node: 40, role: "option", name: "上海", operations: ["CLICK"], within: "chooser" }),
      ),
    );
    const guarded = applyHistoryGuards(space, [
      { op: "type", text: "北京", matched: { index: "38", role: "textbox", operations: ["TYPE", "CLICK"] } },
      { op: "click", matched: { index: "40", name: "上海", role: "option" } },
    ]);
    expect(guarded.typeTargets["39"]).toBeDefined();
  });
});
