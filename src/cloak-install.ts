import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { findCloakExecutable } from "./cloak.js";
import { assertHttpsUrl } from "./util.js";

const MIRROR_REQUIRED =
  "Set CLOAKBROWSER_DOWNLOAD_URL to an https mirror you are allowed to use, and CLOAKBROWSER_SHA256 to the archive hash. This skill does not ship a default browser download.";

const PLATFORM_VERSION: Record<string, string> = {
  "darwin-arm64": "145.0.7632.109.2",
  "darwin-x64": "145.0.7632.109.2",
  "windows-x64": "146.0.7680.177.5",
};

export interface CloakInstallInfo {
  installed: boolean;
  platform: string;
  version: string;
  executablePath?: string;
  geoipPath: string;
  cacheDir: string;
  archiveUrl: string;
  geoipUrl: string;
}

export function cloakMirrorRoot(): string {
  const raw = (process.env.CLOAKBROWSER_DOWNLOAD_URL || "").trim().replace(/\/$/, "");
  if (!raw) throw new Error(MIRROR_REQUIRED);
  assertHttpsUrl(raw);
  return raw;
}

export function cloakGeoIpUrl(): string {
  const raw = (process.env.CLOAKBROWSER_GEOIP_URL || "").trim();
  if (!raw) return "";
  assertHttpsUrl(raw);
  return raw;
}

export function cloakPlatform(platform = process.platform, arch = process.arch): string {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "win32" && arch === "x64") return "windows-x64";
  throw new Error(`当前系统 ${platform}/${arch} 没有对应的 Cloak 浏览器内核`);
}

export function cloakVersion(platform = cloakPlatform()): string {
  return process.env.CLOAKBROWSER_VERSION || PLATFORM_VERSION[platform] || "";
}

export function cloakArchiveName(platform = cloakPlatform()): string {
  const ext = platform.startsWith("windows") ? ".zip" : ".tar.gz";
  return `cloakbrowser-${platform}${ext}`;
}

export function cloakArchiveUrl(platform = cloakPlatform(), version = cloakVersion(platform)): string {
  if (!version) {
    throw new Error(`镜像尚未提供 ${platform} Cloak 浏览器内核。设置 CLOAKBROWSER_VERSION，或改用 CLOAKBROWSER_BINARY_PATH。`);
  }
  return `${cloakMirrorRoot()}/chromium-v${version}/${cloakArchiveName(platform)}`;
}

export function cloakCacheDir(): string {
  return process.env.CLOAKBROWSER_CACHE_DIR || path.join(os.homedir(), ".cloakbrowser");
}

export function cloakGeoIpPath(): string {
  return path.join(cloakCacheDir(), "geoip", "geoip.mmdb");
}

export function cloakStatus(): CloakInstallInfo {
  const platform = cloakPlatform();
  const version = cloakVersion(platform);
  const executablePath = findCloakExecutable();
  const geoipPath = cloakGeoIpPath();
  let archiveUrl = "";
  try {
    archiveUrl = version ? cloakArchiveUrl(platform, version) : "";
  } catch {
    archiveUrl = "";
  }
  let geoipUrl = "";
  try {
    geoipUrl = cloakGeoIpUrl();
  } catch {
    geoipUrl = "";
  }
  return {
    installed: Boolean(executablePath && existsSync(executablePath)),
    platform,
    version,
    executablePath,
    geoipPath,
    cacheDir: cloakCacheDir(),
    archiveUrl,
    geoipUrl,
  };
}

export async function ensureCloakBrowser(options: { force?: boolean } = {}): Promise<CloakInstallInfo> {
  const status = cloakStatus();
  const geoReady = !status.geoipUrl || existsSync(status.geoipPath);
  if (!options.force && status.installed && geoReady) return status;
  if (!(process.env.CLOAKBROWSER_DOWNLOAD_URL || "").trim()) throw new Error(MIRROR_REQUIRED);
  if (!status.version) {
    throw new Error(`镜像尚未提供 ${status.platform} Cloak 浏览器内核`);
  }
  if (!status.archiveUrl) throw new Error(MIRROR_REQUIRED);
  mkdirSync(status.cacheDir, { recursive: true });
  if (options.force || !status.installed) {
    await installBinary(status);
  }
  if (status.geoipUrl && (options.force || !existsSync(status.geoipPath))) {
    await downloadChecked(status.geoipUrl, status.geoipPath, process.env.CLOAKBROWSER_GEOIP_SHA256, "CLOAKBROWSER_GEOIP_SHA256");
  }
  const next = cloakStatus();
  if (!next.installed) throw new Error(`Cloak 浏览器解压完成但未找到可执行文件，缓存目录：${status.cacheDir}`);
  return next;
}

async function installBinary(status: CloakInstallInfo): Promise<void> {
  const dest = path.join(status.cacheDir, `chromium-${status.version}`);
  const archive = path.join(status.cacheDir, cloakArchiveName(status.platform));
  await downloadChecked(status.archiveUrl, archive, process.env.CLOAKBROWSER_SHA256, "CLOAKBROWSER_SHA256");
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  extractArchive(archive, dest);
  rmSync(archive, { force: true });
}

function extractArchive(archive: string, dest: string): void {
  if (archive.endsWith(".zip")) {
    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", "Expand-Archive", "-Force", "-Path", archive, "-DestinationPath", dest],
      { stdio: "inherit" },
    );
    if (result.status !== 0) throw new Error("解压 Windows Cloak 浏览器失败");
    return;
  }
  const result = spawnSync("tar", ["-xzf", archive, "-C", dest], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("解压 Cloak 浏览器失败");
}

async function downloadChecked(url: string, dest: string, expected: string | undefined, envName: string): Promise<void> {
  const hash = requireSha256(expected, envName);
  await downloadFile(url, dest);
  const actual = await sha256File(dest);
  if (actual !== hash) {
    rmSync(dest, { force: true });
    throw new Error(`${path.basename(dest)} 的 sha256 与 ${envName} 不一致`);
  }
}

function requireSha256(expected: string | undefined, envName: string): string {
  const hash = (expected || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Set ${envName} to the sha256 of the file before downloading.`);
  }
  return hash;
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(file);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

async function downloadFile(url: string, dest: string): Promise<void> {
  mkdirSync(path.dirname(dest), { recursive: true });
  const temporary = `${dest}.tmp`;
  const response = await fetchHttps(url);
  if (!response.ok || !response.body) {
    throw new Error(`下载失败 ${response.status} ${url}`);
  }
  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0;
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (!total) return;
    const pct = Math.floor((received / total) * 100);
    if (pct % 10 === 0) process.stderr.write(`\rdownload ${path.basename(dest)} ${pct}%`);
  });
  try {
    await pipeline(body, createWriteStream(temporary));
    process.stderr.write(`\rdownload ${path.basename(dest)} 100%\n`);
    if (existsSync(dest)) rmSync(dest, { force: true });
    renameSync(temporary, dest);
    if (statSync(dest).size <= 0) throw new Error(`下载文件为空：${dest}`);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

async function fetchHttps(url: string): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    assertHttpsUrl(current);
    const response = await fetch(current, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error(`下载重定向缺少 Location：${current}`);
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new Error(`下载重定向次数过多：${url}`);
}
