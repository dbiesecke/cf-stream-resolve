import { describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { mediaflowRequestUrl, proxyMediaflowStream, workerProxyUrl } from "../src/mediaflow";

const env = { MEDIAFLOW_PROXY_SERVERS: "https://mediaflow-a.example,https://mediaflow-b.example", MEDIAFLOW_PROXY_DEFAULT: "https://mediaflow-a.example", MEDIAFLOW_API_PASSWORD: "test-secret" };
const video = "https://video.example/embed/fixture";
const request = (path: string, init?: RequestInit) => new Request(`https://worker.example${path}`, init);

describe("MediaFlow configuration", () => {
  it("uses the configured default and forwards only supported options", () => {
    const url = mediaflowRequestUrl(video, env, { redirectStream: true, transcode: true, maxRes: true });
    expect(url.href).toContain("https://mediaflow-a.example/proxy/stream?");
    expect(url.searchParams.get("d")).toBe(video);
    expect(url.searchParams.get("api_password")).toBe("test-secret");
    expect(url.searchParams.get("redirect_stream")).toBe("true");
    expect(url.searchParams.get("transcode")).toBe("true");
    expect(url.searchParams.get("max_res")).toBe("true");
  });
  it("accepts an exact allowlisted server and rejects unknown, unsafe, or incomplete configuration", () => {
    expect(mediaflowRequestUrl(video, env, { proxyServer: "https://mediaflow-b.example" }).hostname).toBe("mediaflow-b.example");
    expect(() => mediaflowRequestUrl(video, env, { proxyServer: "https://attacker.example" })).toThrow(/allowed/i);
    expect(() => mediaflowRequestUrl("http://127.0.0.1/secret", env)).toThrow();
    expect(() => mediaflowRequestUrl(video, { ...env, MEDIAFLOW_PROXY_DEFAULT: "" })).toThrow(/allowed/i);
    expect(() => mediaflowRequestUrl(video, { ...env, MEDIAFLOW_API_PASSWORD: "" })).toThrow(/PASSWORD/i);
  });
  it("builds a worker-local proxy URL without exposing the API password", () => {
    const url = workerProxyUrl("https://worker.example", video, env, { proxyServer: "https://mediaflow-b.example", maxRes: true });
    expect(url).toContain("https://worker.example/proxy/stream?");
    expect(url).toContain("proxyServer=https%3A%2F%2Fmediaflow-b.example");
    expect(url).not.toContain("test-secret");
  });
});

describe("MediaFlow streaming proxy", () => {
  it("forwards JSON and upstream request parameters", async () => {
    let seen: URL | undefined;
    const upstream = async (input: RequestInfo | URL) => { seen = new URL(input.toString()); return new Response('{"ok":true}', { headers: { "content-type": "application/json" } }); };
    const response = await proxyMediaflowStream(video, env, { maxRes: true }, upstream as typeof fetch);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen?.searchParams.get("api_password")).toBe("test-secret");
  });
  it("passes stream bodies and sanitized redirects through the public route", async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("#EXTM3U")); controller.close(); } });
    const streamed = await handle(request(`/proxy/stream?d=${encodeURIComponent(video)}`), env, async () => new Response(body, { headers: { "content-type": "application/vnd.apple.mpegurl" } }));
    expect(streamed.headers.get("content-type")).toContain("mpegurl");
    expect(await streamed.text()).toBe("#EXTM3U");
    const redirected = await handle(request(`/proxy/stream?d=${encodeURIComponent(video)}`), env, async () => new Response(null, { status: 302, headers: { location: "?api_password=test-secret&d=x" } }));
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).not.toContain("test-secret");
  });
  it("returns structured errors before an upstream request for invalid input", async () => {
    let called = false;
    const response = await handle(request("/proxy/stream?d=http%3A%2F%2F127.0.0.1%2Fsecret"), env, async () => { called = true; return new Response(); });
    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });
});

describe("compatibility routes", () => {
  it("keeps root, MCP, and MSX contracts while returning worker proxy URLs", async () => {
    const root = await handle(request(`/?url=${encodeURIComponent(video)}&redirect_stream=true`), env);
    const body = await root.json() as { response: { data: { url: string } } };
    expect(body.response.data.url).toContain("/proxy/stream?");
    expect(body.response.data.url).toContain("redirect_stream=true");
    const msx = await handle(request(`/interaction/resolve.html?url=${encodeURIComponent(video)}`), env);
    expect((await msx.json() as { url: string }).url).toContain("/proxy/stream?");
    const mcp = await handle(request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), env);
    const discovery = await mcp.json() as { result: { tools: Array<{ inputSchema: { properties: Record<string, unknown> } }> } };
    expect(discovery.result.tools[0].inputSchema.properties).toHaveProperty("proxyServer");
    expect(discovery.result.tools[0].inputSchema.properties).not.toHaveProperty("hostExtraction");
    const initialized = await handle(request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" }) }), env);
    expect((await initialized.json() as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("cf-stream-resolve");
    const called = await handle(request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { arguments: { url: video, transcode: true } } }) }), env);
    const callResult = await called.json() as { result: { content: Array<{ text: string }> } };
    expect(callResult.result.content[0].text).toContain("transcode=true");
  });
});
