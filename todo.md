# Urgent follow-up

- [ ] Close public TCP port 8888 on `147.224.146.137`; HTTPS, password enforcement, Forward, and HLS through `resolve.btc-mining.at` are live, but the origin health endpoint remains directly reachable on that port.
- [ ] Use an egress service that resolves and connects atomically if strict DNS-rebinding prevention is required; Cloudflare Workers cannot pin a DNS preflight result to the subsequent hostname fetch.
