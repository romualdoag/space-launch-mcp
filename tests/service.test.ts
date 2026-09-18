/** Offline unit tests for space-launch-mcp (stubbed fetch, no network). */
import { describe, it, expect, beforeEach } from "vitest";
import {
  __setFetch,
  __resetFetch,
  __clearCache,
  buildLaunchParams,
  clampLimit,
  clampOffset,
  assertValidWindow,
  normalizeLaunch,
  normalizeLocation,
  normalizePad,
  normalizeProvider,
  pickProvider,
  normalizeSpaceXLaunch,
  listUpcomingLaunches,
  getLaunch,
  listLaunchLocations,
  listLaunchPads,
  listLaunchProviders,
  listSpaceXLaunches,
  getSpaceXLaunch,
} from "../src/service.js";

const LAUNCH_FIXTURE = {
  count: 2,
  next: null,
  results: [
    {
      id: "f4c720ce-0cfd-43e6-b8dd-00273073bc01",
      slug: "electron-owl-by-the-dozen",
      name: "Electron | Owl By The Dozen",
      net: "2026-09-19T03:15:00Z",
      window_start: "2026-09-19T03:15:00Z",
      window_end: "2026-09-19T03:15:00Z",
      status: { abbrev: "Go", name: "Go for Launch" },
      launch_service_provider: { id: 147, name: "Rocket Lab", type: "Commercial" },
      rocket: { configuration: { full_name: "Electron", name: "Electron" } },
      mission: { name: "Owl By The Dozen", orbit: { abbrev: "LEO", name: "Low Earth Orbit" } },
      pad: {
        id: 99,
        name: "Rocket Lab Launch Complex 1A",
        country_code: "NZL",
        location: { id: 10, name: "Onenui Station, Mahia Peninsula, New Zealand", country_code: "NZL" },
      },
    },
    {
      id: "starlink-1",
      name: "Falcon 9 | Starlink Group 1",
      net: "2026-10-02T12:00:00Z",
      window_start: "2026-10-02T12:00:00Z",
      window_end: "2026-10-02T16:00:00Z",
      status: { abbrev: "TBD", name: "To Be Determined" },
      launch_service_provider: { id: 121, name: "SpaceX", type: "Commercial" },
      rocket: { configuration: { full_name: "Falcon 9", name: "Falcon 9" } },
      mission: { name: "Starlink Group 1", orbit: { abbrev: "LEO", name: "Low Earth Orbit" } },
      pad: {
        id: 87,
        name: "Space Launch Complex 40",
        country_code: "USA",
        location: { id: 12, name: "Cape Canaveral SFS, FL, USA", country_code: "USA" },
      },
    },
  ],
};

const LOCATION_FIXTURE = {
  count: 1,
  next: null,
  results: [
    {
      id: 12,
      name: "Cape Canaveral SFS, FL, USA",
      country_code: "USA",
      timezone_name: "America/New_York",
      total_launch_count: 1129,
    },
  ],
};

const AGENCY_FIXTURE = {
  count: 1,
  next: null,
  results: [{ id: 121, name: "SpaceX", abbrev: "SpX", type: "Commercial", country_code: "USA" }],
};

const PAD_FIXTURE = {
  count: 1,
  next: null,
  results: [
    {
      id: 87,
      name: "Space Launch Complex 40",
      latitude: "28.5619",
      longitude: "-80.5774",
      country_code: "USA",
      location: { id: 12, name: "Cape Canaveral SFS, FL, USA", country_code: "USA" },
    },
  ],
};

const SPACEX_FIXTURE = [
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
  {
    id: "sx-2",
    name: "Crew-12",
    date_utc: "2026-11-01T10:00:00.000Z",
    date_local: "2026-11-01T06:00:00-04:00",
    upcoming: true,
    success: null,
    flight_number: 401,
    details: null,
    launchpad: "pad-2",
    rocket: "rocket-1",
  },
];

function stubFetch(handler: (url: string) => unknown) {
  __clearCache();
  __setFetch(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => handler(url),
  }));
}

beforeEach(() => {
  __clearCache();
  __resetFetch();
});

describe("clamp helpers", () => {
  it("clamps limits to 1..100 with default 10", () => {
    expect(clampLimit(undefined)).toBe(10);
    expect(clampLimit(5)).toBe(5);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(500)).toBe(100);
    expect(clampLimit(NaN)).toBe(10);
  });

  it("clamps offsets to >= 0", () => {
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset(-3)).toBe(0);
    expect(clampOffset(7)).toBe(7);
  });
});

