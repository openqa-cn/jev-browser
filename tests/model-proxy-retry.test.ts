import { afterEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("undici", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
  ProxyAgent: class ProxyAgent {
    constructor(readonly proxyUrl: string) {}
  },
}));

import { modelFetch, resetModelProxyCache } from "../src/model-http.js";

const KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] as const;

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
  resetModelProxyCache();
  fetchMock.mockReset();
});

describe("model proxy failure", () => {
  it("does not retry a proxied model call on the direct network", async () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:6553";
    resetModelProxyCache();
    fetchMock.mockRejectedValue(new Error("proxy down"));
    await expect(modelFetch("https://api.example.com/v1/chat/completions", { method: "POST", body: "{}" })).rejects.toThrow(
      /proxy down/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
