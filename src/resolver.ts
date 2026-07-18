import { boundedText, safeFetch, SafeFetchError } from "./safe-fetch";
import { validatePublicUrl } from "./validation";
import { extractMedia } from "./extract";
import { providerFor } from "./host-providers";
import type { FetchLike, ResolveResult, ResolvedVideo } from "./types";

export interface ResolveOptions { hostExtraction?: boolean; upstreamCookie?: string; upstreamReferer?: string; upstreamOrigin?: string; }
const protectionPattern = /cf-turnstile|challenge-platform|attention required|verify you are human/i;
function upstreamHeaders(options: ResolveOptions): HeadersInit | undefined {
  const headers: Record<string, string> = {};
  if (options.upstreamCookie) headers.cookie = options.upstreamCookie;
  if (options.upstreamReferer) headers.referer = options.upstreamReferer;
  if (options.upstreamOrigin) headers.origin = options.upstreamOrigin;
  return Object.keys(headers).length ? headers : undefined;
}
export async function resolveVideo(raw: string, fetcher: FetchLike = fetch, options: ResolveOptions = {}): Promise<ResolveResult> {
  let target: URL; try { target = validatePublicUrl(raw); } catch (error) { return { outcome: "invalid", message: (error as Error).message }; }
  if (/\.(mp4|m3u8)(?:[?#]|$)/i.test(target.href)) return { outcome: "ok", data: { url: target.href, source: target.hostname, original: target.href, alternates: [] } };
  try { const { response, finalUrl } = await safeFetch(target.href, fetcher, 8000, 3, { headers: upstreamHeaders(options) }); if (!response.ok) return { outcome: response.status === 404 ? "not_found" : "unavailable", message: "The upstream page was unavailable." }; const html = await boundedText(response); const provider = options.hostExtraction === false ? undefined : providerFor(finalUrl); const found = provider?.extract(html, finalUrl) ?? extractMedia(html, finalUrl); if (found) return { outcome: "ok", data: found }; if (provider?.name === "Vidmoly" && protectionPattern.test(html)) return { outcome: "unavailable", message: "The upstream page requires interactive access before public player data is exposed." }; return { outcome: "not_found", message: "No public MP4 or HLS stream was found." }; }
  catch (error) { const kind = error instanceof SafeFetchError ? error.kind : "upstream_error"; return { outcome: kind, message: kind === "timeout" ? "The upstream request timed out." : "The upstream request failed." }; }
}
export function publicResult(data: ResolvedVideo) { return { url: data.url, source: data.source, original: data.original, ...(data.thumbnail ? { thumbnail: data.thumbnail } : {}), ...(data.favicon ? { favicon: data.favicon } : {}), alternates: data.alternates }; }
