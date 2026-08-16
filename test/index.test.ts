import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const FAKE_DISCOVERY = JSON.stringify({
  issuer: "https://accounts.google.com",
  jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
});
const FAKE_CERTS = JSON.stringify({ keys: [{ kty: "RSA", kid: "fake-key" }] });

function run(path: string, search = "") {
  const request = new Request(`http://example.com${path}${search}`);
  const ctx = createExecutionContext();
  // The worker's fetch() only declares (request, env) — it never reads ctx —
  // but createExecutionContext/waitOnExecutionContext is still the standard
  // pattern so any future waitUntil() usage is exercised by these tests too.
  return { response: worker.fetch(request, env), ctx };
}

beforeEach(async () => {
  // Cache API and KV persist across tests within a worker instance —
  // start every test from a clean slate so tests don't depend on order.
  const cache = (caches as any).default;
  await cache.delete(new Request("http://example.com/.well-known/openid-configuration"));
  await cache.delete(new Request("http://example.com/oauth2/v3/certs"));
  await env.OAUTH_DISCOVERY_CACHE.delete("discovery-document");
  await env.OAUTH_DISCOVERY_CACHE.delete("jwks-certs");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discovery endpoint", () => {
  it("fetches from Google and rewrites jwks_uri to SELF_ORIGIN", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(FAKE_DISCOVERY, { status: 200 })),
    );

    const { response, ctx } = run("/.well-known/openid-configuration");
    const res = await response;
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { jwks_uri: string };
    expect(body.jwks_uri).toBe(`${env.SELF_ORIGIN}/oauth2/v3/certs`);
    expect(res.headers.get("Cache-Control")).toContain("max-age=86400");
  });

  it("serves the second request from cache without refetching", async () => {
    const fetchMock = vi.fn(async () => new Response(FAKE_DISCOVERY, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = run("/.well-known/openid-configuration");
    await first.response;
    await waitOnExecutionContext(first.ctx);

    const second = run("/.well-known/openid-configuration");
    const res2 = await second.response;
    await waitOnExecutionContext(second.ctx);

    expect(res2.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the KV last-known-good copy when the live fetch fails", async () => {
    await env.OAUTH_DISCOVERY_CACHE.put("discovery-document", FAKE_DISCOVERY);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );

    const { response, ctx } = run("/.well-known/openid-configuration");
    const res = await response;
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Served-From")).toBe("stale-kv-fallback");
    expect(await res.text()).toBe(FAKE_DISCOVERY);
  });

  it("returns 503 when the live fetch fails and there is no KV fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );

    const { response, ctx } = run("/.well-known/openid-configuration");
    const res = await response;
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(503);
  });
});

describe("certs endpoint", () => {
  it("proxies the certs response and caches it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(FAKE_CERTS, { status: 200 })),
    );

    const { response, ctx } = run("/oauth2/v3/certs");
    const res = await response;
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FAKE_CERTS);
    expect(res.headers.get("Cache-Control")).toContain("max-age=3600");
  });
});

describe("tokeninfo endpoint", () => {
  it("passes the query string through and is never cached", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("access_token=abc123");
      return new Response('{"aud":"abc123"}', { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { response, ctx } = run("/oauth2/v3/tokeninfo", "?access_token=abc123");
    const res = await response;
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A second identical request must hit the origin again — tokeninfo
    // responses are request-specific and must never be served from cache.
    const { response: response2 } = run("/oauth2/v3/tokeninfo", "?access_token=abc123");
    await response2;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("unknown paths", () => {
  it("returns 404", async () => {
    const { response, ctx } = run("/nonsense");
    const res = await response;
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Path received: /nonsense");
  });
});
