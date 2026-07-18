import { MediaflowError, proxyMediaflowStream, workerProxyUrl } from "./mediaflow";
import type { MediaflowEnv, ProxyOptions } from "./mediaflow";
import type { ResolveResult } from "./types";

const supportedProtocols = new Set(["2025-03-26", "2025-11-25"]);
const latestProtocol = "2025-11-25";
const baseCors = { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-method, mcp-name", "access-control-max-age": "86400" };
const tool = {
  name: "resolve_video",
  title: "Create MediaFlow proxy URL",
  description: "Create a Worker-local MediaFlow proxy URL for a public HTTP(S) video or embed URL. The tool validates the destination and configured proxy server but does not fetch or play media.",
  inputSchema: { type: "object", additionalProperties: false, required: ["url"], properties: {
    url: { type: "string", format: "uri", description: "Public HTTP(S) video or embed URL to pass to MediaFlow." },
    proxyServer: { type: "string", format: "uri", description: "Optional exact URL from the server's MEDIAFLOW_PROXY_SERVERS allowlist." },
    redirect_stream: { type: "boolean", description: "Ask MediaFlow to return a stream redirect." },
    transcode: { type: "boolean", description: "Ask MediaFlow to transcode the stream when supported." },
    max_res: { type: "boolean", description: "Ask MediaFlow to select the maximum available resolution." }
  } },
  outputSchema: { type: "object", additionalProperties: false, required: ["url", "source", "original", "alternates"], properties: {
    url: { type: "string", format: "uri", description: "Worker-local /proxy/stream URL." },
    source: { type: "string", const: "MediaFlow Proxy" },
    original: { type: "string", format: "uri" },
    alternates: { type: "array", items: { type: "string", format: "uri" } }
  } },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
} as const;

type JsonObject = Record<string, unknown>;
type ToolArguments = { url?: string; proxyServer?: string; redirect_stream?: boolean; transcode?: boolean; max_res?: boolean };
type ValidToolArguments = ToolArguments & { url: string };
type JsonRpcId = string | number | null;

function isObject(value: unknown): value is JsonObject { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isId(value: unknown): value is JsonRpcId { return value === null || typeof value === "string" || typeof value === "number"; }
function cors(request: Request): HeadersInit { const origin = request.headers.get("origin"); return origin && origin === new URL(request.url).origin ? { ...baseCors, "access-control-allow-origin": origin, vary: "origin" } : baseCors; }
function json(request: Request, value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { ...cors(request), "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
function errorStatus(error: MediaflowError): number { return error.kind === "invalid" ? 400 : error.kind === "timeout" ? 504 : error.kind === "configuration" ? 500 : 502; }
function options(params: URLSearchParams): ProxyOptions { return { proxyServer: params.get("proxyServer") ?? undefined, redirectStream: params.get("redirect_stream") === "true", transcode: params.get("transcode") === "true", maxRes: params.get("max_res") === "true" }; }
function result(request: Request, raw: string, env: MediaflowEnv, value: ProxyOptions): ResolveResult {
  try { return { outcome: "ok", data: { url: workerProxyUrl(new URL(request.url).origin, raw, env, value), source: "MediaFlow Proxy", original: raw, alternates: [] } }; }
  catch (error) { const failure = error instanceof MediaflowError ? error : new MediaflowError("upstream_error", "The MediaFlow proxy request failed."); return { outcome: failure.kind, message: failure.message }; }
}
function status(value: ResolveResult): number { return value.outcome === "ok" ? 200 : value.outcome === "invalid" ? 400 : value.outcome === "configuration" ? 500 : value.outcome === "timeout" ? 504 : 502; }
function api(value: ResolveResult) { return value.outcome === "ok" ? { response: { status: 200, text: "OK", data: value.data } } : { response: { status: status(value), text: value.outcome, error: value.message } }; }
function proxyResponse(response: Response, request: Request): Response {
  const headers = new Headers(response.headers); const location = headers.get("location");
  if (location) { try { const redirect = new URL(location, request.url); redirect.searchParams.delete("api_password"); headers.set("location", redirect.href); } catch { /* Preserve malformed redirect locations. */ } }
  for (const [name, value] of Object.entries(cors(request))) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function toolOptions(value: ToolArguments): ProxyOptions { return { proxyServer: value.proxyServer, redirectStream: value.redirect_stream === true, transcode: value.transcode === true, maxRes: value.max_res === true }; }
function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) { return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } }; }
function rpcResult(id: JsonRpcId, value: unknown) { return { jsonrpc: "2.0", id, result: value }; }
function validToolArguments(value: unknown): value is ValidToolArguments {
  if (!isObject(value) || typeof value.url !== "string") return false;
  const allowed = new Set(["url", "proxyServer", "redirect_stream", "transcode", "max_res"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  return (value.proxyServer === undefined || typeof value.proxyServer === "string") && ["redirect_stream", "transcode", "max_res"].every((key) => value[key] === undefined || typeof value[key] === "boolean");
}
function validOrigin(request: Request): boolean { const origin = request.headers.get("origin"); return !origin || origin === new URL(request.url).origin; }
function acceptsJson(request: Request): boolean { const accept = request.headers.get("accept"); return Boolean(accept && /(?:application\/json|\*\/\*)/i.test(accept)); }
function hasJsonContentType(request: Request): boolean { return /^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""); }
function protocolHeaderValid(request: Request): boolean { const version = request.headers.get("mcp-protocol-version"); return !version || supportedProtocols.has(version); }

function mcpMessage(message: unknown, request: Request, env: MediaflowEnv, isBatch: boolean): JsonObject | undefined {
  if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || ("id" in message && !isId(message.id))) return rpcError(null, -32600, "Invalid Request");
  const id = "id" in message ? message.id as JsonRpcId : undefined;
  const params = message.params;
  if (message.method === "notifications/initialized") return id === undefined ? undefined : rpcError(id, -32600, "Invalid Request");
  if (message.method === "ping") return id === undefined ? undefined : rpcResult(id, {});
  if (message.method === "initialize") {
    if (isBatch || id === undefined || !isObject(params) || typeof params.protocolVersion !== "string") return rpcError(id ?? null, -32600, "Invalid Request");
    if (!supportedProtocols.has(params.protocolVersion)) return rpcError(id, -32602, "Unsupported protocol version", { supported: [...supportedProtocols] });
    return rpcResult(id, { protocolVersion: params.protocolVersion === latestProtocol ? latestProtocol : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "cf-stream-resolve", version: "0.3.0" }, instructions: "Use resolve_video to create a Worker-local MediaFlow proxy URL. The tool accepts only public HTTP(S) URLs and configured allowlisted proxy servers. It does not fetch media, bypass access controls, or expose MediaFlow credentials." });
  }
  if (message.method === "tools/list") {
    if (id === undefined) return undefined;
    if (params !== undefined && (!isObject(params) || (params.cursor !== undefined && typeof params.cursor !== "string"))) return rpcError(id, -32602, "Invalid params");
    if (isObject(params) && params.cursor) return rpcError(id, -32602, "Invalid params", "This server has no additional tool pages.");
    return rpcResult(id, { tools: [tool] });
  }
  if (message.method === "tools/call") {
    if (id === undefined) return undefined;
    if (!isObject(params) || params.name !== tool.name || !validToolArguments(params.arguments)) return rpcError(id, -32602, "Invalid params", "Use name 'resolve_video' with a valid arguments object.");
    const resolved = result(request, params.arguments.url, env, toolOptions(params.arguments));
    if (resolved.outcome !== "ok") return rpcResult(id, { content: [{ type: "text", text: resolved.message }], isError: true });
    return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(resolved.data) }], structuredContent: resolved.data });
  }
  return id === undefined ? undefined : rpcError(id, -32601, "Method not found");
}

