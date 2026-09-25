/**
 * space-launch-mcp service layer — pure logic behind the MCP tools.
 * Kept separate from index.ts (stdio wiring) so it can be unit-tested.
 *
 * Data sources:
 * - Launch Library 2 (https://ll.thespacedevs.com/2.2.0) — global launch
 *   manifest, locations, pads, agencies. No auth needed for read access.
 * - SpaceX REST API v5 (https://api.spacexdata.com/v5) — SpaceX-specific
 *   detail. Treated as secondary: when it is unreachable the tools raise a
 *   clear, actionable error instead of failing silently.
 */

import { createRequire } from "node:module";

export const LL2_BASE = "https://ll.thespacedevs.com/2.2.0";
export const SPACEX_BASE = "https://api.spacexdata.com/v5";

const _require = createRequire(import.meta.url);
let _pkgVersion = "0.0.0";
try {
  const pkg = _require("../package.json") as { version?: unknown };
  if (typeof pkg.version === "string" && pkg.version.length > 0) _pkgVersion = pkg.version;
} catch {
  /* fallback quando package.json não é resolvível (ex. bundle) */
}
export const PKG_VERSION = _pkgVersion;
export const USER_AGENT = `space-launch-mcp/${_pkgVersion} (+https://github.com/romualdoag/space-launch-mcp)`;

/** Timeout por requisição (ms). Configurável via SPACE_LAUNCH_TIMEOUT_MS (1..60000). Padrão 12s. */
export function getTimeoutMs(): number {
  const raw = process.env.SPACE_LAUNCH_TIMEOUT_MS;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), 60_000);
  }
  return 12_000;
}

function warn(msg: string): void {
  console.error(`[space-launch-mcp] ${msg}`);
}

// ---------------------------------------------------------------------------
// HTTP + cache
// ---------------------------------------------------------------------------

type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: { get(name: string): string | null } | Record<string, string | null | undefined>;
  json(): Promise<unknown>;
}>;

let fetchFn: FetchFn = (url, init) =>
  fetch(url, {
    method: init?.method,
    headers: { "user-agent": USER_AGENT, ...(init?.headers ?? {}) },
    body: init?.body,
    signal: init?.signal,
  }) as unknown as Promise<ReturnType<FetchFn> extends Promise<infer T> ? T : never>;

/** Override the HTTP fetcher (used by unit tests). */
export function __setFetch(fn: FetchFn): void {
  fetchFn = fn;
}

/** Restore the default fetch-based fetcher. */
export function __resetFetch(): void {
  fetchFn = (url, init) =>
    fetch(url, {
      method: init?.method,
      headers: { "user-agent": USER_AGENT, ...(init?.headers ?? {}) },
      body: init?.body,
      signal: init?.signal,
    }) as unknown as Promise<ReturnType<FetchFn> extends Promise<infer T> ? T : never>;
}

type CacheEntry = { expires: number; data: unknown };
const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 200;

function cacheGet(key: string): CacheEntry | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  // Refresh LRU: re-insere para marcar como recente.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key: string, entry: CacheEntry): void {
  if (cache.has(key)) cache.delete(key);
  else if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, entry);
}

/** Tamanho atual do cache (usado em testes). */
export function __cacheSize(): number {
  return cache.size;
}

/** Clear the response cache (used by unit tests). */
export function __clearCache(): void {
  cache.clear();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getHeader(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === "function") {
    try {
      return (headers as { get(n: string): string | null }).get(name);
    } catch {
      return null;
    }
  }
  const rec = headers as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (k.toLowerCase() === name.toLowerCase()) {
      const v = rec[k];
      return typeof v === "string" ? v : v == null ? null : String(v);
    }
  }
  return null;
}

