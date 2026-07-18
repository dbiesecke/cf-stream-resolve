import { describe, expect, it, vi } from "vitest";
import { PROVIDERS } from "../src/providers";
import { buildPlaybackUrl, classifySource, diagnoseVideo } from "../src/resolver";
import { validatePublicUrl, validateResolvedAddresses } from "../src/validation";
import { handle } from "../src/worker";

const env = {
  MEDIAFLOW_PROXY_SERVERS: "https://mediaflow.example",
  MEDIAFLOW_PROXY_DEFAULT: "https://mediaflow.example",
  MEDIAFLOW_API_PASSWORD: "test-secret",
};
const publicDns = async () => ["93.184.216.34"];

describe("provider registry and playback URLs", () => {
  it("classifies all provider hosts and uses their canonical MediaFlow contract", () => {
    expect(PROVIDERS).toHaveLength(24);
    for (const provider of PROVIDERS) {
      const source = `https://${provider.hosts[0]}/e/fixture`;
      const classification = classifySource(source);
      expect(classification).toMatchObject({ sourceType: "extractor", provider: provider.id, confidence: "high" });
      const playback = new URL(buildPlaybackUrl({ baseUrl: "https://worker.example", sourceType: "extractor", provider: provider.id, sourceUrl: source, redirectStream: true }));
      expect(playback.pathname).toBe(`/extractor/${provider.preferredEndpoint}`);
      expect(playback.searchParams.get("host")).toBe(provider.mediaFlowName);
      expect(playback.searchParams.get("d")).toBe(source);
      expect(playback.searchParams.get("redirect_stream")).toBe("true");
      expect(playback.href).not.toContain("%25");
    }
  });

  it("prioritizes direct media types and enforces provider domain boundaries", () => {
    expect(classifySource("https://cdn.example/live.m3u8").sourceType).toBe("hls");
    expect(classifySource("https://cdn.example/live.mpd").sourceType).toBe("dash");
    expect(classifySource("https://cdn.example/video.mp4").sourceType).toBe("direct_stream");
    expect(classifySource("https://cdn.voe.sx/e/x")).toMatchObject({ sourceType: "extractor", provider: "voe" });
    expect(classifySource("https://voe.sx.example.org/e/x").sourceType).toBe("unknown");
    expect(classifySource("https://fakevoe.sx.invalid/e/x").sourceType).toBe("unknown");
  });
});

