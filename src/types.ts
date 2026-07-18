export type Outcome = "ok" | "invalid" | "not_found" | "unavailable" | "upstream_error" | "timeout";
export interface ResolvedVideo { url: string; source: string; original: string; thumbnail?: string; favicon?: string; alternates: string[]; }
export type ResolveResult = { outcome: "ok"; data: ResolvedVideo } | { outcome: Exclude<Outcome, "ok">; message: string };
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
