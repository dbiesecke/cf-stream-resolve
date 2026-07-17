import { boundedText, safeFetch, SafeFetchError } from "./safe-fetch";
import { validatePublicUrl } from "./validation";
import { extractMedia } from "./extract";
import type { FetchLike, ResolveResult, ResolvedVideo } from "./types";

const prohibited = ["pornhub.com", "aniworld.to"];
export async function resolveVideo(raw: string, fetcher: FetchLike = fetch): Promise<ResolveResult> {
  let target: URL; try { target = validatePublicUrl(raw); } catch (error) { return { outcome: "invalid", message: (error as Error).message }; }
  if (prohibited.some((domain) => target.hostname === domain || target.hostname.endsWith(`.${domain}`))) return { outcome: "unsupported", message: "This source is not supported because protected or age-gated media is never bypassed." };
  if (/\.(mp4|m3u8)(?:[?#]|$)/i.test(target.href)) return { outcome: "ok", data: { url: target.href, source: target.hostname, original: target.href, alternates: [] } };
  try { const { response, finalUrl } = await safeFetch(target.href, fetcher); if (!response.ok) return { outcome: response.status === 404 ? "not_found" : "unavailable", message: "The upstream page was unavailable." }; const found = extractMedia(await boundedText(response), finalUrl); return found ? { outcome: "ok", data: found } : { outcome: "not_found", message: "No public MP4 or HLS stream was found." }; }
  catch (error) { const kind = error instanceof SafeFetchError ? error.kind : "upstream_error"; return { outcome: kind === "invalid" ? "unsupported" : kind, message: kind === "timeout" ? "The upstream request timed out." : "The upstream request failed." }; }
}
export function publicResult(data: ResolvedVideo) { return { url: data.url, source: data.source, original: data.original, ...(data.thumbnail ? { thumbnail: data.thumbnail } : {}), ...(data.favicon ? { favicon: data.favicon } : {}), alternates: data.alternates }; }
