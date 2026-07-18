# cf-stream-resolve

A Cloudflare Worker that creates safe, Worker-local MediaFlow proxy URLs. Local host adapters, HTML scraping, browser impersonation, and access-control bypasses are intentionally not included.

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

`MEDIAFLOW_API_PASSWORD` is appended only to the selected MediaFlow upstream request and is never included in a Worker-generated URL or relayed redirect.

## API

`GET /proxy/stream?d=<encoded URL>` validates `d`, selects a configured MediaFlow server, and streams its response without buffering. It transparently returns its status, body, content type, and redirects. Optional flags are forwarded only when set to `true`:

```sh
curl -i 'https://YOUR-WORKER.workers.dev/proxy/stream?d=https%3A%2F%2Fvideo.example%2Fembed%2Fabc&max_res=true&redirect_stream=true'
```

Use `proxyServer=<encoded allowlisted base URL>` to choose a non-default configured server. Arbitrary proxy server URLs are rejected.

`/` and `/interaction/resolve.html` remain available. Their existing `url` parameter is converted into a Worker-local `/proxy/stream?d=…` URL, preserving the prior JSON and MSX response contracts. They also accept `proxyServer`, `redirect_stream`, `transcode`, and `max_res`.

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
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"resolve_video","arguments":{"url":"https://video.example/embed/abc","max_res":true}}}'
```

The tool only creates a Worker-local proxy URL. It does not fetch media during the call, bypass access controls, or expose MediaFlow credentials.

## Development

```sh
npm install
npm run dev
npm test
npm run lint
npm run typecheck
```

The Worker accepts only public HTTP(S) target URLs without embedded credentials. It does not create Turnstile cookies, emulate browser TLS/HTTP2 fingerprints, or bypass upstream access controls.
