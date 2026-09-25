/** Offline unit tests for new sources + recent improvements (stubbed fetch, no network). */
import { describe, it, expect, beforeEach } from "vitest";
import {
  __setFetch,
  __resetFetch,
  __clearCache,
  validateCountryCode,
  normalizeRllLaunch,
  normalizeNewsItem,
  listRocketLaunchLiveUpcoming,
  listSpaceflightNews,
  listSpaceXLaunches,
  listLaunchLocations,
  listLaunchPads,
  listLaunchProviders,
} from "../src/service.js";

const RLL_FIXTURE = {
  valid_auth: false,
  count: 2,
  limit: 5,
  total: 5,
  result: [
    {
      id: 5080,
      name: "Owlright",
      provider: { id: 26, name: "Rocket Lab", slug: "rocket-lab" },
      vehicle: { id: 18, name: "Electron", slug: "electron" },
      pad: {
        id: 122,
        name: "LC-1B",
        location: { id: 20, name: "Rocket Lab Launch Complex, Mahia Peninsula", country: "New Zealand" },
      },
      t0: "2026-09-26T00:26Z",
      win_open: "2026-09-26T00:15Z",
      date_str: "Sep 26",
      launch_description: "Electron will launch Owlright.",
      slug: "strix-launch-13",
    },
    {
      id: 6215,
      name: "USSF-385",
      provider: { id: 1, name: "SpaceX", slug: "spacex" },
      vehicle: { id: 1, name: "Falcon 9", slug: "falcon-9" },
      pad: {
        id: 1,
        name: "SLC-4E",
        location: { id: 60, name: "Vandenberg SFB", country: "United States" },
      },
      t0: "2026-09-26T11:56Z",
      win_open: null,
      date_str: "Sep 26",
      launch_description: null,
      slug: "ussf-385",
    },
  ],
};

const SFN_FIXTURE = {
  count: 2,
  next: null,
  previous: null,
  results: [
    {
      id: 1,
      title: "Starship flies",
      url: "https://example.com/a",
      news_site: "Example",
      summary: "Flight test.",
      published_at: "2026-09-24T10:00:00Z",
    },
    {
      id: 2,
      title: "Artemis update",
      url: "https://example.com/b",
      news_site: "Example",
      summary: "Moon plans.",
      published_at: "2026-09-23T10:00:00Z",
    },
  ],
};

const SPACEX_QUERY_FIXTURE = {
  docs: [
    {
      id: "sx-1",
      name: "Starlink 10-1",
      date_utc: "2026-10-05T10:00:00.000Z",
      date_local: "2026-10-05T06:00:00-04:00",
      upcoming: true,
      success: null,
      flight_number: 400,
      details: "Starlink mission",
      launchpad: "pad-1",
      rocket: "rocket-1",
    },
  ],
  totalDocs: 42,
  limit: 10,
  page: 1,
};

function stubFetch(handler: (url: string, init?: { method?: string; body?: string }) => unknown) {
  __clearCache();
  __setFetch(async (url: string, init?: { method?: string; body?: string }) => ({
    ok: true,
    status: 200,
    json: async () => handler(url, init),
  }));
}

beforeEach(() => {
  __clearCache();
  __resetFetch();
});

describe("validateCountryCode", () => {
  it("normalizes and validates", () => {
    expect(validateCountryCode("usa")).toBe("USA");
    expect(validateCountryCode(" JPN ")).toBe("JPN");
    expect(() => validateCountryCode("US")).toThrow(/alpha-3/);
    expect(() => validateCountryCode("USAA")).toThrow(/alpha-3/);
    expect(() => validateCountryCode("12A")).toThrow(/alpha-3/);
  });
});

describe("offset pagination (LL2 catalogs)", () => {
  it("sends offset to the API and echoes it back", async () => {
    const seen: string[] = [];
    stubFetch((url: string) => {
      seen.push(url);
      return { count: 100, next: null, results: [] };
    });
    const locs = await listLaunchLocations({ offset: 20 });
    expect(locs.offset).toBe(20);
    expect(seen.some((u) => u.includes("offset=20"))).toBe(true);
    const pads = await listLaunchPads({ offset: 7 });
    expect(pads.offset).toBe(7);
    const provs = await listLaunchProviders({ offset: 3 });
    expect(provs.offset).toBe(3);
  });
});

