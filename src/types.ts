export type Outcome = "ok" | "invalid" | "configuration" | "upstream_error" | "timeout";
export type ResolveResult = { outcome: "ok"; data: { url: string; source: string; original: string; alternates: string[] } } | { outcome: Exclude<Outcome, "ok">; message: string };
