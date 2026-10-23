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
/**
 * Versão do namespace das chaves frias. Leituras tentam `v1:…` primeiro e
 * caem pra chave legada (sem prefixo) — DBs antigos continuam válidos.
 * Escritas vão sempre pra `v1:…`.
 */
export const COLD_CACHE_VERSION = "v1";
/** Janela stale-while-revalidate do detalhe passado além do TTL (30d). */
export const LAUNCH_DETAIL_STALE_EXTRA_HOURS_DEFAULT = 720; // 30 dias

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

/** Janela extra (stale) p/ revalidação ocasional do detalhe passado. Env `SPACE_LAUNCH_DETAIL_STALE_EXTRA_HOURS`. */
export function launchDetailStaleExtraHours(): number {
  const raw = Number(
    process.env.SPACE_LAUNCH_DETAIL_STALE_EXTRA_HOURS ?? LAUNCH_DETAIL_STALE_EXTRA_HOURS_DEFAULT,
  );
  return Number.isFinite(raw) && raw >= 0 ? raw : LAUNCH_DETAIL_STALE_EXTRA_HOURS_DEFAULT;
}

/** Normaliza a chave fria pro namespace versionado (`v1:…`). Idempotente. */
export function coldKey(key: string): string {
  return key.startsWith(`${COLD_CACHE_VERSION}:`) ? key : `${COLD_CACHE_VERSION}:${key}`;
}

/** Chave legada (pré-v1), pra fallback de leitura em DBs antigos. */
export function legacyColdKey(key: string): string {
  return key.startsWith(`${COLD_CACHE_VERSION}:`) ? key.slice(COLD_CACHE_VERSION.length + 1) : key;
}

/** Hash leve (FNV-1a 32-bit, hex) do JSON serializado — detecção barata de mudança. */
export function contentHashOf(serialized: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < serialized.length; i++) {
    h ^= serialized.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
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

export type KvSeedOpts = {
  /** Grava na chave exata (simula DB pré-v1). Padrão grava em `v1:…`. */
  legacy?: boolean;
  /** Idade simulada da linha (ms) — pra exercitar TTL/stale sem esperar. */
  ageMs?: number;
  etag?: string | null;
  lastModified?: string | null;
};

/** Test hook: planta uma linha fria com idade/validadores controlados. */
export function __kvSeedForTests(key: string, value: unknown, opts: KvSeedOpts = {}): void {
  const store = getDb();
  if (!store) return;
  const serialized = JSON.stringify(value);
  const fetchedAt = new Date(Date.now() - (opts.ageMs ?? 0)).toISOString();
  store
    .prepare(
      "INSERT OR REPLACE INTO kv_cache (key, value_json, fetched_at, etag, last_modified, content_hash) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      opts.legacy ? legacyColdKey(key) : coldKey(key),
      serialized,
      fetchedAt,
      opts.etag ?? null,
      opts.lastModified ?? null,
      contentHashOf(serialized),
    );
}

export function closeColdCache(): void {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
}

function ensureColumn(store: DatabaseSync, table: string, col: string, ddl: string): void {
  const cols = store.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === col)) store.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
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
        fetched_at TEXT NOT NULL,
        etag TEXT,
        last_modified TEXT,
        content_hash TEXT
      );
    `);
    // Migração suave: DBs pré-v1 ganham as colunas sem perder dados.
    ensureColumn(opened, "kv_cache", "etag", "TEXT");
    ensureColumn(opened, "kv_cache", "last_modified", "TEXT");
    ensureColumn(opened, "kv_cache", "content_hash", "TEXT");
    db = opened;
    return db;
  } catch {
    // Fail-soft: cwd read-only ou arquivo travado nunca quebra a chamada.
    return null;
  }
}

export type ColdMeta = {
  value: unknown;
  /** Idade da linha em ms (Infinity quando fetched_at é inválido). */
  ageMs: number;
  fetchedAt: string;
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  /** Verdadeiro quando veio da chave legada (sem `v1:`) — migre na próxima escrita. */
  legacy: boolean;
};

type KvRow = {
  valueJson: string;
  fetchedAt: string;
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
};

function readRow(store: DatabaseSync, key: string): (KvRow & { legacy: boolean }) | undefined {
  // Namespace versionado primeiro; chave legada como fallback (DBs pré-v1).
  for (const [candidate, legacy] of [
    [coldKey(key), false],
    [legacyColdKey(key), true],
  ] as const) {
    try {
      const row = store
        .prepare(
          "SELECT value_json AS valueJson, fetched_at AS fetchedAt, etag, last_modified AS lastModified, content_hash AS contentHash FROM kv_cache WHERE key = ?",
        )
        .get(candidate) as KvRow | undefined;
      if (row) return { ...row, legacy };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function rowToMeta(row: KvRow & { legacy: boolean }): ColdMeta | undefined {
  let value: unknown;
  try {
    value = JSON.parse(row.valueJson) as unknown;
  } catch {
    return undefined;
  }
  const age = Date.now() - Date.parse(row.fetchedAt);
  return {
    value,
    ageMs: Number.isFinite(age) ? age : Number.POSITIVE_INFINITY,
    fetchedAt: row.fetchedAt,
    etag: typeof row.etag === "string" ? row.etag : null,
    lastModified: typeof row.lastModified === "string" ? row.lastModified : null,
    contentHash: typeof row.contentHash === "string" ? row.contentHash : null,
    legacy: row.legacy,
  };
}

/**
 * Lê a linha fria com metadados, sem filtro de TTL (`undefined` = miss,
 * desligado ou erro). Tenta `v1:…` antes da chave legada.
 */
export function kvGetWithMeta(key: string): ColdMeta | undefined {
  const store = getDb();
  if (!store) return undefined;
  const row = readRow(store, key);
  if (!row) return undefined;
  return rowToMeta(row);
}

/**
 * Lê do KV se fresco; `undefined` = miss, expirado, desligado ou erro.
 * `ttlHours = Infinity` = nunca expira (janela passada, dado imutável).
 */
export function kvGet(key: string, ttlHours: number): unknown | undefined {
  const meta = kvGetWithMeta(key);
  if (!meta) return undefined;
  if (Number.isFinite(ttlHours) && meta.ageMs > ttlHours * 3_600_000) return undefined;
  return meta.value;
}

export type KvSetMeta = { etag?: string | null; lastModified?: string | null };

/** Grava no KV sob a chave `v1:…` (fail-soft). O content-hash é derivado do JSON. */
export function kvSet(key: string, value: unknown, meta?: KvSetMeta): void {
  const store = getDb();
  if (!store) return;
  try {
    const serialized = JSON.stringify(value);
    store
      .prepare(
        "INSERT OR REPLACE INTO kv_cache (key, value_json, fetched_at, etag, last_modified, content_hash) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        coldKey(key),
        serialized,
        new Date().toISOString(),
        meta?.etag ?? null,
        meta?.lastModified ?? null,
        contentHashOf(serialized),
      );
  } catch {
    /* fail-soft */
  }
}

/**
 * Renova `fetched_at` da linha (TTL estendido) mantendo valor e validadores.
 * Migra legado → `v1:…`. Usado após 304, revalidação sem validadores ou
 * falha de rede (fail-soft: não martela o upstream a cada chamada).
 */
export function kvTouch(key: string): void {
  const meta = kvGetWithMeta(key);
  if (meta === undefined) return;
  kvSet(legacyColdKey(key), meta.value, { etag: meta.etag, lastModified: meta.lastModified });
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
