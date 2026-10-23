/** Cache-key hardening tests (SQLite :memory:, stubbed fetch, no network). */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  __setFetch,
  __resetFetch,
  __clearCache,
  __fetchJsonForTests,
  canonicalUrl,
  buildHotCacheKey,
  getLaunch,
} from "../src/service.js";
import {
  __resetColdCacheForTests,
  __kvSeedForTests,
  closeColdCache,
  kvGet,
  kvGetWithMeta,
  kvSet,
  coldKey,
  legacyColdKey,
  contentHashOf,
} from "../src/cache.js";

const DAY_MS = 24 * 3_600_000;

const PAST_SLIM = {
  id: "past-9",
  name: "Falcon 9 | Starlink Past",
  net: "2020-05-30T19:22:00Z",
  windowStart: "2020-05-30T19:22:00Z",
  windowEnd: "2020-05-30T19:22:00Z",
  status: "Success",
  provider: "SpaceX",
  rocket: "Falcon 9",
  mission: "Starlink",
  orbit: "LEO",
  pad: "SLC-40",
  location: "Cape Canaveral",
  countryCode: "USA",
};

const PAST_RAW = {
  id: "past-9",
  name: "Falcon 9 | Starlink Past",
  net: "2020-05-30T19:22:00Z",
  window_start: "2020-05-30T19:22:00Z",
  window_end: "2020-05-30T19:22:00Z",
  status: { abbrev: "Success", name: "Launch Successful" },
  launch_service_provider: { name: "SpaceX" },
  rocket: { configuration: { full_name: "Falcon 9" } },
  mission: { name: "Starlink", orbit: { abbrev: "LEO" } },
  pad: { name: "SLC-40", location: { name: "Cape Canaveral", country_code: "USA" } },
};

function stubFetch(handler: (url: string, init?: any) => unknown): () => number {
  let calls = 0;
  __clearCache();
  __setFetch(async (url: string, init?: any) => {
    calls++;
    return handler(url, init) as any;
  });
  return () => calls;
}

beforeEach(() => {
  __resetColdCacheForTests(":memory:");
  __clearCache();
});

afterEach(() => {
  __resetFetch();
  closeColdCache();
});

describe("canonicalUrl", () => {
  it("ordena query params; host case-insensitive; sem trailing slash", () => {
    const a = canonicalUrl("https://LL.THESPACEEVS.com/2.2.0/location/?limit=100&country_code=USA");
    const b = canonicalUrl("https://ll.thespaceevs.com/2.2.0/location?country_code=USA&limit=100");
    expect(a).toBe(b);
    expect(a).toBe("https://ll.thespaceevs.com/2.2.0/location?country_code=USA&limit=100");
  });

  it("ordena valores de chaves repetidas e descarta fragmento/porta default", () => {
    const a = canonicalUrl("https://x.com:443/a?k=2&k=1#frag");
    expect(a).toBe("https://x.com/a?k=1&k=2");
  });

  it("preserva case do path e cai pro input aparado se não for URL", () => {
    expect(canonicalUrl("https://X.COM/Launch/ABC/")).toBe("https://x.com/Launch/ABC");
    expect(canonicalUrl("  not-a-url  ")).toBe("not-a-url");
  });
});

describe("buildHotCacheKey", () => {
  it("método case-insensitive; corpo diferencia; URLs equivalentes colapsam", () => {
    const base = "https://ll.thespacedevs.com/2.2.0/location?country_code=USA&limit=100";
    expect(buildHotCacheKey(base, "get")).toBe(buildHotCacheKey(base, "GET"));
    expect(buildHotCacheKey(base)).toBe(buildHotCacheKey(base, "GET"));
    expect(buildHotCacheKey(base, "GET", '{"a":1}')).not.toBe(buildHotCacheKey(base, "GET", '{"a":2}'));
    expect(
      buildHotCacheKey("https://LL.THESPACEEVS.com/2.2.0/location/?limit=100&country_code=USA", "get"),
    ).toBe(buildHotCacheKey("https://ll.thespaceevs.com/2.2.0/location?country_code=USA&limit=100", "GET"));
  });
});

describe("quente canônico (fetchJson)", () => {
  it("URLs equivalentes (ordem/case/slash) dão 1 fetch; corpo distinto dá 2", async () => {
    const calls = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: 1 }) }));
    const ttl = 60_000;
    await __fetchJsonForTests("https://LL.THESPACEEVS.com/2.2.0/location/?limit=100&country_code=USA", "t", ttl);
    await __fetchJsonForTests("https://ll.thespaceevs.com/2.2.0/location?country_code=USA&limit=100", "t", ttl);
    await __fetchJsonForTests(
      "https://ll.thespaceevs.com/2.2.0/location?country_code=USA&limit=100",
      "t",
      ttl,
      { method: "get" },
    );
    expect(calls()).toBe(1);
    await __fetchJsonForTests("https://api.spacexdata.com/v5/launches/query", "sx", ttl, {
      method: "POST",
      body: '{"a":1}',
    });
    await __fetchJsonForTests("https://api.spacexdata.com/v5/launches/query", "sx", ttl, {
      method: "POST",
      body: '{"a":2}',
    });
    expect(calls()).toBe(3);
  });
});

