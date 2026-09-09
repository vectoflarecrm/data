// 方案B: D1-native provider configuration.
//
// Provider state lives in D1 (api_configs + provider_settings) and is managed
// from the admin panel at runtime — adding a Groq key or disabling a provider
// takes effect on the next request with no redeploy and no GitHub/CLI touch.
//
// Resolution order per provider:
//   1. D1 api_configs rows (is_active = 1)   — panel-managed, dynamic
//   2. env secrets (<PROVIDER>_API_KEY pool) — bootstrap/fallback source
//
// A short in-isolate cache (30s) keeps the per-request D1 overhead at zero for
// bursty batches; cooldown/exhaustion state still lives in api_key_health.

export interface ProviderKeyEntry {
  key: string;
  model: string | null; // per-key model override
  rpmLimit: number | null; // per-key RPM override
  source: "d1" | "env";
  // Stable identity for api_key_health cooldown tracking. D1 keys use their
  // row id (stable across reordering); env keys fall back to pool position.
  keyId: number;
}

// Cooldown registry uses "<provider>:<keyId>" so cooldowns survive panel edits
// (delete/reorder api_configs rows) and D1/env keys never collide. Safe even
// though D1 ids and env pool positions are both numeric: a provider's key list
// comes from exactly one source at a time (D1 rows XOR env secrets).
export function keyHealthName(provider: string, entry: ProviderKeyEntry): string {
  return `${provider}:${entry.keyId}`;
}

export interface ProviderState {
  provider: string;
  keys: ProviderKeyEntry[];
  defaultModel: string | null; // provider_settings.default_model
  rpmTotal: number | null; // provider_settings.rpm_total override
  enabled: boolean; // provider_settings.enabled (default true)
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { state: ProviderState; at: number }>();

// Minimal structural view of D1Database to avoid importing workers-types here.
interface MinimalDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results?: T[] }>;
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}
interface EnvWithDb {
  DB?: MinimalDb;
  [key: string]: unknown;
}

// Providers that live in api_configs. Search engines use the same mechanism.
export const D1_PROVIDERS = [
  "gemini", "groq", "cerebras", "zhipu", "nvidia", "amd", "mistral", "deepseek", "openrouter",
  "tavily", "exa", "brave", "searlo",
] as const;

interface ApiConfigRow {
  id?: number;
  api_key: string;
  model: string | null;
  rpm_limit: number | null;
}

interface ProviderSettingsRow {
  default_model: string | null;
  rpm_total: number | null;
  enabled: number;
}

function collectEnvKeys(env: Record<string, unknown>, provider: string, maxKeys = 40): string[] {
  const keys: string[] = [];
  const base = `${provider.toUpperCase()}_API_KEY`;
  for (let i = 1; i <= maxKeys; i++) {
    const name = i === 1 ? base : `${base}_${i}`;
    const value = env[name];
    if (typeof value === "string" && value.trim()) keys.push(value.trim());
  }
  return keys;
}

/**
 * Resolve the full state for a provider: D1 rows first, env secrets as
 * fallback when D1 has no keys. Cached for 30s per isolate.
 */
export async function getProviderState(env: unknown, provider: string): Promise<ProviderState> {
  const cached = cache.get(provider);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.state;

  const e = env as Record<string, unknown>;
  const db = (env as EnvWithDb).DB;
  let state: ProviderState;

  if (db) {
    try {
      const [configs, settings] = await Promise.all([
        db.prepare(`SELECT api_key, model, rpm_limit FROM api_configs WHERE provider = ? AND is_active = 1 ORDER BY id`)
          .bind(provider).all<ApiConfigRow>(),
        db.prepare(`SELECT default_model, rpm_total, enabled FROM provider_settings WHERE provider = ?`)
          .bind(provider).first<ProviderSettingsRow>(),
      ]);
      const d1Keys: ProviderKeyEntry[] = (configs.results ?? []).map((row) => ({
        key: row.api_key,
        model: row.model,
        rpmLimit: row.rpm_limit,
        source: "d1" as const,
        keyId: row.id ?? 0,
      }));
      // Env secrets are the bootstrap fallback when the panel has no keys yet.
      const envKeys: ProviderKeyEntry[] = d1Keys.length === 0
        ? collectEnvKeys(e, provider).map((key, i) => ({ key, model: null, rpmLimit: null, source: "env" as const, keyId: i + 1 }))
        : [];
      state = {
        provider,
        keys: [...d1Keys, ...envKeys],
        defaultModel: settings?.default_model ?? null,
        rpmTotal: settings?.rpm_total ?? null,
        enabled: settings ? settings.enabled === 1 : true,
      };
    } catch {
      // D1 hiccup or table not yet migrated: fall back to env-only, no cache
      // so a recovered database is picked up on the next request.
      state = {
        provider,
        keys: collectEnvKeys(e, provider).map((key, i) => ({ key, model: null, rpmLimit: null, source: "env" as const, keyId: i + 1 })),
        defaultModel: null,
        rpmTotal: null,
        enabled: true,
      };
      return state; // don't cache error-path results
    }
  } else {
    state = {
      provider,
      keys: collectEnvKeys(e, provider).map((key, i) => ({ key, model: null, rpmLimit: null, source: "env" as const, keyId: i + 1 })),
      defaultModel: null,
      rpmTotal: null,
      enabled: true,
    };
  }

  cache.set(provider, { state, at: Date.now() });
  return state;
}

/** Invalidate the cached state after panel writes (same isolate, immediate). */
export function invalidateProviderCache(provider?: string): void {
  if (provider) cache.delete(provider);
  else cache.clear();
}

/** True when the provider is disabled or has no usable keys. */
export function isProviderUsable(state: ProviderState): boolean {
  return state.enabled && state.keys.length > 0;
}

/**
 * Best-effort: record the last error on the D1 row so the panel shows why a
 * key stopped working. Silent no-op for env-sourced keys or DB failures.
 */
export async function noteProviderKeyError(env: unknown, provider: string, entry: ProviderKeyEntry, error: string): Promise<void> {
  if (entry.source !== "d1" || !entry.keyId) return;
  try {
    const db = (env as EnvWithDb).DB;
    if (!db) return;
    await db.prepare(`UPDATE api_configs SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(error.slice(0, 200), entry.keyId).run();
  } catch { /* best effort */ }
}

/** Clear the error flag when a key works again. */
export async function noteProviderKeySuccess(env: unknown, provider: string, entry: ProviderKeyEntry): Promise<void> {
  if (entry.source !== "d1" || !entry.keyId) return;
  try {
    const db = (env as EnvWithDb).DB;
    if (!db) return;
    await db.prepare(`UPDATE api_configs SET last_error = NULL, last_used_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(entry.keyId).run();
  } catch { /* best effort */ }
}
