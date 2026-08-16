# cloudflare-gauth-proxy

Edge-cached proxy for Google's OpenID Connect discovery document and JWKS
signing keys, deployed as a Cloudflare Worker.

## Problem it solves

OIDC clients (NextAuth, Auth.js, Passport, etc.) hit Google directly on every
cold start:

- `GET https://accounts.google.com/.well-known/openid-configuration`
- `GET https://www.googleapis.com/oauth2/v3/certs`

That's an extra cross-region round trip sitting on your login's critical
path, and most OIDC clients set an aggressive timeout (NextAuth: ~3.5s) — a
slow or briefly-down Google endpoint fails sign-in outright, even though
nothing about your app is broken.

This Worker sits in front of both endpoints, at the edge, and:

- Serves from Cloudflare's Cache API first — sub-millisecond, per-colo.
- Falls back to a KV-stored "last known good" copy with **no expiry** if the
  live fetch to Google fails or times out, so a transient Google outage
  doesn't take your login flow down with it.
- Rewrites `jwks_uri` in the discovery document to point back through this
  proxy, so both endpoints stay cached consistently under one origin.
- Proxies `/tokeninfo` straight through, uncached, since that response is
  specific to the caller's token.

Net effect: faster, more resilient OIDC sign-in for any app using Google as
an identity provider, with no code changes beyond pointing the discovery URL
at your Worker.

## Where this came from

Extracted from a production Next.js + FastAPI app that had run an uncached
version of this exact proxy, unversioned, for months. It caused a real
incident: users saw *"Google returned successfully, but we could not
complete sign-in"* on ~1 in 20 sign-ins. Sentry traced it to NextAuth's
internal fetch aborting after 3500ms while this Worker did a fully live,
uncached `fetch()` to Google on every single request — Google's own response
time, with zero margin against that budget.

The fix is the two-layer caching this repo now ships with (Cache API +
KV fallback), plus bounding the origin fetch itself to 2500ms
(`ORIGIN_FETCH_TIMEOUT_MS`) so a cache-miss-plus-slow-Google scenario fails
fast into the KV fallback instead of hanging until NextAuth's own timeout
fires. If you're proxying anything in front of a client with a fixed
timeout budget, keep your own origin-fetch timeout comfortably under it —
that margin is what turns "Google is slow" into "served a two-day-old
cached copy" instead of "sign-in failed."

## Architecture

```
Client (NextAuth / your OIDC lib)
        │
        ▼
 cloudflare-gauth-proxy (Worker, runs at the edge)
        │
        ├─ Cache API hit? ──────────────► return cached response
        │
        ├─ Cache miss → fetch Google (2.5s timeout)
        │       │
        │       ├─ success → cache in Cache API + KV, return
        │       │
        │       └─ fail/timeout → serve last-known-good copy from KV
        │                          (X-Served-From: stale-kv-fallback)
        │
        ▼
 accounts.google.com / googleapis.com  (only hit on cache miss)
```

Two caching layers, deliberately different lifetimes:
- **Cache API** — bounded TTL (24h discovery / 1h certs), fast, edge-local.
- **KV** — unbounded, used only as a fallback when the live fetch fails.
  Google's discovery document and signing keys change on the order of hours
  to months, so serving a slightly stale copy during an outage is safe and
  strictly better than failing sign-in.

## Requirements

- Node.js 18+
- A Cloudflare account (Workers + KV, both on the free tier)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (installed via `npm install`, no global install needed)

## Setup

```bash
npm install

# Create the KV namespace this Worker reads/writes its fallback cache to
npx wrangler kv namespace create OAUTH_DISCOVERY_CACHE
```

Copy `wrangler.jsonc.example` to `wrangler.jsonc` and fill in:

- `kv_namespaces[0].id` — the id printed by the command above
- `vars.SELF_ORIGIN` — the URL this Worker will be deployed at (you'll know
  this before first deploy: `https://<worker-name>.<your-subdomain>.workers.dev`,
  or your custom route if you attach one)

