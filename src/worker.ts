import { fetchMediaflowGateway, isMediaflowGatewayPath, MediaflowError, publicMediaflowResponse } from "./mediaflow";
import type { MediaflowConfig } from "./mediaflow";
import { diagnoseVideo, resolveVideo } from "./resolver";
import type { ResolveVideoArguments } from "./resolver";
import { defaultDnsLookup, readBoundedText } from "./network";
import { publicProviderList } from "./providers";
import type { DnsLookup } from "./validation";
import type { ResolveResult } from "./types";

const supportedProtocols = new Set(["2025-03-26", "2025-11-25"]);
const latestProtocol = "2025-11-25";
const baseCors = {
  "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
  "access-control-allow-headers": "content-type, range, if-range, mcp-protocol-version, mcp-method, mcp-name",
  "access-control-expose-headers": "accept-ranges, content-length, content-range, content-type, location",
  "access-control-max-age": "86400",
};

const tool = {
  name: "resolve_video",
  title: "Resolve video playback URL",
  description: "Classify a public HTTP(S) video, manifest, or supported embed URL and create the correct Worker-local MediaFlow playback URL without fetching the media during the tool call.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", format: "uri", description: "Public HTTP(S) video, manifest, or embed URL." },
      link: { type: "string", format: "uri", description: "Optional public source-page context used only as upstream Referer and Origin." },
      endpoint: { type: "string", const: "/proxy/stream", description: "Compatibility marker; automatic endpoint selection always takes precedence." },
      provider: { type: "string", description: "Optional provider ID or canonical MediaFlow name. Direct media URLs take precedence." },
      redirect_stream: { type: "boolean", description: "Ask a supported MediaFlow extractor to redirect to its stream." },
      transcode: { type: "boolean", description: "Compatibility option; ignored with a warning when unsupported by the configured MediaFlow API." },
      max_res: { type: "boolean", description: "Compatibility option; ignored with a warning when unsupported by the configured MediaFlow API." },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url", "source", "original", "alternates"],
    properties: {
      url: { type: "string", format: "uri", description: "Direct YouTube URL or Worker-local playback URL." },
      source: { type: "string" },
      original: { type: "string", format: "uri" },
      alternates: { type: "array", items: { type: "string", format: "uri" } },
      mediaType: { type: "string", enum: ["youtube", "hls", "dash", "stream", "extractor"] },
      warnings: { type: "array", items: { type: "string" } },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
} as const;

type JsonObject = Record<string, unknown>;
type ValidToolArguments = ResolveVideoArguments & { url: string };
type JsonRpcId = string | number | null;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || typeof value === "number";
}

function cors(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  return origin && origin === new URL(request.url).origin
    ? { ...baseCors, "access-control-allow-origin": origin, vary: "origin" }
    : baseCors;
}

function gatewayCors(): HeadersInit {
  return { ...baseCors, "access-control-allow-origin": "*" };
}