async function mcp(request: Request, env: MediaflowEnv): Promise<Response> {
  if (!validOrigin(request)) return json(request, rpcError(null, -32000, "Forbidden"), 403);
  if (!hasJsonContentType(request)) return json(request, rpcError(null, -32600, "Content-Type must be application/json"), 415);
  if (!acceptsJson(request)) return json(request, rpcError(null, -32600, "Accept must include application/json"), 406);
  if (!protocolHeaderValid(request)) return json(request, rpcError(null, -32602, "Unsupported MCP-Protocol-Version"), 400);
  let parsed: unknown;
  try { parsed = await request.json(); } catch { return json(request, rpcError(null, -32700, "Parse error"), 400); }
  if (Array.isArray(parsed)) {
    if (!parsed.length) return json(request, rpcError(null, -32600, "Invalid Request"), 400);
    const responses = parsed.map((message) => mcpMessage(message, request, env, true)).filter((message): message is JsonObject => Boolean(message));
    return responses.length ? json(request, responses) : new Response(null, { status: 202, headers: cors(request) });
  }
  const response = mcpMessage(parsed, request, env, false);
  return response ? json(request, response) : new Response(null, { status: 202, headers: cors(request) });
}

export async function handle(request: Request, env: MediaflowEnv, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/mcp" && !validOrigin(request)) return json(request, { error: "Forbidden origin." }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  if (url.pathname === "/mcp") {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...cors(request), allow: "POST" } });
    return mcp(request, env);
  }
  const raw = url.searchParams.get(url.pathname === "/proxy/stream" ? "d" : "url") ?? ""; const value = options(url.searchParams);
  if (url.pathname === "/proxy/stream") { try { return proxyResponse(await proxyMediaflowStream(raw, env, value, fetcher), request); } catch (error) { const failure = error instanceof MediaflowError ? error : new MediaflowError("upstream_error", "The MediaFlow proxy request failed."); return json(request, { error: failure.message }, errorStatus(failure)); } }
  if (url.pathname === "/interaction/resolve.html") { const resolved = result(request, raw, env, value); return resolved.outcome === "ok" ? json(request, { url: resolved.data.url, label: resolved.data.source }) : json(request, { error: resolved.message }, status(resolved)); }
  if (url.pathname !== "/") return json(request, { response: { status: 404, text: "not_found", error: "Unknown endpoint." } }, 404);
  const resolved = result(request, raw, env, value);
  if (resolved.outcome === "ok" && (url.searchParams.get("format") === "redirect" || /(?:ffprobe|libavformat)/i.test(request.headers.get("user-agent") ?? ""))) return Response.redirect(resolved.data.url, 307);
  return json(request, api(resolved), status(resolved));
}

export default { fetch(request: Request, env: MediaflowEnv): Promise<Response> { return handle(request, env); } } satisfies ExportedHandler<MediaflowEnv>;