describe("frio v1 com fallback legado", () => {
  it("escritas vão pra v1; leitura cai pra legada quando v1 falta", () => {
    expect(coldKey("launch:1")).toBe("v1:launch:1");
    expect(coldKey("v1:launch:1")).toBe("v1:launch:1");
    expect(legacyColdKey("v1:launch:1")).toBe("launch:1");
    kvSet("k", { a: 1 });
    const meta = kvGetWithMeta("k");
    expect(meta?.legacy).toBe(false);
    expect(kvGet("k", 720)).toEqual({ a: 1 });
  });

  it("linha legada (pré-v1) continua legível", () => {
    __kvSeedForTests("launch:old-1", PAST_SLIM, { legacy: true });
    const meta = kvGetWithMeta("launch:old-1");
    expect(meta?.legacy).toBe(true);
    expect(kvGet("launch:old-1", 720)).toEqual(PAST_SLIM);
  });

  it("getLaunch serve legado sem fetch e migra pra v1", async () => {
    __kvSeedForTests("launch:past-9", PAST_SLIM, { legacy: true });
    const calls = stubFetch(async () => {
      throw new Error("must not fetch");
    });
    const got = await getLaunch("past-9");
    expect(got).toEqual(PAST_SLIM);
    expect(calls()).toBe(0);
    expect(kvGetWithMeta("launch:past-9")?.legacy).toBe(false);
  });
});

describe("content-hash leve", () => {
  it("gravado no frio; estável pro mesmo dado, muda com o dado", async () => {
    stubFetch(async () => ({ ok: true, status: 200, headers: {}, json: async () => PAST_RAW }));
    await getLaunch("past-9");
    const meta = kvGetWithMeta("launch:past-9");
    expect(typeof meta?.contentHash).toBe("string");
    expect(meta?.contentHash).toHaveLength(8);
    expect(contentHashOf(JSON.stringify(PAST_SLIM))).toBe(meta?.contentHash);
    expect(contentHashOf(JSON.stringify({ ...PAST_SLIM, name: "Other" }))).not.toBe(meta?.contentHash);
  });
});

describe("revalidação ocasional do detalhe passado (idade >30d)", () => {
  it("304 com ETag mantém cache: 1 condicional, depois 0 fetch", async () => {
    __kvSeedForTests("launch:past-9", PAST_SLIM, { ageMs: 31 * DAY_MS, etag: '"abc123"' });
    let seenHeaders: Record<string, string> | undefined;
    const calls = stubFetch(async (_url: string, init?: any) => {
      seenHeaders = init?.headers as Record<string, string>;
      return { ok: false, status: 304, headers: {}, json: async () => ({}) };
    });
    const got = await getLaunch("past-9");
    expect(got).toEqual(PAST_SLIM);
    expect(calls()).toBe(1);
    expect(seenHeaders?.["if-none-match"]).toBe('"abc123"');
    // touch pós-304 → fresca de novo: 2ª chamada sem rede
    await getLaunch("past-9");
    expect(calls()).toBe(1);
  });

  it("If-Modified-Since quando só há last-modified", async () => {
    __kvSeedForTests("launch:past-9", PAST_SLIM, {
      ageMs: 31 * DAY_MS,
      lastModified: "Wed, 21 Oct 2020 07:28:00 GMT",
    });
    let seenHeaders: Record<string, string> | undefined;
    stubFetch(async (_url: string, init?: any) => {
      seenHeaders = init?.headers as Record<string, string>;
      return { ok: false, status: 304, headers: {}, json: async () => ({}) };
    });
    await getLaunch("past-9");
    expect(seenHeaders?.["if-modified-since"]).toBe("Wed, 21 Oct 2020 07:28:00 GMT");
    expect(seenHeaders?.["if-none-match"]).toBeUndefined();
  });

  it("sem validadores: TTL estendido sem rede", async () => {
    __kvSeedForTests("launch:past-9", PAST_SLIM, { ageMs: 31 * DAY_MS });
    const calls = stubFetch(async () => {
      throw new Error("must not fetch");
    });
    const got = await getLaunch("past-9");
    expect(got).toEqual(PAST_SLIM);
    expect(calls()).toBe(0);
    // idade renovada: próxima chamada também sem rede
    await getLaunch("past-9");
    expect(calls()).toBe(0);
  });

  it("200 com dado corrigido atualiza o cache", async () => {
    __kvSeedForTests("launch:past-9", PAST_SLIM, { ageMs: 31 * DAY_MS, etag: '"old"' });
    const changed = { ...PAST_RAW, name: "Falcon 9 | Starlink Past (corrigido)" };
    const calls = stubFetch(async () => ({
      ok: true,
      status: 200,
      headers: { etag: '"new"' },
      json: async () => changed,
    }));
    const got = await getLaunch("past-9");
    expect(got.name).toBe("Falcon 9 | Starlink Past (corrigido)");
    expect(calls()).toBe(1);
    const meta = kvGetWithMeta("launch:past-9");
    expect(meta?.etag).toBe('"new"');
    expect(meta?.value).toMatchObject({ name: "Falcon 9 | Starlink Past (corrigido)" });
  });

  it("falha de rede: fail-soft serve o stale sem lançar", async () => {
    __kvSeedForTests("launch:past-9", PAST_SLIM, { ageMs: 31 * DAY_MS, etag: '"abc123"' });
    const calls = stubFetch(async () => {
      throw new Error("boom upstream");
    });
    const got = await getLaunch("past-9");
    expect(got).toEqual(PAST_SLIM);
    expect(calls()).toBe(1);
  });

  it("velho além da janela stale: refetch integral", async () => {
    __kvSeedForTests("launch:past-9", PAST_SLIM, { ageMs: 61 * DAY_MS, etag: '"old"' });
    const calls = stubFetch(async () => ({
      ok: true,
      status: 200,
      headers: { etag: '"new2"' },
      json: async () => PAST_RAW,
    }));
    const got = await getLaunch("past-9");
    expect(got).toEqual(PAST_SLIM);
    expect(calls()).toBe(1);
  });
});