describe("window validation", () => {
  it("accepts ISO dates and datetimes", () => {
    expect(() =>
      assertValidWindow({ windowStartGte: "2026-10-01", windowStartLte: "2026-12-31T00:00:00Z" }),
    ).not.toThrow();
  });

  it("rejects garbage with a helpful message", () => {
    expect(() => assertValidWindow({ windowStartGte: "next friday" })).toThrow(/window_start_gte/);
    expect(() => assertValidWindow({ windowStartLte: "ontem" })).toThrow(/ISO/);
  });
});

describe("buildLaunchParams", () => {
  it("builds defaults for an empty query", () => {
    expect(buildLaunchParams({})).toEqual({ limit: "10", offset: "0", ordering: "net" });
  });

  it("maps every filter to LL2 params", () => {
    expect(
      buildLaunchParams(
        {
          search: "Starlink",
          windowStartGte: "2026-10-01",
          windowStartLte: "2026-12-31",
          locationId: 12,
          padId: 87,
          providerId: 121,
          mode: "previous",
          limit: 5,
          offset: 10,
        },
        {},
      ),
    ).toEqual({
      limit: "5",
      offset: "10",
      ordering: "-net",
      search: "Starlink",
      window_start__gte: "2026-10-01",
      window_start__lte: "2026-12-31",
      location__ids: "12",
      pad__ids: "87",
      lsp__ids: "121",
    });
  });

  it("uses resolved ids when direct ids are absent", () => {
    const p = buildLaunchParams(
      { countryCode: "USA", providerName: "SpaceX" },
      { locationIds: [12, 27], providerId: 121 },
    );
    expect(p.location__ids).toBe("12,27");
    expect(p.lsp__ids).toBe("121");
  });
});

describe("normalizers", () => {
  it("slims an LL2 launch row", () => {
    const l = normalizeLaunch(LAUNCH_FIXTURE.results[0] as unknown as Record<string, unknown>);
    expect(l).toMatchObject({
      id: "f4c720ce-0cfd-43e6-b8dd-00273073bc01",
      status: "Go",
      provider: "Rocket Lab",
      rocket: "Electron",
      pad: "Rocket Lab Launch Complex 1A",
      countryCode: "NZL",
    });
  });

  it("falls back gracefully on sparse rows", () => {
    const l = normalizeLaunch({ id: "x" });
    expect(l.name).toBe("Unnamed launch");
    expect(l.provider).toBeNull();
    expect(l.countryCode).toBeNull();
  });

  it("slims locations, pads and providers", () => {
    expect(
      normalizeLocation(LOCATION_FIXTURE.results[0] as unknown as Record<string, unknown>),
    ).toMatchObject({ id: 12, countryCode: "USA", timezone: "America/New_York" });
    expect(normalizePad(PAD_FIXTURE.results[0] as unknown as Record<string, unknown>)).toMatchObject({
      id: 87,
      location: "Cape Canaveral SFS, FL, USA",
    });
    expect(normalizeProvider(AGENCY_FIXTURE.results[0] as unknown as Record<string, unknown>)).toMatchObject({
      id: 121,
      abbrev: "SpX",
    });
  });

  it("picks providers by exact, abbrev, prefix, then first", () => {
    const rows = [
      { id: 1, name: "Rocket Lab", abbrev: "RL" },
      { id: 121, name: "SpaceX", abbrev: "SpX" },
    ] as unknown as Record<string, unknown>[];
    expect(pickProvider(rows, "SpaceX")).toMatchObject({ id: 121 });
    expect(pickProvider(rows, "spx")).toMatchObject({ id: 121 });
    expect(pickProvider(rows, "space")).toMatchObject({ id: 121 });
    expect(pickProvider(rows, "zzz")).toMatchObject({ id: 1 });
    expect(pickProvider([], "SpaceX")).toBeNull();
  });

  it("slims a SpaceX launch", () => {
    const s = normalizeSpaceXLaunch(SPACEX_FIXTURE[0] as unknown as Record<string, unknown>);
    expect(s).toMatchObject({ id: "sx-1", name: "Starlink 10-1", flightNumber: 400, upcoming: true });
  });
});

