import { assertMediaflowConfigured, MediaflowError } from "./mediaflow";
import type { MediaflowConfig } from "./mediaflow";
import { checkedFetch, defaultDnsLookup, fetchWithTimeout, readBoundedText, readUpToBytes } from "./network";
import { providerById, providerFromName, providerFromUrl } from "./providers";
import type { ExtractorProvider } from "./providers";
import type { ClassificationResult, DiagnosticErrorCode, MediaType, ResolveDiagnostic, ResolveResult, SourceType } from "./types";
import { validatePublicUrl } from "./validation";
import type { DnsLookup } from "./validation";

export interface ResolveVideoArguments {
  url?: string;
  link?: string;
  endpoint?: string;
  provider?: string;
  redirect_stream?: boolean;
  transcode?: boolean;
  max_res?: boolean;
}

export interface DiagnoseArguments {
  url: string;
  redirectStream?: boolean;
  checkPlayback?: boolean;
}

const MAX_HTML_BYTES = 512 * 1024;
const MAX_PROBE_BYTES = 64 * 1024;
const MAX_REDIRECTS = 5;
const TOTAL_TIMEOUT_MS = 20_000;
const mediaExtensions = [".mp4", ".mkv", ".webm", ".ts", ".mov", ".m4v"];

class ResolverError extends Error {
  constructor(public readonly code: DiagnosticErrorCode, message: string) { super(message); }
}

function exactDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function pathEndsWith(url: URL, extensions: readonly string[]): boolean {
  const path = url.pathname.toLowerCase();
  return extensions.some((extension) => path.endsWith(extension));
}

function isYouTube(url: URL): boolean {
  return ["youtube.com", "youtube-nocookie.com"].some((host) => exactDomain(url.hostname, host)) || url.hostname === "youtu.be";
}

