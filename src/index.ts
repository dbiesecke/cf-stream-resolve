import { MediaflowError, proxyMediaflowStream, workerProxyUrl } from "./mediaflow";
import type { MediaflowEnv, ProxyOptions } from "./mediaflow";
import type { ResolveResult } from "./types";

const baseCors = { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, mcp-session-id", "access-control-max-age": "86400" };
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
  const headers = new Headers(response.headers);
  const location = headers.get("location");
  if (location) { try { const redirect = new URL(location, request.url); redirect.searchParams.delete("api_password"); headers.set("location", redirect.href); } catch { /* Preserve malformed redirect locations. */ } }
  for (const [name, value] of Object.entries(cors(request))) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

type ToolArguments = { url?: string; proxyServer?: string; redirect_stream?: boolean; transcode?: boolean; max_res?: boolean };
function toolOptions(value: ToolArguments = {}): ProxyOptions { return { proxyServer: value.proxyServer, redirectStream: value.redirect_stream === true, transcode: value.transcode === true, maxRes: value.max_res === true }; }
async function mcp(request: Request, env: MediaflowEnv): Promise<Response> {
  let body: { method?: string; id?: string | number | null; params?: { arguments?: ToolArguments } };
  try { body = await request.json(); } catch { return json(request, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400); }
  const id = body.id ?? null;
  if (body.method === "initialize") return json(request, { jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "cf-stream-resolve", version: "0.2.0" } } });
  if (body.method === "tools/list") return json(request, { jsonrpc: "2.0", id, result: { tools: [{ name: "resolve_video", description: "Create a MediaFlow proxy URL for a public HTTP(S) video or embed URL.", inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" }, proxyServer: { type: "string", description: "Optional exact URL from MEDIAFLOW_PROXY_SERVERS." }, redirect_stream: { type: "boolean" }, transcode: { type: "boolean" }, max_res: { type: "boolean" } } } }] } });
  if (body.method === "tools/call") { const args = body.params?.arguments ?? {}; const value = result(request, args.url ?? "", env, toolOptions(args)); return json(request, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(api(value)) }], ...(value.outcome === "ok" ? {} : { isError: true }) } }); }
  return json(request, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }, 404);
}

export async function handle(request: Request, env: MediaflowEnv, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  if (url.pathname === "/mcp") return request.method === "POST" ? mcp(request, env) : json(request, { error: "Use JSON-RPC 2.0 POST." }, 405);
  const raw = url.searchParams.get(url.pathname === "/proxy/stream" ? "d" : "url") ?? "";
  const value = options(url.searchParams);
  if (url.pathname === "/proxy/stream") {
    try { return proxyResponse(await proxyMediaflowStream(raw, env, value, fetcher), request); }
    catch (error) { const failure = error instanceof MediaflowError ? error : new MediaflowError("upstream_error", "The MediaFlow proxy request failed."); return json(request, { error: failure.message }, errorStatus(failure)); }
  }
  if (url.pathname === "/interaction/resolve.html") { const resolved = result(request, raw, env, value); return resolved.outcome === "ok" ? json(request, { url: resolved.data.url, label: resolved.data.source }) : json(request, { error: resolved.message }, status(resolved)); }
  if (url.pathname !== "/") return json(request, { response: { status: 404, text: "not_found", error: "Unknown endpoint." } }, 404);
  const resolved = result(request, raw, env, value);
  if (resolved.outcome === "ok" && (url.searchParams.get("format") === "redirect" || /(?:ffprobe|libavformat)/i.test(request.headers.get("user-agent") ?? ""))) return Response.redirect(resolved.data.url, 307);
  return json(request, api(resolved), status(resolved));
}

export default { fetch(request: Request, env: MediaflowEnv): Promise<Response> { return handle(request, env); } } satisfies ExportedHandler<MediaflowEnv>;
