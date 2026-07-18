const MAX_URL_LENGTH = 4096;
const blockedHosts = new Set(["localhost", "metadata.google.internal", "metadata.azure.com", "169.254.169.254"]);

function ipv4Private(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && parts[2] === 100)
    || (a === 203 && b === 0 && parts[2] === 113);
}

function ipv6Private(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff")) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? ipv4Private(mapped[1]) : true;
  }
  return normalized.startsWith("2001:db8:") || normalized.startsWith("2001:2:");
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  return ipv4Private(normalized) || (normalized.includes(":") && ipv6Private(normalized));
}

export function validatePublicUrl(raw: string): URL {
  if (!raw || raw.length > MAX_URL_LENGTH) throw new Error("A non-empty URL up to 4096 characters is required.");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("url must be an absolute HTTP(S) URL."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http: and https: URLs are allowed.");
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if ([...blockedHosts].some((blocked) => host === blocked || host.endsWith(`.${blocked}`)) || host.endsWith(".localhost") || ipv4Private(host) || ipv6Private(host)) throw new Error("This host is not publicly routable.");
  return url;
}

export type DnsLookup = (hostname: string) => Promise<string[]>;

export async function validateResolvedAddresses(url: URL, lookup: DnsLookup): Promise<void> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes(":")) return;
  let addresses: string[];
  try { addresses = await lookup(url.hostname); }
  catch { throw new Error("DNS_BLOCKED: DNS resolution failed."); }
  if (!addresses.length) throw new Error("DNS_BLOCKED: DNS resolution returned no public address.");
  if (addresses.some(isPrivateAddress)) throw new Error("DNS_BLOCKED: DNS resolution returned a private or reserved address.");
}

export function safeAsset(value: string | undefined, base: URL): string | undefined {
  if (!value) return undefined;
  try { return validatePublicUrl(new URL(value, base).href).href; } catch { return undefined; }
}
