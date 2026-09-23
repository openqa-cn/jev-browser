(() => {
  const MAX = window.__uiPilotMax || 250;
  const SELECTOR = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "summary",
    '[contenteditable="true"]',
    '[contenteditable=""]',
    "[role='button']",
    "[role='link']",
    "[role='textbox']",
    "[role='searchbox']",
    "[role='combobox']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='menuitem']",
    "[role='tab']",
    "[role='option']",
    "[role='listitem']",
    "[role='gridcell']",
    "[role='switch']",
  ].join(",");

  const LAYER_SEL = [
    "[role='listbox']",
    "[role='dialog']",
    "[role='menu']",
    "[role='grid']",
    "[role='list']",
    "[class*='suggest']",
    "[class*='dropdown']",
    "[class*='picker']",
    "[class*='autocomplete']",
    "[class*='auto-complete']",
  ].join(",");

  const store = (window.__uiPilot = window.__uiPilot || {
    byEl: new WeakMap(),
    byId: new Map(),
    next: 1,
    marker: Math.random().toString(36).slice(2),
  });

  const prune = () => {
    for (const [id, el] of [...store.byId.entries()]) {
      if (!el.isConnected) store.byId.delete(id);
    }
  };

  const nodeId = (el) => {
    let id = store.byEl.get(el);
    if (!id) {
      id = store.next++;
      store.byEl.set(el, id);
      store.byId.set(id, el);
    }
    el.setAttribute("data-codexqa-jev-browser-id", String(id));
    return id;
  };

  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest("[hidden]")) return false;
    if (el.getAttribute("aria-hidden") === "true" || el.closest("[aria-hidden='true']")) return false;
    if (el.matches("input,textarea") && el.getAttribute("tabindex") === "-1") return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };

  const isDisabled = (el) =>
    el.matches(":disabled") ||
    el.getAttribute("aria-disabled") === "true" ||
    !!el.closest("[aria-disabled='true'],[inert]");

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (type === "hidden" || type === "file") return null;
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "search") return "searchbox";
      if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return tag;
  };

  const docOf = (el) => el.ownerDocument || document;

  const labelledBy = (el) => {
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    if (!ids.length) return "";
    const doc = docOf(el);
    return ids
      .map((id) => doc.getElementById(id)?.innerText || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  };

  const nameOf = (el) => {
    const doc = docOf(el);
    const fromIds = labelledBy(el);
    if (fromIds) return fromIds.slice(0, 80);
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return aria.slice(0, 80);
    if (el.id) {
      const lab = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return lab.innerText.replace(/\s+/g, " ").trim().slice(0, 80);
    }
    const wrap = el.closest("label");
    if (wrap) {
      const clone = wrap.cloneNode(true);
      clone.querySelectorAll("input,textarea,select,button").forEach((node) => node.remove());
      const text = clone.innerText.replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, 80);
    }
    const img = el.querySelector?.("img[alt]");
    const alt = (img?.getAttribute("alt") || el.getAttribute("alt") || el.getAttribute("title") || "").trim();
    if (alt) return alt.slice(0, 80);
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 80);
    if (el.tagName?.toLowerCase() === "input") {
      const type = (el.type || "").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset" || type === "image") {
        const value = (el.getAttribute("value") || "").replace(/\s+/g, " ").trim();
        if (value) return value.slice(0, 80);
      }
    }
    return "";
  };

  const captionText = (node) => {
    if (!node || node.nodeType !== 1) return "";
    if (node.matches("input,textarea,select,button,a")) return "";
    if (node.querySelector("input,textarea,select,button,a")) return "";
    const text = (node.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 8 || /^\d+$/.test(text)) return "";
    return text;
  };

  const captionOf = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return "";
    let scope = el.parentElement;
    let node = el.parentElement;
    for (let depth = 0; depth < 4 && node && node !== docOf(el).body; depth += 1, node = node.parentElement) {
      const box = node.getBoundingClientRect();
      if (box.width > rect.width + 120 || box.height > 160) break;
      scope = node;
    }
    if (!scope) return "";
    const value = String(el.value || "").trim();
    let best = "";
    let bestTop = Infinity;
    for (const candidate of scope.querySelectorAll("*")) {
      if (candidate === el || candidate.contains(el) || el.contains(candidate)) continue;
      const text = captionText(candidate);
      if (!text || (value && (text === value || value.includes(text)))) continue;
      const box = candidate.getBoundingClientRect();
      if (box.width < 2 || box.height < 2 || box.height > 32) continue;
      const overlapsX = box.left < rect.right - 4 && box.right > rect.left + 4;
      const inUpper = overlapsX && box.top >= rect.top - 40 && box.top <= rect.top + 36 && box.bottom <= rect.top + rect.height * 0.7;
      if (!inUpper || box.top >= bestTop) continue;
      best = text;
      bestTop = box.top;
    }
    return best;
  };

  const withinOf = (el) => {
    const dialog = el.closest("[role='dialog'],dialog,[role='alertdialog']");
    if (dialog) return (dialog.getAttribute("aria-label") || dialog.innerText || "dialog").replace(/\s+/g, " ").trim().slice(0, 60);
    const form = el.closest("form");
    if (form) return (form.getAttribute("aria-label") || form.getAttribute("name") || "form").slice(0, 60);
    const heading = el.closest("section,article,main,nav");
    if (heading) {
      const h = heading.querySelector("h1,h2,h3,[role='heading']");
      if (h) return h.innerText.replace(/\s+/g, " ").trim().slice(0, 60);
    }
    return "";
  };

  const nearbyText = (el) => {
    const scope = el.closest("form,tr,li,[role='row'],[role='dialog'],label,fieldset") || el.parentElement;
    return (scope?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160);
  };

  const operationsOf = (el, role) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.type || "").toLowerCase();
    const editable =
      tag === "textarea" ||
      el.isContentEditable ||
      (tag === "input" && !["checkbox", "radio", "submit", "button", "reset", "file", "hidden", "image"].includes(type)) ||
      role === "textbox" ||
      role === "searchbox" ||
      (role === "combobox" && tag !== "select");
    if (tag === "select") return ["SELECT"];
    if (editable) return ["TYPE", "CLICK"];
    return ["CLICK"];
  };

  const secretControl = (el, name) => {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password") return true;
    const blob = `${name || ""} ${el.getAttribute("name") || ""} ${el.getAttribute("autocomplete") || ""}`;
    return /password|passwd|secret|api[_-]?key|access[_-]?token|密码|口令/i.test(blob);
  };

  const valueOf = (el, role) => {
    if (role === "checkbox" || role === "radio" || role === "switch") {
      return el.checked || el.getAttribute("aria-checked") === "true" ? "checked" : "unchecked";
    }
    if (el.tagName.toLowerCase() === "select") {
      const opt = el.selectedOptions?.[0];
      return (opt?.label || opt?.text || el.value || "").trim();
    }
    return String(el.value ?? el.getAttribute("aria-valuetext") ?? "").slice(0, 200);
  };

  const leafText = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();

  const isDayCell = (text) => /^\d{1,2}$/.test(text);

  const isWeekdayHeader = (text) => {
    const compact = text.replace(/\s+/g, "");
    return /[日一二三四五六]{5,}/.test(compact) && !/\d{1,2}日/.test(compact);
  };

  const isChoiceLeaf = (el) => {
    if (!isVisible(el) || isDisabled(el)) return false;
    if (el.matches("input,textarea,select,button,a[href]")) return false;
    const text = leafText(el);
    if (isWeekdayHeader(text)) return false;
    const compact = text.replace(/\s+/g, "");
    if (/^20\d{2}年(\d{1,2}月)?$/.test(compact) || /^\d{1,2}月$/.test(compact)) return false;
    const dayTokens = text.match(/\d{1,2}/g) || [];
    if (!isDayCell(text) && dayTokens.length > 1) return false;
    if (text.length < 1 || text.length > 20) return false;
    if (!isDayCell(text) && text.length < 2) return false;
    for (const child of el.children) {
      if (leafText(child) === text) return false;
    }
    if (el.querySelector("input,textarea,select")) return false;
    return true;
  };

  const monthLabel = (text) => {
    const compact = String(text || "").replace(/\s+/g, "");
    const months = compact.match(/20\d{2}年\d{1,2}月/g) || [];
    if (months.length !== 1 || compact.length > 24) return "";
    return months[0];
  };

  const monthHeading = (el) => {
    let node = el.parentElement;
    for (let depth = 0; depth < 8 && node; depth += 1, node = node.parentElement) {
      const heading = node.querySelector(
        ":scope > h1, :scope > h2, :scope > h3, :scope > [class*='month'], :scope > [class*='Month']",
      );
      const fromHeading = monthLabel(heading ? leafText(heading) : "");
      if (fromHeading) return fromHeading;
      let prev = node.previousElementSibling;
      for (let hops = 0; prev && hops < 6; hops += 1, prev = prev.previousElementSibling) {
        const label = monthLabel(leafText(prev));
        if (label) return label;
      }
    }
    return "";
  };

  const isOverlayLayer = (el) => {
    if (!isVisible(el)) return false;
    if (el.matches(LAYER_SEL)) return true;
    const style = getComputedStyle(el);
    return style.position === "absolute" || style.position === "fixed";
  };

  const collectRoot = (root) => {
    const found = [];
    const visit = (node) => {
      if (!node || !node.querySelectorAll) return;
      for (const el of node.querySelectorAll(SELECTOR)) found.push(el);
      for (const host of node.querySelectorAll("*")) {
        if (host.shadowRoot) visit(host.shadowRoot);
      }
    };
    visit(root);
    return found;
  };

  const collectChooserLeaves = (root) => {
    const leaves = [];
    const visit = (node) => {
      if (!node || !node.querySelectorAll) return;
      const layers = [...node.querySelectorAll(LAYER_SEL)].filter(isOverlayLayer);
      for (const layer of layers) {
        const candidates = [...layer.querySelectorAll("li,span,div,a,[role='option'],[role='listitem'],[role='gridcell']")];
        const choices = candidates.filter(isChoiceLeaf);
        if (choices.length < 3) continue;
        for (const el of choices) leaves.push(el);
      }
      for (const host of node.querySelectorAll("*")) {
        if (host.shadowRoot) visit(host.shadowRoot);
      }
    };
    visit(root);
    return leaves;
  };

  const inChrome = (el) => !!el.closest("header,nav,footer,[role='banner'],[role='navigation']");
  const isSearchField = (el) => {
    if (!isVisible(el)) return false;
    const type = (el.getAttribute("type") || "").toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (type === "search" || role === "searchbox") return true;
    const hint = `${el.id} ${el.getAttribute("name") || ""} ${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""}`;
    return /search|搜索/i.test(hint);
  };

  const looksDisabled = (el) => {
    let node = el;
    for (let depth = 0; depth < 3 && node; depth += 1, node = node.parentElement) {
      if (node.classList?.contains("disabled") || node.getAttribute("aria-disabled") === "true") return true;
      const rect = node.getBoundingClientRect();
      if (rect.width > 80 || rect.height > 80) break;
    }
    return false;
  };

  const iconBox = (el) => {
    let box = el;
    let parent = el.parentElement;
    for (let depth = 0; depth < 4 && parent; depth += 1, parent = parent.parentElement) {
      if (leafText(parent) || parent.querySelector("input, textarea, select")) break;
      const rect = parent.getBoundingClientRect();
      if (rect.width < 16 || rect.height < 16 || rect.width > 80 || rect.height > 80) break;
      box = parent;
    }
    return box;
  };

  const atFieldEnd = (icon, field) => {
    const iconRect = icon.getBoundingClientRect();
    const fieldRect = field.getBoundingClientRect();
    if (iconRect.width < 16 || iconRect.height < 16 || iconRect.width > 80 || iconRect.height > 80) return false;
    const midX = iconRect.left + iconRect.width / 2;
    const midY = iconRect.top + iconRect.height / 2;
    const nearEnd = midX >= fieldRect.right - 56 && midX <= fieldRect.right + 64;
    const sameBand = midY >= fieldRect.top - 8 && midY <= fieldRect.bottom + 64;
    return nearEnd && sameBand;
  };

  const fieldEndIcon = (el) => {
    if (!isVisible(el) || isDisabled(el) || looksDisabled(el) || leafText(el)) return false;
    const root = el.ownerDocument || document;
    for (const field of root.querySelectorAll("input, textarea, [role='searchbox'], [role='textbox']")) {
      if (field.contains(el) || !isSearchField(field)) continue;
      if (atFieldEnd(el, field)) return true;
    }
    return false;
  };

  const collectFieldEndIcons = (root) => {
    const found = [];
    const visit = (node) => {
      if (!node || !node.querySelectorAll) return;
      for (const el of node.querySelectorAll("img, svg")) {
        const box = iconBox(el);
        if (fieldEndIcon(box)) found.push(box);
      }
      for (const host of node.querySelectorAll("*")) {
        if (host.shadowRoot) visit(host.shadowRoot);
      }
    };
    visit(root);
    return found;
  };

  prune();
  const nodes = [];
  for (const el of collectRoot(document)) nodes.push({ el, frame: null, chooser: false });
  for (const el of collectFieldEndIcons(document)) nodes.push({ el, frame: null, chooser: false, press: true, name: "搜索" });
  for (const el of collectChooserLeaves(document)) nodes.push({ el, frame: null, chooser: true });
  for (const iframe of document.querySelectorAll("iframe")) {
    try {
      const doc = iframe.contentDocument;
      if (doc) {
        const frame = iframe.getAttribute("name") || iframe.id || "iframe";
        for (const el of collectRoot(doc)) nodes.push({ el, frame, chooser: false });
        for (const el of collectChooserLeaves(doc)) nodes.push({ el, frame, chooser: true });
        for (const el of collectFieldEndIcons(doc)) nodes.push({ el, frame, chooser: false, press: true, name: "搜索" });
      }
    } catch {
      /* cross-origin */
    }
  }

  const elements = [];
  const seen = new Set();
  const ranked = [];
  for (const entry of nodes) {
    if (seen.has(entry.el)) continue;
    seen.add(entry.el);
    ranked.push(entry);
  }
  ranked.sort((a, b) => {
    const score = (entry) => {
      if (entry.chooser) return 2;
      if (entry.press) return 0;
      if (inChrome(entry.el)) return 3;
      return 1;
    };
    return score(a) - score(b);
  });
  for (const { el, frame, chooser, card, press, name: givenName, href: cardHref } of ranked) {
    if (el.closest("footer, [role='contentinfo']")) continue;
    if (!isVisible(el) || isDisabled(el)) continue;
    const role = chooser ? "option" : card ? "link" : press ? "button" : roleOf(el);
    if (!role) continue;
    const accessible = chooser
      ? (() => {
          const text = leafText(el).slice(0, 80);
          if (!isDayCell(text)) return text;
          const month = monthHeading(el);
          return month ? `${month} ${text}`.slice(0, 80) : text;
        })()
      : givenName || nameOf(el);
    const caption =
      chooser || card || press || !el.matches?.("input,textarea,[contenteditable=''],[contenteditable='true'],[role='textbox'],[role='searchbox']")
        ? ""
        : captionOf(el);
    const name = caption && !accessible.includes(caption) ? `${caption} ${accessible}`.trim().slice(0, 80) : accessible;
    const operations = chooser || card || press ? ["CLICK"] : operationsOf(el, role);
    if (!name && !chooser && !operations.includes("TYPE") && !operations.includes("SELECT")) continue;
    const id = nodeId(el);
    const item = {
      index: String(elements.length + 1),
      node: id,
      role,
      name,
      value: chooser || secretControl(el, name) ? "" : valueOf(el, role),
      operations,
      checked: el.checked ?? null,
      selected: el.selected ?? null,
      expanded: el.getAttribute("aria-expanded"),
      within: chooser ? "chooser" : withinOf(el),
      frame,
      href: cardHref || el.getAttribute("href"),
      nearby: nearbyText(el),
      options: [],
    };
    if (!chooser && el.tagName.toLowerCase() === "select") {
      item.options = [...el.options]
        .filter((opt) => !opt.disabled)
        .map((opt, i) => ({
          index: `${item.index}:${i + 1}`,
          label: (opt.label || opt.text || "").trim(),
          value: opt.value,
        }));
    }
    elements.push(item);
    if (elements.length >= MAX) break;
  }

  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const parts = [];
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest("script,style,noscript,footer")) continue;
    if (!isVisible(parent)) continue;
    const text = node.textContent.replace(/\s+/g, " ").trim();
    if (text) parts.push(text);
    if (parts.join(" ").length > 4000) break;
  }

  const pageKey = location.href + "|" + document.title;
  store.pageKey = pageKey;
  store.guards = Object.fromEntries(
    elements.map((item) => [
      String(item.node),
      [item.node, item.role, item.name, item.value, item.checked, item.expanded, item.href, item.nearby].map(String).join("|"),
    ]),
  );

  return {
    url: location.href,
    title: document.title,
    text: parts.join(" ").slice(0, 4000),
    elements,
    scroll: { x: scrollX, y: scrollY, maxY: Math.max(document.documentElement.scrollHeight - innerHeight, 0) },
    pageKey,
    marker: store.marker,
    guards: store.guards,
  };
})()
