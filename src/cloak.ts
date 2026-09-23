import { existsSync, readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PilotConfig } from "./types.js";

export type BrowserEngine = "auto" | "cloak" | "chromium";

export interface CloakLaunch {
  engine: "cloak";
  executablePath: string;
  userDataDir: string;
  args: string[];
  fingerprintSeed: string;
  profileDirectory: string;
}

const FALLBACK_SEED = "61385";

export function resolveEngine(config: PilotConfig): BrowserEngine {
  const raw = (config.browserEngine || process.env.UI_PILOT_BROWSER || "chromium").trim().toLowerCase();
  if (raw === "cloak" || raw === "auto" || raw === "chromium") return raw;
  return "chromium";
}

export function resolveCloakLaunch(config: PilotConfig): CloakLaunch | undefined {
  const engine = resolveEngine(config);
  if (engine === "chromium") return undefined;
  const executablePath = config.executablePath || findCloakExecutable();
  if (!executablePath) {
    if (engine === "cloak") {
      throw new Error("未找到 Cloak 浏览器。设置 CLOAKBROWSER_DOWNLOAD_URL 和 CLOAKBROWSER_SHA256 后执行 install-browser，或设置 CLOAKBROWSER_BINARY_PATH。");
    }
    return undefined;
  }
  const fingerprintSeed = String(config.fingerprintSeed || FALLBACK_SEED);
  const userDataDir = pickUserDataDir(config.userDataDir);
  return {
    engine: "cloak",
    executablePath,
    userDataDir,
    fingerprintSeed,
    profileDirectory: "Default",
    args: cloakArgs({
      fingerprintSeed,
      storageQuota: 1024,
      profileDirectory: "Default",
      width: config.viewportWidth,
      height: config.viewportHeight,
    }),
  };
}

export function findCloakExecutable(): string | undefined {
  const explicit = firstExisting(
    process.env.CLOAKBROWSER_BINARY_PATH,
    process.env.CLOAK_EXECUTABLE,
    process.env.CLOAK_BROWSER,
  );
  if (explicit) return explicit;

  const cacheRoots = [
    process.env.CLOAKBROWSER_CACHE_DIR,
    path.join(os.homedir(), ".cloakbrowser"),
  ].filter((item): item is string => Boolean(item));

  for (const root of cacheRoots) {
    const found = findChromiumBinary(root);
    if (found) return found;
  }
  return undefined;
}

export function cloakArgs(opts: {
  fingerprintSeed: string;
  storageQuota: number;
  profileDirectory: string;
  width: number;
  height: number;
}): string[] {
  const args = [
    `--fingerprint=${opts.fingerprintSeed}`,
    `--fingerprint-storage-quota=${opts.storageQuota}`,
    `--profile-directory=${opts.profileDirectory}`,
    `--fingerprint-platform=${process.platform === "darwin" ? "macos" : "windows"}`,
    "--fingerprint-timezone=Asia/Shanghai",
    "--lang=zh-CN",
    "--fingerprint-locale=zh-CN",
    `--window-size=${opts.width},${opts.height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-infobars",
    "--no-session-restore",
    "--disable-session-crashed-bubble",
    "--password-store=basic",
  ];
  if (process.platform === "darwin") args.push("--use-mock-keychain");
  return args;
}

function pickUserDataDir(preferred?: string): string {
  if (preferred && !isProfileLocked(preferred)) return preferred;
  const fallback = path.join(os.homedir(), ".cloakbrowser", "profiles", "codexqa-jev-browser");
  return fallback;
}

export function isProfileLocked(userDataDir: string): boolean {
  const lock = path.join(userDataDir, "SingletonLock");
  if (!existsSync(lock)) return false;
  try {
    const target = realpathSync(lock);
    const match = target.match(/-(\d+)$/);
    if (!match) return true;
    process.kill(Number(match[1]), 0);
    return true;
  } catch {
    return false;
  }
}

function findChromiumBinary(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  const direct = firstExisting(
    path.join(root, "Chromium.app/Contents/MacOS/Chromium"),
    path.join(root, "chrome"),
    path.join(root, "chrome.exe"),
  );
  if (direct) return direct;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  const versions = entries
    .filter((name) => name.startsWith("chromium-"))
    .sort()
    .reverse();
  for (const version of versions) {
    const found = firstExisting(
      path.join(root, version, "Chromium.app/Contents/MacOS/Chromium"),
      path.join(root, version, "chrome"),
      path.join(root, version, "chrome.exe"),
    );
    if (found) return found;
  }
  return undefined;
}

function firstExisting(...candidates: Array<string | undefined>): string | undefined {
  return candidates.find((item) => item && existsSync(item));
}
