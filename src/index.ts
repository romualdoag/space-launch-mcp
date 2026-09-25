#!/usr/bin/env node
/**
 * space-launch-mcp — MCP server for space launches.
 *
 * Primary source: Launch Library 2 (global manifest — SpaceX, Rocket Lab,
 * Arianespace, ISRO, CNSA…), no credentials needed.
 * Secondary source: SpaceX REST API v5 (SpaceX-specific detail).
 * Tertiary/fallback: RocketLaunch.Live free JSON (next 5 launches, no key).
 * Context: Spaceflight News API v4 (articles/blogs/reports, no key).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  listUpcomingLaunches,
  getLaunch,
  listLaunchLocations,
  listLaunchPads,
  listLaunchProviders,
  listSpaceXLaunches,
  getSpaceXLaunch,
  listRocketLaunchLiveUpcoming,
  listSpaceflightNews,
  PKG_VERSION,
} from "./service.js";

const server = new McpServer({
  name: "space-launch-mcp",
  version: PKG_VERSION,
});

type TextResult = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

function asText(obj: unknown): TextResult {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

function asError(err: unknown): TextResult {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[space-launch-mcp] tool error: ${msg}`);
  return {
    content: [{ type: "text", text: `Error: ${msg}` }],
    isError: true,
  };
}

/** Executa a tool com erro estruturado (isError) em vez de derrubar a sessão. */
async function handle(fn: () => Promise<unknown>): Promise<TextResult> {
  try {
    return asText(await fn());
  } catch (err) {
    return asError(err);
  }
}

const limitParam = z
  .number()
  .int()
  .positive()
  .max(100)
  .optional()
  .describe("Max items to return (default 10, max 100).");

const offsetParam = z.number().int().min(0).optional().describe("Pagination offset (default 0).");

server.registerTool(
  "list_upcoming_launches",
  {
    description:
      "List space launches (upcoming by default, or previous). Filter by free-text search, NET window (window_start_gte/lte as ISO dates), country_code (ISO alpha-3, e.g. USA/JPN/FRA), location_id, pad_id, provider_id or provider_name (e.g. 'SpaceX').",
    inputSchema: {
      search: z.string().optional().describe("Free-text search on mission/rocket/provider, e.g. 'Starlink'."),
      window_start_gte: z.string().optional().describe("NET lower bound, ISO date/datetime, e.g. '2026-10-01'."),
      window_start_lte: z.string().optional().describe("NET upper bound, ISO date/datetime, e.g. '2026-12-31'."),
      country_code: z.string().optional().describe("ISO 3166-1 alpha-3 country of the launch site, e.g. 'USA', 'JPN'."),
      location_id: z.number().int().positive().optional().describe("LL2 location id. See list_launch_locations."),
      pad_id: z.number().int().positive().optional().describe("LL2 pad id. See list_launch_pads."),
      provider_id: z.number().int().positive().optional().describe("LL2 agency id. See list_launch_providers."),
      provider_name: z.string().optional().describe("Provider name resolved via agencies search, e.g. 'SpaceX', 'Rocket Lab'."),
      mode: z.enum(["upcoming", "previous"]).optional().describe("Which manifest to read (default 'upcoming')."),
      limit: limitParam,
      offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)."),
    },
  },
  async (args) =>
    handle(() =>
      listUpcomingLaunches({
        search: args.search,
        windowStartGte: args.window_start_gte,
        windowStartLte: args.window_start_lte,
        countryCode: args.country_code,
        locationId: args.location_id,
        padId: args.pad_id,
        providerId: args.provider_id,
        providerName: args.provider_name,
        mode: args.mode,
        limit: args.limit,
        offset: args.offset,
      }),
    ),
);

server.registerTool(
  "get_launch",
  {
    description: "Get full detail for one launch by LL2 id or slug (ids come from list_upcoming_launches).",
    inputSchema: {
      id: z.string().describe("LL2 launch id (uuid) or slug."),
    },
  },
  async ({ id }) => handle(() => getLaunch(id)),
);

