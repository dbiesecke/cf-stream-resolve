# Usage

`cf-stream-resolve` classifies public media URLs and creates playback URLs on `https://resolve.btc-mining.at`. MediaFlow hosts and credentials remain server-side.

## OpenAPI 3.1.1

The complete GPT-compatible API contract, schemas, enums, and examples are maintained in [`openapi.yaml`](../openapi.yaml). It is the source of truth for `/resolve/diagnose` and `/resolve/providers`.

Validate it locally with:

```sh
npx --yes @redocly/cli lint openapi.yaml
```

## Diagnose a stream

```sh
curl -X POST https://resolve.btc-mining.at/resolve/diagnose \
  -H 'content-type: application/json' \
  --data '{
    "url": "https://voe.sx/e/example",
    "redirectStream": true,
    "checkPlayback": false
  }'
```

`resolutionTransport` explains how the source page was handled:

- `none`: direct media or registered provider; no page fetch was needed.
- `worker_direct`: bounded Worker redirect flow, currently used for AniWorld `/redirect/`.
- `mediaflow_forward`: internal MediaFlow Forward fetch for known AniWorld episode and ARD hosts.

Unknown page hosts are rejected. ARD series and season pages return `ARD_NOT_PLAYABLE_ITEM`; no episode is selected automatically.

## List providers

```sh
curl https://resolve.btc-mining.at/resolve/providers
```

The response contains public metadata for all 24 registered extractors. It does not expose aliases, credentials, or upstream configuration.

## Direct playback routes

The resolver selects these routes automatically:

| Source | Worker route |
| --- | --- |
| HLS | `/proxy/hls/manifest.m3u8` |
| DASH | `/proxy/mpd/manifest.m3u8` |
| Direct media | `/proxy/stream` |
| Provider embed | `/extractor/video`, `/extractor/video.m3u8`, or `/extractor/video.mp4` |

`/proxy/forward` is internal and returns `404` when called through the public Worker. Signed MediaFlow playback paths are relayed only when they match the strict token-path shape.

## MediaFlow configuration

Use publicly resolvable HTTPS hostnames, never direct IP addresses:

```jsonc
{
  "vars": {
    "MEDIAFLOW_PROXY_SERVERS": "https://mediaflow.btc-mining.at",
    "MEDIAFLOW_PROXY_DEFAULT": "https://mediaflow.btc-mining.at"
  }
}
```

Set the shared password only as a Worker secret:

```sh
npx wrangler secret put MEDIAFLOW_API_PASSWORD
```

Direct IPv4 and IPv6 MediaFlow origins are rejected during configuration validation.

## MCP

The stateless Streamable HTTP MCP endpoint is `POST /mcp`. Use the `resolve_video` tool with `url`; compatibility fields `link`, `endpoint`, and `provider` remain supported.
