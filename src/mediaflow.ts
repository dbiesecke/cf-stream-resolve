import { validatePublicUrl } from "./validation";

export interface MediaflowEnv {
  MEDIAFLOW_PROXY_SERVERS?: string;
  MEDIAFLOW_PROXY_DEFAULT?: string;
  MEDIAFLOW_API_PASSWORD?: string;
}

export interface ProxyOptions {
  proxyServer?: string;
  redirectStream?: boolean;
  transcode?: boolean;
  maxRes?: boolean;
}

export class MediaflowError extends Error {
  constructor(public readonly kind: "invalid" | "configuration" | "upstream_error" | "timeout", message: string) {
    super(message);
  }
}

function configuredServers(env: MediaflowEnv): Set<string> {
  return new Set((env.MEDIAFLOW_PROXY_SERVERS ?? "").split(",").map((value) => value.trim().replace(/\/+$/, "")).filter(Boolean));
}

function selectedServer(env: MediaflowEnv, requested?: string): string {
  const servers = configuredServers(env);
  const candidate = (requested ?? env.MEDIAFLOW_PROXY_DEFAULT ?? "").trim().replace(/\/+$/, "");
  if (!candidate || !servers.has(candidate)) throw new MediaflowError("configuration", "No allowed MediaFlow proxy server is configured.");
  try { validatePublicUrl(candidate); } catch { throw new MediaflowError("configuration", "A configured MediaFlow proxy server is invalid."); }
  if (!env.MEDIAFLOW_API_PASSWORD) throw new MediaflowError("configuration", "MEDIAFLOW_API_PASSWORD is not configured.");
  return candidate;
}

export function mediaflowRequestUrl(raw: string, env: MediaflowEnv, options: ProxyOptions = {}): URL {
  let destination: URL;
  try { destination = validatePublicUrl(raw); } catch (error) { throw new MediaflowError("invalid", (error as Error).message); }
  const server = selectedServer(env, options.proxyServer);
  const target = new URL("/proxy/stream", `${server}/`);
  target.searchParams.set("d", destination.href);
  target.searchParams.set("api_password", env.MEDIAFLOW_API_PASSWORD!);
  if (options.redirectStream) target.searchParams.set("redirect_stream", "true");
  if (options.transcode) target.searchParams.set("transcode", "true");
  if (options.maxRes) target.searchParams.set("max_res", "true");
  return target;
}

export async function proxyMediaflowStream(raw: string, env: MediaflowEnv, options: ProxyOptions = {}, fetcher: typeof fetch = fetch): Promise<Response> {
  const target = mediaflowRequestUrl(raw, env, options);
  try { return await fetcher(target, { redirect: "manual" }); }
  catch (error) { throw new MediaflowError((error as Error).name === "AbortError" ? "timeout" : "upstream_error", "The MediaFlow proxy request failed."); }
}

export function workerProxyUrl(origin: string, raw: string, env: MediaflowEnv, options: ProxyOptions = {}): string {
  mediaflowRequestUrl(raw, env, options);
  const target = new URL("/proxy/stream", origin);
  target.searchParams.set("d", validatePublicUrl(raw).href);
  if (options.proxyServer) target.searchParams.set("proxyServer", options.proxyServer);
  if (options.redirectStream) target.searchParams.set("redirect_stream", "true");
  if (options.transcode) target.searchParams.set("transcode", "true");
  if (options.maxRes) target.searchParams.set("max_res", "true");
  return target.href;
}