server.registerTool(
  "list_launch_locations",
  {
    description: "List launch sites (spaceports/cosmodromes). Filter by free-text search or country_code (ISO alpha-3).",
    inputSchema: {
      search: z.string().optional().describe("Free-text search, e.g. 'Cape', 'Kourou', 'Tanegashima'."),
      country_code: z.string().optional().describe("ISO 3166-1 alpha-3, e.g. 'USA', 'FRA', 'JPN', 'KAZ'."),
      limit: limitParam,
      offset: offsetParam,
    },
  },
  async (args) =>
    handle(() =>
      listLaunchLocations({
        search: args.search,
        countryCode: args.country_code,
        limit: args.limit,
        offset: args.offset,
      }),
    ),
);

server.registerTool(
  "list_launch_pads",
  {
    description: "List launch pads. Filter by free-text search or parent location_id (see list_launch_locations).",
    inputSchema: {
      search: z.string().optional().describe("Free-text search, e.g. 'LC-39A', 'Ariane'."),
      location_id: z.number().int().positive().optional().describe("Parent LL2 location id."),
      limit: limitParam,
      offset: offsetParam,
    },
  },
  async (args) =>
    handle(() =>
      listLaunchPads({
        search: args.search,
        locationId: args.location_id,
        limit: args.limit,
        offset: args.offset,
      }),
    ),
);

server.registerTool(
  "list_launch_providers",
  {
    description: "List launch service providers / agencies (SpaceX, Rocket Lab, ESA…). Filter by free-text search.",
    inputSchema: {
      search: z.string().optional().describe("Free-text search, e.g. 'SpaceX'."),
      limit: limitParam,
      offset: offsetParam,
    },
  },
  async (args) =>
    handle(() => listLaunchProviders({ search: args.search, limit: args.limit, offset: args.offset })),
);

server.registerTool(
  "list_spacex_launches",
  {
    description:
      "List SpaceX launches from the secondary SpaceX REST API (upcoming by default, server-side search/sort/pagination via /launches/query). If it is unreachable, use list_upcoming_launches with provider_name='SpaceX' instead.",
    inputSchema: {
      upcoming: z.boolean().optional().describe("True for upcoming, false for past (default true)."),
      search: z.string().optional().describe("Filter by mission name substring, e.g. 'Starlink'."),
      limit: limitParam,
      offset: offsetParam,
    },
  },
  async (args) =>
    handle(() =>
      listSpaceXLaunches({ upcoming: args.upcoming, search: args.search, limit: args.limit, offset: args.offset }),
    ),
);

server.registerTool(
  "get_spacex_launch",
  {
    description: "Get one SpaceX launch by id from the secondary SpaceX REST API.",
    inputSchema: {
      id: z.string().describe("SpaceX launch id."),
    },
  },
  async ({ id }) => handle(() => getSpaceXLaunch(id)),
);

server.registerTool(
  "list_rocketlaunch_live",
  {
    description:
      "Fallback independente (RocketLaunch.Live, tier gratuito: próximos até 5 lançamentos, sem auth). Use quando Launch Library 2 estiver fora do ar; inclui janela/t0 e clima do pad.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .positive()
        .max(5)
        .optional()
        .describe("Max items to return (default 5, max 5 on the free tier)."),
    },
  },
  async (args) => handle(() => listRocketLaunchLiveUpcoming({ limit: args.limit })),
);

server.registerTool(
  "list_spaceflight_news",
  {
    description:
      "Space news with launch context (Spaceflight News API v4, sem auth): articles, blogs ou reports. Complementa o manifesto com cobertura jornalística.",
    inputSchema: {
      type: z.enum(["article", "blog", "report"]).optional().describe("Kind of item (default 'article')."),
      search: z.string().optional().describe("Free-text search, e.g. 'Starship', 'Artemis'."),
      limit: limitParam,
      offset: offsetParam,
    },
  },
  async (args) =>
    handle(() =>
      listSpaceflightNews({ type: args.type, search: args.search, limit: args.limit, offset: args.offset }),
    ),
);

await server.connect(new StdioServerTransport());
