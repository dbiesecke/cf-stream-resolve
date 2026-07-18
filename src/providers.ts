export type ExtractorProvider =
  | "city" | "lulustream" | "turbovidplay" | "doodstream" | "maxstream" | "uqload"
  | "f16px" | "mixdrop" | "vavoo" | "fastream" | "okru" | "vidfast"
  | "filelions" | "sportsonline" | "vidmoly" | "filemoon" | "streamtape" | "vidoza"
  | "gupload" | "streamwish" | "vixcloud" | "livetv" | "supervideo" | "voe";

export type ExtractorEndpoint = "video" | "video.m3u8" | "video.mp4";

export interface ProviderDefinition {
  id: ExtractorProvider;
  mediaFlowName: string;
  hosts: readonly string[];
  hostLabels?: readonly string[];
  pathPatterns?: readonly RegExp[];
  preferredEndpoint: ExtractorEndpoint;
  supportsRedirectStream: boolean;
}

const embedPaths = [/^\/(?:e|embed|embed-|v|video|watch|d)\/?/i];

export const PROVIDERS: readonly ProviderDefinition[] = [
  { id: "city", mediaFlowName: "City", hosts: ["citytv.live"], hostLabels: ["city"], preferredEndpoint: "video.m3u8", supportsRedirectStream: true },
  { id: "lulustream", mediaFlowName: "LuluStream", hosts: ["lulustream.com", "luluvdo.com"], hostLabels: ["lulustream", "luluvdo"], pathPatterns: embedPaths, preferredEndpoint: "video.m3u8", supportsRedirectStream: true },
  { id: "turbovidplay", mediaFlowName: "TurboVidPlay", hosts: ["turboviplay.com", "emturbovid.com", "tuborstb.co", "javggvideo.xyz", "stbturbo.xyz", "turbovidhls.com"], pathPatterns: embedPaths, preferredEndpoint: "video.m3u8", supportsRedirectStream: true },
  { id: "doodstream", mediaFlowName: "Doodstream", hosts: ["doodstream.com", "dood.to", "dood.watch", "dood.so", "dood.pm", "dsvplay.com", "myvidplay.com"], hostLabels: ["doodstream", "dood"], pathPatterns: embedPaths, preferredEndpoint: "video.mp4", supportsRedirectStream: true },
  { id: "maxstream", mediaFlowName: "Maxstream", hosts: ["maxstream.video", "uprot.net"], hostLabels: ["maxstream"], pathPatterns: embedPaths, preferredEndpoint: "video.m3u8", supportsRedirectStream: true },
  { id: "uqload", mediaFlowName: "Uqload", hosts: ["uqload.com", "uqload.co", "uqload.io", "uqload.bz", "uqload.is"], hostLabels: ["uqload"], pathPatterns: embedPaths, preferredEndpoint: "video.mp4", supportsRedirectStream: true },
  { id: "f16px", mediaFlowName: "F16Px", hosts: ["f16px.com", "f16px.lol"], hostLabels: ["f16px"], pathPatterns: embedPaths, preferredEndpoint: "video.m3u8", supportsRedirectStream: true },
  { id: "mixdrop", mediaFlowName: "Mixdrop", hosts: ["mixdrop.co", "mixdrop.to", "mixdrop.sx", "mixdrop.club", "mixdrop.ps", "mixdrop.ag"], hostLabels: ["mixdrop"], pathPatterns: embedPaths, preferredEndpoint: "video.mp4", supportsRedirectStream: true },
  { id: "vavoo", mediaFlowName: "Vavoo", hosts: ["vavoo.to", "vavoo.tv"], hostLabels: ["vavoo"], preferredEndpoint: "video", supportsRedirectStream: true },
  { id: "fastream", mediaFlowName: "Fastream", hosts: ["fastream.to", "fastream.is"], hostLabels: ["fastream"], pathPatterns: embedPaths, preferredEndpoint: "video.m3u8", supportsRedirectStream: true },
  { id: "okru", mediaFlowName: "Okru", hosts: ["ok.ru", "odnoklassniki.ru"], pathPatterns: [/^\/video(?:embed)?\//i], preferredEndpoint: "video.m3u8", supportsRedirectStream: true },
  { id: "vidfast", mediaFlowName: "VidFast", hosts: ["vidfast.pro"], hostLabels: ["vidfast"], pathPatterns: [/^\/(?:movie|tv)\//i], preferredEndpoint: "video.m3u8", supportsRedirectStream: true },
  { id: "filelions", mediaFlowName: "FileLions", hosts: ["filelions.to", "filelions.live"], hostLabels: ["filelions"], pathPatterns: embedPaths, preferredEndpoint: "video.m3u8", supportsRedirectStream: true },
  { id: "sportsonline", mediaFlowName: "Sportsonline", hosts: ["sportsonline.st", "sportsonline.si", "sportsonline.sn", "sportzonline.st", "sportzonline.bz", "sportzonline.cc", "sportzonline.top", "sportzsonline.click"], hostLabels: ["sportsonline", "sportzonline", "sportzsonline"], preferredEndpoint: "video.m3u8", supportsRedirectStream: true },
  { id: "vidmoly", mediaFlowName: "Vidmoly", hosts: ["vidmoly.biz", "vidmoly.to", "vidmoly.me"], hostLabels: ["vidmoly"], pathPatterns: embedPaths, preferredEndpoint: "video.m3u8", supportsRedirectStream: true },
  { id: "filemoon", mediaFlowName: "FileMoon", hosts: ["filemoon.sx", "filemoon.to", "filemoon.in"], hostLabels: ["filemoon"], pathPatterns: embedPaths, preferredEndpoint: "video.m3u8", supportsRedirectStream: true },
  { id: "streamtape", mediaFlowName: "Streamtape", hosts: ["streamtape.com", "streamtape.to", "streamtape.cc"], hostLabels: ["streamtape"], pathPatterns: embedPaths, preferredEndpoint: "video.mp4", supportsRedirectStream: true },
  { id: "vidoza", mediaFlowName: "Vidoza", hosts: ["vidoza.net", "videzz.net"], hostLabels: ["vidoza", "videzz"], pathPatterns: embedPaths, preferredEndpoint: "video.mp4", supportsRedirectStream: true },
  { id: "gupload", mediaFlowName: "Gupload", hosts: ["gupload.xyz"], hostLabels: ["gupload"], pathPatterns: embedPaths, preferredEndpoint: "video.m3u8", supportsRedirectStream: true },
  { id: "streamwish", mediaFlowName: "StreamWish", hosts: ["streamwish.to", "streamwish.site", "wishfast.top", "streamwish.com"], hostLabels: ["streamwish", "wishfast"], pathPatterns: embedPaths, preferredEndpoint: "video.m3u8", supportsRedirectStream: true },
  { id: "vixcloud", mediaFlowName: "VixCloud", hosts: ["vixcloud.co", "vixcloud.to"], hostLabels: ["vixcloud"], pathPatterns: embedPaths, preferredEndpoint: "video.m3u8", supportsRedirectStream: true },
  { id: "livetv", mediaFlowName: "LiveTV", hosts: ["livetv.sx", "livetv.ru"], hostLabels: ["livetv"], preferredEndpoint: "video", supportsRedirectStream: true },
  { id: "supervideo", mediaFlowName: "Supervideo", hosts: ["supervideo.tv", "supervideo.cc"], hostLabels: ["supervideo"], pathPatterns: embedPaths, preferredEndpoint: "video.m3u8", supportsRedirectStream: true },
  { id: "voe", mediaFlowName: "Voe", hosts: ["voe.sx", "voe.to", "voeunblock.com", "ellenpoliticalfollow.com"], hostLabels: ["voe"], pathPatterns: embedPaths, preferredEndpoint: "video.m3u8", supportsRedirectStream: true },
] as const;

const byId = new Map(PROVIDERS.map((provider) => [provider.id, provider]));
const byName = new Map(PROVIDERS.flatMap((provider) => [[provider.id, provider], [provider.mediaFlowName.toLowerCase(), provider]] as const));

export function providerById(id: ExtractorProvider): ProviderDefinition {
  return byId.get(id)!;
}

export function providerFromName(value: string): ProviderDefinition | undefined {
  return byName.get(value.trim().toLowerCase());
}

function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

const forwardSourceHosts = ["aniworld.to", "ardmediathek.de"] as const;

export function isKnownForwardTarget(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return forwardSourceHosts.some((host) => domainMatches(hostname, host))
    || PROVIDERS.some((provider) => provider.hosts.some((host) => domainMatches(hostname, host)));
}

export function providerFromUrl(url: URL): ProviderDefinition | undefined {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  for (const provider of PROVIDERS) {
    if (provider.hosts.some((host) => domainMatches(hostname, host))) return provider;
    const labels = hostname.split(".");
    const registrableLabel = labels.at(-2);
    if (provider.hostLabels?.includes(registrableLabel ?? "") && provider.pathPatterns?.some((pattern) => pattern.test(url.pathname))) return provider;
  }
  return undefined;
}

export function publicProviderList() {
  return PROVIDERS.map(({ id, mediaFlowName, preferredEndpoint, supportsRedirectStream }) => ({ id, mediaFlowName, preferredEndpoint, supportsRedirectStream }));
}
