import type { ExtractorProvider } from "./providers";

export type MediaType = "youtube" | "hls" | "dash" | "stream" | "extractor";
export type Outcome = "ok" | "invalid" | "unsupported_provider" | "configuration" | "upstream_error" | "timeout";
export type SourceType = "direct_stream" | "hls" | "dash" | "extractor" | "redirect" | "aniworld_redirect" | "ard_mediathek" | "unknown";
export type ResolveStatus = "resolved" | "partially_resolved" | "unsupported" | "failed";
export type ResolveStage = "classified" | "playback_url_created" | "endpoint_reachable" | "manifest_loaded" | "playable";
export type Confidence = "high" | "medium" | "low";
export type DiagnosticErrorCode = "INVALID_URL" | "SSRF_BLOCKED" | "DNS_BLOCKED" | "REDIRECT_FAILED" | "REDIRECT_LOOP" | "TIMEOUT" | "ARD_NOT_PLAYABLE_ITEM" | "UNSUPPORTED_SOURCE" | "UPSTREAM_ERROR" | "CONFIGURATION";

export interface ClassificationResult {
  sourceType: SourceType;
  provider: ExtractorProvider | null;
  confidence: Confidence;
  matchedRule: string | null;
}

export interface RedirectHop { url: string; status: number; }
export interface DiagnosticError { code: DiagnosticErrorCode; message: string; }

export interface ResolveDiagnostic {
  inputUrl: string;
  normalizedUrl: string | null;
  sourceType: SourceType;
  provider: ExtractorProvider | null;
  mediaFlowProvider: string | null;
  confidence: Confidence;
  matchedRule: string | null;
  redirectChain: RedirectHop[];
  resolvedSourceUrl: string | null;
  mediaFlowEndpoint: string | null;
  playbackUrl: string | null;
  redirectStream: boolean;
  httpStatus: number | null;
  contentType: string | null;
  finalUrl: string | null;
  durationMs: number | null;
  cors: "allowed" | "not_advertised" | "not_checked";
  bodySize: number | null;
  manifestDetected: boolean;
  stage: ResolveStage;
  status: ResolveStatus;
  warnings: string[];
  error: DiagnosticError | null;
}

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
