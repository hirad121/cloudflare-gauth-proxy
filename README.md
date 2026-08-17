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

## Quickstart (5 minutes, no prior Workers experience needed)

A Cloudflare Worker is just a small script Cloudflare runs on its edge
network instead of on your own server. This whole thing is free — no credit
card required for the Workers/KV usage this project needs.

```bash
git clone https://github.com/hirad121/cloudflare-gauth-proxy
cd cloudflare-gauth-proxy
npm install
npx wrangler login          # opens your browser, log in / sign up free
npx wrangler kv namespace create OAUTH_DISCOVERY_CACHE
```

That last command prints an `id`. Copy `wrangler.jsonc.example` to
`wrangler.jsonc`, paste that `id` into `kv_namespaces[0].id`, then run:

```bash
npx wrangler deploy
```

It prints your live URL, something like
`https://cloudflare-gauth-proxy.<you>.workers.dev`. Open
`<that-url>/.well-known/openid-configuration` in a browser — if you see
JSON with a `jwks_uri` field pointing back at your own URL, it's working.

One more step: paste that same URL into `wrangler.jsonc`'s `vars.SELF_ORIGIN`
and run `npx wrangler deploy` once more — this is what makes the `jwks_uri`
rewrite point at the right place. (The full [Setup](#setup) section below
explains why this is two steps.)

That's the whole thing deployed. The rest of this README covers *using* it
(pointing your app at it) and the *why* behind its design.

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

Config reference (see [Quickstart](#quickstart-5-minutes-no-prior-workers-experience-needed)
for the step-by-step walkthrough) — `wrangler.jsonc` (copied from
`wrangler.jsonc.example`) needs:

- `kv_namespaces[0].id` — printed by `npx wrangler kv namespace create OAUTH_DISCOVERY_CACHE`
- `vars.SELF_ORIGIN` — the URL this Worker is deployed at
  (`https://<worker-name>.<your-subdomain>.workers.dev`, or your custom route)

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
  read it before changing `src/index.ts` (see [Testing](#testing) for what
  it covers).
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

## Verified, not just claimed

Before publishing, this was actually run — not just written and assumed to
work:

- **Real deploy, real Cloudflare account, real Google endpoints.** A
  throwaway Worker + KV namespace were deployed live, hit with real HTTP
  requests, and confirmed: correct `jwks_uri` rewrite, correct cache
  headers, real Google signing keys returned, 404s on unknown paths. Both
  torn down afterward — nothing about them is in this repo.
- **The KV fallback path was proven against a real failure, not a
  simulated one** — during development, Google itself temporarily blocked
  the test environment's IP (an ordinary real-world failure this proxy
  exists to survive), and the fallback served the last-known-good copy
  correctly, with `X-Served-From: stale-kv-fallback`, exactly as designed.
- **What wasn't re-proven on the live deploy**: forcing the fallback path
  a second time on that same instance — Cloudflare's Cache API correctly
  served the still-valid cached response instead, so the deliberately-broken
  upstream was never reached. Not a gap; the fallback logic itself is
  separately covered by the automated test suite below.
- **The full automated test suite** (`npm test`) exercises every branch in
  the real Workers runtime and is what CI runs on every push.

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

## Roadmap / where to contribute

Being upfront about what this repo doesn't have yet, ranked by how
self-contained the work is:

**Good first issues** (no design decisions needed, clear done-condition):
- **A `/healthz` endpoint** reporting whether the last origin fetch to
  Google succeeded and how old the KV fallback copy is — useful for anyone
  running this in front of real traffic who wants an uptime check that
  isn't just "does the Worker respond."
- **Structured logging** — `console.error` calls currently log a string and
  an `Error` object; switching to a consistent JSON shape would make this
  pluggable into Cloudflare Logpush / any log pipeline without a
  regex-scrape step.
- **A CONTRIBUTING checklist item enforcing `npm run typecheck && npm test`
  as a git pre-commit hook** (husky or similar) — right now this is only
  enforced in CI, so a local commit can still land red.

**Real design work, needs a proposal/issue first**:
- **Rate limiting.** Currently relies entirely on Cloudflare's
  platform-level DDoS protection — there's no request-count-per-IP guard in
  the Worker itself. Whether that's actually needed for a public-metadata
  proxy like this (vs. adding complexity for no real benefit) is exactly
  the kind of judgment call that should be argued out in an issue before
  code, not decided unilaterally in a PR.
- **A real-deploy smoke test in CI.** Right now CI only runs the local
  Miniflare suite — an actual `wrangler deploy` to a scratch Worker,
  live-endpoint check, then teardown, gated on `workflow_dispatch` or a
  label, would close the gap this README's own
  [Verified](#verified-not-just-claimed) section is honest about.
- **Generalizing beyond Google.** The two-layer cache + fallback pattern
  here isn't Google-specific — the same shape would work for any OIDC
  provider's discovery document (Microsoft Entra, Auth0, Okta...). Worth
  discussing whether that's a config option on this repo or a genuinely
  separate one before anyone invests the work.

**Want to contribute something not listed here?** Open an issue proposing
it first, especially for anything touching `src/index.ts`'s core request
handling — this repo is small on purpose, and staying small is part of
what makes it trustworthy to run in front of a real login flow. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).

## Author

[@hirad121](https://github.com/hirad121)
