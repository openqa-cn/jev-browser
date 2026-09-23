import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { CDPSession, Page } from "playwright";

export class RunScreencast {
  private ffmpeg: ChildProcess | null = null;
  private cdp: CDPSession | null = null;
  private ticket = 0;
  private closed = false;

  constructor(private file: string) {}

  async start(page: Page): Promise<void> {
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.ffmpeg = spawn(
      "ffmpeg",
      [
        "-y",
        "-f",
        "image2pipe",
        "-use_wallclock_as_timestamps",
        "1",
        "-i",
        "pipe:0",
        "-an",
        "-vf",
        "fps=8,scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        this.file,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    this.ffmpeg.stdin?.on("error", () => {
      this.closed = true;
    });
    this.ffmpeg.on("error", () => {
      this.closed = true;
    });
    this.ffmpeg.on("exit", () => {
      this.closed = true;
    });
    this.ffmpeg.stderr?.on("data", () => undefined);
    await this.follow(page);
  }

  async follow(page: Page): Promise<void> {
    if (!this.ffmpeg) return;
    const ticket = ++this.ticket;
    await this.detach();
    if (ticket !== this.ticket || page.isClosed()) return;
    const cdp = await page.context().newCDPSession(page);
    if (ticket !== this.ticket) {
      await cdp.detach().catch(() => undefined);
      return;
    }
    this.cdp = cdp;
    cdp.on("Page.screencastFrame", (event: { data: string; sessionId: number }) => {
      const stdin = this.ffmpeg?.stdin;
      if (this.closed || !stdin?.writable || this.cdp !== cdp) return;
      try {
        stdin.write(Buffer.from(event.data, "base64"));
      } catch {
        this.closed = true;
      }
      cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
    });
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 50,
      maxWidth: 1120,
      maxHeight: 780,
      everyNthFrame: 2,
    });
  }

  async stop(): Promise<string | undefined> {
    await this.detach();
    const ffmpeg = this.ffmpeg;
    this.ffmpeg = null;
    if (!ffmpeg) return undefined;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ffmpeg.kill("SIGKILL");
        resolve();
      }, 4000);
      ffmpeg.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      ffmpeg.stdin?.end();
    });
    return this.file;
  }

  private async detach(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = null;
    if (!cdp) return;
    await Promise.race([
      (async () => {
        await cdp.send("Page.stopScreencast").catch(() => undefined);
        await cdp.detach().catch(() => undefined);
      })(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
}
