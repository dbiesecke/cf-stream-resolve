import { safeAsset } from "./validation";
import type { ResolvedVideo } from "./types";

export interface HostProvider { name: string; hosts: readonly string[]; extract(html: string, page: URL): ResolvedVideo | undefined; }

const media = (value: string) => /\.(?:m3u8|mp4)(?:[?#]|$)/i.test(value);
const valuePattern = /(?:file|source|src|hls|video_url|stream_url)\s*[:=]\s*["']([^"']+)["']/gi;
const urlPattern = /https?:\\?\/\\?\/[^"'\s<>]+?\.(?:m3u8|mp4)(?:[?#][^"'\s<>]*)?/gi;

function extractUrls(html: string, page: URL): string[] {
  const values: string[] = [];
  for (const match of html.matchAll(valuePattern)) values.push(match[1].replace(/\\\//g, "/"));
  for (const match of html.matchAll(urlPattern)) values.push(match[0].replace(/\\\//g, "/"));
  return [...new Set(values.map((value) => safeAsset(value, page)).filter((value): value is string => Boolean(value && media(value))))];
}

function adapter(name: string, hosts: readonly string[]): HostProvider {
  return { name, hosts, extract(html, page) { const urls = extractUrls(html, page); if (!urls.length) return undefined; const primary = urls.find((url) => url.includes(".m3u8")) ?? urls[0]; return { url: primary, source: name, original: page.href, alternates: urls.filter((url) => url !== primary) }; } };
}

export const HOST_PROVIDERS: readonly HostProvider[] = [
  adapter("City", ["cinemacity.cc"]), adapter("DoodStream", ["doodstream.com", "dood.to", "dood.so", "dood.watch", "playmogo.com"]),
  adapter("F16PX", ["f16px.com", "f16px.net"]), adapter("Fastream", ["fastream.to", "fastream.net"]),
  adapter("Filelions", ["filelions.to", "filelions.live"]), adapter("Filemoon", ["filemoon.sx", "filemoon.to", "bysezejataos.com"]),
  adapter("GUpload", ["gupload.com", "guupload.com"]), adapter("LiveTV", ["livetv.sx", "livetv.ru"]),
  adapter("LuluStream", ["lulustream.com", "lulustream.co"]), adapter("MaxStream", ["maxstream.video", "maxstream.to"]),
  adapter("MixDrop", ["mixdrop.co", "mixdrop.ps", "mixdrop.ag"]), adapter("Okru", ["ok.ru"]),
  adapter("SportsOnline", ["sportsonline.si", "sportsonline.to"]), adapter("StreamHG", ["streamhg.com", "streamhg.net"]),
  adapter("Streamtape", ["streamtape.com", "streamtape.to"]), adapter("Streamwish", ["streamwish.to", "streamwish.com"]),
  adapter("Supervideo", ["supervideo.tv", "supervideo.cc"]), adapter("TurboVidPlay", ["turbovidplay.com", "turbovidplay.net"]),
  adapter("UQload", ["uqload.to", "uqload.io"]), adapter("Vavoo", ["vavoo.to", "vavoo.tv"]),
  adapter("VidFast", ["vidfast.pro", "vidfast.net"]), adapter("Vidmoly", ["vidmoly.me", "vidmoly.to", "vidmoly.biz"]),
  adapter("Vidoza", ["vidoza.net", "vidoza.org"]), adapter("VixCloud", ["vixcloud.co", "vixcloud.cc"]),
  adapter("VOE", ["voe.sx", "voe-network.net", "ellenpoliticalfollow.com"])
];

export function providerFor(page: URL): HostProvider | undefined { const host = page.hostname.toLowerCase(); return HOST_PROVIDERS.find((provider) => provider.hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))); }
