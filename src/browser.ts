import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { resolveCloakLaunch, type CloakLaunch } from "./cloak.js";
import type { PageState, PilotConfig } from "./types.js";
import { clearActionMark, collectSnapshot, paintActionMark } from "./observe/snapshot.js";
import { RunScreencast } from "./record.js";
import { elapsedMs, resolveStartUrl } from "./util.js";

export class BrowserSession {
  page: Page | null = null;
  engine = "chromium";
  lastObserveMs = 0;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private recorder: RunScreencast | null = null;

  constructor(
    private config: PilotConfig,
    private options: {
      headed?: boolean;
      storageState?: string;
      headers?: Record<string, string>;
      recordVideoDir?: string;
    } = {},
  ) {}

  async start(url?: string): Promise<PageState | null> {
    const headless = this.options.headed ? false : this.config.headless;
    const cloak = resolveCloakLaunch(this.config);
    if (cloak) {
      await this.launchCloak(cloak, headless);
    } else {
      this.browser = await this.launchChromium(headless);
      this.context = await this.browser.newContext({
        viewport: { width: this.config.viewportWidth, height: this.config.viewportHeight },
        storageState: this.options.storageState,
        extraHTTPHeaders: this.options.headers,
      });
      this.page = await this.context.newPage();
      this.engine = "chromium";
    }
    this.watchPages();
    this.page!.setDefaultTimeout(this.config.timeoutMs);
    try {
      const opening = url ? this.goto(url) : Promise.resolve(null);
      await this.beginRecording();
      return await opening;
    } finally {
      if (!headless) await this.revealWindow();
    }
  }

  async goto(url: string): Promise<PageState> {
    if (!this.page) throw new Error("Browser is not started");
    const target = resolveStartUrl(url) ?? url;
    await this.page.goto(target, { waitUntil: "domcontentloaded" });
    return this.observe();
  }

  async observe(): Promise<PageState> {
    if (!this.page) throw new Error("Browser is not started");
    const started = performance.now();
    try {
      return await collectSnapshot(this.page, this.config.maxElements);
    } finally {
      this.lastObserveMs = elapsedMs(started);
    }
  }

  async screenshot(mark?: { node: number; label: string }): Promise<Buffer> {
    if (!this.page) throw new Error("Browser is not started");
    const painted = mark ? await paintActionMark(this.page, mark) : false;
    try {
      return await this.page.screenshot({ type: "png", fullPage: false });
    } finally {
      if (painted) await clearActionMark(this.page);
    }
  }

  locator(nodeId: number) {
    if (!this.page) throw new Error("Browser is not started");
    return this.page.locator(`[data-codexqa-jev-browser-id="${nodeId}"]`).first();
  }

  async findLocator(nodeId: number) {
    if (!this.page) throw new Error("Browser is not started");
    const selector = `[data-codexqa-jev-browser-id="${nodeId}"]`;
    for (const frame of this.page.frames()) {
      const loc = frame.locator(selector);
      if (await loc.count()) return loc.first();
    }
    return this.page.locator(selector).first();
  }

  watchPopup(): () => Promise<boolean> {
    const opened: Page[] = [];
    const onPage = (page: Page) => {
      opened.push(page);
    };
    this.context?.on("page", onPage);
    return async () => {
      this.context?.off("page", onPage);
      for (const page of opened) {
        if (await this.claimPage(page)) return true;
      }
      return false;
    };
  }

  private async claimPage(page: Page | undefined): Promise<boolean> {
    if (!page || page === this.page || page.isClosed()) return false;
    this.page = page;
    this.page.setDefaultTimeout(this.config.timeoutMs);
    await this.page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await this.recorder?.follow(page).catch(() => undefined);
    return true;
  }

  get url(): string {
    return this.page?.url() ?? "";
  }

  async title(): Promise<string> {
    return this.page ? this.page.title() : "";
  }

