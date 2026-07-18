# cf-stream-resolve

A Cloudflare Worker that classifies public video, manifest, embed, redirect, and ARD Mediathek URLs and creates Worker-local MediaFlow playback URLs. It keeps MediaFlow servers and credentials private and exposes a stateless MCP tool plus a diagnostic REST API.

## Resolution pipeline

Every request uses one pipeline:

1. Validate and normalize the public HTTP(S) URL.
2. Detect direct files, HLS, DASH, AniWorld, ARD, or a registered extractor provider.
3. Load known AniWorld episode and concrete ARD pages internally through MediaFlow Forward; keep AniWorld `/redirect/` on bounded Worker redirects.
4. Classify the resolved URL again.
5. Build one Worker-local MediaFlow URL with `URLSearchParams`.
6. Optionally probe playback with HEAD and a bounded Range GET.

Unknown web pages are neither fetched nor sent blindly to `/proxy/stream`. Forward is limited to registry hosts, AniWorld, and ARD. HTML inspection recognizes only URLs, meta refreshes, simple location assignments, and `location.replace()`. It never executes JavaScript.

## Configuration

Configure a comma-separated allowlist and an optional default. The default must exactly match an allowlisted server.

```jsonc
{
  "vars": {
    "MEDIAFLOW_PROXY_SERVERS": "https://mediaflow.btc-mining.at",
    "MEDIAFLOW_PROXY_DEFAULT": "https://mediaflow.btc-mining.at"
  }
}
```

Store the password as a Worker secret:

```sh
npx wrangler secret put MEDIAFLOW_API_PASSWORD
```

Clients cannot select a MediaFlow server. `MEDIAFLOW_API_PASSWORD` is added only to upstream requests and is removed from public URLs, rewritten manifests, and relayed redirects.

The MediaFlow origin terminates HTTPS on port 443 and forwards privately to its Python service on `127.0.0.1:8888`. Public port 8888 should remain closed. The same strong password is configured as MediaFlow `API_PASSWORD` and as the Worker secret.

## Provider registry

The central registry contains provider IDs, canonical MediaFlow names, strict host and alias rules, path hints, preferred player endpoints, and `redirect_stream` support.

| Provider IDs | Canonical MediaFlow names |
| --- | --- |
| `city`, `lulustream`, `turbovidplay`, `doodstream`, `maxstream`, `uqload` | `City`, `LuluStream`, `TurboVidPlay`, `Doodstream`, `Maxstream`, `Uqload` |
| `f16px`, `mixdrop`, `vavoo`, `fastream`, `okru`, `vidfast` | `F16Px`, `Mixdrop`, `Vavoo`, `Fastream`, `Okru`, `VidFast` |
| `filelions`, `sportsonline`, `vidmoly`, `filemoon`, `streamtape`, `vidoza` | `FileLions`, `Sportsonline`, `Vidmoly`, `FileMoon`, `Streamtape`, `Vidoza` |
| `gupload`, `streamwish`, `vixcloud`, `livetv`, `supervideo`, `voe` | `Gupload`, `StreamWish`, `VixCloud`, `LiveTV`, `Supervideo`, `Voe` |

Confirmed aliases include VOE's `ellenpoliticalfollow.com`, Vidoza's `videzz.net`, Uqload mirrors, TurboVidPlay mirrors, and Sportsonline/Sportzonline variants. Host matches require a real domain boundary; names such as `voe.sx.example.org` are not accepted as VOE.

### Endpoint selection

- `.m3u8`, `.m3u`, `.m3u_plus` → `/proxy/hls/manifest.m3u8`
- `.mpd` → `/proxy/mpd/manifest.m3u8`
- `.mp4`, `.mkv`, `.webm`, `.ts`, `.mov`, `.m4v` → `/proxy/stream`
- HLS extractors → `/extractor/video.m3u8`
- MP4 extractors → `/extractor/video.mp4`
- Dynamic Vavoo and LiveTV extraction → `/extractor/video`

`redirect_stream=true` is emitted only for registered extractor endpoints. It is never attached to proxy endpoints. A provider extension is a player hint; MediaFlow still performs the actual extraction and proxy selection.

## Diagnostic API

### Diagnose a URL

