import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { extractMedia } from "../src/extract";
import { resolveVideo } from "../src/resolver";
import { validatePublicUrl } from "../src/validation";

const page = "https://public.example/watch";
const html = '<meta property="og:site_name" content="Fixture"><meta property="og:image" content="/cover.jpg"><link rel="icon" href="/favicon.ico"><video src="/movie.mp4"></video><source src="https://cdn.example/master.m3u8">';
const fetcher = async () => new Response(html, { headers: { "content-type": "text/html" } });
const request = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://worker.example${path}`, init), {} as never, {} as never);

describe("validation and extraction", () => {
  it.each(["", "ftp://example.com/x", "http://localhost/x", "http://127.0.0.1/x", "http://10.0.0.1/x", "http://169.254.169.254/x", "http://[::1]/x", "https://u:p@example.com/x"])('rejects unsafe URL %s', (value) => expect(() => validatePublicUrl(value)).toThrow());
  it("extracts relative MP4, HLS, and safe assets", () => { const value = extractMedia(html, new URL(page))!; expect(value.url).toBe("https://cdn.example/master.m3u8"); expect(value.alternates).toEqual(["https://public.example/movie.mp4"]); expect(value.thumbnail).toBe("https://public.example/cover.jpg"); });
  it("does not accept image candidates", () => expect(extractMedia('<video src="/cover.jpg">', new URL(page))).toBeUndefined());
});
describe("resolver", () => {
  it("returns direct MP4 without fetch", async () => expect((await resolveVideo("https://cdn.example/video.mp4")).outcome).toBe("ok"));
  it("resolves public page fixture", async () => expect((await resolveVideo(page, fetcher)).outcome).toBe("ok"));
  it("rejects protected named sources", async () => expect((await resolveVideo("https://de.pornhub.com/view_video.php?x=1")).outcome).toBe("unsupported"));
  it("maps timeout and bad upstream", async () => { const timeout = async () => { throw new DOMException("", "AbortError"); }; expect((await resolveVideo(page, timeout)).outcome).toBe("timeout"); expect((await resolveVideo(page, async () => new Response("x", { status: 500 }))).outcome).toBe("unavailable"); });
});
describe("HTTP endpoints", () => {
  it("handles missing url and cors preflight", async () => { expect((await request("/")).status).toBe(400); const res = await request("/", { method: "OPTIONS" }); expect(res.status).toBe(204); expect(res.headers.get("access-control-allow-origin")).toBe("*"); });
  it("returns JSON and redirect mode", async () => { const json = await request("/?url=https%3A%2F%2Fcdn.example%2Fmovie.mp4"); expect(json.status).toBe(200); expect((await json.json() as { response: { data: { url: string } } }).response.data.url).toContain("movie.mp4"); const redirect = await request("/?url=https%3A%2F%2Fcdn.example%2Fmovie.mp4&format=redirect", { redirect: "manual" }); expect(redirect.status).toBe(307); expect(redirect.headers.get("location")).toBe("https://cdn.example/movie.mp4"); });
  it("supports MCP initialization, discovery, and call", async () => { const post = (body: object) => request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); expect((await post({ jsonrpc: "2.0", id: 1, method: "initialize" })).status).toBe(200); expect((await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json() as { result: { tools: unknown[] } }).result.tools).toHaveLength(1); expect((await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { arguments: { url: "https://cdn.example/movie.mp4" } } })).status).toBe(200); });
  it("returns MSX url or error", async () => { expect((await request("/interaction/resolve.html?url=https%3A%2F%2Fcdn.example%2Fmovie.mp4")).status).toBe(200); const invalid = await request("/interaction/resolve.html"); expect(invalid.status).toBe(400); expect((await invalid.json() as { error: string }).error).toBeTruthy(); });
});
