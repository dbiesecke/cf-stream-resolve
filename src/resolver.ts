import { assertMediaflowConfigured } from "./mediaflow";
import type { MediaflowConfig } from "./mediaflow";
import type { MediaType, ResolveResult } from "./types";
import { validatePublicUrl } from "./validation";

export interface ResolveVideoArguments {
  url?: string;
  link?: string;
  endpoint?: string;
  provider?: string;
  redirect_stream?: boolean;
  transcode?: boolean;
  max_res?: boolean;
}

const supportedProviders = new Map([
  ["doodstream", "Doodstream"],
  ["mixdrop", "Mixdrop"],
  ["uqload", "Uqload"],
  ["streamtape", "Streamtape"],
  ["supervideo", "Supervideo"],
  ["livetv", "LiveTV"],
]);

function isYouTube(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com");
}

function pathMatches(url: URL, extensions: readonly string[]): boolean {
  const path = url.pathname.toLowerCase();
  return extensions.some((extension) => path.endsWith(extension));
}

function warningList(args: ResolveVideoArguments, mediaType: MediaType): string[] {
  const warnings: string[] = [];
  if (args.redirect_stream && mediaType !== "extractor") warnings.push("redirect_stream is only supported for extractor URLs and was ignored.");
  if (args.transcode) warnings.push("transcode is not supported by the configured MediaFlow API and was ignored.");
  if (args.max_res) warnings.push("max_res is not supported by the configured MediaFlow API and was ignored.");
  return warnings;
}

function contextParams(target: URL, link?: URL): URLSearchParams {
  const params = new URLSearchParams();
  params.set("d", target.href);
  if (link) {
    params.set("h_referer", link.href);
    params.set("h_origin", link.origin);
  }
  return params;
}

function workerUrl(origin: string, endpoint: string, params: URLSearchParams): string {
  const result = new URL(endpoint, origin);
  result.search = params.toString();
  return result.href;
}

export function resolveVideo(origin: string, args: ResolveVideoArguments, env: MediaflowConfig): ResolveResult {
  let target: URL;
  let link: URL | undefined;
  try {
    target = validatePublicUrl(args.url ?? "");
    link = args.link === undefined ? undefined : validatePublicUrl(args.link);
  } catch (error) {
    return { outcome: "invalid", message: (error as Error).message };
  }

  if (isYouTube(target)) {
    return {
      outcome: "ok",
      data: { url: target.href, source: "YouTube", original: target.href, alternates: [], mediaType: "youtube" },
    };
  }

  try {
    assertMediaflowConfigured(env);
  } catch (error) {
    return { outcome: "configuration", message: (error as Error).message };
  }

  let mediaType: MediaType;
  let endpoint: string;
  const params = contextParams(target, link);

  if (pathMatches(target, [".m3u8", ".m3u"])) {
    mediaType = "hls";
    endpoint = "/proxy/hls/manifest.m3u8";
  } else if (pathMatches(target, [".mpd"])) {
    mediaType = "dash";
    endpoint = "/proxy/mpd/manifest.m3u8";
  } else if (link && target.href !== link.href) {
    mediaType = "stream";
    endpoint = "/proxy/stream";
  } else if (args.provider) {
    const provider = supportedProviders.get(args.provider.trim().toLowerCase());
    if (!provider) return { outcome: "unsupported_provider", message: `Provider '${args.provider}' is not supported by the configured MediaFlow API.` };
    mediaType = "extractor";
    endpoint = "/extractor/video";
    params.set("host", provider);
    if (args.redirect_stream) params.set("redirect_stream", "true");
  } else {
    mediaType = "stream";
    endpoint = "/proxy/stream";
  }

  const warnings = warningList(args, mediaType);
  return {
    outcome: "ok",
    data: {
      url: workerUrl(origin, endpoint, params),
      source: mediaType === "extractor" ? `MediaFlow Extractor (${params.get("host")})` : "MediaFlow Proxy",
      original: target.href,
      alternates: [],
      mediaType,
      ...(warnings.length ? { warnings } : {}),
    },
  };
}

export function isSupportedProvider(value: string): boolean {
  return supportedProviders.has(value.trim().toLowerCase());
}