function json(request: Request, value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...cors(request), "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function publicJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...gatewayCors(), "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function errorStatus(error: MediaflowError): number {
  return error.kind === "invalid" ? 400 : error.kind === "timeout" ? 504 : error.kind === "configuration" ? 500 : 502;
}

function status(value: ResolveResult): number {
  if (value.outcome === "ok") return 200;
  if (value.outcome === "invalid") return 400;
  if (value.outcome === "unsupported_provider") return 422;
  if (value.outcome === "configuration") return 500;
  if (value.outcome === "timeout") return 504;
  return 502;
}

function api(value: ResolveResult) {
  return value.outcome === "ok"
    ? { response: { status: 200, text: "OK", data: value.data } }
    : { response: { status: status(value), text: value.outcome, error: value.message } };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function rpcResult(id: JsonRpcId, value: unknown) {
  return { jsonrpc: "2.0", id, result: value };
}

function validToolArguments(value: unknown): value is ValidToolArguments {
  if (!isObject(value) || typeof value.url !== "string") return false;
  const allowed = new Set(["url", "link", "endpoint", "provider", "redirect_stream", "transcode", "max_res"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  return (value.link === undefined || typeof value.link === "string")
    && (value.provider === undefined || typeof value.provider === "string")
    && (value.endpoint === undefined || value.endpoint === "/proxy/stream")
    && ["redirect_stream", "transcode", "max_res"].every((key) => value[key] === undefined || typeof value[key] === "boolean");
}

function validOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function acceptsJson(request: Request): boolean {
  const accept = request.headers.get("accept");
  return Boolean(accept && /(?:application\/json|\*\/\*)/i.test(accept));
}

function hasJsonContentType(request: Request): boolean {
  return /^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "");
}

function protocolHeaderValid(request: Request): boolean {
  const version = request.headers.get("mcp-protocol-version");
  return !version || supportedProtocols.has(version);
}

async function mcpMessage(message: unknown, request: Request, env: MediaflowConfig, isBatch: boolean, fetcher: typeof fetch, lookup: DnsLookup): Promise<JsonObject | undefined> {
  if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || ("id" in message && !isId(message.id))) return rpcError(null, -32600, "Invalid Request");
  const id = "id" in message ? message.id as JsonRpcId : undefined;
  const params = message.params;

  if (message.method === "notifications/initialized") return id === undefined ? undefined : rpcError(id, -32600, "Invalid Request");
  if (message.method === "ping") return id === undefined ? undefined : rpcResult(id, {});
  if (message.method === "initialize") {
    if (isBatch || id === undefined || !isObject(params) || typeof params.protocolVersion !== "string") return rpcError(id ?? null, -32600, "Invalid Request");
    if (!supportedProtocols.has(params.protocolVersion)) return rpcError(id, -32602, "Unsupported protocol version", { supported: [...supportedProtocols] });
    return rpcResult(id, {
      protocolVersion: params.protocolVersion === latestProtocol ? latestProtocol : "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "cf-stream-resolve", version: "0.5.1" },
      instructions: "Use resolve_video to create the correct Worker-local playback URL for public HTTP(S) media. YouTube remains direct. The server never exposes MediaFlow credentials.",
    });
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
    const resolved = await resolveVideo(new URL(request.url).origin, params.arguments, env, fetcher, lookup);
    if (resolved.outcome !== "ok") return rpcResult(id, { content: [{ type: "text", text: JSON.stringify({ outcome: resolved.outcome, message: resolved.message }) }], isError: true });
    return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(resolved.data) }], structuredContent: resolved.data });
  }
  return id === undefined ? undefined : rpcError(id, -32601, "Method not found");
}

async function mcp(request: Request, env: MediaflowConfig, fetcher: typeof fetch, lookup: DnsLookup): Promise<Response> {
  if (!validOrigin(request)) return json(request, rpcError(null, -32000, "Forbidden"), 403);
  if (!hasJsonContentType(request)) return json(request, rpcError(null, -32600, "Content-Type must be application/json"), 415);
  if (!acceptsJson(request)) return json(request, rpcError(null, -32600, "Accept must include application/json"), 406);
  if (!protocolHeaderValid(request)) return json(request, rpcError(null, -32602, "Unsupported MCP-Protocol-Version"), 400);
  let parsed: unknown;
  try { parsed = await request.json(); } catch { return json(request, rpcError(null, -32700, "Parse error"), 400); }
  if (Array.isArray(parsed)) {
    if (!parsed.length) return json(request, rpcError(null, -32600, "Invalid Request"), 400);
    const values = await Promise.all(parsed.map((message) => mcpMessage(message, request, env, true, fetcher, lookup)));
    const responses = values.filter((message): message is JsonObject => Boolean(message));
    return responses.length ? json(request, responses) : new Response(null, { status: 202, headers: cors(request) });
  }
  const response = await mcpMessage(parsed, request, env, false, fetcher, lookup);
  return response ? json(request, response) : new Response(null, { status: 202, headers: cors(request) });
}

