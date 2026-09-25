/**
 * Live smoke tests — opt-in via LIVE=1 (excluded from the default suite).
 * Hit the real APIs with limit=1/2; assert shape, not content.
 *
 *   LIVE=1 npx vitest run tests/live.test.ts
 */
import { describe, it, expect } from "vitest";
import {
  listUpcomingLaunches,
  listLaunchLocations,
  listSpaceXLaunches,
  listRocketLaunchLiveUpcoming,
  listSpaceflightNews,
} from "../src/service.js";

const LIVE = process.env.LIVE === "1" ? describe : describe.skip;

LIVE("live APIs (LIVE=1)", () => {
  it("LL2 upcoming", async () => {
    const r = await listUpcomingLaunches({ limit: 1 });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0].name).toBeTypeOf("string");
  }, 30_000);

  it("LL2 locations", async () => {
    const r = await listLaunchLocations({ search: "Cape", limit: 1 });
    expect(r.results.length).toBeGreaterThan(0);
  }, 30_000);

  it("SpaceX query (ou fallback documentado se fora do ar)", async () => {
    try {
      const r = await listSpaceXLaunches({ upcoming: true, limit: 1 });
      expect(r.results.length).toBeGreaterThan(0);
    } catch (err) {
      // A SpaceX API é instável (ex. HTTP 525); o erro deve orientar o fallback LL2.
      expect(String(err)).toMatch(/secondary source.*provider_name='SpaceX'/s);
    }
  }, 30_000);

  it("RocketLaunch.Live free tier", async () => {
    const r = await listRocketLaunchLiveUpcoming({ limit: 2 });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0].t0 ?? r.results[0].windowOpen ?? r.results[0].dateStr).toBeTruthy();
  }, 30_000);

  it("Spaceflight News", async () => {
    const r = await listSpaceflightNews({ type: "article", limit: 1 });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0].title).toBeTypeOf("string");
  }, 30_000);
});