  private async launchCloak(cloak: CloakLaunch, headless: boolean): Promise<void> {
    mkdirSync(cloak.userDataDir, { recursive: true });
    this.engine = "cloak";
    const args = headless ? cloak.args : [...cloak.args, "--window-position=-32000,-32000"];
    try {
      this.context = await chromium.launchPersistentContext(cloak.userDataDir, {
        executablePath: cloak.executablePath,
        headless,
        chromiumSandbox: true,
        args,
        ignoreDefaultArgs: ["--enable-automation", "--enable-unsafe-swiftshader"],
        viewport: headless ? { width: this.config.viewportWidth, height: this.config.viewportHeight } : null,
        extraHTTPHeaders: this.options.headers,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/user data|profile|Singleton|in use|already in use/i.test(message)) throw error;
      const fallback = cloak.userDataDir.endsWith("codexqa-jev-browser")
        ? `${cloak.userDataDir}-${process.pid}`
        : `${cloak.userDataDir.replace(/\/$/, "")}-codexqa-jev-browser`;
      mkdirSync(fallback, { recursive: true });
      this.context = await chromium.launchPersistentContext(fallback, {
        executablePath: cloak.executablePath,
        headless,
        chromiumSandbox: true,
        args,
        ignoreDefaultArgs: ["--enable-automation", "--enable-unsafe-swiftshader"],
        viewport: headless ? { width: this.config.viewportWidth, height: this.config.viewportHeight } : null,
        extraHTTPHeaders: this.options.headers,
      });
    }
    this.browser = this.context.browser();
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.applyStorageState();
    console.error(`browser cloak ${cloak.executablePath}`);
  }

  private async revealWindow(): Promise<void> {
    const page = this.page;
    const browser = this.browser;
    if (!page || !browser || page.isClosed()) return;
    try {
      const session = await page.context().newCDPSession(page);
      const { windowId } = await session.send("Browser.getWindowForTarget");
      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          left: 48,
          top: 48,
          width: this.config.viewportWidth,
          height: this.config.viewportHeight + 120,
          windowState: "normal",
        },
      });
      await session.detach().catch(() => undefined);
      await page.bringToFront().catch(() => undefined);
    } catch {
      /* The window stays where the browser placed it. */
    }
  }

  private async beginRecording(): Promise<void> {
    const dir = this.options.recordVideoDir;
    if (!dir || !this.page) return;
    this.recorder = new RunScreencast(path.join(dir, "recording.mp4"));
    await this.recorder.start(this.page).catch(() => {
      this.recorder = null;
    });
  }

  private watchPages(): void {
    this.context?.on("page", (page) => {
      const current = this.page;
      if (current && current !== page && !current.isClosed() && page.url() === "about:blank") {
        void current.bringToFront().catch(() => undefined);
      }
      page.once("domcontentloaded", () => {
        if (!this.page || this.page.isClosed()) {
          this.page = page;
          void this.recorder?.follow(page).catch(() => undefined);
          return;
        }
        if (this.page !== page && page.url() === "about:blank") {
          void this.page.bringToFront().catch(() => undefined);
        }
      });
    });
  }

  private async applyStorageState(): Promise<void> {
    if (!this.context || !this.options.storageState) return;
    const raw = JSON.parse(readFileSync(this.options.storageState, "utf8")) as { cookies?: Parameters<BrowserContext["addCookies"]>[0] };
    if (raw.cookies?.length) await this.context.addCookies(raw.cookies);
  }

  private async launchChromium(headless: boolean) {
    try {
      return await chromium.launch({ headless });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Executable doesn't exist") || message.includes("browserType.launch")) {
        return chromium.launch({ headless, channel: "chrome" });
      }
      throw error;
    }
  }

  async close(): Promise<string[]> {
    const recorded = await this.recorder?.stop().catch(() => undefined);
    this.recorder = null;
    if (this.context) {
      await this.context.close().catch(() => undefined);
    } else {
      await this.browser?.close().catch(() => undefined);
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    if (!recorded || !existsSync(recorded) || statSync(recorded).size < 1000) return [];
    return [recorded];
  }
}
