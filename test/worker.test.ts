import { describe, expect, it } from "vitest";
import { handle as workerHandle } from "../src/worker";
import {
  fetchMediaflowGateway,
  mediaflowGatewayUrl,
  rewriteManifest,
  workerProxyUrl,
} from "../src/mediaflow";
import { resolveVideo } from "../src/resolver";

const env = {
  MEDIAFLOW_PROXY_SERVERS: "https://mediaflow-a.example,https://mediaflow-b.example",
  MEDIAFLOW_PROXY_DEFAULT: "https://mediaflow-a.example",
  MEDIAFLOW_API_PASSWORD: "test-secret",
};
const publicDns = async () => ["93.184.216.34"];
const handle: typeof workerHandle = (incoming, testEnv, fetcher = fetch) => workerHandle(incoming, testEnv, fetcher, publicDns);
const directHls = "https://stream.4fun.tv:8888/hls/4f_high/index.m3u8";
const genericVideo = "https://video.example/embed/fixture";
const request = (path: string, init?: RequestInit) => new Request(`https://worker.example${path}`, init);
const mcp = (body: unknown, init: RequestInit = {}) => {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return handle(request("/mcp", { ...init, method: "POST", headers, body: JSON.stringify(body) }), env);
};

describe("resolve_video routing", () => {
  it("routes the reported Vidmoly result through the HLS endpoint", async () => {
    const result = await resolveVideo("https://worker.example", {
      url: directHls,
      link: "https://vidmoly.biz/embed-ynhyvaz86ylw.html",
      endpoint: "/proxy/stream",
      provider: "Vidmoly",
      redirect_stream: true,
      max_res: true,
    }, env);
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    const url = new URL(result.data.url);
    expect(url.pathname).toBe("/proxy/hls/manifest.m3u8");
    expect(url.searchParams.get("d")).toBe(directHls);
    expect(url.searchParams.get("h_referer")).toBe("https://vidmoly.biz/embed-ynhyvaz86ylw.html");
    expect(url.searchParams.has("redirect_stream")).toBe(false);
    expect(url.searchParams.has("max_res")).toBe(false);
    expect(result.data.mediaType).toBe("hls");
    expect(result.data.warnings).toHaveLength(2);
    expect(result.data.url).not.toContain("test-secret");
    expect(result.data.url).not.toContain("mediaflow-a.example");
  });

  it("keeps YouTube direct without requiring MediaFlow configuration", async () => {
    const result = await resolveVideo("https://worker.example", { url: "https://youtu.be/fixture" }, {});
    expect(result).toMatchObject({ outcome: "ok", data: { url: "https://youtu.be/fixture", mediaType: "youtube" } });
  });

  it("routes DASH, direct streams, and supported extractors deterministically", async () => {
    expect(await resolveVideo("https://worker.example", { url: "https://cdn.example/video.mpd" }, env)).toMatchObject({ outcome: "ok", data: { mediaType: "dash" } });
    expect(await resolveVideo("https://worker.example", { url: "https://video.example/file.mp4" }, env)).toMatchObject({ outcome: "ok", data: { mediaType: "stream" } });
    const extractor = await resolveVideo("https://worker.example", { url: "https://doodstream.com/e/fixture", provider: "DOODSTREAM", redirect_stream: true }, env);
    expect(extractor).toMatchObject({ outcome: "ok", data: { mediaType: "extractor" } });
    if (extractor.outcome === "ok") {
      const url = new URL(extractor.data.url);
      expect(url.pathname).toBe("/extractor/video.mp4");
      expect(url.searchParams.get("host")).toBe("Doodstream");
      expect(url.searchParams.get("redirect_stream")).toBe("true");
    }
  });

  it("supports Vidmoly embeds and separate direct URLs with Vidmoly context", async () => {
    expect(await resolveVideo("https://worker.example", { url: "https://vidmoly.biz/embed-fixture.html", provider: "Vidmoly" }, env)).toMatchObject({ outcome: "ok", data: { mediaType: "extractor" } });
    expect(await resolveVideo("https://worker.example", { url: "https://cdn.example/token", link: "https://vidmoly.biz/embed-fixture.html", provider: "Vidmoly" }, env)).toMatchObject({ outcome: "ok", data: { mediaType: "stream" } });
  });
});

