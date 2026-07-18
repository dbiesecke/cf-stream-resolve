# cf-stream-resolve

A Cloudflare Worker that resolves publicly embedded MP4 and HLS streams from direct URLs or conservative HTML metadata. It is intended for a browser/WebUI, MCP clients, Media Station X, and direct playback tools.

It resolves pages uniformly by their publicly embedded metadata; it has no hostname-based age or DRM blocklist. It does not perform access-control circumvention. A URL that cannot be resolved safely returns a structured error.

## Install and develop

Requires Node.js 20+ and a Cloudflare account only for deployment.

```sh
npm install
npm run dev
npm test
npm run lint
npm run typecheck
```

Deploy after authenticating Wrangler:

```sh
npm run deploy
```

The Worker has no required secrets or environment variables. Its upstream limit is 8 seconds and 1.5 MB of HTML/JSON per response; redirects are manually followed up to three hops and each target is revalidated. Only HTTP(S), public routable URLs with no credentials are accepted. Private, loopback, link-local, ULA, CGNAT, and cloud-metadata addresses are rejected. CORS is same-origin only: browser frontends should be served from the Worker origin (or placed behind a same-origin proxy).

## API

`GET /?url=<encoded URL>` returns JSON:

```sh
curl 'http://localhost:8787/?url=https%3A%2F%2Fcdn.example%2Fvideo.mp4'
```

The successful envelope is `response.data` with `url`, `source`, `original`, optional `thumbnail`/`favicon`, and `alternates`. Invalid input is 400, an unresolved page 404, upstream errors 502, and timeouts 504.

Host-specific extraction is enabled by default. Disable it for one request and use only generic `<video>`, Open Graph, and JSON metadata extraction with `hostExtraction=false`:

```sh
curl 'http://localhost:8787/?url=https%3A%2F%2Fvidmoly.biz%2Fembed-ynhyvaz86ylw.html&hostExtraction=false'
```

If you already have an authorized session for the upstream page, you can explicitly forward a small set of request headers to the upstream fetch. This is opt-in and limited to `upstreamCookie`, `upstreamReferer`, and `upstreamOrigin`:

```sh
curl 'http://localhost:8787/?url=https%3A%2F%2Fvidmoly.biz%2Fembed-ynhyvaz86ylw.html&upstreamCookie=session%3Dabc&upstreamReferer=https%3A%2F%2Fvidmoly.biz%2Fembed-ynhyvaz86ylw.html&upstreamOrigin=https%3A%2F%2Fvidmoly.biz'
```

For `Vidmoly`, challenge pages that only expose Turnstile/interactive verification are treated as unavailable. The Worker does not synthesize bypass cookies or solve the challenge.

For exactly one validated media URL, use the explicit redirect format. This is the dependable mode for ffprobe (a compatible `ffprobe`/`libavformat` User-Agent is also recognized):

```sh
ffprobe 'https://YOUR-WORKER.workers.dev/?url=https%3A%2F%2Fcdn.example%2Fvideo.mp4&format=redirect'
curl -I 'http://localhost:8787/?url=https%3A%2F%2Fcdn.example%2Fvideo.mp4&format=redirect'
```

## MCP

`POST /mcp` implements the MCP JSON-RPC initialization, `tools/list`, and `tools/call` flow. The `resolve_video` tool requires `{ "url": "https://…" }`; optional Boolean `hostExtraction` defaults to `true` and skips host adapters when set to `false`. Optional `upstreamCookie`, `upstreamReferer`, and `upstreamOrigin` forward those exact upstream request headers for already authorized sessions.

```sh
curl -X POST http://localhost:8787/mcp -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Media Station X

Media Station X resolve actions expect a response object with `url` on success or `error` on failure. Configure an item action like this (URL-encode the target):

```json
{ "action": "video:resolve:https://YOUR-WORKER.workers.dev/interaction/resolve.html?url=https%3A%2F%2Fcdn.example%2Fvideo.mp4" }
```

The endpoint returns `{ "url": "…", "label": "…" }` when successful and `{ "error": "…" }` otherwise, consistent with the [MSX Resolve Action contract](https://msx.benzac.de/wiki/index.php?title=Resolve_Action). Append `hostExtraction=false` to skip host adapters, and the same `upstreamCookie`, `upstreamReferer`, and `upstreamOrigin` query parameters are available here as well.

## Sources and testing

Direct public MP4/HLS URLs and pages containing `<video src>`, `<source src>`, `og:video`, `twitter:player:stream`, bounded JSON player configuration, `og:image`/`twitter:image`, and favicon fields are supported. Host adapters cover City, DoodStream, F16PX, Fastream, Filelions, Filemoon, GUpload, LiveTV, LuluStream, MaxStream, MixDrop, Okru, SportsOnline, StreamHG, Streamtape, Streamwish, Supervideo, TurboVidPlay, UQload, Vavoo, VidFast, Vidmoly, Vidoza, VixCloud and VOE.

Manual smoke-test examples (availability can change): Vidmoly `https://vidmoly.biz/embed-ynhyvaz86ylw.html`, VOE `https://ellenpoliticalfollow.com/e/ddhl1ul2kwbv`, DoodStream `https://playmogo.com/e/4x5pl61mp2r7`, and Filemoon `https://bysezejataos.com/d/dl03r6je3iei`. Tests remain offline and mocked.

Tests use only local fixtures and mocks. Run `npm test`, `npm run lint`, and `npm run typecheck` before deployment.
