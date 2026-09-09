// Proactive per-provider RPM (requests per minute) limiter.
//
// Cloudflare Workers isolates have isolated memory, so this sliding window is
// per-isolate — NOT a global counter. That is sufficient here because:
// - The Cron handler processes customers strictly sequentially
//   (BATCH_SIZE = 1 + INTER_CUSTOMER_DELAY_MS), all inside one isolate.
// - Admin-triggered outreach generation usually lands on the same isolate,
//   so analysis + outreach share the same buckets instead of jointly
//   exceeding an upstream free tier.
// The reactive layer (429 capture + api_key_health cooldown in D1) remains
// the global safety net; this limiter exists so we rarely trigger 429 at all,
// which is what protects free-tier accounts from repeated rate-limit bans.
//
// Free-tier upstream limits are enforced PER KEY (per account), and this
// project pools multiple keys per provider. The aggregate provider cap is
// therefore per-key RPM x number of configured keys, unless overridden via
// the optional <PROVIDER>_RPM secret (interpreted as the TOTAL provider RPM).

export type ProviderId =
  | "gemini"
  | "groq"
  | "cerebras"
  | "mistral"
  | "deepseek"
  | "zhipu"
  | "nvidia"
  | "openrouter";

// Conservative per-key free-tier RPM (well below the official caps so brief
// bursts never hard-hit the upstream limit):
// - gemini: flash-lite 15 RPM, flash 10 RPM -> use the stricter one
// - groq: 30 RPM official -> 25
// - cerebras: 30 RPM official free tier -> 25
// - mistral: free tier allows ~1 req/s -> 20 keeps a wide margin
// - deepseek: paid API without a documented RPM cap -> effectively off
// - zhipu: GLM-4-Flash is permanently free, concurrency-capped -> 15
// - nvidia: NIM free endpoint ~40 RPM default -> 30 (credits are finite,
//   so it sits late in the fallback chain)
// - openrouter: :free models ~20 RPM -> 15
export const PER_KEY_RPM: Record<ProviderId, number> = {
  gemini: 10,
  groq: 25,
  cerebras: 25,
  mistral: 20,
  deepseek: 100,
  zhipu: 15,
  nvidia: 30,
  openrouter: 15,
};

const WINDOW_MS = 60_000;

// provider -> timestamps of requests inside the current minute
const buckets = new Map<string, number[]>();

function parseRpmOverride(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Read the optional total-RPM override secret for a provider from env. */
export function rpmEnvOverride(
  env: {
    GEMINI_RPM?: string;
    GROQ_RPM?: string;
    CEREBRAS_RPM?: string;
    MISTRAL_RPM?: string;
    DEEPSEEK_RPM?: string;
    ZHIPU_RPM?: string;
    NVIDIA_RPM?: string;
    OPENROUTER_RPM?: string;
  },
  provider: ProviderId,
): string | undefined {
  switch (provider) {
    case "gemini": return env.GEMINI_RPM;
    case "groq": return env.GROQ_RPM;
    case "cerebras": return env.CEREBRAS_RPM;
    case "mistral": return env.MISTRAL_RPM;
    case "deepseek": return env.DEEPSEEK_RPM;
    case "zhipu": return env.ZHIPU_RPM;
    case "nvidia": return env.NVIDIA_RPM;
    case "openrouter": return env.OPENROUTER_RPM;
  }
}

/**
 * Aggregate RPM cap for a provider: per-key free-tier RPM scaled by the size
 * of the configured key pool, or the explicit total override when provided.
 */
export function rpmLimitFor(provider: ProviderId, keyCount: number, totalOverride?: string): number {
  const overridden = parseRpmOverride(totalOverride);
  if (overridden !== null) return overridden;
  return PER_KEY_RPM[provider] * Math.max(1, keyCount);
}

/**
 * Try to consume one RPM slot for `provider`.
 * Returns true when the call may proceed; false when the provider has reached
 * its per-minute cap and the caller should skip to the next provider instead
 * of risking an upstream 429.
 */
export function tryAcquireRpmSlot(provider: ProviderId, limit: number): boolean {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const timestamps = (buckets.get(provider) ?? []).filter((t) => t > windowStart);
  if (timestamps.length >= limit) {
    buckets.set(provider, timestamps);
    return false;
  }
  timestamps.push(now);
  buckets.set(provider, timestamps);
  return true;
}

/** Test-only: clear all in-memory RPM buckets (window state is per-isolate). */
export function resetRpmBuckets(): void {
  buckets.clear();
}
