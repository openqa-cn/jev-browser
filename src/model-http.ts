import { fetch as undiciFetch, ProxyAgent } from "undici";

let cachedProxy: string | undefined;
let resolved = false;

export function envProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    undefined
  );
}

export async function resolveModelProxy(): Promise<string | undefined> {
  if (resolved) return cachedProxy;
  cachedProxy = envProxyUrl();
  resolved = true;
  return cachedProxy;
}

export async function modelFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<Response> {
  const proxy = await resolveModelProxy();
  try {
    return await dispatch(url, init, proxy);
  } catch (error) {
    if (!proxy) throw error;
    if (!envProxyUrl()) {
      cachedProxy = undefined;
      resolved = true;
    }
    return await dispatch(url, init, undefined);
  }
}

async function dispatch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
  proxy?: string,
): Promise<Response> {
  const ac = new AbortController();
  const timer = init.timeoutMs ? setTimeout(() => ac.abort(), init.timeoutMs) : undefined;
  try {
    return (await undiciFetch(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      signal: ac.signal,
      dispatcher: proxy ? new ProxyAgent(proxy) : undefined,
    })) as unknown as Response;
  } catch (error) {
    if (ac.signal.aborted) {
      throw new Error(`Model request timed out after ${init.timeoutMs ?? 0}ms`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function resetModelProxyCache(): void {
  cachedProxy = undefined;
  resolved = false;
}

