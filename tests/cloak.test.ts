import { describe, expect, it } from "vitest";
import { cloakArgs, findCloakExecutable, resolveCloakLaunch, resolveEngine } from "../src/cloak.js";
import {
  cloakArchiveUrl,
  cloakGeoIpUrl,
  cloakPlatform,
  cloakStatus,
  cloakVersion,
  ensureCloakBrowser,
} from "../src/cloak-install.js";
import { defaultConfig, loadConfig } from "../src/config.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("cloak launch", () => {
  it("keeps tests on bundled chromium by default", () => {
    const config = defaultConfig();
    expect(config.browserEngine).toBe("chromium");
    expect(resolveEngine(config)).toBe("chromium");
    expect(resolveCloakLaunch(config)).toBeUndefined();
  });

  it("reads engine=auto from yaml and prefers a local Cloak binary", () => {
    const previous = process.env.UI_PILOT_BROWSER;
    delete process.env.UI_PILOT_BROWSER;
    try {
      const config = loadConfig(path.join(root, "codexqa-jev-browser.config.yaml"));
      expect(config.browserEngine).toBe("auto");
      const cloak = resolveCloakLaunch(config);
      const binary = findCloakExecutable();
      if (binary) {
        expect(cloak?.engine).toBe("cloak");
        expect(cloak?.executablePath).toBe(binary);
        expect(cloak?.args.some((item) => item.startsWith("--fingerprint="))).toBe(true);
      } else {
        expect(cloak).toBeUndefined();
      }
    } finally {
      if (previous === undefined) delete process.env.UI_PILOT_BROWSER;
      else process.env.UI_PILOT_BROWSER = previous;
    }
  });

  it("pins timezone and locale through binary flags", () => {
    const args = cloakArgs({
      fingerprintSeed: "61385",
      storageQuota: 1024,
      profileDirectory: "Default",
      width: 1120,
      height: 780,
    });
    expect(args).toContain("--fingerprint=61385");
    expect(args).toContain("--fingerprint-timezone=Asia/Shanghai");
    expect(args).toContain("--lang=zh-CN");
    expect(args).toContain("--window-size=1120,780");
    expect(args).not.toContain("--no-sandbox");
  });
});

describe("cloak install mirror", () => {
  it("requires an explicit https mirror and does not embed a download host", () => {
    const previous = {
      url: process.env.CLOAKBROWSER_DOWNLOAD_URL,
      version: process.env.CLOAKBROWSER_VERSION,
      geoip: process.env.CLOAKBROWSER_GEOIP_URL,
      sha: process.env.CLOAKBROWSER_SHA256,
    };
    delete process.env.CLOAKBROWSER_DOWNLOAD_URL;
    delete process.env.CLOAKBROWSER_VERSION;
    delete process.env.CLOAKBROWSER_GEOIP_URL;
    delete process.env.CLOAKBROWSER_SHA256;
    try {
      expect(cloakGeoIpUrl()).toBe("");
      expect(() => cloakArchiveUrl("darwin-arm64", "145.0.7632.109.2")).toThrow(/CLOAKBROWSER_DOWNLOAD_URL/);
      process.env.CLOAKBROWSER_DOWNLOAD_URL = "http://mirror.example/cloak";
      expect(() => cloakArchiveUrl("darwin-arm64", "145.0.7632.109.2")).toThrow(/https/);
      process.env.CLOAKBROWSER_DOWNLOAD_URL = "https://mirror.example/cloak";
      expect(cloakArchiveUrl("darwin-arm64", "145.0.7632.109.2")).toBe(
        "https://mirror.example/cloak/chromium-v145.0.7632.109.2/cloakbrowser-darwin-arm64.tar.gz",
      );
      expect(cloakArchiveUrl("windows-x64", "146.0.7680.177.5")).toBe(
        "https://mirror.example/cloak/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip",
      );
      process.env.CLOAKBROWSER_GEOIP_URL = "https://mirror.example/geoip.mmdb";
      expect(cloakGeoIpUrl()).toBe("https://mirror.example/geoip.mmdb");
      expect(() => cloakArchiveUrl("linux-x64", "")).toThrow(/尚未提供/);
    } finally {
      restoreEnv("CLOAKBROWSER_DOWNLOAD_URL", previous.url);
      restoreEnv("CLOAKBROWSER_VERSION", previous.version);
      restoreEnv("CLOAKBROWSER_GEOIP_URL", previous.geoip);
      restoreEnv("CLOAKBROWSER_SHA256", previous.sha);
    }
  });

  it("refuses to download without a mirror and sha256", async () => {
    const previous = {
      url: process.env.CLOAKBROWSER_DOWNLOAD_URL,
      sha: process.env.CLOAKBROWSER_SHA256,
      version: process.env.CLOAKBROWSER_VERSION,
    };
    delete process.env.CLOAKBROWSER_DOWNLOAD_URL;
    delete process.env.CLOAKBROWSER_SHA256;
    try {
      await expect(ensureCloakBrowser({ force: true })).rejects.toThrow(/CLOAKBROWSER_DOWNLOAD_URL/);
      process.env.CLOAKBROWSER_DOWNLOAD_URL = "https://mirror.example/cloak";
      process.env.CLOAKBROWSER_VERSION = process.env.CLOAKBROWSER_VERSION || "145.0.7632.109.2";
      await expect(ensureCloakBrowser({ force: true })).rejects.toThrow(/CLOAKBROWSER_SHA256/);
    } finally {
      restoreEnv("CLOAKBROWSER_DOWNLOAD_URL", previous.url);
      restoreEnv("CLOAKBROWSER_SHA256", previous.sha);
      restoreEnv("CLOAKBROWSER_VERSION", previous.version);
    }
  });

  it("keeps the Cloak profile inside the tool cache", () => {
    const config = defaultConfig();
    config.browserEngine = "cloak";
    config.executablePath = path.join(root, "package.json");
    const cloak = resolveCloakLaunch(config);
    expect(cloak?.userDataDir.includes(`${path.sep}.cloakbrowser${path.sep}`)).toBe(true);
  });

  it("reports the local Cloak install without downloading", () => {
    const previous = process.env.CLOAKBROWSER_GEOIP_URL;
    delete process.env.CLOAKBROWSER_GEOIP_URL;
    try {
      const status = cloakStatus();
      expect(status.platform).toBe(cloakPlatform());
      expect(status.geoipUrl).toBe("");
      if (status.platform.startsWith("darwin")) {
        expect(cloakVersion(status.platform)).toBe("145.0.7632.109.2");
      }
    } finally {
      restoreEnv("CLOAKBROWSER_GEOIP_URL", previous);
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
