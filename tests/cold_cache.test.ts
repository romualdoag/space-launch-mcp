/** Cold cache tests (SQLite :memory:, stubbed fetch, no network). */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  __setFetch,
  __resetFetch,
  __clearCache,
  listUpcomingLaunches,
  getLaunch,
  listLaunchLocations,
  listLaunchPads,
  listLaunchProviders,
} from "../src/service.js";
import {
  __resetColdCacheForTests,
  closeColdCache,
  kvGet,
  kvSet,
  isWindowInPast,
  isPastLaunch,
} from "../src/cache.js";

const PAST_LAUNCH = {
  id: "past-1",
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

const FUTURE_LAUNCH = {
  ...PAST_LAUNCH,
  id: "future-1",
  name: "Falcon 9 | Starlink Future",
  net: "2999-01-01T00:00:00Z",
  window_start: "2999-01-01T00:00:00Z",
  window_end: "2999-01-01T00:00:00Z",
};

const PAGE_FIXTURE = {
  count: 1,
  next: null,
  results: [PAST_LAUNCH],
};

function stubCount(handler: (url: string) => unknown): () => number {
  let calls = 0;
  __clearCache();
  __setFetch(async (url: string) => {
    calls++;
    return { ok: true, status: 200, json: async () => handler(url) };
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
  delete process.env.SPACE_LAUNCH_CACHE_ENABLED;
});

describe("kv frio", () => {
  it("roundtrip save/load e TTL expirado dá miss", () => {
    kvSet("k", { a: 1 });
    expect(kvGet("k", 720)).toEqual({ a: 1 });
    expect(kvGet("k", 0)).toBeUndefined();
    expect(kvGet("missing", 720)).toBeUndefined();
  });

  it("ENABLED=0 desliga o frio (fail-soft bypass)", () => {
    process.env.SPACE_LAUNCH_CACHE_ENABLED = "0";
    kvSet("k", { a: 1 });
    expect(kvGet("k", 720)).toBeUndefined();
  });
});

describe("isWindowInPast / isPastLaunch", () => {
  it("janela com lte no passado é passada; sem lte não", () => {
    expect(isWindowInPast({ windowStartLte: "2020-01-01" })).toBe(true);
    expect(isWindowInPast({ windowStartLte: "2999-01-01" })).toBe(false);
    expect(isWindowInPast({})).toBe(false);
  });

  it("launch com net passada é passado; futura não", () => {
    expect(isPastLaunch({ net: "2020-01-01T00:00:00Z" })).toBe(true);
    expect(isPastLaunch({ net: "2999-01-01T00:00:00Z" })).toBe(false);
    expect(isPastLaunch({})).toBe(false);
  });
});

describe("registry no frio (locations/pads/providers)", () => {
  it("2ª chamada serve do frio mesmo com quente limpo", async () => {
    const calls = stubCount((url: string) => {
      if (url.includes("/location/")) return { count: 1, next: null, results: [{ id: 12 }] };
      throw new Error(`unexpected ${url}`);
    });
    const first = await listLaunchLocations({ countryCode: "USA" });
    expect(calls()).toBe(1);
    __clearCache(); // quente limpo — frio tem que segurar
    const second = await listLaunchLocations({ countryCode: "USA" });
    expect(calls()).toBe(1);
    expect(second).toEqual(first);
  });

  it("pads e providers também ficam no frio", async () => {
    const calls = stubCount((url: string) => {
      if (url.includes("/pad/"))
        return { count: 1, next: null, results: [{ id: 87, location: { name: "Cape" } }] };
      if (url.includes("/agencies/"))
        return { count: 1, next: null, results: [{ id: 121, name: "SpaceX" }] };
      throw new Error(`unexpected ${url}`);
    });
    await listLaunchPads({ search: "Cape" });
    await listLaunchProviders({ search: "SpaceX" });
    expect(calls()).toBe(2);
    __clearCache();
    await listLaunchPads({ search: "Cape" });
    await listLaunchProviders({ search: "SpaceX" });
    expect(calls()).toBe(2);
  });

  it("resolve de country/provider usa o frio (upcoming com filtros, 2ª vez sem fetch)", async () => {
    const calls = stubCount((url: string) => {
      if (url.includes("/location/")) return { count: 1, next: null, results: [{ id: 12 }] };
      if (url.includes("/agencies/"))
        return { count: 1, next: null, results: [{ id: 121, name: "SpaceX" }] };
      if (url.includes("/launch/upcoming/")) return { count: 0, next: null, results: [] };
      throw new Error(`unexpected ${url}`);
    });
    await listUpcomingLaunches({ countryCode: "USA", providerName: "SpaceX" });
    const afterFirst = calls();
    expect(afterFirst).toBe(3);
    __clearCache();
    await listUpcomingLaunches({ countryCode: "USA", providerName: "SpaceX" });
    // resolve sai do frio; só o /launch (quente 60s, limpo) refaz fetch
    expect(calls()).toBe(afterFirst + 1);
  });
});

describe("launch detail passado no frio", () => {
  it("detail passado: 2ª chamada 0 fetch; upcoming nunca vai pro frio", async () => {
    const calls = stubCount((url: string) => {
      if (url.includes("/launch/past-1/")) return PAST_LAUNCH;
      if (url.includes("/launch/future-1/")) return FUTURE_LAUNCH;
      throw new Error(`unexpected ${url}`);
    });
    const past = await getLaunch("past-1");
    expect(past.provider).toBe("SpaceX");
    expect(calls()).toBe(1);
    __clearCache();
    await getLaunch("past-1");
    expect(calls()).toBe(1); // frio 30d segurou

    await getLaunch("future-1");
    expect(calls()).toBe(2);
    __clearCache();
    await getLaunch("future-1");
    expect(calls()).toBe(3); // upcoming não congela no frio
  });
});

describe("listagem com janela passada: frio infinito", () => {
  it("previous com lte passado: 2ª chamada 0 fetch; upcoming sem janela refaz", async () => {
    const calls = stubCount(() => PAGE_FIXTURE);
    const first = await listUpcomingLaunches({ mode: "previous", windowStartLte: "2020-12-31" });
    expect(first.count).toBe(1);
    expect(calls()).toBe(1);
    __clearCache();
    const second = await listUpcomingLaunches({ mode: "previous", windowStartLte: "2020-12-31" });
    expect(calls()).toBe(1);
    expect(second).toEqual(first);

    await listUpcomingLaunches({ limit: 5 });
    expect(calls()).toBe(2);
    __clearCache();
    await listUpcomingLaunches({ limit: 5 });
    expect(calls()).toBe(3); // upcoming/recente só no quente
  });
});
