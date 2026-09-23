import { afterEach, describe, expect, it } from "vitest";
import { envProxyUrl, resetModelProxyCache, resolveModelProxy } from "../src/model-http.js";

const KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] as const;

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
  resetModelProxyCache();
});

describe("model proxy", () => {
  it("does not invent a proxy when none is configured", async () => {
    resetModelProxyCache();
    expect(envProxyUrl()).toBeUndefined();
    expect(await resolveModelProxy()).toBeUndefined();
  });

  it("prefers HTTPS_PROXY from the environment", async () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:6553";
    resetModelProxyCache();
    expect(envProxyUrl()).toBe("http://127.0.0.1:6553");
    expect(await resolveModelProxy()).toBe("http://127.0.0.1:6553");
  });
});
