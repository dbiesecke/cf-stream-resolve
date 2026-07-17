import { safeAsset } from "./validation";
import type { ResolvedVideo } from "./types";
import { extractArdMetadata } from "./providers";

const media = (url: string) => /\.(mp4|m3u8)(?:[?#]|$)/i.test(url);
function attribute(tag: string, name: string): string | undefined { return new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1]; }
function meta(html: string, keys: string[]): string | undefined { for (const key of keys) { const hit = new RegExp(`<meta\\b[^>]*(?:property|name)=["']${key}["'][^>]*>`, "i").exec(html); const value = hit && attribute(hit[0], "content"); if (value) return value; } return undefined; }
export function collectMediaUrls(value: unknown, page: URL, depth = 0, seen = new WeakSet<object>()): string[] {
  if (depth > 8 || !value || typeof value !== "object") return [];
  if (seen.has(value)) return []; seen.add(value);
  const direct = extractArdMetadata(value, page); const urls = direct ? [direct.url, ...direct.alternates] : [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === "string" && /(url|src|stream|video|media)/i.test(key)) { const asset = safeAsset(child, page); if (asset && media(asset)) urls.push(asset); }
    else urls.push(...collectMediaUrls(child, page, depth + 1, seen));
  }
  return [...new Set(urls)];
}
export function extractMedia(html: string, page: URL): ResolvedVideo | undefined {
  const candidates: string[] = [];
  for (const tag of html.matchAll(/<(?:video|source)\b[^>]*>/gi)) { const asset = safeAsset(attribute(tag[0], "src"), page); if (asset && media(asset)) candidates.push(asset); }
  for (const key of ["og:video", "og:video:url", "twitter:player:stream"]) { const asset = safeAsset(meta(html, [key]), page); if (asset && media(asset)) candidates.push(asset); }
  for (const tag of html.matchAll(/<script\b[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { candidates.push(...collectMediaUrls(JSON.parse(tag[1]), page)); } catch { /* invalid publisher JSON is ignored */ } }
  const unique = [...new Set(candidates)]; if (!unique.length) return undefined;
  const primary = unique.find((value) => /\.m3u8(?:[?#]|$)/i.test(value)) ?? unique[0];
  const faviconTag = /<link\b[^>]*rel=["'][^"']*icon[^"']*["'][^>]*>/i.exec(html)?.[0];
  return { url: primary, source: meta(html, ["og:site_name"]) ?? (page.hostname.endsWith("ardmediathek.de") ? "ARD Mediathek" : page.hostname), original: page.href, thumbnail: safeAsset(meta(html, ["og:image", "twitter:image"]), page), favicon: safeAsset(faviconTag && attribute(faviconTag, "href"), page), alternates: unique.filter((value) => value !== primary) };
}
