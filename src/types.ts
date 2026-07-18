export type MediaType = "youtube" | "hls" | "dash" | "stream" | "extractor";
export type Outcome = "ok" | "invalid" | "unsupported_provider" | "configuration" | "upstream_error" | "timeout";

export interface ResolvedVideo {
  url: string;
  source: string;
  original: string;
  alternates: string[];
  mediaType?: MediaType;
  warnings?: string[];
}

export type ResolveResult =
  | { outcome: "ok"; data: ResolvedVideo }
  | { outcome: Exclude<Outcome, "ok">; message: string };