/** Retry-After (s ou data HTTP) → ms, ou null se ausente/inválido. Cap 30s. */
function parseRetryAfterMs(v: string | null): number | null {
  if (!v) return null;
  const t = v.trim();
  if (/^\d+$/.test(t)) return Math.min(Number(t) * 1000, 30_000);
  const ts = Date.parse(t);
  if (Number.isFinite(ts)) return Math.max(0, Math.min(ts - Date.now(), 30_000));
  return null;
}

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function fetchJson<T>(url: string, label: string, ttlMs: number, init?: { method?: string; body?: string }): Promise<T> {
  const key = `${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`;
  const now = Date.now();
  const hit = cacheGet(key);
  if (hit && hit.expires > now) return hit.data as T;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const timeoutMs = getTimeoutMs();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetchFn(url, {
        method: init?.method,
        headers: init?.body ? { "content-type": "application/json" } : undefined,
        body: init?.body,
        signal: ctrl.signal,
      });
      if (isRetryableStatus(resp.status) && attempt < MAX_RETRIES) {
        const delay = parseRetryAfterMs(getHeader(resp.headers, "retry-after")) ?? RETRY_BASE_MS * 2 ** attempt;
        warn(`${label}: HTTP ${resp.status} — retry ${attempt + 1}/${MAX_RETRIES} em ${delay}ms (${url})`);
        await sleep(delay);
        continue;
      }
      if (!resp.ok) {
        throw new Error(`${label}: HTTP ${resp.status} for ${url}`);
      }
      const data = (await resp.json()) as T;
      cacheSet(key, { expires: Date.now() + ttlMs, data });
      return data;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.name === "AbortError") {
        warn(`${label}: timeout após ${getTimeoutMs()}ms (${url})`);
        throw new Error(`${label}: timeout após ${getTimeoutMs()}ms for ${url}`);
      }
      // Erro HTTP (incl. 429/5xx após esgotar retries) ou parse: não re-tenta fora do loop.
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label}: request failed for ${url}`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UpcomingMode = "upcoming" | "previous";

export type UpcomingOptions = {
  search?: string;
  /** ISO date/datetime lower bound on the NET window, e.g. "2026-10-01" */
  windowStartGte?: string;
  /** ISO date/datetime upper bound on the NET window, e.g. "2026-12-31" */
  windowStartLte?: string;
  /** ISO 3166-1 alpha-3 country code, e.g. "USA", "JPN", "FRA" */
  countryCode?: string;
  locationId?: number;
  padId?: number;
  providerId?: number;
  /** Resolved via /agencies/?search= when providerId is absent. */
  providerName?: string;
  mode?: UpcomingMode;
  limit?: number;
  offset?: number;
};

export type SlimLaunch = {
  id: string;
  name: string;
  net: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  status: string | null;
  provider: string | null;
  rocket: string | null;
  mission: string | null;
  orbit: string | null;
  pad: string | null;
  location: string | null;
  countryCode: string | null;
};

export type SlimLocation = {
  id: number;
  name: string;
  countryCode: string | null;
  timezone: string | null;
  totalLaunchCount: number | null;
};

export type SlimPad = {
  id: number;
  name: string;
  location: string | null;
  countryCode: string | null;
  latitude: string | null;
  longitude: string | null;
};

export type SlimProvider = {
  id: number;
  name: string;
  abbrev: string | null;
  type: string | null;
  countryCode: string | null;
};

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested offline)
// ---------------------------------------------------------------------------

export function clampLimit(limit: number | undefined, def = 10, max = 100): number {
  if (limit === undefined || !Number.isFinite(limit)) return def;
  return Math.min(Math.max(Math.floor(limit), 1), max);
}

export function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(Math.floor(offset), 0);
}

function isIsoDateLike(s: string): boolean {
  const t = s.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})([T ].*)?$/.exec(t);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  // Valida dia real (ex. rejeita 2026-02-30, 2026-13-01, 2025-02-29).
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > dim) return false;
  return Number.isFinite(Date.parse(t.replace(" ", "T")));
}

/** Validate user-supplied date filters early with a clear message. */
export function assertValidWindow(opts: Pick<UpcomingOptions, "windowStartGte" | "windowStartLte">): void {
  for (const [label, v] of [
    ["window_start_gte", opts.windowStartGte],
    ["window_start_lte", opts.windowStartLte],
  ] as const) {
    if (v !== undefined && !isIsoDateLike(v)) {
      throw new Error(
        `Invalid ${label} '${v}'. Use ISO date or datetime, e.g. '2026-10-01' or '2026-10-01T00:00:00Z'.`,
      );
    }
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Build LL2 /launch query params from tool options (no I/O). */
export function buildLaunchParams(
  opts: UpcomingOptions,
  resolved: { locationIds?: number[]; providerId?: number } = {},
): Record<string, string> {
  assertValidWindow(opts);
  const p: Record<string, string> = {
    limit: String(clampLimit(opts.limit)),
    offset: String(clampOffset(opts.offset)),
    ordering: opts.mode === "previous" ? "-net" : "net",
  };
  if (opts.search) p.search = opts.search;
  if (opts.windowStartGte) p.window_start__gte = opts.windowStartGte;
  if (opts.windowStartLte) p.window_start__lte = opts.windowStartLte;
  const locIds = opts.locationId !== undefined ? [opts.locationId] : (resolved.locationIds ?? []);
  if (locIds.length > 0) p.location__ids = locIds.join(",");
  if (opts.padId !== undefined) p.pad__ids = String(opts.padId);
  const provId = opts.providerId ?? resolved.providerId;
  if (provId !== undefined) p.lsp__ids = String(provId);
  return p;
}

/** Slim down one raw LL2 launch row (no I/O). */
export function normalizeLaunch(raw: Record<string, unknown>): SlimLaunch {
  const r = raw as Record<string, unknown>;
  const lsp = (r.launch_service_provider ?? {}) as Record<string, unknown>;
  const rocket = (r.rocket ?? {}) as Record<string, unknown>;
  const config = (rocket.configuration ?? {}) as Record<string, unknown>;
  const mission = (r.mission ?? {}) as Record<string, unknown>;
  const orbit = (mission.orbit ?? {}) as Record<string, unknown>;
  const pad = (r.pad ?? {}) as Record<string, unknown>;
  const location = (pad.location ?? {}) as Record<string, unknown>;
  const status = (r.status ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? r.slug ?? "unknown"),
    name: String(r.name ?? "Unnamed launch"),
    net: str(r.net),
    windowStart: str(r.window_start),
    windowEnd: str(r.window_end),
    status: str(status.abbrev) ?? str(status.name),
    provider: str(lsp.name),
    rocket: str(config.full_name) ?? str(config.name),
    mission: str(mission.name),
    orbit: str(orbit.abbrev) ?? str(orbit.name),
    pad: str(pad.name),
    location: str(location.name),
    countryCode: str(location.country_code) ?? str(pad.country_code),
  };
}

/** Slim down one raw LL2 location row (no I/O). */
export function normalizeLocation(raw: Record<string, unknown>): SlimLocation {
  return {
    id: Number(raw.id),
    name: String(raw.name ?? "Unnamed location"),
    countryCode: str(raw.country_code),
    timezone: str(raw.timezone_name),
    totalLaunchCount: num(raw.total_launch_count),
  };
}

/** Slim down one raw LL2 pad row (no I/O). */
export function normalizePad(raw: Record<string, unknown>): SlimPad {
  const loc = (raw.location ?? {}) as Record<string, unknown>;
  return {
    id: Number(raw.id),
    name: String(raw.name ?? "Unnamed pad"),
    location: str(loc.name),
    countryCode: str(raw.country_code) ?? str(loc.country_code),
    latitude: str(raw.latitude),
    longitude: str(raw.longitude),
  };
}

/** Slim down one raw LL2 agency row (no I/O). */
export function normalizeProvider(raw: Record<string, unknown>): SlimProvider {
  return {
    id: Number(raw.id),
    name: String(raw.name ?? "Unnamed provider"),
    abbrev: str(raw.abbrev),
    type: str(raw.type),
    countryCode: str(raw.country_code),
  };
}

/** Pick the best agency match for a provider name search (no I/O). */
export function pickProvider(
  results: Array<Record<string, unknown>>,
  wanted: string,
): Record<string, unknown> | null {
  if (results.length === 0) return null;
  const w = wanted.trim().toLowerCase();
  const exact = results.find(
    (r) =>
      String(r.name ?? "").toLowerCase() === w ||
      String(r.abbrev ?? "").toLowerCase() === w,
  );
  if (exact) return exact;
  const prefix = results.find((r) => String(r.name ?? "").toLowerCase().startsWith(w));
  return prefix ?? results[0];
}

/** Slim down one raw SpaceX v5 launch (no I/O). */
export function normalizeSpaceXLaunch(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    id: str(raw.id),
    name: str(raw.name),
    dateUtc: str(raw.date_utc),
    dateLocal: str(raw.date_local),
    upcoming: typeof raw.upcoming === "boolean" ? raw.upcoming : null,
    success: typeof raw.success === "boolean" ? raw.success : null,
    flightNumber: num(raw.flight_number),
    details: str(raw.details),
    launchpad: str(raw.launchpad),
    rocket: str(raw.rocket),
  };
}

// ---------------------------------------------------------------------------
// LL2 reads
// ---------------------------------------------------------------------------

type Paginated<T> = { count: number; next: string | null; results: T[] };

async function resolveLocationIds(countryCode: string): Promise<number[]> {
  const code = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error(
      `Invalid country_code '${countryCode}'. Use ISO 3166-1 alpha-3, e.g. 'USA', 'BRA', 'JPN', 'FRA'.`,
    );
  }
  // Pagina via `next` — países grandes (ex. USA) têm >100 locations.
  let url: string | null = `${LL2_BASE}/location/?country_code=${encodeURIComponent(code)}&limit=100`;
  const ids: number[] = [];
  for (let page = 0; page < 20 && url; page++) {
    const pageUrl: string = url;
    const data: Paginated<Record<string, unknown>> = await fetchJson<Paginated<Record<string, unknown>>>(
      pageUrl,
      "LL2 locations",
      24 * 3_600_000,
    );
    for (const r of Array.isArray(data.results) ? data.results : []) {
      const n = Number((r as Record<string, unknown>).id);
      if (Number.isFinite(n)) ids.push(n);
    }
    url = typeof data.next === "string" && data.next.length > 0 ? data.next : null;
  }
  return ids;
}

async function resolveProviderId(providerName: string): Promise<number> {
  const url = `${LL2_BASE}/agencies/?search=${encodeURIComponent(providerName)}&limit=10`;
  const data = await fetchJson<Paginated<Record<string, unknown>>>(url, "LL2 agencies", 24 * 3_600_000);
  const results = Array.isArray(data.results) ? data.results : [];
  const best = pickProvider(results, providerName);
  if (!best) {
    throw new Error(
      `Unknown provider '${providerName}'. Call list_launch_providers with search='${providerName}' to find the exact name.`,
    );
  }
  return Number(best.id);
}

export async function listUpcomingLaunches(opts: UpcomingOptions = {}) {
  const mode: UpcomingMode = opts.mode === "previous" ? "previous" : "upcoming";
  const resolved: { locationIds?: number[]; providerId?: number } = {};
  let conflictNote: string | undefined;
  if (opts.countryCode && opts.locationId !== undefined) {
    // location_id explícito vence; country_code seria contraditório se aplicado junto.
    conflictNote =
      `Both country_code ('${opts.countryCode.toUpperCase()}') and location_id (${opts.locationId}) were given; ` +
      `location_id takes precedence and country_code was ignored.`;
    warn(conflictNote);
  }
  // Resolve em paralelo: antes eram 2 round-trips sequenciais + launch (3×25s no pior caso).
  const needLocations = opts.countryCode && opts.locationId === undefined;
  const needProvider = opts.providerName && opts.providerId === undefined;
  const [locationIds, providerId] = await Promise.all([
    needLocations ? resolveLocationIds(opts.countryCode as string) : Promise.resolve(undefined),
    needProvider ? resolveProviderId(opts.providerName as string) : Promise.resolve(undefined),
  ]);
  if (locationIds) {
    if (locationIds.length === 0) {
      return {
        mode,
        count: 0,
        results: [],
        note: `No launch locations registered in LL2 for country '${(opts.countryCode as string).toUpperCase()}'.`,
      };
    }
    resolved.locationIds = locationIds;
  }
  if (providerId !== undefined) resolved.providerId = providerId;
  const params = buildLaunchParams({ ...opts, mode }, resolved);
  const qs = new URLSearchParams(params).toString();
  const url = `${LL2_BASE}/launch/${mode}/?${qs}`;
  const data = await fetchJson<Paginated<Record<string, unknown>>>(url, `LL2 ${mode} launches`, 60_000);
  const results = Array.isArray(data.results) ? data.results.map(normalizeLaunch) : [];
  return {
    mode,
    count: typeof data.count === "number" ? data.count : results.length,
    results,
    ...(conflictNote ? { note: conflictNote } : {}),
  };
}

export async function getLaunch(id: string) {
  const clean = id.trim();
  if (!clean) throw new Error("get_launch requires a non-empty id (LL2 launch id or slug).");
  const url = `${LL2_BASE}/launch/${encodeURIComponent(clean)}/`;
  const data = await fetchJson<Record<string, unknown>>(url, "LL2 launch detail", 60_000);
  return normalizeLaunch(data);
}

export async function listLaunchLocations(opts: { search?: string; countryCode?: string; limit?: number } = {}) {
  const params: Record<string, string> = { limit: String(clampLimit(opts.limit, 10)) };
  if (opts.search) params.search = opts.search;
  if (opts.countryCode) {
    const code = opts.countryCode.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
      throw new Error(
        `Invalid country_code '${opts.countryCode}'. Use ISO 3166-1 alpha-3, e.g. 'USA', 'BRA', 'JPN', 'FRA'.`,
      );
    }
    params.country_code = code;
  }
  const url = `${LL2_BASE}/location/?${new URLSearchParams(params).toString()}`;
  const data = await fetchJson<Paginated<Record<string, unknown>>>(url, "LL2 locations", 24 * 3_600_000);
  const results = Array.isArray(data.results) ? data.results.map(normalizeLocation) : [];
  return { count: typeof data.count === "number" ? data.count : results.length, results };
}

export async function listLaunchPads(opts: { search?: string; locationId?: number; limit?: number } = {}) {
  const params: Record<string, string> = { limit: String(clampLimit(opts.limit, 10)) };
  if (opts.search) params.search = opts.search;
  if (opts.locationId !== undefined) params.location__ids = String(opts.locationId);
  const url = `${LL2_BASE}/pad/?${new URLSearchParams(params).toString()}`;
  const data = await fetchJson<Paginated<Record<string, unknown>>>(url, "LL2 pads", 24 * 3_600_000);
  const results = Array.isArray(data.results) ? data.results.map(normalizePad) : [];
  return { count: typeof data.count === "number" ? data.count : results.length, results };
}

export async function listLaunchProviders(opts: { search?: string; limit?: number } = {}) {
  const params: Record<string, string> = { limit: String(clampLimit(opts.limit, 10)) };
  if (opts.search) params.search = opts.search;
  const url = `${LL2_BASE}/agencies/?${new URLSearchParams(params).toString()}`;
  const data = await fetchJson<Paginated<Record<string, unknown>>>(url, "LL2 agencies", 24 * 3_600_000);
  const results = Array.isArray(data.results) ? data.results.map(normalizeProvider) : [];
  return { count: typeof data.count === "number" ? data.count : results.length, results };
}

// ---------------------------------------------------------------------------
// SpaceX reads (secondary source)
// ---------------------------------------------------------------------------

function spaceXError(action: string, err: unknown): never {
  const detail = err instanceof Error ? err.message : String(err);
  throw new Error(
    `SpaceX API unavailable for ${action} (${detail}). ` +
      `The SpaceX endpoint is a secondary source — retry later or use list_upcoming_launches with provider_name='SpaceX' (Launch Library 2) instead.`,
  );
}

export async function listSpaceXLaunches(opts: { upcoming?: boolean; search?: string; limit?: number } = {}) {
  const upcoming = opts.upcoming ?? true;
  const limit = clampLimit(opts.limit, 10);
  const url = `${SPACEX_BASE}/launches/${upcoming ? "upcoming" : "past"}`;
  let rows: Record<string, unknown>[];
  try {
    const data = await fetchJson<Record<string, unknown>[]>(url, "SpaceX launches", 5 * 60_000);
    rows = Array.isArray(data) ? data : [];
  } catch (err) {
    spaceXError("list_spacex_launches", err);
  }
  let slim = rows!.map(normalizeSpaceXLaunch);
  if (opts.search) {
    const q = opts.search.trim().toLowerCase();
    slim = slim.filter((r) => String(r.name ?? "").toLowerCase().includes(q));
  }
  slim.sort((a, b) => {
    // Datas ausentes sempre por último, em ambas as direções.
    const da = typeof a.dateUtc === "string" && a.dateUtc.length > 0 ? a.dateUtc : null;
    const db = typeof b.dateUtc === "string" && b.dateUtc.length > 0 ? b.dateUtc : null;
    if (da === null && db === null) return 0;
    if (da === null) return 1;
    if (db === null) return -1;
    const cmp = da.localeCompare(db);
    return upcoming ? cmp : -cmp;
  });
  return { upcoming, count: slim.length, results: slim.slice(0, limit) };
}

export async function getSpaceXLaunch(id: string) {
  const clean = id.trim();
  if (!clean) throw new Error("get_spacex_launch requires a non-empty id.");
  const url = `${SPACEX_BASE}/launches/${encodeURIComponent(clean)}`;
  try {
    const data = await fetchJson<Record<string, unknown>>(url, "SpaceX launch detail", 5 * 60_000);
    return normalizeSpaceXLaunch(data);
  } catch (err) {
    spaceXError("get_spacex_launch", err);
  }
}
