# cf-stream-resolve

A Cloudflare Worker that resolves **public, non-DRM MP4 and HLS** streams from direct URLs or conservative HTML metadata. It is intended for a browser/WebUI, MCP clients, Media Station X, and direct playback tools.

It does not bypass logins, paywalls, age gates, geography, DRM, anti-bot protections, or any access control. Pornhub and AniWorld URLs are explicitly reported as unsupported. A URL that cannot be resolved safely returns a structured error instead of scraping around a protection.

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

The Worker has no required secrets. Its upstream limit is 8 seconds and 1 MB of HTML/JSON per response; redirects are manually followed up to three hops and each target is revalidated. Only HTTP(S), public routable URLs with no credentials are accepted. Private, loopback, link-local, ULA, CGNAT, and cloud-metadata addresses are rejected.

## API

`GET /?url=<encoded URL>` returns JSON:

```sh
curl 'http://localhost:8787/?url=https%3A%2F%2Fcdn.example%2Fvideo.mp4'
```

The successful envelope is `response.data` with `url`, `source`, `original`, optional `thumbnail`/`favicon`, and `alternates`. Invalid input is 400, an unresolved page 404, unsupported/protected sources 422, upstream errors 502, and timeouts 504.

For exactly one validated media URL, use the explicit redirect format. This is the dependable mode for ffprobe (a compatible `ffprobe`/`libavformat` User-Agent is also recognized):

```sh
ffprobe 'https://YOUR-WORKER.workers.dev/?url=https%3A%2F%2Fcdn.example%2Fvideo.mp4&format=redirect'
curl -I 'http://localhost:8787/?url=https%3A%2F%2Fcdn.example%2Fvideo.mp4&format=redirect'
```

## MCP

`POST /mcp` implements the MCP JSON-RPC initialization, `tools/list`, and `tools/call` flow. The `resolve_video` tool requires `{ "url": "https://…" }`; it accepts optional `format` and `includeAssets` fields for forward compatibility.

```sh
curl -X POST http://localhost:8787/mcp -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Media Station X

Media Station X resolve actions expect a response object with `url` on success or `error` on failure. Configure an item action like this (URL-encode the target):

```json
{ "action": "video:resolve:https://YOUR-WORKER.workers.dev/interaction/resolve.html?url=https%3A%2F%2Fcdn.example%2Fvideo.mp4" }
```

The endpoint returns `{ "url": "…", "label": "…" }` when successful and `{ "error": "…" }` otherwise, consistent with the [MSX Resolve Action contract](https://msx.benzac.de/wiki/index.php?title=Resolve_Action).

## Sources and testing

Direct public MP4/HLS URLs and pages containing `<video src>`, `<source src>`, `og:video`, `twitter:player:stream`, `og:image`/`twitter:image`, and favicon fields are supported. ARD, Arte, 3sat, Phoenix and ServusTV pages may resolve only when they expose such public, unprotected metadata; current availability changes. The URLs mentioned in the task may therefore resolve, be unsupported, or be unavailable without attempting any bypass.

Tests use only local fixtures and mocks. Run `npm test`, `npm run lint`, and `npm run typecheck` before deployment.