`wrangler.jsonc` is gitignored on purpose — it's your deployment config, not
example code. See [Security](#security) for why.

### Deploying via GitHub Actions instead

`.github/workflows/deploy.yml` (manual trigger) deploys for you — it writes
`wrangler.jsonc` at CI time from two repo variables instead of reading a
gitignored file, so nothing account-specific needs to be committed:

- Repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- Repo variables: `CF_KV_NAMESPACE_ID`, `CF_SELF_ORIGIN`

`.github/workflows/ci.yml` runs a typecheck on every push/PR — no Cloudflare
credentials needed for that one.

## Run it

```bash
npm run dev      # local dev server via Wrangler
npm run deploy   # ships to Cloudflare
```

## Use it

Point your OIDC client's discovery/issuer config at this Worker instead of
Google directly:

```js
// NextAuth example
GoogleProvider({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  wellKnown: "https://<your-worker>.workers.dev/.well-known/openid-configuration",
})
```

Everything else about your Google OAuth setup (client ID, client secret,
consent screen, redirect URIs) is unchanged — this only replaces where the
discovery document and signing keys are fetched from.

## Endpoints

| Path | Cache | Upstream |
|---|---|---|
| `/.well-known/openid-configuration` | 24h edge + KV fallback | `accounts.google.com` |
| `/oauth2/v3/certs` | 1h edge + KV fallback | `googleapis.com` |
| `/oauth2/v3/tokeninfo` | never (request-specific) | `googleapis.com` |

## Security

- This Worker holds no secrets — it proxies only Google's *public* OIDC
  metadata and signing keys, nothing tied to a specific client ID or user.
- `SELF_ORIGIN` is a public URL, not a secret — kept out of source so the
  repo isn't tied to any one deployment, but it's fine to commit if you fork
  this for your own project.
- `wrangler.jsonc` is gitignored because it holds *your* KV namespace id
  (an account-specific resource identifier, not a credential, but no reason
  to publish it either). `wrangler.jsonc.example` is the template.
- All proxied responses set `Access-Control-Allow-Origin: *` — this mirrors
  Google's own CORS policy on these specific endpoints (they're public
  metadata, meant to be fetched cross-origin by any OIDC client). Do not
  reuse this pattern for endpoints that return user- or client-specific
  data.
- Report a vulnerability: see [SECURITY.md](SECURITY.md).

## For agents / automated contributors

- `src/index.ts` is the entire runtime — one file, no hidden state, no build
  step beyond `tsc`/`wrangler`'s bundling.
- `Env` (top of `src/index.ts`) is the full contract with the outside world:
  one KV binding, one string var. Nothing else this Worker touches.
- `test/index.test.ts` is the executable spec of this Worker's behavior —
  read it before changing `src/index.ts`; it covers every branch
  (cache-hit, cache-miss, KV-fallback, no-fallback-503, tokeninfo passthrough,
  404) via `@cloudflare/vitest-pool-workers` (real Workers runtime, not a
  Node.js approximation).
- Before proposing a change, run `npm run typecheck && npm test` — CI
  (`.github/workflows/ci.yml`) runs both on every push/PR.
- Don't add dependencies for something the Workers runtime already provides
  (`fetch`, `caches`, `AbortController` are all global, no imports needed).

## Testing

```bash
npm test
```

Runs against the real Workers runtime (Miniflare, via
`@cloudflare/vitest-pool-workers`) — not a Node.js approximation of it.
Covers: discovery-document fetch + `jwks_uri` rewrite, cache-hit path (no
refetch), the KV stale-fallback path, the no-fallback 503 path, certs
proxying, `tokeninfo`'s uncached passthrough, and unknown-path 404s.
`wrangler.test.jsonc` (a separate, committed config — see [Gotchas](#gotchas))
holds the fake KV id and origin the test suite runs against.

## Gotchas

- **`wrangler.test.jsonc` (test-only config) is committed; `wrangler.jsonc`
  (your real deploy config) is not.** The test one holds fake values
  (`test-kv-namespace`, `http://example.com`) that exist only inside
  Miniflare during `npm test` — nothing real is ever reachable through them.
- **`@cloudflare/workers-types` must track the same major line `wrangler`
  peer-requires.** A stale `node_modules` will silently tolerate a mismatch
  between them — only a clean `rm -rf node_modules && npm install` surfaces
  it, as a hard `ELSPROBLEMS` failure. If you bump `wrangler`, check this
  package's version too; nothing keeps them in sync automatically.
- **The Cache API is per-colo, not global.** A cache write in one Cloudflare
  datacenter doesn't warm any other — expect the first request from each
  region to hit Google (or KV) once before that region's cache is warm. This
  is normal, not a bug.
- **Local dev (`wrangler dev`) uses a local KV emulation**, not your real
  namespace, unless you pass `--remote`. Don't be surprised if a value you
  put in production KV isn't visible locally.

## Missing / next steps

Being upfront about what this repo doesn't have yet:

- No rate limiting on the proxy itself (relies on Cloudflare's platform-level
  protections).
- No real-deploy smoke test in CI (only the local Miniflare test suite +
  typecheck run automatically; an actual `wrangler deploy` + live-endpoint
  check is still manual).

Issues and PRs welcome for either.

## License

MIT — see [LICENSE](LICENSE).
