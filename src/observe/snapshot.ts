import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { StalePage } from "../errors.js";
import type { ControlSnapshot, ObservedElement, PageState } from "../types.js";
import { publicValue, stableHash } from "../util.js";

const SCRIPT = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "snapshot.dom.js"), "utf8");

export async function collectSnapshot(page: Page, maxElements = 250): Promise<PageState> {
  try {
    const raw = await readSnapshot(page, maxElements);
    if (!raw) throw new StalePage("Document is navigating");
    return fromRaw(raw);
  } catch (error) {
    if (error instanceof StalePage) throw error;
    throw new StalePage("Document changed during observation");
  }
}

async function readSnapshot(page: Page, maxElements: number): Promise<Record<string, unknown> | null> {
  await page.evaluate(`window.__uiPilotMax = ${maxElements}`);
  return (await page.evaluate(SCRIPT)) as Record<string, unknown> | null;
}

export function fromRaw(raw: Record<string, unknown>): PageState {
  const elements = ((raw.elements as ObservedElement[]) ?? []).map((item) => ({
    ...item,
    name: item.name ?? "",
    value: publicValue(item.name, item.value),
    operations: item.operations ?? [],
    within: item.within ?? "",
    nearby: item.nearby ?? "",
    options: item.options ?? [],
  }));
  const state: PageState = {
    url: String(raw.url ?? ""),
    title: String(raw.title ?? ""),
    text: String(raw.text ?? ""),
    elements,
    scroll: (raw.scroll as Record<string, number>) ?? {},
    pageKey: String(raw.pageKey ?? raw.page_key ?? ""),
    marker: String(raw.marker ?? ""),
    guards: (raw.guards as Record<string, string>) ?? {},
    fingerprint: "",
  };
  state.fingerprint = stableHash({
    url: state.url,
    title: state.title,
    text: state.text,
    elements,
    scroll: state.scroll,
  });
  return state;
}

export function contentKey(page: Pick<PageState, "url" | "title" | "elements">): string {
  const controls = page.elements
    .map((item) => `${item.role}|${item.name}|${item.value}|${item.operations.join(",")}`)
    .sort();
  return stableHash({ url: page.url, title: page.title, controls });
}

export function controlSnapshot(page: PageState): ControlSnapshot {
  return {
    url: page.url,
    title: page.title,
    elements: page.elements.map((item) => ({
      index: item.index,
      role: item.role,
      name: item.name,
      value: publicValue(item.name, item.value),
      operations: item.operations,
      within: item.within,
    })),
  };
}

export function actionMarkLabel(item: { role?: string; name?: string }): string {
  const name = item.name?.trim() ?? "";
  const text = name ? `${item.role ?? ""} ${name}`.trim() : item.role || "target";
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

export async function paintActionMark(page: Page, mark: { node: number; label: string }): Promise<boolean> {
  return page
    .evaluate(({ node, label }) => {
      document.querySelector("[data-codexqa-jev-browser-mark]")?.remove();
      const el = window.__uiPilot?.byId?.get(node) as HTMLElement | undefined;
      if (!el?.isConnected) return false;
      const doc = el.ownerDocument;
      const view = doc.defaultView;
      if (!view) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      let x = rect.left;
      let y = rect.top;
      let frameEl = view.frameElement as HTMLElement | null;
      let current: Window | null = view;
      while (frameEl && current && current !== window) {
        const frameRect = frameEl.getBoundingClientRect();
        x += frameRect.left;
        y += frameRect.top;
        current = frameEl.ownerDocument.defaultView;
        frameEl = current?.frameElement as HTMLElement | null;
      }
      const box = document.createElement("div");
      box.setAttribute("data-codexqa-jev-browser-mark", "1");
      box.setAttribute("aria-hidden", "true");
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      box.style.cssText = [
        "position:fixed",
        `left:${Math.round(x)}px`,
        `top:${Math.round(y)}px`,
        `width:${width}px`,
        `height:${height}px`,
        "border:3px solid #ff3b30",
        "border-radius:8px",
        "box-shadow:0 0 0 2px #fff, 0 8px 24px rgba(255,59,48,.35)",
        "pointer-events:none",
        "z-index:2147483647",
        "box-sizing:border-box",
      ].join(";");
      const tag = document.createElement("div");
      tag.textContent = label;
      const below = y < 28;
      tag.style.cssText = [
        "position:absolute",
        "left:-3px",
        below ? `top:${height + 4}px` : "top:-26px",
        "max-width:280px",
        "padding:2px 8px",
        "border-radius:6px",
        "background:#ff3b30",
        "color:#fff",
        "font:600 12px/20px PingFang SC, Hiragino Sans GB, Noto Sans SC, sans-serif",
        "white-space:nowrap",
        "overflow:hidden",
        "text-overflow:ellipsis",
        "box-shadow:0 0 0 2px #fff",
      ].join(";");
      box.appendChild(tag);
      document.documentElement.appendChild(box);
      return true;
    }, mark)
    .catch(() => false);
}

export async function clearActionMark(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector("[data-codexqa-jev-browser-mark]")?.remove()).catch(() => undefined);
}

