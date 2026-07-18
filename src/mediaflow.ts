import { validatePublicUrl } from "./validation";

export interface MediaflowConfig {
  MEDIAFLOW_PROXY_SERVERS?: string;
  MEDIAFLOW_PROXY_DEFAULT?: string;
  MEDIAFLOW_API_PASSWORD?: string;
}

export interface ProxyOptions {
  redirectStream?: boolean;
  transcode?: boolean;
  maxRes?: boolean;
}

export class MediaflowError extends Error {
  constructor(public readonly kind: "invalid" | "configuration" | "upstream_error" | "timeout", message: string) {
    super(message);
  }
}

const HEADER_TIMEOUT_MS = 10_000;
const MAX_MANIFEST_BYTES = 2_000_000;
const gatewayPaths = new Set([
  "/proxy/stream",
  "/proxy/hls/manifest.m3u8",
  "/proxy/mpd/manifest.m3u8",
  "/proxy/mpd/playlist.m3u8",
  "/proxy/mpd/segment.mp4",
  "/extractor/video",
]);
const hlsSegmentPath = /^\/proxy\/hls\/segment\.(?:ts|m4s|mp4|m4a|m4v|aac)$/;
const requestHeaders = new Set(["accept", "content-type", "if-range", "range"]);

function configuredServers(env: MediaflowConfig): string[] {
  return [...new Set((env.MEDIAFLOW_PROXY_SERVERS ?? "").split(",").map((value) => value.trim().replace(/\/+$/, "")).filter(Boolean))];
}

function selectedServer(env: MediaflowConfig): URL {
  const servers = configuredServers(env);
  const candidate = (env.MEDIAFLOW_PROXY_DEFAULT || servers[0] || "").trim().replace(/\/+$/, "");
  if (!candidate || !servers.includes(candidate)) throw new MediaflowError("configuration", "No allowed MediaFlow proxy server is configured.");
  try { return validatePublicUrl(candidate); } catch { throw new MediaflowError("configuration", "A configured MediaFlow proxy server is invalid."); }
}

export function assertMediaflowConfigured(env: MediaflowConfig): void {
  selectedServer(env);
  apiPassword(env);
}

function apiPassword(env: MediaflowConfig): string {
  if (!env.MEDIAFLOW_API_PASSWORD) throw new MediaflowError("configuration", "MEDIAFLOW_API_PASSWORD is not configured.");
  return env.MEDIAFLOW_API_PASSWORD;
}

export function isMediaflowGatewayPath(pathname: string): boolean {
  return gatewayPaths.has(pathname) || hlsSegmentPath.test(pathname);
}

function allowedParameter(pathname: string, name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "d" || lower.startsWith("h_") || lower.startsWith("r_") || lower.startsWith("rp_")) return true;
  if (pathname === "/proxy/hls/manifest.m3u8") return lower === "key_url";
  if (pathname === "/proxy/mpd/manifest.m3u8") return lower === "key_id" || lower === "key";
  if (pathname === "/proxy/mpd/playlist.m3u8") return lower === "profile_id" || lower === "key_id" || lower === "key";
  if (pathname === "/proxy/mpd/segment.mp4") return ["init_url", "segment_url", "mime_type", "key_id", "key"].includes(lower);
  if (pathname === "/extractor/video") return ["host", "redirect_stream", "extra_params"].includes(lower);
  return false;
}

export function mediaflowGatewayUrl(pathname: string, params: URLSearchParams, env: MediaflowConfig): URL {
  if (!isMediaflowGatewayPath(pathname)) throw new MediaflowError("invalid", "Unsupported MediaFlow gateway path.");
  assertMediaflowConfigured(env);
  const target = new URL(pathname, `${selectedServer(env).href}/`);
  for (const [name, value] of params) {
    if (!allowedParameter(pathname, name)) continue;
    const lower = name.toLowerCase();
    const normalized = ["d", "key_url", "init_url", "segment_url"].includes(lower) ? validateGatewayDestination(value) : value;
    target.searchParams.append(name, normalized);
  }
  target.searchParams.set("api_password", apiPassword(env));
  return target;
}

