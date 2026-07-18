import { validatePublicUrl, validateResolvedAddresses } from "./validation";
import type { DnsLookup } from "./validation";

export const defaultDnsLookup: DnsLookup = async (hostname) => {
  const query = async (type: "A" | "AAAA"): Promise<string[]> => {
    const url = new URL("https://cloudflare-dns.com/dns-query");
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", type);
    const response = await fetch(url, { headers: { accept: "application/dns-json" } });
    if (!response.ok) throw new Error(`DNS query failed with HTTP ${response.status}.`);
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || !("Answer" in value) || !Array.isArray(value.Answer)) return [];
    return value.Answer.flatMap((answer) => typeof answer === "object" && answer !== null
      && "type" in answer && (answer.type === 1 || answer.type === 28)
      && "data" in answer && typeof answer.data === "string" ? [answer.data] : []);
  };
  const results = await Promise.allSettled([query("A"), query("AAAA")]);
  if (results.every((result) => result.status === "rejected")) throw new Error("DNS resolution failed.");
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
};

export async function checkedFetch(
  raw: string | URL,
  init: RequestInit,
  fetcher: typeof fetch,
  lookup: DnsLookup,
  timeoutMs = 8_000,
): Promise<Response> {
  const url = validatePublicUrl(raw.toString());
  await validateResolvedAddresses(url, lookup);
  return fetchWithTimeout(url, init, fetcher, timeoutMs);
}

export async function fetchWithTimeout(raw: string | URL, init: RequestInit, fetcher: typeof fetch, timeoutMs = 8_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetcher(raw, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

export async function readBoundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > limit) throw new Error("UPSTREAM_ERROR: Response body exceeds the configured limit.");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error("UPSTREAM_ERROR: Response body exceeds the configured limit.");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function readBoundedText(response: Response, limit: number): Promise<string> {
  return new TextDecoder().decode(await readBoundedBytes(response, limit));
}

export async function readUpToBytes(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const bytes = new Uint8Array(limit);
  let length = 0;
  while (length < limit) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const remaining = limit - length;
    const selected = chunk.value.subarray(0, remaining);
    bytes.set(selected, length);
    length += selected.byteLength;
    if (selected.byteLength < chunk.value.byteLength) break;
  }
  await reader.cancel();
  return bytes.slice(0, length);
}
