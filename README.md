# cf-stream-resolve

A Cloudflare Worker that classifies public video URLs and creates the correct, Worker-local MediaFlow playback URL. Local host adapters, HTML scraping, browser impersonation, and access-control bypasses are intentionally not included.

## Configuration

Configure a comma-separated allowlist and its default in the Worker environment. Values must be public HTTP(S) MediaFlow base URLs and the default must be an exact member of the list.

```jsonc
// wrangler.jsonc (example values only)
{
  "vars": {
    "MEDIAFLOW_PROXY_SERVERS": "https://mediaflow-1.example,https://mediaflow-2.example",
    "MEDIAFLOW_PROXY_DEFAULT": "https://mediaflow-1.example"
  }
}
```

Set the password outside the repository:

```sh
npx wrangler secret put MEDIAFLOW_API_PASSWORD
```

`MEDIAFLOW_API_PASSWORD` is appended only to the selected MediaFlow upstream request and is removed from Worker-generated URLs, relayed redirects, and rewritten manifests.

## API

The resolver chooses a playback route from the URL before any media is fetched:

- YouTube URLs remain direct.
- `.m3u8` and `.m3u` use `/proxy/hls/manifest.m3u8`.
- `.mpd` uses `/proxy/mpd/manifest.m3u8`.
- Supported extractor providers use `/extractor/video`.
- Other public HTTP(S) URLs use `/proxy/stream`.

Gateway routes validate `d`, select the configured MediaFlow server, and support cross-origin `GET`, `HEAD`, and byte-range requests. Binary streams pass through without buffering. HLS manifests are size-bounded and rewritten so nested playlists, segments, keys, and init maps stay on the Worker origin.

If MediaFlow returns the exact Cloudflare response `403 error code: 1003` for an otherwise valid public destination, the Worker first retries MediaFlow with its documented `no_proxy=true` mode and then retries the validated destination directly. This fallback chain is deliberately limited to that signature; all other MediaFlow errors pass through unchanged.

```sh
curl -i 'https://YOUR-WORKER.workers.dev/proxy/hls/manifest.m3u8?d=https%3A%2F%2Fcdn.example%2Flive%2Findex.m3u8'
```

The server is selected exclusively from `MEDIAFLOW_PROXY_SERVERS`; clients cannot choose or override a proxy host. `MEDIAFLOW_PROXY_DEFAULT` selects an allowlisted entry, and the first configured server is used if no default is set.

`/` and `/interaction/resolve.html` remain available and preserve their existing JSON and MSX response envelopes. Their `url` input is classified using the same resolver as MCP. Compatibility options `redirect_stream`, `transcode`, and `max_res` remain accepted; options unsupported by the configured MediaFlow API are omitted and reported in `warnings`.

## MCP

`POST /mcp` is a stateless Streamable HTTP MCP Tool Server. It supports protocol versions `2025-11-25` and `2025-03-26`, JSON-RPC batches, `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`. The endpoint exposes one deterministic, read-only and idempotent tool: `resolve_video`.

Clients should send `Content-Type: application/json` and an `Accept` header that includes both `application/json` and `text/event-stream`. This server does not offer an SSE stream or session management, so `GET /mcp` and `DELETE /mcp` return `405 Method Not Allowed`. Browser requests must use the Worker origin; non-browser clients may omit `Origin`.

Initialize the connection:

```sh
curl -X POST https://YOUR-WORKER.workers.dev/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"example-client","version":"1.0.0"}}}'
```

Discover and call the tool:

```sh
curl -X POST https://YOUR-WORKER.workers.dev/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

curl -X POST https://YOUR-WORKER.workers.dev/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"resolve_video","arguments":{"url":"https://cdn.example/live/index.m3u8","link":"https://video.example/embed/abc","provider":"Vidmoly"}}}'
```

The tool only creates a direct YouTube URL or Worker-local playback URL. It does not fetch media during the call, bypass access controls, or expose MediaFlow credentials. Successful results retain `url`, `source`, `original`, and `alternates`, and may add `mediaType` and `warnings`.

For compatibility with clients that attach playback context, `resolve_video` accepts optional `link`, `endpoint` (only `/proxy/stream`), and `provider` fields. `endpoint` never overrides automatic routing. A validated `link` supplies upstream Referer and Origin context but never replaces `url`. Direct media URLs take precedence over provider extraction. The configured MediaFlow API currently supports `Doodstream`, `Mixdrop`, `Uqload`, `Streamtape`, `Supervideo`, and `LiveTV`; other embed-only providers return `unsupported_provider`.

## Development

```sh
npm install
npx wrangler types
npm run dev
npm test
npm run lint
npm run typecheck
```

The Worker accepts only public HTTP(S) target URLs without embedded credentials. It does not create Turnstile cookies, emulate browser TLS/HTTP2 fingerprints, or bypass upstream access controls.
