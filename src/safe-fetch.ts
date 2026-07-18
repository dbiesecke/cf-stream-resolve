import { validatePublicUrl } from "./validation";
import type { FetchLike } from "./types";

// Some otherwise ordinary video pages embed their public player configuration
// inline. Keep this bounded, but leave enough room for those pages.
export const MAX_UPSTREAM_DOCUMENT_BYTES = 1_500_000;
export interface SafeFetchOptions { headers?: HeadersInit; }

export class SafeFetchError extends Error { constructor(public readonly kind: "timeout" | "upstream_error" | "invalid") { super(kind); } }
export async function safeFetch(raw: string, fetcher: FetchLike = fetch, timeoutMs = 8000, redirects = 3, options: SafeFetchOptions = {}): Promise<{ response: Response; finalUrl: URL }> {
  let url: URL;
  try { url = validatePublicUrl(raw); } catch { throw new SafeFetchError("invalid"); }
  for (let attempt = 0; attempt <= redirects; attempt += 1) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try { response = await fetcher(url.href, { redirect: "manual", signal: controller.signal, headers: { accept: "text/html,application/json;q=0.9,*/*;q=0.1", "user-agent": "cf-stream-resolve/0.1", ...options.headers } }); }
    catch (error) { clearTimeout(timer); throw new SafeFetchError((error as Error).name === "AbortError" ? "timeout" : "upstream_error"); }
    clearTimeout(timer);
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      if (attempt === redirects) throw new SafeFetchError("upstream_error");
      try { url = validatePublicUrl(new URL(response.headers.get("location")!, url).href); } catch { throw new SafeFetchError("invalid"); }
      continue;
    }
    return { response, finalUrl: url };
  }
  throw new SafeFetchError("upstream_error");
}

export async function boundedText(response: Response, maxBytes = MAX_UPSTREAM_DOCUMENT_BYTES): Promise<string> {
  const length = Number(response.headers.get("content-length") || 0); if (length > maxBytes) throw new SafeFetchError("upstream_error");
  const reader = response.body?.getReader(); if (!reader) return ""; const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new SafeFetchError("upstream_error"); } chunks.push(next.value); }
  const all = new Uint8Array(size); let at = 0; for (const chunk of chunks) { all.set(chunk, at); at += chunk.byteLength; } return new TextDecoder().decode(all);
}
