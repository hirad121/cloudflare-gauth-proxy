export interface Env {
  OAUTH_DISCOVERY_CACHE: KVNamespace;
  // Public URL this Worker is deployed at (e.g. https://your-worker.your-subdomain.workers.dev
  // or a custom route). Used to rewrite jwks_uri in the discovery document so
  // clients fetch signing keys through this proxy instead of Google directly.
  SELF_ORIGIN: string;
}

// NextAuth (and most OIDC clients) abort outgoing requests after ~3-4s. This
// must stay comfortably below that so a cache-miss fetch fails fast enough to
// fall back to the KV copy instead of hanging until the client's own timeout
// fires.
const ORIGIN_FETCH_TIMEOUT_MS = 2500;

// Google rotates JWKS signing keys periodically but the discovery document
// itself is effectively static. These TTLs match that reality rather than
// caching everything for the same duration.
const DISCOVERY_CACHE_TTL_SECONDS = 24 * 60 * 60;
const CERTS_CACHE_TTL_SECONDS = 60 * 60;

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Serves `upstreamUrl` through two layers: the Cache API (fast, per-colo,
 * bounded by `cacheTtlSeconds`) and a KV-backed "last known good" copy that
 * has no expiry and is used whenever the live origin fetch fails or times
 * out — even if the Cache API entry has already expired. Google's OIDC
 * discovery document and signing keys change on the order of hours to
 * months, so serving a stale copy for a few extra minutes during an outage
 * is safe and strictly better than failing sign-in outright.
 */
async function proxyWithCache(
  env: Env,
  cacheKey: string,
  kvKey: string,
  cacheTtlSeconds: number,
  upstreamUrl: string,
  transformBody?: (body: string) => string,
): Promise<Response> {
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const cacheRequest = new Request(new URL(cacheKey, env.SELF_ORIGIN));

  const cached = await cache.match(cacheRequest);
  if (cached) {
    return cached;
  }

  try {
    const originResponse = await fetchWithTimeout(upstreamUrl, ORIGIN_FETCH_TIMEOUT_MS);
    if (!originResponse.ok) {
      throw new Error(`upstream responded with ${originResponse.status}`);
    }

    let body = await originResponse.text();
    if (transformBody) {
      body = transformBody(body);
    }

    const response = new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": `public, max-age=${cacheTtlSeconds}`,
      },
    });

    await cache.put(cacheRequest, response.clone());
    await env.OAUTH_DISCOVERY_CACHE.put(kvKey, body);

    return response;
  } catch (error) {
    const fallback = await env.OAUTH_DISCOVERY_CACHE.get(kvKey);
    if (fallback) {
      return new Response(fallback, {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
          "X-Served-From": "stale-kv-fallback",
        },
      });
    }
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.includes(".well-known/openid-configuration")) {
      try {
        return await proxyWithCache(
          env,
          "/.well-known/openid-configuration",
          "discovery-document",
          DISCOVERY_CACHE_TTL_SECONDS,
          "https://accounts.google.com/.well-known/openid-configuration",
          (body) => {
            const config = JSON.parse(body);
            config.jwks_uri = `${env.SELF_ORIGIN}/oauth2/v3/certs`;
            return JSON.stringify(config);
          },
        );
      } catch (error) {
        console.error("discovery_document_unavailable", error);
        return new Response("Google discovery document unavailable", { status: 503 });
      }
    }

    if (path.includes("certs")) {
      try {
        return await proxyWithCache(
          env,
          "/oauth2/v3/certs",
          "jwks-certs",
          CERTS_CACHE_TTL_SECONDS,
          "https://www.googleapis.com/oauth2/v3/certs",
        );
      } catch (error) {
        console.error("jwks_certs_unavailable", error);
        return new Response("Google signing keys unavailable", { status: 503 });
      }
    }

    // tokeninfo validates a specific caller-supplied token; the response is
    // request-specific and must never be cached.
    if (path.includes("tokeninfo")) {
      try {
        const googleUrl = `https://www.googleapis.com/oauth2/v3/tokeninfo${url.search}`;
        const response = await fetchWithTimeout(googleUrl, ORIGIN_FETCH_TIMEOUT_MS);
        const data = await response.text();
        return new Response(data, {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (error) {
        console.error("tokeninfo_unavailable", error);
        return new Response("Google tokeninfo unavailable", { status: 503 });
      }
    }

    return new Response(`Path received: ${path}`, { status: 404 });
  },
};