```sh
curl -X POST https://resolve.btc-mining.at/resolve/diagnose \
  -H 'content-type: application/json' \
  --data '{
    "url": "https://voe.sx/e/example",
    "redirectStream": true,
    "checkPlayback": true
  }'
```

`checkPlayback` defaults to `false`. When enabled, the Worker first sends HEAD and falls back to a bounded Range GET when HEAD is rejected or uninformative. Results distinguish `classified`, `playback_url_created`, `endpoint_reachable`, `manifest_loaded`, and `playable`.

The response includes classification confidence, `resolutionTransport` (`none`, `worker_direct`, or `mediaflow_forward`), redirect chain, resolved source, MediaFlow endpoint, playback URL, HTTP metadata, warnings, and a stable sanitized error.

### List providers

```sh
curl https://resolve.btc-mining.at/resolve/providers
```

The response exposes only provider IDs, canonical MediaFlow names, preferred endpoints, and redirect support. The complete OpenAPI 3.1.1 contract and examples are in [`openapi.yaml`](openapi.yaml).

## Redirects, AniWorld, and ARD

AniWorld episode pages are loaded through internal MediaFlow Forward and searched for registered provider URLs. One target continues through the normal extractor flow; multiple targets return `partially_resolved`. AniWorld `/redirect/` stays on manual Worker redirects because Forward does not expose its final redirect URL.

ARD pages are loaded through Forward and inspected for structured player data and HLS, DASH, or direct media URLs. Series and season pages return `ARD_NOT_PLAYABLE_ITEM`; the resolver never selects an arbitrary episode.

Forward is an internal page-fetch transport, not a playback route. It accepts only resolver-controlled GET requests and selected headers. It is never present in the public gateway allowlist. HLS, DASH, files, and extractor playback continue through streaming-aware MediaFlow routes with Range and manifest rewriting support.

MediaFlow-signed playback subpaths are relayed only when they match the strict token-path shape. Their origin is rewritten to the Worker, and client query parameters are discarded. This keeps the MediaFlow hostname and password out of public manifests while preserving nested HLS/DASH playback.

If an unknown page exposes more than one supported target, the result is `partially_resolved` and no arbitrary target is selected.

## Security

- Only public HTTP(S) URLs without credentials are accepted.
- Loopback, private, link-local, carrier-grade NAT, benchmarking, multicast, and reserved IPv4/IPv6 ranges are blocked.
- A and AAAA answers are checked through DNS-over-HTTPS before every server-side page fetch.
- Every redirect target is validated again.
- Forward targets must match a provider-registry host, AniWorld, or ARD at a domain boundary.
- HTML is limited to 512 KiB, playback samples to 64 KiB, individual fetches to 8 seconds, and resolution to 20 seconds.
- Large media responses continue to stream; only bounded HTML, manifests, and diagnostic samples are buffered.
- No stack traces, tokens, API keys, cookies, or sensitive request headers are returned.

DNS validation reduces rebinding risk, but Cloudflare Workers cannot pin the checked address to the later hostname fetch. Deployments that require cryptographic network isolation should add an egress proxy that performs DNS resolution and the connection atomically.

## MCP and compatibility routes

`POST /mcp` remains a stateless Streamable HTTP MCP server with `resolve_video`. Protocols `2025-11-25` and `2025-03-26`, batches, initialization, ping, tool listing, origin validation, and JSON content negotiation remain supported.

Compatibility fields `link`, `endpoint`, and `provider` remain accepted. `url` is always the media destination; `link` supplies Referer/Origin context; `endpoint` cannot override automatic routing; direct media classification takes precedence over a provider hint.

`/` and `/interaction/resolve.html` retain their existing response envelopes. Gateway routes support GET, HEAD, ranges, CORS, streaming passthrough, bounded HLS rewriting, sanitized redirects, and the existing exact Cloudflare `403 error code: 1003` fallback.

## Development

```sh
npm install
npx wrangler types
npm run dev
npm test
npm run typecheck
npm run lint
npx wrangler deploy --dry-run
```

Tests use compact tables for all providers and focused mocks for Forward, redirects, ARD, playback probing, DNS, private targets, timeouts, encoding, and domain-boundary attacks. Provider classification and URL construction do not claim that a current third-party stream is live or playable.