describe("MediaFlow gateway", () => {
  it("uses only configured servers, appends the secret upstream, and filters unsupported parameters", () => {
    const target = mediaflowGatewayUrl("/proxy/hls/manifest.m3u8", new URLSearchParams({ d: directHls, max_res: "true", h_referer: "https://vidmoly.biz/" }), env);
    expect(target.origin).toBe("https://mediaflow-a.example");
    expect(target.searchParams.get("api_password")).toBe("test-secret");
    expect(target.searchParams.get("d")).toBe(directHls);
    expect(target.searchParams.get("h_referer")).toBe("https://vidmoly.biz/");
    expect(target.searchParams.has("max_res")).toBe(false);
    expect(() => mediaflowGatewayUrl("/proxy/stream", new URLSearchParams({ d: "http://127.0.0.1/secret" }), env)).toThrow(/publicly routable/i);
    expect(() => mediaflowGatewayUrl("/unknown", new URLSearchParams({ d: directHls }), env)).toThrow(/unsupported/i);
  });

  it("selects specialized compatibility URLs without exposing configuration", () => {
    expect(new URL(workerProxyUrl("https://worker.example", directHls, env)).pathname).toBe("/proxy/hls/manifest.m3u8");
    expect(new URL(workerProxyUrl("https://worker.example", "https://cdn.example/video.mpd", env)).pathname).toBe("/proxy/mpd/manifest.m3u8");
    expect(workerProxyUrl("https://worker.example", genericVideo, env)).not.toMatch(/test-secret|mediaflow-a/);
  });

  it("forwards HEAD and range metadata to MediaFlow", async () => {
    let seenRequest: Request | undefined;
    const incoming = request(`/proxy/stream?d=${encodeURIComponent(genericVideo)}`, { method: "HEAD", headers: { range: "bytes=0-99", "if-range": "etag", accept: "video/*" } });
    const result = await fetchMediaflowGateway(incoming, env, async (input, init) => {
      seenRequest = new Request(input, init);
      return new Response(null, { status: 206, headers: { "content-range": "bytes 0-99/1000" } });
    }, publicDns);
    expect(seenRequest?.method).toBe("HEAD");
    expect(seenRequest?.headers.get("range")).toBe("bytes=0-99");
    expect(seenRequest?.headers.get("if-range")).toBe("etag");
    expect(result.target.searchParams.get("api_password")).toBe("test-secret");
  });

  it("streams binary responses and preserves range status", async () => {
    const response = await handle(request(`/proxy/stream?d=${encodeURIComponent(genericVideo)}`, { headers: { range: "bytes=0-2" } }), env, async () => new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-2/10" } }));
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-2/10");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("rewrites nested HLS URLs, segment URLs, key URLs, and map URLs", async () => {
    const manifest = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=1000",
      "https://mediaflow-a.example/proxy/hls/manifest.m3u8?d=https%3A%2F%2Fcdn.example%2Flow.m3u8&api_password=test-secret",
      "#EXT-X-MEDIA:TYPE=AUDIO,URI=\"https://cdn.example/audio.m3u8\"",
      "#EXT-X-KEY:METHOD=AES-128,URI=\"https://keys.example/key.bin\"",
      "#EXT-X-MAP:URI=\"init.mp4\"",
      "#EXTINF:6.0,",
      "938694.ts",
    ].join("\n");
    const path = `/proxy/hls/manifest.m3u8?d=${encodeURIComponent(directHls)}&h_referer=${encodeURIComponent("https://vidmoly.biz/embed.html")}`;
    const response = await handle(request(path), env, async () => new Response(manifest, { headers: { "content-type": "application/vnd.apple.mpegurl", "content-length": String(manifest.length) } }));
    const rewritten = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBeNull();
    expect(rewritten).not.toMatch(/test-secret|mediaflow-a\.example/);
    expect(rewritten).toContain("https://worker.example/proxy/hls/manifest.m3u8");
    expect(rewritten).toContain(encodeURIComponent("https://keys.example/key.bin"));
    expect(rewritten).toContain(encodeURIComponent("https://stream.4fun.tv:8888/hls/4f_high/938694.ts"));
    expect(rewritten.match(/https:\/\/worker\.example/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("rewrites MediaFlow redirects and removes the password", async () => {
    const location = `https://mediaflow-a.example/proxy/stream?d=${encodeURIComponent(genericVideo)}&api_password=test-secret`;
    const response = await handle(request(`/extractor/video?host=Doodstream&d=${encodeURIComponent("https://doodstream.com/e/x")}&redirect_stream=true`), env, async () => new Response(null, { status: 302, headers: { location } }));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("https://worker.example/proxy/stream");
    expect(response.headers.get("location")).not.toMatch(/test-secret|mediaflow-a/);
  });

  it("preserves upstream errors such as Cloudflare 1003", async () => {
    const response = await handle(request(`/proxy/hls/manifest.m3u8?d=${encodeURIComponent(directHls)}`), env, async () => new Response("error code: 1003", { status: 403, headers: { "content-type": "text/plain" } }));
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("error code: 1003");
  });

  it("falls back directly only for the exact Cloudflare 1003 response", async () => {
    const seen: URL[] = [];
    const manifest = "#EXTM3U\n#EXTINF:6,\nsegment.ts";
    const path = `/proxy/hls/manifest.m3u8?d=${encodeURIComponent(directHls)}&h_referer=${encodeURIComponent("https://vidmoly.biz/embed.html")}`;
    const response = await handle(request(path), env, async (input, init) => {
      const target = new URL(input.toString());
      seen.push(target);
      if (seen.length <= 2) return new Response("error code: 1003", { status: 403, headers: { server: "cloudflare", "content-length": "17", "content-type": "text/plain" } });
      expect(new Headers(init?.headers).get("referer")).toBe("https://vidmoly.biz/embed.html");
      return new Response(manifest, { headers: { "content-type": "application/vnd.apple.mpegurl" } });
    });
    expect(seen).toHaveLength(3);
    expect(seen[0].origin).toBe("https://mediaflow-a.example");
    expect(seen[1].searchParams.get("no_proxy")).toBe("true");
    expect(seen[2].href).toBe(directHls);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("https://worker.example/proxy/stream");
  });

  it("uses MediaFlow no_proxy before attempting a direct fallback", async () => {
    const seen: URL[] = [];
    const response = await handle(request(`/proxy/hls/manifest.m3u8?d=${encodeURIComponent(directHls)}`), env, async (input) => {
      const target = new URL(input.toString());
      seen.push(target);
      if (seen.length === 1) return new Response("error code: 1003", { status: 403, headers: { server: "cloudflare", "content-length": "17" } });
      return new Response("#EXTM3U\n#EXTINF:6,\nsegment.ts", { headers: { "content-type": "application/vnd.apple.mpegurl" } });
    });
    expect(seen).toHaveLength(2);
    expect(seen[1].origin).toBe("https://mediaflow-a.example");
    expect(seen[1].searchParams.get("no_proxy")).toBe("true");
    expect(response.status).toBe(200);
  });

  it("bounds manifests and maps aborted upstream requests to gateway timeout", async () => {
    const path = `/proxy/hls/manifest.m3u8?d=${encodeURIComponent(directHls)}`;
    const oversized = await handle(request(path), env, async () => new Response("#EXTM3U", { headers: { "content-type": "application/vnd.apple.mpegurl", "content-length": "2000001" } }));
    expect(oversized.status).toBe(502);
    const timeout = await handle(request(path), env, async () => { throw new DOMException("timeout", "AbortError"); });
    expect(timeout.status).toBe(504);
  });

  it("rewrites a standalone manifest without leaking a secret", () => {
    const target = new URL(`https://mediaflow-a.example/proxy/hls/manifest.m3u8?d=${encodeURIComponent(directHls)}&api_password=test-secret`);
    const rewritten = rewriteManifest("#EXTM3U\n#EXTINF:6,\nsegment.ts", "https://worker.example", target, env);
    expect(rewritten).toContain("https://worker.example/proxy/stream");
    expect(rewritten).not.toContain("test-secret");
  });
});

describe("MCP Streamable HTTP and compatibility routes", () => {
  it("negotiates protocols, transport rules, notifications, and batches", async () => {
    const initialized = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect((await initialized.json() as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-11-25");
    expect((await handle(request("/mcp"), env)).status).toBe(405);
    expect((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const batch = await mcp([{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "ping" }]);
    expect(await batch.json()).toEqual([{ jsonrpc: "2.0", id: 2, result: {} }]);
  });

  it("retains MCP origin, content negotiation, protocol, and argument validation", async () => {
    expect((await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { origin: "https://attacker.example" } })).status).toBe(403);
    expect((await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { "content-type": "text/plain", accept: "application/json" } })).status).toBe(415);
    expect((await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { "content-type": "application/json", accept: "text/plain" } })).status).toBe(406);
    expect((await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { "mcp-protocol-version": "invalid" } })).status).toBe(400);
    const invalid = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "resolve_video", arguments: { url: directHls, unexpected: true } } });
    expect(await invalid.json()).toMatchObject({ error: { code: -32602 } });
  });

  it("describes the new output and returns the corrected HLS URL", async () => {
    const listed = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const listedBody = await listed.json() as { result: { tools: Array<{ outputSchema: { properties: Record<string, unknown> } }> } };
    expect(listedBody.result.tools[0].outputSchema.properties).toHaveProperty("mediaType");
    expect(listedBody.result.tools[0].outputSchema.properties).toHaveProperty("warnings");

    const called = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "resolve_video", arguments: { url: directHls, link: "https://vidmoly.biz/embed-ynhyvaz86ylw.html", endpoint: "/proxy/stream", provider: "Vidmoly", redirect_stream: false, max_res: true } } });
    const body = await called.json() as { result: { structuredContent: { url: string; mediaType: string; warnings: string[] } } };
    expect(new URL(body.result.structuredContent.url).pathname).toBe("/proxy/hls/manifest.m3u8");
    expect(body.result.structuredContent.mediaType).toBe("hls");
    expect(body.result.structuredContent.warnings).toHaveLength(1);
    expect(body.result.structuredContent.url).not.toMatch(/api_password|test-secret|redirect_stream|max_res/);
  });

  it("returns a structured MCP error for unsupported provider extraction", async () => {
    const called = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "resolve_video", arguments: { url: "https://unknown.example/embed-fixture.html", provider: "Unsupported" } } });
    const body = await called.json() as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ outcome: "unsupported_provider" });
  });

  it("preserves root and MSX response envelopes", async () => {
    const root = await handle(request(`/?url=${encodeURIComponent(directHls)}&redirect_stream=true`), env);
    const body = await root.json() as { response: { data: { url: string; mediaType: string; warnings: string[] } } };
    expect(new URL(body.response.data.url).pathname).toBe("/proxy/hls/manifest.m3u8");
    expect(body.response.data.mediaType).toBe("hls");
    expect(body.response.data.warnings).toHaveLength(1);
    const msx = await handle(request(`/interaction/resolve.html?url=${encodeURIComponent("https://video.example/file.mp4")}`), env);
    expect(await msx.json()).toMatchObject({ mediaType: "stream" });
  });
});