export function classifySource(input: string | URL): ClassificationResult {
  const url = typeof input === "string" ? validatePublicUrl(input) : input;
  if (pathEndsWith(url, [".m3u8", ".m3u", ".m3u_plus"])) return { sourceType: "hls", provider: null, confidence: "high", matchedRule: "path-extension-hls" };
  if (pathEndsWith(url, [".mpd"])) return { sourceType: "dash", provider: null, confidence: "high", matchedRule: "path-extension-dash" };
  if (pathEndsWith(url, mediaExtensions)) return { sourceType: "direct_stream", provider: null, confidence: "high", matchedRule: "path-extension-media" };
  if (exactDomain(url.hostname, "aniworld.to") && /^\/redirect\//i.test(url.pathname)) return { sourceType: "aniworld_redirect", provider: null, confidence: "high", matchedRule: "aniworld-redirect-path" };
  if (exactDomain(url.hostname, "ardmediathek.de")) return { sourceType: "ard_mediathek", provider: null, confidence: "high", matchedRule: "ard-mediathek-host" };
  const provider = providerFromUrl(url);
  if (provider) return { sourceType: "extractor", provider: provider.id, confidence: "high", matchedRule: "provider-host" };
  if (/\/(?:redirect|out|go)\//i.test(url.pathname)) return { sourceType: "redirect", provider: null, confidence: "medium", matchedRule: "redirect-path" };
  return { sourceType: "unknown", provider: null, confidence: "low", matchedRule: null };
}

export function buildPlaybackUrl(input: {
  baseUrl: string;
  sourceType: SourceType;
  provider: ExtractorProvider | null;
  sourceUrl: string;
  redirectStream: boolean;
  link?: URL;
}): string {
  let path: string;
  if (input.sourceType === "hls") path = "/proxy/hls/manifest.m3u8";
  else if (input.sourceType === "dash") path = "/proxy/mpd/manifest.m3u8";
  else if (input.sourceType === "direct_stream") path = "/proxy/stream";
  else if (input.sourceType === "extractor" && input.provider) path = `/extractor/${providerById(input.provider).preferredEndpoint}`;
  else throw new ResolverError("UNSUPPORTED_SOURCE", "No MediaFlow endpoint is available for this source type.");

  const result = new URL(path, input.baseUrl);
  result.searchParams.set("d", validatePublicUrl(input.sourceUrl).href);
  if (input.link) {
    result.searchParams.set("h_referer", input.link.href);
    result.searchParams.set("h_origin", input.link.origin);
  }
  if (input.sourceType === "extractor" && input.provider) {
    const provider = providerById(input.provider);
    result.searchParams.set("host", provider.mediaFlowName);
    if (input.redirectStream && provider.supportsRedirectStream) result.searchParams.set("redirect_stream", "true");
  }
  return result.href;
}

function emptyDiagnostic(inputUrl: string): ResolveDiagnostic {
  return {
    inputUrl, normalizedUrl: null, sourceType: "unknown", provider: null, mediaFlowProvider: null,
    confidence: "low", matchedRule: null, redirectChain: [], resolvedSourceUrl: null,
    mediaFlowEndpoint: null, playbackUrl: null, redirectStream: false, httpStatus: null,
    contentType: null, finalUrl: null, durationMs: null, cors: "not_checked", bodySize: null,
    manifestDetected: false, stage: "classified", status: "failed", warnings: [], error: null,
  };
}

function errorFrom(error: unknown): ResolverError {
  if (error instanceof ResolverError) return error;
  if (error instanceof MediaflowError) return new ResolverError(error.kind === "configuration" ? "CONFIGURATION" : error.kind === "timeout" ? "TIMEOUT" : error.kind === "invalid" ? "INVALID_URL" : "UPSTREAM_ERROR", error.message);
  const message = error instanceof Error ? error.message : "The resolver failed.";
  if (message.startsWith("DNS_BLOCKED:")) return new ResolverError("DNS_BLOCKED", message.slice(12).trim());
  if (message.startsWith("UPSTREAM_ERROR:")) return new ResolverError("UPSTREAM_ERROR", message.slice(15).trim());
  if (error instanceof DOMException && error.name === "AbortError") return new ResolverError("TIMEOUT", "The upstream request timed out.");
  if (/credentials|publicly routable|http:|https:|absolute|4096/i.test(message)) return new ResolverError(/publicly routable/i.test(message) ? "SSRF_BLOCKED" : "INVALID_URL", message);
  return new ResolverError("UPSTREAM_ERROR", "The upstream resolution failed.");
}

function decodeHtmlUrls(html: string): string {
  return html.replaceAll("\\/", "/").replaceAll("&amp;", "&").replaceAll("\\u002F", "/").replaceAll("\\u003A", ":");
}

function candidateUrls(html: string, base: URL): URL[] {
  const decoded = decodeHtmlUrls(html);
  const values: string[] = [];
  const patterns = [
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url\s*=\s*([^"'>;]+)/gi,
    /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/gi,
    /location\.replace\(\s*["']([^"']+)["']\s*\)/gi,
    /(?:href|src|data-src)\s*=\s*["']([^"']+)["']/gi,
    /https?:\/\/[^\s"'<>\\]+/gi,
  ];
  for (const pattern of patterns) {
    for (const match of decoded.matchAll(pattern)) values.push(match[1] ?? match[0]);
  }
  const urls = values.flatMap((value) => {
    try { return [validatePublicUrl(new URL(value.trim(), base).href)]; } catch { return []; }
  });
  return [...new Map(urls.map((url) => [url.href, url])).values()];
}

function isArdOverview(url: URL): boolean {
  return /\/(?:serie|sendung)\//i.test(url.pathname) || /\/staffel-\d+/i.test(url.pathname);
}

interface PageResolution { url: URL | null; classification: ClassificationResult | null; warnings: string[]; partial: boolean; }

async function resolvePage(
  start: URL,
  initialType: SourceType,
  diagnostic: ResolveDiagnostic,
  fetcher: typeof fetch,
  lookup: DnsLookup,
  deadline: number,
): Promise<PageResolution> {
  if (initialType === "ard_mediathek" && isArdOverview(start)) throw new ResolverError("ARD_NOT_PLAYABLE_ITEM", "Die URL verweist auf eine Serien- oder Staffelübersicht.");
  const seen = new Set<string>();
  let current = start;
  for (let step = 0; step <= MAX_REDIRECTS; step += 1) {
    if (Date.now() > deadline) throw new ResolverError("TIMEOUT", "The resolver exceeded its total time limit.");
    if (seen.has(current.href)) throw new ResolverError("REDIRECT_LOOP", "A redirect loop was detected.");
    seen.add(current.href);
    if (step > 0) {
      const redirected = classifySource(current);
      if (["hls", "dash", "direct_stream", "extractor"].includes(redirected.sourceType)) return { url: current, classification: redirected, warnings: [], partial: false };
    }
    let response: Response;
    try { response = await checkedFetch(current, { method: "GET", redirect: "manual", headers: { accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.1" } }, fetcher, lookup, Math.min(8_000, Math.max(1, deadline - Date.now()))); }
    catch (error) { throw errorFrom(error); }
    diagnostic.redirectChain.push({ url: current.href, status: response.status });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new ResolverError("REDIRECT_FAILED", "The redirect response did not include a Location header.");
      try { current = validatePublicUrl(new URL(location, current).href); }
      catch { throw new ResolverError("SSRF_BLOCKED", "The redirect target is not a permitted public URL."); }
      continue;
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("html") && !contentType.includes("json") && contentType) throw new ResolverError("REDIRECT_FAILED", "The page did not return redirect-compatible content.");
    const html = await readBoundedText(response, MAX_HTML_BYTES);
    const candidates = candidateUrls(html, current).map((url) => ({ url, classification: classifySource(url) }))
      .filter(({ classification }) => ["hls", "dash", "direct_stream", "extractor"].includes(classification.sourceType));
    const unique = [...new Map(candidates.map((candidate) => [candidate.url.href, candidate])).values()];
    if (!unique.length) {
      const code = initialType === "ard_mediathek" ? "UNSUPPORTED_SOURCE" : "REDIRECT_FAILED";
      throw new ResolverError(code, initialType === "ard_mediathek" ? "No playable media URL was found in the ARD item." : "No supported redirect target was found.");
    }
    if (initialType !== "ard_mediathek" && unique.length > 1) return { url: null, classification: null, warnings: ["Multiple supported media targets were found; no arbitrary target was selected."], partial: true };
    const selected = initialType === "ard_mediathek"
      ? unique.find(({ classification }) => classification.sourceType === "hls") ?? unique.find(({ classification }) => classification.sourceType === "dash") ?? unique[0]
      : unique[0];
    return { url: selected.url, classification: selected.classification, warnings: [], partial: false };
  }
  throw new ResolverError("REDIRECT_FAILED", `More than ${MAX_REDIRECTS} redirects were returned.`);
}

function mediaTypeFor(sourceType: SourceType): MediaType {
  if (sourceType === "hls") return "hls";
  if (sourceType === "dash") return "dash";
  if (sourceType === "extractor") return "extractor";
  return "stream";
}

function looksPlayable(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes.subarray(0, 16));
  if (bytes.length >= 8 && text.slice(4, 8) === "ftyp") return true;
  return (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    || (bytes.length >= 376 && bytes[0] === 0x47 && bytes[188] === 0x47);
}

async function probePlayback(diagnostic: ResolveDiagnostic, fetcher: typeof fetch): Promise<void> {
  if (!diagnostic.playbackUrl) return;
  const started = Date.now();
  let response: Response;
  try { response = await fetchWithTimeout(diagnostic.playbackUrl, { method: "HEAD", redirect: "follow" }, fetcher); }
  catch (error) { throw errorFrom(error); }
  let bytes: Uint8Array = new Uint8Array();
  const headType = response.headers.get("content-type") ?? "";
  if ([403, 405].includes(response.status) || !response.ok || !headType || /mpegurl|dash\+xml/i.test(headType)) {
    try { response = await fetchWithTimeout(diagnostic.playbackUrl, { method: "GET", redirect: "follow", headers: { range: "bytes=0-1023" } }, fetcher); }
    catch (error) { throw errorFrom(error); }
    bytes = await readUpToBytes(response, MAX_PROBE_BYTES);
  }
  diagnostic.httpStatus = response.status;
  diagnostic.contentType = response.headers.get("content-type");
  diagnostic.finalUrl = response.url || diagnostic.playbackUrl;
  diagnostic.durationMs = Date.now() - started;
  diagnostic.cors = response.headers.has("access-control-allow-origin") ? "allowed" : "not_advertised";
  diagnostic.bodySize = bytes.byteLength || Number(response.headers.get("content-length") ?? 0) || null;
  diagnostic.manifestDetected = /mpegurl|dash\+xml/i.test(diagnostic.contentType ?? "") || new TextDecoder().decode(bytes.subarray(0, 16)).startsWith("#EXTM3U");
  if (response.ok) diagnostic.stage = diagnostic.manifestDetected && bytes.length ? "manifest_loaded" : "endpoint_reachable";
  if (response.ok && !diagnostic.manifestDetected && looksPlayable(bytes)) diagnostic.stage = "playable";
  diagnostic.status = response.ok ? "resolved" : "partially_resolved";
  if (!response.ok) diagnostic.warnings.push(`Playback endpoint returned HTTP ${response.status}.`);
}

export async function diagnoseVideo(
  origin: string,
  args: DiagnoseArguments,
  env: MediaflowConfig,
  fetcher: typeof fetch = fetch,
  lookup: DnsLookup = defaultDnsLookup,
): Promise<ResolveDiagnostic> {
  const diagnostic = emptyDiagnostic(args.url);
  diagnostic.redirectStream = args.redirectStream ?? false;
  try {
    const input = validatePublicUrl(args.url);
    diagnostic.normalizedUrl = input.href;
    let classification = classifySource(input);
    diagnostic.sourceType = classification.sourceType;
    diagnostic.provider = classification.provider;
    diagnostic.confidence = classification.confidence;
    diagnostic.matchedRule = classification.matchedRule;

    if (isYouTube(input)) {
      diagnostic.resolvedSourceUrl = input.href;
      diagnostic.playbackUrl = input.href;
      diagnostic.stage = "playback_url_created";
      diagnostic.status = "resolved";
      return diagnostic;
    }

    assertMediaflowConfigured(env);
    let resolved = input;
    if (["aniworld_redirect", "redirect", "ard_mediathek", "unknown"].includes(classification.sourceType)) {
      const page = await resolvePage(input, classification.sourceType, diagnostic, fetcher, lookup, Date.now() + TOTAL_TIMEOUT_MS);
      diagnostic.warnings.push(...page.warnings);
      if (page.partial || !page.url || !page.classification) {
        diagnostic.status = "partially_resolved";
        return diagnostic;
      }
      resolved = page.url;
      classification = page.classification;
      diagnostic.provider = classification.provider;
      diagnostic.mediaFlowProvider = classification.provider ? providerById(classification.provider).mediaFlowName : null;
      diagnostic.confidence = classification.confidence;
      diagnostic.matchedRule = input.href === resolved.href ? classification.matchedRule : "redirect-target-host";
    }
    if (!["hls", "dash", "direct_stream", "extractor"].includes(classification.sourceType)) throw new ResolverError("UNSUPPORTED_SOURCE", "The source could not be mapped to a supported MediaFlow endpoint.");
    diagnostic.resolvedSourceUrl = resolved.href;
    diagnostic.mediaFlowProvider = classification.provider ? providerById(classification.provider).mediaFlowName : null;
    diagnostic.playbackUrl = buildPlaybackUrl({ baseUrl: origin, sourceType: classification.sourceType, provider: classification.provider, sourceUrl: resolved.href, redirectStream: diagnostic.redirectStream });
    diagnostic.mediaFlowEndpoint = new URL(diagnostic.playbackUrl).pathname;
    diagnostic.stage = "playback_url_created";
    diagnostic.status = args.checkPlayback ? "partially_resolved" : "resolved";
    if (args.checkPlayback) await probePlayback(diagnostic, fetcher);
    return diagnostic;
  } catch (error) {
    const failure = errorFrom(error);
    diagnostic.error = { code: failure.code, message: failure.message };
    diagnostic.status = failure.code === "UNSUPPORTED_SOURCE" ? "unsupported" : "failed";
    return diagnostic;
  }
}

function warningList(args: ResolveVideoArguments, mediaType: MediaType): string[] {
  const warnings: string[] = [];
  if (args.redirect_stream && mediaType !== "extractor") warnings.push("redirect_stream is only supported for extractor URLs and was ignored.");
  if (args.transcode) warnings.push("transcode is not supported by the configured MediaFlow API and was ignored.");
  if (args.max_res) warnings.push("max_res is not supported by the configured MediaFlow API and was ignored.");
  return warnings;
}

export async function resolveVideo(
  origin: string,
  args: ResolveVideoArguments,
  env: MediaflowConfig,
  fetcher: typeof fetch = fetch,
  lookup: DnsLookup = defaultDnsLookup,
): Promise<ResolveResult> {
  let target: URL;
  let link: URL | undefined;
  try {
    target = validatePublicUrl(args.url ?? "");
    link = args.link === undefined ? undefined : validatePublicUrl(args.link);
  } catch (error) { return { outcome: "invalid", message: (error as Error).message }; }
  if (isYouTube(target)) return { outcome: "ok", data: { url: target.href, source: "YouTube", original: target.href, alternates: [], mediaType: "youtube" } };

  let classification = classifySource(target);
  if (link && target.href !== link.href && classification.sourceType === "unknown") classification = { sourceType: "direct_stream", provider: null, confidence: "medium", matchedRule: "extracted-url-with-source-context" };
  if (args.provider && classification.sourceType === "unknown") {
    const provider = providerFromName(args.provider);
    if (!provider) return { outcome: "unsupported_provider", message: `Provider '${args.provider}' is not supported by the configured MediaFlow API.` };
    classification = { sourceType: "extractor", provider: provider.id, confidence: "medium", matchedRule: "explicit-provider" };
  }

  if (["hls", "dash", "direct_stream", "extractor"].includes(classification.sourceType)) {
    try {
      assertMediaflowConfigured(env);
      const playbackUrl = buildPlaybackUrl({ baseUrl: origin, sourceType: classification.sourceType, provider: classification.provider, sourceUrl: target.href, redirectStream: args.redirect_stream ?? false, link });
      const mediaType = mediaTypeFor(classification.sourceType);
      const warnings = warningList(args, mediaType);
      return {
        outcome: "ok",
        data: {
          url: playbackUrl,
          source: mediaType === "extractor" ? `MediaFlow Extractor (${providerById(classification.provider!).mediaFlowName})` : "MediaFlow Proxy",
          original: target.href,
          alternates: [],
          mediaType,
          ...(warnings.length ? { warnings } : {}),
        },
      };
    } catch (error) { return { outcome: error instanceof MediaflowError && error.kind === "configuration" ? "configuration" : "invalid", message: (error as Error).message }; }
  }

  const diagnostic = await diagnoseVideo(origin, { url: target.href, redirectStream: args.redirect_stream, checkPlayback: false }, env, fetcher, lookup);
  if (!diagnostic.playbackUrl || diagnostic.error) {
    const outcome = diagnostic.error?.code === "INVALID_URL" || diagnostic.error?.code === "SSRF_BLOCKED" || diagnostic.error?.code === "DNS_BLOCKED" ? "invalid"
      : diagnostic.error?.code === "TIMEOUT" ? "timeout"
      : diagnostic.error?.code === "CONFIGURATION" ? "configuration"
      : diagnostic.status === "unsupported" ? "unsupported_provider" : "upstream_error";
    return { outcome, message: diagnostic.error?.message ?? "The source could not be resolved." };
  }
  const path = new URL(diagnostic.playbackUrl).pathname;
  const mediaType: MediaType = path.startsWith("/extractor/") ? "extractor" : path.includes("/hls/") ? "hls" : path.includes("/mpd/") ? "dash" : "stream";
  const warnings = [...warningList(args, mediaType), ...diagnostic.warnings];
  return {
    outcome: "ok",
    data: {
      url: diagnostic.playbackUrl,
      source: mediaType === "extractor" ? `MediaFlow Extractor (${diagnostic.mediaFlowProvider ?? providerById(classification.provider!).mediaFlowName})` : "MediaFlow Proxy",
      original: target.href,
      alternates: [],
      mediaType,
      ...(warnings.length ? { warnings } : {}),
    },
  };
}

export function isSupportedProvider(value: string): boolean {
  return Boolean(providerFromName(value));
}