describe("LL2 reads (stubbed)", () => {
  it("lists upcoming launches", async () => {
    stubFetch(() => LAUNCH_FIXTURE);
    const r = await listUpcomingLaunches({ limit: 10 });
    expect(r.mode).toBe("upcoming");
    expect(r.count).toBe(2);
    expect(r.results[0].provider).toBe("Rocket Lab");
  });

  it("resolves country_code to location ids", async () => {
    const seen: string[] = [];
    stubFetch((url: string) => {
      seen.push(url);
      if (url.includes("/location/")) return { count: 2, next: null, results: [{ id: 12 }, { id: 27 }] };
      return LAUNCH_FIXTURE;
    });
    const r = await listUpcomingLaunches({ countryCode: "usa" });
    expect(r.results).toHaveLength(2);
    expect(seen.some((u) => u.includes("country_code=USA"))).toBe(true);
    expect(seen.some((u) => u.includes("location__ids=12%2C27") || u.includes("location__ids=12,27"))).toBe(true);
  });

  it("returns an empty note when the country has no locations", async () => {
    stubFetch((url: string) => {
      if (url.includes("/location/")) return { count: 0, next: null, results: [] };
      return LAUNCH_FIXTURE;
    });
    const r = await listUpcomingLaunches({ countryCode: "BRA" });
    expect(r.count).toBe(0);
    expect(r.results).toEqual([]);
    expect(String((r as { note?: string }).note)).toMatch(/BRA/);
  });

  it("rejects invalid country codes without network", async () => {
    stubFetch(() => LAUNCH_FIXTURE);
    await expect(listUpcomingLaunches({ countryCode: "US" })).rejects.toThrow(/alpha-3/);
  });

  it("resolves provider_name via agencies search", async () => {
    const seen: string[] = [];
    stubFetch((url: string) => {
      seen.push(url);
      if (url.includes("/agencies/")) return AGENCY_FIXTURE;
      return LAUNCH_FIXTURE;
    });
    const r = await listUpcomingLaunches({ providerName: "spacex" });
    expect(r.results).toHaveLength(2);
    expect(seen.some((u) => u.includes("lsp__ids=121"))).toBe(true);
  });

  it("rejects unknown providers with a hint", async () => {
    stubFetch((url: string) => {
      if (url.includes("/agencies/")) return { count: 0, next: null, results: [] };
      return LAUNCH_FIXTURE;
    });
    await expect(listUpcomingLaunches({ providerName: "Initech" })).rejects.toThrow(
      /Unknown provider 'Initech'/,
    );
  });

  it("fetches one launch and validates the id", async () => {
    stubFetch(() => LAUNCH_FIXTURE.results[0]);
    const l = await getLaunch("f4c720ce-0cfd-43e6-b8dd-00273073bc01");
    expect(l.provider).toBe("Rocket Lab");
    await expect(getLaunch("   ")).rejects.toThrow(/non-empty id/);
  });

  it("lists locations, pads and providers", async () => {
    stubFetch((url: string) => {
      if (url.includes("/location/")) return LOCATION_FIXTURE;
      if (url.includes("/pad/")) return PAD_FIXTURE;
      return AGENCY_FIXTURE;
    });
    const locs = await listLaunchLocations({ countryCode: "USA" });
    expect(locs.results[0]).toMatchObject({ id: 12 });
    const pads = await listLaunchPads({ search: "Cape" });
    expect(pads.results[0]).toMatchObject({ id: 87 });
    const provs = await listLaunchProviders({ search: "SpaceX" });
    expect(provs.results[0]).toMatchObject({ id: 121 });
    await expect(listLaunchLocations({ countryCode: "US" })).rejects.toThrow(/alpha-3/);
  });
});

describe("SpaceX reads (stubbed)", () => {
  it("lists and filters upcoming SpaceX launches", async () => {
    stubFetch(() => SPACEX_FIXTURE);
    const all = await listSpaceXLaunches({ upcoming: true, limit: 10 });
    expect(all.count).toBe(2);
    expect(all.results[0].name).toBe("Starlink 10-1");
    const filtered = await listSpaceXLaunches({ search: "crew" });
    expect(filtered.results).toHaveLength(1);
  });

  it("fetches one SpaceX launch and validates the id", async () => {
    stubFetch(() => SPACEX_FIXTURE[0]);
    const l = await getSpaceXLaunch("sx-1");
    expect(l.name).toBe("Starlink 10-1");
    await expect(getSpaceXLaunch("  ")).rejects.toThrow(/non-empty id/);
  });

  it("wraps SpaceX outages with a fallback hint", async () => {
    __clearCache();
    __setFetch(async () => ({ ok: false, status: 525, json: async () => ({}) }));
    await expect(listSpaceXLaunches({})).rejects.toThrow(/secondary source.*provider_name='SpaceX'/s);
    await expect(getSpaceXLaunch("sx-1")).rejects.toThrow(/secondary source/);
  });
});