describe("redirect, ARD, SSRF, and playback diagnostics", () => {
  it("resolves AniWorld HTTP redirects and HTML redirects without executing scripts", async () => {
    const httpFetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: "https://voe.sx/e/fixture" } }));
    const http = await diagnoseVideo("https://worker.example", { url: "https://aniworld.to/redirect/1", redirectStream: true }, env, httpFetcher, publicDns);
    expect(http).toMatchObject({ status: "resolved", sourceType: "aniworld_redirect", provider: "voe", mediaFlowEndpoint: "/extractor/video.m3u8" });
    expect(http.redirectChain).toEqual([{ url: "https://aniworld.to/redirect/1", status: 302 }]);

    const htmlFetcher = vi.fn<typeof fetch>(async () => new Response('<meta http-equiv="refresh" content="0; url=https://vidmoly.biz/embed-fixture.html">', { headers: { "content-type": "text/html" } }));
    const html = await diagnoseVideo("https://worker.example", { url: "https://redirect.example/go/item", redirectStream: true }, env, htmlFetcher, publicDns);
    expect(html).toMatchObject({ status: "resolved", provider: "vidmoly", mediaFlowEndpoint: "/extractor/video.m3u8" });
  });

  it("reports ambiguous embeds and ARD overview pages without choosing media", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('<iframe src="https://voe.sx/e/a"></iframe><iframe src="https://vidmoly.biz/embed-b.html"></iframe>', { headers: { "content-type": "text/html" } }));
    const ambiguous = await diagnoseVideo("https://worker.example", { url: "https://embed.example/watch/1" }, env, fetcher, publicDns);
    expect(ambiguous).toMatchObject({ status: "partially_resolved", playbackUrl: null });
    expect(ambiguous.warnings[0]).toMatch(/Multiple supported/i);

    const ard = await diagnoseVideo("https://worker.example", { url: "https://www.ardmediathek.de/serie/example/staffel-1/id/1" }, env, fetcher, publicDns);
    expect(ard).toMatchObject({ status: "failed", error: { code: "ARD_NOT_PLAYABLE_ITEM" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("blocks credentials, private addresses, private DNS, and private redirect targets", async () => {
    expect(() => validatePublicUrl("https://user:pass@example.com/video.mp4")).toThrow(/credentials/i);
    expect(() => validatePublicUrl("http://127.0.0.1/video.mp4")).toThrow(/publicly routable/i);
    expect(() => validatePublicUrl("http://localhost./video.mp4")).toThrow(/publicly routable/i);
    expect(() => validatePublicUrl("http://[fc00::1]/video.mp4")).toThrow(/publicly routable/i);
    await expect(validateResolvedAddresses(new URL("https://public.example"), async () => ["10.0.0.2"])).rejects.toThrow(/DNS_BLOCKED/);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: "http://192.168.1.10/secret" } }));
    const result = await diagnoseVideo("https://worker.example", { url: "https://aniworld.to/redirect/2" }, env, fetcher, publicDns);
    expect(result).toMatchObject({ status: "failed", error: { code: "SSRF_BLOCKED" } });
  });

  it("reports redirect loops, timeouts, and gateway DNS blocks", async () => {
    const loopFetcher = vi.fn<typeof fetch>(async (input) => new Response(null, { status: 302, headers: { location: new URL(input.toString()).hostname === "aniworld.to" ? "https://redirect.example/go/back" : "https://aniworld.to/redirect/loop" } }));
    const loop = await diagnoseVideo("https://worker.example", { url: "https://aniworld.to/redirect/loop" }, env, loopFetcher, publicDns);
    expect(loop).toMatchObject({ status: "failed", error: { code: "REDIRECT_LOOP" } });

    const timeoutFetcher = vi.fn<typeof fetch>(async () => { throw new DOMException("timed out", "AbortError"); });
    const timeout = await diagnoseVideo("https://worker.example", { url: "https://aniworld.to/redirect/timeout" }, env, timeoutFetcher, publicDns);
    expect(timeout).toMatchObject({ status: "failed", error: { code: "TIMEOUT" } });

    const upstream = vi.fn<typeof fetch>();
    const gateway = await handle(new Request(`https://worker.example/proxy/stream?d=${encodeURIComponent("https://private-dns.example/video.mp4")}`), env, upstream, async () => ["192.168.1.2"]);
    expect(gateway.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps playback probing opt-in and records a playable manifest", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl", "access-control-allow-origin": "*" } });
      expect(init?.method).toBe("GET");
      return new Response("#EXTM3U\n#EXTINF:6,\nsegment.ts", { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl", "access-control-allow-origin": "*" } });
    });
    const result = await diagnoseVideo("https://worker.example", { url: "https://cdn.example/live.m3u8", checkPlayback: true }, env, fetcher, publicDns);
    expect(result).toMatchObject({ status: "resolved", stage: "manifest_loaded", httpStatus: 200, cors: "allowed", manifestDetected: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("exposes provider metadata and validates diagnose request bodies", async () => {
    const providers = await handle(new Request("https://worker.example/resolve/providers"), env, fetch, publicDns);
    expect(providers.status).toBe(200);
    expect((await providers.json() as { providers: unknown[] }).providers).toHaveLength(24);
    const invalid = await handle(new Request("https://worker.example/resolve/diagnose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://cdn.example/live.m3u8", extra: true }) }), env, fetch, publicDns);
    expect(invalid.status).toBe(400);
    const valid = await handle(new Request("https://worker.example/resolve/diagnose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://cdn.example/live.m3u8" }) }), env, fetch, publicDns);
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ status: "resolved", stage: "playback_url_created", mediaFlowEndpoint: "/proxy/hls/manifest.m3u8" });
  });
});