function validateGatewayDestination(value: string): string {
  try { return validatePublicUrl(value).href; }
  catch (error) { throw new MediaflowError("invalid", (error as Error).message); }
}

function upstreamHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of requestHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function directFallbackHeaders(request: Request, params: URLSearchParams): Headers {
  const headers = upstreamHeaders(request);
  const allowedContextHeaders = new Set(["authorization", "cookie", "origin", "referer", "user-agent"]);
  for (const [name, value] of params) {
    if (!name.toLowerCase().startsWith("h_")) continue;
    const header = name.slice(2).replaceAll("_", "-").toLowerCase();
    if (allowedContextHeaders.has(header)) headers.set(header, value);
  }
  return headers;
}

async function fetchWithHeaderTimeout(target: URL, init: RequestInit, fetcher: typeof fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
  try { return await fetcher(target, { ...init, signal: controller.signal }); }
  catch (error) { throw new MediaflowError((error as Error).name === "AbortError" ? "timeout" : "upstream_error", "The MediaFlow proxy request failed."); }
  finally { clearTimeout(timer); }
}

async function isCloudflare1003(response: Response): Promise<boolean> {
  if (response.status !== 403 || response.headers.get("server")?.toLowerCase() !== "cloudflare") return false;
  const length = Number(response.headers.get("content-length") ?? 0);
  if (!length || length > 64) return false;
  return (await response.clone().text()).trim().toLowerCase() === "error code: 1003";
}

export async function fetchMediaflowGateway(request: Request, env: MediaflowConfig, fetcher: typeof fetch = fetch): Promise<{ response: Response; target: URL }> {
  const incoming = new URL(request.url);
  const target = mediaflowGatewayUrl(incoming.pathname, incoming.searchParams, env);
  const response = await fetchWithHeaderTimeout(target, { method: request.method, headers: upstreamHeaders(request), redirect: "manual" }, fetcher);
  if (await isCloudflare1003(response)) {
    const noProxyTarget = new URL(target);
    noProxyTarget.searchParams.set("no_proxy", "true");
    const noProxyResponse = await fetchWithHeaderTimeout(noProxyTarget, { method: request.method, headers: upstreamHeaders(request), redirect: "manual" }, fetcher);
    if (!await isCloudflare1003(noProxyResponse)) return { response: noProxyResponse, target };
    const destination = incoming.searchParams.get("d");
    if (!destination) return { response: noProxyResponse, target };
    const directTarget = new URL(validateGatewayDestination(destination));
    const direct = await fetchWithHeaderTimeout(directTarget, { method: request.method, headers: directFallbackHeaders(request, incoming.searchParams), redirect: "manual" }, fetcher);
    return { response: direct, target };
  }
  return { response, target };
}

function publicUrlForMediaflowUrl(raw: string, publicOrigin: string, target: URL, env: MediaflowConfig, playlist: boolean): string {
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    const destination = target.searchParams.get("d");
    if (!destination) return raw;
    try { parsed = new URL(raw, destination); } catch { return raw; }
  }

  const upstreamOrigins = new Set(configuredServers(env).map((server) => new URL(server).origin));
  if (upstreamOrigins.has(parsed.origin)) {
    const publicUrl = new URL(parsed.pathname, publicOrigin);
    for (const [name, value] of parsed.searchParams) if (name.toLowerCase() !== "api_password") publicUrl.searchParams.append(name, value);
    return publicUrl.href;
  }

  parsed.searchParams.delete("api_password");
  const publicUrl = new URL(playlist ? "/proxy/hls/manifest.m3u8" : "/proxy/stream", publicOrigin);
  publicUrl.searchParams.set("d", parsed.href);
  for (const [name, value] of target.searchParams) {
    const lower = name.toLowerCase();
    if ((lower.startsWith("h_") || lower.startsWith("rp_")) && !publicUrl.searchParams.has(name)) publicUrl.searchParams.append(name, value);
  }
  return publicUrl.href;
}

