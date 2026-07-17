import { safeAsset } from "./validation";
import type { ResolvedVideo } from "./types";

const mediaUrl = (value: string) => /\.(?:mp4|m3u8)(?:[?#]|$)/i.test(value);

/** Reads the small public ARD JSON shape used in page fixtures; no protected APIs are queried. */
export function extractArdMetadata(value: unknown, page: URL): ResolvedVideo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const streams = [record.streamUrl, record.url, record.src]
    .filter((item): item is string => typeof item === "string")
    .map((item) => safeAsset(item, page))
    .filter((item): item is string => Boolean(item && mediaUrl(item)));
  if (!streams.length) return undefined;
  const unique = [...new Set(streams)];
  const primary = unique.find((item) => item.includes(".m3u8")) ?? unique[0];
  return { url: primary, source: "ARD Mediathek", original: page.href, alternates: unique.filter((item) => item !== primary) };
}
