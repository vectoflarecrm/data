// Generic key-pool collection: instead of enumerating XXX_API_KEY through
// XXX_API_KEY_40 in Env interfaces and collector functions per provider, this
// reads indexed keys directly from the runtime env object. Cloudflare injects
// every secret (GEMINI_API_KEY_7, TAVILY_API_KEY_23, ...) onto env, so a loop
// discovers exactly the keys that are configured — no code change needed when
// the pool grows from 1 to 40 keys.

/**
 * Collect `<PREFIX>_API_KEY`, `<PREFIX>_API_KEY_2` … `<PREFIX>_API_KEY_N`
 * from the runtime env, preserving index order (skipping unset entries).
 */
export function collectKeyPool(env: object, prefix: string, maxKeys = 40): string[] {
  const keys: string[] = [];
  const base = `${prefix}_API_KEY`;
  for (let i = 1; i <= maxKeys; i++) {
    const name = i === 1 ? base : `${base}_${i}`;
    const value = (env as Record<string, unknown>)[name];
    if (typeof value === "string" && value.trim()) keys.push(value.trim());
  }
  return keys;
}

export interface KeyPoolAttempt {
  apiKey: string;
  healthName: string;
}

/**
 * Build the per-task key order for a provider:
 * - ONE fixed key per company task (start index derived from customer id), so a
 *   single task never hops between accounts (anti-ban).
 * - Keys known to be exhausted (D1 health table, by health name) are excluded.
 * - The remaining keys follow in rotation order as rare fallbacks.
 *
 * `healthNames[i]` must be the health identity of `entries[i]` — see
 * keyHealthName() in provider-keys.ts ("<provider>:<keyId>").
 */
export function buildKeyOrder(
  entries: Array<{ key: string }>,
  healthNames: string[],
  startIndex: number,
  exhausted: Set<string>,
): KeyPoolAttempt[] {
  const healthy = entries
    .map((entry, i) => ({ apiKey: entry.key, healthName: healthNames[i] }))
    .filter((k) => !exhausted.has(k.healthName));
  if (healthy.length === 0) return [];
  const start = ((startIndex % healthy.length) + healthy.length) % healthy.length;
  return [...healthy.slice(start), ...healthy.slice(0, start)];
}
