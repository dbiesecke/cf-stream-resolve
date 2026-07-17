const MAX_URL_LENGTH = 4096;
const blockedHosts = new Set(["localhost", "metadata.google.internal", "metadata.azure.com", "169.254.169.254"]);

function ipv4Private(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function ipv6Private(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:") || normalized.startsWith("::ffff:127.");
}

export function validatePublicUrl(raw: string): URL {
  if (!raw || raw.length > MAX_URL_LENGTH) throw new Error("A non-empty URL up to 4096 characters is required.");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("url must be an absolute HTTP(S) URL."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http: and https: URLs are allowed.");
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (blockedHosts.has(host) || host.endsWith(".localhost") || ipv4Private(host) || ipv6Private(host)) throw new Error("This host is not publicly routable.");
  return url;
}

export function safeAsset(value: string | undefined, base: URL): string | undefined {
  if (!value) return undefined;
  try { return validatePublicUrl(new URL(value, base).href).href; } catch { return undefined; }
}