export function elementLabel(item: ObservedElement): string {
  const shown = publicValue(item.name, item.value);
  const extra = shown ? ` · ${shown}` : "";
  const href = item.href && /^https?:|^\/\//.test(item.href) ? ` · ${shortHref(item.href)}` : "";
  return `[${item.index}] ${item.role}  ${item.name || "(unnamed)"}${extra}${href}`;
}

function shortHref(href: string): string {
  try {
    const url = new URL(href, "https://local.invalid");
    const path = `${url.hostname}${url.pathname}`.replace(/\/$/, "");
    return path.length > 72 ? `${path.slice(0, 72)}…` : path;
  } catch {
    return href.slice(0, 72);
  }
}

export function asCandidate(item: ObservedElement): Record<string, unknown> {
  return {
    index: item.index,
    role: item.role,
    name: item.name,
    value: publicValue(item.name, item.value),
    within: item.within,
    operations: item.operations,
  };
}

export function pageTable(page: PageState): string {
  return page.elements.map(elementLabel).join("\n") || "(no visible controls)";
}

export async function targetReady(
  page: Page,
  action: { node: number; kind: string; value?: string; frame?: string | null },
): Promise<{ x: number; y: number } | null> {
  return page.evaluate((payload) => {
    const el = window.__uiPilot?.byId?.get(payload.node) as HTMLElement | undefined;
    if (!el?.isConnected) return null;
    const doc = el.ownerDocument;
    const view = doc.defaultView;
    if (!view) return null;
    if (el.getAttribute("aria-hidden") === "true" || el.closest("[aria-hidden='true'],[hidden],[inert]")) return null;
    if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.getAttribute("tabindex") === "-1") return null;
    const style = view.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none" || Number(style.opacity) === 0) {
      return null;
    }
    if (el.matches(":disabled") || el.closest('[aria-disabled="true"],[inert]')) return null;
    if (payload.kind === "type" && ((el as HTMLInputElement).readOnly || el.getAttribute("aria-readonly") === "true")) {
      return null;
    }
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return null;
    }
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const r = el.getBoundingClientRect();
    const viewTop = Math.max(r.top, 0);
    const viewBottom = Math.min(r.bottom, view.innerHeight);
    const viewLeft = Math.max(r.left, 0);
    const viewRight = Math.min(r.right, view.innerWidth);
    if (!r.width || !r.height || viewBottom - viewTop < 4 || viewRight - viewLeft < 4) return null;
    const localX = (viewLeft + viewRight) / 2;
    const localY = (viewTop + viewBottom) / 2;
    const top = doc.elementFromPoint(localX, localY);
    if (top && !el.contains(top) && top !== el) return null;
    let absX = localX;
    let absY = localY;
    let frameEl = view.frameElement as HTMLElement | null;
    let current: Window | null = view;
    while (frameEl && current && current !== window) {
      if (typeof frameEl.checkVisibility === "function" && !frameEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
        return null;
      }
      const fr = frameEl.getBoundingClientRect();
      absX += fr.left;
      absY += fr.top;
      const parentDoc = frameEl.ownerDocument;
      const cover = parentDoc.elementFromPoint(fr.left + fr.width / 2, fr.top + fr.height / 2);
      if (cover && !frameEl.contains(cover) && cover !== frameEl) return null;
      current = parentDoc.defaultView;
      frameEl = current?.frameElement as HTMLElement | null;
    }
    if (payload.kind === "select") {
      if (el.tagName !== "SELECT") return null;
      const ok = [...(el as HTMLSelectElement).options].some((o) => o.value === payload.value && !o.disabled);
      if (!ok) return null;
    }
    return { x: absX, y: absY };
  }, action);
}

declare global {
  interface Window {
    __uiPilotMax?: number;
    __uiPilot?: { byId: Map<number, Element>; marker?: string };
  }
}
