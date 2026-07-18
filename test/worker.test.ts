import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { collectMediaUrls, extractMedia } from "../src/extract";
import { resolveVideo } from "../src/resolver";
import { boundedText, MAX_UPSTREAM_DOCUMENT_BYTES, safeFetch } from "../src/safe-fetch";
import { HOST_PROVIDERS, providerFor } from "../src/host-providers";
import { validatePublicUrl } from "../src/validation";

const page = "https://public.example/watch";
const html = '<meta property="og:site_name" content="Fixture"><meta property="og:image" content="/cover.jpg"><link rel="icon" href="/favicon.ico"><video src="/movie.mp4"></video><source src="https://cdn.example/master.m3u8">';
const fetcher = async () => new Response(html, { headers: { "content-type": "text/html" } });
const request = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://worker.example${path}`, init), {} as never, {} as never);

describe("validation and extraction", () => {
  it.each(["", "ftp://example.com/x", "http://localhost/x", "http://127.0.0.1/x", "http://10.0.0.1/x", "http://169.254.169.254/x", "http://[::1]/x", "https://u:p@example.com/x"])('rejects unsafe URL %s', (value) => expect(() => validatePublicUrl(value)).toThrow());
  it("extracts relative MP4, HLS, and safe assets", () => { const value = extractMedia(html, new URL(page))!; expect(value.url).toBe("https://cdn.example/master.m3u8"); expect(value.alternates).toEqual(["https://public.example/movie.mp4"]); expect(value.thumbnail).toBe("https://public.example/cover.jpg"); });
  it("does not accept image candidates", () => expect(extractMedia('<video src="/cover.jpg">', new URL(page))).toBeUndefined());
  it("extracts an ARD public metadata fixture", () => { const ard = '<script type="application/json">{"mediaCollection":{"streamUrl":"https://cdn.ard.example/master.m3u8"}}</script>'; const value = extractMedia(ard, new URL("https://www.ardmediathek.de/video/fixture"))!; expect(value.source).toBe("ARD Mediathek"); expect(value.url).toBe("https://cdn.ard.example/master.m3u8"); });
  it("extracts public inline player configuration without executing it", () => { const player = '<script>var flashvars_1 = {"mediaDefinitions":[{"videoUrl":"https://cdn.example/720.m3u8"},{"videoUrl":"https://cdn.example/480.mp4"}]};</script>'; const value = extractMedia(player, new URL(page))!; expect(value.url).toBe("https://cdn.example/720.m3u8"); expect(value.alternates).toEqual(["https://cdn.example/480.mp4"]); });
  it("bounds cyclic and deeply nested JSON metadata", () => { const cyclic: Record<string, unknown> = { streamUrl: "https://cdn.example/a.m3u8" }; cyclic.self = cyclic; expect(collectMediaUrls(cyclic, new URL(page))).toEqual(["https://cdn.example/a.m3u8"]); let deep: Record<string, unknown> = {}; let current = deep; for (let i = 0; i < 12; i += 1) { current.child = {}; current = current.child as Record<string, unknown>; } current.streamUrl = "https://cdn.example/too-deep.m3u8"; expect(collectMediaUrls(deep, new URL(page))).toEqual([]); });
  it("allows a bounded document larger than one megabyte", async () => { const body = "x".repeat(1_100_000); await expect(boundedText(new Response(body))).resolves.toHaveLength(body.length); expect(MAX_UPSTREAM_DOCUMENT_BYTES).toBeGreaterThan(body.length); });
});
describe("resolver", () => {
  it("returns direct MP4 without fetch", async () => expect((await resolveVideo("https://cdn.example/video.mp4")).outcome).toBe("ok"));
  it("resolves public page fixture", async () => expect((await resolveVideo(page, fetcher)).outcome).toBe("ok"));
  it("does not block a source based on its hostname", async () => expect((await resolveVideo("https://de.pornhub.com/view_video.php?x=1", fetcher)).outcome).toBe("ok"));
  it("maps timeout and bad upstream", async () => { const timeout = async () => { throw new DOMException("", "AbortError"); }; expect((await resolveVideo(page, timeout)).outcome).toBe("timeout"); expect((await resolveVideo(page, async () => new Response("x", { status: 500 }))).outcome).toBe("unavailable"); });
  it("revalidates redirect locations", async () => { const redirects = async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }); await expect(safeFetch(page, redirects)).rejects.toMatchObject({ kind: "invalid" }); });
  it("runs every registered host provider against an offline public metadata fixture", async () => { expect(HOST_PROVIDERS).toHaveLength(25); for (const provider of HOST_PROVIDERS) { const result = await resolveVideo(`https://${provider.hosts[0]}/embed/fixture`, async () => new Response('var sources = [{ file: "https://cdn.example/fixture.m3u8" }];')); expect(result.outcome).toBe("ok"); if (result.outcome === "ok") expect(result.data.source).toBe(provider.name); } });
  it("can disable host extraction without disabling generic extraction", async () => { const host = "https://vidmoly.biz/embed-fixture.html"; const hostOnly = async () => new Response('sources: [{ file: "https://cdn.example/provider.m3u8" }]'); expect((await resolveVideo(host, hostOnly)).outcome).toBe("ok"); expect((await resolveVideo(host, hostOnly, { hostExtraction: false })).outcome).toBe("not_found"); const generic = async () => new Response('<video src="https://cdn.example/generic.mp4">'); expect((await resolveVideo(host, generic, { hostExtraction: false })).outcome).toBe("ok"); });
  it("returns unavailable for Vidmoly challenge pages instead of trying to bypass them", async () => { const challenge = async () => new Response('<div class="cf-turnstile"></div><title>Attention Required</title>'); expect((await resolveVideo("https://vidmoly.biz/embed-fixture.html", challenge)).outcome).toBe("unavailable"); });
  it("forwards explicit upstream session headers when provided", async () => {
    let seen: Headers | undefined;
    const upstream = async (_input: RequestInfo | URL, init?: RequestInit) => { seen = new Headers(init?.headers); return new Response('<video src="https://cdn.example/secure.mp4">'); };
    const result = await resolveVideo("https://vidmoly.biz/embed-fixture.html", upstream, { upstreamCookie: "session=abc", upstreamReferer: "https://vidmoly.biz/embed-fixture.html", upstreamOrigin: "https://vidmoly.biz" });
    expect(result.outcome).toBe("ok");
    expect(seen?.get("cookie")).toBe("session=abc");
    expect(seen?.get("referer")).toBe("https://vidmoly.biz/embed-fixture.html");
    expect(seen?.get("origin")).toBe("https://vidmoly.biz");
  });
  it("matches supplied smoke-test host aliases", () => { expect(providerFor(new URL("https://vidmoly.biz/embed-ynhyvaz86ylw.html"))?.name).toBe("Vidmoly"); expect(providerFor(new URL("https://ellenpoliticalfollow.com/e/ddhl1ul2kwbv"))?.name).toBe("VOE"); expect(providerFor(new URL("https://playmogo.com/e/4x5pl61mp2r7"))?.name).toBe("DoodStream"); expect(providerFor(new URL("https://bysezejataos.com/d/dl03r6je3iei"))?.name).toBe("Filemoon"); });
});
describe("HTTP endpoints", () => {
  it("handles missing url and restrictive CORS preflight", async () => { expect((await request("/")).status).toBe(400); const res = await request("/", { method: "OPTIONS", headers: { origin: "https://worker.example" } }); expect(res.status).toBe(204); expect(res.headers.get("access-control-allow-origin")).toBe("https://worker.example"); const foreign = await request("/", { method: "OPTIONS", headers: { origin: "https://other.example" } }); expect(foreign.headers.get("access-control-allow-origin")).toBeNull(); });
  it("returns JSON and redirect mode", async () => { const json = await request("/?url=https%3A%2F%2Fcdn.example%2Fmovie.mp4"); expect(json.status).toBe(200); expect((await json.json() as { response: { data: { url: string } } }).response.data.url).toContain("movie.mp4"); const redirect = await request("/?url=https%3A%2F%2Fcdn.example%2Fmovie.mp4&format=redirect", { redirect: "manual" }); expect(redirect.status).toBe(307); expect(redirect.headers.get("location")).toBe("https://cdn.example/movie.mp4"); });
  it("supports MCP initialization, discovery, and call", async () => { const post = (body: object) => request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); expect((await post({ jsonrpc: "2.0", id: 1, method: "initialize" })).status).toBe(200); const discovery = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json() as { result: { tools: Array<{ inputSchema: { properties: Record<string, unknown> } }> } }; expect(discovery.result.tools).toHaveLength(1); expect(discovery.result.tools[0].inputSchema.properties).toHaveProperty("hostExtraction"); expect(discovery.result.tools[0].inputSchema.properties).toHaveProperty("upstreamCookie"); expect((await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { arguments: { url: "https://cdn.example/movie.mp4", hostExtraction: false, upstreamReferer: "https://example.com/player" } } })).status).toBe(200); });
  it("returns MSX url or error", async () => { expect((await request("/interaction/resolve.html?url=https%3A%2F%2Fcdn.example%2Fmovie.mp4")).status).toBe(200); const invalid = await request("/interaction/resolve.html"); expect(invalid.status).toBe(400); expect((await invalid.json() as { error: string }).error).toBeTruthy(); });
  it("recognizes ffprobe clients for direct play", async () => { const response = await request("/?url=https%3A%2F%2Fcdn.example%2Fmovie.mp4", { headers: { "user-agent": "Lavf/ffprobe libavformat" }, redirect: "manual" }); expect(response.status).toBe(307); expect(response.headers.get("location")).toBe("https://cdn.example/movie.mp4"); });
});
