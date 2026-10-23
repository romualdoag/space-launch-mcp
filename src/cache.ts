import { DatabaseSync } from "node:sqlite";
import path from "node:path";

/**
 * Cache frio persistente (SQLite via `node:sqlite`, KV genérico) para o
 * registry quase estático do Launch Library 2.
 *
 * Quente vs frio:
 * - Quente (memória, `service.ts`): upcoming/recent — LL2 upcoming 60s,
 *   SpaceX/RLL/SFN 5min. Dado vivo nunca vai pro frio.
 * - Frio (este arquivo): locations, pads, agencies (TTL 30d = 720h),
 *   launch detail passado (TTL 30d) e listagens cuja janela terminou no
 *   passado (imutáveis → TTL infinito).
 *
 * Fail-soft: qualquer erro de SQLite (cwd read-only, lock, schema) desliga
 * o cache e segue direto pro upstream. Cache nunca quebra chamada.
 * Dados de terceiros ficam fora do git (`*.sqlite*` no `.gitignore`).
 */

export const REGISTRY_TTL_HOURS_DEFAULT = 720; // 30 dias
export const LAUNCH_DETAIL_TTL_HOURS_DEFAULT = 720; // 30 dias

/** TTL do registry (locations/pads/agencies). Env `SPACE_LAUNCH_REGISTRY_TTL_HOURS`. */
export function registryCacheTtlHours(): number {
  const raw = Number(process.env.SPACE_LAUNCH_REGISTRY_TTL_HOURS ?? REGISTRY_TTL_HOURS_DEFAULT);
  return Number.isFinite(raw) && raw >= 0 ? raw : REGISTRY_TTL_HOURS_DEFAULT;
}

/** TTL do launch detail passado. Env `SPACE_LAUNCH_DETAIL_TTL_HOURS`. */
export function launchDetailCacheTtlHours(): number {
  const raw = Number(process.env.SPACE_LAUNCH_DETAIL_TTL_HOURS ?? LAUNCH_DETAIL_TTL_HOURS_DEFAULT);
  return Number.isFinite(raw) && raw >= 0 ? raw : LAUNCH_DETAIL_TTL_HOURS_DEFAULT;
}

let dbPathOverride: string | undefined;
let db: DatabaseSync | null = null;

export function isColdCacheEnabled(): boolean {
  return process.env.SPACE_LAUNCH_CACHE_ENABLED !== "0";
}

function coldDbPath(): string {
  return (
    dbPathOverride ??
    process.env.SPACE_LAUNCH_CACHE_PATH ??
    path.join(process.cwd(), "space-launch-cache.sqlite")
  );
}

/** Test hook: aponta o cache pra outro arquivo (ou `':memory:'`). */
export function __resetColdCacheForTests(dbPath = ":memory:"): void {
  closeColdCache();
  dbPathOverride = dbPath;
}

export function closeColdCache(): void {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
}

function getDb(): DatabaseSync | null {
  if (!isColdCacheEnabled()) return null;
  if (db) return db;
  try {
    const opened = new DatabaseSync(coldDbPath());
    opened.exec("PRAGMA journal_mode=WAL");
    opened.exec("PRAGMA busy_timeout=5000");
    opened.exec(`
      CREATE TABLE IF NOT EXISTS kv_cache (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
    `);
    db = opened;
    return db;
  } catch {
    // Fail-soft: cwd read-only ou arquivo travado nunca quebra a chamada.
    return null;
  }
}

/**
 * Lê do KV se fresco; `undefined` = miss, expirado, desligado ou erro.
 * `ttlHours = Infinity` = nunca expira (janela passada, dado imutável).
 */
export function kvGet(key: string, ttlHours: number): unknown | undefined {
  const store = getDb();
  if (!store) return undefined;
  try {
    const row = store
      .prepare("SELECT value_json AS valueJson, fetched_at AS fetchedAt FROM kv_cache WHERE key = ?")
      .get(key) as { valueJson: string; fetchedAt: string } | undefined;
    if (!row) return undefined;
    if (Number.isFinite(ttlHours)) {
      const ageMs = Date.now() - Date.parse(row.fetchedAt);
      if (!Number.isFinite(ageMs) || ageMs > ttlHours * 3_600_000) return undefined;
    }
    return JSON.parse(row.valueJson) as unknown;
  } catch {
    return undefined;
  }
}

/** Grava no KV (fail-soft). */
export function kvSet(key: string, value: unknown): void {
  const store = getDb();
  if (!store) return;
  try {
    store
      .prepare("INSERT OR REPLACE INTO kv_cache (key, value_json, fetched_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(value), new Date().toISOString());
  } catch {
    /* fail-soft */
  }
}

/** Verdadeiro quando a janela pedida termina no passado (listagem imutável → frio infinito). */
export function isWindowInPast(opts: { windowStartLte?: string }): boolean {
  const raw = opts.windowStartLte?.trim();
  if (!raw) return false;
  const t = Date.parse(raw.replace(" ", "T"));
  return Number.isFinite(t) && t < Date.now();
}

/** Verdadeiro quando o detalhe do lançamento já aconteceu (net/window no passado). */
export function isPastLaunch(detail: {
  net?: string | null;
  windowEnd?: string | null;
  windowStart?: string | null;
}): boolean {
  const cand = detail.windowEnd ?? detail.net ?? detail.windowStart;
  if (!cand) return false;
  const t = Date.parse(cand);
  return Number.isFinite(t) && t < Date.now();
}
