# Urgent follow-up

- [ ] Provide current authorized example URLs for the 24 extractor providers and run the post-deployment live matrix; local tests currently confirm classification and MediaFlow URL construction, not third-party playback.
- [ ] Use an egress service that resolves and connects atomically if strict DNS-rebinding prevention is required; Cloudflare Workers cannot pin a DNS preflight result to the subsequent hostname fetch.