function requestArguments(url: URL): ResolveVideoArguments {
  return {
    url: url.searchParams.get("url") ?? "",
    link: url.searchParams.get("link") ?? undefined,
    endpoint: url.searchParams.get("endpoint") ?? undefined,
    provider: url.searchParams.get("provider") ?? undefined,
    redirect_stream: url.searchParams.get("redirect_stream") === "true",
    transcode: url.searchParams.get("transcode") === "true",
    max_res: url.searchParams.get("max_res") === "true",
  };
}

export async function handle(request: Request, env: MediaflowConfig, fetcher: typeof fetch = fetch, lookup: DnsLookup = defaultDnsLookup): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/mcp" && !validOrigin(request)) return json(request, { error: "Forbidden origin." }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: isMediaflowGatewayPath(url.pathname) || url.pathname.startsWith("/resolve/") ? gatewayCors() : cors(request) });

  if (url.pathname === "/resolve/providers") {
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { ...gatewayCors(), allow: "GET" } });
    return publicJson({ providers: publicProviderList() });
  }

  if (url.pathname === "/resolve/diagnose") {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...gatewayCors(), allow: "POST" } });
    if (!hasJsonContentType(request)) return publicJson({ error: { code: "INVALID_URL", message: "Content-Type must be application/json." } }, 415);
    let body: unknown;
    try { body = JSON.parse(await readBoundedText(new Response(request.body), 16 * 1024)); }
    catch { return publicJson({ error: { code: "INVALID_URL", message: "The request body must be valid JSON up to 16 KiB." } }, 400); }
    const valid = isObject(body)
      && Object.keys(body).every((key) => ["url", "redirectStream", "checkPlayback"].includes(key))
      && typeof body.url === "string"
      && (body.redirectStream === undefined || typeof body.redirectStream === "boolean")
      && (body.checkPlayback === undefined || typeof body.checkPlayback === "boolean");
    if (!valid) return publicJson({ error: { code: "INVALID_URL", message: "Use url with optional redirectStream and checkPlayback booleans." } }, 400);
    const diagnosticRequest = body as JsonObject;
    const result = await diagnoseVideo(url.origin, { url: diagnosticRequest.url as string, redirectStream: diagnosticRequest.redirectStream as boolean | undefined, checkPlayback: diagnosticRequest.checkPlayback as boolean | undefined }, env, fetcher, lookup);
    const responseStatus = result.status === "failed" ? (result.error?.code === "TIMEOUT" ? 504 : result.error?.code === "CONFIGURATION" ? 500 : 400) : result.status === "unsupported" ? 422 : 200;
    return publicJson(result, responseStatus);
  }

  if (url.pathname === "/mcp") {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...cors(request), allow: "POST" } });
    return mcp(request, env, fetcher, lookup);
  }

  if (isMediaflowGatewayPath(url.pathname)) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { ...gatewayCors(), allow: "GET, HEAD" } });
    try {
      const { response, target } = await fetchMediaflowGateway(request, env, fetcher, lookup);
      return await publicMediaflowResponse(response, target, request, env, gatewayCors());
    } catch (error) {
      const failure = error instanceof MediaflowError ? error : new MediaflowError("upstream_error", "The MediaFlow proxy request failed.");
      return publicJson({ error: failure.message }, errorStatus(failure));
    }
  }

  const resolved = await resolveVideo(url.origin, requestArguments(url), env, fetcher, lookup);
  if (url.pathname === "/interaction/resolve.html") {
    return resolved.outcome === "ok"
      ? json(request, { url: resolved.data.url, label: resolved.data.source, ...(resolved.data.mediaType ? { mediaType: resolved.data.mediaType } : {}), ...(resolved.data.warnings ? { warnings: resolved.data.warnings } : {}) })
      : json(request, { error: resolved.message }, status(resolved));
  }
  if (url.pathname !== "/") return json(request, { response: { status: 404, text: "not_found", error: "Unknown endpoint." } }, 404);
  if (resolved.outcome === "ok" && (url.searchParams.get("format") === "redirect" || /(?:ffprobe|libavformat)/i.test(request.headers.get("user-agent") ?? ""))) return Response.redirect(resolved.data.url, 307);
  return json(request, api(resolved), status(resolved));
}