describe("SpaceX query (server-side)", () => {
  it("POSTs to /launches/query with regex + sort + pagination", async () => {
    let captured: { url?: string; method?: string; body?: string } = {};
    stubFetch((url: string, init?: { method?: string; body?: string }) => {
      captured = { url, method: init?.method, body: init?.body };
      return SPACEX_QUERY_FIXTURE;
    });
    const r = await listSpaceXLaunches({ upcoming: true, search: "Starlink", limit: 5, offset: 10 });
    expect(captured.url).toMatch(/\/launches\/query$/);
    expect(captured.method).toBe("POST");
    const body = JSON.parse(captured.body ?? "{}") as {
      query: { upcoming: boolean; name: { $regex: string; $options: string } };
      options: { limit: number; offset: number; sort: Record<string, string> };
    };
    expect(body.query.upcoming).toBe(true);
    expect(body.query.name.$regex).toBe("Starlink");
    expect(body.query.name.$options).toBe("i");
    expect(body.options.limit).toBe(5);
    expect(body.options.offset).toBe(10);
    expect(body.options.sort).toEqual({ date_utc: "asc" });
    expect(r.count).toBe(42);
    expect(r.offset).toBe(10);
    expect(r.results[0].name).toBe("Starlink 10-1");
  });

  it("sorts past launches descending", async () => {
    let capturedBody = "";
    stubFetch((_url: string, init?: { method?: string; body?: string }) => {
      capturedBody = init?.body ?? "";
      return { docs: [], totalDocs: 0 };
    });
    await listSpaceXLaunches({ upcoming: false });
    expect(JSON.parse(capturedBody).options.sort).toEqual({ date_utc: "desc" });
  });
});

describe("RocketLaunch.Live", () => {
  it("slims an RLL row", () => {
    const l = normalizeRllLaunch(RLL_FIXTURE.result[0] as unknown as Record<string, unknown>);
    expect(l).toMatchObject({
      id: 5080,
      provider: "Rocket Lab",
      vehicle: "Electron",
      pad: "LC-1B",
      country: "New Zealand",
      t0: "2026-09-26T00:26Z",
    });
    expect(l.url).toBe("https://rocketlaunch.live/launch/strix-launch-13");
  });

  it("lists upcoming via the free endpoint", async () => {
    const seen: string[] = [];
    stubFetch((url: string) => {
      seen.push(url);
      return RLL_FIXTURE;
    });
    const r = await listRocketLaunchLiveUpcoming({ limit: 2 });
    expect(r.source).toBe("rocketlaunch.live");
    expect(r.results).toHaveLength(2);
    expect(r.results[0].provider).toBe("Rocket Lab");
    expect(seen.some((u) => u.includes("/json/launches/next/2"))).toBe(true);
  });

  it("caps the free tier at 5 and hints LL2 on outage", async () => {
    const seen: string[] = [];
    stubFetch((url: string) => {
      seen.push(url);
      return RLL_FIXTURE;
    });
    await listRocketLaunchLiveUpcoming({ limit: 100 });
    expect(seen.some((u) => u.includes("/next/5"))).toBe(true);
    __clearCache();
    __setFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(listRocketLaunchLiveUpcoming({})).rejects.toThrow(/list_upcoming_launches/);
  });
});

describe("Spaceflight News", () => {
  it("slims a news item", () => {
    const n = normalizeNewsItem(SFN_FIXTURE.results[0] as unknown as Record<string, unknown>);
    expect(n).toMatchObject({ id: 1, title: "Starship flies", newsSite: "Example" });
  });

  it("lists articles with search + pagination", async () => {
    const seen: string[] = [];
    stubFetch((url: string) => {
      seen.push(url);
      return SFN_FIXTURE;
    });
    const r = await listSpaceflightNews({ type: "article", search: "Starship", limit: 2, offset: 4 });
    expect(r.type).toBe("article");
    expect(r.count).toBe(2);
    expect(r.offset).toBe(4);
    expect(r.results[0].title).toBe("Starship flies");
    expect(seen.some((u) => u.includes("/articles/") && u.includes("search=Starship") && u.includes("offset=4"))).toBe(
      true,
    );
  });

  it("routes blog and report types", async () => {
    const seen: string[] = [];
    stubFetch((url: string) => {
      seen.push(url);
      return SFN_FIXTURE;
    });
    await listSpaceflightNews({ type: "blog" });
    await listSpaceflightNews({ type: "report" });
    expect(seen.some((u) => u.includes("/blogs/"))).toBe(true);
    expect(seen.some((u) => u.includes("/reports/"))).toBe(true);
  });
});