export function rewriteManifest(manifest: string, publicOrigin: string, target: URL, env: MediaflowConfig): string {
  let afterStreamInfo = false;
  return manifest.split(/\r?\n/).map((line) => {
    const isSubPlaylistTag = line.startsWith("#EXT-X-MEDIA") || line.startsWith("#EXT-X-I-FRAME-STREAM-INF");
    const rewrittenAttributes = line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${publicUrlForMediaflowUrl(uri, publicOrigin, target, env, isSubPlaylistTag)}"`);
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      afterStreamInfo = true;
      return rewrittenAttributes;
    }
    if (line.startsWith("#")) {
      if (!line.startsWith("#EXT-X-STREAM-INF")) afterStreamInfo = false;
      return rewrittenAttributes;
    }
    if (!line.trim()) return rewrittenAttributes;
    const playlist = afterStreamInfo || /\.(?:m3u8?|m3u_plus)(?:[?#]|$)/i.test(line.trim());
    afterStreamInfo = false;
    return publicUrlForMediaflowUrl(line.trim(), publicOrigin, target, env, playlist);
  }).join("\n");
}

async function boundedManifest(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_MANIFEST_BYTES) throw new MediaflowError("upstream_error", "The upstream HLS manifest is too large.");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > MAX_MANIFEST_BYTES) {
      await reader.cancel();
      throw new MediaflowError("upstream_error", "The upstream HLS manifest is too large.");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function isManifestResponse(response: Response, pathname: string): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return response.ok && (pathname.endsWith(".m3u8") || contentType.includes("mpegurl"));
}

function responseHeaders(response: Response, corsHeaders: HeadersInit): Headers {
  const headers = new Headers(response.headers);
  for (const header of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]) headers.delete(header);
  for (const [name, value] of new Headers(corsHeaders)) headers.set(name, value);
  return headers;
}

export async function publicMediaflowResponse(
  upstream: Response,
  target: URL,
  request: Request,
  env: MediaflowConfig,
  corsHeaders: HeadersInit,
): Promise<Response> {
  const headers = responseHeaders(upstream, corsHeaders);
  const location = headers.get("location");
  if (location) {
    try { headers.set("location", publicUrlForMediaflowUrl(new URL(location, target).href, new URL(request.url).origin, target, env, false)); }
    catch { headers.delete("location"); }
  }

  if (request.method !== "HEAD" && upstream.body && isManifestResponse(upstream, new URL(request.url).pathname)) {
    const manifest = rewriteManifest(await boundedManifest(upstream), new URL(request.url).origin, target, env);
    headers.delete("content-length");
    headers.delete("content-range");
    headers.set("content-type", "application/vnd.apple.mpegurl; charset=utf-8");
    return new Response(manifest, { status: upstream.status, statusText: upstream.statusText, headers });
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

// Compatibility helpers retained for existing imports and callers.
export function mediaflowRequestUrl(raw: string, env: MediaflowConfig, _options: ProxyOptions = {}): URL {
  const destination = validatePublicUrl(raw);
  return mediaflowGatewayUrl("/proxy/stream", new URLSearchParams({ d: destination.href }), env);
}

export async function proxyMediaflowStream(raw: string, env: MediaflowConfig, _options: ProxyOptions = {}, fetcher: typeof fetch = fetch): Promise<Response> {
  const target = mediaflowRequestUrl(raw, env);
  try { return await fetcher(target, { redirect: "manual" }); }
  catch (error) { throw new MediaflowError((error as Error).name === "AbortError" ? "timeout" : "upstream_error", "The MediaFlow proxy request failed."); }
}

export function workerProxyUrl(origin: string, raw: string, env: MediaflowConfig, _options: ProxyOptions = {}): string {
  assertMediaflowConfigured(env);
  const destination = validatePublicUrl(raw);
  const path = /\.(?:m3u8?|m3u)(?:[?#]|$)/i.test(destination.href) ? "/proxy/hls/manifest.m3u8" : /\.mpd(?:[?#]|$)/i.test(destination.href) ? "/proxy/mpd/manifest.m3u8" : "/proxy/stream";
  const target = new URL(path, origin);
  target.searchParams.set("d", destination.href);
  return target.href;
}
