/*
 * Security V2 Stage 9 — Audit log (spec §10).
 *
 * Every important operation (spec §10.1 action list) produces one row in
 * `audit_logs`: who acted, what happened, which resource, and hashed
 * client fingerprints. Two hard rules shape this module:
 *
 * §10.2 — secret values (API keys, OAuth tokens, private keys, refresh
 * tokens, passwords, session tokens) must NEVER reach the audit table.
 * `redactAuditMetadata()` enforces this defensively at the write boundary:
 * any metadata key whose normalized name matches the denylist is stored as
 * "[REDACTED]" regardless of what a caller passed. Callers still avoid
 * putting secrets in metadata by construction — the redactor is the
 * seatbelt, not the steering wheel.
 *
 * Fail-open policy — an audit write must never break the business action
 * it describes: the INSERT is awaited (so tests can assert ordering) but
 * every error is swallowed. A missing `audit_logs` table (migration not
 * yet applied) is a silent no-op so the pre-migration window and local
 * test fixtures without the table stay quiet; any other D1 failure is
 * logged to the structured console (`wrangler tail`) but the response
 * still goes out.
 */

/** Subset of the worker env the audit trail needs. */
export interface AuditEnv {
  DB: D1Database;
}

/** Metadata values are limited to JSON-safe scalars, arrays and objects. */
export type AuditMetadataValue =
  | string
  | number
  | boolean
  | null
  | AuditMetadata
  | AuditMetadataValue[];

export interface AuditMetadata {
  [key: string]: AuditMetadataValue;
}

export interface AuditEvent {
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  /** Correlates with the Stage 20 request id once that middleware lands. */
  requestId?: string | null;
  metadata?: AuditMetadata | null;
}

/** §10.2 denylist, matched against normalized keys (api_key → apikey). */
const SECRET_KEY_NAMES = new Set([
  "apikey", "privatekey", "clientsecret", "refreshtoken", "accesstoken",
  "password", "sessiontoken", "token", "secret", "credential", "credentials",
  "authorization", "bearer", "cookie",
]);

const REDACTED = "[REDACTED]";
const MAX_METADATA_JSON = 4096;
const MAX_METADATA_DEPTH = 4;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Defensive §10.2 filter. Walks the metadata tree; any key whose normalized
 * name is in the denylist is replaced with "[REDACTED]". Depth beyond
 * MAX_METADATA_DEPTH collapses to the same marker, and the serialized result
 * is truncated to MAX_METADATA_JSON so a huge metadata blob cannot turn the
 * audit table into a storage vector.
 */
export function redactAuditMetadata(value: AuditMetadataValue | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  let json = safeStringify(redactValue(value, 0));
  if (json.length <= MAX_METADATA_JSON) return json;
  // Second pass: clip every string leaf so oversized metadata stays parseable
  // (a raw slice would leave broken JSON in the trail).
  json = safeStringify(clipStringLeaves(redactValue(value, 0)));
  if (json.length <= MAX_METADATA_JSON) return json;
  // Pathological input (deep nesting of many keys): store a marker instead of
  // letting the audit table become a storage vector.
  return JSON.stringify({ truncated: true, original_bytes: json.length });
}

function safeStringify(value: AuditMetadataValue): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? REDACTED : json;
  } catch {
    return REDACTED;
  }
}

const MAX_CLIPPED_STRING = 200;

function clipStringLeaves(value: AuditMetadataValue): AuditMetadataValue {
  if (typeof value === "string") {
    return value.length > MAX_CLIPPED_STRING ? value.slice(0, MAX_CLIPPED_STRING) + "…" : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => clipStringLeaves(v));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, AuditMetadataValue> = {};
    for (const key of Object.keys(value as Record<string, AuditMetadataValue>)) {
      out[key] = clipStringLeaves((value as Record<string, AuditMetadataValue>)[key]);
    }
    return out;
  }
  return value;
}

function redactValue(value: AuditMetadataValue, depth: number): AuditMetadataValue {
  if (depth >= MAX_METADATA_DEPTH) return REDACTED;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, AuditMetadataValue> = {};
    for (const key of Object.keys(value as Record<string, AuditMetadataValue>)) {
      if (SECRET_KEY_NAMES.has(normalizeKey(key))) {
        out[key] = REDACTED;
      } else {
        out[key] = redactValue((value as Record<string, AuditMetadataValue>)[key], depth + 1);
      }
    }
    return out;
  }
  return REDACTED;
}

/** CF edge sets this header; clients cannot forge it (see admin.ts loginIdent). */
function clientIp(request: Request): string {
  const raw = request.headers.get("CF-Connecting-IP")?.trim() ?? "";
  return /^[0-9a-fA-F:.]{3,45}$/.test(raw) ? raw.toLowerCase() : "unknown";
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Write one audit row. `request` may be null (cron/system context — the
 * fingerprint columns stay null). Fail-open: errors never propagate.
 */
export async function writeAuditLog(
  env: AuditEnv,
  request: Request | null,
  event: AuditEvent,
): Promise<void> {
  try {
    const ipHash = request ? await sha256Hex(clientIp(request)) : null;
    const userAgentHash = request ? await sha256Hex(request.headers.get("User-Agent") ?? "") : null;
    await env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, actor_role, action, resource_type, resource_id, request_id, metadata_json, ip_hash, user_agent_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      event.actorUserId,
      event.actorRole,
      event.action,
      event.resourceType,
      event.resourceId,
      event.requestId ?? null,
      redactAuditMetadata(event.metadata ?? null),
      ipHash,
      userAgentHash,
      new Date().toISOString().slice(0, 19).replace("T", " "),
    ).run();
  } catch (e) {
    // Pre-migration window (and test fixtures that never create the table):
    // audit is a no-op, same fail-open stance as the rest of the module.
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("no such table")) return;
    console.error(`[audit] write failed action=${event.action} resource=${event.resourceType}`, e);
  }
}
