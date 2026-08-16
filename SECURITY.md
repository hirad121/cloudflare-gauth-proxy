# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub's "Report a vulnerability"
button (Security tab → Advisories) rather than opening a public issue. If
that isn't available, open an issue with minimal detail asking for a private
contact channel.

## Scope

This Worker proxies only Google's public OIDC discovery document and JWKS
signing keys — no client secrets, tokens, or user data pass through its
caching layers except the `/tokeninfo` endpoint, which is proxied uncached
and untouched.

Things worth reporting:
- Cache poisoning (a way to make the proxy serve attacker-controlled content
  as if it were Google's).
- A way to make the KV fallback serve stale/wrong data past its intended
  window.
- Any path where request-specific data (e.g. `/tokeninfo` responses) could
  be cached or leaked across requests.

## Supported versions

This is a single-branch project (`main`); only the latest commit is
supported.
