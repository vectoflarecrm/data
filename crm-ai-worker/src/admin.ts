import {
  getBrandSettings,
  updateBrandSetting,
  generateOutreachEmails,
  getOutreachEmails,
  updateOutreachEmail,
  deleteOutreachEmail,
  getOutreachStats,
  attachmentLangForCountry,
} from "./outreach";
import {
  getQuota,
  sendDelayMs,
  getAccessToken,
  noteGmailAccountResult,
  GmailEnv,
  GmailConfigError,
} from "./gmail";
import { sendWithStateMachine } from "./outreach-send";
import { invalidateProviderCache } from "./provider-keys";
import {
  encryptSecret,
  decryptSecret,
  tryDecryptSecret,
  getPreviousEncKeys,
  requireEncKeys,
  type CredentialKeys,
  isEncrypted,
  fingerprint,
  isEncryptionConfigured,
  suggestEncKey,
  hintFor,
} from "./credential-crypto";
import { parseBulkKeyEntries } from "./bulk-keys";
import { readSavedResearchText } from "./research-run";
import {
  parseSegmentFilters,
  segmentClause,
  previewSegment,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  listCampaigns,
  getCampaign,
  listCampaignMembers,
  createCampaign,
  setCampaignStatus,
  setCampaignAutoAdvance,
  deleteCampaign,
  runCampaignGenerate,
  runCampaignSend,
  deserializeFilters,
} from "./campaigns";
import { CampaignLockedError } from "./campaign-lock";
import { handleCrmApi } from "./crm";
import { buildFilterOptions } from "./facets";
import { LEAD_SCORE_WEIGHTS } from "./lead-score-dims";
import {
  loadLeadScoreConfig,
  loadLeadScoreWeights,
  saveLeadScoreWeights,
  parseLeadScoreWeights,
} from "./lead-score-config";
import { computeLeadScoreV2, type LeadScoreInputs } from "./lead-score-engine";
import { roleHasPermission, requiredPermission } from "./auth/rbac";
import { applySecurityHeaders, htmlCsp } from "./security-headers";
import { originGuardRejection } from "./security/origin-guard";
import { sanitizeResponse } from "./security/redaction";
import { safeLog } from "./security/safe-log";
import { setRequestId, getRequestId } from "./security/request-context";
import { checkCloudflareAccess } from "./security/cf-access";
import { readCsvImportBody, parseCsvBounded, CsvLimitError } from "./security/csv-limits";
import { writeAuditLog, AuditMetadata } from "./audit/audit-log";
import {
  WebAuthnError,
  rpConfig,
  issueChallenge,
  consumeChallenge,
  countActiveCredentials,
  listCredentialDescriptors,
  verifyRegistrationResponse,
  verifyAssertionResponse,
  generateRecoveryCodes,
  sha256HexOf,
} from "./auth/webauthn";

export interface AdminEnv extends GmailEnv {
  DB: D1Database;
  ADMIN_PANEL_TOKEN?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_API_KEY_2?: string;
  GEMINI_API_KEY_3?: string;
  GEMINI_API_KEY_4?: string;
  GEMINI_API_KEY_5?: string;
  GEMINI_API_KEY_6?: string;
  GEMINI_API_KEY_7?: string;
  GEMINI_API_KEY_8?: string;
  GEMINI_API_KEY_9?: string;
  GEMINI_API_KEY_10?: string;
  GEMINI_API_KEY_11?: string;
  GEMINI_API_KEY_12?: string;
  GEMINI_API_KEY_13?: string;
  GEMINI_API_KEY_14?: string;
  GEMINI_API_KEY_15?: string;
  GEMINI_API_KEY_16?: string;
  GEMINI_API_KEY_17?: string;
  GEMINI_API_KEY_18?: string;
  GEMINI_API_KEY_19?: string;
  GEMINI_API_KEY_20?: string;
  GEMINI_API_KEY_21?: string;
  GEMINI_API_KEY_22?: string;
  GEMINI_API_KEY_23?: string;
  GEMINI_API_KEY_24?: string;
  GEMINI_API_KEY_25?: string;
  GEMINI_API_KEY_26?: string;
  GEMINI_API_KEY_27?: string;
  GEMINI_API_KEY_28?: string;
  GEMINI_API_KEY_29?: string;
  GEMINI_API_KEY_30?: string;
  GEMINI_API_KEY_31?: string;
  GEMINI_API_KEY_32?: string;
  GEMINI_API_KEY_33?: string;
  GEMINI_API_KEY_34?: string;
  GEMINI_API_KEY_35?: string;
  GEMINI_API_KEY_36?: string;
  GEMINI_API_KEY_37?: string;
  GEMINI_API_KEY_38?: string;
  GEMINI_API_KEY_39?: string;
  GEMINI_API_KEY_40?: string;
  GROQ_API_KEY?: string;
  GROQ_API_KEY_2?: string;
  GROQ_MODEL?: string;
  CEREBRAS_API_KEY?: string;
  CEREBRAS_API_KEY_2?: string;
  CEREBRAS_MODEL?: string;
  ZHIPU_API_KEY?: string;
  ZHIPU_API_KEY_2?: string;
  ZHIPU_MODEL?: string;
  NVIDIA_API_KEY?: string;
  NVIDIA_API_KEY_2?: string;
  NVIDIA_MODEL?: string;
  AMD_API_KEY?: string;
  AMD_API_KEY_2?: string;
  AMD_MODEL?: string;
  MISTRAL_API_KEY?: string;
  MISTRAL_API_KEY_2?: string;
  MISTRAL_MODEL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_API_KEY_2?: string;
  DEEPSEEK_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_API_KEY_2?: string;
  OPENROUTER_API_KEY_3?: string;
  OPENROUTER_MODEL?: string;
  BRAVE_API_KEY?: string;
  BRAVE_API_KEY_2?: string;
  FIRECRAWL_API_KEY?: string;
  // Optional total-RPM limiter overrides (see src/rate-limit.ts)
  GEMINI_RPM?: string;
  GROQ_RPM?: string;
  CEREBRAS_RPM?: string;
  MISTRAL_RPM?: string;
  DEEPSEEK_RPM?: string;
  ZHIPU_RPM?: string;
  NVIDIA_RPM?: string;
  AMD_RPM?: string;
  OPENROUTER_RPM?: string;
  // Post-V2 Stage 29 (WebAuthn 2FA): RP ID unset ⇒ the feature is dormant.
  // While the bootstrap user holds an active credential, the Bearer
  // master-token path is closed (see authenticate()).
  WEBAUTHN_RP_ID?: string;
  WEBAUTHN_RP_NAME?: string;
  WEBAUTHN_ORIGINS?: string;
  // Post-V2 Stage 35 (Cloudflare Access perimeter): both set ⇒ every /admin
  // request must carry a valid Cf-Access-Jwt-Assertion (verified in code
  // against the team's JWKS, fail-closed); exactly one set ⇒ loud 500, so a
  // misconfiguration can never silently disable the perimeter.
  CF_ACCESS_TEAM?: string;
  CF_ACCESS_AUD?: string;
}

interface AdminCustomer {
  id: number;
  company_id: string;
  domain: string;
  status: string;
  company_name: string | null;
  legal_name: string | null;
  trading_name: string | null;
  normalized_domain: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  title: string | null;
  department: string | null;
  linkedin_url: string | null;
  street_address: string | null;
  zip_city: string | null;
  country: string | null;
  country_code: string | null;
  region: string | null;
  city: string | null;
  postal_code: string | null;
  tel: string | null;
  email: string | null;
  cellphone: string | null;
  whatsapp: string | null;
  products_services: string | null;
  business_tag: string | null;
  industry: string | null;
  company_type: string | null;
  business_model: string | null;
  founded_year: number | null;
  employee_range: string | null;
  description: string | null;
  target_markets: string | null;
  is_manufacturer: number | null;
  is_importer: number | null;
  is_distributor: number | null;
  is_wholesaler: number | null;
  is_retailer: number | null;
  is_ecommerce: number | null;
  is_rental: number | null;
  is_oem: number | null;
  social_accounts: string | null;
  /** Deprecated blob cache — Stage 38: detail views overwrite this with the
   * research_sources reconstruction (blob only as pre-Stage-36 fallback). */
  full_research_text?: string | null;
  customer_segment: string | null;
  personas_and_solutions: string | null;
  remarks: string | null;
  updated_at: string;
}

// Field-level evidence chain (docx ①): every core AI judgement carries its
// source URL, quoted text and confidence so users can verify claims without
// re-crawling. Loaded per-company from the evidence table on detail view.
interface EvidenceRow {
  id: number;
  field_name: string;
  field_value: string | null;
  source_url: string | null;
  source_type: string | null;
  evidence_text: string | null;
  confidence: number | null;
  collected_at: string;
  // Stage 14 (spec §15): 1 = current fact, 0 = superseded history row.
  is_current?: number | null;
}

/** Exported for tests (tests/evidence-v2.test.ts). */
export async function getCustomerEvidence(env: AdminEnv, companyId: string): Promise<EvidenceRow[]> {
  // Stage 14 (spec §15): evidence is append-only, so current rows are ordered
  // before superseded history within the same confidence/age ordering. Degrades
  // to the legacy query while the migration is pending (column missing).
  try {
    const result = await env.DB.prepare(
      `SELECT id, field_name, field_value, source_url, source_type, evidence_text, confidence, collected_at, is_current
       FROM evidence WHERE company_id = ? ORDER BY is_current DESC, confidence DESC, collected_at DESC LIMIT 30`,
    )
      .bind(companyId)
      .all<EvidenceRow>();
    return result.results;
  } catch (e) {
    if (e instanceof Error && e.message.includes("no such column")) {
      const legacy = await env.DB.prepare(
        `SELECT id, field_name, field_value, source_url, source_type, evidence_text, confidence, collected_at
         FROM evidence WHERE company_id = ? ORDER BY confidence DESC, collected_at DESC LIMIT 30`,
      )
        .bind(companyId)
        .all<EvidenceRow>();
      return legacy.results;
    }
    throw e;
  }
}

const CUSTOMER_COLUMNS = `
  id, company_id, display_id, domain, status, company_name, legal_name, trading_name, normalized_domain,
  first_name, last_name, full_name, title, department, linkedin_url,
  street_address, zip_city, country, country_code, region, city, postal_code,
  tel, email, cellphone, whatsapp, products_services, business_tag,
  industry, company_type, business_model, founded_year, employee_range,
  description, target_markets, is_manufacturer, is_importer, is_distributor,
  is_wholesaler, is_retailer, is_ecommerce, is_rental, is_oem, social_accounts,
  full_research_text, social_accounts_verified, customer_segment,
  product_categories, company_size, geographic_coverage,
  personas_and_solutions, remarks, updated_at,
  company_profile, outreach_context, buying_signals, lead_score, source_import_id
`;
/* Phase 3b Stage 39: list/sample queries ship a slim column set. The full
 * set above still serves the detail view (the modal renders every field
 * and the blob is the Stage 38 fallback source). Dropped here: the
 * deprecated blob plus ten columns no code path has ever written (the
 * embedded person block minus email/cellphone, and social_accounts —
 * docs/phase3b-normalization-review.md §2). cellphone stays: the panel
 * list row falls back to it next to email. */
const CUSTOMER_LIST_COLUMNS = `
  id, company_id, display_id, domain, status, company_name, legal_name, trading_name, normalized_domain,
  street_address, zip_city, country, country_code, region, city, postal_code,
  email, cellphone, products_services, business_tag,
  industry, company_type, business_model, founded_year, employee_range,
  description, target_markets, is_manufacturer, is_importer, is_distributor,
  is_wholesaler, is_retailer, is_ecommerce, is_rental, is_oem,
  social_accounts_verified, customer_segment,
  product_categories, company_size, geographic_coverage,
  personas_and_solutions, remarks, updated_at,
  company_profile, outreach_context, buying_signals, lead_score, source_import_id
`;
const CUSTOMER_STATUSES = new Set(["pending", "processing", "completed", "failed"]);

/* ── Admin sessions (Security V2 Stage 1) ────────────────────────────────
 * ADMIN_PANEL_TOKEN authenticates the login POST only (bootstrap credential,
 * per docs/security-v2-baseline.md). A successful login mints a random
 * 256-bit session token; its SHA-256 hash is the only thing stored in D1.
 * The browser holds an opaque `crm_session` cookie — the master token never
 * rides in a cookie again. */
const SESSION_COOKIE_NAME = "crm_session";
const SESSION_TTL_SECONDS = 60 * 60;
const BOOTSTRAP_USER_ID = "u_admin";
const BOOTSTRAP_USERNAME = "admin";

interface AdminUserRow {
  id: string;
  username: string;
  role: string;
  enabled: number;
}

export interface AdminAuthContext {
  user: AdminUserRow;
  /** Empty for the Bearer bootstrap path (no session row involved). */
  sessionId: string;
  /** SHA-256 hex of the presented session token; null for Bearer. */
  tokenHash: string | null;
  /** "session" = cookie session; "bootstrap" = explicit Bearer master token. */
  via: "session" | "bootstrap";
  /** Session expiry (SQL UTC), null for Bearer. */
  expiresAt: string | null;
}

function htmlResponse(body: string, status = 200): Response {
  // Stage 5 CSP: a fresh nonce per response is injected into every inline
  // <script>/<style> tag, so the panels pass script-src/style-src
  // 'nonce-…' without 'unsafe-inline' or 'unsafe-eval'. All tags in the
  // panel templates are plain (<script>/<style> with no attributes), which
  // the exact-string replaceAll relies on. Since stage 30 the panels carry
  // no style="" attributes either — see docs/stages/stage-30-panel-style-classes.md.
  const nonce = crypto.randomUUID();
  const hardened = body
    .replaceAll("<script>", `<script nonce="${nonce}">`)
    .replaceAll("<style>", `<style nonce="${nonce}">`);
  return new Response(hardened, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": htmlCsp(nonce),
    },
  });
}

/** Exported for tests (tests/response-redaction.test.ts) — the single JSON
 * choke point every admin API response passes through, so the §19 redaction
 * net in sanitizeResponse() covers all of them. */
export function jsonResponse(body: unknown, status = 200): Response {
  // Stage 18 (spec §19): sanitize BEFORE serializing — no §19 key name may
  // ever reach a caller, even if a handler accidentally includes one.
  return new Response(JSON.stringify(sanitizeResponse(body)), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/* An unexpected throw can carry a D1 constraint name, a column list or an
 * upstream provider URL, and this panel's errors are readable by anyone who
 * reaches the route. The real message goes to the Worker log — which is where
 * a developer looks anyway — and the caller gets a request id to quote. */
function internalErrorResponse(context: string, error: unknown, request?: Request): Response {
  // Stage 20: reuse the request's id when available so the 500's body
  // request_id, the X-Request-ID header and the log line all match.
  const requestId = getRequestId(request ?? null) ?? crypto.randomUUID();
  safeLog("error", `[admin:${context}] ${requestId}`, error);
  return jsonResponse(
    { detail: "服务器内部错误，请查看 Worker 日志", request_id: requestId },
    500,
  );
}

function readCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("Cookie")?.split(";") ?? [];
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

async function constantTimeSecretMatch(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

/* ── Session primitives (Security V2 Stage 1) ──────────────────────────── */

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fresh 256-bit session token; the client sees the hex, D1 sees only its hash. */
function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** UTC timestamp in the "YYYY-MM-DD HH:MM:SS" shape D1/SQLite comparisons use. */
function sqlUtc(ms: number = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** Parse the SQL UTC shape back to epoch ms; NaN when unparseable. */
function sqlUtcToMs(value: string): number {
  return new Date(`${value.trim().replace(" ", "T")}Z`).getTime();
}

function sessionCookieHeader(request: Request, value: string, maxAgeSeconds: number): string {
  const secure = new URL(request.url).protocol === "https:" ? " Secure;" : "";
  return `${SESSION_COOKIE_NAME}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly;${secure} SameSite=Strict`;
}

/** Idempotently ensure the bootstrap operator row exists and return it. */
async function ensureBootstrapUser(env: AdminEnv): Promise<AdminUserRow> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO admin_users (id, username, role) VALUES (?, ?, 'super_admin')`,
  ).bind(BOOTSTRAP_USER_ID, BOOTSTRAP_USERNAME).run();
  const row = await env.DB.prepare(
    `SELECT id, username, role, enabled FROM admin_users WHERE id = ?`,
  ).bind(BOOTSTRAP_USER_ID).first<AdminUserRow>();
  if (!row) throw new Error("bootstrap admin user missing after ensure");
  return row;
}

async function createAdminSession(
  env: AdminEnv,
  request: Request,
  user: AdminUserRow,
): Promise<{ token: string; expiresAt: string }> {
  const token = generateSessionToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = sqlUtc(now + SESSION_TTL_SECONDS * 1000);
  // IP is pre-validated by loginIdent(); UA is hashed because raw agent
  // strings are fingerprinting material, not an audit requirement.
  const ip = loginIdent(request);
  const ua = request.headers.get("User-Agent") ?? "";
  await env.DB.prepare(
    `INSERT INTO admin_sessions (id, user_id, token_hash, role, created_at, expires_at, ip_hash, user_agent_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), user.id, tokenHash, user.role, sqlUtc(now), expiresAt,
    await sha256Hex(ip), await sha256Hex(ua),
  ).run();
  return { token, expiresAt };
}

interface SessionJoinRow extends AdminUserRow {
  session_id: string;
  token_hash: string;
  expires_at: string;
  revoked_at: string | null;
}

/** Cookie → session row → enabled user. Revoked/expired/missing ⇒ null. */
async function resolveAdminSession(request: Request, env: AdminEnv): Promise<AdminAuthContext | null> {
  const token = readCookie(request, SESSION_COOKIE_NAME);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  let row: SessionJoinRow | null;
  try {
    row = await env.DB.prepare(
      `SELECT s.id AS session_id, s.token_hash, s.expires_at, s.revoked_at,
              u.id, u.username, u.role, u.enabled
       FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    ).bind(tokenHash).first<SessionJoinRow>();
  } catch (e) {
    // Fail closed: if the sessions table is missing (migration pending) no
    // session can be verified, so nothing is served on a session cookie.
    safeLog("error", "[admin:sessions] lookup failed", e);
    return null;
  }
  if (!row || row.revoked_at) return null;
  if (!Number.isFinite(sqlUtcToMs(row.expires_at)) || sqlUtcToMs(row.expires_at) <= Date.now()) return null;
  if (!row.enabled) return null;
  return {
    user: { id: row.id, username: row.username, role: row.role, enabled: row.enabled },
    sessionId: row.session_id,
    tokenHash,
    via: "session",
    expiresAt: row.expires_at,
  };
}

/** Revoke one session by token hash. Idempotent; safe on missing rows. */
async function revokeSessionByHash(env: AdminEnv, tokenHash: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE admin_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
  ).bind(sqlUtc(), tokenHash).run();
}

async function countActiveSessions(env: AdminEnv, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM admin_sessions
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(userId, sqlUtc()).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Active sessions across ALL users (super_admin inventory / revoke-all). */
async function countAllActiveSessions(env: AdminEnv): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM admin_sessions WHERE revoked_at IS NULL AND expires_at > ?`,
  ).bind(sqlUtc()).first<{ n: number }>();
  return row?.n ?? 0;
}

/* ── WebAuthn 2FA (post-V2 Stage 29) ─────────────────────────────────────
 * 2FA is active for a user iff they hold >= 1 active credential row and
 * WEBAUTHN_RP_ID is configured. Login then becomes two-step: master token
 * → assert challenge (202 / MFA page), authenticator or recovery code →
 * session. The Bearer master-token path is closed while the bootstrap user
 * has an active credential (see authenticate()). */

/** Enabled admin_users row by id — the session-minting subject for MFA flows. */
async function loadEnabledUser(env: AdminEnv, userId: string): Promise<AdminUserRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, username, role, enabled FROM admin_users WHERE id = ?`,
  ).bind(userId).first<AdminUserRow>();
  return row && row.enabled ? row : null;
}

interface MfaChallengePayload {
  flow_id: string;
  public_key: {
    challenge: string;
    rpId: string;
    timeout: number;
    userVerification: string;
    allowCredentials: Array<{ type: string; id: string; transports?: string[] }>;
  };
}

/** Issue the login assert challenge when the user's second factor is active.
 * null ⇒ 2FA does not apply, the caller mints the session directly. */
async function issueLoginMfaChallenge(env: AdminEnv, user: AdminUserRow): Promise<MfaChallengePayload | null> {
  const rp = rpConfig(env);
  if (!rp) return null;
  if ((await countActiveCredentials(env, user.id)) === 0) return null;
  const { flowId, challenge } = await issueChallenge(env, user.id, "assert");
  const descriptors = await listCredentialDescriptors(env, user.id);
  return {
    flow_id: flowId,
    public_key: {
      challenge,
      rpId: rp.rpId,
      timeout: 120_000,
      userVerification: "preferred",
      allowCredentials: descriptors.map((d) => ({
        type: "public-key",
        id: d.id,
        ...(d.transports ? { transports: d.transports.split(",").filter(Boolean) } : {}),
      })),
    },
  };
}

/** Shared MFA completion: clear the caller's throttle record, rotate the
 * cookie session, mint a fresh session, audit the LOGIN, return JSON with
 * the Set-Cookie header. */
async function completeMfaLogin(
  env: AdminEnv,
  request: Request,
  user: AdminUserRow,
  via: "mfa" | "recovery",
  metadata: AuditMetadata,
): Promise<Response> {
  await clearLoginFailures(env, throttleKey("ip", loginIdent(request)));
  const oldToken = readCookie(request, SESSION_COOKIE_NAME);
  if (oldToken) await revokeSessionByHash(env, await sha256Hex(oldToken));
  const session = await createAdminSession(env, request, user);
  await auditAdminAction(env, request, { user }, "LOGIN", "admin_session", null, { via, ...metadata });
  const res = jsonResponse({
    user_id: user.id,
    username: user.username,
    role: user.role,
    expires_at: session.expiresAt,
  });
  res.headers.set("Set-Cookie", sessionCookieHeader(request, session.token, SESSION_TTL_SECONDS));
  return res;
}

/**
 * Single authentication entry point for every admin route.
 *
 * Precedence mirrors the pre-V2 behavior: an explicit Authorization header
 * (if present) wins over any cookie. The Bearer form accepts the
 * ADMIN_PANEL_TOKEN as the bootstrap/migration credential — it maps to the
 * super_admin operator without a session row, because a browser never
 * attaches Authorization headers automatically, so it cannot act as a
 * persistent browser session.
 */
async function authenticate(request: Request, env: AdminEnv): Promise<AdminAuthContext | null> {
  if (!env.ADMIN_PANEL_TOKEN) return null;
  const authorization = request.headers.get("Authorization");
  if (authorization !== null) {
    if (!authorization.startsWith("Bearer ")) return null;
    const candidate = authorization.slice("Bearer ".length);
    if (!candidate || !(await constantTimeSecretMatch(candidate, env.ADMIN_PANEL_TOKEN))) return null;
    // Post-V2 Stage 29: while the bootstrap user holds an active WebAuthn
    // credential the Bearer master-token path is CLOSED — a second factor
    // that can be skipped by switching the token into an Authorization
    // header would be decoration. safeLog only, never an audit row: a
    // hammering automation client must not be able to flood audit_logs.
    if (rpConfig(env) !== null) {
      try {
        if ((await countActiveCredentials(env, BOOTSTRAP_USER_ID)) > 0) {
          safeLog("warn", "[admin:auth] Bearer bootstrap rejected: WebAuthn 2FA is active for the bootstrap user");
          return null;
        }
      } catch {
        // Fail closed: unreadable credential state ⇒ no Bearer access.
        safeLog("error", "[admin:auth] Bearer bootstrap rejected: credential lookup failed");
        return null;
      }
    }
    return {
      user: { id: BOOTSTRAP_USER_ID, username: BOOTSTRAP_USERNAME, role: "super_admin", enabled: 1 },
      sessionId: "",
      tokenHash: null,
      via: "bootstrap",
      expiresAt: null,
    };
  }
  return resolveAdminSession(request, env);
}

/* ── Login throttling ───────────────────────────────────────────────────
 *
 * The repository is public, so /admin/login's existence and shape are not a
 * secret, and a successful guess hands over every API key stored in D1. The
 * token is the only barrier, so failures are counted in D1 (the per-isolate
 * Map in rate-limit.ts dies with the isolate and would not survive a restart
 * or a second instance) and a run of wrong guesses locks the caller out. */

const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_SECONDS = 15 * 60;
/** Floor for a spray that rotates source addresses; high enough not to
 *  interfere with a handful of real operators, low enough to stop a run. */
const LOGIN_GLOBAL_MAX_FAILURES = 30;
/** Rolling window after which old failures stop counting. */
const LOGIN_WINDOW_SECONDS = 15 * 60;

/* Cloudflare sets CF-Connecting-IP at the edge and clients cannot forge it.
 * Anything that is not an IP literal falls back to a single shared bucket,
 * which is the safe direction: a garbage header throttles itself instead of
 * minting a fresh row per attempt. */
function loginIdent(request: Request): string {
  const raw = request.headers.get("CF-Connecting-IP")?.trim() ?? "";
  return /^[0-9a-fA-F:.]{3,45}$/.test(raw) ? raw.toLowerCase() : "unknown";
}

interface LoginThrottle {
  locked: boolean;
  failures: number;
  retryAfterSeconds: number;
}

async function readThrottle(env: AdminEnv, scope: string, ident: string): Promise<LoginThrottle> {
  // Prune on the way in: a login attempt is rare, so this is cheaper than a
  // scheduled prune job and keeps the table bounded on its own.
  await env.DB.prepare(
    `DELETE FROM admin_login_attempts
     WHERE updated_at <= datetime('now', ?)`,
  ).bind(`-${LOGIN_WINDOW_SECONDS} seconds`).run();

  const row = await env.DB.prepare(
    `SELECT failures, locked_until FROM admin_login_attempts
     WHERE scope = ? AND ident = ?`,
  ).bind(scope, ident).first<{ failures: number; locked_until: string | null }>();
  if (!row) return { locked: false, failures: 0, retryAfterSeconds: 0 };
  if (!row.locked_until) return { locked: false, failures: row.failures, retryAfterSeconds: 0 };

  const until = new Date(`${row.locked_until.replace(" ", "T")}Z`).getTime();
  if (!Number.isFinite(until) || until <= Date.now()) {
    return { locked: false, failures: row.failures, retryAfterSeconds: 0 };
  }
  return {
    locked: true,
    failures: row.failures,
    retryAfterSeconds: Math.max(1, Math.ceil((until - Date.now()) / 1000)),
  };
}

async function recordLoginFailure(env: AdminEnv, scope: string, ident: string): Promise<void> {
  const limit = scope === "global" ? LOGIN_GLOBAL_MAX_FAILURES : LOGIN_MAX_FAILURES;
  const current = await readThrottle(env, scope, ident);
  // Accumulate within the window; the first failure of a new run starts at 1.
  const failures = Math.min(current.locked ? current.failures : current.failures + 1, limit);
  const lockedUntil = failures >= limit
    ? new Date(Date.now() + LOGIN_LOCK_SECONDS * 1000).toISOString().replace("T", " ").slice(0, 19)
    : null;
  await env.DB.prepare(
    `INSERT INTO admin_login_attempts (scope, ident, failures, window_start, locked_until, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(scope, ident) DO UPDATE SET
       failures = excluded.failures,
       locked_until = excluded.locked_until,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(scope, ident, failures, lockedUntil).run();
}

async function clearLoginFailures(env: AdminEnv, ident: string): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM admin_login_attempts WHERE scope = 'ip' AND ident = ?",
  ).bind(ident).run();
}

/* Both buckets must be clear. The global bucket is always keyed "all" — it has
 * to be one shared row, otherwise a spray that rotates addresses would mint a
 * fresh counter per attempt and never accumulate. Likewise, callers with no
 * usable IP header collapse onto "all" so forged headers throttle themselves
 * instead of rotating free. */
const LOGIN_GLOBAL_KEY = "all";

function throttleKey(scope: string, ident: string): string {
  if (scope === "global") return LOGIN_GLOBAL_KEY;
  return ident === "unknown" ? LOGIN_GLOBAL_KEY : ident;
}

async function loginBlocked(env: AdminEnv, ident: string): Promise<LoginThrottle | null> {
  for (const scope of ["ip", "global"]) {
    const state = await readThrottle(env, scope, throttleKey(scope, ident));
    if (state.locked) return state;
  }
  return null;
}

/* Deliberately says nothing about the token: a locked caller must not be able
 * to learn whether the value they are holding is close to the right one. */
function loginThrottledResponse(state: LoginThrottle): Response {
  const minutes = Math.max(1, Math.ceil(state.retryAfterSeconds / 60));
  const page = htmlResponse(
    `${ADMIN_LOGIN_HTML}<p class="error">尝试过于频繁，请 ${minutes} 分钟后再试。</p>`,
    429,
  );
  page.headers.set("Retry-After", String(state.retryAfterSeconds));
  return page;
}

function authFailure(request: Request): Response {
  if (new URL(request.url).pathname.startsWith("/admin/api/")) {
    return jsonResponse({ detail: "Admin authentication required" }, 401);
  }
  return htmlResponse(ADMIN_LOGIN_HTML, 401);
}

/* ── Audit trail (Security V2 Stage 9, spec §10) ─────────────────────────
 *
 * Thin wrapper over writeAuditLog so call sites read as one line. The
 * metadata passes through redactAuditMetadata() in the audit module, so a
 * caller mistake (a secret under a denylisted key) is neutralized at the
 * write boundary (§10.2). Fail-open: audit problems never break the action.
 */
// Exported for the CRM sales layer (src/crm.ts) so its CRUD endpoints write
// the same audit trail as the rest of the admin surface.
export async function auditAdminAction(
  env: AdminEnv,
  request: Request,
  auth: { user: AdminUserRow } | null,
  action: string,
  resourceType: string,
  resourceId: string | null = null,
  metadata: AuditMetadata | null = null,
): Promise<void> {
  await writeAuditLog(env, request, {
    actorUserId: auth?.user.id ?? null,
    actorRole: auth?.user.role ?? null,
    action,
    resourceType,
    resourceId,
    // Stage 20 (spec §21): correlate the audit row with the request that
    // produced it — same UUID as the X-Request-ID response header.
    requestId: getRequestId(request),
    metadata,
  });
}

function validateText(value: unknown, field: string, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  if (value.length > maxLength) throw new Error(`${field} is too long`);
  return value.trim();
}

function validateDomain(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("domain is required");
  const candidate = value.trim();
  const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("domain must use HTTP or HTTPS");
  }
  return url.toString();
}

function normalizePersonaJson(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("personas_and_solutions must be valid JSON");
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("personas_and_solutions must be a JSON object or array");
  }
  const serialized = JSON.stringify(parsed);
  if (serialized.length > 30_000) throw new Error("personas_and_solutions is too long");
  return serialized;
}

function parseCustomerId(pathname: string): number | null {
  const match = pathname.match(/^\/admin\/api\/customers\/(\d+)$/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

interface ContactRow {
  id: number;
  contact_id: string;
  company_id: string;
  seq: number;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  title: string | null;
  department: string | null;
  email: string | null;
  cellphone: string | null;
  tel: string | null;
  whatsapp: string | null;
  linkedin_url: string | null;
  social_accounts: string | null;
}

async function getCustomer(env: AdminEnv, id: number): Promise<AdminCustomer | null> {
  const result = await env.DB.prepare(
    `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<AdminCustomer>();
  return result ?? null;
}

async function getCustomerContacts(env: AdminEnv, companyId: string): Promise<ContactRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, contact_id, company_id, seq, first_name, last_name, full_name, title, department, email, cellphone, tel, whatsapp, linkedin_url, social_accounts FROM contacts WHERE company_id = ? ORDER BY seq`,
  )
    .bind(companyId)
    .all<ContactRow>();
  return result.results;
}

async function listCustomers(request: Request, env: AdminEnv): Promise<Response> {
  const url = new URL(request.url);
  const search = (url.searchParams.get("q") ?? "").trim();
  const status = (url.searchParams.get("status") ?? "").trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 100);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
  const where: string[] = [];
  const bindings: Array<string | number> = [];

  if (search) {
    where.push("(company_id LIKE ? OR domain LIKE ? OR company_name LIKE ? OR customer_segment LIKE ? OR product_categories LIKE ? OR country LIKE ? OR remarks LIKE ?)");
    const pattern = `%${search}%`;
    bindings.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern);
  }
  if (status) {
    if (!CUSTOMER_STATUSES.has(status)) return jsonResponse({ detail: "Invalid status" }, 400);
    where.push("status = ?");
    bindings.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT ${CUSTOMER_LIST_COLUMNS} FROM customers ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
      .bind(...bindings, limit, offset)
      .all<AdminCustomer>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM customers ${clause}`)
      .bind(...bindings)
      .first<{ total: number }>(),
  ]);
  return jsonResponse({
    items: rows.results,
    total: count?.total ?? 0,
    limit,
    offset,
  });
}

// ── Seed-data CSV import (docx ①/③: Data Import + Raw Layer) ─────────────
// Expected CSV columns (header row, order-insensitive):
//   company_name, country, domain|website, email, product
// Every raw row is stored verbatim in customer_imports (Layer 1, immutable);
// rows that match an existing company (domain or normalized name) are marked
// 'matched' and skipped; new ones become pending customers (Layer 2).
async function importCustomersCsv(request: Request, env: AdminEnv, auth: AdminAuthContext): Promise<Response> {
  // Stage 8: the body is read with a hard byte cap (no unbounded
  // request.json()) and the CSV with hard row/column/field caps. Every
  // refusal names the exact limit it tripped.
  let body: { csv: string; file_name: string | null };
  try {
    body = await readCsvImportBody(request);
  } catch (e) {
    if (e instanceof CsvLimitError) return jsonResponse({ detail: e.message }, e.status);
    return jsonResponse({ detail: "Invalid JSON body" }, 400);
  }
  const csvText = body.csv.trim();
  if (!csvText) return jsonResponse({ detail: "csv is required" }, 400);

  let table: string[][];
  try {
    table = parseCsvBounded(csvText);
  } catch (e) {
    if (e instanceof CsvLimitError) return jsonResponse({ detail: e.message }, e.status);
    throw e;
  }
  if (table.length < 2) return jsonResponse({ detail: "CSV needs a header row plus at least one data row" }, 400);
  const header = table[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iName = col("company_name", "company", "name");
  const iCountry = col("country");
  const iDomain = col("domain", "website", "url");
  const iEmail = col("email", "email_address");
  const iProduct = col("product", "product_category", "products");
  if (iName === -1) return jsonResponse({ detail: "CSV must contain a company_name column" }, 400);

  const importId = `imp_${Date.now().toString(36)}`;
  // Stage 33: every customer_imports row of this import carries the request
  // id — same id as the IMPORT audit row, so a row traces to its request in
  // one hop.
  const importRequestId = getRequestId(request);
  const normalizeDomain = (raw: string | undefined): string | null => {
    if (!raw) return null;
    try {
      let v = raw.trim().toLowerCase();
      if (!v) return null;
      if (!/^https?:\/\//.test(v)) v = `https://${v}`;
      const host = new URL(v).hostname.replace(/^www\./, "");
      return host || null;
    } catch { return null; }
  };

  let inserted = 0, matched = 0, skipped = 0;
  const insertStmts: D1PreparedStatement[] = [];
  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    const companyName = (cells[iName] ?? "").trim();
    const domain = normalizeDomain(cells[iDomain]);
    if (!companyName && !domain) { skipped++; continue; }
    const rawJson = JSON.stringify({
      company_name: companyName || null,
      country: iCountry >= 0 ? (cells[iCountry] ?? "").trim() || null : null,
      domain: domain,
      email: iEmail >= 0 ? (cells[iEmail] ?? "").trim() || null : null,
      product: iProduct >= 0 ? (cells[iProduct] ?? "").trim() || null : null,
    });

    // Dedup (docx Step 3): by domain first, then exact company_name.
    let existingId: string | null = null;
    if (domain) {
      const hit = await env.DB.prepare(
        `SELECT company_id FROM customers WHERE normalized_domain = ? OR domain LIKE ? LIMIT 1`,
      ).bind(domain, `%${domain}%`).first<{ company_id: string }>();
      if (hit) existingId = hit.company_id;
    }
    if (!existingId && companyName) {
      const hit = await env.DB.prepare(
        `SELECT company_id FROM customers WHERE LOWER(company_name) = LOWER(?) LIMIT 1`,
      ).bind(companyName).first<{ company_id: string }>();
      if (hit) existingId = hit.company_id;
    }

    if (existingId) {
      matched++;
      insertStmts.push(env.DB.prepare(
        `INSERT INTO customer_imports (import_id, file_name, row_number, raw_json, mapped_company_id, dedup_status, request_id)
         VALUES (?, ?, ?, ?, ?, 'matched', ?)`,
      ).bind(importId, body.file_name ?? null, r, rawJson, existingId, importRequestId));
      continue;
    }

    // New company: map into the customers schema (docx 建议 4 — keep the
    // imported name as company_name; website may reveal a trading_name later).
    const companyId = crypto.randomUUID();
    insertStmts.push(env.DB.prepare(
      `INSERT INTO customers (company_id, domain, normalized_domain, company_name, country, email, products_services, status, source_import_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(
      companyId,
      domain ?? "",
      domain,
      companyName || domain || `import_row_${r}`,
      iCountry >= 0 ? (cells[iCountry] ?? "").trim() || null : null,
      iEmail >= 0 ? (cells[iEmail] ?? "").trim() || null : null,
      iProduct >= 0 ? (cells[iProduct] ?? "").trim() || null : null,
      importId,
    ));
    insertStmts.push(env.DB.prepare(
      `INSERT INTO customer_imports (import_id, file_name, row_number, raw_json, mapped_company_id, dedup_status, request_id)
       VALUES (?, ?, ?, ?, ?, 'inserted', ?)`,
    ).bind(importId, body.file_name ?? null, r, rawJson, companyId, importRequestId));
    inserted++;
  }

  // D1 batches are capped; chunk to stay safely below the 100-statement limit.
  for (let i = 0; i < insertStmts.length; i += 50) {
    await env.DB.batch(insertStmts.slice(i, i + 50));
  }
  // Stage 9: one row per import batch with the outcome counts. The CSV body
  // itself never enters the audit trail — only its size envelope.
  await auditAdminAction(env, request, auth, "IMPORT_CSV", "customer_import", importId, {
    file_name: body.file_name,
    inserted,
    matched,
    skipped,
    total_rows: table.length - 1,
  });
  return jsonResponse({ import_id: importId, inserted, matched, skipped, total_rows: table.length - 1 });
}

// ── Pre-filter / 海选 (docx Step 2) ──────────────────────────────────────
// SQL-only narrowing over existing verified fields. Counts what remains so the
// user can decide before committing research budget. Also can reset matching
// rows to pending (action=queue) so the cron pipeline re-processes them.
// Shares its WHERE-clause builder with the 定向群发 campaign preview so both
// screens agree on what "this customer group" means.
/* 海选 CSV 导出上限：一次响应最多输出这么多行——D1 查询与 Worker 内存都
 * 需要有界；超限时在响应尾部追加截断说明行，操作员按提示收紧条件再导。 */
const PREFILTER_EXPORT_ROW_CAP = 5_000;

async function preFilterCustomers(request: Request, env: AdminEnv, auth: AdminAuthContext): Promise<Response> {
  const url = new URL(request.url);
  const hasEmail = url.searchParams.get("has_email") === "1";
  const filters = parseSegmentFilters({
    countries: url.searchParams.get("countries") ?? "",
    segments: url.searchParams.get("segments") ?? "",
    products: url.searchParams.get("products") ?? "",
    min_lead_score: url.searchParams.get("min_lead_score") ?? 0,
    has_email: hasEmail,
    // Phase 6 (design §4): the pre-filter narrows by current buying signals
    // too — useful for counting and for the action=queue re-research path.
    has_buying_signal: url.searchParams.get("has_buying_signal") === "1",
    // Phase 8 (design §2.1): persona targeting shares this builder, so the
    // 海选 screen can count and re-queue by the same persona_role values the
    // campaign screen will use.
    persona_roles: url.searchParams.get("persona_roles") ?? "",
  });
  const action = url.searchParams.get("action") ?? "count";
  const { clause, binds } = segmentClause(filters, { requireCompleted: true, requireEmail: hasEmail });

  if (action === "queue") {
    // Reset the filtered set for re-research (海选 → 再处理). Re-queue must
    // also retire the saved research: processCustomer's canReuseResearch
    // path would otherwise re-run the AI on the PREVIOUS crawl verbatim —
    // re-queueing a customer whose profile was contaminated with another
    // company's data would re-analyse the same bad inputs. research_sources
    // rows are superseded (is_current = 0, valid_until = now — history
    // stays queryable) and the deprecated blob cache is cleared, so the
    // next tick pays a fresh crawl+search. Both statements run in one batch.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const validUntil =
      `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ` +
      `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
    const supersedeSources = env.DB.prepare(
      `UPDATE research_sources SET is_current = 0, valid_until = ?
        WHERE is_current = 1
          AND customer_id IN (SELECT company_id FROM customers ${clause})`,
    ).bind(validUntil, ...binds);
    const requeue = env.DB.prepare(
      `UPDATE customers SET status = 'pending', full_research_text = NULL, updated_at = CURRENT_TIMESTAMP ${clause}`,
    ).bind(...binds);
    const results = await env.DB.batch([supersedeSources, requeue]);
    const queued = results[1]?.meta?.changes ?? 0;
    // Stage 9: re-queueing IS research being (re)started for a customer set.
    await auditAdminAction(env, request, auth, "START_RESEARCH", "customer", null, {
      via: "pre-filter",
      queued,
    });
    return jsonResponse({ action, queued });
  }

  if (action === "export") {
    // 海选结果全量导出（CSV，带 BOM 方便 Excel 直接打开中文）。与 count
    // 共用同一个 segmentClause WHERE，筛选语义完全一致。列集是固定白名
    // 单：列表列 + 两个评分明细列——死列（从未写入的人名块、
    // social_accounts）与 full_research_text 原文 blob 不导。不走
    // jsonResponse/sanitizeResponse 的 JSON 出口，但白名单列名不含任
    // 何 §19 敏感键。
    const columns = [
      ...CUSTOMER_LIST_COLUMNS.trim().split(/[,\s]+/).filter(Boolean),
      "data_completeness_score",
      "lead_score_breakdown",
    ];
    const rows = await env.DB.prepare(
      `SELECT ${columns.join(", ")} FROM customers ${clause} ORDER BY lead_score DESC NULLS LAST, id LIMIT ?`,
    ).bind(...binds, PREFILTER_EXPORT_ROW_CAP + 1).all<Record<string, string | number | null>>();
    const data = rows.results;
    const truncated = data.length > PREFILTER_EXPORT_ROW_CAP;
    if (truncated) data.length = PREFILTER_EXPORT_ROW_CAP;
    const cell = (v: string | number | null | undefined): string => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [columns.join(",")];
    for (const row of data) lines.push(columns.map((c) => cell(row[c])).join(","));
    if (truncated) {
      lines.push(`# 截断：匹配数超过 ${PREFILTER_EXPORT_ROW_CAP}，仅导出前 ${PREFILTER_EXPORT_ROW_CAP} 行——请收紧筛选条件后重新导出`);
    }
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    return new Response("\uFEFF" + lines.join("\r\n"), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="prefilter-export-${stamp}-${data.length}rows.csv"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM customers ${clause}`,
  ).bind(...binds).first<{ n: number }>();
  const sample = await env.DB.prepare(
    `SELECT ${CUSTOMER_LIST_COLUMNS} FROM customers ${clause} ORDER BY lead_score DESC NULLS LAST, id LIMIT 20`,
  ).bind(...binds).all<AdminCustomer>();
  return jsonResponse({ matching: count?.n ?? 0, sample: sample.results });
}

/* Phase 7 Stage 48 (docs/phase7-contact-merge.md §4): manual merge for the
 * duplicates the conservative write-time rule (Stage 47) refuses to guess
 * — a shared info@ mailbox fronting two people, name-only twins, and every
 * row accumulated before Phase 7. The operator picks the survivor; the
 * merge itself is mechanical:
 *   - fill-NULL-only across the mergeable fields (never overwrites),
 *   - repoint research_facts.contact_id + evidence.contact_id to the
 *     survivor, then delete the merged rows — ONE D1 batch, so there is
 *     no window with dangling references,
 *   - audited as CONTACT_MERGE with the ids and which fields got filled
 *     (no raw contact data in the audit trail).
 * RBAC needs no change: any POST under /admin/api/customers… already maps
 * to customers.write (rbac.ts). */
const CONTACT_MERGE_FIELDS = [
  "first_name", "last_name", "full_name", "title", "department",
  "email", "cellphone", "tel", "whatsapp", "linkedin_url", "social_accounts",
] as const;

async function mergeCustomerContacts(
  request: Request,
  env: AdminEnv,
  id: number,
  auth: AdminAuthContext,
): Promise<Response> {
  const customer = await getCustomer(env, id);
  if (!customer) return jsonResponse({ detail: "Customer not found" }, 404);

  let payload: Record<string, unknown>;
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonResponse({ detail: "JSON object required" }, 400);
    }
    payload = body as Record<string, unknown>;
  } catch {
    return jsonResponse({ detail: "JSON object required" }, 400);
  }

  const survivor = typeof payload.survivor_contact_id === "string"
    ? payload.survivor_contact_id.trim().slice(0, 100) : "";
  if (!survivor) return jsonResponse({ detail: "survivor_contact_id 不能为空" }, 400);
  const mergedRaw = Array.isArray(payload.merged_contact_ids) ? payload.merged_contact_ids : [];
  const merged = [...new Set(
    mergedRaw.map((v) => (typeof v === "string" ? v.trim().slice(0, 100) : "")).filter(Boolean),
  )];
  if (merged.length === 0) return jsonResponse({ detail: "merged_contact_ids 不能为空" }, 400);
  if (merged.length > 10) return jsonResponse({ detail: "一次最多合并 10 个联系人" }, 400);
  if (merged.includes(survivor)) {
    return jsonResponse({ detail: "主行不能同时出现在合并列表中" }, 400);
  }

  // Every id must be a contact of THIS company — a foreign id (another
  // company, a typo) is a 404, never a silent cross-company merge.
  const contacts = await getCustomerContacts(env, customer.company_id);
  const byId = new Map(contacts.map((c) => [c.contact_id, c] as const));
  const survivorRow = byId.get(survivor);
  if (!survivorRow) return jsonResponse({ detail: "Contact not found" }, 404);
  const mergedRows = merged.map((cid) => byId.get(cid));
  if (mergedRows.some((r) => !r)) return jsonResponse({ detail: "Contact not found" }, 404);

  // Fill-NULL merge: the survivor keeps every non-null field; NULL fields
  // fill from the merged rows in the order the operator listed them.
  const filled: string[] = [];
  const values: Record<string, string | null> = {};
  for (const field of CONTACT_MERGE_FIELDS) {
    let value = survivorRow[field];
    for (const row of mergedRows) {
      if (row && value == null && row[field] != null) {
        value = row[field];
        if (!filled.includes(field)) filled.push(field);
      }
    }
    values[field] = value;
  }

  const placeholders = merged.map(() => "?").join(",");
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE contacts SET ${CONTACT_MERGE_FIELDS.map((f) => `${f} = ?`).join(", ")}
       WHERE contact_id = ? AND company_id = ?`,
    ).bind(
      ...CONTACT_MERGE_FIELDS.map((f) => values[f]),
      survivor,
      customer.company_id,
    ),
    env.DB.prepare(
      `UPDATE research_facts SET contact_id = ? WHERE customer_id = ? AND contact_id IN (${placeholders})`,
    ).bind(survivor, customer.company_id, ...merged),
    env.DB.prepare(
      `UPDATE evidence SET contact_id = ? WHERE company_id = ? AND contact_id IN (${placeholders})`,
    ).bind(survivor, customer.company_id, ...merged),
    env.DB.prepare(
      `DELETE FROM contacts WHERE company_id = ? AND contact_id IN (${placeholders})`,
    ).bind(customer.company_id, ...merged),
  ]);

  await auditAdminAction(env, request, auth, "CONTACT_MERGE", "customer", String(id), {
    survivor_contact_id: survivor,
    merged_contact_ids: merged,
    filled_fields: filled,
  });
  return jsonResponse({ survivor_contact_id: survivor, merged: merged.length, filled_fields: filled });
}

async function updateCustomer(request: Request, env: AdminEnv, id: number, auth: AdminAuthContext): Promise<Response> {
  const existing = await getCustomer(env, id);
  if (!existing) return jsonResponse({ detail: "Customer not found" }, 404);

  let payload: Record<string, unknown>;
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonResponse({ detail: "JSON object required" }, 400);
    }
    payload = body as Record<string, unknown>;
  } catch {
    return jsonResponse({ detail: "Invalid JSON body" }, 400);
  }

  try {
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    if ("domain" in payload) {
      assignments.push("domain = ?");
      values.push(validateDomain(payload.domain));
    }
    if ("status" in payload) {
      if (typeof payload.status !== "string" || !CUSTOMER_STATUSES.has(payload.status)) {
        return jsonResponse({ detail: "Invalid status" }, 400);
      }
      assignments.push("status = ?");
      values.push(payload.status);
    }
    if ("customer_segment" in payload) {
      assignments.push("customer_segment = ?");
      values.push(validateText(payload.customer_segment, "customer_segment", 200));
    }
    if ("personas_and_solutions" in payload) {
      assignments.push("personas_and_solutions = ?");
      values.push(normalizePersonaJson(payload.personas_and_solutions));
    }
    if ("remarks" in payload) {
      assignments.push("remarks = ?");
      values.push(validateText(payload.remarks, "remarks", 10_000));
    }
    if (!assignments.length) return jsonResponse({ detail: "No editable fields supplied" }, 400);

    const updated = await env.DB.prepare(
      `UPDATE customers SET ${assignments.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING ${CUSTOMER_COLUMNS}`,
    )
      .bind(...values, id)
      .first<AdminCustomer>();
    if (updated) {
      // Stage 9: field names only — values can hold contact details.
      await auditAdminAction(env, request, auth, "UPDATE_CUSTOMER", "customer", String(id), {
        fields: Object.keys(payload).filter((k) => k !== "id"),
      });
    }
    return jsonResponse(updated ?? { detail: "Customer not found" }, updated ? 200 : 404);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Invalid customer data";
    // Stage 17 (spec §18.1): the partial unique index on customers(domain)
    // turns a duplicate-domain PATCH into a clear 409 rather than a raw
    // SQLite error string.
    if (msg.includes("UNIQUE constraint failed: customers.domain")) {
      return jsonResponse({ detail: "该 domain 已被其他客户占用" }, 409);
    }
    return jsonResponse({ detail: msg }, 400);
  }
}

/* ── Dynamic provider key management (方案B: D1 api_configs, no deploy needed) ── */

const PANEL_PROVIDERS = [
  "gemini", "groq", "cerebras", "zhipu", "nvidia", "amd", "mistral", "deepseek", "openrouter",
  "tavily", "exa", "brave", "searlo",
] as const;

async function handleProviderKeysApi(request: Request, env: AdminEnv, auth: AdminAuthContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // GET /admin/api/keys — list all provider keys + settings
  if (request.method === "GET" && path === "/admin/api/keys") {
    const [keys, settings, cooldowns, history] = await Promise.all([
      env.DB.prepare(
        `SELECT id, provider, label, api_key, key_hint, rpm_limit, is_active, model, last_error, last_used_at, created_at
         FROM api_configs ORDER BY provider, id`,
      ).all<Record<string, unknown>>(),
      env.DB.prepare(`SELECT provider, default_model, rpm_total, enabled FROM provider_settings ORDER BY provider`)
        .all<Record<string, unknown>>(),
      // Active cooldowns (api_key_health rows written by the runtime when a
      // key returns 429/401/403). key_index holds the health name
      // "<provider>:<keyId>" so it maps directly onto api_configs row ids.
      env.DB.prepare(
        `SELECT provider, key_index, exhausted_until, last_error FROM api_key_health
         WHERE exhausted_until IS NOT NULL AND exhausted_until > datetime('now')
         ORDER BY provider, key_index`,
      ).all<Record<string, unknown>>(),
      // Expired cooldowns stay in the table (rows are upserted, never pruned
      // on expiry) — surface the most recent 20 as a lightweight history log.
      env.DB.prepare(
        `SELECT provider, key_index, exhausted_until, last_error, updated_at FROM api_key_health
         WHERE exhausted_until IS NOT NULL AND exhausted_until <= datetime('now')
         ORDER BY updated_at DESC LIMIT 20`,
      ).all<Record<string, unknown>>(),
    ]);
    // Mask keys. key_hint is computed at encryption time because ciphertext has
    // no stable prefix to slice; legacy cleartext rows still have no hint yet,
    // so those fall back to slicing the value itself.
    const rows = (keys.results ?? []).map((row) => {
      const stored = typeof row.api_key === "string" ? row.api_key : "";
      const hint = typeof row.key_hint === "string" && row.key_hint
        ? row.key_hint
        : isEncrypted(stored) ? "…" : hintFor(stored);
      const { api_key: _raw, key_hint: _storedHint, ...rest } = row;
      // Stage 18 (spec §19): the masked display form rides under key_hint —
      // its real name. It used to be returned as `api_key`, which is on the
      // §19 forbidden-key list, so the response-wide redaction net would have
      // blanked it; the value is a hint by construction, never the secret.
      return { ...rest, key_hint: hint, encrypted: isEncrypted(stored) };
    });
    return jsonResponse({
      keys: rows,
      settings: settings.results ?? [],
      cooldowns: cooldowns.results ?? [],
      history: history.results ?? [],
      // Drives the panel's warning banner and enables/disables the write
      // affordances. Read paths work with or without it.
      encryption: {
        configured: await isEncryptionConfigured(env),
        plaintext_rows: rows.filter((r) => !r.encrypted).length,
      },
    });
  }

  // POST /admin/api/keys — add a new key
  if (request.method === "POST" && path === "/admin/api/keys") {
    const body = await request.json() as Record<string, unknown>;
    const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
    const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
    if (!PANEL_PROVIDERS.includes(provider as typeof PANEL_PROVIDERS[number])) {
      return jsonResponse({ detail: `provider 必须是: ${PANEL_PROVIDERS.join(", ")}` }, 400);
    }
    if (!apiKey) return jsonResponse({ detail: "api_key 不能为空" }, 400);
    const label = typeof body.label === "string" ? body.label.trim().slice(0, 100) || null : null;
    const model = typeof body.model === "string" ? body.model.trim() || null : null;
    const rpmRaw = Number(body.rpm_limit);
    const rpmLimit = Number.isFinite(rpmRaw) && rpmRaw > 0 ? Math.floor(rpmRaw) : null;
    // Fail closed: writing without a configured key would put the new value
    // back into D1 in cleartext, which is the exact state this feature exists
    // to end. Checked up front and reported as 400 rather than letting
    // encryptSecret throw — an unconfigured key is something the operator can
    // fix, and a redacted 500 with a request_id would tell them nothing.
    if (!(await isEncryptionConfigured(env))) {
      return jsonResponse({
        detail: "尚未配置 CREDENTIAL_ENC_KEY，为避免明文写入已拒绝保存。请先在「🔐 凭据加密」中生成并保存密钥。",
      }, 400);
    }
    const encrypted = await encryptSecret(apiKey, env);
    // Stage 17 (spec §18.1): reject a duplicate API fingerprint up front.
    // Bulk import already dedupes this way ("duplicates within the paste AND
    // keys already stored for the provider are skipped"); the single-key form
    // now enforces the same per-provider rule, and the partial unique index
    // idx_api_configs_fingerprint (deploy-worker.yml) backstops it against
    // concurrent writes.
    const dupe = await env.DB.prepare(
      `SELECT id FROM api_configs WHERE provider = ? AND key_fingerprint = ? LIMIT 1`,
    ).bind(provider, encrypted.fingerprint).first<{ id: number }>();
    if (dupe) {
      return jsonResponse({ detail: "该 provider 下已存在相同的 API key（指纹重复），已拒绝保存" }, 409);
    }
    const result = await env.DB.prepare(
      `INSERT INTO api_configs (provider, label, api_key, key_hint, key_fingerprint, rpm_limit, model, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    ).bind(provider, label, encrypted.cipher, encrypted.hint, encrypted.fingerprint, rpmLimit, model).run();
    invalidateProviderCache(provider);
    // Stage 9: the row id is the resource; the key material never appears.
    await auditAdminAction(
      env, request, auth, "CREATE_API_KEY", "api_config",
      result.meta?.last_row_id != null ? String(result.meta.last_row_id) : null,
      { provider },
    );
    return jsonResponse({ ok: true, id: result.meta?.last_row_id ?? null, encrypted: true });
  }

  // POST /admin/api/keys/encrypt-all — convert remaining cleartext rows in
  // place. Explicit rather than automatic: it is irreversible, it rewrites live
  // credentials, and the operator should see a count before it happens.
  if (request.method === "POST" && path === "/admin/api/keys/encrypt-all") {
    // Check up front so an unconfigured or malformed key fails before any
    // write, rather than halfway through rewriting live credentials.
    if (!(await isEncryptionConfigured(env))) {
      return jsonResponse({
        detail: "尚未配置 CREDENTIAL_ENC_KEY：请先在「🔐 凭据加密」中生成并保存，再执行加密。",
      }, 400);
    }
    const rows = await env.DB.prepare(
      `SELECT id, provider, api_key FROM api_configs WHERE api_key NOT LIKE 'enc:v1:%'`,
    ).all<{ id: number; provider: string; api_key: string }>();

    const converted: string[] = [];
    const failed: Array<{ id: number; reason: string }> = [];
    for (const row of rows.results ?? []) {
      try {
        const encrypted = await encryptSecret(row.api_key, env);
        // Security V2 Stage 4 (spec 5.2): the plaintext row is only replaced
        // after the ciphertext is proven to decrypt back to the same value AND
        // re-fingerprint to the same digest. Any mismatch ⇒ skip and keep the
        // working plaintext row; never trade a live credential for an
        // unverifiable one.
        const roundtrip = await decryptSecret(encrypted.cipher, env);
        if (roundtrip !== row.api_key) {
          failed.push({ id: row.id, reason: "解密回读不一致，已跳过（原值未动）" });
          continue;
        }
        if ((await fingerprint(roundtrip, env)) !== encrypted.fingerprint) {
          failed.push({ id: row.id, reason: "指纹校验不一致，已跳过（原值未动）" });
          continue;
        }
        await env.DB.prepare(
          `UPDATE api_configs SET api_key = ?, key_hint = ?, key_fingerprint = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        ).bind(encrypted.cipher, encrypted.hint, encrypted.fingerprint, row.id).run();
        converted.push(row.provider);
        // Audit trail (structured console until the Stage 9 audit_logs table
        // lands; visible via `wrangler tail`). Records the conversion event,
        // never the credential material.
         safeLog("log",
           `[security-v2:credential-migration] table=api_configs id=${row.id} provider=${row.provider} event=encrypted-verified`,
         );
      } catch (error) {
        failed.push({ id: row.id, reason: error instanceof Error ? error.message : "unknown" });
      }
    }
    // Rows rewritten under the same key, so cached provider state is stale.
    for (const provider of new Set(converted)) invalidateProviderCache(provider);
    const remaining = (await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM api_configs WHERE api_key NOT LIKE 'enc:v1:%'`,
    ).first<{ n: number }>())?.n ?? null;
    await auditAdminAction(env, request, auth, "UPDATE_API_KEY", "api_config", null, {
      via: "encrypt-all",
      converted: converted.length,
      remaining,
    });
    return jsonResponse({
      ok: failed.length === 0,
      converted: converted.length,
      remaining,
      failed,
    });
  }

  // POST /admin/api/keys/reseal — key-rotation sweep (post-V2). encrypt-all
  // only converts legacy plaintext; reseal rewrites EVERY api_configs row
  // that is not sealed under the *current* master: rows sealed with
  // CREDENTIAL_ENC_KEY_PREVIOUS (rotation in progress) and leftover plaintext
  // both get re-encrypted in place. Idempotent: rows already under the
  // current key are counted, not touched. Same Stage 4 verification gate as
  // encrypt-all — decrypt roundtrip + fingerprint must both check out before
  // a live row is replaced.
  if (request.method === "POST" && path === "/admin/api/keys/reseal") {
    // Fail fast before any write: an unconfigured or malformed current key
    // must not abort halfway through rewriting live credentials.
    if (!(await isEncryptionConfigured(env))) {
      return jsonResponse({
        detail: "尚未配置 CREDENTIAL_ENC_KEY：请先在「🔐 凭据加密」中生成并保存，再执行重密封。",
      }, 400);
    }
    const currentKeys = await requireEncKeys(env);
    // A malformed PREVIOUS must surface as configuration feedback, not a 500.
    let previousKeys: CredentialKeys | null;
    try {
      previousKeys = await getPreviousEncKeys(env);
    } catch (e) {
      return jsonResponse({
        detail: `CREDENTIAL_ENC_KEY_PREVIOUS 配置无效：${e instanceof Error ? e.message : String(e)}`,
      }, 400);
    }
    const rows = await env.DB.prepare(
      "SELECT id, provider, api_key FROM api_configs",
    ).all<{ id: number; provider: string; api_key: string }>();

    let resealed = 0;
    let alreadyCurrent = 0;
    const converted: string[] = [];
    const failed: Array<{ id: number; reason: string }> = [];
    for (const row of rows.results ?? []) {
      try {
        let plain: string | null;
        if (isEncrypted(row.api_key)) {
          // Current key opens it → already sealed with the master that is
          // in force; leave it alone so the sweep is safe to re-run.
          plain = await tryDecryptSecret(row.api_key, currentKeys);
          if (plain !== null) {
            alreadyCurrent++;
            continue;
          }
          // Otherwise the previous rotation key must open it, else the row
          // is unrecoverable here — keep it and report loudly.
          plain = previousKeys ? await tryDecryptSecret(row.api_key, previousKeys) : null;
          if (plain === null) {
            failed.push({ id: row.id, reason: "当前/备用密钥均无法解密，已跳过（原值未动）" });
            continue;
          }
        } else {
          // Legacy plaintext — the sweep migrates it too (encrypt-all's job,
          // but a rotation visit must not leave plaintext behind).
          plain = row.api_key;
        }
        const encrypted = await encryptSecret(plain, env);
        const roundtrip = await tryDecryptSecret(encrypted.cipher, currentKeys);
        if (roundtrip !== plain || (await fingerprint(plain, env)) !== encrypted.fingerprint) {
          failed.push({ id: row.id, reason: "验证失败（回读/指纹不一致），已跳过（原值未动）" });
          continue;
        }
        await env.DB.prepare(
          `UPDATE api_configs SET api_key = ?, key_hint = ?, key_fingerprint = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        ).bind(encrypted.cipher, encrypted.hint, encrypted.fingerprint, row.id).run();
        resealed++;
        converted.push(row.provider);
        safeLog("log",
          `[security-v2:credential-rotation] table=api_configs id=${row.id} provider=${row.provider} event=resealed-under-current-key`,
        );
      } catch (error) {
        failed.push({ id: row.id, reason: error instanceof Error ? error.message : "unknown" });
      }
    }
    for (const provider of new Set(converted)) invalidateProviderCache(provider);
    const plaintextRemaining = (await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM api_configs WHERE api_key NOT LIKE 'enc:v1:%'`,
    ).first<{ n: number }>())?.n ?? 0;
    await auditAdminAction(env, request, auth, "UPDATE_API_KEY", "api_config", null, {
      via: "reseal",
      resealed,
      already_current: alreadyCurrent,
      previous_key_in_use: previousKeys !== null,
      failed: failed.length,
    });
    return jsonResponse({
      ok: failed.length === 0,
      resealed,
      already_current: alreadyCurrent,
      plaintext_remaining: plaintextRemaining,
      failed,
    });
  }

  // POST /admin/api/keys/encryption-key — mint a candidate CREDENTIAL_ENC_KEY.
  // Returns the value instead of saving it: setting a Worker secret needs the
  // Cloudflare API token, and a generated value the operator cannot retrieve
  // later is useless. Losing it means the D1 rows become undecryptable, which
  // is why the panel treats saving it as a deliberate step.
  if (request.method === "POST" && path === "/admin/api/keys/encryption-key") {
    return jsonResponse({ value: await suggestEncKey() });
  }

  // GET /admin/api/keys/usage — per-provider monthly usage summary for the
  // 📊 card: month/total calls, active keys, keys used this month, and
  // theoretical monthly capacity from documented free tiers (search engines).
  if (request.method === "GET" && path === "/admin/api/keys/usage") {
    const [active, monthRows, totalRows, cooldowns] = await Promise.all([
      env.DB.prepare(`SELECT provider, COUNT(*) AS n FROM api_configs WHERE is_active = 1 GROUP BY provider`)
        .all<{ provider: string; n: number }>(),
      env.DB.prepare(
        `SELECT provider, SUM(success_count) AS calls, COUNT(DISTINCT key_index) AS keys_used
         FROM api_key_usage WHERE day >= date('now', 'start of month') GROUP BY provider`,
      ).all<{ provider: string; calls: number; keys_used: number }>(),
      env.DB.prepare(`SELECT provider, SUM(success_count) AS calls FROM api_key_usage GROUP BY provider`)
        .all<{ provider: string; calls: number }>(),
      env.DB.prepare(
        `SELECT provider, COUNT(*) AS n FROM api_key_health
         WHERE exhausted_until IS NOT NULL AND exhausted_until > datetime('now') GROUP BY provider`,
      ).all<{ provider: string; n: number }>(),
    ]);
    const activeMap = Object.fromEntries((active.results ?? []).map((r) => [r.provider, r.n]));
    const monthMap = Object.fromEntries((monthRows.results ?? []).map((r) => [r.provider, r]));
    const totalMap = Object.fromEntries((totalRows.results ?? []).map((r) => [r.provider, r.calls]));
    const coolMap = Object.fromEntries((cooldowns.results ?? []).map((r) => [r.provider, r.n]));
    // Documented per-key monthly capacities (search engines only; AI providers
    // depend on model/token mix so no hard capacity is shown for them).
    const monthlyCapacityPerKey: Record<string, number> = {
      tavily: 500,  // 1,000 credits, advanced search = 2 credits
      exa: 2000,    // ~$10 credits at ~$5/1k auto searches
      brave: 2000,  // 2,000 searches/mo
      searlo: 1000, // estimate
    };
    const providers = Array.from(new Set([
      ...Object.keys(activeMap), ...Object.keys(monthMap), ...Object.keys(totalMap),
    ])).sort();
    const usage = providers.map((p) => {
      const activeKeys = activeMap[p] ?? 0;
      const m = monthMap[p];
      const capacity = (monthlyCapacityPerKey[p] ?? 0) * activeKeys;
      return {
        provider: p,
        active_keys: activeKeys,
        cooling_keys: coolMap[p] ?? 0,
        month_calls: m?.calls ?? 0,
        keys_used_this_month: m?.keys_used ?? 0,
        total_calls: totalMap[p] ?? 0,
        monthly_capacity: capacity || null, // null = no documented capacity (AI providers)
      };
    });
    // Precheck savings: irrelevant companies skipped today (each skipped row
    // would have cost ~5-6k paid input tokens in the full analysis).
    let precheck = { skipped_today: 0, tokens_saved_estimate: 0 };
    try {
      const row = await env.DB.prepare(`
        SELECT COUNT(*) AS n FROM customers
        WHERE customer_segment = '不相关' AND remarks LIKE '%预检判定%'
          AND updated_at >= date('now')
      `).first<{ n: number }>();
      const skipped = row?.n ?? 0;
      precheck = { skipped_today: skipped, tokens_saved_estimate: skipped * 5_500 };
    } catch { /* stats are non-critical; render zeros */ }
    return jsonResponse({ usage, precheck });
  }

  // POST /admin/api/keys/bulk — bulk import keys.
  // Template format: one entry per line, "key,label" (label = 备注/账号).
  // Also accepts key<TAB>label, key|label, or bare keys (one per line).
  // Duplicates within the paste AND keys already stored for the provider are skipped.
  if (request.method === "POST" && path === "/admin/api/keys/bulk") {
    const body = await request.json() as Record<string, unknown>;
    const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
    if (!PANEL_PROVIDERS.includes(provider as typeof PANEL_PROVIDERS[number])) {
      return jsonResponse({ detail: `provider 必须是: ${PANEL_PROVIDERS.join(", ")}` }, 400);
    }
    const raw = typeof body.keys === "string" ? body.keys : "";
    const entries = parseBulkKeyEntries(raw);
    if (entries.length === 0) {
      return jsonResponse({ detail: "未解析到任何 Key。模板格式：每行一条 `API Key,备注/账号`" }, 400);
    }
    const labelPrefix = typeof body.label_prefix === "string" ? body.label_prefix.trim().slice(0, 80) : "";
    const model = typeof body.model === "string" ? body.model.trim() || null : null;
    const rpmRaw = Number(body.rpm_limit);
    const rpmLimit = Number.isFinite(rpmRaw) && rpmRaw > 0 ? Math.floor(rpmRaw) : null;

    // Same fail-closed rule as the single-key path, checked before any query so
    // a rejected import cannot half-apply.
    if (!(await isEncryptionConfigured(env))) {
      return jsonResponse({
        detail: "尚未配置 CREDENTIAL_ENC_KEY，为避免明文写入已拒绝导入。请先在「🔐 凭据加密」中生成并保存密钥。",
      }, 400);
    }

    // Dedupe can no longer compare api_key values: two rows holding the same
    // key produce different ciphertext (random IV), so equality is meaningless.
    // Every candidate is reduced to its HMAC fingerprint instead. Rows that
    // predate the fingerprint column are fingerprinted on the fly from their
    // decrypted value, so a mixed table still detects duplicates correctly.
    const existingRows = await env.DB.prepare(
      `SELECT api_key, key_fingerprint FROM api_configs WHERE provider = ?`,
    ).bind(provider).all<{ api_key: string; key_fingerprint: string | null }>();
    const existing = new Set<string>();
    for (const row of existingRows.results ?? []) {
      try {
        existing.add(
          row.key_fingerprint ?? (await fingerprint(await decryptSecret(row.api_key, env), env)),
        );
      } catch { /* unreadable row: cannot be a duplicate we could have caught */ }
    }

    let added = 0;
    let skipped = 0;
    for (const entry of entries) {
      const encrypted = await encryptSecret(entry.key, env);
      // Also recorded as we go, so a key repeated within the same paste is
      // caught even though no row exists for it yet.
      if (existing.has(encrypted.fingerprint)) {
        skipped++;
        continue;
      }
      existing.add(encrypted.fingerprint);
      // Line-provided label wins; otherwise prefix + sequence (账号1, 账号2, …)
      const label = entry.label ?? (labelPrefix ? `${labelPrefix}${added + 1}` : null);
      await env.DB.prepare(
        `INSERT INTO api_configs (provider, label, api_key, key_hint, key_fingerprint, rpm_limit, model, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      ).bind(provider, label, encrypted.cipher, encrypted.hint, encrypted.fingerprint, rpmLimit, model).run();
      added++;
    }
    invalidateProviderCache(provider);
    await auditAdminAction(env, request, auth, "CREATE_API_KEY", "api_config", null, {
      provider, added, skipped, via: "bulk",
    });
    return jsonResponse({ ok: true, added, skipped });
  }

  // PATCH /admin/api/keys/:id — update label/rpm/model/is_active (NOT the key itself)
  const keyIdMatch = path.match(/^\/admin\/api\/keys\/(\d+)$/);
  if (keyIdMatch) {
    const id = Number(keyIdMatch[1]);
    const existing = await env.DB.prepare(`SELECT provider FROM api_configs WHERE id = ?`).bind(id)
      .first<{ provider: string }>();
    if (!existing) return jsonResponse({ detail: "Key 不存在" }, 404);

    if (request.method === "PATCH") {
      const body = await request.json() as Record<string, unknown>;
      const sets: string[] = ["updated_at = CURRENT_TIMESTAMP"];
      const binds: unknown[] = [];
      if (body.label !== undefined) {
        sets.push("label = ?");
        binds.push(typeof body.label === "string" ? body.label.trim().slice(0, 100) || null : null);
      }
      if (body.rpm_limit !== undefined) {
        const rpm = Number(body.rpm_limit);
        sets.push("rpm_limit = ?");
        binds.push(Number.isFinite(rpm) && rpm > 0 ? Math.floor(rpm) : null);
      }
      if (body.model !== undefined) {
        sets.push("model = ?");
        binds.push(typeof body.model === "string" ? body.model.trim() || null : null);
      }
      if (body.is_active !== undefined) {
        sets.push("is_active = ?");
        binds.push(body.is_active ? 1 : 0);
      }
      if (sets.length > 1) {
        binds.push(id);
        await env.DB.prepare(`UPDATE api_configs SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
        invalidateProviderCache(existing.provider);
        // Field names only — never the values (labels can hold account hints).
        await auditAdminAction(env, request, auth, "UPDATE_API_KEY", "api_config", String(id), {
          provider: existing.provider,
          fields: ["label", "rpm_limit", "model", "is_active"].filter((f) => body[f] !== undefined),
        });
      }
      return jsonResponse({ ok: true });
    }

    if (request.method === "DELETE") {
      await env.DB.prepare(`DELETE FROM api_configs WHERE id = ?`).bind(id).run();
      // Also drop any cooldown rows for this key so a re-added key starts fresh
      await env.DB.prepare(
        `DELETE FROM api_key_health WHERE provider = ? AND key_index = ?`,
      ).bind(existing.provider, `${existing.provider}:${id}`).run();
      invalidateProviderCache(existing.provider);
      await auditAdminAction(env, request, auth, "DELETE_API_KEY", "api_config", String(id), {
        provider: existing.provider,
      });
      return jsonResponse({ ok: true });
    }
  }

  // DELETE /admin/api/keys/cooldowns/:provider — manually clear active
  // cooldowns (e.g. after fixing a key or when a quota resets early)
  const cooldownMatch = path.match(/^\/admin\/api\/keys\/cooldowns\/([a-z]+)$/);
  if (cooldownMatch && request.method === "DELETE") {
    const provider = cooldownMatch[1];
    if (!PANEL_PROVIDERS.includes(provider as typeof PANEL_PROVIDERS[number])) {
      return jsonResponse({ detail: "unknown provider" }, 400);
    }
    await env.DB.prepare(`DELETE FROM api_key_health WHERE provider = ?`).bind(provider).run();
    await auditAdminAction(env, request, auth, "UPDATE_API_KEY", "api_config", null, {
      provider, via: "clear-cooldowns",
    });
    return jsonResponse({ ok: true });
  }

  // GET/PUT /admin/api/keys/settings/:provider — provider-level settings
  const settingsMatch = path.match(/^\/admin\/api\/keys\/settings\/([a-z]+)$/);
  if (settingsMatch) {
    const provider = settingsMatch[1];
    if (!PANEL_PROVIDERS.includes(provider as typeof PANEL_PROVIDERS[number])) {
      return jsonResponse({ detail: "unknown provider" }, 400);
    }
    if (request.method === "PUT") {
      const body = await request.json() as Record<string, unknown>;
      const defaultModel = typeof body.default_model === "string" ? body.default_model.trim() || null : null;
      const rpmRaw = Number(body.rpm_total);
      const rpmTotal = Number.isFinite(rpmRaw) && rpmRaw > 0 ? Math.floor(rpmRaw) : null;
      const enabled = body.enabled === undefined ? 1 : (body.enabled ? 1 : 0);
      await env.DB.prepare(
        `INSERT INTO provider_settings (provider, default_model, rpm_total, enabled, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (provider) DO UPDATE SET
           default_model = excluded.default_model,
           rpm_total = excluded.rpm_total,
           enabled = excluded.enabled,
           updated_at = CURRENT_TIMESTAMP`,
      ).bind(provider, defaultModel, rpmTotal, enabled).run();
      invalidateProviderCache(provider);
      await auditAdminAction(env, request, auth, "UPDATE_API_KEY", "provider_settings", provider, {
        via: "provider-settings",
        default_model: defaultModel,
        rpm_total: rpmTotal,
        enabled,
      });
      return jsonResponse({ ok: true });
    }
  }

  return jsonResponse({ detail: "Not Found" }, 404);
}

async function handleOutreachApi(request: Request, env: AdminEnv, auth: AdminAuthContext): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname;

    // GET /admin/api/outreach/settings - Get brand settings
    if (path === "/admin/api/outreach/settings" && request.method === "GET") {
      const settings = await getBrandSettings(env);
      return jsonResponse({ settings });
    }

    // PATCH /admin/api/outreach/settings/:brand - Update brand setting
    if (path.startsWith("/admin/api/outreach/settings/") && request.method === "PATCH") {
      const brandName = decodeURIComponent(path.split("/").pop() || "");
      const body = (await request.json()) as Record<string, unknown>;
      const updates: { company_intro?: string; enabled?: boolean; sender_email?: string | null; sender_name?: string | null; company_entity?: string | null; signature?: string | null; gmail_account?: string | null } = {};
      if (typeof body.company_intro === "string") updates.company_intro = body.company_intro;
      if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
      if (typeof body.sender_email === "string") {
        const senderEmail = body.sender_email.trim();
        if (senderEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
          return jsonResponse({ detail: "sender_email must be a valid email address" }, 400);
        }
        updates.sender_email = senderEmail || null;
      }
      if (typeof body.sender_name === "string") {
        updates.sender_name = body.sender_name.replace(/[\r\n]+/g, " ").trim() || null;
      }
      if (typeof body.company_entity === "string") {
        updates.company_entity = body.company_entity.replace(/[\r\n]+/g, " ").trim() || null;
      }
      if (typeof body.signature === "string") {
        if (body.signature.length > 5_000) return jsonResponse({ detail: "signature is too long" }, 400);
        updates.signature = body.signature || null;
      }
      if (typeof body.gmail_account === "string") {
        const ga = body.gmail_account.trim();
        if (ga && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ga)) {
          return jsonResponse({ detail: "gmail_account 必须是有效的邮箱地址（发信账号池中的服务账号或 OAuth 发件邮箱）" }, 400);
        }
        updates.gmail_account = ga || null;
      }
      await updateBrandSetting(env, brandName, updates);
      return jsonResponse({ ok: true });
    }

    // ── Brand attachments ──
    // GET /admin/api/outreach/attachments?brand=X - list metadata
    if (path === "/admin/api/outreach/attachments" && request.method === "GET") {
      const brand = url.searchParams.get("brand");
      if (!brand) return jsonResponse({ detail: "brand is required" }, 400);
      const rows = await env.DB.prepare(
        `SELECT id, brand_name, filename, mime_type, size_bytes, language, created_at
         FROM outreach_attachments WHERE brand_name = ? ORDER BY created_at`,
      ).bind(brand).all();
      return jsonResponse({ attachments: rows.results ?? [] });
    }
    // POST /admin/api/outreach/attachments - upload (JSON: brand, filename, mime_type, content_base64, language)
    if (path === "/admin/api/outreach/attachments" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        brand?: string; filename?: string; mime_type?: string; content_base64?: string; language?: string;
      };
      if (typeof body.brand !== "string" || typeof body.filename !== "string" || typeof body.content_base64 !== "string" || !body.brand.trim() || !body.filename.trim() || !body.content_base64.trim()) {
        return jsonResponse({ detail: "brand, filename and content_base64 are required strings" }, 400);
      }
      if (body.brand.length > 100) return jsonResponse({ detail: "brand is too long" }, 400);
      const b64 = body.content_base64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) {
        return jsonResponse({ detail: "附件内容不是有效的 base64" }, 400);
      }
      const sizeBytes = Math.max(0, Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0));
      if (sizeBytes <= 0) return jsonResponse({ detail: "附件不能为空" }, 400);
      // D1 limits each string/row to 2 MB; base64 expands binary data by
      // roughly 4/3, so keep raw attachments below 1.4 MB.
      if (sizeBytes > 1_400_000) return jsonResponse({ detail: "附件不能超过 1.4 MB（D1 存储限制）" }, 400);
      if (body.filename.length > 200 || /[\r\n\x00-\x1F\x7F]/.test(body.filename)) {
        return jsonResponse({ detail: "附件文件名无效" }, 400);
      }
      if (body.mime_type !== undefined && (typeof body.mime_type !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(body.mime_type))) {
        return jsonResponse({ detail: "附件 MIME 类型无效" }, 400);
      }
      // Language tag: ISO 639-1 code (es/de/fr/…) or "all" for universal
      // attachments. Empty/missing = "all" so existing callers keep working.
      const language = (typeof body.language === "string" ? body.language.trim().toLowerCase() : "") || "all";
      if (!/^[a-z]{2,3}$/.test(language) && language !== "all") {
        return jsonResponse({ detail: "language 必须是 2-3 位语言代码（如 es）或 all" }, 400);
      }
      const count = await env.DB.prepare(
        "SELECT COUNT(*) AS cnt FROM outreach_attachments WHERE brand_name = ?",
      ).bind(body.brand.trim()).first<{ cnt: number }>();
      if ((count?.cnt ?? 0) >= 5) return jsonResponse({ detail: "每个品牌最多 5 个附件" }, 400);
      await env.DB.prepare(
        `INSERT INTO outreach_attachments (brand_name, filename, mime_type, size_bytes, content_base64, language)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(body.brand.trim(), body.filename.trim().slice(0, 200), body.mime_type || "application/octet-stream", sizeBytes, b64, language).run();
      return jsonResponse({ ok: true, size_bytes: sizeBytes, language });
    }
    // DELETE /admin/api/outreach/attachments/:id
    if (path.startsWith("/admin/api/outreach/attachments/") && request.method === "DELETE") {
      const id = Number(path.split("/").pop());
      if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ detail: "Invalid id" }, 400);
      await env.DB.prepare("DELETE FROM outreach_attachments WHERE id = ?").bind(id).run();
      return jsonResponse({ ok: true });
    }

    // ── Gmail sender account pool ──
    // GET /admin/api/gmail/accounts - list (never returns private keys)
    if (path === "/admin/api/gmail/accounts" && request.method === "GET") {
      const rows = await env.DB.prepare(
        `SELECT id, label, credential_type, client_email, delegated_domain, daily_limit, enabled, last_error, cooldown_until, created_at
         FROM gmail_accounts ORDER BY id`,
      ).all().catch(() => ({ results: [] }));
      const accounts = (rows.results ?? []) as Array<Record<string, unknown>>;
      // Per-account sent-today for the panel quota cards.
      for (const a of accounts) {
        const cnt = await env.DB.prepare(
          `SELECT COUNT(*) AS cnt FROM gmail_send_log WHERE date(sent_at) = date('now') AND status = 'sent' AND sender_client_email = ?`,
        ).bind(String(a.client_email)).first<{ cnt: number }>().catch(() => null);
        a.sent_today = cnt?.cnt ?? 0;
      }
      return jsonResponse({ accounts });
    }
    // POST /admin/api/gmail/accounts - add (JSON: label, credential_type, client_email, private_key, delegated_domain?, daily_limit?)
    if (path === "/admin/api/gmail/accounts" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const clientEmail = typeof body.client_email === "string" ? body.client_email.trim() : "";
      const privateKey = typeof body.private_key === "string" ? body.private_key.trim() : "";
      const credentialType = body.credential_type === "oauth_refresh" ? "oauth_refresh" : "service_account";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
        return jsonResponse({ detail: credentialType === "oauth_refresh"
          ? "client_email 必须是发件邮箱（OAuth 令牌账号绑定该邮箱）"
          : "client_email 必须是服务账号邮箱（…@….iam.gserviceaccount.com）" }, 400);
      }
      if (credentialType === "service_account") {
        if (!privateKey.includes("PRIVATE KEY")) {
          return jsonResponse({ detail: "private_key 必须是 PEM 格式私钥（-----BEGIN PRIVATE KEY-----）" }, 400);
        }
      } else {
        // Refresh tokens are opaque URL-safe strings ~100+ chars; catch obvious mistakes.
        if (privateKey.length < 40 || /[\s<>"]/.test(privateKey)) {
          return jsonResponse({ detail: "private_key 应粘贴 OAuth refresh_token（一长串无空格字符）" }, 400);
        }
      }
      const dailyLimitRaw = Number(body.daily_limit);
      const dailyLimitVal = Number.isSafeInteger(dailyLimitRaw) && dailyLimitRaw > 0 ? dailyLimitRaw : null;
      // Quick-reference workspace domain (from the From mailbox or manual input).
      const delegatedDomain = typeof body.delegated_domain === "string" && body.delegated_domain.trim()
        ? body.delegated_domain.trim().slice(0, 200)
        : clientEmail.includes("@") && !clientEmail.endsWith(".iam.gserviceaccount.com")
          ? clientEmail.split("@")[1] || null
          : null;
      try {
        // Encrypt at rest with the same AES-GCM scheme as the AI key pool: a
        // D1 export must not hand out the company's mailboxes. decryptSecret
        // still reads legacy plaintext rows, so nothing breaks during rollout.
        const encrypted = await encryptSecret(privateKey, env);
        await env.DB.prepare(
          `INSERT INTO gmail_accounts (label, credential_type, client_email, private_key, delegated_domain, daily_limit, enabled)
           VALUES (?, ?, ?, ?, ?, ?, 1)`,
        ).bind(
          typeof body.label === "string" ? body.label.trim().slice(0, 100) || null : null,
          credentialType,
          clientEmail,
          encrypted.cipher,
          delegatedDomain,
          dailyLimitVal,
        ).run();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("UNIQUE")) return jsonResponse({ detail: "该服务账号已存在" }, 409);
        if (msg.includes("CREDENTIAL_ENC_KEY")) return jsonResponse({ detail: msg }, 400);
        return internalErrorResponse("gmail-account-save", e, request);
      }
      // Stage 9: client_email identifies the account; the private key /
      // refresh token material never enters the audit trail (§10.2).
      await auditAdminAction(env, request, auth, "CREATE_GMAIL_ACCOUNT", "gmail_account", null, {
        client_email: clientEmail,
        credential_type: credentialType,
      });
      return jsonResponse({ ok: true });
    }
    // POST /admin/api/gmail/accounts/:id/test - verify the key by requesting a Gmail token
    if (path.startsWith("/admin/api/gmail/accounts/") && path.endsWith("/test") && request.method === "POST") {
      const id = Number(path.split("/")[path.split("/").length - 2]);
      if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ detail: "Invalid id" }, 400);
      const acc = await env.DB.prepare(
        "SELECT credential_type, client_email, private_key FROM gmail_accounts WHERE id = ?",
      ).bind(id).first<{ credential_type: string | null; client_email: string; private_key: string }>();
      if (!acc) return jsonResponse({ detail: "Account not found" }, 404);
      const credType = acc.credential_type === "oauth_refresh" ? "oauth_refresh" as const : "service_account" as const;
      try {
        // Reads both new ciphertext and legacy plaintext rows.
        const keyMaterial = await decryptSecret(acc.private_key, env);
        await getAccessToken(env, acc.client_email, keyMaterial, acc.client_email, credType);
        await noteGmailAccountResult(env, acc.client_email, true);
        return jsonResponse({ ok: true, detail: credType === "oauth_refresh" ? "refresh token 有效，token 获取成功" : "私钥有效，token 获取成功" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await noteGmailAccountResult(env, acc.client_email, false, msg);
        return jsonResponse({ ok: false, detail: msg }, 200);
      }
    }
    // PATCH /admin/api/gmail/accounts/:id - toggle enabled / daily_limit / label
    if (path.startsWith("/admin/api/gmail/accounts/") && request.method === "PATCH") {
      const id = Number(path.split("/").pop());
      if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ detail: "Invalid id" }, 400);
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const sets: string[] = [];
      const binds: unknown[] = [];
      if (typeof body.enabled === "boolean") {
        sets.push("enabled = ?");
        binds.push(body.enabled ? 1 : 0);
        if (body.enabled) {
          sets.push("cooldown_until = NULL");
          sets.push("last_error = NULL");
        }
      }
      if (typeof body.label === "string") {
        sets.push("label = ?");
        binds.push(body.label.trim().slice(0, 100) || null);
      }
      if (body.daily_limit !== undefined) {
        const n = Number(body.daily_limit);
        sets.push("daily_limit = ?");
        binds.push(Number.isSafeInteger(n) && n > 0 ? n : null);
      }
      if (sets.length === 0) return jsonResponse({ detail: "No updates" }, 400);
      sets.push("updated_at = CURRENT_TIMESTAMP");
      binds.push(id);
      await env.DB.prepare(`UPDATE gmail_accounts SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
      await auditAdminAction(env, request, auth, "UPDATE_GMAIL_ACCOUNT", "gmail_account", String(id), {
        fields: ["enabled", "label", "daily_limit"].filter((f) => (body as Record<string, unknown>)[f] !== undefined),
      });
      return jsonResponse({ ok: true });
    }
    // DELETE /admin/api/gmail/accounts/:id
    if (path.startsWith("/admin/api/gmail/accounts/") && request.method === "DELETE") {
      const id = Number(path.split("/").pop());
      if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ detail: "Invalid id" }, 400);
      await env.DB.prepare("DELETE FROM gmail_accounts WHERE id = ?").bind(id).run();
      await auditAdminAction(env, request, auth, "DELETE_GMAIL_ACCOUNT", "gmail_account", String(id));
      return jsonResponse({ ok: true });
    }
    // POST /admin/api/gmail/encrypt-all — convert legacy cleartext sender
    // credentials in place, same idea as /admin/api/keys/encrypt-all. Idempotent:
    // rows already carrying the enc:v1: prefix are skipped.
    if (request.method === "POST" && path === "/admin/api/gmail/encrypt-all") {
      try {
        // Fail fast before any write, mirroring /admin/api/keys/encrypt-all:
        // a missing key must not abort halfway through live credentials.
        if (!(await isEncryptionConfigured(env))) {
          return jsonResponse({
            detail: "尚未配置 CREDENTIAL_ENC_KEY：请先在「🔐 凭据加密」中生成并保存，再执行加密。",
          }, 400);
        }
        const rows = await env.DB.prepare(
          "SELECT id, private_key FROM gmail_accounts WHERE private_key NOT LIKE 'enc:v1:%'",
        ).all<{ id: number; private_key: string }>();
        let converted = 0;
        const failedRows: Array<{ id: number; reason: string }> = [];
        for (const row of rows.results ?? []) {
          // Stage 4 (spec 5.2) verification gate: decrypt roundtrip + fingerprint
          // must both check out before the plaintext row is replaced.
          const encrypted = await encryptSecret(row.private_key, env);
          const roundtrip = await decryptSecret(encrypted.cipher, env);
          if (roundtrip !== row.private_key) {
            failedRows.push({ id: row.id, reason: "解密回读不一致，已跳过（原值未动）" });
            continue;
          }
          if ((await fingerprint(roundtrip, env)) !== encrypted.fingerprint) {
            failedRows.push({ id: row.id, reason: "指纹校验不一致，已跳过（原值未动）" });
            continue;
          }
          await env.DB.prepare(
            "UPDATE gmail_accounts SET private_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          ).bind(encrypted.cipher, row.id).run();
          converted++;
           safeLog("log",
             `[security-v2:credential-migration] table=gmail_accounts id=${row.id} event=encrypted-verified`,
           );
        }
        const left = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM gmail_accounts WHERE private_key NOT LIKE 'enc:v1:%'",
        ).first<{ n: number }>();
        await auditAdminAction(env, request, auth, "UPDATE_GMAIL_ACCOUNT", "gmail_account", null, {
          via: "encrypt-all",
          converted,
          remaining: left?.n ?? 0,
        });
        return jsonResponse({ ok: failedRows.length === 0, converted, remaining: left?.n ?? 0, failed: failedRows });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("CREDENTIAL_ENC_KEY")) return jsonResponse({ detail: msg }, 400);
        return internalErrorResponse("gmail-encrypt-all", e, request);
      }
    }

    // POST /admin/api/gmail/reseal — key-rotation sweep for the sender pool
    // (post-V2), same contract as /admin/api/keys/reseal: rows sealed under
    // CREDENTIAL_ENC_KEY_PREVIOUS and legacy plaintext private keys are
    // re-encrypted with the current master; rows already under the current
    // key are counted, not touched. gmail_accounts carries no fingerprint
    // columns, so the verification gate is the decrypt roundtrip alone.
    if (request.method === "POST" && path === "/admin/api/gmail/reseal") {
      try {
        if (!(await isEncryptionConfigured(env))) {
          return jsonResponse({
            detail: "尚未配置 CREDENTIAL_ENC_KEY：请先在「🔐 凭据加密」中生成并保存，再执行重密封。",
          }, 400);
        }
        const currentKeys = await requireEncKeys(env);
        const previousKeys = await getPreviousEncKeys(env);
        const rows = await env.DB.prepare(
          "SELECT id, private_key FROM gmail_accounts",
        ).all<{ id: number; private_key: string }>();
        let resealed = 0;
        let alreadyCurrent = 0;
        const failedRows: Array<{ id: number; reason: string }> = [];
        for (const row of rows.results ?? []) {
          try {
            let plain: string | null;
            if (isEncrypted(row.private_key)) {
              plain = await tryDecryptSecret(row.private_key, currentKeys);
              if (plain !== null) {
                alreadyCurrent++;
                continue;
              }
              plain = previousKeys ? await tryDecryptSecret(row.private_key, previousKeys) : null;
              if (plain === null) {
                failedRows.push({ id: row.id, reason: "当前/备用密钥均无法解密，已跳过（原值未动）" });
                continue;
              }
            } else {
              plain = row.private_key;
            }
            const encrypted = await encryptSecret(plain, env);
            const roundtrip = await tryDecryptSecret(encrypted.cipher, currentKeys);
            if (roundtrip !== plain) {
              failedRows.push({ id: row.id, reason: "解密回读不一致，已跳过（原值未动）" });
              continue;
            }
            await env.DB.prepare(
              "UPDATE gmail_accounts SET private_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            ).bind(encrypted.cipher, row.id).run();
            resealed++;
            safeLog("log",
              `[security-v2:credential-rotation] table=gmail_accounts id=${row.id} event=resealed-under-current-key`,
            );
          } catch (error) {
            failedRows.push({ id: row.id, reason: error instanceof Error ? error.message : "unknown" });
          }
        }
        const plaintextLeft = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM gmail_accounts WHERE private_key NOT LIKE 'enc:v1:%'",
        ).first<{ n: number }>();
        await auditAdminAction(env, request, auth, "UPDATE_GMAIL_ACCOUNT", "gmail_account", null, {
          via: "reseal",
          resealed,
          already_current: alreadyCurrent,
          previous_key_in_use: previousKeys !== null,
          failed: failedRows.length,
        });
        return jsonResponse({
          ok: failedRows.length === 0,
          resealed,
          already_current: alreadyCurrent,
          plaintext_remaining: plaintextLeft?.n ?? 0,
          failed: failedRows,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("CREDENTIAL_ENC_KEY")) return jsonResponse({ detail: msg }, 400);
        return internalErrorResponse("gmail-reseal", e, request);
      }
    }

    // POST /admin/api/outreach/generate - Generate outreach emails
    if (path === "/admin/api/outreach/generate" && request.method === "POST") {
      const body = (await request.json()) as { brand?: string; limit?: number };
      if (typeof body.brand !== "string" || !body.brand.trim()) return jsonResponse({ detail: "brand is required" }, 400);
      const requestedLimit = Number(body.limit ?? 10);
      if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
        return jsonResponse({ detail: "limit must be an integer from 1 to 50" }, 400);
      }
      const result = await generateOutreachEmails(env, body.brand.trim(), requestedLimit, getRequestId(request));
      await auditAdminAction(env, request, auth, "GENERATE_EMAIL", "outreach_email", null, {
        brand: body.brand.trim(),
        limit: requestedLimit,
        generated: result.generated,
      });
      return jsonResponse(result);
    }

    // GET /admin/api/outreach/emails - List outreach emails
    if (path === "/admin/api/outreach/emails" && request.method === "GET") {
      const result = await getOutreachEmails(env, {
        brand: url.searchParams.get("brand") || undefined,
        status: url.searchParams.get("status") || undefined,
        limit: Number(url.searchParams.get("limit") || 50),
        offset: Number(url.searchParams.get("offset") || 0),
      });
      return jsonResponse(result);
    }

    // GET /admin/api/outreach/stats - Get outreach statistics
    if (path === "/admin/api/outreach/stats" && request.method === "GET") {
      const stats = await getOutreachStats(env);
      return jsonResponse(stats);
    }

    // GET /admin/api/outreach/quota - Gmail daily send quota
    if (path === "/admin/api/outreach/quota" && request.method === "GET") {
      return jsonResponse(await getQuota(env));
    }

    // POST /admin/api/outreach/send-batch - Send draft emails via Gmail with rate limiting
    if (path === "/admin/api/outreach/send-batch" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { brand?: string; limit?: number };
      const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50);
      const params: unknown[] = [];
      // Stage 10: 'failed' rows are retried by the next batch (the state
      // machine guarantees a claimed row cannot be double-sent); rows in
      // reserved/sending/uncertain are deliberately NOT picked here.
      let clause = "WHERE e.status IN ('draft', 'failed') AND e.email_to IS NOT NULL AND e.email_to != ''";
      if (body.brand) {
        clause += " AND brand_name = ?";
        params.push(body.brand);
      }
      const drafts = await env.DB.prepare(
        `SELECT e.id, e.email_to, e.subject, e.body, e.brand_name, s.sender_email, s.sender_name, s.gmail_account, c.country
         FROM outreach_emails e
         LEFT JOIN outreach_settings s ON s.brand_name = e.brand_name
         LEFT JOIN customers c ON c.id = e.customer_id
         ${clause} ORDER BY e.id LIMIT ?`,
      ).bind(...params, limit).all<{ id: number; email_to: string; subject: string | null; body: string | null; brand_name: string | null; sender_email: string | null; sender_name: string | null; gmail_account: string | null; country: string | null }>();

      const quota = await getQuota(env);
      const delayMs = sendDelayMs(env);
      const results: Array<{ id: number; ok: boolean; error?: string; outcome?: string }> = [];
      let sent = 0;
      for (const draft of drafts.results) {
        if (quota.sent_today + sent >= quota.daily_limit) {
          results.push({ id: draft.id, ok: false, error: "今日配额已用完，未发送" });
          continue;
        }
        if (sent > 0) await new Promise((r) => setTimeout(r, delayMs));
        try {
          const r = await sendWithStateMachine(env, draft, {
            fromEmail: draft.sender_email,
            fromName: draft.sender_name,
            brandName: draft.brand_name,
            // Spanish customers get the Spanish catalog, etc.
            attachmentLanguage: attachmentLangForCountry(draft.country),
            // Brand-bound service account (empty = auto-pick from the pool).
            gmailAccount: draft.gmail_account,
            requestId: getRequestId(request),
          });
          if (r.ok) sent++;
          results.push({ id: draft.id, ok: r.ok, error: r.error, outcome: r.outcome });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          results.push({ id: draft.id, ok: false, error: msg });
          if (e instanceof GmailConfigError) break; // config missing: stop the batch
        }
      }
      const after = await getQuota(env);
      await auditAdminAction(env, request, auth, "SEND_EMAIL", "outreach_email", null, {
        via: "send-batch",
        brand: body.brand ?? null,
        attempted: drafts.results.length,
        sent,
        failed: results.filter((r) => !r.ok).length,
      });
      return jsonResponse({
        attempted: drafts.results.length,
        sent,
        failed: results.filter((r) => !r.ok).length,
        quota: after,
        results,
      });
    }

    // PATCH /admin/api/outreach/emails/:id - Update email
    if (path.startsWith("/admin/api/outreach/emails/") && request.method === "PATCH") {
      const id = Number(path.split("/").pop());
      if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ detail: "Invalid id" }, 400);
      const body = (await request.json()) as Record<string, unknown>;
      const updates: { status?: string; subject?: string; body?: string } = {};
      // Status is restricted: real sending goes through send-batch/send-one;
      // 'draft' is only allowed to revert a mistaken manual mark.
      if (body.status === "draft") updates.status = body.status;
      if (typeof body.subject === "string") updates.subject = body.subject;
      if (typeof body.body === "string") updates.body = body.body;
      await updateOutreachEmail(env, id, updates);
      return jsonResponse({ ok: true });
    }

    // POST /admin/api/outreach/emails/:id/send - Send a single draft via Gmail
    if (path.startsWith("/admin/api/outreach/emails/") && path.endsWith("/send") && request.method === "POST") {
      const id = Number(path.split("/")[path.split("/").length - 2]);
      if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ detail: "Invalid id" }, 400);
      const row = await env.DB.prepare(
        `SELECT e.id, e.email_to, e.subject, e.body, e.status, e.brand_name, c.country, s.gmail_account
         FROM outreach_emails e
         LEFT JOIN customers c ON c.id = e.customer_id
         LEFT JOIN outreach_settings s ON s.brand_name = e.brand_name
         WHERE e.id = ?`,
      ).bind(id).first<{ id: number; email_to: string; subject: string | null; body: string | null; status: string; brand_name: string | null; country: string | null; gmail_account: string | null }>();
      if (!row) return jsonResponse({ detail: "Email not found" }, 404);
      // Stage 10: failed drafts may be retried; in-flight and unknown-outcome
      // rows must never be re-entered (the state machine would skip them
      // anyway — this gate just gives the operator an honest message).
      if (row.status === "reserved" || row.status === "sending") {
        return jsonResponse({ detail: "该邮件正在发送中，请勿重复点击" }, 409);
      }
      if (row.status === "uncertain") {
        return jsonResponse({ detail: "该邮件上次发送结果未知（可能已送达），已阻止重发；请核实后再处理" }, 409);
      }
      if (row.status !== "draft" && row.status !== "failed") {
        return jsonResponse({ detail: "只有草稿或失败的邮件可以发送" }, 400);
      }
      // Resolve the sending identity from the email's brand (falls back to
      // the global GMAIL_SENDER_EMAIL when the brand has none).
      let fromEmail: string | null = null;
      let fromName: string | null = null;
      if (row.brand_name) {
        const brand = await env.DB.prepare(
          "SELECT sender_email, sender_name FROM outreach_settings WHERE brand_name = ?",
        ).bind(row.brand_name).first<{ sender_email: string | null; sender_name: string | null }>();
        fromEmail = brand?.sender_email ?? null;
        fromName = brand?.sender_name ?? null;
      }
      const result = await sendWithStateMachine(env, row, {
        fromEmail,
        fromName,
        brandName: row.brand_name,
        attachmentLanguage: attachmentLangForCountry(row.country),
        gmailAccount: row.gmail_account,
        requestId: getRequestId(request),
      });
      const quota = await getQuota(env);
      await auditAdminAction(env, request, auth, "SEND_EMAIL", "outreach_email", String(id), {
        ok: result.ok,
        outcome: result.outcome,
      });
      return jsonResponse({ ok: result.ok, error: result.error, gmail_message_id: result.gmail_message_id, outcome: result.outcome, from: fromEmail, quota });
    }

    // DELETE /admin/api/outreach/emails/:id - Delete email
    if (path.startsWith("/admin/api/outreach/emails/") && request.method === "DELETE") {
      const id = Number(path.split("/").pop());
      if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ detail: "Invalid id" }, 400);
      await deleteOutreachEmail(env, id);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ detail: "Not Found" }, 404);
  } catch (error) {
    return internalErrorResponse("outreach-api", error, request);
  }
}

// ── 定向群发 API (targeted outreach: groups + resumable campaigns) ───────
// Every write here is gated on the same filters as the preview, and a campaign
// only ever touches customers that were snapshotted into its members table —
// so "全部发送" is always a bounded, auditable set rather than a live query
// over a table that is still being rewritten by the research pipeline.
function parseBatchSize(value: unknown, fallback = 10): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  return Math.min(n, 50);
}

// Exported for the CRM sales layer (src/crm.ts) — same tolerant body reader
// for every JSON API surface.
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const body = (await request.json().catch(() => ({}))) as unknown;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Invalid JSON body");
  }
  return body as Record<string, unknown>;
}

async function handleCampaignApi(request: Request, env: AdminEnv, auth: AdminAuthContext): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname;

    // POST /admin/api/outreach/segment-preview — count a customer group before
    // committing any AI or send budget to it.
    if (path === "/admin/api/outreach/segment-preview" && request.method === "POST") {
      const body = await readJsonBody(request);
      // Phase 10: dimension floors clamp against the weights effective NOW
      // (fail-open to the code defaults) — the preview is a live build.
      const weights = await loadLeadScoreWeights(env);
      const filters = parseSegmentFilters(body.filters ?? body, weights);
      const brand = typeof body.brand === "string" ? body.brand.trim() || null : null;
      return jsonResponse(await previewSegment(env, filters, brand));
    }

    // GET /admin/api/persona-roles — distinct buyer-persona roles across
    // CURRENT research runs, with the count of distinct customers carrying
    // each role. persona_roles and role_priority both match these values
    // exactly, so the form's datalists must offer exactly what exists
    // (Stage 51 leftover: the input shipped without its options source).
    // Fail-open on a missing research_personas table (migration pending):
    // an empty datalist is harmless, a 500 on panel load is not.
    if (path === "/admin/api/persona-roles" && request.method === "GET") {
      try {
        const roles = await env.DB.prepare(
          `SELECT rp.persona_role AS persona_role, COUNT(DISTINCT rp.customer_id) AS n
           FROM research_personas rp
           WHERE rp.is_current = 1 AND rp.persona_role IS NOT NULL AND rp.persona_role != ''
           GROUP BY rp.persona_role ORDER BY n DESC, rp.persona_role LIMIT 100`,
        ).all<{ persona_role: string; n: number }>();
        return jsonResponse({ roles: roles.results });
      } catch (e) {
        safeLog("warn", "[admin:persona-roles] lookup failed, serving empty (fail-open)", e);
        return jsonResponse({ roles: [] });
      }
    }

    // ── Saved groups (可复用客群) ──
    if (path === "/admin/api/outreach/groups" && request.method === "GET") {
      return jsonResponse({ groups: await listGroups(env) });
    }
    if (path === "/admin/api/outreach/groups" && request.method === "POST") {
      const body = await readJsonBody(request);
      const id = await createGroup(env, {
        name: String(body.name ?? ""),
        description: typeof body.description === "string" ? body.description : null,
        filters: body.filters,
      });
      return jsonResponse({ ok: true, id });
    }
    if (path.startsWith("/admin/api/outreach/groups/") && request.method === "PATCH") {
      const id = Number(path.split("/").pop());
      if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ detail: "Invalid id" }, 400);
      const body = await readJsonBody(request);
      await updateGroup(env, id, body);
      return jsonResponse({ ok: true });
    }
    if (path.startsWith("/admin/api/outreach/groups/") && request.method === "DELETE") {
      const id = Number(path.split("/").pop());
      if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ detail: "Invalid id" }, 400);
      await deleteGroup(env, id);
      return jsonResponse({ ok: true });
    }

    // ── Campaigns (群发任务) ──
    if (path === "/admin/api/outreach/campaigns" && request.method === "GET") {
      return jsonResponse({ campaigns: await listCampaigns(env) });
    }
    if (path === "/admin/api/outreach/campaigns" && request.method === "POST") {
      const body = await readJsonBody(request);
      const brandName = String(body.brand ?? "");
      // Phase 10: the campaign's segment is built NOW — both filter sources
      // (a saved group's stored JSON or a fresh body) clamp their dimension
      // floors against the weights effective at this moment (fail-open).
      const weights = await loadLeadScoreWeights(env);
      let filters: ReturnType<typeof parseSegmentFilters>;
      let groupId: number | null = null;
      let groupName: string | null = null;
      if (body.group_id !== undefined && body.group_id !== null && body.group_id !== "") {
        const gid = Number(body.group_id);
        if (!Number.isSafeInteger(gid) || gid <= 0) return jsonResponse({ detail: "Invalid group_id" }, 400);
        const group = await env.DB.prepare(
          "SELECT id, name, filters FROM outreach_groups WHERE id = ?",
        ).bind(gid).first<{ id: number; name: string; filters: string }>();
        if (!group) return jsonResponse({ detail: "客群不存在" }, 404);
        // A campaign launched from a saved group uses the group's stored
        // filters, so the preview the operator saw cannot drift from the send.
        filters = deserializeFilters(group.filters, weights);
        groupId = group.id;
        groupName = group.name;
      } else {
        filters = parseSegmentFilters(body.filters ?? body, weights);
      }
      const created = await createCampaign(env, {
        name: body.name,
        brandName,
        groupId,
        groupName,
        filters,
      });
      await auditAdminAction(env, request, auth, "CREATE_CAMPAIGN", "campaign", String(created.id), {
        brand: brandName,
        group_id: groupId,
        members: created.total,
        companies: created.companies,
        capped: created.capped,
        per_person: filters.perPerson,
      });
      return jsonResponse({ ok: true, ...created });
    }

    // /admin/api/outreach/campaigns/:id[/members|/generate|/send|/status]
    const campaignMatch = path.match(/^\/admin\/api\/outreach\/campaigns\/(\d+)(\/[a-z]+)?$/);
    if (campaignMatch) {
      const id = Number(campaignMatch[1]);
      if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ detail: "Invalid id" }, 400);
      const action = campaignMatch[2] ?? "";

      if (action === "" && request.method === "GET") {
        const campaign = await getCampaign(env, id);
        if (!campaign) return jsonResponse({ detail: "群发任务不存在" }, 404);
        return jsonResponse({ campaign });
      }
      if (action === "" && request.method === "DELETE") {
        await deleteCampaign(env, id);
        await auditAdminAction(env, request, auth, "DELETE_CAMPAIGN", "campaign", String(id));
        return jsonResponse({ ok: true });
      }
      if (action === "/members" && request.method === "GET") {
        const campaign = await getCampaign(env, id);
        if (!campaign) return jsonResponse({ detail: "群发任务不存在" }, 404);
        const result = await listCampaignMembers(env, id, {
          status: url.searchParams.get("status") || undefined,
          limit: Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200),
          offset: Math.max(Number(url.searchParams.get("offset")) || 0, 0),
        });
        return jsonResponse({ campaign, ...result });
      }
      if (action === "/generate" && request.method === "POST") {
        const body = await readJsonBody(request);
        const limit = parseBatchSize(body.limit, 10);
        const result = await runCampaignGenerate(env, id, limit, {}, getRequestId(request));
        await auditAdminAction(env, request, auth, "GENERATE_EMAIL", "campaign", String(id), {
          via: "campaign-generate",
          limit,
          generated: result.generated,
          failed: result.failed,
        });
        return jsonResponse(result);
      }
      if (action === "/send" && request.method === "POST") {
        const body = await readJsonBody(request);
        const limit = parseBatchSize(body.limit, 10);
        const result = await runCampaignSend(env, id, limit, {}, getRequestId(request));
        await auditAdminAction(env, request, auth, "SEND_EMAIL", "campaign", String(id), {
          via: "campaign-send",
          limit,
          sent: result.generated,
          failed: result.failed,
        });
        return jsonResponse(result);
      }
      if (action === "/status" && request.method === "POST") {
        const body = await readJsonBody(request);
        const status = String(body.status ?? "");
        if (status !== "draft" && status !== "paused" && status !== "done") {
          return jsonResponse({ detail: "status must be draft, paused or done" }, 400);
        }
        await setCampaignStatus(env, id, status);
        await auditAdminAction(env, request, auth, "UPDATE_CAMPAIGN", "campaign", String(id), { status });
        return jsonResponse({ ok: true });
      }
      if (action === "/auto" && request.method === "POST") {
        const body = await readJsonBody(request);
        const enabled = body.enabled === true;
        await setCampaignAutoAdvance(env, id, enabled);
        await auditAdminAction(env, request, auth, "UPDATE_CAMPAIGN", "campaign", String(id), { auto_advance: enabled });
        return jsonResponse({ ok: true });
      }
    }

    return jsonResponse({ detail: "Not Found" }, 404);
  } catch (error) {
    // Busy campaign (Stage 12, spec §13): another execution holds the lock —
    // 409 turns this into an actionable "稍后重试" toast instead of a 500.
    if (error instanceof CampaignLockedError) {
      return jsonResponse({ detail: error.message }, 409);
    }
    const msg = error instanceof Error ? error.message : String(error);
    // Input problems (bad filter JSON, unknown brand, empty match) are the
    // operator's to fix — 400 keeps the panel message actionable instead of
    // reporting a server fault. Anything else is an unexpected fault and must
    // not be echoed back: this used to return `msg` for both cases.
    const isUserError = /不能为空|必须是|最多|不存在|未启用|尚未配置|没有匹配|已存在|超出|Invalid/.test(msg);
    if (!isUserError) return internalErrorResponse("campaign-api", error, request);
    return jsonResponse({ detail: msg }, 400);
  }
}

/** Stage 15 (spec §16): read the completeness score independently of the
 * shared CUSTOMER_COLUMNS list, so existing fixtures/panels that do not know
 * the column keep working. Returns null while the migration is pending. */
async function getCustomerCompleteness(env: AdminEnv, id: number): Promise<number | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT data_completeness_score FROM customers WHERE id = ?",
    ).bind(id).first<{ data_completeness_score: number | null }>();
    return row?.data_completeness_score ?? null;
  } catch (e) {
    if (e instanceof Error && e.message.includes("no such column")) return null;
    throw e;
  }
}

/** Phase 5 Stage 43 (建议 §十八): read the lead score's six-dimension
 * breakdown the same fail-open way — not in the shared column lists, so
 * migration-pending databases and bare test fixtures keep working. Returns
 * null (raw JSON string) while the migration is pending or the row predates
 * Stage 43 / was skipped by the relevance precheck. */
async function getCustomerLeadScoreBreakdown(env: AdminEnv, id: number): Promise<string | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT lead_score_breakdown FROM customers WHERE id = ?",
    ).bind(id).first<{ lead_score_breakdown: string | null }>();
    return row?.lead_score_breakdown ?? null;
  } catch (e) {
    if (e instanceof Error && e.message.includes("no such column")) return null;
    throw e;
  }
}

/** Row shape of the read-only audit view (GET /admin/api/audit-logs). */
interface AuditLogViewRow {
  id: string;
  created_at: string;
  actor_user_id: string | null;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  request_id: string | null;
  metadata_json: string | null;
}

async function handleAdminApi(request: Request, env: AdminEnv, auth: AdminAuthContext): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname === "/admin/api/customers" && request.method === "GET") {
      return await listCustomers(request, env);
    }
    // POST /admin/api/customers/import — seed-data CSV import (docx ① Data Import).
    // Original rows land in customer_imports untouched; deduped new companies
    // are inserted as pending customers so the cron pipeline enriches them.
    if (url.pathname === "/admin/api/customers/import" && request.method === "POST") {
      return await importCustomersCsv(request, env, auth);
    }
    // GET /admin/api/customers/pre-filter — 海选: SQL-only targeting over
    // verified fields so users can shrink 50k rows to a research-worthy set
    // before spending any crawl/AI budget (docx 建议 Step 2 Pre-Filter).
    if (url.pathname === "/admin/api/customers/pre-filter" && request.method === "GET") {
      return await preFilterCustomers(request, env, auth);
    }
    // GET /admin/api/customers/lead-score-histogram — bucketed lead_score
    // distribution over completed rows, for the panel overview card.
    if (url.pathname === "/admin/api/customers/lead-score-histogram" && request.method === "GET") {
      const rows = await env.DB.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN lead_score IS NULL THEN 1 ELSE 0 END) AS unscored,
          SUM(CASE WHEN lead_score >= 80 THEN 1 ELSE 0 END) AS s80,
          SUM(CASE WHEN lead_score >= 60 AND lead_score < 80 THEN 1 ELSE 0 END) AS s60,
          SUM(CASE WHEN lead_score >= 40 AND lead_score < 60 THEN 1 ELSE 0 END) AS s40,
          SUM(CASE WHEN lead_score < 40 THEN 1 ELSE 0 END) AS s0
        FROM customers WHERE status = 'completed'
      `).first<{ total: number; unscored: number; s80: number; s60: number; s40: number; s0: number }>();
      return jsonResponse(rows ?? { total: 0, unscored: 0, s80: 0, s60: 0, s40: 0, s0: 0 });
    }
    // Phase 10 Stage 55 — GET /admin/api/lead-score/config: the effective
    // six-dimension weights, the code defaults (the panel's reset-to-default
    // affordance), and when the profile was last tuned. Fail-open to
    // defaults pre-tune/pre-migration — the read must always answer.
    // Gated customers.read in rbac.ts (the score is customer data).
    if (url.pathname === "/admin/api/lead-score/config" && request.method === "GET") {
      const config = await loadLeadScoreConfig(env);
      return jsonResponse({
        weights: config.weights,
        // Shallow copy, never the module-level object: pre-tune the config
        // resolves to LEAD_SCORE_WEIGHTS by reference, and sanitizeResponse's
        // cycle guard (shared WeakSet) redacts any value it has already
        // walked — the same reference under both keys would answer
        // "[REDACTED]" instead of the defaults.
        defaults: { ...LEAD_SCORE_WEIGHTS },
        updated_at: config.updatedAt,
      });
    }
    // PUT /admin/api/lead-score/config — retune the dimension weights. The
    // body IS the weights object: exactly the six dimension keys, each an
    // integer 0-100, summing to exactly 100 (the frozen 0-100 total
    // contract) — anything else is a 400 carrying the reason. Audited with
    // old→new weights; the Stage 57 re-score sweep is what makes the stored
    // per-customer scores follow. Gated scores.write (super_admin +
    // operator) in rbac.ts; fail-loud on save (a silent no-op config write
    // would be a lie).
    if (url.pathname === "/admin/api/lead-score/config" && request.method === "PUT") {
      const raw: unknown = await request.json().catch(() => null);
      const parsed = parseLeadScoreWeights(raw);
      if (!parsed.ok) return jsonResponse({ detail: parsed.error }, 400);
      const before = await loadLeadScoreConfig(env);
      const updatedAt = await saveLeadScoreWeights(env, parsed.weights, auth.user.id);
      await auditAdminAction(env, request, auth, "UPDATE_SCORE_CONFIG", "lead_score_config", "1", {
        old_weights: before.weights,
        new_weights: parsed.weights,
      });
      return jsonResponse({ ok: true, weights: parsed.weights, updated_at: updatedAt });
    }
    // POST /admin/api/lead-score/rescore — Phase 10 Stage 57: the re-score
    // sweep. A retune only rewrites the config; the stored per-customer
    // scores stay stale (they were computed under the old profile) until
    // this walks every completed row with a segment, rebuilds the engine
    // inputs from the stored analysis columns + the LIVE contacts table
    // (merge-visibility: a contact merged in after the analysis counts for
    // buyer_role/reachability like a found one), recomputes under the
    // currently-saved weights, and writes lead_score/lead_score_breakdown.
    // 不相关 rows re-zero (score 0, all-zero breakdown); pending/processing/
    // failed rows and data_completeness_score are untouched (separate axis —
    // the sweep never re-runs research). Audited RESCORE_LEADS with counts +
    // the applied weights. Gated scores.write (super_admin + operator) in
    // rbac.ts. Chunked by id cursor (100 rows/query, D1 parameter caps); the
    // contacts lookup rides the company_id index.
    if (url.pathname === "/admin/api/lead-score/rescore" && request.method === "POST") {
      const weights = await loadLeadScoreWeights(env);
      const parseColumn = (raw: string | null): unknown => {
        if (!raw) return null;
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      };
      let scanned = 0;
      let rescored = 0;
      let zeroed = 0;
      let cursor = 0;
      for (;;) {
        const chunk = (
          await env.DB.prepare(`
            SELECT id, company_id, customer_segment, product_categories, company_size, geographic_coverage, personas_and_solutions, buying_signals
            FROM customers
            WHERE status = 'completed' AND customer_segment IS NOT NULL AND id > ?
            ORDER BY id LIMIT 100
          `)
            .bind(cursor)
            .all<{
              id: number;
              company_id: string;
              customer_segment: string;
              product_categories: string | null;
              company_size: string | null;
              geographic_coverage: string | null;
              personas_and_solutions: string | null;
              buying_signals: string | null;
            }>()
        ).results ?? [];
        if (chunk.length === 0) break;
        for (const row of chunk) {
          cursor = row.id;
          // Live contacts, not the analysis snapshot: a post-analysis
          // merge/import must move the score without re-research
          // (docs/phase10-lead-score-config.md §4).
          const contacts = (
            await env.DB.prepare(
              "SELECT first_name, last_name, email, cellphone, whatsapp FROM contacts WHERE company_id = ?",
            )
              .bind(row.company_id)
              .all<{
                first_name: string | null;
                last_name: string | null;
                email: string | null;
                cellphone: string | null;
                whatsapp: string | null;
              }>()
          ).results ?? [];
          const signalsRaw = parseColumn(row.buying_signals);
          const inputs: LeadScoreInputs = {
            customer_segment: row.customer_segment,
            product_categories: row.product_categories,
            company_size: row.company_size,
            geographic_coverage: row.geographic_coverage,
            personas_and_solutions: parseColumn(row.personas_and_solutions),
            buying_signals: Array.isArray(signalsRaw)
              ? signalsRaw.filter((s): s is string => typeof s === "string")
              : [],
            found_contacts: contacts,
          };
          const breakdown = computeLeadScoreV2(inputs, weights);
          const total = Math.min(
            100,
            breakdown.icp_fit + breakdown.product_fit + breakdown.buyer_role +
              breakdown.buying_signal + breakdown.reachability + breakdown.strategic_value,
          );
          await env.DB.prepare(
            "UPDATE customers SET lead_score = ?, lead_score_breakdown = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          )
            .bind(total, JSON.stringify(breakdown), row.id)
            .run();
          scanned += 1;
          if (total > 0) rescored += 1;
          else zeroed += 1;
        }
      }
      await auditAdminAction(env, request, auth, "RESCORE_LEADS", "lead_score", null, {
        scanned,
        rescored,
        zeroed,
        weights: { ...weights },
      });
      return jsonResponse({ ok: true, scanned, rescored, zeroed });
    }
    // GET /admin/api/customers/filter-options — option lists (with live match
    // counts) behind the 海选 / 定向群发 filter dropdowns. Counts reuse the
    // LIKE expressions of buildSegmentWhere(), so the number shown next to an
    // option is what 统计匹配 will really return once it is ticked.
    if (url.pathname === "/admin/api/customers/filter-options" && request.method === "GET") {
      return jsonResponse(await buildFilterOptions(env, url.searchParams.get("facets")));
    }
    // GET /admin/api/audit-logs — read-only view over the audit trail
    // (post-V2, Remaining Risks #5 companion). audit.read gate is in rbac.ts.
    // Query: ?limit= (default 100, clamp 1..500), ?before=<created_at> cursor
    // (strictly older rows), ?action= exact filter. ip_hash / user_agent_hash
    // stay out of the response — the panel answers "what happened", not "who
    // sat behind which address".
    if (url.pathname === "/admin/api/audit-logs" && request.method === "GET") {
      const limitRaw = Number(url.searchParams.get("limit") ?? "100");
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 500) : 100;
      const before = url.searchParams.get("before");
      const action = url.searchParams.get("action")?.trim() ?? "";
      const where: string[] = [];
      const params: string[] = [];
      if (before && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(before)) {
        where.push("created_at < ?");
        params.push(before);
      }
      if (action !== "") {
        where.push("action = ?");
        params.push(action);
      }
      const rows = await env.DB.prepare(
        `SELECT id, created_at, actor_user_id, actor_role, action, resource_type, resource_id, request_id, metadata_json
         FROM audit_logs ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).bind(...params, String(limit)).all<AuditLogViewRow>();
      const logs = (rows.results ?? []).map((row) => {
        let metadata: unknown = null;
        try {
          metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null;
        } catch {
          metadata = null;
        }
        return { ...row, metadata_json: undefined, metadata };
      });
      // Full page ⇒ there may be more; hand the caller the last row's
      // created_at as the next `before` cursor. Short page ⇒ end of trail.
      const nextBefore = logs.length === limit ? logs[logs.length - 1].created_at : null;
      return jsonResponse({ logs, next_before: nextBefore });
    }
    // Phase 7 Stage 48: manual contact merge (design §4). Checked before
    // parseCustomerId — that one only matches the bare /customers/:id.
    const mergeMatch = url.pathname.match(/^\/admin\/api\/customers\/(\d+)\/contacts\/merge$/);
    if (mergeMatch && request.method === "POST") {
      const mergeId = Number(mergeMatch[1]);
      if (Number.isSafeInteger(mergeId) && mergeId > 0) {
        return await mergeCustomerContacts(request, env, mergeId, auth);
      }
    }
    const id = parseCustomerId(url.pathname);
    if (id !== null) {
      if (request.method === "GET") {
        const customer = await getCustomer(env, id);
        if (!customer) return jsonResponse({ detail: "Customer not found" }, 404);
        // Phase 3 Stage 38: the panel reads raw research from
        // research_sources (rebuilt into the legacy text format); the
        // deprecated blob column is only the fallback for pre-Stage-36
        // snapshots. Fail-open — a missing source table must never break
        // the detail view.
        customer.full_research_text = await readSavedResearchText(
          env, customer.company_id, customer.full_research_text ?? "",
        );
        const contacts = await getCustomerContacts(env, customer.company_id);
        const evidence = await getCustomerEvidence(env, customer.company_id);
        // Phase 4 Stage 40: current buying signals from the typed layer —
        // until now the panel showed NOTHING for buying_signals (the JSON
        // cache column was selected but never rendered). Fail-open: a
        // missing table renders no section, never a broken detail view.
        let signals: Array<{ signal_text: string }> = [];
        try {
          const signalRows = await env.DB.prepare(
            `SELECT signal_text FROM research_signals WHERE customer_id = ? AND is_current = 1 ORDER BY id`,
          ).bind(customer.company_id).all<{ signal_text: string }>();
          signals = signalRows.results ?? [];
        } catch {
          // pre-migration window / bare test fixture — no section
        }
        // Phase 4 Stage 41: current buyer personas from the typed layer.
        // The panel prefers these rows and falls back to the
        // personas_and_solutions JSON (pre-stage snapshots); the outreach
        // prompt reads them through loadPersonasForOutreach. Fail-open.
        let personas: Array<{ persona_name: string; persona_role: string | null; needs_json: string | null; pain_points_json: string | null }> = [];
        try {
          const personaRows = await env.DB.prepare(
            `SELECT persona_name, persona_role, needs_json, pain_points_json
             FROM research_personas WHERE customer_id = ? AND is_current = 1 ORDER BY id`,
          ).bind(customer.company_id).all<{ persona_name: string; persona_role: string | null; needs_json: string | null; pain_points_json: string | null }>();
          personas = personaRows.results ?? [];
        } catch {
          // pre-migration window / bare test fixture — JSON fallback only
        }
        // Stage 15: both quality axes on one response — fit (lead_score) and
        // data completeness are separate metrics (spec §16), never derived
        // from each other.
        // Phase 4 Stage 42: linked facts — the current email/phone facts
        // that entity resolution tied to a contacts row, served with the
        // contact's name so the panel's evidence section answers "这个
        // 邮箱是谁" at a glance. Fail-open like every typed reader.
        let linkedFacts: Array<{ fact_type: string; fact_value: string; source_type: string | null; fetched_at: string; contact_id: string; first_name: string | null; last_name: string | null; title: string | null }> = [];
        try {
          const linkedRows = await env.DB.prepare(
            `SELECT f.fact_type, f.fact_value, f.source_type, f.fetched_at, f.contact_id,
                    c.first_name, c.last_name, c.title
             FROM research_facts f
             LEFT JOIN contacts c ON c.contact_id = f.contact_id AND c.company_id = f.customer_id
             WHERE f.customer_id = ? AND f.is_current = 1 AND f.contact_id IS NOT NULL
             ORDER BY f.id`,
          ).bind(customer.company_id).all<{ fact_type: string; fact_value: string; source_type: string | null; fetched_at: string; contact_id: string; first_name: string | null; last_name: string | null; title: string | null }>();
          linkedFacts = linkedRows.results ?? [];
        } catch {
          // pre-migration window / bare test fixture — no section
        }
        // Phase 5 Stage 43 (§4.2): the six-dimension decomposition rides the
        // same response — raw JSON, fail-open to null like the completeness
        // axis (migration-pending DBs / pre-stage rows / precheck skips).
        return jsonResponse({
          ...customer,
          contacts,
          evidence,
          signals,
          personas,
          linked_facts: linkedFacts,
          data_completeness_score: await getCustomerCompleteness(env, id),
          lead_score_breakdown: await getCustomerLeadScoreBreakdown(env, id),
        });
      }
      if (request.method === "PATCH") return await updateCustomer(request, env, id, auth);
    }
    return jsonResponse({ detail: "Not Found" }, 404);
  } catch (error) {
    return internalErrorResponse("admin-api", error, request);
  }
}

export async function handleAdminRequest(
  request: Request,
  env: AdminEnv,
): Promise<Response | null> {
  // Stage 5: every response this module produces — HTML, JSON, 303 redirect
  // or 404 text — leaves through here, so the security-header set is applied
  // once, centrally. Null ("not an /admin path") is passed through for
  // index.ts to handle.
  //
  // Stage 20 (spec §21): one UUID per request, minted here — never accepted
  // from the client — stamped on the response (X-Request-ID) and carried in
  // the request context so audit rows and error logs written while serving
  // this request correlate with it.
  const requestId = crypto.randomUUID();
  setRequestId(request, requestId);
  const response = await routeAdminRequest(request, env);
  if (response === null) return null;
  return applySecurityHeaders(withRequestId(response, requestId));
}

/** Stamps the request id onto a response. Response headers are guard-
 * protected in some runtimes, so the response is rebuilt with an extended
 * header set; the body stream is transferred unread. */
function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Request-ID", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function routeAdminRequest(
  request: Request,
  env: AdminEnv,
): Promise<Response | null> {
  try {
  const url = new URL(request.url);
  if (url.pathname !== "/admin" && !url.pathname.startsWith("/admin/")) return null;

  // Post-V2 Stage 35: optional Cloudflare Access perimeter, checked before
  // origin guard, auth and RBAC — a perimeter rejection says nothing about
  // routes or accounts (generic detail, safeLog-only, never an audit row:
  // rejections are internet-scanner noise, the Stage 29 class). Fail-closed
  // on every error, including a half-configured env (500, loud by design).
  const access = await checkCloudflareAccess(request, env);
  if (access.outcome === "reject") {
    return jsonResponse({ detail: access.detail }, access.status);
  }

  // Stage 6: a foreign-origin state-changing request (POST/PUT/PATCH/DELETE)
  // dies here — before routing, auth, or any handler side effect. Browsers
  // that can attach the session cookie always send `Origin` on non-GET
  // requests, so cookie-carrying cross-site calls cannot slip past; the
  // missing-Origin policy is documented in src/security/origin-guard.ts.
  const csrfRejection = originGuardRejection(request);
  if (csrfRejection) return csrfRejection;

  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    if (request.method !== "GET") return jsonResponse({ detail: "Method Not Allowed" }, 405);
    return (await authenticate(request, env))
      ? htmlResponse(ADMIN_PANEL_HTML)
      : htmlResponse(ADMIN_LOGIN_HTML);
  }

  if (url.pathname === "/admin/login" && request.method === "POST") {
    if (!env.ADMIN_PANEL_TOKEN) {
      return htmlResponse("<h1>Admin panel is not configured</h1><p>Set ADMIN_PANEL_TOKEN first.</p>", 503);
    }
    const ident = loginIdent(request);
    // Checked before reading the submitted token, and a locked caller is told
    // nothing about whether the token they hold is the right one.
    const blocked = await loginBlocked(env, ident);
    if (blocked) return loginThrottledResponse(blocked);
    const form = await request.formData();
    const token = form.get("token");
    if (typeof token !== "string" || !(await constantTimeSecretMatch(token, env.ADMIN_PANEL_TOKEN))) {
      await recordLoginFailure(env, "ip", throttleKey("ip", ident));
      await recordLoginFailure(env, "global", LOGIN_GLOBAL_KEY);
      // Stage 9: never the attempted value, only the fact of the failure.
      await auditAdminAction(env, request, null, "LOGIN_FAILED", "admin_session", null, { via: "form" });
      return htmlResponse(`${ADMIN_LOGIN_HTML}<p class="error">授权失败，请重试。</p>`, 401);
    }
    // A correct guess clears this caller's record; leaving it would let
    // earlier mistakes lock the operator out of their own panel.
    await clearLoginFailures(env, throttleKey("ip", ident));
    // Mint a server-side session; the master token never becomes the cookie.
    const user = await ensureBootstrapUser(env);
    // Post-V2 Stage 29: the token alone is not enough when the operator has
    // a WebAuthn credential — hand the browser the assert challenge page
    // instead of a session. Nothing is revoked yet; rotation happens at
    // successful assert, same as a normal login.
    const mfa = await issueLoginMfaChallenge(env, user);
    if (mfa) return htmlResponse(mfaChallengePage(mfa));
    // Session rotation: a valid session presented at login is revoked so a
    // re-login always leaves exactly one live token for this browser.
    const oldToken = readCookie(request, SESSION_COOKIE_NAME);
    if (oldToken) await revokeSessionByHash(env, await sha256Hex(oldToken));
    const session = await createAdminSession(env, request, user);
    await auditAdminAction(env, request, { user }, "LOGIN", "admin_session", null, { via: "form" });
    return new Response(null, {
      status: 303,
      headers: {
        Location: new URL("/admin", request.url).toString(),
        "Set-Cookie": sessionCookieHeader(request, session.token, SESSION_TTL_SECONDS),
        "Cache-Control": "no-store",
      },
    });
  }

  if (url.pathname === "/admin/logout" && request.method === "POST") {
    // Revoke server-side too: clearing the cookie alone would leave the row
    // live, and a stolen copy of the old cookie would keep working.
    const oldToken = readCookie(request, SESSION_COOKIE_NAME);
    if (oldToken) {
      // Stage 9: the row being revoked is the actor of this LOGOUT; resolve
      // it before the revoke so the audit can name the user.
      const auth = await authenticate(request, env);
      await revokeSessionByHash(env, await sha256Hex(oldToken)).catch(() => {});
      await auditAdminAction(env, request, auth, "LOGOUT", "admin_session", null, { via: "form" });
    }
    return new Response(null, {
      status: 303,
      headers: {
        Location: new URL("/admin", request.url).toString(),
        "Set-Cookie": sessionCookieHeader(request, "", 0),
      },
    });
  }

  /* ── Session API (Security V2 Stage 1) ──
   * POST /admin/api/auth/login  {password|token} → session cookie (JSON)
   * POST /admin/api/auth/logout → revoke current session
   * GET  /admin/api/auth/me     → current user/role/expiry
   * POST /admin/api/auth/revoke → revoke ALL sessions of the current user
   *                              (logout everywhere; optional {session_id}
   *                              narrows it to one row) */
  if (url.pathname === "/admin/api/auth/login" && request.method === "POST") {
    if (!env.ADMIN_PANEL_TOKEN) return jsonResponse({ detail: "Admin panel is not configured" }, 503);
    const ident = loginIdent(request);
    const blocked = await loginBlocked(env, ident);
    if (blocked) {
      const res = jsonResponse({ detail: "尝试过于频繁，请稍后再试" }, 429);
      res.headers.set("Retry-After", String(blocked.retryAfterSeconds));
      return res;
    }
    let credential: unknown;
    try {
      const body = await request.json() as { password?: unknown; token?: unknown };
      credential = body.password ?? body.token;
    } catch {
      return jsonResponse({ detail: "Invalid JSON body" }, 400);
    }
    if (typeof credential !== "string" || !(await constantTimeSecretMatch(credential, env.ADMIN_PANEL_TOKEN))) {
      await recordLoginFailure(env, "ip", throttleKey("ip", ident));
      await recordLoginFailure(env, "global", LOGIN_GLOBAL_KEY);
      await auditAdminAction(env, request, null, "LOGIN_FAILED", "admin_session", null, { via: "api" });
      return jsonResponse({ detail: "授权失败" }, 401);
    }
    await clearLoginFailures(env, throttleKey("ip", ident));
    const user = await ensureBootstrapUser(env);
    // Post-V2 Stage 29: 202 + the assert challenge when a WebAuthn
    // credential is on file — the session is minted by /mfa/assert only.
    const mfa = await issueLoginMfaChallenge(env, user);
    if (mfa) return jsonResponse({ status: "mfa_required", ...mfa }, 202);
    const oldToken = readCookie(request, SESSION_COOKIE_NAME);
    if (oldToken) await revokeSessionByHash(env, await sha256Hex(oldToken));
    const session = await createAdminSession(env, request, user);
    await auditAdminAction(env, request, { user }, "LOGIN", "admin_session", null, { via: "api" });
    const res = jsonResponse({
      user_id: user.id,
      username: user.username,
      role: user.role,
      expires_at: session.expiresAt,
    });
    res.headers.set("Set-Cookie", sessionCookieHeader(request, session.token, SESSION_TTL_SECONDS));
    return res;
  }

  if (url.pathname === "/admin/api/auth/logout" && request.method === "POST") {
    const auth = await authenticate(request, env);
    if (!auth) return authFailure(request);
    if (auth.tokenHash) await revokeSessionByHash(env, auth.tokenHash);
    await auditAdminAction(env, request, auth, "LOGOUT", "admin_session", null, { via: "api" });
    const res = jsonResponse({ ok: true, revoked: auth.tokenHash ? 1 : 0 });
    res.headers.set("Set-Cookie", sessionCookieHeader(request, "", 0));
    return res;
  }

  if (url.pathname === "/admin/api/auth/me" && request.method === "GET") {
    const auth = await authenticate(request, env);
    if (!auth) return authFailure(request);
    return jsonResponse({
      user_id: auth.user.id,
      username: auth.user.username,
      role: auth.user.role,
      via: auth.via,
      expires_at: auth.expiresAt,
    });
  }

  if (url.pathname === "/admin/api/auth/revoke" && request.method === "POST") {
    const auth = await authenticate(request, env);
    if (!auth) return authFailure(request);
    let sessionId: string | null = null;
    try {
      const body = await request.json() as { session_id?: unknown };
      if (typeof body.session_id === "string" && body.session_id) sessionId = body.session_id;
    } catch { /* empty body allowed */ }
    let revoked: number;
    if (sessionId) {
      const info = await env.DB.prepare(
        `UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
      ).bind(sqlUtc(), sessionId, auth.user.id).run();
      revoked = Number(info.meta.changes ?? 0);
    } else {
      const info = await env.DB.prepare(
        `UPDATE admin_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
      ).bind(sqlUtc(), auth.user.id).run();
      revoked = Number(info.meta.changes ?? 0);
    }
    const remaining = await countActiveSessions(env, auth.user.id);
    return jsonResponse({ ok: true, revoked, remaining });
  }

  /* ── Session inventory + admin-wide revocation (post-V2) ──
   * GET  /admin/api/auth/sessions        → active sessions, all users
   * POST /admin/api/auth/sessions/revoke → revoke one session by id
   * POST /admin/api/auth/revoke-all      → revoke every active session
   * All three are super_admin only. The rbac gate maps /admin/api/auth/*
   * to no permission (session lifecycle), so the role check lives HERE —
   * mirroring the gate's audit shape so a denial is on the trail. */
  if (url.pathname === "/admin/api/auth/sessions" && request.method === "GET") {
    const auth = await authenticate(request, env);
    if (!auth) return authFailure(request);
    if (auth.user.role !== "super_admin") {
      await auditAdminAction(env, request, auth, "ACCESS_DENIED", "admin_session", null, {
        reason: "forbidden",
        requires: "super_admin",
        path: url.pathname,
      });
      return jsonResponse({ detail: "无权执行此操作（仅 super_admin）" }, 403);
    }
    const rows = await env.DB.prepare(
      `SELECT s.id, s.user_id, u.username, s.role, s.created_at, s.expires_at, s.last_seen_at, s.ip_hash
       FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
       WHERE s.revoked_at IS NULL AND s.expires_at > ?
       ORDER BY s.created_at DESC LIMIT 200`,
    ).bind(sqlUtc()).all<{
      id: string;
      user_id: string;
      username: string;
      role: string;
      created_at: string;
      expires_at: string;
      last_seen_at: string | null;
      ip_hash: string | null;
    }>();
    const sessions = (rows.results ?? []).map((row) => ({
      ...row,
      is_current: row.id === auth.sessionId,
    }));
    return jsonResponse({ sessions });
  }

  if (url.pathname === "/admin/api/auth/sessions/revoke" && request.method === "POST") {
    const auth = await authenticate(request, env);
    if (!auth) return authFailure(request);
    if (auth.user.role !== "super_admin") {
      await auditAdminAction(env, request, auth, "ACCESS_DENIED", "admin_session", null, {
        reason: "forbidden",
        requires: "super_admin",
        path: url.pathname,
      });
      return jsonResponse({ detail: "无权执行此操作（仅 super_admin）" }, 403);
    }
    let sessionId = "";
    try {
      const body = await request.json() as { session_id?: unknown };
      if (typeof body.session_id === "string") sessionId = body.session_id;
    } catch { /* empty body → 400 below */ }
    if (!sessionId) return jsonResponse({ detail: "缺少 session_id" }, 400);
    const target = await env.DB.prepare(
      "SELECT id, user_id, revoked_at FROM admin_sessions WHERE id = ?",
    ).bind(sessionId).first<{ id: string; user_id: string; revoked_at: string | null }>();
    if (!target) return jsonResponse({ detail: "会话不存在" }, 404);
    const info = await env.DB.prepare(
      `UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
    ).bind(sqlUtc(), sessionId).run();
    const revoked = Number(info.meta.changes ?? 0);
    await auditAdminAction(env, request, auth, "REVOKE_SESSION", "admin_session", sessionId, {
      target_user_id: target.user_id,
      already_revoked: revoked === 0,
    });
    return jsonResponse({ ok: true, revoked });
  }

  if (url.pathname === "/admin/api/auth/revoke-all" && request.method === "POST") {
    const auth = await authenticate(request, env);
    if (!auth) return authFailure(request);
    if (auth.user.role !== "super_admin") {
      await auditAdminAction(env, request, auth, "ACCESS_DENIED", "admin_session", null, {
        reason: "forbidden",
        requires: "super_admin",
        path: url.pathname,
      });
      return jsonResponse({ detail: "无权执行此操作（仅 super_admin）" }, 403);
    }
    // Keep the caller's own session alive so an operator responding to an
    // incident does not lock themselves out mid-response. The Bearer
    // bootstrap path has no session row, so it revokes everything.
    const keepCurrent = auth.via === "session" && auth.sessionId !== "";
    const info = keepCurrent
      ? await env.DB.prepare(
          `UPDATE admin_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND expires_at > ? AND id != ?`,
        ).bind(sqlUtc(), sqlUtc(), auth.sessionId).run()
      : await env.DB.prepare(
          `UPDATE admin_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND expires_at > ?`,
        ).bind(sqlUtc(), sqlUtc()).run();
    const revoked = Number(info.meta.changes ?? 0);
    const remaining = await countAllActiveSessions(env);
    await auditAdminAction(env, request, auth, "REVOKE_ALL_SESSIONS", "admin_session", null, {
      revoked,
      kept_current: keepCurrent,
    });
    return jsonResponse({ ok: true, revoked, remaining });
  }

  /* ── WebAuthn 2FA (post-V2 Stage 29) ──
   * POST /admin/api/auth/mfa/assert
   *        {flow_id, credential_id, client_data_json, authenticator_data,
   *         signature} → session cookie (JSON)
   * POST /admin/api/auth/mfa/recovery
   *        {flow_id, code} → session cookie (JSON)
   * POST /admin/api/auth/webauthn/register/options {name?}
   *        → creation challenge (session required)
   * POST /admin/api/auth/webauthn/register/verify
   *        {flow_id, client_data_json, attestation_object, transports?, name?}
   *        → credential + one-time recovery codes on first enrollment
   * GET  /admin/api/auth/webauthn/credentials[?user_id=]
   *        → own credential list (super_admin may pass ?user_id=)
   * DELETE /admin/api/auth/webauthn/credentials/{id}[?user_id=]
   *        → revoke (self; super_admin may target another user)
   * POST /admin/api/auth/webauthn/recovery/regenerate
   *        → replace the recovery-code set (self)
   * All of these are /admin/api/auth/* lifecycle routes — the rbac gate maps
   * that prefix to no permission, so role checks (where needed) live here. */
  if (url.pathname === "/admin/api/auth/mfa/assert" && request.method === "POST") {
    const rp = rpConfig(env);
    if (!rp) return jsonResponse({ detail: "WebAuthn 未配置（缺少 WEBAUTHN_RP_ID）" }, 503);
    const ident = loginIdent(request);
    const blocked = await loginBlocked(env, ident);
    if (blocked) {
      const res = jsonResponse({ detail: "尝试过于频繁，请稍后再试" }, 429);
      res.headers.set("Retry-After", String(blocked.retryAfterSeconds));
      return res;
    }
    let body: { flow_id?: unknown; credential_id?: unknown; client_data_json?: unknown; authenticator_data?: unknown; signature?: unknown };
    try {
      body = await request.json() as typeof body;
    } catch {
      return jsonResponse({ detail: "Invalid JSON body" }, 400);
    }
    if (typeof body.flow_id !== "string" || typeof body.credential_id !== "string" ||
        typeof body.client_data_json !== "string" || typeof body.authenticator_data !== "string" ||
        typeof body.signature !== "string") {
      return jsonResponse({ detail: "缺少验证参数" }, 400);
    }
    const failMfa = async (reason: string, status: number): Promise<Response> => {
      await recordLoginFailure(env, "ip", throttleKey("ip", ident));
      await recordLoginFailure(env, "global", LOGIN_GLOBAL_KEY);
      await auditAdminAction(env, request, null, "LOGIN_FAILED", "admin_session", null, { via: "mfa", reason });
      return jsonResponse({ detail: "验证失败" }, status);
    };
    let consumed: { userId: string; challenge: string };
    try {
      consumed = await consumeChallenge(env, body.flow_id, "assert");
    } catch (e) {
      if (e instanceof WebAuthnError) {
        const status = e.reason === "flow_expired" ? 410 : 401;
        return failMfa(e.reason, status);
      }
      throw e;
    }
    try {
      const result = await verifyAssertionResponse(rp, env, {
        userId: consumed.userId,
        credentialId: body.credential_id,
        expectedChallenge: consumed.challenge,
        clientDataJson: body.client_data_json,
        authenticatorData: body.authenticator_data,
        signature: body.signature,
      });
      const user = await loadEnabledUser(env, consumed.userId);
      if (!user) return failMfa("user_disabled", 401);
      await env.DB.prepare(
        `UPDATE webauthn_credentials SET sign_count = ?, last_used_at = ? WHERE id = ?`,
      ).bind(result.newSignCount, sqlUtc(), result.credentialId).run();
      return await completeMfaLogin(env, request, user, "mfa", { credential_id: result.credentialId });
    } catch (e) {
      if (e instanceof WebAuthnError) return failMfa(e.reason, 401);
      throw e;
    }
  }

  if (url.pathname === "/admin/api/auth/mfa/recovery" && request.method === "POST") {
    const rp = rpConfig(env);
    if (!rp) return jsonResponse({ detail: "WebAuthn 未配置（缺少 WEBAUTHN_RP_ID）" }, 503);
    const ident = loginIdent(request);
    const blocked = await loginBlocked(env, ident);
    if (blocked) {
      const res = jsonResponse({ detail: "尝试过于频繁，请稍后再试" }, 429);
      res.headers.set("Retry-After", String(blocked.retryAfterSeconds));
      return res;
    }
    let body: { flow_id?: unknown; code?: unknown };
    try {
      body = await request.json() as typeof body;
    } catch {
      return jsonResponse({ detail: "Invalid JSON body" }, 400);
    }
    if (typeof body.flow_id !== "string" || typeof body.code !== "string" || !body.code.trim()) {
      return jsonResponse({ detail: "缺少恢复码" }, 400);
    }
    const failRecovery = async (reason: string, status: number): Promise<Response> => {
      await recordLoginFailure(env, "ip", throttleKey("ip", ident));
      await recordLoginFailure(env, "global", LOGIN_GLOBAL_KEY);
      await auditAdminAction(env, request, null, "LOGIN_FAILED", "admin_session", null, { via: "recovery", reason });
      return jsonResponse({ detail: "恢复码无效或已使用" }, status);
    };
    let consumed: { userId: string; challenge: string };
    try {
      consumed = await consumeChallenge(env, body.flow_id, "assert");
    } catch (e) {
      if (e instanceof WebAuthnError) {
        return failRecovery(e.reason, e.reason === "flow_expired" ? 410 : 401);
      }
      throw e;
    }
    const user = await loadEnabledUser(env, consumed.userId);
    if (!user) return failRecovery("user_disabled", 401);
    const codes = await env.DB.prepare(
      `SELECT id, code_hash FROM webauthn_recovery_codes WHERE user_id = ? AND used_at IS NULL`,
    ).bind(user.id).all<{ id: number; code_hash: string }>();
    let matched: { id: number; code_hash: string } | null = null;
    const presented = (await sha256HexOf(body.code.trim().toLowerCase()));
    for (const row of codes.results ?? []) {
      if (await constantTimeSecretMatch(presented, row.code_hash)) {
        matched = row;
        break;
      }
    }
    if (!matched) return failRecovery("recovery_code_invalid", 401);
    // Conditional update decides the winner if the same code races two flows.
    const used = await env.DB.prepare(
      `UPDATE webauthn_recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL`,
    ).bind(sqlUtc(), matched.id).run();
    if (Number(used.meta.changes ?? 0) !== 1) return failRecovery("recovery_code_invalid", 401);
    return await completeMfaLogin(env, request, user, "recovery", { recovery_code_id: matched.id });
  }

  if (url.pathname === "/admin/api/auth/webauthn/register/options" && request.method === "POST") {
    const auth = await authenticate(request, env);
    if (!auth) return authFailure(request);
    const rp = rpConfig(env);
    if (!rp) return jsonResponse({ detail: "WebAuthn 未配置：请先设置 WEBAUTHN_RP_ID" }, 503);
    let name: string | null = null;
    try {
      const body = await request.json() as { name?: unknown };
      if (typeof body.name === "string" && body.name.trim()) {
        name = body.name.trim().slice(0, 60);
      }
    } catch { /* no body / no name — both fine */ }
    const { flowId, challenge } = await issueChallenge(env, auth.user.id, "register");
    const exclude = await listCredentialDescriptors(env, auth.user.id);
    return jsonResponse({
      status: "ok",
      flow_id: flowId,
      public_key: {
        rp: { id: rp.rpId, name: rp.rpName },
        user: { id: auth.user.id, name: auth.user.username, displayName: auth.user.username },
        challenge,
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        timeout: 120_000,
        attestation: "none",
        excludeCredentials: exclude.map((d) => ({
          type: "public-key" as const,
          id: d.id,
          ...(d.transports ? { transports: d.transports.split(",").filter(Boolean) } : {}),
        })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      },
    });
  }

  if (url.pathname === "/admin/api/auth/webauthn/register/verify" && request.method === "POST") {
    const auth = await authenticate(request, env);
    if (!auth) return authFailure(request);
    const rp = rpConfig(env);
    if (!rp) return jsonResponse({ detail: "WebAuthn 未配置：请先设置 WEBAUTHN_RP_ID" }, 503);
    let body: { flow_id?: unknown; client_data_json?: unknown; attestation_object?: unknown; transports?: unknown; name?: unknown };
    try {
      body = await request.json() as typeof body;
    } catch {
      return jsonResponse({ detail: "Invalid JSON body" }, 400);
    }
    if (typeof body.flow_id !== "string" || typeof body.client_data_json !== "string" ||
        typeof body.attestation_object !== "string") {
      return jsonResponse({ detail: "缺少注册参数" }, 400);
    }
    let consumed: { userId: string; challenge: string };
    try {
      consumed = await consumeChallenge(env, body.flow_id, "register");
    } catch (e) {
      if (e instanceof WebAuthnError) {
        return jsonResponse({ detail: "注册流程无效或已过期，请重新发起" }, e.reason === "flow_expired" ? 410 : 400);
      }
      throw e;
    }
    if (consumed.userId !== auth.user.id) {
      await auditAdminAction(env, request, auth, "ACCESS_DENIED", "webauthn_credential", null, {
        reason: "flow_user_mismatch",
        path: url.pathname,
      });
      return jsonResponse({ detail: "无权完成他人的注册流程" }, 403);
    }
    const transports = Array.isArray(body.transports)
      ? body.transports.filter((t): t is string => typeof t === "string")
      : [];
    let registration: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      registration = await verifyRegistrationResponse(rp, env, {
        userId: consumed.userId,
        expectedChallenge: consumed.challenge,
        clientDataJson: body.client_data_json,
        attestationObject: body.attestation_object,
        transports,
      });
    } catch (e) {
      if (e instanceof WebAuthnError) {
        safeLog("warn", "[admin:webauthn] registration rejected", e.reason);
        return jsonResponse({ detail: "注册验证失败", reason: e.reason }, 400);
      }
      throw e;
    }
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : null;
    await env.DB.prepare(
      `INSERT INTO webauthn_credentials (id, user_id, public_key_jwk, alg, sign_count, transports, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      registration.credentialId, auth.user.id, JSON.stringify(registration.jwk), registration.alg,
      registration.signCount, registration.transports.join(",") || null, name, sqlUtc(),
    ).run();
    // Recovery codes are minted ONCE — when this is the user's first active
    // credential and no unused codes exist. Regenerating later is an
    // explicit, audited action.
    const activeCount = await countActiveCredentials(env, auth.user.id);
    const unusedCodes = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM webauthn_recovery_codes WHERE user_id = ? AND used_at IS NULL`,
    ).bind(auth.user.id).first<{ n: number }>();
    let recoveryCodes: string[] | null = null;
    if (activeCount === 1 && (unusedCodes?.n ?? 0) === 0) {
      recoveryCodes = generateRecoveryCodes();
      const inserts = await Promise.all(recoveryCodes.map(async (code) =>
        env.DB.prepare(
          `INSERT INTO webauthn_recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)`,
        ).bind(auth.user.id, await sha256HexOf(code), sqlUtc()),
      ));
      await env.DB.batch(inserts);
    }
    await auditAdminAction(env, request, auth, "WEBAUTHN_REGISTER", "webauthn_credential", registration.credentialId, {
      alg: registration.alg,
      transports: registration.transports.join(",") || null,
      first_credential: activeCount === 1,
    });
    return jsonResponse({
      ok: true,
      credential_id: registration.credentialId,
      recovery_codes: recoveryCodes,
      two_factor_active: true,
    });
  }

  if (url.pathname === "/admin/api/auth/webauthn/credentials" && request.method === "GET") {
    const auth = await authenticate(request, env);
    if (!auth) return authFailure(request);
    const requestedUser = url.searchParams.get("user_id");
    let targetUser = auth.user.id;
    if (requestedUser && requestedUser !== auth.user.id) {
      if (auth.user.role !== "super_admin") {
        await auditAdminAction(env, request, auth, "ACCESS_DENIED", "webauthn_credential", null, {
          reason: "forbidden",
          requires: "super_admin",
          path: url.pathname,
        });
        return jsonResponse({ detail: "无权执行此操作（仅 super_admin）" }, 403);
      }
      targetUser = requestedUser;
    }
    const rows = await env.DB.prepare(
      `SELECT id, name, transports, created_at, last_used_at, sign_count
       FROM webauthn_credentials WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at`,
    ).bind(targetUser).all<{
      id: string; name: string | null; transports: string | null;
      created_at: string; last_used_at: string | null; sign_count: number;
    }>();
    const unusedCodes = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM webauthn_recovery_codes WHERE user_id = ? AND used_at IS NULL`,
    ).bind(targetUser).first<{ n: number }>();
    return jsonResponse({
      credentials: rows.results ?? [],
      recovery_codes_remaining: unusedCodes?.n ?? 0,
      two_factor_active: (rows.results ?? []).length > 0,
    });
  }

  if (url.pathname.startsWith("/admin/api/auth/webauthn/credentials/") && request.method === "DELETE") {
    const auth = await authenticate(request, env);
    if (!auth) return authFailure(request);
    const credentialId = decodeURIComponent(url.pathname.slice("/admin/api/auth/webauthn/credentials/".length));
    if (!credentialId || !/^[\w-]{10,300}$/.test(credentialId)) {
      return jsonResponse({ detail: "凭据 ID 无效" }, 400);
    }
    const requestedUser = url.searchParams.get("user_id");
    let targetUser = auth.user.id;
    if (requestedUser && requestedUser !== auth.user.id) {
      if (auth.user.role !== "super_admin") {
        await auditAdminAction(env, request, auth, "ACCESS_DENIED", "webauthn_credential", null, {
          reason: "forbidden",
          requires: "super_admin",
          path: url.pathname,
        });
        return jsonResponse({ detail: "无权执行此操作（仅 super_admin）" }, 403);
      }
      targetUser = requestedUser;
    }
    const info = await env.DB.prepare(
      `UPDATE webauthn_credentials SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    ).bind(sqlUtc(), credentialId, targetUser).run();
    if (Number(info.meta.changes ?? 0) !== 1) return jsonResponse({ detail: "凭据不存在" }, 404);
    const remaining = await countActiveCredentials(env, targetUser);
    await auditAdminAction(env, request, auth, "WEBAUTHN_REVOKE", "webauthn_credential", credentialId, {
      target_user_id: targetUser,
      was_last_credential: remaining === 0,
    });
    return jsonResponse({ ok: true, revoked: 1, two_factor_active: remaining > 0 });
  }

  if (url.pathname === "/admin/api/auth/webauthn/recovery/regenerate" && request.method === "POST") {
    const auth = await authenticate(request, env);
    if (!auth) return authFailure(request);
    const rp = rpConfig(env);
    if (!rp) return jsonResponse({ detail: "WebAuthn 未配置：请先设置 WEBAUTHN_RP_ID" }, 503);
    // Replace the WHOLE set (used and unused): regenerating after a leak
    // must invalidate everything previously printed.
    await env.DB.prepare(`DELETE FROM webauthn_recovery_codes WHERE user_id = ?`).bind(auth.user.id).run();
    const codes = generateRecoveryCodes();
    const inserts = await Promise.all(codes.map(async (code) =>
      env.DB.prepare(
        `INSERT INTO webauthn_recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)`,
      ).bind(auth.user.id, await sha256HexOf(code), sqlUtc()),
    ));
    await env.DB.batch(inserts);
    await auditAdminAction(env, request, auth, "WEBAUTHN_RECOVERY_REGEN", "webauthn_credential", null, {
      count: codes.length,
    });
    return jsonResponse({ ok: true, recovery_codes: codes });
  }

  if (url.pathname === "/admin/outreach") {
    if (request.method !== "GET") return jsonResponse({ detail: "Method Not Allowed" }, 405);
    return (await authenticate(request, env))
      ? htmlResponse(OUTREACH_PANEL_HTML)
      : htmlResponse(ADMIN_LOGIN_HTML);
  }

  if (url.pathname === "/admin/keys") {
    if (request.method !== "GET") return jsonResponse({ detail: "Method Not Allowed" }, 405);
    return (await authenticate(request, env))
      ? htmlResponse(KEYS_PANEL_HTML)
      : htmlResponse(ADMIN_LOGIN_HTML);
  }

  // Post-V2: read-only audit trail viewer (backing API is
  // GET /admin/api/audit-logs, gated audit.read in rbac.ts).
  if (url.pathname === "/admin/audit") {
    if (request.method !== "GET") return jsonResponse({ detail: "Method Not Allowed" }, 405);
    return (await authenticate(request, env))
      ? htmlResponse(AUDIT_PANEL_HTML)
      : htmlResponse(ADMIN_LOGIN_HTML);
  }

  // Post-V2: session inventory + revocation, super_admin only (incident
  // response surface). Non-super_admin gets a JSON 403, not the page.
  if (url.pathname === "/admin/sessions") {
    if (request.method !== "GET") return jsonResponse({ detail: "Method Not Allowed" }, 405);
    const auth = await authenticate(request, env);
    if (!auth) return htmlResponse(ADMIN_LOGIN_HTML);
    if (auth.user.role !== "super_admin") {
      return jsonResponse({ detail: "无权执行此操作（仅 super_admin）" }, 403);
    }
    return htmlResponse(SESSIONS_PANEL_HTML);
  }

  // Post-V2 Stage 29: WebAuthn credential self-service — every authenticated
  // user manages their own authenticators and recovery codes here.
  if (url.pathname === "/admin/security") {
    if (request.method !== "GET") return jsonResponse({ detail: "Method Not Allowed" }, 405);
    return (await authenticate(request, env))
      ? htmlResponse(SECURITY_PANEL_HTML)
      : htmlResponse(ADMIN_LOGIN_HTML);
  }

  // CRM sales layer (合并.txt): companies / deals kanban / timeline — the
  // sales view of the same D1 database. Reads ride customers.read in the
  // API gate below; the page shell itself only needs a session.
  if (url.pathname === "/admin/crm") {
    if (request.method !== "GET") return jsonResponse({ detail: "Method Not Allowed" }, 405);
    return (await authenticate(request, env))
      ? htmlResponse(CRM_PANEL_HTML)
      : htmlResponse(ADMIN_LOGIN_HTML);
  }

  /* ── Central authorization gate (Security V2 Stage 2) ──
   * Every /admin/api/* route except the /admin/api/auth/* lifecycle endpoints
   * (handled above) passes through here: authenticate once, then check the
   * role against the route's required permission. The per-route handlers
   * never re-check auth — this gate is the single choke point. */
  if (url.pathname.startsWith("/admin/api/")) {
    const auth = await authenticate(request, env);
    if (!auth) {
      // Stage 9: an unauthenticated state-changing attempt on a protected
      // route is audit-worthy; GETs are not (probes would bury the trail).
      if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
        await auditAdminAction(env, request, null, "ACCESS_DENIED", "admin_api", url.pathname, {
          reason: "unauthenticated",
        });
      }
      return authFailure(request);
    }
    const permission = requiredPermission(url, request.method);
    if (permission !== null && !roleHasPermission(auth.user.role, permission)) {
      await auditAdminAction(env, request, auth, "ACCESS_DENIED", "admin_api", url.pathname, {
        reason: "forbidden",
        permission,
        method: request.method,
      });
      return jsonResponse({ detail: `无权执行此操作（需要权限 ${permission}）` }, 403);
    }
    // Stage 9: the gate is the single point that knows the actor, so it
    // hands the authenticated context down to the route handlers for their
    // per-action audit rows.
    if (url.pathname.startsWith("/admin/api/keys")) {
      // `await` matters: a bare `return promise` leaves the try block before the
      // promise settles, so an async throw would skip the redaction catch below
      // and escape the router entirely.
      return await handleProviderKeysApi(request, env, auth);
    }

    // CRM sales layer (companies/contacts/deals/activities — src/crm.ts).
    // Checked before the broader outreach prefix is irrelevant here; the
    // prefix is disjoint, this just keeps the handler list explicit.
    if (url.pathname.startsWith("/admin/api/crm")) {
      // `await` for the same reason as the keys branch above.
      return await handleCrmApi(request, env, auth);
    }

    // Outreach + Gmail sender pool: both live in handleOutreachApi. The pool was
    // unreachable (404) when only the outreach prefix was routed here.
    // 定向群发 (segment-preview / groups / campaigns) is checked first because
    // handleCampaignApi owns those paths; everything else falls through.
    if (url.pathname.startsWith("/admin/api/outreach/segment-preview")
      || url.pathname === "/admin/api/persona-roles"
      || url.pathname.startsWith("/admin/api/outreach/groups")
      || url.pathname.startsWith("/admin/api/outreach/campaigns")) {
      return await handleCampaignApi(request, env, auth);
    }

    if (url.pathname.startsWith("/admin/api/outreach") || url.pathname.startsWith("/admin/api/gmail")) {
      return await handleOutreachApi(request, env, auth);
    }

    return await handleAdminApi(request, env, auth);
  }

  return new Response("Not Found", { status: 404 });
  } catch (error) {
    return internalErrorResponse("admin-router", error, request);
  }
}

const ADMIN_LOGIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>D1 CRM 管理登录</title><style>body{font-family:system-ui,sans-serif;background:#eef4fa;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:#fff;padding:28px;border-radius:14px;box-shadow:0 8px 30px #123b6820;width:min(420px,calc(100% - 40px))}h1{margin-top:0;color:#123b68}label{display:block;font-weight:600;margin:16px 0 6px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}button{margin-top:18px;background:#1677d2;color:#fff;border:0;border-radius:8px;padding:12px 18px;cursor:pointer;font:inherit}.error{color:#b91c1c}</style></head>
<body><main class="card"><h1>D1 CRM 管理面板</h1><p>请输入 ADMIN_PANEL_TOKEN 登录。</p><form method="post" action="/admin/login"><label for="token">管理 Token</label><input id="token" name="token" type="password" autocomplete="current-password" required><button type="submit">登录</button></form></main></body></html>`;

const ADMIN_PANEL_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>D1 CRM 客户管理</title><style>
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}.top{background:#eef3fa;color:#172033;border-bottom:1px solid #d3deed;padding:18px 26px;display:flex;justify-content:space-between;gap:12px;align-items:center}.top h1{font-size:22px;margin:0}.wrap{max-width:1400px;margin:22px auto;padding:0 18px}.panel{background:#fff;border:1px solid #dce5f0;border-radius:12px;padding:18px;margin-bottom:18px}.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.toolbar input,.toolbar select{font:inherit;padding:10px;border:1px solid #cbd5e1;border-radius:8px}.toolbar input:not([type=checkbox]){min-width:240px}.button{background:#1677d2;color:#fff;border:0;border-radius:8px;padding:10px 15px;cursor:pointer;font:inherit}.button.secondary{background:#475569}.button.danger{background:#b91c1c}.button.small{padding:6px 12px;font-size:13px}table{width:100%;border-collapse:collapse;margin-top:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #e2e8f0;vertical-align:top;font-size:14px}th{background:#f8fafc;white-space:nowrap}td{max-width:300px;overflow-wrap:anywhere}.badge{display:inline-block;border-radius:999px;padding:3px 9px;background:#e2e8f0;font-size:12px}.badge-completed{background:#d1fae5;color:#065f46}.badge-pending{background:#fef3c7;color:#92400e}.badge-failed{background:#fee2e2;color:#991b1b}.badge-processing{background:#dbeafe;color:#1e40af}.notice{margin-top:12px;padding:10px;border-radius:8px;background:#eff6ff}.success{background:#ecfdf5;color:#065f46}.error{background:#fef2f2;color:#991b1b}.hidden{display:none}.pager{display:flex;justify-content:space-between;align-items:center;margin-top:14px;gap:12px}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;justify-content:center;align-items:flex-start;padding:30px 18px;overflow-y:auto}.modal-overlay.active{display:flex}.modal{background:#fff;border-radius:14px;width:min(800px,100%);box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden}.modal-header{background:#123b68;color:#fff;padding:18px 24px;display:flex;justify-content:space-between;align-items:center}.modal-header h2{margin:0;font-size:20px}.modal-body{padding:24px;max-height:70vh;overflow-y:auto}.modal-footer{padding:16px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:10px}
.field-row{display:flex;align-items:stretch;border-bottom:1px solid #e2e8f0;min-height:48px}.field-row:last-child{border-bottom:none}.field-label{width:180px;min-width:180px;padding:12px 16px;background:#f8fafc;font-weight:600;font-size:13px;color:#475569;display:flex;align-items:center;border-right:1px solid #e2e8f0}.field-content{flex:1;padding:12px 16px;display:flex;align-items:center;gap:8px;min-height:48px}.field-value{flex:1;font-size:14px;word-break:break-word;line-height:1.5}.field-value a{color:#1677d2;text-decoration:none}.field-value a:hover{text-decoration:underline}.field-input{flex:1;display:none;gap:8px;align-items:center}.field-input input,.field-input select,.field-input textarea{font:inherit;padding:8px 12px;border:1px solid #cbd5e1;border-radius:6px;width:100%}.field-input textarea{min-height:80px;resize:vertical}.field-input input,.field-input select{max-width:100%}.field-row.editing .field-value{display:none}.field-row.editing .field-input{display:flex}.field-row.readonly .field-label{color:#94a3b8}
.cp-dd{position:relative;display:inline-block}
.cp-dd-btn{padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;font:inherit;font-size:13px;cursor:pointer;min-width:150px;max-width:320px;text-align:left;color:#172033;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cp-dd-btn:hover{border-color:#0f766e}
.cp-dd-panel{display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:60;background:#fff;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 10px 28px rgba(15,23,42,.14);padding:6px;max-height:260px;overflow:auto;min-width:230px}
.cp-dd.open .cp-dd-panel{display:block}
.cp-dd-item{display:flex;align-items:center;gap:7px;padding:5px 8px;font-size:13px;border-radius:6px;cursor:pointer;user-select:none}
.cp-dd-item:hover{background:#f0fdfa}
.cp-dd-item input:disabled+span{color:#9ca3af}
.cp-dd-n{margin-left:auto;color:#64748b;font-size:11px;font-variant-numeric:tabular-nums}
.cp-dd-sum{color:#0f766e;font-weight:600}
.cp-dd-empty{font-size:12px;color:#9ca3af;padding:6px 8px}
.cp-dd-search{width:100%;box-sizing:border-box;font:inherit;font-size:13px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;margin-bottom:4px;min-width:0}
.cp-dd-note{font-size:11px;color:#b45309;padding:2px 8px 4px}
.toolbar .cp-dd input[type=checkbox]{min-width:0;width:auto;padding:0;margin:0}
.persona-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;margin-bottom:10px}.persona-card h4{margin:0 0 8px;font-size:14px;color:#1e293b}.persona-card ul{margin:0;padding-left:18px;font-size:13px;color:#475569}.solution-card{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px;margin-bottom:10px}.solution-card h4{margin:0 0 6px;font-size:14px;color:#1e40af}.solution-card p{margin:0;font-size:13px;color:#1e3a5f}.section-title{font-size:15px;font-weight:600;color:#123b68;margin:18px 0 10px;padding-bottom:6px;border-bottom:2px solid #123b68}
@media(max-width:700px){.top{align-items:flex-start;flex-direction:column}table{display:block;overflow-x:auto;white-space:nowrap}.field-row{flex-direction:column}.field-label{width:100%;min-width:0;border-right:none;border-bottom:1px solid #e2e8f0}.modal-body{padding:16px}}

/* stage30 auto: inline style -> class */
.s-fs13{font-size:13px}
.s-faint{color:#94a3b8}
.s-mw130{min-width:130px}
.s-note{font-size:13px;color:#475569;margin:6px 0}
.s-chiprow{font-size:13px;display:flex;align-items:center;gap:4px}
.s-faint2{color:#9ca3af}
.s-dfx-g12-aic{display:flex;gap:12px;align-items:center}
/* stage30 auto conversion produced a class name containing a space
 * ("p8 16" from padding:8px 16px), which made the selector invalid —
 * browsers dropped the whole rule and the header nav links rendered as
 * unstyled default-blue anchors. Replaced with a single valid class. */
.top-nav-link{color:#123b68;text-decoration:none;background:#ffffff;border:1px solid #b9c9e0;padding:8px 16px;border-radius:8px;font-weight:600}
.top-nav-link:hover{border-color:#1677d2;color:#1677d2}
.s-xw220{max-width:220px}
.s-mb12{margin-bottom:12px}
.s-mra{margin-right:auto}
.s-fx1-mw110{flex:1;min-width:110px}
.s-fs11-c64748b-mb2{font-size:11px;color:#64748b;margin-bottom:2px}
.s-bge2e8f0-br4-h8-ovh{background:#e2e8f0;border-radius:4px;height:8px;overflow:hidden}
.s-fs12-fw700-mt2{font-size:12px;font-weight:700;margin-top:2px}
.s-fs10-c94a3b8-fw400{font-size:10px;color:#94a3b8;font-weight:400}
.s-dfx-g14-fxww-bgf8fafc-bd1 ol e2e8f0-br8-p10 14{display:flex;gap:14px;flex-wrap:wrap;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px}
.s-fx0 0 a-dfx-aic-fs12-c475569{flex:0 0 auto;display:flex;align-items:center;font-size:12px;color:#475569}
.s-c16a34a-fw700{color:#16a34a;font-weight:700}
.s-cd97706-fw700{color:#d97706;font-weight:700}
.s-mb4{margin-bottom:4px}
.s-wspw-fs12{white-space:pre-wrap;font-size:12px}
.s-wspw-lh16{white-space:pre-wrap;line-height:1.6}
.s-c94a3b8-p12{color:#94a3b8;padding:12px}
.s-bdl3 ol 1677d2{border-left:3px solid #1677d2}
.s-dfx-jcb-aic-mb8{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.s-m0{margin:0}
.s-dgrid-gridtemplatecolumns1fr 1fr-g4 16-fs13{display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;font-size:13px}
.s-gc11{grid-column:1/-1}
.s-dfx-fxww-g8{display:flex;flex-wrap:wrap;gap:8px}
.s-bgf8fafc-bd1 ol e2e8f0-br8-p10 14-dfx-aic-g8{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:8px}
.s-fs18{font-size:18px}
.s-fw600-fs13{font-weight:600;font-size:13px}
.s-fs12-c1677d2-wbba{font-size:12px;color:#1677d2;word-break:break-all}
.s-dfx-fxdcol-g8{display:flex;flex-direction:column;gap:8px}
.s-bgf8fafc-bd1 ol e2e8f0-br8-p10 12{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px}
.s-dfx-jcb-g8-mb4{display:flex;justify-content:space-between;gap:8px;margin-bottom:4px}
.s-fs12-c374151-mb3{font-size:12px;color:#374151;margin-bottom:3px}
.s-fs12-c6b7280-fstit-mb3{font-size:12px;color:#6b7280;font-style:italic;margin-bottom:3px}
.s-fs11-c1677d2-wbba{font-size:11px;color:#1677d2;word-break:break-all}
.s-cd97706{color:#d97706}
.s-bgf8fafc{background:#f8fafc}
.s-dfx-jcb-aic{display:flex;justify-content:space-between;align-items:center}
/* stage30: dynamic-variant classes (score bar / verified / evidence) */
.score-fill{height:100%}
.sf-hi{background:#16a34a}.sf-good{background:#65a30d}.sf-mid{background:#d97706}.sf-low{background:#9ca3af}.sf-none{background:#cbd5e1}
.sv-ok{font-size:11px;color:#059669;font-weight:600}.sv-bad{font-size:11px;color:#dc2626;font-weight:600}
.ev-hi{font-size:11px;color:#059669;font-weight:700}.ev-mid{font-size:11px;color:#d97706;font-weight:700}.ev-lo{font-size:11px;color:#9ca3af;font-weight:700}
/* stage57 (Phase 10): weights-editor number inputs — narrow on purpose, the
 * .toolbar input rule's 240px min-width would stack the six inputs. */
.s-mw64{min-width:64px;width:64px;padding:6px 8px}
</style></head><body><header class="top"><h1>D1 CRM 客户管理面板</h1><div class="s-dfx-g12-aic"><a href="/admin/security" class="top-nav-link">🛡️ 安全设置</a><a href="/admin/outreach" class="top-nav-link">📧 开发信管理</a><a href="/admin/crm" class="top-nav-link">🎯 CRM 销售</a><a href="/admin/keys" class="top-nav-link">⚡ 动态 Key 池</a><form method="post" action="/admin/logout"><button class="button secondary" type="submit">退出登录</button></form></div></header><main class="wrap">
<section class="panel"><h2>📥 客户数据导入（Seed CSV）</h2><p class="s-note">粘贴 CSV（需表头，支持列：company_name, country, domain/website, email, product）。原始数据永久保存在 customer_imports（不可变原始层）；域名或公司名匹配的行自动去重跳过，新公司以 pending 状态进入研究队列。</p><div class="toolbar"><input id="importFileName" placeholder="文件名备注（可选）" class="s-xw220"><button class="button" id="importBtn">导入并去重入队</button></div><textarea id="importCsv" rows="6" placeholder="company_name,country,website,email,product\nABC Sports,USA,,buyer@abcsports.com,SUP\nOcean Pro,Germany,oceanpro.de,,RIB"></textarea><div id="importMsg" class="notice hidden"></div></section>
<section class="panel"><h2>🎯 海选过滤器（Pre-Filter）</h2><p class="s-note">纯 SQL 筛选已分析客户（零 AI 成本）。先用条件缩小目标范围：「统计匹配」后可「重新入队」让管道二次研究高价值客户，「写开发信」把当前条件带入定向群发生成分批开发信，「导出全部数据」按当前条件下载全量 CSV。筛选项为下拉勾选，右侧数字是该条件当前命中的客户数（勾选「有邮箱」后只计有邮箱的）。</p><div class="toolbar"><span class="cp-dd" id="ddCountries"><button type="button" class="cp-dd-btn" data-dd="countries">🌍 国家<span class="cp-dd-sum" id="ddSumCountries"></span> ▾</button><div class="cp-dd-panel" id="ddPanelCountries"></div></span><span class="cp-dd" id="ddSegments"><button type="button" class="cp-dd-btn" data-dd="segments">🏷️ 细分<span class="cp-dd-sum" id="ddSumSegments"></span> ▾</button><div class="cp-dd-panel" id="ddPanelSegments"></div></span><span class="cp-dd" id="ddProducts"><button type="button" class="cp-dd-btn" data-dd="products">📦 产品<span class="cp-dd-sum" id="ddSumProducts"></span> ▾</button><div class="cp-dd-panel" id="ddPanelProducts"></div></span><select id="pfMinScore" class="s-mw130"><option value="">最低分：不限</option><option value="40">最低分 ≥40</option><option value="50">最低分 ≥50</option><option value="60">最低分 ≥60</option><option value="70">最低分 ≥70</option><option value="80">最低分 ≥80</option><option value="90">最低分 ≥90</option></select><label class="s-chiprow"><input type="checkbox" id="pfHasEmail"> 有邮箱</label><label class="s-chiprow"><input type="checkbox" id="pfHasSignal"> 有购买信号</label><input id="pfPersonaRoles" placeholder="人物角色（逗号分隔，如：采购总监）" class="s-p8-bd1 ol cbd5e1-br6-fs13-mw180"><button class="button" id="pfCount">统计匹配</button><button class="button secondary" id="pfQueue">匹配项重新入队</button><button class="button" id="pfOutreach">✉️ 写开发信</button><button class="button secondary" id="pfExport">📥 导出全部数据</button></div><div id="pfResult" class="notice hidden"></div></section>
<section class="panel"><h2>🎯 线索评分权重（Phase 10 可调）</h2><p class="s-note">六维权重决定评分结构：每维 0-100 的整数，六维合计必须恰好 100（总分 0-100 契约）。保存仅写入配置；已评分客户仍是旧权重结果——点「重算存量评分」按当前权重全量重算（不相关客户归零，未完成客户不受影响，数据完整度分不重算，不重新研究）。</p><div class="toolbar" id="lsInputs"></div><p class="s-note" id="lsMeta"></p><div class="toolbar"><span id="lsSum" class="s-fs12-fw700-mt2"></span><button class="button secondary" id="lsDefaultsBtn">恢复默认</button><button class="button" id="lsSaveBtn" disabled>保存权重</button><button class="button secondary" id="lsRescoreBtn">重算存量评分</button></div><div id="lsMsg" class="notice hidden"></div></section>
<section class="panel"><h2>客户列表</h2><div id="scoreCard" class="hidden s-mb12" ></div><div class="toolbar"><input id="search" placeholder="公司 ID、网址、细分或备注"><select id="status"><option value="">全部状态</option><option value="pending">pending</option><option value="processing">processing</option><option value="completed">completed</option><option value="failed">failed</option></select><button class="button" id="load">刷新</button><span id="summary"></span></div><div id="listMessage"></div><table><thead><tr><th>客户ID</th><th>公司名称</th><th>网址</th><th>状态</th><th>评分</th><th>客户细分</th><th>国家</th><th>联系方式</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table><div class="pager"><button class="button secondary" id="prev">上一页</button><span id="pageInfo"></span><button class="button secondary" id="next">下一页</button></div></section>
</main>
<div class="modal-overlay" id="modal"><div class="modal"><div class="modal-header"><h2 id="modalTitle">客户详情</h2><button class="button secondary small" id="closeModal">✕ 关闭</button></div><div class="modal-body" id="modalBody"></div><div class="modal-footer"><span id="modalMsg" class="notice hidden s-mra" ></span><button class="button danger small" id="requeueBtn">设为 pending 重新处理</button><button class="button" id="submitBtn">提交修改</button></div></div></div>
<script>
(function(){
  var state={offset:0,limit:50,total:0,selected:null,dirty:{}};
  var $=function(id){return document.getElementById(id)};
  var esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
  var api=function(p,o){return fetch(p,o||{}).then(function(r){if(r.status===401){location='/admin';throw new Error('登录已过期')}var ct=r.headers.get('content-type')||'';if(ct.indexOf('json')===-1&&ct.indexOf('text/plain')===-1){return r.text().then(function(t){throw new Error('服务器返回非JSON响应 (HTTP '+r.status+'): '+t.slice(0,100))})}return r.json().then(function(d){if(!r.ok)throw new Error(d.detail||'请求失败 ('+r.status+')');return d})})};
  var showMsg=function(id,t,g){var e=$(id);e.textContent=t;e.classList.remove('hidden');e.classList.toggle('success',!!g);e.classList.toggle('error',!g)};
  var badge=function(s){return'<span class="badge badge-'+esc(s)+'">'+esc(s)+'</span>'};
  // Lead-score distribution bar chart (SQL buckets, no per-row cost).
  var renderScoreCard=function(h){var $c=$('scoreCard');if(!h||!h.total){$c.classList.add('hidden');return}$c.classList.remove('hidden');var bar=function(n,t,colorCls){var pct=h.total?Math.round(n/h.total*100):0;return '<div class="s-fx1-mw110"><div class="s-fs11-c64748b-mb2">'+t+'</div><div class="s-bge2e8f0-br4-h8-ovh"><div class="score-fill '+colorCls+'" data-w="'+pct+'"></div></div><div class="s-fs12-fw700-mt2">'+n+' <span class="s-fs10-c94a3b8-fw400">('+pct+'%)</span></div></div>'};$c.innerHTML='<div class="s-dfx-g14-fxww-bgf8fafc-bd1 ol e2e8f0-br8-p10 14">'
    +bar(h.s80,'≥80 高优先','sf-hi')
    +bar(h.s60,'60-79 优质','sf-good')
    +bar(h.s40,'40-59 一般','sf-mid')
    +bar(h.s0,'<40 低分','sf-low')
    +bar(h.unscored,'未评分','sf-none')
    +'<div class="s-fx0 0 a-dfx-aic-fs12-c475569">已完成 <b>'+h.total+'</b> 家</div>'+'</div>';$c.querySelectorAll('.score-fill').forEach(function(el){el.style.width=el.getAttribute('data-w')+'%'})};
  var loadScoreCard=function(){api('/admin/api/customers/lead-score-histogram').then(renderScoreCard).catch(function(){})};
  loadScoreCard();
  // Phase 10 (Stage 57, design docs/phase10-lead-score-config.md §4):
  // operator-tunable six-dimension weights. The editor loads the saved
  // profile, live-checks 合计 = 100, PUTs on save;「重算存量评分」triggers
  // the server sweep so stored scores follow the new weights. LS_DIMS is
  // the single key/label source — the breakdown renderer below shares it.
  var LS_DIMS=[['icp_fit','ICP 契合'],['product_fit','产品匹配'],['buyer_role','决策人'],['buying_signal','采购信号'],['reachability','可触达'],['strategic_value','战略价值']];
  // Fail-open fallback ONLY: the literals are what the config endpoint
  // answers pre-tune; lsLoad() overwrites them with the SERVER's saved
  // weights once the fetch lands — no JS mirror of LEAD_SCORE_WEIGHTS.
  var LS_DIMS_MAX={icp_fit:30,product_fit:20,buyer_role:10,buying_signal:15,reachability:15,strategic_value:10};
  var lsDefaults=null;
  $('lsInputs').innerHTML=LS_DIMS.map(function(d){return '<label class="s-chiprow">'+esc(d[1])+' <input type="number" min="0" max="100" step="1" id="ls_'+d[0]+'" class="s-mw64"></label>'}).join('');
  var lsVal=function(k){var n=Number($('ls_'+k).value);return isFinite(n)?Math.floor(n):0};
  var lsSum=function(){var s=0;for(var i=0;i<LS_DIMS.length;i++)s+=lsVal(LS_DIMS[i][0]);return s};
  var lsRenderSum=function(){var s=lsSum();var el=$('lsSum');el.textContent='合计 '+s+' / 100';el.style.color=s===100?'#059669':'#dc2626';$('lsSaveBtn').disabled=s!==100};
  LS_DIMS.forEach(function(d){$('ls_'+d[0]).oninput=lsRenderSum});
  var lsFill=function(w){LS_DIMS.forEach(function(d){$('ls_'+d[0]).value=w[d[0]]});lsRenderSum()};
  var lsLoad=function(){api('/admin/api/lead-score/config').then(function(d){lsDefaults=d.defaults;lsFill(d.weights);LS_DIMS.forEach(function(x){LS_DIMS_MAX[x[0]]=Number(d.weights[x[0]])||0});$('lsMeta').textContent=d.updated_at?('上次调整：'+d.updated_at+'，当前生效权重如上（「恢复默认」= 代码默认）'):'未调整（使用代码默认权重）'}).catch(function(e){showMsg('lsMsg',e.message,false)})};
  lsLoad();
  $('lsDefaultsBtn').onclick=function(){if(lsDefaults)lsFill(lsDefaults)};
  $('lsSaveBtn').onclick=function(){var w={};LS_DIMS.forEach(function(d){w[d[0]]=lsVal(d[0])});var b=$('lsSaveBtn');b.disabled=true;b.textContent='保存中…';
    api('/admin/api/lead-score/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(w)}).then(function(d){showMsg('lsMsg','✅ 已保存（调整时间 '+d.updated_at+'）。存量客户评分仍为旧权重生成——建议点「重算存量评分」让分数跟进。',true);lsLoad()}).catch(function(e){showMsg('lsMsg',e.message,false)}).finally(function(){b.textContent='保存权重';lsRenderSum()})};
  $('lsRescoreBtn').onclick=function(){if(!confirm('将按当前保存的权重重算全部已完成客户的评分：不相关客户归零，未完成客户不受影响，数据完整度分不重算（不重新研究）。确定？'))return;var b=$('lsRescoreBtn');b.disabled=true;b.textContent='重算中…';
    api('/admin/api/lead-score/rescore',{method:'POST'}).then(function(d){showMsg('lsMsg','✅ 重算完成：扫描 '+d.scanned+' 家，有分 '+d.rescored+' 家，归零 '+d.zeroed+' 家',true);loadScoreCard();load()}).catch(function(e){showMsg('lsMsg',e.message,false)}).finally(function(){b.textContent='重算存量评分';b.disabled=false})};
  var load=function(){var p=new URLSearchParams({q:$('search').value,status:$('status').value,limit:String(state.limit),offset:String(state.offset)});api('/admin/api/customers?'+p.toString()).then(function(d){state.total=d.total;$('summary').textContent='共 '+d.total+' 条';$('rows').innerHTML=d.items.map(function(c){var did=c.display_id||'N/A';var score=c.lead_score;var scoreHtml=(score===null||score===undefined)?'—':(score>=70?'<span class="s-c16a34a-fw700">'+score+'</span>':score>=40?'<span class="s-cd97706-fw700">'+score+'</span>':'<span class="s-faint2">'+score+'</span>');return'<tr><td>'+esc(did)+'</td><td>'+esc(c.company_name||'-')+'</td><td><a href="'+esc(c.domain)+'" target="_blank">'+esc((c.domain||'').slice(0,35))+'</a></td><td>'+badge(c.status)+'</td><td>'+scoreHtml+'</td><td>'+esc((c.customer_segment||'-').slice(0,35))+'</td><td>'+esc((c.country||'-'))+'</td><td>'+esc((c.email||c.cellphone||'-').slice(0,25))+'</td><td><button class="button" data-open="'+c.id+'">查看详情</button></td></tr>'}).join('')||'<tr><td colspan="9">暂无数据</td></tr>';$('pageInfo').textContent=(state.total?state.offset+1:0)+'-'+Math.min(state.offset+state.limit,state.total)+' / '+state.total;$('prev').disabled=state.offset===0;$('next').disabled=state.offset+state.limit>=state.total}).catch(function(e){showMsg('listMessage',e.message,false)})};
  $('rows').addEventListener('click',function(ev){var t=ev.target.closest('[data-open]');if(t){window.openDetail(parseInt(t.getAttribute('data-open'),10))}});
  // Seed CSV import (docx ① Data Import)
  var doImport=function(){var csv=$('importCsv').value;if(!csv.trim()){showMsg('importMsg','请先粘贴 CSV 内容',false);return}$('importBtn').disabled=true;$('importBtn').textContent='导入中…';api('/admin/api/customers/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csv:csv,file_name:$('importFileName').value||null})}).then(function(d){showMsg('importMsg','✅ 导入完成：新增 '+d.inserted+' 家（进入研究队列），匹配已有 '+d.matched+' 家（跳过），无效行 '+d.skipped+'。导入批次：'+d.import_id,true);$('importCsv').value='';load()}).catch(function(e){showMsg('importMsg',e.message,false)}).finally(function(){$('importBtn').disabled=false;$('importBtn').textContent='导入并去重入队'})};
  $('importBtn').onclick=doImport;
  // Pre-filter 海选 (docx Step 2)
  /* ── 多选下拉（国家/细分/产品）：勾选式选择项，替代手填输入框 ── */
  var pfDDOpts={countries:[],segments:[],products:[]};
  var pfDDSel={countries:[],segments:[],products:[]};
  var pfDDReady=false,pfDDError=false;
  // Mirrors MAX_FILTER_VALUES in src/campaigns.ts: the API rejects longer
  // lists, so cap the ticks here where the operator can still see why.
  var pfDDLimit={countries:10,segments:10,products:10};
  var pfDDKinds=['countries','segments','products'];
  var pfDDCap=function(k){return k.charAt(0).toUpperCase()+k.slice(1)};
  // 海选 base rows always have research; the count follows 有邮箱 because that
  // is exactly what pre-filter will add to its WHERE clause when ticked.
  var pfDDCount=function(o){return $('pfHasEmail').checked?o.ne:o.n};
  function pfDDRender(k){var panel=$('ddPanel'+pfDDCap(k));if(!panel)return;
    if(!pfDDReady){panel.innerHTML='<div class="cp-dd-empty">'+(pfDDError?'加载失败，刷新重试':'加载中…')+'</div>';return}
    if(!panel.__built){panel.__built=true;panel.__q='';
      panel.innerHTML='<input class="cp-dd-search" placeholder="过滤…"><div class="cp-dd-list"></div>';
      panel.querySelector('.cp-dd-search').oninput=function(){panel.__q=this.value;pfDDList(k)}}
    pfDDList(k)}
  function pfDDList(k){var panel=$('ddPanel'+pfDDCap(k));if(!panel||!panel.__built)return;
    var q=(panel.__q||'').toLowerCase();
    var opts=pfDDOpts[k].filter(function(o){return !q||o.v.toLowerCase().indexOf(q)>=0});
    var arr=pfDDSel[k],limit=pfDDLimit[k],full=arr.length>=limit;
    var items=opts.map(function(o){var on=arr.indexOf(o.v)>=0;
      return '<label class="cp-dd-item"><input type="checkbox" '+(on?'checked':'')+(full&&!on?' disabled':'')+' data-v="'+esc(o.v)+'"><span>'+esc(o.v)+'</span><span class="cp-dd-n">'+pfDDCount(o)+'</span></label>'}).join('');
    if(!opts.length)items='<div class="cp-dd-empty">无匹配选项</div>';
    panel.querySelector('.cp-dd-list').innerHTML=items+(full?'<div class="cp-dd-note">最多 '+limit+' 项，取消一项可继续</div>':'');
    panel.querySelectorAll('.cp-dd-list input').forEach(function(cb){cb.onchange=function(){pfDDToggle(k,cb.dataset.v,cb.checked)}})}
  function pfDDToggle(k,v,on){var arr=pfDDSel[k],i=arr.indexOf(v);
    if(on&&i<0&&arr.length<pfDDLimit[k])arr.push(v);
    if(!on&&i>=0)arr.splice(i,1);
    pfDDSum(k);pfDDList(k)}
  function pfDDSum(k){var el=$('ddSum'+pfDDCap(k));if(!el)return;var arr=pfDDSel[k];
    el.textContent=arr.length?('：'+arr.slice(0,2).join(',')+(arr.length>2?' 等'+arr.length+'项':'')):''}
  function pfDDAll(fn){pfDDKinds.forEach(fn)}
  function loadFilterOptions(){return api('/admin/api/customers/filter-options?facets=countries,segments,products').then(function(d){
      pfDDOpts.countries=d.countries||[];pfDDOpts.segments=d.segments||[];pfDDOpts.products=d.products||[];
      pfDDReady=true;pfDDAll(function(k){pfDDRender(k);pfDDSum(k)})}).catch(function(){pfDDError=true;pfDDAll(pfDDRender)})}
  document.querySelectorAll('.cp-dd-btn').forEach(function(btn){btn.onclick=function(ev){ev.stopPropagation();var dd=btn.parentElement,was=dd.classList.contains('open');document.querySelectorAll('.cp-dd.open').forEach(function(o){o.classList.remove('open')});if(!was)dd.classList.add('open')}});
  document.addEventListener('click',function(ev){if(!(ev.target.closest&&ev.target.closest('.cp-dd')))document.querySelectorAll('.cp-dd.open').forEach(function(o){o.classList.remove('open')})});
  $('pfHasEmail').onchange=function(){pfDDAll(pfDDList)};
  var pfParams=function(){var p=new URLSearchParams();var c=pfDDSel.countries.join(','),s=pfDDSel.segments.join(','),pr=pfDDSel.products.join(','),m=$('pfMinScore').value,proles=$('pfPersonaRoles').value.trim();if(c)p.set('countries',c);if(s)p.set('segments',s);if(pr)p.set('products',pr);if(m&&Number(m)>0)p.set('min_lead_score',m);if($('pfHasEmail').checked)p.set('has_email','1');if($('pfHasSignal').checked)p.set('has_buying_signal','1');if(proles)p.set('persona_roles',proles);return p};
  $('pfCount').onclick=function(){var p=pfParams();p.set('action','count');$('pfCount').disabled=true;api('/admin/api/customers/pre-filter?'+p.toString()).then(function(d){var s=d.sample||[];var lines=s.slice(0,5).map(function(c){return esc((c.company_name||c.display_id||c.id)+'（'+(c.lead_score??'—')+'分）')}).join('、');$('pfResult').classList.remove('hidden');$('pfResult').innerHTML='🎯 匹配 <b>'+d.matching+'</b> 家'+(lines?'。高分示例：'+lines:'');$('pfResult').style.color='#123b68'}).catch(function(e){$('pfResult').classList.remove('hidden');$('pfResult').textContent='❌ '+e.message;$('pfResult').style.color='#b91c1c'}).finally(function(){$('pfCount').disabled=false})};
  $('pfQueue').onclick=function(){if(!confirm('确定将所有匹配的已完成客户重新研究？将作废旧研究数据并重新抓取分析（消耗搜索配额），完成后画像与评分全部刷新。'))return;var p=pfParams();p.set('action','queue');$('pfQueue').disabled=true;api('/admin/api/customers/pre-filter?'+p.toString()).then(function(d){$('pfResult').classList.remove('hidden');$('pfResult').innerHTML='✅ 已作废旧研究并重新入队 <b>'+d.queued+'</b> 家，等待 cron 重新抓取分析';$('pfResult').style.color='#123b68';load()}).catch(function(e){$('pfResult').classList.remove('hidden');$('pfResult').textContent='❌ '+e.message;$('pfResult').style.color='#b91c1c'}).finally(function(){$('pfQueue').disabled=false})};
  // 写开发信：当前筛选条件原样带去定向群发页（prefill=1），由那边的
  // 预填逻辑接手；导出：同 count 的 WHERE，服务端回 CSV 附件。
  $('pfOutreach').onclick=function(){var p=pfParams();p.set('prefill','1');location.href='/admin/outreach?'+p.toString()};
  $('pfExport').onclick=function(){var p=pfParams();p.set('action','export');var a=document.createElement('a');a.href='/admin/api/customers/pre-filter?'+p.toString();document.body.appendChild(a);a.click();a.remove();$('pfResult').classList.remove('hidden');$('pfResult').innerHTML='📥 已按当前筛选条件开始导出 CSV（行数多时需等待几秒，可在浏览器下载列表查看进度）';$('pfResult').style.color='#123b68'};
  var fields=[
    {key:'id',label:'数据库 ID',readonly:true},
    {key:'display_id',label:'客户 ID',readonly:true},
    {key:'company_id',label:'内部 UUID',readonly:true},
    {key:'company_name',label:'公司名称',type:'input'},
    {key:'legal_name',label:'法人名称',type:'input'},
    {key:'trading_name',label:'商号',type:'input'},
    {key:'domain',label:'企业网址',type:'input'},
    {key:'normalized_domain',label:'标准化域名',type:'input'},
    {key:'status',label:'状态',type:'select',options:['pending','processing','completed','failed']},
    {key:'first_name',label:'First Name',type:'input'},
    {key:'last_name',label:'Last Name',type:'input'},
    {key:'full_name',label:'全名 (Full Name)',type:'input'},
    {key:'title',label:'职位 (TITLE)',type:'input'},
    {key:'department',label:'部门 (Department)',type:'input'},
    {key:'linkedin_url',label:'LinkedIn URL',type:'input'},
    {key:'street_address',label:'街道地址',type:'input'},
    {key:'zip_city',label:'邮编 & 城市',type:'input'},
    {key:'country',label:'国家 (Country)',type:'input'},
    {key:'country_code',label:'国家代码',type:'input'},
    {key:'region',label:'地区 (Region)',type:'input'},
    {key:'city',label:'城市 (City)',type:'input'},
    {key:'postal_code',label:'邮编 (Postal Code)',type:'input'},
    {key:'tel',label:'电话 (TEL)',type:'input'},
    {key:'email',label:'邮箱 (EMAIL)',type:'input'},
    {key:'cellphone',label:'手机 (Cellphone)',type:'input'},
    {key:'whatsapp',label:'WhatsApp',type:'input'},
    {key:'products_services',label:'产品与服务',type:'textarea'},
    {key:'business_tag',label:'业务标签 (Business Tag)',type:'input'},
    {key:'industry',label:'行业 (Industry)',type:'input'},
    {key:'company_type',label:'公司类型',type:'input'},
    {key:'business_model',label:'商业模式',type:'input'},
    {key:'founded_year',label:'成立年份',type:'input'},
    {key:'employee_range',label:'员工规模',type:'input'},
    {key:'description',label:'公司描述',type:'textarea'},
    {key:'target_markets',label:'目标市场',type:'input'},
    {key:'is_manufacturer',label:'制造商',type:'select',options:['0','1']},
    {key:'is_importer',label:'进口商',type:'select',options:['0','1']},
    {key:'is_distributor',label:'分销商',type:'select',options:['0','1']},
    {key:'is_wholesaler',label:'批发商',type:'select',options:['0','1']},
    {key:'is_retailer',label:'零售商',type:'select',options:['0','1']},
    {key:'is_ecommerce',label:'电商',type:'select',options:['0','1']},
    {key:'is_rental',label:'租赁',type:'select',options:['0','1']},
    {key:'is_oem',label:'OEM',type:'select',options:['0','1']},
    {key:'social_accounts',label:'社交账号 JSON',type:'textarea'},
    {key:'customer_segment',label:'客户细分 (Customer Segment)',type:'input'},
    {key:'product_categories',label:'产品类别 (Product Categories)',type:'input'},
    {key:'company_size',label:'公司规模 (Company Size)',type:'select',options:['Small','Medium','Large','Enterprise']},
    {key:'geographic_coverage',label:'地理覆盖 (Geographic Coverage)',type:'select',options:['Local','National','International']},
    // Phase 3 Stage 38: raw research is system-generated (research_sources,
    // rebuilt for display) and was never accepted by the PATCH whitelist —
    // readonly keeps the panel honest about that.
    {key:'full_research_text',label:'完整研究文本',type:'textarea',readonly:true},
    {key:'social_accounts_verified',label:'已验证社交媒体',type:'textarea'},
    {key:'personas_and_solutions',label:'AI 分析结果 JSON',type:'textarea',parseJson:true},
    {key:'remarks',label:'中文备注 (Remarks)',type:'textarea'},
    // Stage 15 (spec §16): two independent quality axes, both system-computed
    // by the research pipeline — readonly, so they are never hand-edited and
    // never overwrite each other.
    {key:'lead_score',label:'线索评分 (Lead Score)',readonly:true},
    {key:'data_completeness_score',label:'数据完整度 (Data Completeness)',readonly:true}
  ];
  var buildModal=function(c){state.dirty={};var h='';
    fields.forEach(function(f){
      var val=c[f.key]||'';var isReadonly=!!f.readonly;var rowClass=isReadonly?'field-row readonly':'field-row';
      h+='<div class="field-row" data-key="'+f.key+'">';
      h+='<div class="field-label">'+esc(f.label)+'</div>';
      h+='<div class="field-content">';
      h+='<div class="field-value" id="fv_'+f.key+'">';
      if(f.key==='id'||f.key==='company_id'){h+=esc(val)}
      else if(f.key==='domain'){h+='<a href="'+esc(val)+'" target="_blank">'+esc(val)+'</a>'}
      else if(f.key==='status'){h+=badge(val)}
      else if(f.key==='linkedin_url'&&val){h+='<a href="'+esc(val)+'" target="_blank">'+esc(val)+'</a>'}
      else if(f.key==='is_manufacturer'||f.key==='is_importer'||f.key==='is_distributor'||f.key==='is_wholesaler'||f.key==='is_retailer'||f.key==='is_ecommerce'||f.key==='is_rental'||f.key==='is_oem'){h+=(val==1||val==='1'?'✅ 是':'❌ 否')}
      else if(f.key==='social_accounts'&&val){var sa=null;try{sa=JSON.parse(val)}catch(e){}
        if(sa&&sa.length>0){sa.forEach(function(a){h+='<div class="s-mb4">🔗 '+esc(a.platform||'')+': '+(a.username?'@'+esc(a.username):'')+(a.url?' <a href="'+esc(a.url)+'" target="_blank">'+esc(a.url)+'</a>':'')+'</div>'})}else{h+='<em class="s-faint">暂无社交账号</em>'}}
      else if(f.key==='personas_and_solutions'&&(val||(c.personas&&c.personas.length))){var parsed=null;if(val){try{parsed=JSON.parse(val)}catch(e){}}
        var pl=[];var sl=[];
        if(c.personas&&c.personas.length){c.personas.forEach(function(p){var pn=null,pp=null;try{pn=JSON.parse(p.needs_json||'[]')}catch(e){}try{pp=JSON.parse(p.pain_points_json||'[]')}catch(e){}
          pl.push({name:p.persona_name,role:p.persona_role,needs:pn||[],pain_points:pp||[]})});sl=(parsed&&parsed.solutions)||[]}
        else if(parsed){pl=parsed.personas||[];sl=parsed.solutions||[]}
        if(!parsed&&(!c.personas||!c.personas.length)){h+='<pre class="s-wspw-fs12">'+esc(val)+'</pre>'}
        else{
          if(pl.length>0){h+='<div class="section-title">👤 客户画像</div>';pl.forEach(function(p){h+='<div class="persona-card"><h4>'+esc(p.name||'未知角色')+(p.role?' — '+esc(p.role):'')+'</h4>';if(p.needs&&p.needs.length){h+='<ul>';p.needs.forEach(function(n){h+='<li>需求: '+esc(n)+'</li>'});h+='</ul>'}if(p.pain_points&&p.pain_points.length){h+='<ul>';p.pain_points.forEach(function(n){h+='<li>痛点: '+esc(n)+'</li>'});h+='</ul>'}h+='</div>'})}
          if(sl.length>0){h+='<div class="section-title">💡 解决方案</div>';sl.forEach(function(s){h+='<div class="solution-card"><h4>'+esc(s.name||'')+'</h4><p>'+esc(s.value||'')+'</p></div>'})}
          if(pl.length===0&&sl.length===0){h+='<em class="s-faint">暂无数据</em>'}}}
      else if(f.key==='remarks'){h+='<div class="s-wspw-lh16">'+(esc(val)||'<em class="s-faint">暂无备注</em>')+'</div>'}
      else if(isReadonly&&f.type==='textarea'){h+='<pre class="s-wspw-fs12">'+(esc(val)||'<em class="s-faint">-</em>')+'</pre>'}
      else{h+=esc(val)||'<em class="s-faint">-</em>'}
      h+='</div>';
      if(!isReadonly){h+='<div class="field-input" id="fi_'+f.key+'">';
        if(f.type==='select'){h+='<select id="inp_'+f.key+'">';f.options.forEach(function(o){h+='<option value="'+esc(o)+'"'+(val===o?' selected':'')+'>'+esc(o)+'</option>'});h+='</select>'}
        else if(f.type==='textarea'){h+='<textarea id="inp_'+f.key+'" rows="6">'+esc(val)+'</textarea>'}
        else{h+='<input id="inp_'+f.key+'" value="'+esc(val)+'">'}
        h+='</div>';
        h+='<button class="button secondary small edit-btn" data-key="'+f.key+'">修改</button>'}
      h+='</div></div>'});
    return h};
  // Phase 7 Stage 48: manual contact merge support. 疑似重复 is pure
  // client-side key counting (same normalized email / phone / whatsapp /
  // name as another card); the actual merge decision stays with the
  // operator — the server re-validates everything anyway.
  var lastContacts=[];
  var ctNorm=function(v){return String(v||'').trim().toLowerCase()};
  var ctPhone=function(v){return ctNorm(v).replace(/[ \\-().]/g,'')};
  var ctName=function(ct){return ctNorm(((ct.first_name||'')+' '+(ct.last_name||'')).trim().replace(/\\s+/g,' '))};
  var ctKeys=function(ct){return [ctNorm(ct.email),ctPhone(ct.cellphone),ctPhone(ct.whatsapp),ctName(ct)].filter(Boolean)};
  var renderContacts=function(contacts){lastContacts=contacts||[];if(!contacts||contacts.length===0)return'<div class="s-c94a3b8-p12">暂无联系人数据</div>';
    var kc={};contacts.forEach(function(ct){ctKeys(ct).forEach(function(k){kc[k]=(kc[k]||0)+1})});
    var h='<div class="section-title">👥 联系人列表 ('+contacts.length+'人)</div>';contacts.forEach(function(ct,idx){
      var dup=ctKeys(ct).some(function(k){return kc[k]>1});
      h+='<div class="persona-card s-bdl3 ol 1677d2" >';h+='<div class="s-dfx-jcb-aic-mb8">';h+='<h4 class="s-m0">'+esc(ct.contact_id||'')+' — '+esc((ct.first_name||'')+' '+(ct.last_name||''))+'</h4>';h+='<span class="badge">#'+esc(String(ct.seq))+'</span>'+(dup?'<span class="badge" style="background:#d97706;color:#fff">疑似重复</span>':'')+'<label class="s-chiprow"><input type="checkbox" class="ct-merge-cb" data-cid="'+esc(ct.contact_id||'')+'" data-seq="'+esc(String(ct.seq))+'"> 选择</label></div>';
      h+='<div class="s-dgrid-gridtemplatecolumns1fr 1fr-g4 16-fs13">';
      var pairs=[['职位',ct.title],['全名',ct.full_name],['部门',ct.department],['邮箱',ct.email],['手机',ct.cellphone],['电话',ct.tel],['WhatsApp',ct.whatsapp],['LinkedIn',ct.linkedin_url]];
      pairs.forEach(function(p){if(p[1])h+='<div><strong>'+esc(p[0])+':</strong> '+esc(p[1])+'</div>'});
      if(ct.social_accounts){try{var sa=JSON.parse(ct.social_accounts);if(sa.length>0){h+='<div class="s-gc11"><strong>社交账号:</strong> ';sa.forEach(function(a){h+=esc(a.platform)+': '+(a.username?'@'+esc(a.username):'')+' '});h+='</div>'}}catch(e){}}
      h+='</div></div>'});
    if(contacts.length>1)h+='<div class="s-mt8"><button class="button secondary small" id="ctMergeBtn">合并所选联系人</button><span class="s-fs12-c475569" style="margin-left:8px">勾选 ≥2 行后合并：序号最早的行是主行，空字段由其余行填充，关联证据自动重指向。</span></div>';
    return h};
  var wireMergeButton=function(){var mb=document.getElementById('ctMergeBtn');if(!mb)return;mb.onclick=function(){
    var cbs=[].slice.call(document.querySelectorAll('.ct-merge-cb:checked'));
    if(cbs.length<2){alert('请至少勾选 2 个联系人');return}
    var picked=cbs.map(function(cb){return{cid:cb.getAttribute('data-cid'),seq:Number(cb.getAttribute('data-seq'))||0}}).sort(function(a,b){return a.seq-b.seq});
    var survivor=picked[0].cid,mergedIds=picked.slice(1).map(function(p){return p.cid});
    var nm=function(cid){var c=null;for(var i=0;i<lastContacts.length;i++){if(lastContacts[i].contact_id===cid)c=lastContacts[i]}return c?((((c.first_name||'')+' '+(c.last_name||'')).trim())||cid):cid};
    if(!confirm('将把 '+mergedIds.length+' 个联系人合并进主行 '+nm(survivor)+'（'+survivor+'，勾选中序号最早的一行）。\\n主行已有字段不会被覆盖，空字段由其余行填充，关联的联系方式证据会重指向主行。确定？'))return;
    mb.disabled=true;
    api('/admin/api/customers/'+state.selected+'/contacts/merge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({survivor_contact_id:survivor,merged_contact_ids:mergedIds})}).then(function(){openDetail(state.selected)}).catch(function(e){alert('❌ '+e.message);mb.disabled=false})}};
  var renderVerifiedSocial=function(sv){if(!sv)return'';var social=null;try{social=JSON.parse(sv)}catch(e){}if(!social||!social.length)return'';var h='<div class="section-title">📱 已验证社交媒体</div><div class="s-dfx-fxww-g8">';social.forEach(function(s){var icon=s.platform==='LinkedIn'?'🔗':s.platform==='Facebook'?'📘':s.platform==='Instagram'?'📷':s.platform==='Twitter'?'🐦':s.platform==='YouTube'?'📺':s.platform==='TikTok'?'🎵':'🌐';var statusCls=s.verified?'sv-ok':'sv-bad';var statusText=s.verified?'已验证':'未验证';h+='<div class="s-bgf8fafc-bd1 ol e2e8f0-br8-p10 14-dfx-aic-g8"><span class="s-fs18">'+icon+'</span><div><div class="s-fw600-fs13">'+esc(s.platform)+'</div><a href="'+esc(s.url)+'" target="_blank" class="s-fs12-c1677d2-wbba">'+esc(s.url)+'</a></div><span class="'+statusCls+'">'+statusText+'</span></div>'});h+='</div>';return h};
  var renderEvidence=function(ev){if(!ev||!ev.length)return'';var h='<div class="section-title">🔍 证据链（AI 判断的来源依据）</div><div class="s-dfx-fxdcol-g8">';ev.forEach(function(e){var pct=e.confidence!=null?Math.round(e.confidence*100)+'%':'—';var cCls=e.confidence>=0.8?'ev-hi':e.confidence>=0.5?'ev-mid':'ev-lo';h+='<div class="s-bgf8fafc-bd1 ol e2e8f0-br8-p10 12">'
    +'<div class="s-dfx-jcb-g8-mb4"><strong class="s-fs13">'+esc(e.field_name)+'</strong><span class="'+cCls+'">置信度 '+pct+'</span></div>'
    +(e.field_value?'<div class="s-fs12-c374151-mb3"><b>判定:</b> '+esc(e.field_value)+'</div>':'')
    +(e.evidence_text?'<div class="s-fs12-c6b7280-fstit-mb3">“'+esc(e.evidence_text)+'”</div>':'')
    +(e.source_url?'<a href="'+esc(e.source_url)+'" target="_blank" class="s-fs11-c1677d2-wbba">'+esc(e.source_url.slice(0,90))+'</a>':'')
    +'</div>'});h+='</div>';return h};
  var renderSignals=function(sv){if(!sv||!sv.length)return'';var h='<div class="section-title">🚨 采购信号 (Buying Signals)</div><div class="s-dfx-fxdcol-g8">';sv.forEach(function(s){h+='<div class="s-bgf8fafc-bd1 ol e2e8f0-br8-p10 12 s-fs13">'+esc(s.signal_text)+'</div>'});h+='</div>';return h};
  var renderLinkedFacts=function(lf){if(!lf||!lf.length)return'';var h='<div class="section-title">🔗 联系方式归属（实体关联）</div><div class="s-dfx-fxdcol-g8">';lf.forEach(function(f){var nm=([f.first_name,f.last_name].filter(Boolean).join(' ')||f.contact_id);var ttl=f.title?'（'+f.title+'）':'';var icon=f.fact_type==='phone'?'📞':'✉️';var src=f.source_type?(' · '+esc(f.source_type)):'';h+='<div class="s-bgf8fafc-bd1 ol e2e8f0-br8-p10 14-dfx-aic-g8"><span class="s-fs18">'+icon+'</span><div><div class="s-fw600-fs13 wbba">'+esc(f.fact_value)+'</div><div class="s-fs12-c475569">→ '+esc(nm)+esc(ttl)+src+' · '+esc((f.fetched_at||'').slice(0,10))+'</div></div></div>'});h+='</div>';return h};
  // Phase 5 (建议 §十八): the lead score's six-dimension decomposition.
  // Bars reuse the histogram's score-fill widget (track + data-w fill).
  // A NULL/invalid breakdown — pre-Stage-43 rows, precheck skips,
  // migration-pending databases — hides the section; the total and the
  // completeness axis above it keep rendering. Phase 10 Stage 57: the
  // dimension maxes are the SERVER's saved weights, fetched once per panel
  // load (lsLoad fills LS_DIMS_MAX) — the Stage 44 JS mirror of
  // LEAD_SCORE_WEIGHTS is gone; the literals in LS_DIMS_MAX are only the
  // fail-open fallback when that fetch itself fails (pre-migration).
  var renderLeadScoreBreakdown=function(c){var b=null;if(c.lead_score_breakdown){try{b=JSON.parse(c.lead_score_breakdown)}catch(e){}}
    if(!b||b.version!=='lead-score-v2')return'';
    var h='<div class="section-title">🎯 线索评分维度（六维拆解）</div><div class="s-dfx-fxdcol-g8">';
    LS_DIMS.forEach(function(d){var mx=LS_DIMS_MAX[d[0]]||0;var v=Math.max(0,Number(b[d[0]])||0);var pct=mx>0?Math.round(v/mx*100):0;var fill=pct>=80?'sf-hi':pct>=40?'sf-mid':pct>0?'sf-low':'sf-none';
      h+='<div><div class="s-dfx-jcb-g8-mb4"><span class="s-fw600-fs13">'+esc(d[1])+'</span><span class="s-fs12-c475569">'+v+' / '+mx+'</span></div>'
      +'<div class="s-bge2e8f0-br4-h8-ovh"><div class="score-fill '+fill+'" data-w="'+pct+'"></div></div></div>'});
    h+='</div>';return h};
  window.openDetail=function(id){api('/admin/api/customers/'+id).then(function(c){state.selected=id;state.dirty={};$('modalTitle').textContent='客户详情 — '+esc(c.company_name||c.domain||'');var body=buildModal(c);body+=renderLeadScoreBreakdown(c);body+=renderSignals(c.signals);body+=renderEvidence(c.evidence);body+=renderLinkedFacts(c.linked_facts);body+=renderVerifiedSocial(c.social_accounts_verified);body+='<div class="section-title">👥 联系人列表</div>';body+='<div id="contactsArea"></div>';$('modalBody').innerHTML=body;$('modalBody').querySelectorAll('.score-fill').forEach(function(el){el.style.width=el.getAttribute('data-w')+'%'});var ca=document.getElementById('contactsArea');if(ca)ca.innerHTML=renderContacts(c.contacts);wireMergeButton();$('modalMsg').classList.add('hidden');$('modal').classList.add('active');document.body.style.overflow='hidden';
      document.querySelectorAll('.edit-btn').forEach(function(btn){btn.onclick=function(){var key=btn.getAttribute('data-key');var row=btn.closest('.field-row');row.classList.add('editing');state.dirty[key]=true;var inp=document.getElementById('inp_'+key);if(inp&&inp.focus)inp.focus()}})}).catch(function(e){showMsg('listMessage',e.message,false)})};
  var closeModal=function(){$('modal').classList.remove('active');document.body.style.overflow='';state.selected=null;state.dirty={}};
  $('closeModal').onclick=closeModal;
  $('modal').onclick=function(e){if(e.target===$('modal'))closeModal()};
  $('submitBtn').onclick=function(){if(state.selected===null)return;var payload={};Object.keys(state.dirty).forEach(function(k){if(!state.dirty[k])return;var inp=document.getElementById('inp_'+k);if(!inp)return;payload[k]=inp.value});if(Object.keys(payload).length===0){showMsg('modalMsg','没有修改内容',false);return}
    api('/admin/api/customers/'+state.selected,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).then(function(){showMsg('modalMsg','保存成功',true);return api('/admin/api/customers/'+state.selected)}).then(function(c){$('modalBody').innerHTML=buildModal(c);state.dirty={};document.querySelectorAll('.edit-btn').forEach(function(btn){btn.onclick=function(){var key=btn.getAttribute('data-key');var row=btn.closest('.field-row');row.classList.add('editing');state.dirty[key]=true;var inp=document.getElementById('inp_'+key);if(inp&&inp.focus)inp.focus()}});load()}).catch(function(e){showMsg('modalMsg',e.message,false)})};
  $('requeueBtn').onclick=function(){if(state.selected===null)return;api('/admin/api/customers/'+state.selected,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'pending'})}).then(function(){showMsg('modalMsg','已设为 pending',true);load()}).catch(function(e){showMsg('modalMsg',e.message,false)})};
  $('load').onclick=function(){state.offset=0;load()};$('search').onkeydown=function(e){if(e.key==='Enter'){state.offset=0;load()}};$('status').onchange=function(){state.offset=0;load()};$('prev').onclick=function(){if(state.offset>0){state.offset=Math.max(0,state.offset-state.limit);load()}};$('next').onclick=function(){if(state.offset+state.limit<state.total){state.offset+=state.limit;load()}};
  load();
  loadFilterOptions();
})();
</script></body></html>`;

const OUTREACH_PANEL_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>开发信管理 - Outreach</title><style>
:root{font-family:system-ui,-apple-system,sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}.top{background:#0f766e;color:#fff;padding:18px 26px;display:flex;justify-content:space-between;align-items:center;gap:12px}.top h1{font-size:22px;margin:0}.wrap{max-width:1400px;margin:22px auto;padding:0 18px}.tabs{display:flex;gap:0;margin-bottom:18px;border-bottom:2px solid #d1d5db}.tab{padding:12px 24px;cursor:pointer;font-weight:600;color:#6b7280;border-bottom:3px solid transparent;transition:.2s}.tab.active{color:#0f766e;border-bottom-color:#0f766e}.tab:hover{color:#0f766e}.panel{background:#fff;border:1px solid #d1d5db;border-radius:12px;padding:20px;margin-bottom:18px}.section-title{font-size:17px;font-weight:700;color:#0f766e;margin:0 0 14px;padding-bottom:8px;border-bottom:2px solid #0f766e}
.brand-card{background:#f0fdfa;border:1px solid #99f6e4;border-radius:12px;padding:20px;margin-bottom:16px}.brand-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.brand-name{font-size:20px;font-weight:700;color:#0f766e}.brand-category{font-size:13px;color:#6b7280;background:#e0f2fe;padding:4px 10px;border-radius:20px}
.toggle{position:relative;display:inline-block;width:50px;height:26px}.toggle input{opacity:0;width:0;height:0}.slider{position:absolute;cursor:pointer;inset:0;background:#cbd5e1;border-radius:26px;transition:.3s}.slider:before{content:'';position:absolute;height:20px;width:20px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.3s}input:checked+.slider{background:#0f766e}input:checked+.slider:before{transform:translateX(24px)}
.intro-textarea{width:100%;min-height:120px;padding:12px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;resize:vertical;margin-top:8px}
.btn{padding:10px 20px;border:0;border-radius:8px;cursor:pointer;font:inherit;font-weight:600;transition:.2s}.btn-primary{background:#0f766e;color:#fff}.btn-primary:hover{background:#115e59}.btn-secondary{background:#6b7280;color:#fff}.btn-secondary:hover{background:#4b5563}.btn-danger{background:#dc2626;color:#fff}.btn-danger:hover{background:#b91c1c}.btn-sm{padding:6px 14px;font-size:13px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:18px}.stat-card{background:#f0fdfa;border:1px solid #99f6e4;border-radius:10px;padding:16px;text-align:center}.stat-value{font-size:28px;font-weight:700;color:#0f766e}.stat-label{font-size:13px;color:#6b7280;margin-top:4px}
.email-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:12px}.email-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.email-subject{font-weight:700;font-size:15px;color:#111827}.email-meta{font-size:12px;color:#6b7280;margin-bottom:8px}.email-body{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px;white-space:pre-wrap;font-size:13px;line-height:1.6;color:#374151}
.badge{display:inline-block;border-radius:20px;padding:3px 10px;font-size:12px;font-weight:600}.badge-draft{background:#fef3c7;color:#92400e}.badge-sent{background:#d1fae5;color:#065f46}
.toast{position:fixed;top:20px;right:20px;padding:14px 20px;border-radius:10px;color:#fff;font-weight:600;z-index:9999;display:none}.toast.success{background:#059669}.toast.error{background:#dc2626}
.cp-bar{height:8px;border-radius:4px;background:#e2e8f0;overflow:hidden;display:flex;margin:6px 0}.cp-seg{height:100%}.cp-sent{background:#059669}.cp-generated{background:#0ea5e9}.cp-pending{background:#cbd5e1}.cp-failed{background:#dc2626}.cp-legend{font-size:12px;color:#6b7280;display:flex;gap:12px;flex-wrap:wrap}.cp-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px}
.cp-card{border:1px solid #d1d5db;border-radius:10px;padding:14px;margin-bottom:12px;background:#fff}.cp-card.done{border-color:#99f6e4;background:#f0fdfa}
.cp-table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}.cp-table th,.cp-table td{text-align:left;padding:6px 8px;border-bottom:1px solid #f1f5f9}.cp-table th{background:#f8fafc;font-weight:600;white-space:nowrap}
.cp-chip{display:inline-block;background:#f1f5f9;border-radius:20px;padding:2px 8px;font-size:11px;margin:2px}
.cp-hint{font-size:12px;color:#6b7280;line-height:1.7;margin:6px 0}
.cp-dd{position:relative;display:inline-block}
.cp-dd-btn{padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;font:inherit;font-size:13px;cursor:pointer;min-width:150px;max-width:320px;text-align:left;color:#172033;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cp-dd-btn:hover{border-color:#0f766e}
.cp-dd-panel{display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:60;background:#fff;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 10px 28px rgba(15,23,42,.14);padding:6px;max-height:260px;overflow:auto;min-width:230px}
.cp-dd.open .cp-dd-panel{display:block}
.cp-dd-item{display:flex;align-items:center;gap:7px;padding:5px 8px;font-size:13px;border-radius:6px;cursor:pointer;user-select:none}
.cp-dd-item:hover{background:#f0fdfa}
.cp-dd-item input:disabled+span{color:#9ca3af}
.cp-dd-n{margin-left:auto;color:#64748b;font-size:11px;font-variant-numeric:tabular-nums}
.cp-dd-sum{color:#0f766e;font-weight:600}
.cp-dd-empty{font-size:12px;color:#9ca3af;padding:6px 8px}
.cp-dd-search{width:100%;box-sizing:border-box;font:inherit;font-size:13px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;margin-bottom:4px}
.cp-dd-note{font-size:11px;color:#b45309;padding:2px 8px 4px}
@media(max-width:700px){.top{flex-direction:column}.stats{grid-template-columns:1fr 1fr}.email-header{flex-direction:column;align-items:flex-start;gap:6px}}

/* stage30 auto: inline style -> class */
.s-hidden{display:none}
.s-seclabel{font-weight:600;font-size:13px;color:#475569;display:block;margin-top:10px}
.s-fs13{font-size:13px}
.s-red-loud{color:red}
.s-hint12{font-size:12px;color:#6b7280}
.s-input-lg{padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}
.s-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.s-mt8{margin-top:8px}
.s-gray{color:#6b7280}
.s-mt10{margin-top:10px}
.s-input-flex{flex:1;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px}
.s-between{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center}
.s-input150{padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;width:150px}
.s-input{padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px}
.s-chiprow{font-size:13px;display:flex;align-items:center;gap:4px}
.s-gray0{color:#6b7280;margin:0}
.s-intro{font-size:13px;color:#475569;margin:0 0 10px}
.s-red13{color:#dc2626;font-size:13px}
.s-dfx-g12-aic{display:flex;gap:12px;align-items:center}
.s-m0{margin:0}
.s-fw600-fs13{font-weight:600;font-size:13px}
.s-dfx-g10-aic{display:flex;gap:10px;align-items:center}
.s-cfff-tdn-fw600{color:#fff;text-decoration:none;font-weight:600}
.s-bgrgba2552552552-cfff{background:rgba(255,255,255,.2);color:#fff}
.s-m0 0 10-fs13-c334155{margin:0 0 10px;font-size:13px;color:#334155}
.s-curptr-fw600{cursor:pointer;font-weight:600}
.s-m8 0 0 18-lh18{margin:8px 0 0 18px;line-height:1.8}
.s-m6 0 0-c6b7280{margin:6px 0 0;color:#6b7280}
.s-p8-bd1 ol cbd5e1-br6-fs13-fx1-mw240-ffmono{padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;flex:1;min-width:240px;font-family:monospace}
.s-w100-p8-bd1 ol cbd5e1-br6-fs12-ffmono{width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;font-family:monospace}
.s-mt8-dfx-g8-aic{margin-top:8px;display:flex;gap:8px;align-items:center}
.s-mt8-fs13{margin-top:8px;font-size:13px}
.s-dfx-g12-aic-fxww-mt12{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:12px}
.s-p10-bd1 ol cbd5e1-br8-finh-mw200{padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;min-width:200px}
.s-mt12{margin-top:12px}
.s-dfx-g8-fxww-aic-mb10{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.s-p8-bd1 ol cbd5e1-br6-fs13-mw180{padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;min-width:180px}
.s-p8-bd1 ol cbd5e1-br6-fs13-mw190{padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;min-width:190px}
.s-p8-bd1 ol cbd5e1-br6-fs13-w110{padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;width:110px}
.s-dfx-g8-aic-fxww{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.s-dfx-g8-aic-mt8-fxww{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
.s-p8-bd1 ol cbd5e1-br6-fs13-fx1-mw220{padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;flex:1;min-width:220px}
.s-xh230-ova-mt6{max-height:230px;overflow:auto;margin-top:6px}
.s-dfx-g8-fxww-aic-mt12-paddingtop12-bdt1 ol e5e7eb{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px;padding-top:12px;border-top:1px solid #e5e7eb}
.s-p8-bd1 ol cbd5e1-br6-fs13-w220{padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;width:220px}
.s-w1-h24-bge5e7eb{width:1px;height:24px;background:#e5e7eb}
.s-p8-bd1 ol cbd5e1-br6-fs13-w200{padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;width:200px}
.s-mt22{margin-top:22px}
.s-dfx-g8-aic-mb10-fxww{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.s-fs13-c475569{font-size:13px;color:#475569}
.s-dfx-g10-aic-fxww-mb14{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.s-fs13-c475569-mla{font-size:13px;color:#475569;margin-left:auto}
.s-dfx-jcb-aic-mt14{display:flex;justify-content:space-between;align-items:center;margin-top:14px}
.s-fs11-c0f766e-bgccfbf1-br10-p1 8{font-size:11px;color:#0f766e;background:#ccfbf1;border-radius:10px;padding:1px 8px}
.s-fs11-c92400e-bgfef3c7-br10-p1 8{font-size:11px;color:#92400e;background:#fef3c7;border-radius:10px;padding:1px 8px}
.s-cd97706{color:#d97706}
.s-c059669{color:#059669}
.s-cdc2626{color:#dc2626}
.s-fs12-cb91c1c-mt4-wbba{font-size:12px;color:#b91c1c;margin-top:4px;word-break:break-all}
.s-p14{padding:14px}
.s-fs14{font-size:14px}
.s-ffmono-fs12-c475569{font-family:monospace;font-size:12px;color:#475569}
.s-dfx-g6-aic{display:flex;gap:6px;align-items:center}
.s-fs12-c475569{font-size:12px;color:#475569}
.s-fw600-fs13-c475569{font-weight:600;font-size:13px;color:#475569}
.s-dfx-g8-mt4{display:flex;gap:8px;margin-top:4px}
.s-w100-mt4-p6 8-bd1 ol cbd5e1-br6-fs13{width:100%;margin-top:4px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px}
.s-w100-mh70-mt4-p8-bd1 ol cbd5e1-br6-fs13-ffmono{width:100%;min-height:70px;margin-top:4px;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;font-family:monospace}
.s-mt4-fs13-c334155{margin-top:4px;font-size:13px;color:#334155}
.s-dfx-g8-mt6-aic-fxww{display:flex;gap:8px;margin-top:6px;align-items:center;flex-wrap:wrap}
.s-p6 8-bd1 ol cbd5e1-br6-fs13{padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px}
.s-w100-mt4-p6 8-bd1 ol cbd5e1-br6-fs13-ffmono{width:100%;margin-top:4px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;font-family:monospace}
.s-mt10-tar{margin-top:10px;text-align:right}
.s-dfx-jcb-aic-p4 0{display:flex;justify-content:space-between;align-items:center;padding:4px 0}
.s-fs11-c0f766e-bgccfbf1-br10-p1 8-ml4{font-size:11px;color:#0f766e;background:#ccfbf1;border-radius:10px;padding:1px 8px;margin-left:4px}
.s-c6b7280-tac-p20{color:#6b7280;text-align:center;padding:20px}
.s-bgf0fdfa-bd1 ol 99f6e4-br10-p14{background:#f0fdfa;border:1px solid #99f6e4;border-radius:10px;padding:14px}
.s-fs15-fw700-c0f766e{font-size:15px;font-weight:700;color:#0f766e}
.s-fs13-c475569-mt4{font-size:13px;color:#475569;margin-top:4px}
.s-fs12-c6b7280-mt6{font-size:12px;color:#6b7280;margin-top:6px}
.s-w36{width:36px}
.s-tac{text-align:center}
.s-bgdbeafe-c1e40af{background:#dbeafe;color:#1e40af}
.s-fs12-cb91c1c-mt6{font-size:12px;color:#b91c1c;margin-top:6px}
.s-fs15{font-size:15px}
.s-m2 0{margin:2px 0}
.s-dfx-g6-aic-fxww{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.s-cdc2626-m0{color:#dc2626;margin:0}
.s-bgf8fafc{background:#f8fafc}
.s-dfx-jcb-aic{display:flex;justify-content:space-between;align-items:center}
/* stage30: dynamic-variant classes (campaign bar / members / disabled) */
.mo-fail{font-size:12px;color:#dc2626}.mo-ok{font-size:12px;color:#6b7280}
.cg-off{opacity:.45}
</style></head><body>
<header class="top"><h1>📧 开发信管理</h1><div class="s-dfx-g10-aic"><a href="/admin" class="s-cfff-tdn-fw600">← 返回客户管理</a><a href="/admin/crm" class="s-cfff-tdn-fw600">🎯 CRM 销售</a><form method="post" action="/admin/logout"><button class="btn btn-sm s-bgrgba2552552552-cfff"  type="submit">退出</button></form></div></header>
<main class="wrap">
<div class="tabs"><div class="tab active" data-tab="settings">⚙️ 品牌设置</div><div class="tab" data-tab="gmail">📮 发信账号</div><div class="tab" data-tab="generate">🤖 生成开发信</div><div class="tab" data-tab="campaign">🎯 定向群发</div><div class="tab" data-tab="emails">📬 开发信列表</div></div>
<div id="tab-settings" class="tab-content">
<div class="section-title">品牌配置</div><div id="brandsArea"></div>
</div>
<div id="tab-gmail" class="tab-content s-hidden" >
<div class="section-title">📮 Gmail 发信账号池</div>
<div class="panel"><p class="s-intro">添加多个发信账号组成账号池，每封邮件自动选择剩余配额最多的健康账号；品牌可单独绑定账号。被 Google 拒绝的账号自动冷却 6 小时。每日总配额 = 各账号配额之和。</p>
<details class="s-m0 0 10-fs13-c334155"><summary class="s-curptr-fw600">🟢 如何获取 OAuth 令牌（refresh_token）？点开看步骤</summary>
<ol class="s-m8 0 0 18-lh18">
<li>Google Cloud Console → 启用 <b>Gmail API</b>；OAuth 同意屏幕选 <b>内部</b>，范围加 <code>gmail.send</code>；</li>
<li>凭据 → 创建 <b>OAuth 客户端 ID</b>，类型选 <b>桌面应用</b>，记下客户端 ID/密钥；</li>
<li>把客户端 ID 配到 Worker：<code>npx wrangler secret put GMAIL_OAUTH_CLIENT_ID</code>（密钥同理 <code>GMAIL_OAUTH_CLIENT_SECRET</code>）；</li>
<li>本地运行 <code>python3 scripts/get-gmail-refresh-token.py --client-id …</code>，浏览器登录发件邮箱并授权，得到 refresh_token；</li>
<li>在本页凭据类型选 <b>OAuth 令牌</b>，粘贴邮箱 + refresh_token → 添加 → 点 🔌 测试。</li>
</ol>
<p class="s-m6 0 0-c6b7280">完整说明见仓库 <code>crm-ai-worker/docs/gmail-account-setup.md</code>。服务账号需全域委托；OAuth 令牌不需要，适合少量固定发件邮箱。</p></details>
<div class="s-row"><select id="gaType" class="s-input"><option value="oauth_refresh">OAuth 令牌（推荐，无需服务账号密钥）</option><option value="service_account">服务账号（需全域委托）</option></select><input id="gaLabel" placeholder="备注（如：主账号）" class="s-input150"><input id="gaEmail" class="ga-email-input s-p8-bd1 ol cbd5e1-br6-fs13-fx1-mw240-ffmono" placeholder="发件邮箱 helen@isupfactory.com" ><input id="gaLimit" type="number" min="1" placeholder="每日配额（默认 400）" class="s-input150"></div>
<div class="s-mt8"><textarea id="gaKey" rows="3" placeholder="粘贴 refresh_token（一长串无空格字符）" class="s-w100-p8-bd1 ol cbd5e1-br6-fs12-ffmono"></textarea></div>
<div class="s-mt8-dfx-g8-aic"><button class="btn btn-primary" id="gaAdd">➕ 添加账号</button><span class="s-hint12">凭据 AES-GCM 加密后存入 D1，永不回显</span></div>
<div id="gaMsg" class="s-mt8-fs13"></div></div>
<div id="gaList"></div>
</div>
<div id="tab-generate" class="tab-content s-hidden" >
<div class="section-title">生成开发信</div>
<div class="panel"><p>选择品牌，AI将根据数据库中匹配的客户信息自动生成个性化开发信。</p>
<div class="s-dfx-g12-aic-fxww-mt12">
<select id="genBrand" class="s-p10-bd1 ol cbd5e1-br8-finh-mw200"></select>
<select id="genLimit" class="s-input-lg"><option value="5">5封</option><option value="10" selected>10封</option><option value="20">20封</option><option value="50">50封</option></select>
<button class="btn btn-primary" id="genBtn">🚀 开始生成</button>
</div><div id="genMsg" class="s-mt12"></div></div>
</div>
<div id="tab-campaign" class="tab-content s-hidden" >
<div class="section-title">🎯 定向群发（按客户群体群发）</div>
<div class="panel">
<p class="s-intro">用与「客户管理 → 海选过滤器」相同的条件圈出一群客户，保存为可复用客群，创建群发任务后可<b>分批生成开发信、分批发送</b>。每批都记进度，关掉页面随时续发。</p>
<div class="s-dfx-g8-fxww-aic-mb10">
<select id="cgBrand" class="s-p8-bd1 ol cbd5e1-br6-fs13-mw180"></select>
<select id="cgGroup" class="s-p8-bd1 ol cbd5e1-br6-fs13-mw190"><option value="">— 不使用已保存客群 —</option></select>
<button class="btn btn-sm btn-secondary" id="cgLoadGroup">载入客群条件</button>
<button class="btn btn-sm btn-secondary s-hidden" id="cgDeleteGroup" >删除该客群</button>
</div>
<div class="s-row">
<span class="cp-dd" id="ddCountries"><button type="button" class="cp-dd-btn" data-dd="countries">🌍 国家<span class="cp-dd-sum" id="ddSumCountries"></span> ▾</button><div class="cp-dd-panel" id="ddPanelCountries"></div></span>
<span class="cp-dd" id="ddSegments"><button type="button" class="cp-dd-btn" data-dd="segments">🏷️ 细分<span class="cp-dd-sum" id="ddSumSegments"></span> ▾</button><div class="cp-dd-panel" id="ddPanelSegments"></div></span>
<span class="cp-dd" id="ddProducts"><button type="button" class="cp-dd-btn" data-dd="products">📦 产品<span class="cp-dd-sum" id="ddSumProducts"></span> ▾</button><div class="cp-dd-panel" id="ddPanelProducts"></div></span>
<span class="cp-dd" id="ddKeywords"><button type="button" class="cp-dd-btn" data-dd="keywords">🔎 关键词<span class="cp-dd-sum" id="ddSumKeywords"></span> ▾</button><div class="cp-dd-panel" id="ddPanelKeywords"></div></span>
<select id="cgMinScore" class="s-p8-bd1 ol cbd5e1-br6-fs13-w110"><option value="">最低分：不限</option><option value="40">最低分 ≥40</option><option value="60">最低分 ≥60</option><option value="70">最低分 ≥70</option><option value="80">最低分 ≥80</option><option value="90">最低分 ≥90</option></select>
<select id="cgIcpFloor" class="s-p8-bd1 ol cbd5e1-br6-fs13-w110"><option value="">ICP 匹配：不限</option><option value="25">ICP 匹配 ≥25</option><option value="30">ICP 匹配 ≥30</option></select>
<label class="s-chiprow"><input type="checkbox" id="cgHasSignal"> 有购买信号</label>
<label class="s-chiprow"><input type="checkbox" id="cgExcludeSent" checked> 排除本品牌已发送</label>
<label class="s-chiprow"><input type="checkbox" id="cgPerPerson"> 按联系人发送</label>
<input id="cgPersonaRoles" list="dlPersonaRoles" placeholder="人物角色筛选（逗号分隔，如：采购总监,门店老板）" class="s-p8-bd1 ol cbd5e1-br6-fs13-fx1-mw220">
<input id="cgRolePriority" list="dlPersonaRoles" placeholder="角色优先级（逗号分隔，先匹配的先选）" class="s-p8-bd1 ol cbd5e1-br6-fs13-fx1-mw220">
<select id="cgContactsPer" class="s-p8-bd1 ol cbd5e1-br6-fs13-w110"><option value="1">每公司 1 人</option><option value="2">每公司 2 人</option><option value="3">每公司 3 人</option></select>
<datalist id="dlPersonaRoles"></datalist>
<button class="btn btn-primary btn-sm" id="cgPreview">🔍 统计客群</button>
</div>
<p class="cp-hint">只统计已完成研究（<code>status=completed</code>）且<b>有邮箱</b>的客户——没有研究档案无法生成个性化开发信，没有邮箱无法发送。勾选「按联系人发送」后改为定向联系人：每家公司按「角色优先级」排序取至多「每公司 N 人」个有邮箱联系人（不填优先级时取最早发现的），公司自身邮箱不再要求；没有带邮箱联系人的公司会被跳过。人物角色取自最新研究档案的买家画像（精确匹配）。手工勾选的客户会与其余条件取交集。下拉筛选项右侧的数字是该条件当前命中的<b>可发信</b>客户数（未扣除本品牌已发送）。关键词取自客户名称与描述中的高频业务词，最多可选 5 个。</p>
<div id="cgPickedWrap" class="s-mt8">
<div class="s-dfx-g8-aic-fxww"><span class="s-fs13">手工勾选：</span><span id="cgPicked" class="cp-chip"></span><button class="btn btn-sm btn-secondary" id="cgClearPicked">清空</button></div>
<div class="s-dfx-g8-aic-mt8-fxww"><input id="cgPickSearch" placeholder="搜索公司名/网址/国家以勾选客户" class="s-p8-bd1 ol cbd5e1-br6-fs13-fx1-mw220"><button class="btn btn-sm btn-secondary" id="cgPickSearchBtn">🔎 搜索并勾选</button></div>
<div id="cgPickResults" class="s-xh230-ova-mt6"></div>
</div>
<div id="cgPreviewBox" class="s-mt10"></div>
<div class="s-dfx-g8-fxww-aic-mt12-paddingtop12-bdt1 ol e5e7eb">
<input id="cgGroupName" placeholder="客群名称（保存后可复用）" class="s-p8-bd1 ol cbd5e1-br6-fs13-w220">
<button class="btn btn-sm btn-secondary" id="cgSaveGroup">💾 保存为客群</button>
<span class="s-w1-h24-bge5e7eb"></span>
<input id="cgName" placeholder="群发任务名称（可选）" class="s-p8-bd1 ol cbd5e1-br6-fs13-w200">
<button class="btn btn-primary btn-sm" id="cgCreate">🚀 创建群发任务</button>
</div>
<div id="cgMsg" class="s-mt10"></div>
</div>
<div class="section-title s-mt22" >群发任务</div>
<div class="s-dfx-g8-aic-mb10-fxww">
<label class="s-fs13">每批数量</label>
<select id="cgBatch" class="s-input"><option value="5" selected>5 封</option><option value="10">10 封</option><option value="20">20 封</option><option value="30">30 封</option><option value="50">50 封</option></select>
<button class="btn btn-sm btn-secondary" id="cgRefresh">刷新</button>
<span id="cgQuota" class="s-fs13-c475569"></span>
</div>
<div id="cgList"></div>
</div>
<div id="tab-emails" class="tab-content s-hidden" >
<div class="stats" id="statsArea"></div>
<div class="panel"><div class="s-dfx-g10-aic-fxww-mb14">
<select id="filterBrand" class="s-input-lg"><option value="">全部品牌</option><option value="iSupfactory">iSupfactory (SUPs)</option><option value="Aquafarer">Aquafarer (Inflatable)</option><option value="Neptunor">Neptunor (RIB)</option></select>
<select id="filterStatus" class="s-input-lg"><option value="">全部状态</option><option value="draft">草稿</option><option value="sent">已发送</option></select>
<button class="btn btn-secondary btn-sm" id="refreshEmails">刷新</button>
<span id="quotaInfo" class="s-fs13-c475569-mla">📧 Gmail 配额加载中…</span>
<button class="btn btn-primary btn-sm" id="sendBatchBtn">📤 批量发送草稿</button>
</div><div id="emailsArea"></div>
<div class="s-dfx-jcb-aic-mt14"><button class="btn btn-secondary btn-sm" id="emailPrev">上一页</button><span id="emailPageInfo"></span><button class="btn btn-secondary btn-sm" id="emailNext">下一页</button></div>
</div>
</div>
</main>
<div class="toast" id="toast"></div>
<script>
(function(){
var toastTimeout;
function showToast(msg,isOk){var t=document.getElementById('toast');t.textContent=msg;t.className='toast '+(isOk?'success':'error');t.style.display='block';clearTimeout(toastTimeout);toastTimeout=setTimeout(function(){t.style.display='none'},4000)}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function api(p,o){return fetch(p,o||{}).then(function(r){if(r.status===401){location='/admin/outreach';throw new Error('登录过期')}var ct=r.headers.get('content-type')||'';if(ct.indexOf('json')===-1){return r.text().then(function(t){throw new Error('非JSON响应: '+t.slice(0,100))})}return r.json().then(function(d){if(!r.ok)throw new Error(d.detail||'请求失败');return d})})}

// Tab switching
document.querySelectorAll('.tab').forEach(function(tab){tab.onclick=function(){document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active')});document.querySelectorAll('.tab-content').forEach(function(c){c.style.display='none'});tab.classList.add('active');document.getElementById('tab-'+tab.dataset.tab).style.display='block';if(tab.dataset.tab==='settings')loadBrands();if(tab.dataset.tab==='gmail')loadGmailAccounts();if(tab.dataset.tab==='campaign'){loadCampaignBrand();loadGroups();loadCampaigns();loadQuota();loadFilterOptions();loadPersonaRoleOptions()}if(tab.dataset.tab==='emails'){loadStats();loadEmails();loadQuota()}}});

// ── Gmail sender account pool ──
var GA_TYPE_HINTS={
  oauth_refresh:{email:'发件邮箱（如 helen@isupfactory.com）',key:'粘贴 refresh_token（一长串无空格字符，用本地脚本获取，见 docs/gmail-account-setup.md）'},
  service_account:{email:'服务账号邮箱 …@….iam.gserviceaccount.com',key:'粘贴私钥 PEM（-----BEGIN PRIVATE KEY-----…）'}
};
document.getElementById('gaType').onchange=function(){
  var t=this.value,h=GA_TYPE_HINTS[t];
  document.querySelector('.ga-email-input').placeholder=h.email;
  document.getElementById('gaKey').placeholder=h.key;
};
function loadGmailAccounts(){
  api('/admin/api/gmail/accounts').then(function(d){
    var list=document.getElementById('gaList');
    if(!d.accounts.length){list.innerHTML='<div class="panel"><p class="s-gray0">暂无账号。未添加时使用服务器 Secrets 中的 GMAIL_SERVICE_ACCOUNT_* 配置。</p></div>';return}
    list.innerHTML=d.accounts.map(function(a){
      var isOa=a.credential_type==='oauth_refresh';
      var typeBadge=isOa?'<span class="s-fs11-c0f766e-bgccfbf1-br10-p1 8">OAuth 令牌</span>':'<span class="s-fs11-c92400e-bgfef3c7-br10-p1 8">服务账号</span>';
      var status=a.enabled?(a.cooldown_until?'<span class="s-cd97706">❄️ 冷却中（至 '+esc(a.cooldown_until)+'）</span>':'<span class="s-c059669">✅ 正常</span>'):'<span class="s-cdc2626">⛔ 已停用</span>';
      var err=a.last_error?'<div class="s-fs12-cb91c1c-mt4-wbba">最近错误：'+esc(a.last_error)+'</div>':'';
      return '<div class="panel s-p14" ><div class="s-between"><div><b class="s-fs14">'+esc(a.label||'（无备注）')+'</b> '+typeBadge+' <span class="s-ffmono-fs12-c475569">'+esc(a.client_email)+'</span></div><div class="s-dfx-g6-aic">'+status+' <span class="s-fs12-c475569">今日 '+a.sent_today+'/'+(a.daily_limit||'默认')+'</span> <button class="btn btn-sm btn-secondary ga-test" data-id="'+a.id+'">🔌 测试</button> <button class="btn btn-sm '+(a.enabled?'btn-danger':'btn-primary')+' ga-toggle" data-id="'+a.id+'" data-enabled="'+(a.enabled?1:0)+'">'+(a.enabled?'停用':'启用')+'</button> <button class="btn btn-sm btn-danger ga-del" data-id="'+a.id+'">删除</button></div></div>'+err+'</div>';
    }).join('');
    list.querySelectorAll('.ga-test').forEach(function(b){b.onclick=function(){b.disabled=true;b.textContent='⏳…';api('/admin/api/gmail/accounts/'+b.dataset.id+'/test',{method:'POST'}).then(function(r){showToast(r.detail,r.ok);loadGmailAccounts()}).catch(function(e){showToast(e.message,false);b.disabled=false;b.textContent='🔌 测试'})}});
    list.querySelectorAll('.ga-toggle').forEach(function(b){b.onclick=function(){var enable=b.dataset.enabled==='0';api('/admin/api/gmail/accounts/'+b.dataset.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:enable})}).then(function(){showToast(enable?'已启用':'已停用',true);loadGmailAccounts()}).catch(function(e){showToast(e.message,false)})}});
    list.querySelectorAll('.ga-del').forEach(function(b){b.onclick=function(){if(!confirm('确定删除该发信账号？'))return;api('/admin/api/gmail/accounts/'+b.dataset.id,{method:'DELETE'}).then(function(){showToast('已删除',true);loadGmailAccounts()}).catch(function(e){showToast(e.message,false)})}});
  }).catch(function(e){document.getElementById('gaList').innerHTML='<div class="panel"><p class="s-red-loud">'+esc(e.message)+'</p></div>'});
}
document.getElementById('gaAdd').onclick=function(){
  var type=document.getElementById('gaType').value;
  var label=document.getElementById('gaLabel').value.trim();
  var email=document.getElementById('gaEmail').value.trim();
  var key=document.getElementById('gaKey').value.trim();
  var limit=document.getElementById('gaLimit').value;
  if(!email||!key){var m=document.getElementById('gaMsg');m.textContent='❌ 邮箱和凭据均为必填';m.style.color='#dc2626';return}
  var btn=this;btn.disabled=true;btn.textContent='⏳ 保存中…';
  api('/admin/api/gmail/accounts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:label,credential_type:type,client_email:email,private_key:key,daily_limit:limit?Number(limit):undefined})})
    .then(function(){document.getElementById('gaMsg').textContent='✅ 账号已添加';document.getElementById('gaMsg').style.color='#059669';document.getElementById('gaEmail').value='';document.getElementById('gaKey').value='';document.getElementById('gaLabel').value='';document.getElementById('gaLimit').value='';showToast('发信账号已添加',true);loadGmailAccounts()})
    .catch(function(e){var m=document.getElementById('gaMsg');m.textContent='❌ '+e.message;m.style.color='#dc2626'})
    .finally(function(){btn.disabled=false;btn.textContent='➕ 添加账号'});
};

// Brand settings
function loadBrands(){
  api('/admin/api/outreach/settings').then(function(d){
    var h='';
    d.settings.forEach(function(b){
      h+='<div class="brand-card"><div class="brand-header"><div><span class="brand-name">'+esc(b.brand_name)+'</span> <span class="brand-category">'+esc(b.product_category)+'</span></div><label class="toggle"><input type="checkbox" '+(b.enabled?'checked':'')+' data-brand="'+esc(b.brand_name)+'" class="enable-toggle"><span class="slider"></span></label></div>'+
        '<label class="s-fw600-fs13-c475569">发件身份（From 邮箱 / 显示名）</label><div class="s-dfx-g8-mt4"><input class="sender-email s-input-flex" data-brand="'+esc(b.brand_name)+'" placeholder="sender@yourdomain.com" value="'+esc(b.sender_email||'')+'" ><input class="sender-name s-input-flex" data-brand="'+esc(b.brand_name)+'" placeholder="Toby | iSupfactory Team" value="'+esc(b.sender_name||'')+'" ></div>'+
        '<label class="s-seclabel">公司名义（邮件正文署名的公司主体，留空则用品牌名）</label><input class="company-entity s-w100-mt4-p6 8-bd1 ol cbd5e1-br6-fs13" data-brand="'+esc(b.brand_name)+'" placeholder="SUP DIVISION OF QINGDAO VATRAD GROUP CO., LTD" value="'+esc(b.company_entity||'')+'" >'+
        '<label class="s-seclabel">邮件签名（原样附加在正文末尾）</label><textarea class="signature-textarea s-w100-mh70-mt4-p8-bd1 ol cbd5e1-br6-fs13-ffmono" data-brand="'+esc(b.brand_name)+'" >'+esc(b.signature||'')+'</textarea>'+
        '<label class="s-seclabel">邮件附件（最多 5 个，每个 ≤1.4MB；按收件人语言自动附带对应画册）</label><div class="att-list s-mt4-fs13-c334155" data-brand="'+esc(b.brand_name)+'" >加载中…</div><div class="s-dfx-g8-mt6-aic-fxww"><input type="file" class="att-file s-fs13" data-brand="'+esc(b.brand_name)+'" ><select class="att-lang s-p6 8-bd1 ol cbd5e1-br6-fs13" data-brand="'+esc(b.brand_name)+'" ><option value="all">🌐 通用（所有客户）</option><option value="es">🇪🇸 西班牙语</option><option value="en">🇬🇧 英语</option><option value="de">🇩🇪 德语</option><option value="fr">🇫🇷 法语</option><option value="pt">🇵🇹 葡萄牙语</option><option value="it">🇮🇹 意大利语</option><option value="nl">🇳🇱 荷兰语</option><option value="ru">🇷🇺 俄语</option><option value="pl">🇵🇱 波兰语</option><option value="ar">🇸🇦 阿拉伯语</option><option value="ja">🇯🇵 日语</option><option value="ko">🇰🇷 韩语</option></select><button class="btn btn-sm btn-primary att-upload" data-brand="'+esc(b.brand_name)+'">⬆ 上传附件</button></div>'+
        '<label class="s-seclabel">绑定发信账号（📮 发信账号池中的账号，留空=自动分配）</label><input class="gmail-account s-w100-mt4-p6 8-bd1 ol cbd5e1-br6-fs13-ffmono" data-brand="'+esc(b.brand_name)+'" placeholder="留空自动分配，或填账号池中的邮箱（服务账号或 OAuth 发件邮箱）" value="'+esc(b.gmail_account||'')+'" >'+
        '<label class="s-seclabel">公司简介</label><textarea class="intro-textarea" data-brand="'+esc(b.brand_name)+'">'+esc(b.company_intro)+'</textarea><div class="s-mt10-tar"><button class="btn btn-primary btn-sm save-brand" data-brand="'+esc(b.brand_name)+'">💾 保存配置</button></div></div>';
    });
    document.getElementById('brandsArea').innerHTML=h||'<p>暂无品牌配置</p>';
    document.querySelectorAll('.brand-card').forEach(function(card){
      var brand=card.querySelector('.enable-toggle').dataset.brand;
      loadAttachments(brand);
    });
    document.querySelectorAll('.enable-toggle').forEach(function(el){
      el.onchange=function(){
        var brand=el.dataset.brand;
        var enabled=el.checked;
        api('/admin/api/outreach/settings/'+encodeURIComponent(brand),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:enabled})})
          .then(function(){showToast(brand+(enabled?' 已启用':' 已禁用'),true)})
          .catch(function(e){showToast(e.message,false);el.checked=!enabled});
      };
    });
    document.querySelectorAll('.att-upload').forEach(function(el){
      el.onclick=function(){
        var brand=el.dataset.brand;
        var input=document.querySelector('.att-file[data-brand="'+brand+'"]');
        if(!input.files||!input.files[0]){showToast('请选择文件',false);return}
        var file=input.files[0];
        if(file.size>1400000){showToast('文件超过 1.4MB（D1 存储限制）',false);return}
        var langSel=document.querySelector('.att-lang[data-brand="'+brand+'"]');
        var language=langSel?langSel.value:'all';
        var btn=el;btn.disabled=true;btn.textContent='⏳ 上传中…';
        var reader=new FileReader();
        reader.onload=function(){
          var b64=reader.result.split(',')[1];
          api('/admin/api/outreach/attachments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({brand:brand,filename:file.name,mime_type:file.type||'application/octet-stream',content_base64:b64,language:language})})
            .then(function(){showToast('附件已上传（'+(LANG_LABELS[language]||language)+'）',true);loadAttachments(brand)})
            .catch(function(e){showToast(e.message,false)})
            .finally(function(){btn.disabled=false;btn.textContent='⬆ 上传附件';input.value=''});
        };
        reader.readAsDataURL(file);
      };
    });
    document.querySelectorAll('.save-brand').forEach(function(el){
      el.onclick=function(){
        var brand=el.dataset.brand;
        var ta=document.querySelector('.intro-textarea[data-brand="'+brand+'"]');
        var se=document.querySelector('.sender-email[data-brand="'+brand+'"]');
        var sn=document.querySelector('.sender-name[data-brand="'+brand+'"]');
        var sg=document.querySelector('.signature-textarea[data-brand="'+brand+'"]');
        var ce=document.querySelector('.company-entity[data-brand="'+brand+'"]');
        var ga=document.querySelector('.gmail-account[data-brand="'+brand+'"]');
        api('/admin/api/outreach/settings/'+encodeURIComponent(brand),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({company_intro:ta.value,sender_email:se.value,sender_name:sn.value,company_entity:ce.value,signature:sg.value,gmail_account:ga?ga.value:''})})
          .then(function(){showToast(brand+' 配置已保存（签名已更新）',true)})
          .catch(function(e){showToast(e.message,false)});
      };
    });
  }).catch(function(e){
    document.getElementById('brandsArea').innerHTML='<p class="s-red-loud">'+esc(e.message)+'</p>';
  });
}

var LANG_LABELS={all:'🌐 通用',es:'🇪🇸 西班牙语',en:'🇬🇧 英语',de:'🇩🇪 德语',fr:'🇫🇷 法语',pt:'🇵🇹 葡萄牙语',it:'🇮🇹 意大利语',nl:'🇳🇱 荷兰语',ru:'🇷🇺 俄语',pl:'🇵🇱 波兰语',ar:'🇸🇦 阿拉伯语',ja:'🇯🇵 日语',ko:'🇰🇷 韩语'};
function loadAttachments(brand){var box=document.querySelector('.att-list[data-brand="'+brand+'"]');if(!box)return;api('/admin/api/outreach/attachments?brand='+encodeURIComponent(brand)).then(function(d){if(!d.attachments.length){box.innerHTML='<span class="s-gray">暂无附件</span>';return}box.innerHTML=d.attachments.map(function(a){var langLabel=LANG_LABELS[a.language]||(a.language?'🌐 '+esc(a.language):'🌐 通用');return '<div class="s-dfx-jcb-aic-p4 0"><span>📄 '+esc(a.filename)+' ('+Math.round(a.size_bytes/1024)+' KB) <span class="s-fs11-c0f766e-bgccfbf1-br10-p1 8-ml4">'+langLabel+'</span></span><button class="btn btn-sm btn-danger att-del" data-id="'+a.id+'" data-brand="'+esc(brand)+'">删除</button></div>'}).join('');box.querySelectorAll('.att-del').forEach(function(btn){btn.onclick=function(){api('/admin/api/outreach/attachments/'+btn.dataset.id,{method:'DELETE'}).then(function(){showToast('附件已删除',true);loadAttachments(btn.dataset.brand)}).catch(function(e){showToast(e.message,false)})}})}).catch(function(){box.innerHTML='<span class="s-gray">附件加载失败</span>'})}

// Generate
api('/admin/api/outreach/settings').then(function(d){var sel=document.getElementById('genBrand');sel.innerHTML='';d.settings.forEach(function(b){if(b.enabled){var opt=document.createElement('option');opt.value=b.brand_name;opt.textContent=b.brand_name+' ('+b.product_category+')';sel.appendChild(opt)}});if(!sel.options.length){sel.innerHTML='<option value="">-- 请先启用品牌 --</option>'}});
// Generate — batched client-side. One Worker invocation has a hard budget of
// subrequests (D1/fetch/DO calls, ~50 on the free plan); each generated email
// costs ~6, so a single 10-email request dies around the 7th email (observed
// as "只生成 6 封就停止"). Splitting into 5-per-request batches gives every
// batch a fresh invocation budget and keeps each well under the cap.
var GEN_BATCH_SIZE=5;
document.getElementById('genBtn').onclick=function(){
  var brand=document.getElementById('genBrand').value;
  var total=Number(document.getElementById('genLimit').value);
  if(!brand){showToast('请选择品牌',false);return}
  if(!total||total<1){showToast('请选择生成数量',false);return}
  var btn=document.getElementById('genBtn');
  btn.disabled=true;btn.textContent='⏳ 生成中...';
  var generated=0,failed=0,done=0,firstError='';
  showMsg('genMsg','正在为 '+brand+' 分批生成开发信（每批 '+GEN_BATCH_SIZE+' 封），请勿关闭页面...',false);
  function finish(err){
    var ok=!err;
    var msg=ok
      ?('✅ 成功生成 '+generated+' 封开发信'+(failed?'，'+failed+' 条失败'+(firstError?'（'+firstError.slice(0,120)+'）':''):''))
      :('❌ 已生成 '+generated+' 封后中断：'+err.message);
    showMsg('genMsg',msg,ok);showToast(err?err.message:('生成完成: '+generated+'封'),ok);
    btn.disabled=false;btn.textContent='🚀 开始生成';
    loadStats();loadEmails();
  }
  (function next(){
    var n=Math.min(GEN_BATCH_SIZE,total-done);
    api('/admin/api/outreach/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({brand:brand,limit:n})}).then(function(r){
      generated+=r.generated||0;failed+=(r.errors?r.errors.length:0);
      if(!firstError&&r.errors&&r.errors.length)firstError=String(r.errors[0]);
      done+=n;
      if(done>=total){finish(null);return}
      // The whole batch failed (AI/provider down or rate-limited): retrying
      // the next batch immediately would just burn the same errors again.
      if((r.generated||0)===0&&r.errors&&r.errors.length>0){finish(null);return}
      showMsg('genMsg','⏳ 已生成 '+generated+' 封（目标 '+total+'），继续...',true);
      next();
    }).catch(function(e){finish(e)});
  })();
};
function showMsg(id,t,g){var e=document.getElementById(id);if(!e)return;e.textContent=t;e.className='notice '+(g?'success':'error');e.style.display='block'}

// Email list
var emailState={offset:0,limit:20,total:0};
function loadStats(){api('/admin/api/outreach/stats').then(function(s){var h='<div class="stat-card"><div class="stat-value">'+s.total+'</div><div class="stat-label">总计</div></div><div class="stat-card"><div class="stat-value">'+s.draft+'</div><div class="stat-label">草稿</div></div><div class="stat-card"><div class="stat-value">'+s.sent+'</div><div class="stat-label">已发送</div></div>';s.by_brand.forEach(function(b){h+='<div class="stat-card"><div class="stat-value">'+b.count+'</div><div class="stat-label">'+esc(b.brand_name)+'</div></div>'});document.getElementById('statsArea').innerHTML=h}).catch(function(){})}
function loadEmails(){
  var brand=document.getElementById('filterBrand').value;
  var status=document.getElementById('filterStatus').value;
  var p=new URLSearchParams({limit:String(emailState.limit),offset:String(emailState.offset)});
  if(brand)p.set('brand',brand);
  if(status)p.set('status',status);
  api('/admin/api/outreach/emails?'+p.toString()).then(function(d){
    emailState.total=d.total;
    var h='';
    d.items.forEach(function(e){
      h+='<div class="email-card"><div class="email-header"><span class="email-subject">'+esc(e.subject||'(无主题)')+'</span><div><span class="badge badge-'+esc(e.status)+'">'+(e.status==='sent'?'已发送':'草稿')+'</span> <button class="btn btn-sm btn-danger del-email" data-id="'+e.id+'">删除</button>'+(e.status==='draft'?' <button class="btn btn-sm btn-primary send-one" data-id="'+e.id+'">📧 发送</button>':'')+'</div></div><div class="email-meta">'+esc(e.brand_name||'')+' → '+esc(e.company_name||'')+' ('+esc(e.display_id||'')+') | 收件人: '+esc(e.email_to||'未知')+' | '+esc(e.created_at||'')+'</div><div class="email-body">'+esc(e.body||'')+'</div></div>';
    });
    if(!d.items.length)h='<p class="s-c6b7280-tac-p20">暂无开发信</p>';
    emailState.total=d.total;
    document.getElementById('emailsArea').innerHTML=h;
    document.getElementById('emailPageInfo').textContent=(d.total?emailState.offset+1:0)+'-'+Math.min(emailState.offset+emailState.limit,d.total)+' / '+d.total;
    document.getElementById('emailPrev').disabled=emailState.offset===0;
    document.getElementById('emailNext').disabled=emailState.offset+emailState.limit>=d.total;
    document.querySelectorAll('.del-email').forEach(function(b){
      b.onclick=function(){
        if(!confirm('确定删除？'))return;
        api('/admin/api/outreach/emails/'+b.dataset.id,{method:'DELETE'})
          .then(function(){showToast('已删除',true);loadEmails();loadStats()})
          .catch(function(e){showToast(e.message,false)});
      };
    });
    document.querySelectorAll('.send-one').forEach(function(b){
      b.onclick=function(){
        if(b.disabled)return;
        b.disabled=true;b.textContent='⏳…';
        api('/admin/api/outreach/emails/'+b.dataset.id+'/send',{method:'POST'})
          .then(function(d){
            if(d.ok){showToast('已通过 Gmail 发送（今日 '+d.quota.sent_today+'/'+d.quota.daily_limit+'）',true)}
            else{showToast('发送失败：'+(d.error||'未知错误'),false)}
            loadQuota();loadStats();loadEmails();
          })
          .catch(function(e){showToast(e.message,false);b.disabled=false;b.textContent='📧 发送'});
      };
    });
  }).catch(function(e){
    document.getElementById('emailsArea').innerHTML='<p class="s-red-loud">'+esc(e.message)+'</p>';
  });
}
document.getElementById('refreshEmails').onclick=function(){emailState.offset=0;loadEmails()};

function loadQuota(){api('/admin/api/outreach/quota').then(function(q){document.getElementById('quotaInfo').textContent='📧 Gmail 今日 '+q.sent_today+'/'+q.daily_limit+' 剩余 '+q.remaining}).catch(function(){document.getElementById('quotaInfo').textContent='📧 Gmail 未配置'})}

var sending=false;
document.getElementById('sendBatchBtn').onclick=function(){
if(sending)return;
var brand=document.getElementById('filterBrand').value;
var n=prompt('本次批量发送数量（1-50，受每日配额限制）：','10');
if(n===null)return;
sending=true;
var btn=this;btn.textContent='⏳ 发送中…';
showToast('开始批量发送，每封间隔几秒，请勿关闭页面',true);
api('/admin/api/outreach/send-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({brand:brand||undefined,limit:Number(n)||10})}).then(function(d){
var fails=d.results.filter(function(r){return !r.ok});
showToast('发送完成：成功 '+d.sent+' 封，失败 '+d.failed+' 封（今日 '+d.quota.sent_today+'/'+d.quota.daily_limit+'）',d.failed===0);
if(fails.length){console.log('发送失败明细',fails);alert('前3条失败原因：\\n'+fails.slice(0,3).map(function(f){return '#'+f.id+': '+f.error}).join('\\n'))}
}).catch(function(e){showToast(e.message,false)}).finally(function(){sending=false;btn.textContent='📤 批量发送草稿';loadQuota();loadEmails();loadStats()})};
document.getElementById('filterBrand').onchange=function(){emailState.offset=0;loadEmails()};
document.getElementById('filterStatus').onchange=function(){emailState.offset=0;loadEmails()};
document.getElementById('emailPrev').onclick=function(){if(emailState.offset>0){emailState.offset=Math.max(0,emailState.offset-emailState.limit);loadEmails()}};
document.getElementById('emailNext').onclick=function(){if(emailState.offset+emailState.limit<emailState.total){emailState.offset+=emailState.limit;loadEmails()}};

/* ══ 定向群发 (targeted campaigns) ══
   Flow: filters (same criteria as the 海选 tab) → preview → save as a reusable
   客群 → create a campaign (membership is snapshotted server-side) → generate
   drafts in batches → send in batches. Every step is resumable, so a closed
   tab or a spent daily quota never loses progress. */
var cgPickedIds=[];
var cgBusy={};
function cgMsg(t,g){var e=document.getElementById('cgMsg');e.textContent=t;e.style.color=g?'#059669':'#dc2626';e.style.fontSize='13px'}
/* ── 多选下拉（国家/细分/产品/关键词）：勾选式选择项，替代手填输入框 ── */
var cgDDKinds=['countries','segments','products','keywords'];
var cgDDOpts={countries:[],segments:[],products:[],keywords:[]};
var cgDDSel={countries:[],segments:[],products:[],keywords:[]};
// Mirrors MAX_FILTER_VALUES / MAX_KEYWORDS in src/campaigns.ts: the API
// rejects longer lists, so cap the ticks here where the operator can see why.
var cgDDLimit={countries:10,segments:10,products:10,keywords:5};
var cgDDState='loading',cgPendingDD=null;
function cgDDCap(kind){return kind.charAt(0).toUpperCase()+kind.slice(1)}
function cgDDRender(kind){
  var panel=document.getElementById('ddPanel'+cgDDCap(kind));
  if(!panel)return;
  if(cgDDState!=='ready'){
    panel.innerHTML='<div class="cp-dd-empty">'+(cgDDState==='error'?'加载失败，刷新重试':'加载中…')+'</div>';
    return;
  }
  if(!panel.__built){
    panel.__built=true;panel.__q='';
    panel.innerHTML='<input class="cp-dd-search" placeholder="过滤…"><div class="cp-dd-list"></div>';
    panel.querySelector('.cp-dd-search').oninput=function(){panel.__q=this.value;cgDDList(kind)};
  }
  cgDDList(kind);
}
function cgDDList(kind){
  var panel=document.getElementById('ddPanel'+cgDDCap(kind));
  if(!panel||!panel.__built)return;
  var q=(panel.__q||'').toLowerCase();
  var opts=cgDDOpts[kind].filter(function(o){return !q||o.v.toLowerCase().indexOf(q)>=0});
  var arr=cgDDSel[kind],limit=cgDDLimit[kind],full=arr.length>=limit;
  var items=opts.map(function(o){
    var on=arr.indexOf(o.v)>=0;
    return '<label class="cp-dd-item"><input type="checkbox" '+(on?'checked':'')+(full&&!on?' disabled':'')+' data-v="'+esc(o.v)+'"><span>'+esc(o.v)+'</span><span class="cp-dd-n">'+o.ne+'</span></label>';
  }).join('');
  if(!opts.length)items='<div class="cp-dd-empty">无匹配选项</div>';
  panel.querySelector('.cp-dd-list').innerHTML=items+(full?'<div class="cp-dd-note">最多 '+limit+' 项，取消一项可继续</div>':'');
  panel.querySelectorAll('.cp-dd-list input').forEach(function(cb){cb.onchange=function(){cgToggleVal(kind,cb.dataset.v,cb.checked)}});
}
function cgToggleVal(kind,v,on){
  var arr=cgDDSel[kind],i=arr.indexOf(v);
  if(on&&i<0&&arr.length<cgDDLimit[kind])arr.push(v);
  if(!on&&i>=0)arr.splice(i,1);
  cgDDSum(kind);cgDDList(kind);
}
function cgDDSum(kind){
  var el=document.getElementById('ddSum'+cgDDCap(kind));
  if(!el)return;
  var arr=cgDDSel[kind];
  el.textContent=arr.length?('：'+arr.slice(0,2).join(',')+(arr.length>2?' 等'+arr.length+'项':'')):'';
}
document.querySelectorAll('.cp-dd-btn').forEach(function(btn){
  btn.onclick=function(ev){ev.stopPropagation();var dd=btn.parentElement,was=dd.classList.contains('open');document.querySelectorAll('.cp-dd.open').forEach(function(o){o.classList.remove('open')});if(!was)dd.classList.add('open')};
});
document.addEventListener('click',function(ev){if(!(ev.target.closest&&ev.target.closest('.cp-dd')))document.querySelectorAll('.cp-dd.open').forEach(function(o){o.classList.remove('open')})});
function cgDDApply(kind,val){
  var arr=Array.isArray(val)?val.slice():(typeof val==='string'&&val.trim()?val.split(',').map(function(s){return s.trim()}).filter(Boolean):[]);
  // A saved group can hold a value today's data no longer has; keep it visible
  // instead of silently dropping it from the selection.
  arr.forEach(function(v){if(v&&!cgDDOpts[kind].some(function(o){return o.v===v}))cgDDOpts[kind].push({v:v,n:0,ne:0})});
  cgDDSel[kind]=arr;
  cgDDRender(kind);cgDDSum(kind);
}
function loadFilterOptions(){
  if(cgDDState==='ready')return Promise.resolve();
  return api('/admin/api/customers/filter-options?facets=countries,segments,products,keywords').then(function(d){
    cgDDKinds.forEach(function(k){cgDDOpts[k]=d[k]||[]});
    cgDDState='ready';
    cgDDKinds.forEach(function(k){cgDDRender(k);cgDDSum(k)});
    if(cgPendingDD){var p=cgPendingDD;cgPendingDD=null;Object.keys(p).forEach(function(k){cgDDApply(k,p[k])})}
  }).catch(function(){cgDDState='error';cgDDKinds.forEach(cgDDRender)});
}
function cgFilters(){
  var min=Number(document.getElementById('cgMinScore').value)||0;
  var icp=Number(document.getElementById('cgIcpFloor').value)||0;
  return {countries:cgDDSel.countries.join(','),segments:cgDDSel.segments.join(','),products:cgDDSel.products.join(','),keywords:cgDDSel.keywords.join(','),min_lead_score:min,exclude_sent:document.getElementById('cgExcludeSent').checked,customer_ids:cgPickedIds,has_buying_signal:document.getElementById('cgHasSignal').checked,dimension_floors:icp>0?{icp_fit:icp}:{},per_person:document.getElementById('cgPerPerson').checked,persona_roles:document.getElementById('cgPersonaRoles').value.trim(),role_priority:document.getElementById('cgRolePriority').value.trim(),contacts_per_company:Number(document.getElementById('cgContactsPer').value)||1};
}
function cgSetFilters(f){
  f=f||{};
  var ms=document.getElementById('cgMinScore'),mv=String(f.min_lead_score||'');
  if(mv&&!ms.querySelector('option[value="'+mv+'"]')){var o=document.createElement('option');o.value=mv;o.textContent='最低分 ≥'+mv;ms.appendChild(o)}
  ms.value=mv;
  document.getElementById('cgExcludeSent').checked=f.exclude_sent!==false;
  document.getElementById('cgHasSignal').checked=f.has_buying_signal===true;
  document.getElementById('cgPerPerson').checked=f.per_person===true;
  document.getElementById('cgPersonaRoles').value=Array.isArray(f.persona_roles)?f.persona_roles.join(','):(typeof f.persona_roles==='string'?f.persona_roles:'');
  document.getElementById('cgRolePriority').value=Array.isArray(f.role_priority)?f.role_priority.join(','):(typeof f.role_priority==='string'?f.role_priority:'');
  var cp=document.getElementById('cgContactsPer'),cpv=String(f.contacts_per_company||1);
  if(!cp.querySelector('option[value="'+cpv+'"]'))cpv='1';
  cp.value=cpv;
  var icpf=document.getElementById('cgIcpFloor'),iv=String((f.dimension_floors&&f.dimension_floors.icp_fit)||'');
  if(iv&&!icpf.querySelector('option[value="'+iv+'"]')){var io=document.createElement('option');io.value=iv;io.textContent='ICP 匹配 ≥'+iv;icpf.appendChild(io)}
  icpf.value=iv;
  cgPickedIds=Array.isArray(f.customer_ids)?f.customer_ids.slice():[];
  cgRenderPicked();
  var dd={countries:f.countries,segments:f.segments,products:f.products,keywords:f.keywords};
  if(cgDDState!=='ready'){cgPendingDD=dd}else{Object.keys(dd).forEach(function(k){cgDDApply(k,dd[k])})}
}
function cgRenderPicked(){
  document.getElementById('cgPicked').textContent=cgPickedIds.length?('已选 '+cgPickedIds.length+' 家：'+cgPickedIds.slice(0,20).join(', ')+(cgPickedIds.length>20?' …':'')):'未勾选';
}
/* 海选过滤器「写开发信」落地：URL 带 prefill=1 时自动切到定向群发 tab
   并带入筛选条件。下拉值经 cgPendingDD 缓存，等筛选项加载完成后自动
   生效（cgSetFilters 内建该机制）；has_email 参数在此忽略——群发统计
   本就要求可触达（按联系人发送时为联系人有邮箱）。 */
(function(){
  var q=new URLSearchParams(location.search);
  if(q.get('prefill')!=='1')return;
  var f={};
  ['countries','segments','products'].forEach(function(k){var v=q.get(k);if(v)f[k]=v});
  var m=q.get('min_lead_score');if(m&&Number(m)>0)f.min_lead_score=Number(m);
  if(q.get('has_buying_signal')==='1')f.has_buying_signal=true;
  var pr=q.get('persona_roles');if(pr)f.persona_roles=pr;
  var tab=document.querySelector('.tab[data-tab="campaign"]');if(tab)tab.click();
  cgSetFilters(f);
  showMsg('cgMsg','✅ 已带入海选过滤器的筛选条件：选好品牌点「统计客群」预览，再「创建群发任务」生成分批开发信',true);
})();
/* Persona-role datalist: persona_roles and role_priority both match the
   stored persona_role values EXACTLY, so the inputs offer what exists
   (counts included once a value is picked). Fail-soft: an empty datalist
   just leaves free-text entry, which was the Stage 51 status quo. */
function loadPersonaRoleOptions(){
  api('/admin/api/persona-roles').then(function(d){
    var dl=document.getElementById('dlPersonaRoles');
    dl.innerHTML='';
    (d.roles||[]).forEach(function(r){
      var o=document.createElement('option');
      o.value=r.persona_role;
      o.textContent=r.n+' 家客户';
      dl.appendChild(o);
    });
  }).catch(function(){});
}
function loadCampaignBrand(){
  api('/admin/api/outreach/settings').then(function(d){
    var sel=document.getElementById('cgBrand'),cur=sel.value;
    sel.innerHTML='';
    d.settings.forEach(function(b){
      var o=document.createElement('option');
      o.value=b.brand_name;o.textContent=b.brand_name+' ('+b.product_category+')'+(b.enabled?'':' ⚠️未启用');
      sel.appendChild(o);
    });
    // Default to the first ENABLED brand: an unconfigured brand cannot
    // generate or send, so defaulting to it would only produce errors.
    var en=d.settings.filter(function(b){return b.enabled});
    if(en.length){
      var still=d.settings.some(function(b){return b.brand_name===cur&&b.enabled});
      if(!still)sel.value=en[0].brand_name;
    }
  }).catch(function(){});
}
function loadGroups(){
  return api('/admin/api/outreach/groups').then(function(d){
    var sel=document.getElementById('cgGroup'),cur=sel.value;
    sel.innerHTML='<option value="">— 不使用已保存客群 —</option>';
    d.groups.forEach(function(g){var o=document.createElement('option');o.value=g.id;o.textContent=g.name;sel.appendChild(o)});
    sel.value=cur;
    document.getElementById('cgDeleteGroup').style.display=cur?'inline-block':'none';
  });
}
document.getElementById('cgGroup').onchange=function(){document.getElementById('cgDeleteGroup').style.display=this.value?'inline-block':'none'};
document.getElementById('cgLoadGroup').onclick=function(){
  var id=document.getElementById('cgGroup').value;
  if(!id){showToast('请先选择要载入的客群',false);return}
  api('/admin/api/outreach/groups').then(function(d){
    var g=d.groups.filter(function(x){return String(x.id)===String(id)})[0];
    if(!g){showToast('客群不存在',false);return}
    cgSetFilters(JSON.parse(g.filters));
    showMsg('cgMsg','✅ 已载入客群「'+g.name+'」的筛选条件，可直接统计预览',true);
  }).catch(function(e){showMsg('cgMsg','❌ '+e.message,false)});
};
document.getElementById('cgDeleteGroup').onclick=function(){
  var id=document.getElementById('cgGroup').value;
  if(!id||!confirm('确定删除该客群？（已创建的群发任务不受影响）'))return;
  api('/admin/api/outreach/groups/'+id,{method:'DELETE'}).then(function(){showToast('客群已删除',true);loadGroups()}).catch(function(e){showToast(e.message,false)});
};
document.getElementById('cgSaveGroup').onclick=function(){
  var name=document.getElementById('cgGroupName').value.trim();
  if(!name){showMsg('cgMsg','❌ 请填写客群名称',false);return}
  api('/admin/api/outreach/groups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,filters:cgFilters()})})
    .then(function(){document.getElementById('cgGroupName').value='';showMsg('cgMsg','✅ 客群已保存，可随时载入复用',true);return loadGroups()})
    .catch(function(e){showMsg('cgMsg','❌ '+e.message,false)});
};
document.getElementById('cgPreview').onclick=function(){
  var btn=this;btn.disabled=true;btn.textContent='⏳ 统计中…';
  var pp=document.getElementById('cgPerPerson').checked;
  api('/admin/api/outreach/segment-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({brand:document.getElementById('cgBrand').value,filters:cgFilters()})})
    .then(function(d){
      var box=document.getElementById('cgPreviewBox');
      var n=Number(document.getElementById('cgContactsPer').value)||1;
      var countries=(d.by_country||[]).map(function(c){return esc(c.country||'（未知国家）')+' ×'+c.n}).join('　');
      var rows=(d.sample||[]).map(function(c){return '<tr><td>'+esc(c.display_id||c.id)+'</td><td>'+esc(c.company_name||'-')+'</td><td>'+esc(c.country||'-')+'</td><td>'+(c.lead_score==null?'—':c.lead_score)+'</td><td>'+esc((c.customer_segment||'-').slice(0,26))+'</td><td>'+esc((c.email||'-').slice(0,30))+'</td><td>'+(c.has_draft?'📄 已有草稿':'待生成')+'</td></tr>'}).join('');
      box.innerHTML='<div class="s-bgf0fdfa-bd1 ol 99f6e4-br10-p14">'
        +'<div class="s-fs15-fw700-c0f766e">匹配 '+d.matching+' 家客户'+(pp?'（按联系人：只计有带邮箱联系人的公司）':'')+'</div>'
        +'<div class="s-fs13-c475569-mt4">其中 <b>'+d.already+'</b> 家'+(pp?'的目标公司':'')+'该品牌已有开发信（直接沿用，不再花 AI 费用），<b>'+d.pending+'</b> 家需要生成</div>'
        +(pp&&n>1?'<div class="s-fs13-c475569-mt4">共 <b>'+(d.slots==null?d.matching:d.slots)+'</b> 个联系人触点（每公司至多 '+n+' 个），其中 <b>'+(d.slots_covered==null?d.already:d.slots_covered)+'</b> 个该品牌已有开发信，<b>'+((d.slots==null?d.matching:d.slots)-(d.slots_covered==null?d.already:d.slots_covered))+'</b> 个需要生成</div>':'')
        +(countries?'<div class="s-fs12-c6b7280-mt6">国家分布：'+countries+'</div>':'')
        +(rows?'<table class="cp-table"><thead><tr><th>客户ID</th><th>公司</th><th>国家</th><th>评分</th><th>细分</th><th>邮箱</th><th>开发信</th></tr></thead><tbody>'+rows+'</tbody></table><div class="cp-hint">仅预览前 20 家（按评分优先）</div>':'')
        +'</div>';
    })
    .catch(function(e){document.getElementById('cgPreviewBox').innerHTML='<div class="s-red13">❌ '+esc(e.message)+'</div>'})
    .finally(function(){btn.disabled=false;btn.textContent='🔍 统计客群'});
};
/* 手工勾选客户：reuses the customer list API so the picker searches the same
   data the 客户管理 screen shows. */
document.getElementById('cgPickSearchBtn').onclick=function(){
  var q=document.getElementById('cgPickSearch').value.trim();
  if(!q){showMsg('cgMsg','❌ 请输入搜索关键词',false);return}
  var p=new URLSearchParams({q:q,status:'completed',limit:'30',offset:'0'});
  api('/admin/api/customers?'+p.toString()).then(function(d){
    var box=document.getElementById('cgPickResults');
    if(!d.items.length){box.innerHTML='<div class="cp-hint">没有匹配的客户</div>';return}
    box.innerHTML='<table class="cp-table"><thead><tr><th class="s-w36">选</th><th>客户ID</th><th>公司</th><th>国家</th><th>邮箱</th></tr></thead><tbody>'
      +d.items.map(function(c){
        var on=cgPickedIds.indexOf(c.id)>=0;
        return '<tr><td class="s-tac"><input type="checkbox" data-id="'+c.id+'"'+(on?' checked':'')+'></td><td>'+esc(c.display_id||c.id)+'</td><td>'+esc(c.company_name||'-')+'</td><td>'+esc(c.country||'-')+'</td><td>'+esc((c.email||'（无邮箱）').slice(0,32))+'</td></tr>';
      }).join('')+'</tbody></table>';
    box.querySelectorAll('input[type=checkbox]').forEach(function(cb){
      cb.onchange=function(){
        var id=Number(cb.dataset.id),i=cgPickedIds.indexOf(id);
        if(cb.checked){if(i<0)cgPickedIds.push(id)}else if(i>=0)cgPickedIds.splice(i,1);
        cgRenderPicked();
      };
    });
  }).catch(function(e){document.getElementById('cgPickResults').innerHTML='<div class="s-red13">❌ '+esc(e.message)+'</div>'});
};
document.getElementById('cgClearPicked').onclick=function(){cgPickedIds=[];cgRenderPicked();document.getElementById('cgPickResults').innerHTML=''};
cgRenderPicked();
document.getElementById('cgPickSearch').onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();document.getElementById('cgPickSearchBtn').onclick()}};

document.getElementById('cgCreate').onclick=function(){
  var brand=document.getElementById('cgBrand').value;
  var gid=document.getElementById('cgGroup').value;
  var name=document.getElementById('cgName').value.trim();
  if(!brand){showMsg('cgMsg','❌ 请选择品牌',false);return}
  if(!confirm('将为「'+brand+'」创建一个群发任务。\\n\\n创建时会按当前筛选条件把客户名单快照进任务，之后按批次生成和发送。\\n\\n确定继续？'))return;
  var btn=this;btn.disabled=true;btn.textContent='⏳ 创建中…';
  var payload=gid?{brand:brand,group_id:Number(gid),name:name||null}:{brand:brand,name:name||null,filters:cgFilters()};
  api('/admin/api/outreach/campaigns',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(function(d){
      var pp=document.getElementById('cgPerPerson').checked;
      var cpn=Number(document.getElementById('cgContactsPer').value)||1;
      var msg;
      if(pp&&typeof d.companies==='number'){
        msg='✅ 群发任务已创建：匹配 '+d.companies+' 家公司，定向 '+d.total+' 个联系人'
          +(d.companies>d.total?'（'+(d.companies-d.total)+' 家公司没有带邮箱的联系人，已跳过）':'')
          +(d.capped?'（超过单任务上限，已截取）':'')
          +'。每家公司按角色优先级取至多 '+cpn+' 个有邮箱联系人'+(cpn>1?'；建议错开批次发送，避免同公司同日多封':'')+'。点「生成草稿」开始分批生成。';
      }else{
        msg='✅ 群发任务已创建：共 '+d.total+' 家客户'+(d.capped?'（超过单任务上限，已截取评分最高的 '+d.total+' 家）':'')+'。点「生成草稿」开始分批生成。';
      }
      showMsg('cgMsg',msg,true);showToast('群发任务已创建',true);
      document.getElementById('cgName').value='';
      loadCampaigns();
    })
    .catch(function(e){showMsg('cgMsg','❌ '+e.message,false)})
    .finally(function(){btn.disabled=false;btn.textContent='🚀 创建群发任务'});
};
function cgBar(c){
  var t=c.total||1;
  var seg=function(n,cls){return n?'<div class="cp-seg '+cls+'" data-w="'+(n/t*100)+'"></div>':''};
  return '<div class="cp-bar">'+seg(c.sent,'cp-sent')+seg(c.generated,'cp-generated')+seg(c.pending,'cp-pending')+seg(c.failed,'cp-failed')+'</div>'
    +'<div class="cp-legend"><span><i class="cp-sent"></i>已发送 '+c.sent+'</span><span><i class="cp-generated"></i>待发送 '+c.generated+'</span><span><i class="cp-pending"></i>待生成 '+c.pending+'</span><span><i class="cp-failed"></i>失败 '+c.failed+'</span>'
    +(c.skipped?'<span>跳过 '+c.skipped+'</span>':'')+'<span>共 '+c.total+'</span></div>';
}
function loadCampaigns(){
  return Promise.all([
    api('/admin/api/outreach/campaigns'),
    api('/admin/api/outreach/quota').catch(function(){return null})
  ]).then(function(res){
    var campaigns=res[0].campaigns||[],q=res[1];
    if(q)document.getElementById('cgQuota').textContent='📧 Gmail 今日 '+q.sent_today+'/'+q.daily_limit+'，剩余 '+q.remaining;
    var box=document.getElementById('cgList');
    if(!campaigns.length){box.innerHTML='<div class="panel"><p class="s-gray0">还没有群发任务。用上面的筛选条件统计客群 → 创建群发任务。</p></div>';return}
    box.innerHTML=campaigns.map(function(c){
      var state=c.done?'<span class="badge badge-sent">已完成</span>':(c.status==='paused'?'<span class="badge badge-draft">已暂停</span>':'<span class="badge s-bgdbeafe-c1e40af" >进行中</span>');
      var auto=c.auto_advance?' <span class="cp-chip">⚡ 自动推进</span>':'';
      var err=c.last_error?'<div class="s-fs12-cb91c1c-mt6">最近错误：'+esc(c.last_error)+'</div>':'';
      var canGen=c.pending>0,canSend=c.generated>0;
      return '<div class="cp-card'+(c.done?' done':'')+'">'
        +'<div class="s-between">'
         +'<div><b class="s-fs15">'+esc(c.name)+'</b> <span class="cp-chip">'+esc(c.brand_name)+'</span> '+state+auto
        +'<div class="cp-hint s-m2 0" >创建于 '+esc(c.created_at||'')+(c.group_id?' · 来自已保存客群':'')+'</div></div>'
        +'<div class="s-dfx-g6-aic-fxww">'
        +'<button class="btn btn-sm btn-secondary cg-gen" data-id="'+c.id+'"'+(canGen&&!c.done?'':' disabled cg-off')+'>🤖 生成草稿</button>'
        +'<button class="btn btn-sm btn-primary cg-send" data-id="'+c.id+'"'+(canSend&&!c.done?'':' disabled cg-off')+'>📤 继续发送</button>'
        +'<button class="btn btn-sm '+(c.status==='paused'?'btn-primary':'btn-secondary')+' cg-pause" data-id="'+c.id+'" data-status="'+esc(c.status)+'"'+(c.done?' disabled cg-off':'')+'>'+(c.status==='paused'?'▶ 恢复':'⏸ 暂停')+'</button>'
        +'<button class="btn btn-sm '+(c.auto_advance?'btn-primary':'btn-secondary')+' cg-auto" data-id="'+c.id+'" data-on="'+(c.auto_advance?1:0)+'"'+(c.done?' disabled cg-off':'')+'>⚡ 自动推进</button>'
        +'<button class="btn btn-sm btn-secondary cg-members" data-id="'+c.id+'">名单</button>'
        +'<button class="btn btn-sm btn-danger cg-del" data-id="'+c.id+'">删除</button>'
        +'</div></div>'+cgBar(c)+err+'</div>';
    }).join('');
    box.querySelectorAll('.cp-seg').forEach(function(el){el.style.width=el.getAttribute('data-w')+'%'});
    box.querySelectorAll('.cg-gen').forEach(function(b){b.onclick=function(){
      var id=b.dataset.id,limit=Number(document.getElementById('cgBatch').value);
      if(cgBusy[id])return;
      if(!confirm('为该任务分批生成开发信（每批 '+limit+' 家）。\\n\\n生成只针对「尚无该品牌开发信」的客户，每家调用一次 AI。'))return;
      cgBusy[id]=1;b.disabled=true;b.textContent='⏳ 生成中…';
      api('/admin/api/outreach/campaigns/'+id+'/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:limit})})
        .then(function(d){
          showToast('已处理 '+d.processed+' 家：新生成 '+d.generated+'，沿用已有 '+d.skipped+'，失败 '+d.failed+'（剩余 '+d.remaining+'）',d.failed===0);
          cgBusy[id]=0;loadCampaigns();
        })
        .catch(function(e){showToast(e.message,false);cgBusy[id]=0;loadCampaigns()});
    }});
    box.querySelectorAll('.cg-send').forEach(function(b){b.onclick=function(){
      var id=b.dataset.id,limit=Number(document.getElementById('cgBatch').value);
      if(cgBusy[id])return;
      if(!confirm('继续发送该任务的待发开发信（每批 '+limit+' 封），受今日 Gmail 配额限制。\\n\\n发送期间请勿关闭页面。'))return;
      cgBusy[id]=1;b.disabled=true;b.textContent='⏳ 发送中…';
      api('/admin/api/outreach/campaigns/'+id+'/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:limit})})
        .then(function(d){
          var fails=(d.results||[]).filter(function(r){return !r.ok});
          var qq=d.quota?('（今日 '+d.quota.sent_today+'/'+d.quota.daily_limit+'）'):'';
          // A quota stop is expected, not a failure: those members stay queued
          // for the next day, so say so instead of showing a red error.
          if(d.quotaStop){
            showMsg('cgMsg','⏸ 今日 Gmail 配额已用完（'+d.quota.sent_today+'/'+d.quota.daily_limit+'）。本批已发 '+d.generated+' 封，剩余 '+d.remaining+' 封保留在队列中，明天点「继续发送」即可接着发。',true);
            showToast('配额已满，剩余 '+d.remaining+' 封明天续发',true);
            cgBusy[id]=0;loadCampaigns();
            return;
          }
          showToast('发送完成：成功 '+d.generated+' 封，失败 '+d.failed+' 封，剩余 '+d.remaining+qq,d.failed===0);
          if(fails.length)alert('前 3 条失败原因：\\n'+fails.slice(0,3).map(function(f){return '#'+f.customer_id+': '+f.error}).join('\\n'));
          cgBusy[id]=0;loadCampaigns();
        })
        .catch(function(e){showToast(e.message,false);cgBusy[id]=0;loadCampaigns()});
    }});
    box.querySelectorAll('.cg-del').forEach(function(b){b.onclick=function(){
      var id=b.dataset.id;
      if(!confirm('删除该群发任务？\\n\\n已发送的邮件无法撤回；已生成的草稿会保留在「开发信列表」中。'))return;
      api('/admin/api/outreach/campaigns/'+id,{method:'DELETE'}).then(function(){showToast('任务已删除',true);loadCampaigns()}).catch(function(e){showToast(e.message,false)});
    }});
    box.querySelectorAll('.cg-pause').forEach(function(b){b.onclick=function(){
      var id=b.dataset.id,paused=b.dataset.status==='paused';
      if(!paused&&!confirm('暂停该群发任务？\\n\\n暂停后不能生成或发送；已发出的邮件无法撤回。'))return;
      api('/admin/api/outreach/campaigns/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:paused?'draft':'paused'})})
        .then(function(){showToast(paused?'已恢复':'已暂停',true);loadCampaigns()})
        .catch(function(e){showToast(e.message,false)});
    }});
    box.querySelectorAll('.cg-auto').forEach(function(b){b.onclick=function(){
      var id=b.dataset.id,on=b.dataset.on==='1';
      var msg=on
        ?'停用该任务的自动推进？\\n\\n停用后系统不再自动生成/发送；已生成的草稿和已发出的邮件不受影响。'
        :'开启自动推进？\\n\\n系统会在调研空闲时每 5 分钟自动生成并发送一小批（各 5 封/次，受 Gmail 每日配额限制），无需保持页面打开。\\n\\n⚠️ 草稿将不经人工审阅直接发送；已暂停的任务需先点「恢复」。';
      if(!confirm(msg))return;
      api('/admin/api/outreach/campaigns/'+id+'/auto',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:!on})})
        .then(function(){showToast(on?'已停用自动推进':'已开启自动推进',true);loadCampaigns()})
        .catch(function(e){showToast(e.message,false)});
    }});
    box.querySelectorAll('.cg-members').forEach(function(b){b.onclick=function(){cgShowMembers(b.dataset.id)}});
  }).catch(function(e){
    document.getElementById('cgList').innerHTML='<div class="panel"><p class="s-cdc2626-m0">❌ '+esc(e.message)+'</p></div>';
  });
}
function cgShowMembers(id){
  var box=document.getElementById('cgList');
  api('/admin/api/outreach/campaigns/'+id+'/members?limit=200').then(function(d){
    var LBL={pending:'待生成',generated:'待发送',sent:'已发送',skipped:'跳过',failed:'失败'};
    // The campaign's grain travels in its filters JSON (§2.2): only a
    // per-person campaign gets the contact column.
    var pp=false;try{pp=(JSON.parse((d.campaign&&d.campaign.filters)||'{}')||{}).per_person===true}catch(e){}
    var rows=(d.items||[]).map(function(m){
      var contact=pp
        ? '<td>'+esc(((m.contact_first_name||'')+' '+(m.contact_last_name||'')).trim()||m.contact_ref||'-')
          +(m.contact_title?'<div class="cp-hint">'+esc(m.contact_title)+'</div>':'')
          +(m.contact_email?'<div class="cp-hint">'+esc(m.contact_email)+'</div>':'')+'</td>'
        : '';
      return '<tr><td>'+esc(m.display_id||m.customer_id)+'</td><td>'+esc(m.company_name||'-')+'</td>'+contact+'<td>'+esc(m.country||'-')+'</td>'
        +'<td>'+esc((m.email_to||'-').slice(0,30))+'</td><td><span class="cp-chip">'+(LBL[m.status]||esc(m.status))+'</span></td>'
        +'<td class="'+(m.status==='failed'?'mo-fail':'mo-ok')+'">'+esc((m.error||'').slice(0,60))+'</td></tr>';
    }).join('');
    var head='<div class="panel s-bgf8fafc" ><div class="s-dfx-jcb-aic"><b>任务 #'+id+' 名单（'+d.campaign.name+'，共 '+d.campaign.total+(pp?' 个联系人':' 家')+'）</b><button class="btn btn-sm btn-secondary cg-close-members">关闭</button></div>'
      +(rows?'<table class="cp-table"><thead><tr><th>客户ID</th><th>公司</th>'+(pp?'<th>联系人</th>':'')+'<th>国家</th><th>收件人</th><th>状态</th><th>备注</th></tr></thead><tbody>'+rows+'</tbody></table>':'<p class="cp-hint">名单为空</p>')
      +'<div class="cp-hint">最多显示 200 家。</div></div>';
    box.innerHTML=head+box.innerHTML;
    box.querySelector('.cg-close-members').onclick=loadCampaigns;
  }).catch(function(e){showToast(e.message,false)});
}
document.getElementById('cgRefresh').onclick=function(){loadCampaigns();loadQuota()};

// Init
loadBrands();
})();
</script></body></html>`;

/* ── Dynamic key-pool panel (方案B: D1 api_configs CRUD) ── */
const KEYS_PANEL_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>动态 Key 池 - CRM</title><style>
body{font-family:system-ui,sans-serif;margin:0;background:#f3f5f9;color:#1f2430}
.top{background:#1f2430;color:#fff;padding:14px 24px;display:flex;justify-content:space-between;align-items:center}
.top h1{font-size:18px;margin:0}
.top a{color:#fff;text-decoration:none;background:rgba(255,255,255,.15);padding:8px 14px;border-radius:8px;font-weight:600;font-size:14px}
.wrap{max-width:960px;margin:24px auto;padding:0 16px}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:20px;margin-bottom:20px}
h2{font-size:16px;margin:0 0 12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.field label{font-size:12px;color:#5a6270;display:block;margin-bottom:3px}
.field input,.field select{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #ccd2dd;border-radius:6px;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f0f2f7;padding:8px;text-align:left;font-size:12px;color:#5a6270}
td{padding:8px;border-bottom:1px solid #eef1f6}
tr.inactive td{opacity:.5}
.cdtag{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:10px;background:#fef3c7;color:#92400e;font-size:12px}
.btn{border:0;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px;font-weight:600}
.btn.on{background:#3f9d63;color:#fff}.btn.off{background:#8b93a3;color:#fff}.btn.del{background:#fde8e8;color:#b23b3b}
#toast{position:fixed;top:18px;right:18px;background:#1f2430;color:#fff;padding:10px 16px;border-radius:8px;font-size:14px;display:none;max-width:420px;z-index:9}
#toast.err{background:#b23b3b}
.hint{font-size:12px;color:#7a8291;margin-top:6px}

/* stage30 auto: inline style -> class */
.s-num{text-align:right;padding:4px 8px}
.s-muted{color:#6b7280;margin:4px 0}
.s-mw130{min-width:130px}
.s-hint12{font-size:12px;color:#6b7280}
.s-ok{color:#16a34a;margin:4px 0}
.s-btnlg{padding:9px 22px}
.s-scrollx{overflow-x:auto}
.s-mw90{min-width:90px}
.s-faint2{color:#9ca3af}
.s-pad48{padding:4px 8px}
.s-cdc2626{color:#dc2626}
.s-w100-ffmono-fs13{width:100%;font-family:monospace;font-size:13px}
.s-mt6-dfx-g8-fxww-aic{margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.s-fs11-c94a3b8-fw400{font-size:11px;color:#94a3b8;font-weight:400}
.s-cb23b3b-m4 0{color:#b23b3b;margin:4px 0}
.s-ml8{margin-left:8px}
.s-bgfee2e2-c991b1b{background:#fee2e2;color:#991b1b}
.s-w100-bordercollapsecollape-fs13{width:100%;border-collapse:collapse;font-size:13px}
.s-tal-p4 8{text-align:left;padding:4px 8px}
.s-bge5e7eb-br6-h10-w110-posrel{background:#e5e7eb;border-radius:6px;height:10px;width:110px;position:relative}
.s-fs11-c6b7280{font-size:11px;color:#6b7280}
.s-bdt1 ol f1f5f9{border-top:1px solid #f1f5f9}
.s-cdc2626-fs11{color:#dc2626;font-size:11px}
.s-fs12-c6b7280-m6 0 0{font-size:12px;color:#6b7280;margin:6px 0 0}
.s-fs12-c059669-m6 0 0{font-size:12px;color:#059669;margin:6px 0 0}
.s-w200{width:200px}
.s-w160{width:160px}
/* stage30: dynamic-variant classes (usage bar) */
.pb-fill{border-radius:6px;height:10px}
.pb-hot{background:#dc2626}.pb-warm{background:#f59e0b}.pb-ok{background:#16a34a}
</style></head><body>
<header class="top"><h1>⚡ 动态 Key 池（D1 即时生效，无需部署）</h1><a href="/admin">← 返回客户管理</a></header>
<div class="wrap">
<div class="card"><h2>➕ 添加 Key</h2>
  <div class="grid">
    <div class="field"><label>平台</label><select id="nkProvider">
      <option value="gemini">Gemini</option><option value="groq">Groq</option><option value="cerebras">Cerebras</option>
      <option value="zhipu">Zhipu GLM</option><option value="nvidia">NVIDIA NIM</option><option value="amd">AMD Radeon</option><option value="mistral">Mistral</option>
      <option value="deepseek">DeepSeek</option><option value="openrouter">OpenRouter</option>
      <option value="tavily">Tavily 搜索</option><option value="exa">Exa 搜索</option><option value="searlo">Searlo 搜索</option>
    </select></div>
    <div class="field"><label>备注</label><input id="nkLabel" placeholder="如: 账号2"></div>
    <div class="field"><label>API Key</label><input id="nkKey" autocomplete="off"></div>
    <div class="field"><label>单Key RPM (留空=默认)</label><input id="nkRpm" type="number" min="1"></div>
    <div class="field"><label>模型覆盖 (留空=默认)</label><input id="nkModel" placeholder="如 llama-3.3-70b"></div>
  </div>
  <p><button class="btn on s-btnlg" id="addKey" >添加 Key</button></p>
  <p class="hint">Key 池按 D1 优先解析：此处添加的 Key 立即生效（30 秒内全节点刷新）；env Secrets 仅作为引导后备。</p>
</div>
<div class="card"><h2>📦 批量导入（适合 Tavily/Exa 等大量 Key）</h2>
  <div class="grid">
    <div class="field"><label>平台</label><select id="bulkProvider">
      <option value="tavily">Tavily 搜索</option><option value="exa">Exa 搜索</option><option value="searlo">Searlo 搜索</option>
      <option value="gemini">Gemini</option><option value="groq">Groq</option><option value="cerebras">Cerebras</option>
      <option value="zhipu">Zhipu GLM</option><option value="nvidia">NVIDIA NIM</option><option value="amd">AMD Radeon</option><option value="mistral">Mistral</option>
      <option value="deepseek">DeepSeek</option><option value="openrouter">OpenRouter</option>
    </select></div>
    <div class="field"><label>备注前缀（自动编号）</label><input id="bulkLabel" placeholder="如: 账号 → 账号1、账号2…"></div>
    <div class="field"><label>统一模型覆盖 (留空=默认)</label><input id="bulkModel" placeholder="仅 AI 平台需要"></div>
    <div class="field"><label>统一单Key RPM (留空=默认)</label><input id="bulkRpm" type="number" min="1"></div>
  </div>
  <div class="field"><label>导入模板（每行一条：<b>API Key,备注/账号</b>；也支持 Tab 或 | 分隔，纯 Key 也可以）</label>
    <textarea id="bulkKeys" rows="8" autocomplete="off" spellcheck="false" class="s-w100-ffmono-fs13" placeholder="tvly-xxxxxxxx,账号1
tvly-yyyyyyyy,账号2
tvly-zzzzzzzz,账号3"></textarea>
    <div class="s-mt6-dfx-g8-fxww-aic">
      <span class="s-hint12">填充模板：</span>
      <button class="btn tpl" data-tpl="tavily" type="button">Tavily</button>
      <button class="btn tpl" data-tpl="exa" type="button">Exa</button>
      <button class="btn tpl" data-tpl="generic" type="button">通用</button>
      <span class="s-hint12">（覆盖 textarea 内容；分隔符可用英文逗号、Tab 或 | ）</span>
    </div>
  </div>
  <p><button class="btn on s-btnlg" id="bulkImport" >批量导入</button></p>
</div>
<div class="card" id="encCard"><h2>🔐 凭据加密</h2><div id="encBox"><p class="s-muted">加载中…</p></div></div>
<div class="card"><h2>🗝 已配置 Keys</h2><div class="s-scrollx"><table id="keysTable"><thead><tr><th>平台</th><th>备注</th><th>Key</th><th>RPM</th><th>模型</th><th>状态</th><th>最近错误</th><th>操作</th></tr></thead><tbody></tbody></table></div></div>
<div class="card"><h2>📊 本月用量（成功调用数，按自然月）<span class="s-fs11-c94a3b8-fw400"> v2026-09-09b</span></h2><div id="usageBox"><p class="s-muted">加载中…</p></div></div>
<div class="card"><h2>🧊 冷却中的 Key（429/限流自动暂停）</h2><div id="cooldownBox"></div></div>
<div class="card"><h2>📜 冷却历史（最近 20 条）</h2><div id="historyBox"></div></div>
<div class="card"><h2>⚙️ 平台设置（默认模型 / 总RPM / 启用）</h2><div id="settingsBox"></div></div>
</div>
<div id="toast"></div>
<script>
(function(){
var toastEl=document.getElementById('toast');
function toast(msg,err){toastEl.textContent=msg;toastEl.className=err?'err':'';toastEl.style.display='block';setTimeout(function(){toastEl.style.display='none'},4000)}
function api(p,o){return fetch(p,o||{}).then(function(r){if(r.status===401){location='/admin';throw new Error('登录过期')}return r.json().then(function(d){if(!r.ok)throw new Error(d.detail||'请求失败');return d})})}
var PROVIDER_NAMES={gemini:'Gemini',groq:'Groq',cerebras:'Cerebras',zhipu:'Zhipu',nvidia:'NVIDIA',amd:'AMD',mistral:'Mistral',deepseek:'DeepSeek',openrouter:'OpenRouter',tavily:'Tavily',exa:'Exa',brave:'Brave',searlo:'Searlo'};
// Stage 5: every DB-sourced string below (labels, model names, upstream
// last_error, key hints, provider keys) flows through esc() before touching
// innerHTML. Without this a hostile label or an upstream error string
// containing HTML became live script inside the panel.
var esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
function providerName(p){return esc(PROVIDER_NAMES[p]||p||'?')}
// 🔐 凭据加密卡片。
//
// States the operator has to act on, in order of urgency:
//   1. no key configured  → writes are refused, so they must set one first
//   2. key + cleartext    → the "一键加密" button, with a row count
//   3. key + none left    → done, state the residual risk plainly
function renderEncryption(enc){
  var box=document.getElementById('encBox');if(!box)return;
  var left=enc.plaintext_rows||0;
  var genBtn='<button class="btn" id="genEncKey" type="button">生成密钥</button>';
  if(!enc.configured){
    box.innerHTML='<p class="s-cb23b3b-m4 0"><b>⚠️ 未配置加密密钥 —— 新增/导入 Key 已被拒绝。</b></p>'+
      '<p class="hint">点「生成密钥」拿到 32 字节 base64 值，再把它作为 Worker Secret <code>CREDENTIAL_ENC_KEY</code> 保存（面板「🔑 凭据与密钥」页，或 <code>npx wrangler secret put CREDENTIAL_ENC_KEY</code>）。'+
      '保存后回到本页刷新即可。'+
      '<br><br><b>为什么必须先设：</b>密钥只存在于 Worker Secret，与面板 Token 同级保护 —— 拿到它的人本就能控制这个 Worker。'+
      '所以它挡不住面板被攻破，只挡「D1 单独泄露」（Cloudflare 凭据泄露、D1 导出、日志外泄）。'+
      '<br><b>务必先备份 D1</b>再加密：丢失这个密钥，存量 Key 将无法解密，只能重新申请。</p>'+
      '<p>'+genBtn+'</p>';
    document.getElementById('genEncKey').onclick=function(){
      api('/admin/api/keys/encryption-key',{method:'POST'}).then(function(d){
        var v=d.value||'';
        if(prompt('复制下面的值，并作为 CREDENTIAL_ENC_KEY 保存到 Worker Secret。\\n关闭后无法再次查看，请立即妥善保存：',v)===null)return;
        toast('已复制到剪贴板提示框。请确认已保存到 Worker Secret。');
      }).catch(function(e){toast(e.message,true)});
    };
    return;
  }
  var tail=left
    ?'<button class="btn on" id="doEncrypt" type="button">一键加密 '+left+' 条存量</button>'+
     '<span class="hint s-ml8" >就地改写，不可撤销。建议先 <code>npx wrangler d1 export</code> 备份。</span>'
    :'<span class="hint">全部 Key 已加密。</span>';
  box.innerHTML='<p class="s-ok">✔️ 加密密钥已配置'+(left?'，仍有 '+left+' 条为明文':'，无明文存量')+'。</p>'+
    '<p class="hint">表内 <code>api_key</code> 存 AES-GCM 密文；面板只显示加密前算好的 <code>key_hint</code>，D1 泄露拿不到可用凭据。'+
    '该密钥只存在于 Worker Secret，<b>没有备份就无法恢复</b>。</p><p>'+tail+'</p>';
  var encBtn=document.getElementById('doEncrypt');
  if(encBtn)encBtn.onclick=function(){
    if(!confirm('将就地加密 '+left+' 条明文 Key，不可撤销。\\n\\n确认已备份 D1 且已妥善保存 CREDENTIAL_ENC_KEY？'))return;
    encBtn.disabled=true;
    api('/admin/api/keys/encrypt-all',{method:'POST'}).then(function(r){
      toast('已加密 '+r.converted+' 条，剩余 '+(r.remaining===null?'?':r.remaining)+' 条'+(r.failed&&r.failed.length?('，失败 '+r.failed.length+' 条'):''));
      loadKeys();
    }).catch(function(e){toast(e.message,true);encBtn.disabled=false});
  };
}
function loadKeys(){
  api('/admin/api/keys').then(function(d){
    var tb=document.querySelector('#keysTable tbody');tb.innerHTML='';
    var cdMap={};
    (d.cooldowns||[]).forEach(function(c){
      var m=/^([a-z]+):(\\d+)$/.exec(c.key_index||'');
      if(m&&m[1]===c.provider)cdMap[Number(m[2])]=c;
    });
    renderEncryption(d.encryption||{});
    d.keys.forEach(function(k){
      var tr=document.createElement('tr');if(!k.is_active)tr.className='inactive';
      var cd=cdMap[k.id];
      var status=k.is_active?'启用':'停用';
      if(cd){var mins=Math.max(1,Math.round((new Date(cd.exhausted_until.replace(' ','T')+'Z')-Date.now())/60000));status+='<span class="cdtag">冷却中 ~'+mins+'分钟</span>';}
      var keyCell=esc(k.key_hint)+(k.encrypted?'':'<span class="cdtag s-bgfee2e2-c991b1b" >明文</span>');
      tr.innerHTML='<td>'+providerName(k.provider)+'</td><td>'+esc(k.label||'-')+'</td><td><code>'+keyCell+'</code></td><td>'+(k.rpm_limit||'默认')+'</td><td>'+esc(k.model||'-')+'</td><td>'+status+'</td><td>'+esc(k.last_error||'-')+'</td>';
      var td=document.createElement('td');
      var tog=document.createElement('button');tog.className='btn '+(k.is_active?'off':'on');tog.textContent=k.is_active?'停用':'启用';
      tog.onclick=function(){api('/admin/api/keys/'+k.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({is_active:!k.is_active})}).then(loadKeys).catch(function(e){toast(e.message,true)})};
      var del=document.createElement('button');del.className='btn del';del.textContent='删除';del.style.marginLeft='6px';
      del.onclick=function(){if(!confirm('确认删除该 Key？'))return;api('/admin/api/keys/'+k.id,{method:'DELETE'}).then(loadKeys).catch(function(e){toast(e.message,true)})};
      td.appendChild(tog);td.appendChild(del);tr.appendChild(td);tb.appendChild(tr);
    });
    api('/admin/api/keys/usage').then(function(u){
      var box=document.getElementById('usageBox');
      var list=u.usage||[];
      if(list.length===0){box.innerHTML='<p class="s-muted">本月暂无调用记录</p>';return;}
      var h='<div class="s-scrollx"><table class="s-w100-bordercollapsecollape-fs13"><thead><tr>'+
        '<th class="s-tal-p4 8">平台</th><th class="s-num">本月</th><th class="s-num">累计</th><th class="s-num">活动Key</th><th class="s-num">本月用过</th><th class="s-num">月容量(估算)</th><th class="s-num">消耗</th></tr></thead><tbody>';
      list.forEach(function(r){
        var pct=r.monthly_capacity?Math.min(100,Math.round(r.month_calls/r.monthly_capacity*100)):null;
        var bar=pct===null?'<span class="s-faint2">—</span>':'<div class="s-bge5e7eb-br6-h10-w110-posrel"><div class="pb-fill '+(pct>80?'pb-hot':pct>50?'pb-warm':'pb-ok')+'" data-w="'+pct+'"></div></div><span class="s-fs11-c6b7280">'+pct+'%</span>';
        h+='<tr class="s-bdt1 ol f1f5f9"><td class="s-pad48">'+providerName(r.provider)+'</td>'+
          '<td class="s-num">'+r.month_calls+'</td><td class="s-num">'+r.total_calls+'</td>'+
          '<td class="s-num">'+r.active_keys+(r.cooling_keys?(' <span class="s-cdc2626-fs11">(🧊'+r.cooling_keys+')</span>'):'')+'</td>'+
          '<td class="s-num">'+r.keys_used_this_month+'</td>'+
          '<td class="s-num">'+(r.monthly_capacity?r.monthly_capacity:'—')+'</td>'+
          '<td class="s-pad48">'+bar+'</td></tr>';
      });
      h+='</tbody></table></div><p class="s-fs12-c6b7280-m6 0 0">月容量按免费层估算：Tavily 500次深度搜索/Key、Exa ~2000次/Key；AI 平台无固定容量（取决于 token 混合）。Brave 已停用（免费档需绑卡）。</p>';
      var pc=d.precheck||{skipped_today:0,tokens_saved_estimate:0};
      if(pc.skipped_today>0){h+='<p class="s-fs12-c059669-m6 0 0">⚡ 免费预检今日已跳过 <b>'+pc.skipped_today+'</b> 家不相关客户，估算节省付费输入 token ~'+(pc.tokens_saved_estimate>=1000?(Math.round(pc.tokens_saved_estimate/1000)+'k'):pc.tokens_saved_estimate)+'（Workers AI Neurons，0 成本）</p>';}
      box.innerHTML=h;
      box.querySelectorAll('.pb-fill').forEach(function(el){el.style.width=el.getAttribute('data-w')+'%'});
    }).catch(function(){document.getElementById('usageBox').innerHTML='<p class="s-muted">用量数据不可用</p>'});
    var cdBox=document.getElementById('cooldownBox');
    var cdList=d.cooldowns||[];
    if(cdList.length===0){cdBox.innerHTML='<p class="s-ok">✓ 所有 Key 状态正常，无冷却中</p>';}
    else{
      cdBox.innerHTML='';
      cdList.forEach(function(c){
        var row=document.createElement('div');row.style.cssText='display:flex;gap:10px;align-items:center;margin:4px 0';
        var mins=Math.max(1,Math.round((new Date(c.exhausted_until.replace(' ','T')+'Z')-Date.now())/60000));
        row.innerHTML='<span class="s-mw90">'+providerName(c.provider)+'</span><code class="s-mw130">'+esc(c.key_index||'')+'</code><span class="s-cdc2626">'+esc(c.last_error||'限流')+'</span><span>剩余 ~'+mins+' 分钟</span>';
        var clr=document.createElement('button');clr.className='btn on';clr.textContent='清除';
        clr.onclick=function(){api('/admin/api/keys/cooldowns/'+c.provider,{method:'DELETE'}).then(loadKeys).catch(function(e){toast(e.message,true)})};
        row.appendChild(clr);cdBox.appendChild(row);
      });
    }
    var histBox=document.getElementById('historyBox');
    var histList=d.history||[];
    if(histList.length===0){histBox.innerHTML='<p class="s-muted">暂无历史记录</p>';}
    else{
      histBox.innerHTML='';
      histList.forEach(function(c){
        var row=document.createElement('div');row.style.cssText='display:flex;gap:10px;align-items:center;margin:4px 0;color:#6b7280;font-size:13px';
        var until='';
        try{until=new Date(c.exhausted_until.replace(' ','T')+'Z').toLocaleString();}catch(e){until=c.exhausted_until||'';}
        row.innerHTML='<span class="s-mw90">'+providerName(c.provider)+'</span><code class="s-mw130">'+esc(c.key_index||'')+'</code><span class="s-cdc2626">'+esc(c.last_error||'限流')+'</span><span>冷却至 '+esc(until)+'</span>';
        histBox.appendChild(row);
      });
    }
    var sb=document.getElementById('settingsBox');sb.innerHTML='';
    var sMap={};(d.settings||[]).forEach(function(s){sMap[s.provider]=s});
    Object.keys(PROVIDER_NAMES).forEach(function(p){
      var s=sMap[p]||{};
      var row=document.createElement('div');row.style.cssText='display:flex;gap:10px;align-items:end;margin-bottom:8px;flex-wrap:wrap';
      row.innerHTML='<div class="field"><label>'+PROVIDER_NAMES[p]+' 默认模型</label><input id="m_'+p+'" value="'+esc(s.default_model||'')+'" class="s-w200"></div>'+
        '<div class="field"><label>总RPM (留空=按Key数推算)</label><input id="r_'+p+'" type="number" min="1" value="'+esc(s.rpm_total||'')+'" class="s-w160"></div>';
      var en=document.createElement('div');en.className='field';en.innerHTML='<label>启用</label>';
      var cb=document.createElement('input');cb.type='checkbox';cb.id='e_'+p;cb.checked=s.enabled===undefined?true:!!s.enabled;en.appendChild(cb);row.appendChild(en);
      var btn=document.createElement('button');btn.className='btn on';btn.textContent='保存';
      btn.onclick=function(){api('/admin/api/keys/settings/'+p,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({default_model:document.getElementById('m_'+p).value,rpm_total:document.getElementById('r_'+p).value||null,enabled:cb.checked})}).then(function(){toast(PROVIDER_NAMES[p]+' 设置已保存')}).catch(function(e){toast(e.message,true)})};
      row.appendChild(btn);sb.appendChild(row);
    });
  }).catch(function(e){toast(e.message,true)});
}
var TPL={
  tavily:'tvly-你的APIKey1,账号1\\ntvly-你的APIKey2,账号2\\ntvly-你的APIKey3,账号3',
  exa:'exa-你的APIKey1,账号1\\nexa-你的APIKey2,账号2\\nexa-你的APIKey3,账号3',
  brave:'Brave-APIKey1,账号1\\nBrave-APIKey2,账号2\\nBrave-APIKey3,账号3',
  generic:'API-Key-1,账号1\\nAPI-Key-2,账号2\\nAPI-Key-3,账号3'
};
document.querySelectorAll('.btn.tpl').forEach(function(b){
  b.onclick=function(){document.getElementById('bulkKeys').value=TPL[b.getAttribute('data-tpl')]||'';document.getElementById('bulkKeys').focus()};
});
document.getElementById('bulkImport').onclick=function(){
  var btn=this;btn.disabled=true;
  var txt=document.getElementById('bulkKeys').value;
  if(!txt.trim()){toast('请先粘贴 Key 列表（可点击上方模板按钮填充格式）',true);btn.disabled=false;return;}
  if(txt.indexOf('你的APIKey')!==-1){toast('模板占位符未替换：请把 你的APIKey1 换成真实 Key 再导入',true);btn.disabled=false;return;}
  toast('正在导入…');
  api('/admin/api/keys/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:document.getElementById('bulkProvider').value,label_prefix:document.getElementById('bulkLabel').value,model:document.getElementById('bulkModel').value,rpm_limit:document.getElementById('bulkRpm').value||null,keys:txt})})
  .then(function(r){toast('批量导入完成：新增 '+r.added+' 个'+(r.skipped?('，跳过重复 '+r.skipped+' 个'):''));document.getElementById('bulkKeys').value='';loadKeys()})
  .catch(function(e){toast(e.message,true)})
  .finally(function(){btn.disabled=false});
};
document.getElementById('addKey').onclick=function(){
  var btn=this;btn.disabled=true;
  api('/admin/api/keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:document.getElementById('nkProvider').value,label:document.getElementById('nkLabel').value,api_key:document.getElementById('nkKey').value,rpm_limit:document.getElementById('nkRpm').value||null,model:document.getElementById('nkModel').value})})
  .then(function(){toast('Key 已添加并生效');['nkLabel','nkKey','nkRpm','nkModel'].forEach(function(i){document.getElementById(i).value=''});loadKeys()})
  .catch(function(e){toast(e.message,true)})
  .finally(function(){btn.disabled=false});
};
loadKeys();
// Auto-refresh every 30s so cooldown timers tick down live. Skipped while a
// form field has focus (typing a new key) and while the tab is hidden.
var _focusCount=0;
document.addEventListener('focusin',function(e){if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA')_focusCount++});
document.addEventListener('focusout',function(e){if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA')_focusCount=Math.max(0,_focusCount-1)});
setInterval(function(){if(_focusCount===0&&!document.hidden)loadKeys()},30000);
})();
</script></body></html>`;

/* Post-V2 — read-only audit trail viewer. Backing API: GET /admin/api/audit-logs
 * (audit.read). Same escaping discipline as the other panels (Stage 5): every
 * dynamic value goes through esc() before it touches innerHTML. The inner
 * script deliberately avoids template literals — it lives inside one. */
const AUDIT_PANEL_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>审计日志 - CRM</title><style>
body{font-family:system-ui,sans-serif;margin:0;background:#f3f5f9;color:#1f2430}
.top{background:#1f2430;color:#fff;padding:14px 24px;display:flex;justify-content:space-between;align-items:center}
.top h1{font-size:18px;margin:0}
.top a{color:#fff;text-decoration:none;background:rgba(255,255,255,.15);padding:8px 14px;border-radius:8px;font-weight:600;font-size:14px}
.wrap{max-width:1100px;margin:24px auto;padding:0 16px}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:20px;margin-bottom:20px}
h2{font-size:16px;margin:0 0 12px}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.bar input{padding:7px 9px;border:1px solid #ccd2dd;border-radius:6px;font-size:13px;width:220px}
.btn{border:0;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px;font-weight:600;background:#3f9d63;color:#fff}
.btn.gray{background:#8b93a3}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f0f2f7;padding:8px;text-align:left;font-size:12px;color:#5a6270}
td{padding:8px;border-bottom:1px solid #eef1f6;vertical-align:top}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.act{display:inline-block;padding:1px 8px;border-radius:10px;background:#e3ecf7;color:#1d4ed8;font-size:12px;font-weight:600}
.act.warn{background:#fde8e8;color:#b23b3b}
.meta{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#5a6270;word-break:break-all;max-width:340px}
#toast{position:fixed;top:18px;right:18px;background:#1f2430;color:#fff;padding:10px 16px;border-radius:8px;font-size:14px;display:none;max-width:420px;z-index:9}
#toast.err{background:#b23b3b}
.hint{font-size:12px;color:#7a8291;margin-top:6px}

/* stage30 auto: inline style -> class */
.s-hidden{display:none}
</style></head><body>
<header class="top"><h1>🧾 审计日志（只读）</h1><a href="/admin">← 返回客户管理</a></header>
<div class="wrap">
<div class="card">
  <div class="bar">
    <input id="fAction" placeholder="按动作过滤，如 ACCESS_DENIED">
    <button class="btn" id="fGo">刷新</button>
    <button class="btn gray s-hidden" id="more" >加载更多 ↓</button>
  </div>
  <table><thead><tr><th>时间 (UTC)</th><th>操作人</th><th>动作</th><th>资源</th><th>request_id</th><th>详情</th></tr></thead>
  <tbody id="rows"><tr><td colspan="6">加载中…</td></tr></tbody></table>
  <p class="hint">数据源 /admin/api/audit-logs（权限 audit.read）。保留策略由 AUDIT_RETENTION_DAYS 控制，cron 每 5 分钟自动清理过期行。</p>
</div>
</div>
<div id="toast"></div>
<script>
(function(){
'use strict';
function esc(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function toast(msg,isErr){var t=document.getElementById('toast');t.textContent=msg;t.className=isErr?'err':'';t.style.display='block';setTimeout(function(){t.style.display='none'},3200)}
function api(path){return fetch(path,{credentials:'same-origin'}).then(function(r){return r.json().then(function(body){if(!r.ok)throw new Error(body.detail||('HTTP '+r.status));return body})})}
var _next=null;
function renderRows(logs,append){
  var tb=document.getElementById('rows');
  if(!append)tb.innerHTML='';
  if(!logs.length&&!append){tb.innerHTML='<tr><td colspan="6">无记录</td></tr>';return}
  var html='';
  for(var i=0;i<logs.length;i++){
    var l=logs[i];
    var meta=l.metadata?esc(JSON.stringify(l.metadata)):'';
    var actor=l.actor_role?esc(l.actor_role)+(l.actor_user_id?' ('+esc(l.actor_user_id)+')':''):'<span class="mono">—</span>';
    var cls=l.action==='ACCESS_DENIED'||l.action==='LOGIN_FAILURE'?'act warn':'act';
    html+='<tr><td class="mono">'+esc(l.created_at)+'</td><td>'+actor+'</td>'
      +'<td><span class="'+cls+'">'+esc(l.action)+'</span></td>'
      +'<td class="mono">'+esc(l.resource_type)+(l.resource_id?':'+esc(l.resource_id):'')+'</td>'
      +'<td class="mono">'+(l.request_id?esc(l.request_id):'—')+'</td>'
      +'<td class="meta">'+(meta||'—')+'</td></tr>';
  }
  tb.insertAdjacentHTML('beforeend',html);
}
function load(before){
  var action=document.getElementById('fAction').value.trim();
  var q='/admin/api/audit-logs?limit=100'+(before?'&before='+encodeURIComponent(before):'')+(action?'&action='+encodeURIComponent(action):'');
  api(q).then(function(body){
    renderRows(body.logs||[],!!before);
    _next=body.next_before;
    document.getElementById('more').style.display=_next?'':'none';
  }).catch(function(e){toast(e.message,true)});
}
document.getElementById('fGo').onclick=function(){load()};
document.getElementById('fAction').addEventListener('keydown',function(e){if(e.key==='Enter')load()});
document.getElementById('more').onclick=function(){if(_next)load(_next)};
load();
})();
</script></body></html>`;

/* Post-V2 — session inventory + revocation (super_admin only; the server
 * route already 403s everyone else before this HTML is ever served).
 * Backing APIs: GET /admin/api/auth/sessions,
 * POST /admin/api/auth/sessions/revoke, POST /admin/api/auth/revoke-all.
 * Same escaping discipline as the other panels. */
const SESSIONS_PANEL_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>会话管理 - CRM</title><style>
body{font-family:system-ui,sans-serif;margin:0;background:#f3f5f9;color:#1f2430}
.top{background:#1f2430;color:#fff;padding:14px 24px;display:flex;justify-content:space-between;align-items:center}
.top h1{font-size:18px;margin:0}
.top a{color:#fff;text-decoration:none;background:rgba(255,255,255,.15);padding:8px 14px;border-radius:8px;font-weight:600;font-size:14px}
.wrap{max-width:1000px;margin:24px auto;padding:0 16px}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:20px;margin-bottom:20px}
h2{font-size:16px;margin:0 0 12px}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.btn{border:0;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px;font-weight:600;background:#3f9d63;color:#fff}
.btn.del{background:#fde8e8;color:#b23b3b}
.btn.gray{background:#8b93a3}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f0f2f7;padding:8px;text-align:left;font-size:12px;color:#5a6270}
td{padding:8px;border-bottom:1px solid #eef1f6;vertical-align:top}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.cur{display:inline-block;margin-left:6px;padding:1px 8px;border-radius:10px;background:#dcfce7;color:#166534;font-size:12px;font-weight:600}
#toast{position:fixed;top:18px;right:18px;background:#1f2430;color:#fff;padding:10px 16px;border-radius:8px;font-size:14px;display:none;max-width:420px;z-index:9}
#toast.err{background:#b23b3b}
.hint{font-size:12px;color:#7a8291;margin-top:6px}
</style></head><body>
<header class="top"><h1>🔐 会话管理（仅 super_admin）</h1><a href="/admin">← 返回客户管理</a></header>
<div class="wrap">
<div class="card">
  <div class="bar">
    <button class="btn" id="refresh">刷新</button>
    <button class="btn del" id="revokeAll">吊销其他所有会话</button>
  </div>
  <table><thead><tr><th>用户</th><th>角色</th><th>登录时间 (UTC)</th><th>过期时间</th><th>IP 哈希</th><th></th></tr></thead>
  <tbody id="rows"><tr><td colspan="6">加载中…</td></tr></tbody></table>
  <p class="hint">吊销立即生效：被吊销会话的下一个请求将收到 401。「吊销其他所有会话」保留你当前登录，便于应急响应时不把自己锁在门外。</p>
</div>
</div>
<div id="toast"></div>
<script>
(function(){
'use strict';
function esc(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function toast(msg,isErr){var t=document.getElementById('toast');t.textContent=msg;t.className=isErr?'err':'';t.style.display='block';setTimeout(function(){t.style.display='none'},3200)}
function api(path,init){return fetch(path,Object.assign({credentials:'same-origin'},init||{})).then(function(r){return r.json().then(function(body){if(!r.ok)throw new Error(body.detail||('HTTP '+r.status));return body})})}
function render(sessions){
  var tb=document.getElementById('rows');
  if(!sessions.length){tb.innerHTML='<tr><td colspan="6">无活跃会话</td></tr>';return}
  var html='';
  for(var i=0;i<sessions.length;i++){
    var s=sessions[i];
    html+='<tr><td>'+esc(s.username)+'<span class="mono">('+esc(s.user_id)+')</span>'+(s.is_current?'<span class="cur">当前</span>':'')+'</td>'
      +'<td>'+esc(s.role)+'</td>'
      +'<td class="mono">'+esc(s.created_at)+'</td>'
      +'<td class="mono">'+esc(s.expires_at)+'</td>'
      +'<td class="mono">'+(s.ip_hash?esc(s.ip_hash.slice(0,12))+'…':'—')+'</td>'
      +'<td>'+(s.is_current?'':'<button class="btn del" data-sid="'+esc(s.id)+'">吊销</button>')+'</td></tr>';
  }
  tb.innerHTML=html;
  Array.prototype.forEach.call(tb.querySelectorAll('button[data-sid]'),function(b){
    b.onclick=function(){
      api('/admin/api/auth/sessions/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:b.getAttribute('data-sid')})})
      .then(function(body){toast(body.revoked>0?'会话已吊销':'该会话已处于吊销状态');load()})
      .catch(function(e){toast(e.message,true)});
    };
  });
}
function load(){
  api('/admin/api/auth/sessions').then(function(body){render(body.sessions||[])})
  .catch(function(e){toast(e.message,true)});
}
 document.getElementById('refresh').onclick=load;
 document.getElementById('revokeAll').onclick=function(){
   if(!confirm('确定吊销除当前会话外的全部活跃会话？此操作立即生效。'))return;
   api('/admin/api/auth/revoke-all',{method:'POST'}).then(function(body){toast('已吊销 '+body.revoked+' 个会话');load()})
   .catch(function(e){toast(e.message,true)});
 };
load();
})();
</script></body></html>`;

/* CRM sales layer (CRM/合并.txt): companies / deals kanban / timeline — the
 * sales view of the same D1 database. API surface lives in src/crm.ts; this
 * panel only calls /admin/api/crm/*. Template-literal safety (the stage-5206800
 * lesson): no backticks, no "${", no newline escapes inside the embedded JS —
 * messages are single-line strings and the script-block parse check in CI
 * covers regressions. */
const CRM_PANEL_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CRM 销售作战室</title><style>
:root{font-family:system-ui,-apple-system,sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}
.top{background:#0f766e;color:#fff;padding:16px 26px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.top h1{font-size:21px;margin:0}
.top a{color:#fff;text-decoration:none;font-weight:600}
.top form{display:inline}
.top button{background:rgba(255,255,255,.2);color:#fff;border:0;border-radius:8px;padding:6px 14px;font:inherit;font-weight:600;cursor:pointer}
.wrap{max-width:1500px;margin:20px auto;padding:0 16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.stat-card{background:#f0fdfa;border:1px solid #99f6e4;border-radius:10px;padding:14px;text-align:center}
.stat-value{font-size:26px;font-weight:700;color:#0f766e}.stat-label{font-size:13px;color:#6b7280;margin-top:2px}
.panel{background:#fff;border:1px solid #d1d5db;border-radius:12px;padding:18px;margin-bottom:16px}
.panel h2{font-size:17px;font-weight:700;color:#0f766e;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #0f766e}
.sec-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.sec-head h2{margin:0;border:0;padding:0}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.hint{font-size:12px;color:#6b7280;margin:4px 0 10px;line-height:1.6}
input,select,textarea{padding:8px;border:1px solid #cbd5e1;border-radius:6px;font:inherit;font-size:13px;background:#fff}
textarea{width:100%;min-height:70px;resize:vertical}
.btn{padding:8px 16px;border:0;border-radius:8px;cursor:pointer;font:inherit;font-weight:600;font-size:13px;background:#6b7280;color:#fff}
.btn-p{background:#0f766e}.btn-p:hover{background:#115e59}.btn:hover{filter:brightness(.95)}
.btn-d{background:#dc2626}.btn-s{background:#e5e7eb;color:#172033}
.btn-xs{padding:4px 10px;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #f1f5f9;vertical-align:top}
th{background:#f8fafc;font-weight:600;white-space:nowrap}
.badge{display:inline-block;border-radius:20px;padding:2px 9px;font-size:12px;font-weight:600}
.b-a{background:#d1fae5;color:#065f46}.b-b{background:#dbeafe;color:#1e40af}.b-c{background:#fef3c7;color:#92400e}.b-vip{background:#f3e8ff;color:#6b21a8}.b-un{background:#f1f5f9;color:#64748b}
.b-new{background:#e0f2fe;color:#075985}.b-enriched{background:#d1fae5;color:#065f46}.b-contacted{background:#fef3c7;color:#92400e}.b-qualified{background:#ede9fe;color:#5b21b6}.b-disq{background:#fee2e2;color:#991b1b}
.kanban{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px}
.kcol{min-width:210px;flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px}
.kcol h3{margin:2px 4px 8px;font-size:13px;color:#475569;display:flex;justify-content:space-between}
.kcard{background:#fff;border:1px solid #d1d5db;border-radius:8px;padding:8px;margin-bottom:8px;font-size:12px}
.kcard .t{font-weight:700;font-size:13px;margin-bottom:2px}
.kcard .c{color:#6b7280;margin-bottom:4px}
.kcard .amt{font-weight:700;color:#0f766e}
.kcard select{padding:3px 4px;font-size:12px;margin:4px 4px 4px 0}
.modal-back{position:fixed;inset:0;background:rgba(15,23,42,.5);display:none;align-items:flex-start;justify-content:center;z-index:100;padding:30px 14px;overflow:auto}
.modal-back.open{display:flex}
.modal{background:#fff;border-radius:14px;padding:20px;max-width:760px;width:100%}
.modal h3{margin:0 0 12px;font-size:17px;color:#0f766e}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.f label{display:block;font-size:12px;color:#475569;margin:8px 0 3px;font-weight:600}
.f input,.f select,.f textarea{width:100%}
.mrow{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
.tl{list-style:none;margin:8px 0;padding:0;max-height:300px;overflow:auto}
.tl li{border-left:3px solid #99f6e4;padding:6px 10px;margin-bottom:6px;background:#f8fafc;border-radius:0 8px 8px 0;font-size:13px}
.tl .tl-meta{font-size:11px;color:#94a3b8;margin-bottom:2px}
.toast{position:fixed;top:18px;right:18px;padding:12px 18px;border-radius:10px;color:#fff;font-weight:600;z-index:9999;display:none;font-size:14px}
.toast.ok{background:#059669}.toast.err{background:#dc2626}
.od{color:#dc2626;font-weight:700}
.kcard[draggable="true"]{cursor:grab}
.kcard.dragging{opacity:.45}
.kcol.dragover{outline:2px dashed #0f766e;outline-offset:-4px;background:#f0fdfa}
.b-cust{background:#dcfce7;color:#166534}
.b-dnc{background:#fee2e2;color:#991b1b}
.b-unsub{background:#ffedd5;color:#9a3412}
.b-warn{background:#fef9c3;color:#854d0e}
.funnel-row{display:flex;align-items:center;gap:10px;margin:7px 0;font-size:13px}
.funnel-l{width:120px;color:#475569;font-weight:600;flex:none}
.funnel-bar{height:14px;background:#0f766e;border-radius:0 7px 7px 0;min-width:2px}
.funnel-v{white-space:nowrap}
tr.grp td{background:#f0fdfa;font-weight:700;color:#0f766e;font-size:12px;padding:6px 8px}
tr.grp-od td{background:#fef2f2;font-weight:700;color:#dc2626;font-size:12px;padding:6px 8px}
.chart{display:flex;align-items:flex-end;gap:10px;height:130px;padding:24px 6px 0}
.bar-w{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;min-width:0}
.bar{position:relative;background:#0f766e;border-radius:4px 4px 0 0;min-height:2px}
.bar .v{position:absolute;top:-20px;left:50%;transform:translateX(-50%);font-size:11px;color:#0f766e;white-space:nowrap;font-weight:700}
.bar-l{font-size:11px;color:#6b7280;text-align:center;margin-top:4px}
@media(max-width:700px){.top{flex-direction:column}.grid2{grid-template-columns:1fr}}
</style></head><body>
<header class="top"><h1>🎯 CRM 销售作战室</h1><div><a href="/admin">← 客户管理</a>&nbsp;&nbsp;<a href="/admin/outreach">📧 开发信</a>&nbsp;&nbsp;<form method="post" action="/admin/logout"><button type="submit">退出登录</button></form></div></header>
<main class="wrap">
<div class="stats">
<div class="stat-card"><div class="stat-value" id="stCompanies">–</div><div class="stat-label">客户公司</div></div>
<div class="stat-card"><div class="stat-value" id="stCustomersWon">–</div><div class="stat-label">成交客户</div></div>
<div class="stat-card"><div class="stat-value" id="stOpenDeals">–</div><div class="stat-label">进行中商机</div></div>
<div class="stat-card"><div class="stat-value" id="stPipeline">–</div><div class="stat-label">管道金额（进行中）</div></div>
<div class="stat-card"><div class="stat-value" id="stForecast">–</div><div class="stat-label">加权预测</div></div>
<div class="stat-card"><div class="stat-value" id="stTasks">–</div><div class="stat-label">待办任务</div></div>
<div class="stat-card"><div class="stat-value" id="stOverdue">–</div><div class="stat-label">逾期任务</div></div>
</div>

<div class="panel">
<div class="sec-head"><h2>📈 成交走势（近 6 个月）</h2></div>
<p class="hint">每月赢单商机的金额合计（按赢单日期 won_at）。加权预测 = 进行中商机金额按阶段折算：询盘 10% · 样品报价 30% · PI 已发 50% · 定金到账 80%。</p>
<div class="chart" id="wonChart"></div>
</div>

<div class="panel">
<div class="sec-head"><h2>🔻 客户开发漏斗</h2></div>
<p class="hint">口径：触达 = gmail_send_log 中 status='sent' 的发信次数（发送尝试，非送达数）；回复 = 时间线 email_received 条数；商机/赢单 = 未归档商机。回复率 = 回复 / 触达。</p>
<div class="chart" id="funnelChart"></div>
</div>

<div class="panel">
<div class="sec-head"><h2>🔀 销售序列</h2>
<div class="toolbar"><button class="btn" id="seqNew">➕ 新建序列</button><button class="btn btn-p" id="seqReload">刷新</button></div></div>
<p class="hint">多步自动跟进：按步骤天数依次发送模板邮件（占位符 {{company}} {{contact_name}} {{country}} {{domain}} {{sender_name}}）；客户回复、退订/禁联、连续发送失败自动终止；发信复用 Gmail 配额与发送前拦截。在公司详情里把公司加入序列。</p>
<table><thead><tr><th>序列</th><th>品牌</th><th>步骤</th><th>进行中/总数</th><th>状态</th><th>操作</th></tr></thead><tbody id="seqRows"></tbody></table>
</div>

<div class="panel">
<div class="sec-head"><h2>📮 邮箱检测</h2><button class="btn btn-p" id="dchkReload">刷新</button></div>
<p class="hint">公司域名与联系人邮箱的可信度筛查（DNS over HTTPS）：A / MX / SPF 记录、MX 邮局指纹（Google / Microsoft 365 / Zoho…）、免费邮箱、一次性邮箱识别。新增或修改的域名/邮箱自动进入检测队列，由 5 分钟定时任务逐步筛查；也可在公司详情里手动重检。仅 dead_domain / no_mx / disposable 会记入时间线提醒。</p>
<div class="hint" id="dchkCounts"></div>
<table><thead><tr><th>域名</th><th>判定</th><th>邮局</th><th>A</th><th>MX</th><th>SPF</th><th>检测时间</th></tr></thead><tbody id="dchkRows"></tbody></table>
</div>

<div class="panel">
<div class="sec-head"><h2>📡 持续意向监测</h2><button class="btn btn-p" id="sigReload">刷新</button></div>
<p class="hint">对重要客户（A/VIP 分级或有未结商机，自动入表）周期性搜索五类采购信号：新品发布 / 扩张动向 / 经销商招募 / 采购公告 / 渠道变化（DuckDuckGo，单次检查 5 条查询，默认 14 天冷却）。新信号自动记时间线 + 建待办；强信号（扩张/招经销/采购公告）会把 C 级公司自动上调为 B 级。可在公司详情里立即检查。</p>
<table><thead><tr><th>公司</th><th>分级</th><th>监测</th><th>周期(天)</th><th>上次检查</th><th>有效信号</th><th>操作</th></tr></thead><tbody id="sigWatchRows"></tbody></table>
<p class="hint" style="margin:12px 0 4px">最近信号（检测后 90 天内有效，来源去重）：</p>
<table><thead><tr><th>公司</th><th>类型</th><th>信号内容</th><th>来源</th><th>检测时间</th></tr></thead><tbody id="sigRows"></tbody></table>
</div>

<div class="panel">
<div class="sec-head"><h2>📈 ROI 归因（客户开发效果）</h2><button class="btn btn-p" id="attrReload">刷新</button></div>
<p class="hint">哪个客户来源最赚钱、哪种客户最容易成交：按 来源 / 国家 / 行业 / 联系人角色 / 销售序列 五个维度统计 公司 → 联系人 → 回复 → 商机 → 报价 → 成交 → 营收。报价 = 推进到样品报价及之后的商机；赢单率 = 成交 / 商机；平均周期 = 商机创建到赢单的平均天数。来源可在公司详情里人工修正（如转介绍）。</p>
<div class="toolbar" id="attrDims">
<button class="btn btn-p btn-xs" data-dim="sources">来源</button>
<button class="btn btn-xs" data-dim="countries">国家</button>
<button class="btn btn-xs" data-dim="industries">行业</button>
<button class="btn btn-xs" data-dim="roles">联系人角色</button>
<button class="btn btn-xs" data-dim="sequences">销售序列</button>
</div>
<table><thead><tr><th id="attrDimHead">来源</th><th>公司</th><th>联系人</th><th>回复</th><th>商机</th><th>报价</th><th>成交</th><th>营收(USD)</th><th>赢单率</th><th>平均周期(天)</th></tr></thead><tbody id="attrRows"></tbody></table>
<div class="hint" id="attrHint"></div>
</div>

<div class="panel">
<div class="sec-head"><h2>📅 任务日历</h2><div class="toolbar"><button class="btn btn-xs" id="calPrev">‹ 上月</button><span id="calLabel" class="hint" style="margin:0"></span><button class="btn btn-xs" id="calNext">下月 ›</button><button class="btn btn-xs" id="calThisMonth">回到本月</button><button class="btn btn-s" id="calIcs">📥 订阅 .ics</button><button class="btn btn-p" id="calReload">刷新</button></div></div>
<p class="hint">每天打开先看这里：逾期任务按公司价值置顶（超时升级）；商机阶段推进会自动生成下一步行动任务（样品报价 → 跟进反馈 / PI 已发 → 跟进定金 / 定金到账 → 安排生产 / 赢单 → 售后回访）；「订阅 .ics」把未结任务导出为标准日历源，可导入 Google 日历或系统日历。</p>
<div class="hint" id="calCounts"></div>
<table><thead><tr><th>🔴 逾期任务（按公司价值排序）</th><th>公司</th><th>负责人</th><th>操作</th></tr></thead><tbody id="calOverdue"></tbody></table>
<table><thead><tr><th>📌 今日待办</th><th>公司</th><th>负责人</th><th>操作</th></tr></thead><tbody id="calToday"></tbody></table>
<div id="calGrid"></div>
</div>

<div class="panel">
<div class="sec-head"><h2>🏢 客户公司</h2>
<div class="toolbar"><input id="coSearch" placeholder="搜索名称/域名/备注"><select id="coTier"><option value="">全部分级</option><option value="A">A</option><option value="B">B</option><option value="C">C</option><option value="VIP">VIP</option><option value="unqualified">未分级</option></select><select id="coStatus"><option value="">全部状态</option><option value="new">新线索</option><option value="enriched">已富化</option><option value="contacted">已联系</option><option value="qualified">已验证</option><option value="disqualified">已淘汰</option></select><button class="btn btn-p" id="coReload">刷新</button><button class="btn" id="coNew">➕ 新建公司</button></div></div>
<p class="hint">⬆️ 线索提升：把研究管线（customers 表）里已调研完的线索一键转为销售公司 —— ID 填客户管理面板「客户ID」列的数字。提升过的线索会自动跳过（幂等），联系人、国家、行业、评分分级一并带入。</p>
<div class="toolbar"><input id="promoteId" placeholder="customers 表 ID（数字）" style="width:190px"><button class="btn" id="promoteBtn">⬆️ 提升为销售公司</button><span id="promoteMsg" class="hint" style="margin:0"></span></div>
<table><thead><tr><th>公司</th><th>国家</th><th>分级</th><th>状态</th><th>域名</th><th>商机</th><th>待办</th><th>操作</th></tr></thead><tbody id="coRows"></tbody></table>
<div class="hint" id="coHint"></div>
</div>

<div class="panel">
<div class="sec-head"><h2>📊 商机看板</h2><button class="btn btn-p" id="dealNew">➕ 新建商机</button></div>
<p class="hint">阶段流转：询盘 → 样品报价 → PI 已发 → 定金到账 → 赢单 / 输单。拖拽卡片可换阶段、也可在列内排序；输单时会询问输单原因，赢单后公司自动转为成交客户。每列标题右侧是商机数与金额小计。</p>
<div class="kanban" id="kanban"></div>
</div>

<div class="panel">
<div class="sec-head"><h2>🗄 已归档商机</h2><button class="btn btn-s" id="archToggle">展开</button></div>
<div id="archBody" style="display:none">
<p class="hint">赢单/输单结案后的商机点卡片上的「归档」让它离开看板；这里可恢复或彻底删除（时间线记录不受影响）。</p>
<table><thead><tr><th>名称</th><th>公司</th><th>阶段</th><th>金额</th><th>归档日</th><th>操作</th></tr></thead><tbody id="archRows"></tbody></table>
</div>
</div>

<div class="panel">
<h2>✅ 待办任务</h2>
<p class="hint">公司时间线里 type=task 的未完成事项。按到期日分组：逾期 / 今天 / 明天 / 未来 7 天 / 更晚 / 无期限。可用「→明天」一键顺延，逾期任务红色高亮。</p>
<table><thead><tr><th>到期日</th><th>公司</th><th>任务</th><th>操作</th></tr></thead><tbody id="taskRows"></tbody></table>
</div>

<div class="panel">
<div class="sec-head"><h2>📥 CSV 导入</h2></div>
<p class="hint">支持公司 / 联系人 / 商机三种实体。表头可用中文或英文（公司导入：名称、域名、国家、行业、分级、备注；联系人导入：公司、姓名、职务、邮箱、电话、LinkedIn、主联；商机导入：公司、名称、阶段、金额、条款、预计成交、输单原因）。公司按名称/域名自动去重；联系人和商机的公司不存在时自动创建；未知阶段回落到询盘。</p>
<div class="toolbar"><select id="impEntity"><option value="companies">导入公司</option><option value="contacts">导入联系人</option><option value="deals">导入商机</option></select><input type="file" id="impFile" accept=".csv,text/csv,text/plain"><button class="btn btn-p" id="impBtn">开始导入</button></div>
<div class="f"><textarea id="impCsv" placeholder="选择上面的文件，或把 CSV 内容（表头 + 数据行）直接粘贴到这里…"></textarea></div>
<div class="hint" id="impMsg"></div>
</div>
</main>

<div class="modal-back" id="mNewCo"><div class="modal">
<h3>➕ 新建客户公司</h3>
<div class="f grid2">
<div><label>公司名称 *</label><input id="ncName"></div>
<div><label>域名</label><input id="ncDomain" placeholder="example.com"></div>
<div><label>国家</label><input id="ncCountry"></div>
<div><label>行业</label><input id="ncIndustry"></div>
</div>
<div class="mrow"><button class="btn btn-s" data-close="mNewCo">取消</button><button class="btn btn-p" id="ncSave">保存</button></div>
</div></div>

<div class="modal-back" id="mNewDeal"><div class="modal">
<h3>➕ 新建商机</h3>
<div class="f grid2">
<div><label>所属公司 *</label><select id="ndCompany"></select></div>
<div><label>商机名称 *</label><input id="ndTitle" placeholder="如：2026 Q4 采购单"></div>
<div><label>金额（USD）</label><input id="ndAmount" type="number" min="0" step="any"></div>
<div><label>贸易条款</label><input id="ndIncoterms" placeholder="FOB / CIF / EXW…"></div>
<div><label>预计成交日</label><input id="ndClose" type="date"></div>
</div>
<div class="mrow"><button class="btn btn-s" data-close="mNewDeal">取消</button><button class="btn btn-p" id="ndSave">保存</button></div>
</div></div>

<div class="modal-back" id="mDetail"><div class="modal">
  <div id="dBody"></div>
  </div></div>

<div class="modal-back" id="mSeqNew"><div class="modal">
  <h3>➕ 新建销售序列</h3>
  <div id="snBody"></div>
  </div></div>

<div class="modal-back" id="mSeq"><div class="modal">
  <h3>序列入册明细</h3>
  <div id="sqBody"></div>
  </div></div>


<div class="toast" id="toast"></div>

<script>
(function(){
'use strict';
  var STATE={companies:[],total:0,deals:[],tasks:[],stats:null,won:[],funnel:null,sequences:[],domainChecks:[],signalWatch:[],signalList:[],attribution:null,attrDim:'sources',calendar:null,calMonth:new Date().toISOString().slice(0,7)};
var STAGES=['inquiry','sample_quoted','pi_sent','deposit_paid','won','lost'];
var STAGE_L={inquiry:'询盘',sample_quoted:'样品报价',pi_sent:'PI 已发',deposit_paid:'定金到账',won:'赢单',lost:'输单'};
var TIER_L={A:'A级',B:'B级',C:'C级',VIP:'VIP',unqualified:'未分级'};
var STATUS_L={new:'新线索',enriched:'已富化',contacted:'已联系',qualified:'已验证',disqualified:'已淘汰'};
var TYPE_L={note:'备注',manual_note:'备注',task:'任务',call:'通话',meeting:'会议',lead_promoted:'线索提升',company_merged:'公司合并',cold_email_sent:'开发信已发',ai_enrichment:'AI 调研',email_received:'收到邮件'};

function esc(v){return String(v===null||v===undefined?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function $(id){return document.getElementById(id);}
function toast(msg,err){var t=$('toast');t.textContent=msg;t.className='toast '+(err?'err':'ok');t.style.display='block';setTimeout(function(){t.style.display='none';},2600);}
function api(path,opts){
  opts=opts||{};
  var init={method:opts.method||'GET',credentials:'same-origin'};
  if(opts.body){init.headers={'Content-Type':'application/json'};init.body=JSON.stringify(opts.body);}
  return fetch(path,init).then(function(res){
    return res.json().catch(function(){return{};}).then(function(body){
      if(!res.ok){throw new Error(body&&body.detail?body.detail:('HTTP '+res.status));}
      return body;
    });
  });
}
function fmtAmt(a){if(a===null||a===undefined||a==='')return '—';return '$'+Number(a).toLocaleString();}
function fmtDate(s){if(!s)return '—';return String(s).replace('T',' ').slice(0,16);}
function tierBadge(t){return '<span class="badge b-'+(t==='unqualified'?'un':t.toLowerCase())+'">'+esc(TIER_L[t]||t)+'</span>';}
function statusBadge(s){return '<span class="badge b-'+esc(s)+'">'+esc(STATUS_L[s]||s)+'</span>';}
function openModal(id){$(id).classList.add('open');}
function closeModal(id){$(id).classList.remove('open');}

/* ── 加载与渲染 ─────────────────────────────────────────── */
function loadCompanies(){
  var p='/admin/api/crm/companies?limit=200&q='+encodeURIComponent($('coSearch').value)+'&tier='+encodeURIComponent($('coTier').value)+'&lead_status='+encodeURIComponent($('coStatus').value);
  return api(p).then(function(b){STATE.companies=b.companies||[];STATE.total=b.total||0;renderCompanies();});
}
function renderCompanies(){
  var rows='';
  for(var i=0;i<STATE.companies.length;i++){
    var c=STATE.companies[i];
    rows+='<tr><td><strong>'+esc(c.name)+'</strong><div class="hint" style="margin:0">'+esc(c.id)+'</div></td><td>'+esc(c.country||'—')+'</td><td>'+tierBadge(c.tier)+'</td><td>'+statusBadge(c.lead_status)+(c.customer_since?' <span class="badge b-cust" title="自 '+esc(c.customer_since)+' 起成交">客户</span>':'')+'</td><td>'+esc(c.domain||'—')+'</td><td>'+Number(c.open_deals||0)+'</td><td>'+Number(c.open_tasks||0)+'</td><td><button class="btn btn-p btn-xs" data-act="detail" data-id="'+esc(c.id)+'">详情</button> <button class="btn btn-d btn-xs" data-act="delCo" data-id="'+esc(c.id)+'">删除</button></td></tr>';
  }
  $('coRows').innerHTML=rows||'<tr><td colspan="8" class="hint">暂无公司 — 先从下面的「提升线索」开始，或点右上角「新建公司」。</td></tr>';
  $('coHint').textContent='共 '+STATE.total+' 家公司'+(STATE.total>STATE.companies.length?'（当前显示前 '+STATE.companies.length+' 家）':'');
}
function loadDeals(){
  return api('/admin/api/crm/deals').then(function(b){STATE.deals=b.deals||[];renderKanban();});
}
function loadArchived(){
  return api('/admin/api/crm/deals?archived=1').then(function(b){
    var rows='',list=b.deals||[];
    for(var i=0;i<list.length;i++){
      var d=list[i];
      rows+='<tr><td>'+esc(d.title)+(d.lost_reason?'<div class="od" style="font-size:11px">✗ '+esc(d.lost_reason)+'</div>':'')+'</td><td>'+esc(d.company_name)+'</td><td>'+STAGE_L[d.stage]+'</td><td>'+fmtAmt(d.amount)+'</td><td>'+esc(d.archived_at||'—')+'</td><td><button class="btn btn-p btn-xs" data-act="restoreDeal" data-id="'+esc(d.id)+'">恢复</button> <button class="btn btn-d btn-xs" data-act="delArch" data-id="'+esc(d.id)+'">删除</button></td></tr>';
    }
    $('archRows').innerHTML=rows||'<tr><td colspan="6" class="hint">暂无已归档商机。</td></tr>';
  });
}
function renderKanban(){
  var html='';
  for(var s=0;s<STAGES.length;s++){
    var st=STAGES[s];
    html+='<div class="kcol" data-stage="'+st+'"><h3>'+STAGE_L[st]+'<span>'+stageCount(st)+' · '+fmtAmt(stageSum(st))+'</span></h3>';
    for(var i=0;i<STATE.deals.length;i++){
      var d=STATE.deals[i];
      if(d.stage!==st)continue;
      var pos=d.position===null||d.position===undefined?(i+1):Number(d.position);
      html+='<div class="kcard" data-deal="'+esc(d.id)+'" data-pos="'+pos+'" draggable="true"><div class="t">'+esc(d.title)+'</div><div class="c">'+esc(d.company_name)+'</div><div class="amt">'+fmtAmt(d.amount)+'</div>';
      if(d.lost_reason)html+='<div class="od" style="font-size:11px;margin:2px 0">✗ '+esc(d.lost_reason)+'</div>';
      html+='<select data-deal="'+esc(d.id)+'">';
      for(var j=0;j<STAGES.length;j++){html+='<option value="'+STAGES[j]+'"'+(STAGES[j]===d.stage?' selected':'')+'>'+STAGE_L[STAGES[j]]+'</option>';}
      html+='</select> '+(d.stage==='won'||d.stage==='lost'?'<button class="btn btn-s btn-xs" data-act="archDeal" data-id="'+esc(d.id)+'">归档</button> ':'')+'<button class="btn btn-d btn-xs" data-act="delDeal" data-id="'+esc(d.id)+'">删</button></div>';
    }
    html+='</div>';
  }
  $('kanban').innerHTML=html;
}
function stageCount(st){var n=0;for(var i=0;i<STATE.deals.length;i++){if(STATE.deals[i].stage===st)n++;}return n;}
function stageSum(st){var n=0;for(var i=0;i<STATE.deals.length;i++){if(STATE.deals[i].stage===st)n+=Number(STATE.deals[i].amount||0);}return n;}
function loadTasks(){
  return api('/admin/api/crm/activities').then(function(b){STATE.tasks=b.activities||[];renderTasks();});
}
function renderTasks(){
  var t=new Date();
  var tstr=t.toISOString().slice(0,10);
  var tm=new Date(t.getTime()+86400000).toISOString().slice(0,10);
  var wk=new Date(t.getTime()+7*86400000).toISOString().slice(0,10);
  var g={overdue:[],today:[],tomorrow:[],week:[],later:[],none:[]};
  for(var i=0;i<STATE.tasks.length;i++){
    var a=STATE.tasks[i];
    if(!a.due_date)g.none.push(a);
    else if(a.due_date<tstr)g.overdue.push(a);
    else if(a.due_date===tstr)g.today.push(a);
    else if(a.due_date===tm)g.tomorrow.push(a);
    else if(a.due_date<=wk)g.week.push(a);
    else g.later.push(a);
  }
  var rows='';
  var groups=[['overdue','🔴 逾期',true],['today','📌 今天',false],['tomorrow','Tomorrow 明天',false],['week','🗓 未来 7 天',false],['later','⏳ 更晚',false],['none','📭 无期限',false]];
  for(var k=0;k<groups.length;k++){
    var key=groups[k][0],label=groups[k][1],od=groups[k][2];
    var list=g[key];
    if(!list.length)continue;
    rows+='<tr class="'+(od?'grp-od':'grp')+'"><td colspan="4">'+label+'（'+list.length+'）</td></tr>';
    for(var j=0;j<list.length;j++){
      var a2=list[j];
      var isOd=a2.due_date&&a2.due_date<tstr;
      var days=isOd?Math.round((new Date(tstr)-new Date(a2.due_date))/86400000):0;
      var dueCell=isOd?'<span class="od">'+esc(a2.due_date)+'</span> <span class="od">逾期'+days+'天</span>':esc(a2.due_date||'—');
      rows+='<tr><td>'+dueCell+'</td><td>'+esc(a2.company_name)+'</td><td>'+esc(a2.summary)+'</td><td><button class="btn btn-p btn-xs" data-act="doneTask" data-id="'+esc(a2.id)+'">✓ 完成</button> <button class="btn btn-s btn-xs" data-act="snoozeTask" data-id="'+esc(a2.id)+'">→明天</button> <button class="btn btn-s btn-xs" data-act="delTask" data-id="'+esc(a2.id)+'">删</button></td></tr>';
    }
  }
  $('taskRows').innerHTML=rows||'<tr><td colspan="4" class="hint">暂无待办任务 🎉</td></tr>';
}
function renderStats(){
  var s=STATE.stats||{};
  $('stCompanies').textContent=s.companies_total!==undefined?Number(s.companies_total):STATE.total;
  $('stCustomersWon').textContent=s.customers_won!==undefined?Number(s.customers_won):'–';
  $('stOpenDeals').textContent=s.open_deals!==undefined?Number(s.open_deals):'–';
  $('stPipeline').textContent='$'+Number(s.pipeline_amount||0).toLocaleString();
  $('stForecast').textContent='$'+Number(s.forecast_amount||0).toLocaleString();
  $('stTasks').textContent=s.open_tasks!==undefined?Number(s.open_tasks):STATE.tasks.length;
  $('stOverdue').textContent=s.overdue_tasks!==undefined?Number(s.overdue_tasks):'–';
  $('stOverdue').style.color=Number(s.overdue_tasks)>0?'#dc2626':'';
}
function loadStats(){
  return api('/admin/api/crm/stats').then(function(b){STATE.stats=b.stats||null;STATE.won=b.won_monthly||[];STATE.funnel=b.funnel||null;renderStats();renderChart();renderFunnel();});
}
function renderFunnel(){
  var el=$('funnelChart');if(!el)return;
  var f=STATE.funnel;
  if(!f){el.innerHTML='<p class="hint">暂无漏斗数据（发信日志不可用或尚未发信）。</p>';return;}
  var stages=[['客户公司',f.companies],['联系人',f.contacts],['触达（发信）',f.emails_sent],['回复',f.replies],['商机',f.deals],['赢单',f.won]];
  var max=1;
  for(var i=0;i<stages.length;i++){if(Number(stages[i][1])>max)max=Number(stages[i][1]);}
  var h='';
  for(var j=0;j<stages.length;j++){
    var pct=Math.round(Number(stages[j][1])/max*100);
    var conv='';
    if(j>0&&Number(stages[j-1][1])>0){conv=' <span class="hint">转化 '+Math.round(Number(stages[j][1])/Number(stages[j-1][1])*100)+'%</span>';}
    h+='<div class="funnel-row"><span class="funnel-l">'+stages[j][0]+'</span><span class="funnel-bar" style="width:'+Math.max(pct,2)+'%"></span><span class="funnel-v">'+Number(stages[j][1]).toLocaleString()+conv+'</span></div>';
  }
  h+='<p class="hint" style="margin:10px 0 0">回复率（回复/触达）：<b>'+(f.reply_rate!==undefined?f.reply_rate:'–')+'%</b></p>';
  el.innerHTML=h;
}

/* ── 销售序列 ───────────────────────────────────────────── */
function loadSequences(){
  return api('/admin/api/crm/sequences').then(function(b){STATE.sequences=b.sequences||[];renderSequences();});
}
function renderSequences(){
  var rows='';
  for(var i=0;i<STATE.sequences.length;i++){
    var s=STATE.sequences[i];
    var steps='';
    var sl=s.steps||[];
    for(var j=0;j<sl.length;j++){
      steps+='D+'+Number(sl[j].day_offset)+' '+esc(String(sl[j].subject).slice(0,22))+(j<sl.length-1?' → ':'');
    }
    rows+='<tr><td>'+esc(s.name)+'</td><td>'+esc(s.brand_name)+'</td><td>'+steps+'</td><td>'+Number(s.active_count)+' / '+Number(s.total_count)+'</td><td>'+(Number(s.enabled)?'<span class="badge b-a">启用</span>':'<span class="badge b-un">停用</span>')+'</td><td><button class="btn btn-s btn-xs" data-act="seqDetail" data-id="'+esc(s.id)+'">明细</button> <button class="btn btn-s btn-xs" data-act="seqToggle" data-id="'+esc(s.id)+'">'+(Number(s.enabled)?'停用':'启用')+'</button> <button class="btn btn-d btn-xs" data-act="seqDel" data-id="'+esc(s.id)+'">删</button></td></tr>';
  }
  $('seqRows').innerHTML=rows||'<tr><td colspan="6" class="hint">还没有序列。点「➕ 新建序列」创建一个多步自动跟进。</td></tr>';
}
$('seqReload').onclick=loadSequences;
$('seqRows').addEventListener('click',function(e){
  var b=e.target.closest('[data-act]');if(!b)return;
  var act=b.getAttribute('data-act'),id=b.getAttribute('data-id');
  if(act==='seqDetail'){
    openSeqDetail(id);
  }else if(act==='seqToggle'){
    var en=1;
    for(var i=0;i<STATE.sequences.length;i++){
      if(STATE.sequences[i].id===id){en=Number(STATE.sequences[i].enabled)?0:1;break;}
    }
    api('/admin/api/crm/sequences/'+encodeURIComponent(id),{method:'PATCH',body:{enabled:en===1}}).then(function(){toast('已更新');loadSequences();}).catch(function(err){toast(err.message,true);});
  }else if(act==='seqDel'){
    if(!confirm('确定删除该序列及其全部入册记录？已发送的邮件和时间线不受影响。'))return;
    api('/admin/api/crm/sequences/'+encodeURIComponent(id),{method:'DELETE'}).then(function(){toast('已删除');loadSequences();}).catch(function(err){toast(err.message,true);});
  }
});
$('seqNew').onclick=function(){
  var h='<div class="f"><label>序列名称 *</label><input id="sqName" placeholder="如：桨板经销商三步开发"></div>';
  h+='<div class="f"><label>品牌 brand_name *（须与开发信设置一致，用于选择发件邮箱）</label><input id="sqBrand"></div>';
  h+='<p class="hint">至少填写第 1 步；天数为入册后第 N 天发送（0 = 下一 tick 立即发）。占位符：{{company}} {{contact_name}} {{country}} {{domain}} {{sender_name}}。</p>';
  var defs=[0,3,7];
  for(var i=0;i<3;i++){
    h+='<div class="f" style="border-top:1px solid #e2e8f0;padding-top:8px;margin-top:8px"><label>步骤 '+(i+1)+'（第 <input id="sqDay'+i+'" type="number" min="0" max="90" value="'+defs[i]+'" style="width:64px;display:inline-block"> 天）</label>';
    h+='<input id="sqSubj'+i+'" placeholder="主题，如：{{company}} 采购合作意向">';
    h+='<textarea id="sqBodyT'+i+'" rows="3" style="margin-top:4px" placeholder="正文…"></textarea></div>';
  }
  h+='<div class="mrow"><button class="btn btn-s" data-close="mSeqNew">取消</button><button class="btn btn-p" id="sqSave">保存序列</button></div>';
  $('snBody').innerHTML=h;
  $('sqSave').onclick=saveSeqNew;
  openModal('mSeqNew');
};
function saveSeqNew(){
  var steps=[];
  for(var i=0;i<3;i++){
    var subj=$('sqSubj'+i).value.trim(),body=$('sqBodyT'+i).value.trim();
    if(!subj&&!body)continue;
    steps.push({day_offset:Number($('sqDay'+i).value||0),subject:subj,body:body});
  }
  var payload={name:$('sqName').value.trim(),brand_name:$('sqBrand').value.trim(),steps:steps};
  if(!payload.name||!payload.brand_name||!steps.length){toast('名称、品牌和至少一个步骤必填',true);return;}
  api('/admin/api/crm/sequences',{method:'POST',body:payload}).then(function(){
    closeModal('mSeqNew');toast('序列已创建，在公司详情里即可入册');loadSequences();
  }).catch(function(err){toast(err.message,true);});
}
var curSeqId=null;
function openSeqDetail(id){
  curSeqId=id;
  api('/admin/api/crm/sequences/'+encodeURIComponent(id)+'/enrollments').then(function(b){
    var ens=b.enrollments||[];
    var h='<table><thead><tr><th>公司</th><th>邮箱</th><th>步骤</th><th>下次发送</th><th>状态</th><th>操作</th></tr></thead><tbody>';
    for(var i=0;i<ens.length;i++){
      var en=ens[i];
      var st=en.status==='active'?'<span class="badge b-a">进行中</span>':en.status==='paused'?'<span class="badge b-warn">已暂停</span>':en.status==='completed'?'<span class="badge b-cust">已完成</span>':'<span class="badge b-dnc">已终止</span>';
      var btns='';
      if(en.status==='active')btns='<button class="btn btn-s btn-xs" data-act="enPause" data-id="'+esc(en.id)+'">暂停</button> <button class="btn btn-d btn-xs" data-act="enStop" data-id="'+esc(en.id)+'">停止</button>';
      else if(en.status==='paused')btns='<button class="btn btn-p btn-xs" data-act="enResume" data-id="'+esc(en.id)+'">恢复</button> <button class="btn btn-d btn-xs" data-act="enStop" data-id="'+esc(en.id)+'">停止</button>';
      h+='<tr><td>'+esc(en.company_name||en.company_id)+'</td><td>'+esc(en.contact_email)+'</td><td>'+(Number(en.current_step)+1)+'</td><td>'+esc(String(en.next_due_at).slice(0,16).replace('T',' '))+'</td><td>'+st+(en.stop_reason?'<div class="hint" style="margin:2px 0 0">'+esc(en.stop_reason)+'</div>':'')+'</td><td>'+btns+'</td></tr>';
    }
    h+='</tbody></table><div class="mrow"><button class="btn btn-s" data-close="mSeq">关闭</button></div>';
    $('sqBody').innerHTML=h;
    openModal('mSeq');
  }).catch(function(err){toast(err.message,true);});
}
$('snBody').addEventListener('click',function(e){
  var cs=e.target.closest('[data-close]');
  if(cs){closeModal(cs.getAttribute('data-close'));}
});
$('sqBody').addEventListener('click',function(e){
  var cs=e.target.closest('[data-close]');if(cs){closeModal(cs.getAttribute('data-close'));return;}
  var b=e.target.closest('[data-act]');if(!b)return;
  var act=b.getAttribute('data-act'),id=b.getAttribute('data-id');
  var status=act==='enPause'?'paused':act==='enResume'?'active':'stopped';
  api('/admin/api/crm/enrollments/'+encodeURIComponent(id),{method:'PATCH',body:{status:status,reason:act==='enStop'?'人工停止':null}}).then(function(){toast('已更新');openSeqDetail(curSeqId);}).catch(function(err){toast(err.message,true);});
});
function renderChart(){
  var el=$('wonChart');if(!el)return;
  var map={};for(var i=0;i<STATE.won.length;i++){map[STATE.won[i].month]=Number(STATE.won[i].total||0);}
  var now=new Date(),max=0,bars=[];
  for(var m=5;m>=0;m--){
    var d=new Date(now.getFullYear(),now.getMonth()-m,1);
    var key=('0000'+d.getFullYear()).slice(-4)+'-'+('00'+(d.getMonth()+1)).slice(-2);
    var v=map[key]||0;if(v>max)max=v;
    bars.push({key:key,v:v});
  }
  var h='';
  for(var k=0;k<bars.length;k++){
    var pct=max>0?Math.round(bars[k].v/max*100):0;
    h+='<div class="bar-w"><div class="bar" style="height:'+Math.max(pct,2)+'%"><span class="v">'+(bars[k].v?'$'+bars[k].v.toLocaleString():'')+'</span></div><div class="bar-l">'+bars[k].key.slice(2)+'</div></div>';
  }
  el.innerHTML=h;
}
/* ── 邮箱/域名检测 ───────────────────────────────────────── */
var DOMAIL_STATUS_L={pending:'待检测',valid:'邮箱有效',free_email:'免费邮箱',disposable:'一次性邮箱',no_mx:'无收件邮局',dead_domain:'域名失效'};
function domailBadge(s){
  if(s==='valid')return '<span class="badge b-a">邮箱有效</span>';
  if(s==='free_email')return '<span class="badge b-b">免费邮箱</span>';
  if(s==='disposable')return '<span class="badge b-unsub">一次性邮箱</span>';
  if(s==='no_mx')return '<span class="badge b-warn">无收件邮局</span>';
  if(s==='dead_domain')return '<span class="badge b-dnc">域名失效</span>';
  return '<span class="badge b-un">待检测</span>';
}
function loadDomains(){
  return api('/admin/api/crm/domains').then(function(b){
    STATE.domainChecks=b.checks||[];
    renderDomains(b.company_counts||[],b.contact_counts||[]);
  });
}
function renderDomains(companyCounts,contactCounts){
  var rows='';
  for(var i=0;i<STATE.domainChecks.length;i++){
    var d=STATE.domainChecks[i];
    rows+='<tr><td>'+esc(d.domain)+'</td><td>'+domailBadge(d.verdict)+'</td><td>'+esc(d.mx_provider||'—')+'</td><td>'+(Number(d.has_a_record)?'✓':'✗')+'</td><td>'+(Number(d.has_mx_record)?'✓':'✗')+'</td><td>'+(Number(d.has_spf_record)?'✓':'✗')+'</td><td>'+esc(String(d.last_checked_at||'').slice(0,16).replace('T',' '))+'</td></tr>';
  }
  $('dchkRows').innerHTML=rows||'<tr><td colspan="7" class="hint">还没有检测记录。新增/修改域名或邮箱后，定时任务会自动筛查。</td></tr>';
  var cc='',ct='';
  for(var j=0;j<companyCounts.length;j++){cc+=DOMAIL_STATUS_L[companyCounts[j].status]||companyCounts[j].status;cc+=' '+Number(companyCounts[j].n)+(j<companyCounts.length-1?' · ':'');}
  for(var k=0;k<contactCounts.length;k++){ct+=DOMAIL_STATUS_L[contactCounts[k].status]||contactCounts[k].status;ct+=' '+Number(contactCounts[k].n)+(k<contactCounts.length-1?' · ':'');}
  $('dchkCounts').innerHTML='公司域名：'+(cc||'无')+'　｜　联系人邮箱：'+(ct||'无');
}
$('dchkReload').onclick=loadDomains;

/* ── 持续意向监测（更新.txt ⑥） ─────────────────────────── */
var ROLE_BADGE={owner:['老板/决策','b-cust'],procurement:['采购','b-a'],finance:['财务','b-b'],channel:['渠道','b-warn'],operations:['运营','b-unsub'],sales:['销售','b-b'],other:['其他','b-un'],unknown:['未识别','b-un']};
var SIGNAL_TYPE_L={new_product:'新品发布',expansion:'扩张动向',distributor:'经销商招募',procurement:'采购公告',channel_change:'渠道变化'};
function loadSignals(){
  return api('/admin/api/crm/signals').then(function(b){
    STATE.signalWatch=b.watch||[];STATE.signalList=b.signals||[];renderSignals();
  });
}
function renderSignals(){
  var w='';
  for(var i=0;i<STATE.signalWatch.length;i++){
    var s=STATE.signalWatch[i];
    w+='<tr><td>'+esc(s.company_name)+'</td><td>'+tierBadge(s.tier)+'</td><td>'+(Number(s.enabled)?'<span class="badge b-a">监测中</span>':'<span class="badge b-un">已停用</span>')+'</td><td>'+Number(s.interval_days)+'</td><td>'+esc(String(s.last_checked_at||'尚未检查').slice(0,16).replace('T',' '))+'</td><td>'+Number(s.active_signals||0)+'</td><td><button class="btn btn-s btn-xs" data-act="sigToggle" data-id="'+esc(s.company_id)+'">'+(Number(s.enabled)?'停用':'启用')+'</button> <button class="btn btn-p btn-xs" data-act="sigCheck" data-id="'+esc(s.company_id)+'">立即检查</button></td></tr>';
  }
  $('sigWatchRows').innerHTML=w||'<tr><td colspan="7" class="hint">还没有监测中的公司。A/VIP 分级或创建未结商机后自动入表。</td></tr>';
  var r='';
  for(var j=0;j<STATE.signalList.length;j++){
    var g=STATE.signalList[j];
    r+='<tr><td>'+esc(g.company_name)+'</td><td><span class="badge b-warn">'+(SIGNAL_TYPE_L[g.signal_type]||esc(g.signal_type))+'</span></td><td>'+esc(String(g.signal_text||'').slice(0,90))+'</td><td>'+(g.source_url?'<a href="'+esc(g.source_url)+'" target="_blank" rel="noopener">链接</a>':'—')+'</td><td>'+esc(String(g.detected_at||'').slice(0,16).replace('T',' '))+'</td></tr>';
  }
  $('sigRows').innerHTML=r||'<tr><td colspan="5" class="hint">暂无信号。检查完成且命中关键词后展示在这里。</td></tr>';
}
$('sigReload').onclick=loadSignals;
$('sigWatchRows').addEventListener('click',function(e){
  var b=e.target.closest('[data-act]');if(!b)return;
  var id=b.getAttribute('data-id');
  if(b.getAttribute('data-act')==='sigToggle'){
    var en=1;
    for(var i=0;i<STATE.signalWatch.length;i++){
      if(STATE.signalWatch[i].company_id===id){en=Number(STATE.signalWatch[i].enabled)?0:1;break;}
    }
    api('/admin/api/crm/companies/'+encodeURIComponent(id)+'/watch',{method:'PATCH',body:{enabled:en===1}}).then(function(){toast('监测配置已更新');loadSignals();}).catch(function(err){toast(err.message,true);});
  }else if(b.getAttribute('data-act')==='sigCheck'){
    toast('正在搜索信号…');
    api('/admin/api/crm/companies/'+encodeURIComponent(id)+'/check-signals',{method:'POST'}).then(function(b2){
      toast('检查完成：新增信号 '+Number(b2.report.new_signals)+' 条'+(b2.report.tier_bumped?'，公司分级已上调 B':''));
      loadSignals();
    }).catch(function(err){toast(err.message,true);});
  }
});
/* ── ROI 归因 + 任务日历（0038） ─────────────────────────── */
var ATTR_DIM_L={sources:'来源',countries:'国家',industries:'行业',roles:'联系人角色',sequences:'销售序列'};
var SOURCE_L={promoted:'管线提升',manual:'手工录入',csv_import:'CSV 导入',merge:'合并而来',referral:'转介绍',other:'其他',unknown:'未知'};
function loadAttribution(){
  return api('/admin/api/crm/attribution').then(function(b){STATE.attribution=b;renderAttribution();});
}
function renderAttribution(){
  var b=STATE.attribution||{};
  var btns=$('attrDims').querySelectorAll('[data-dim]');
  for(var k=0;k<btns.length;k++){btns[k].className=btns[k].getAttribute('data-dim')===STATE.attrDim?'btn btn-p btn-xs':'btn btn-xs';}
  $('attrDimHead').textContent=ATTR_DIM_L[STATE.attrDim]||STATE.attrDim;
  if(b.available===false){
    $('attrRows').innerHTML='<tr><td colspan="10" class="hint">ROI 归因暂不可用：数据库尚未应用 0038 迁移（crm_companies.source 列缺失）。部署后自动生效。</td></tr>';
    $('attrHint').textContent='';
    return;
  }
  var list=b[STATE.attrDim]||[];
  var rows='';
  for(var i=0;i<list.length;i++){
    var r=list[i];
    var dimCell='<strong>'+esc(r.label||r.dim)+'</strong>';
    if(STATE.attrDim==='sequences'&&r.enrolled!==undefined)dimCell+='<div class="hint" style="margin:0;font-size:11px">报名 '+Number(r.enrolled)+' · 进行 '+Number(r.active)+' · 停止 '+Number(r.stopped)+' · 完成 '+Number(r.completed)+'</div>';
    rows+='<tr><td>'+dimCell+'</td><td>'+Number(r.companies||0)+'</td><td>'+Number(r.contacts||0)+'</td><td>'+Number(r.replies||0)+'</td><td>'+Number(r.deals||0)+'</td><td>'+Number(r.quoted||0)+'</td><td>'+Number(r.won||0)+'</td><td>'+fmtAmt(r.revenue||0)+'</td><td>'+(Number(r.deals||0)>0?String(r.win_rate)+'%':'—')+'</td><td>'+(r.avg_cycle_days===null||r.avg_cycle_days===undefined?'—':String(r.avg_cycle_days))+'</td></tr>';
  }
  $('attrRows').innerHTML=rows||'<tr><td colspan="10" class="hint">该维度暂无数据。</td></tr>';
  $('attrHint').textContent='点击上方标签切换维度；营收按未归档赢单商机金额合计，报价 = 推进到样品报价及之后。';
}
$('attrReload').onclick=function(){loadAttribution().catch(function(e){toast(e.message,true);});};
$('attrDims').addEventListener('click',function(e){
  var b=e.target.closest('[data-dim]');if(!b)return;
  STATE.attrDim=b.getAttribute('data-dim');
  renderAttribution();
});
function shiftMonth(m,off){
  var p=m.split('-');var y=parseInt(p[0],10);var mo=parseInt(p[1],10)-1+off;
  var d=new Date(Date.UTC(y,mo,1));
  return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');
}
function loadCalendar(){
  return api('/admin/api/crm/calendar?month='+STATE.calMonth).then(function(b){STATE.calendar=b;STATE.calMonth=b.month||STATE.calMonth;renderCalendar();});
}
function calTaskRow(t,od){
  var dueCell=od?'<span class="od">逾期 '+Number(t.overdue_days||0)+' 天</span>（'+esc(t.due_date)+'）':'（'+esc(t.due_date)+'）';
  return '<tr><td>'+dueCell+' '+esc(t.summary)+'</td><td>'+esc(t.company_name)+' '+tierBadge(t.tier)+'</td><td>'+esc(t.owner||'—')+'</td><td><button class="btn btn-p btn-xs" data-calact="done" data-id="'+esc(t.id)+'">✓ 完成</button> <button class="btn btn-s btn-xs" data-calact="snooze" data-id="'+esc(t.id)+'">→明天</button></td></tr>';
}
function renderCalendar(){
  var b=STATE.calendar||{};
  var cnt=b.counts||{};
  $('calLabel').textContent=STATE.calMonth;
  $('calCounts').textContent='本月未结任务 '+Number(cnt.month_open||0)+' · 逾期 '+Number(cnt.overdue||0)+' · 今日 '+Number(cnt.today||0);
  var od=b.overdue||[];var rows='';
  for(var i=0;i<od.length;i++){rows+=calTaskRow(od[i],true);}
  $('calOverdue').innerHTML=rows||'<tr><td colspan="4" class="hint">🎉 无逾期任务</td></tr>';
  var td=b.today_tasks||[];var rows2='';
  for(var j=0;j<td.length;j++){rows2+=calTaskRow(td[j],false);}
  $('calToday').innerHTML=rows2||'<tr><td colspan="4" class="hint">今日无待办</td></tr>';
  var days=b.days||{};
  var ym=STATE.calMonth.split('-');var y=parseInt(ym[0],10);var mo=parseInt(ym[1],10);
  var startDow=(new Date(Date.UTC(y,mo-1,1)).getUTCDay()+6)%7;
  var dim=new Date(Date.UTC(y,mo,0)).getUTCDate();
  var today=String(b.today||new Date().toISOString().slice(0,10));
  var html='<table style="table-layout:fixed;margin-top:8px"><thead><tr><th>一</th><th>二</th><th>三</th><th>四</th><th>五</th><th>六</th><th>日</th></tr></thead><tbody>';
  var cell=1-startDow;
  while(cell<=dim){
    html+='<tr>';
    for(var d=0;d<7;d++,cell++){
      if(cell<1||cell>dim){html+='<td style="height:64px"></td>';continue;}
      var ds=y+'-'+String(mo).padStart(2,'0')+'-'+String(cell).padStart(2,'0');
      var list=days[ds]||[];
      var style=ds===today?' style="height:64px;background:#eef2ff;font-weight:600"':' style="height:64px"';
      var inner='';
      for(var k2=0;k2<list.length&&k2<3;k2++){inner+='<div class="hint" style="margin:0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(list[k2].summary)+'">• '+esc(list[k2].summary)+'</div>';}
      if(list.length>3)inner+='<div class="hint" style="margin:0;font-size:11px">+'+(list.length-3)+' 更多</div>';
      html+='<td'+style+'><div style="font-weight:600">'+cell+'</div>'+inner+'</td>';
    }
    html+='</tr>';
  }
  html+='</tbody></table>';
  $('calGrid').innerHTML=html;
}
function calAct(e){
  var b=e.target.closest('[data-calact]');if(!b)return;
  var id=b.getAttribute('data-id');
  if(b.getAttribute('data-calact')==='done'){
    api('/admin/api/crm/activities/'+encodeURIComponent(id),{method:'PATCH',body:{is_completed:true}}).then(function(){toast('已完成 ✓');loadCalendar();loadStats();loadTasks().then(renderStats);}).catch(function(err){toast(err.message,true);});
  }else{
    var tm=new Date(Date.now()+86400000).toISOString().slice(0,10);
    api('/admin/api/crm/activities/'+encodeURIComponent(id),{method:'PATCH',body:{due_date:tm}}).then(function(){toast('已顺延到明天');loadCalendar();loadTasks().then(renderStats);}).catch(function(err){toast(err.message,true);});
  }
}
$('calReload').onclick=function(){loadCalendar().catch(function(e){toast(e.message,true);});};
$('calPrev').onclick=function(){STATE.calMonth=shiftMonth(STATE.calMonth,-1);loadCalendar().catch(function(e){toast(e.message,true);});};
$('calNext').onclick=function(){STATE.calMonth=shiftMonth(STATE.calMonth,1);loadCalendar().catch(function(e){toast(e.message,true);});};
$('calThisMonth').onclick=function(){STATE.calMonth=new Date().toISOString().slice(0,7);loadCalendar().catch(function(e){toast(e.message,true);});};
$('calIcs').onclick=function(){window.open('/admin/api/crm/calendar.ics');};
$('calOverdue').addEventListener('click',calAct);
$('calToday').addEventListener('click',calAct);
function loadAll(){
  return Promise.all([loadCompanies(),loadDeals(),loadTasks(),loadStats(),loadSequences(),loadDomains(),loadSignals(),loadAttribution(),loadCalendar()]).catch(function(e){toast(e.message,true);});
}

/* ── 公司详情 ───────────────────────────────────────────── */
function openDetail(id){
  api('/admin/api/crm/companies/'+encodeURIComponent(id)).then(function(b){
    var c=b.company,contacts=b.contacts||[],deals=b.deals||[],acts=b.activities||[],csg=b.signals||[];
    var h='<h3>'+esc(c.name)+' '+tierBadge(c.tier)+' '+statusBadge(c.lead_status)+(c.customer_since?' <span class="badge b-cust">正式客户 · '+esc(c.customer_since)+' 起</span>':'')+(Number(c.do_not_contact)?' <span class="badge b-dnc">禁止联系</span>':'')+'</h3>';
    h+='<p class="hint" style="margin:0 0 10px">ID '+esc(c.id)+' · '+esc(c.domain||'无域名')+' '+(c.domain?domailBadge(c.domain_email_status):'')+' · '+esc(c.country||'国家未知')+' · '+esc(c.industry||'行业未知')+(c.merged_from_ids?' · 已并入来源: '+esc(c.merged_from_ids):'')+'</p>';
    h+='<div class="grid2 f"><div><label>分级</label><select id="dTier">';
    ['A','B','C','VIP','unqualified'].forEach(function(t){h+='<option value="'+t+'"'+(t===c.tier?' selected':'')+'>'+TIER_L[t]+'</option>';});
    h+='</select></div><div><label>销售状态</label><select id="dStatus">';
    ['new','enriched','contacted','qualified','disqualified'].forEach(function(s){h+='<option value="'+s+'"'+(s===c.lead_status?' selected':'')+'>'+STATUS_L[s]+'</option>';});
    h+='</select></div><div><label>客户来源（ROI 归因，可修正为转介绍等）</label><select id="dSource">';
    ['promoted','manual','csv_import','merge','referral','other','unknown'].forEach(function(src){h+='<option value="'+src+'"'+(src===(c.source||'unknown')?' selected':'')+'>'+SOURCE_L[src]+'</option>';});
    h+='</select></div></div>';
    h+='<div class="f"><label>中文备注（合并历史也记录在这里）</label><textarea id="dRemarks">'+esc(c.chinese_remarks||'')+'</textarea></div>';
    h+='<div class="mrow" style="justify-content:flex-start"><button class="btn btn-p" data-act="saveCo" data-id="'+esc(c.id)+'">保存公司信息</button>';
    if(c.domain)h+='<button class="btn btn-s" data-act="recheckDomain" data-id="'+esc(c.id)+'">🔍 重检域名</button>';
    if(Number(c.do_not_contact)){
      h+='<button class="btn btn-s" data-act="unblockCo" data-id="'+esc(c.id)+'">解除公司禁联</button>';
    }else{
      h+='<button class="btn btn-d" data-act="blockCo" data-id="'+esc(c.id)+'">🚫 标记公司禁止联系</button>';
    }
    h+='</div>';
    h+='<h2 style="font-size:15px;margin:16px 0 8px">👤 联系人（'+contacts.length+'）</h2><table><thead><tr><th>姓名</th><th>职务</th><th>角色</th><th>邮箱</th><th>电话/WhatsApp</th><th>状态</th><th>主联</th><th>操作</th></tr></thead><tbody>';
    for(var i=0;i<contacts.length;i++){
      var ct=contacts[i];
      var cst='';
      if(Number(ct.do_not_contact))cst+='<span class="badge b-dnc">禁联</span> ';
      else if(ct.unsubscribed_at)cst+='<span class="badge b-unsub">已退订</span> ';
      if(ct.email_status==='invalid')cst+='<span class="badge b-warn">邮箱无效</span> ';
      if(ct.email&&ct.email_check_status&&ct.email_check_status!=='pending')cst+=domailBadge(ct.email_check_status)+' ';
      if(!cst)cst='<span class="hint">正常</span>';
      var roleSel='<select data-rolect="'+esc(ct.id)+'" title="'+esc(ct.role_evidence||'自动按职位推断，可人工修正')+'" style="max-width:104px">';
      for(var rk in ROLE_BADGE){roleSel+='<option value="'+rk+'"'+((ct.procurement_role||'unknown')===rk?' selected':'')+'>'+ROLE_BADGE[rk][0]+'</option>';}
      roleSel+='</select>';
      var ctop='';
      if(Number(ct.do_not_contact)||ct.unsubscribed_at){
        ctop+='<button class="btn btn-s btn-xs" data-act="unblockCt" data-id="'+esc(ct.id)+'">解禁</button> ';
      }else{
        ctop+='<button class="btn btn-s btn-xs" data-act="blockCt" data-id="'+esc(ct.id)+'">禁联</button> ';
      }
      if(ct.email)ctop+='<button class="btn btn-s btn-xs" data-act="recheckEmail" data-id="'+esc(ct.id)+'">重检邮箱</button> ';
      if(ct.email&&ct.email_status!=='invalid'){
        ctop+='<button class="btn btn-s btn-xs" data-act="markEmailInvalid" data-id="'+esc(ct.id)+'">标无效</button> ';
      }else if(ct.email){
        ctop+='<button class="btn btn-s btn-xs" data-act="markEmailValid" data-id="'+esc(ct.id)+'">标有效</button> ';
      }
      h+='<tr><td>'+esc(ct.full_name)+'</td><td>'+esc(ct.job_title||'—')+'</td><td>'+roleSel+'</td><td>'+esc(ct.email||'—')+'</td><td>'+esc(ct.whatsapp_or_phone||'—')+'</td><td>'+cst+'</td><td>'+(Number(ct.is_primary)?'★':'')+'</td><td>'+ctop+(Number(ct.is_primary)?'':'<button class="btn btn-s btn-xs" data-act="mkPrimary" data-id="'+esc(ct.id)+'">设主联</button> ')+'<button class="btn btn-d btn-xs" data-act="delContact" data-id="'+esc(ct.id)+'">删</button></td></tr>';
    }
    h+='</tbody></table>';
    h+='<div class="grid2 f"><div><label>新联系人姓名 *</label><input id="dcName"></div><div><label>职务</label><input id="dcTitle"></div><div><label>邮箱</label><input id="dcEmail"></div><div><label>电话/WhatsApp</label><input id="dcPhone"></div></div>';
    h+='<button class="btn" data-act="addContact" data-id="'+esc(c.id)+'" style="margin-top:8px">➕ 添加联系人</button>';
    if(contacts.length>1){
      h+='<div class="toolbar" style="margin-top:10px"><span class="hint" style="margin:0">🔀 合并重复联系人:</span><select id="cmSrc">';
      for(var n=0;n<contacts.length;n++){h+='<option value="'+esc(contacts[n].id)+'">'+esc(contacts[n].full_name)+'</option>';}
      h+='</select><span class="hint" style="margin:0">并入 →</span><select id="cmTgt">';
      for(var n2=1;n2<contacts.length;n2++){h+='<option value="'+esc(contacts[n2].id)+'">'+esc(contacts[n2].full_name)+'</option>';}
      h+='</select><button class="btn btn-d" data-act="mergeContact" data-id="'+esc(c.id)+'">合并</button></div>';
      h+='<p class="hint">来源联系人的姓名保留、缺失字段（职务/邮箱/电话/LinkedIn）补到目标联系人，来源被删除，动作记入时间线。</p>';
    }
    h+='<h2 style="font-size:15px;margin:16px 0 8px">💰 商机（'+deals.length+'）</h2><table><thead><tr><th>名称</th><th>阶段</th><th>金额</th><th>预计成交</th><th>联系人</th><th>状态</th><th>操作</th></tr></thead><tbody>';
    for(var k=0;k<deals.length;k++){
      var d=deals[k];
      var dcs=d.contacts||[];
      var dcHtml='';
      for(var q2=0;q2<dcs.length;q2++){
        var drb=ROLE_BADGE[dcs[q2].procurement_role]||ROLE_BADGE.unknown;
        dcHtml+='<span class="badge '+drb[1]+'" title="'+esc(dcs[q2].job_title||'')+'">'+esc(dcs[q2].full_name)+' <a href="javascript:void(0)" data-act="unlinkDc" data-id="'+esc(d.id)+'" data-cid="'+esc(dcs[q2].contact_id)+'" style="color:inherit;text-decoration:none">✕</a></span> ';
      }
      dcHtml+='<select data-dcpick="'+esc(d.id)+'" style="max-width:110px">';
      var anyUnused=false;
      for(var q3=0;q3<contacts.length;q3++){
        var unused=true;
        for(var q4=0;q4<dcs.length;q4++){if(dcs[q4].contact_id===contacts[q3].id){unused=false;break;}}
        if(unused){dcHtml+='<option value="'+esc(contacts[q3].id)+'">'+esc(contacts[q3].full_name)+'</option>';anyUnused=true;}
      }
      dcHtml+='</select> <button class="btn btn-s btn-xs" data-act="linkDc" data-id="'+esc(d.id)+'"'+(anyUnused?'':' disabled')+'>＋关联</button>';
      h+='<tr><td>'+esc(d.title)+'</td><td>'+STAGE_L[d.stage]+(d.lost_reason?'<div class="od" style="font-size:11px">✗ '+esc(d.lost_reason)+'</div>':'')+'</td><td>'+fmtAmt(d.amount)+'</td><td>'+esc(d.expected_close_date||'—')+'</td><td>'+dcHtml+'</td><td>'+(d.archived_at?'已归档 '+esc(d.archived_at):(d.won_at&&d.stage==='won'?'赢单 '+esc(d.won_at):'—'))+'</td><td><button class="btn btn-d btn-xs" data-act="delDeal" data-id="'+esc(d.id)+'">删</button></td></tr>';
    }
    h+='</tbody></tbody></table>';
    h+='<h2 style="font-size:15px;margin:16px 0 8px">🔀 销售序列</h2>';
    h+='<p class="hint">加入多步自动跟进：按步骤设定天数依次发送开发信（用主联系人邮箱）；客户回复、退订/禁联或连续发送失败会自动终止。</p>';
    h+='<div class="toolbar"><select id="dSeqPick" style="max-width:340px"><option value="">选择序列…</option>';
    for(var s3=0;s3<STATE.sequences.length;s3++){
      var sq=STATE.sequences[s3];
      if(!Number(sq.enabled))continue;
      h+='<option value="'+esc(sq.id)+'">'+esc(sq.name)+'（'+esc(sq.brand_name)+'，'+(sq.steps||[]).length+' 步）</option>';
    }
    h+='</select><button class="btn btn-p" data-act="enrollSeq" data-id="'+esc(c.id)+'">➕ 加入序列</button></div>';
    h+='<h2 style="font-size:15px;margin:16px 0 8px">📡 采购信号（'+csg.length+'）</h2>';
    if(csg.length){
      h+='<table><thead><tr><th>类型</th><th>信号内容</th><th>来源</th><th>检测时间</th></tr></thead><tbody>';
      for(var w2=0;w2<csg.length;w2++){
        var sg=csg[w2];
        h+='<tr><td><span class="badge b-warn">'+(SIGNAL_TYPE_L[sg.signal_type]||esc(sg.signal_type))+'</span></td><td>'+esc(String(sg.signal_text||'').slice(0,120))+'</td><td>'+(sg.source_url?'<a href="'+esc(sg.source_url)+'" target="_blank" rel="noopener">链接</a>':'—')+'</td><td>'+esc(String(sg.detected_at||'').slice(0,16).replace('T',' '))+'</td></tr>';
      }
      h+='</tbody></table>';
    }else{
      h+='<p class="hint">暂无有效信号（90 天内）。</p>';
    }
    h+='<button class="btn btn-p" data-act="checkSignals" data-id="'+esc(c.id)+'" style="margin-top:8px">📡 立即检查信号</button>';
    h+='<h2 style="font-size:15px;margin:16px 0 8px">🕘 时间线 / 动态</h2><ul class="tl">';
    for(var m=0;m<acts.length;m++){
      var a=acts[m];
      h+='<li><div class="tl-meta">'+fmtDate(a.created_at)+' · '+esc(TYPE_L[a.type]||a.type)+(a.owner?' · 负责人 '+esc(a.owner):'')+(a.is_completed&&Number(a.is_completed)?' · 已完成':'')+'</div>'+esc(a.summary)+'</li>';
    }
    h+='</ul>';
    h+='<div class="grid2 f"><div><label>类型</label><select id="daType"><option value="note">备注</option><option value="task">任务（待办）</option><option value="call">通话</option><option value="meeting">会议</option></select></div><div><label>到期日（任务用）</label><input id="daDue" type="date"></div><div><label>负责人（任务用，可选）</label><input id="daOwner" maxlength="50" placeholder="如：小王"></div></div>';
    h+='<div class="f"><label>内容 *</label><textarea id="daSummary" placeholder="记录一次跟进、或创建一个待办…"></textarea></div>';
    h+='<button class="btn" data-act="addActivity" data-id="'+esc(c.id)+'" style="margin-top:8px">➕ 添加到时间线</button>';
    h+='<h2 style="font-size:15px;margin:16px 0 8px">🔀 合并重复公司</h2>';
    h+='<p class="hint">把另一家公司（含联系人、商机、动态）整体并入本公司并删除对方 —— 单事务、可溯源，操作前请确认两者确为同一家公司。</p>';
    h+='<div class="toolbar"><select id="dMergeSrc" style="max-width:320px"><option value="">选择要并入的公司…</option>';
    for(var q=0;q<STATE.companies.length;q++){
      var o=STATE.companies[q];
      if(o.id===c.id)continue;
      h+='<option value="'+esc(o.id)+'">'+esc(o.name)+'（'+esc(o.id)+'）</option>';
    }
    h+='</select><button class="btn btn-d" data-act="merge" data-id="'+esc(c.id)+'">🔀 并入本公司</button></div>';
    h+='<div class="mrow"><button class="btn btn-s" data-close="mDetail">关闭</button></div>';
    $('dBody').innerHTML=h;
    openModal('mDetail');
  }).catch(function(e){toast(e.message,true);});
}

/* ── 事件绑定 ───────────────────────────────────────────── */
$('coReload').onclick=loadAll;
$('coSearch').addEventListener('change',loadCompanies);
$('coTier').addEventListener('change',loadCompanies);
$('coStatus').addEventListener('change',loadCompanies);
$('coRows').addEventListener('click',function(e){
  var b=e.target.closest('[data-act]');if(!b)return;
  if(b.getAttribute('data-act')==='detail')openDetail(b.getAttribute('data-id'));
  else if(b.getAttribute('data-act')==='delCo'){
    if(!confirm('确定删除该公司及其全部联系人、商机、动态？不可撤销。'))return;
    api('/admin/api/crm/companies/'+encodeURIComponent(b.getAttribute('data-id')),{method:'DELETE'}).then(function(){toast('已删除');loadAll();}).catch(function(err){toast(err.message,true);});
  }
});
function moveDeal(dealId,stage,pos){
  var body={stage:stage};
  if(typeof pos==='number')body.position=pos;
  if(stage==='lost'){
    var r=prompt('输单原因（可留空）:','');
    if(r===null){loadDeals();return;}
    if(r)body.lost_reason=r;
  }
  api('/admin/api/crm/deals/'+encodeURIComponent(dealId),{method:'PATCH',body:body}).then(function(){toast(stage==='won'?'已赢单 🎉 公司转正式客户':'已推进到: '+STAGE_L[stage]);loadDeals().then(renderStats);loadStats();loadCompanies();}).catch(function(err){toast(err.message,true);loadDeals();});
}
$('kanban').addEventListener('change',function(e){
  var s=e.target;
  if(s.tagName!=='SELECT'||!s.getAttribute('data-deal'))return;
  moveDeal(s.getAttribute('data-deal'),s.value);
});
var dragDealId=null;
$('kanban').addEventListener('dragstart',function(e){
  var card=e.target.closest('.kcard');
  if(!card)return;
  dragDealId=card.getAttribute('data-deal');
  e.dataTransfer.effectAllowed='move';
  try{e.dataTransfer.setData('text/plain',String(dragDealId));}catch(err){}
  card.classList.add('dragging');
});
$('kanban').addEventListener('dragend',function(e){
  var card=e.target.closest('.kcard');
  if(card)card.classList.remove('dragging');
  dragDealId=null;
});
$('kanban').addEventListener('dragover',function(e){
  var col=e.target.closest('.kcol');
  if(!col||!dragDealId)return;
  e.preventDefault();
  e.dataTransfer.dropEffect='move';
  col.classList.add('dragover');
});
$('kanban').addEventListener('dragleave',function(e){
  var col=e.target.closest('.kcol');
  if(col)col.classList.remove('dragover');
});
$('kanban').addEventListener('drop',function(e){
  var col=e.target.closest('.kcol');
  if(!col)return;
  e.preventDefault();
  col.classList.remove('dragover');
  var id=dragDealId;
  if(!id){try{id=e.dataTransfer.getData('text/plain');}catch(err){}}
  var stage=col.getAttribute('data-stage');
  if(!id||!stage)return;
  dragDealId=null;
  var card=e.target.closest('.kcard');
  if(card&&card.getAttribute('data-deal')===id)return; /* 拖回原位 = 无操作 */
  var pos;
  if(card){
    var prev=card.previousElementSibling;
    var prevPos=prev?Number(prev.getAttribute('data-pos')):Number(card.getAttribute('data-pos'))-1;
    pos=(prevPos+Number(card.getAttribute('data-pos')))/2;
  }else{
    var cards=col.querySelectorAll('.kcard');
    pos=cards.length?Number(cards[cards.length-1].getAttribute('data-pos'))+1:1;
  }
  moveDeal(id,stage,Math.round(pos*1000)/1000);
});
$('kanban').addEventListener('click',kanbanCardHandler);
function kanbanCardHandler(e){
  var b=e.target.closest('[data-act]');if(!b)return;
  var act=b.getAttribute('data-act'),id=b.getAttribute('data-id');
  if(act==='delDeal'){
    if(!confirm('确定删除该商机？'))return;
    api('/admin/api/crm/deals/'+encodeURIComponent(id),{method:'DELETE'}).then(function(){toast('已删除商机');loadAll();}).catch(function(err){toast(err.message,true);});
  }else if(act==='archDeal'){
    api('/admin/api/crm/deals/'+encodeURIComponent(id),{method:'PATCH',body:{archived:true}}).then(function(){toast('已归档');loadDeals().then(renderStats);loadStats();}).catch(function(err){toast(err.message,true);});
  }
}
$('archToggle').onclick=function(){
  var body=$('archBody'),open=body.style.display!=='none';
  body.style.display=open?'none':'block';
  this.textContent=open?'展开':'收起';
  if(!open)loadArchived().catch(function(err){toast(err.message,true);});
};
$('archRows').addEventListener('click',function(e){
  var b=e.target.closest('[data-act]');if(!b)return;
  var id=b.getAttribute('data-id');
  if(b.getAttribute('data-act')==='restoreDeal'){
    api('/admin/api/crm/deals/'+encodeURIComponent(id),{method:'PATCH',body:{archived:false}}).then(function(){toast('已恢复到看板');loadArchived();loadDeals().then(renderStats);loadStats();}).catch(function(err){toast(err.message,true);});
  }else if(b.getAttribute('data-act')==='delArch'){
    if(!confirm('彻底删除该商机？时间线记录会保留。'))return;
    api('/admin/api/crm/deals/'+encodeURIComponent(id),{method:'DELETE'}).then(function(){toast('已删除');loadArchived();loadStats();}).catch(function(err){toast(err.message,true);});
  }
});
$('taskRows').addEventListener('click',function(e){
  var b=e.target.closest('[data-act]');if(!b)return;
  var id=b.getAttribute('data-id');
  if(b.getAttribute('data-act')==='doneTask'){
    api('/admin/api/crm/activities/'+encodeURIComponent(id),{method:'PATCH',body:{is_completed:true}}).then(function(){toast('已完成 ✓');loadAll();}).catch(function(err){toast(err.message,true);});
  }else if(b.getAttribute('data-act')==='snoozeTask'){
    var tm=new Date(Date.now()+86400000).toISOString().slice(0,10);
    api('/admin/api/crm/activities/'+encodeURIComponent(id),{method:'PATCH',body:{due_date:tm}}).then(function(){toast('已顺延到 '+tm);loadTasks().then(renderStats);loadStats();}).catch(function(err){toast(err.message,true);});
  }else if(b.getAttribute('data-act')==='delTask'){
    if(!confirm('确定删除该任务？'))return;
    api('/admin/api/crm/activities/'+encodeURIComponent(id),{method:'DELETE'}).then(function(){loadAll();}).catch(function(err){toast(err.message,true);});
  }
});
$('promoteBtn').onclick=function(){
  var v=$('promoteId').value.trim();
  if(!v){toast('请先填写 customers 表的数字 ID',true);return;}
  $('promoteMsg').textContent='提升中…';
  api('/admin/api/crm/companies/promote',{method:'POST',body:{customer_id:Number(v)}}).then(function(b){
    $('promoteMsg').textContent='';
    toast(b.already_promoted?'该线索已是销售公司（幂等跳过）':'已提升为销售公司: '+b.company.name);
    $('promoteId').value='';
$('impFile').addEventListener('change',function(){
  var f=this.files&&this.files[0];
  if(!f)return;
  var rd=new FileReader();
  rd.onload=function(){$('impCsv').value=String(rd.result||'');};
  rd.readAsText(f);
});
$('impBtn').onclick=function(){
  var csv=$('impCsv').value;
  if(!csv.trim()){toast('请先选择 CSV 文件或粘贴内容',true);return;}
  $('impMsg').textContent='导入中…';
  api('/admin/api/crm/import',{method:'POST',body:{entity:$('impEntity').value,csv:csv}}).then(function(b){
    var msg='新建 '+Number(b.created||0)+' · 跳过 '+Number(b.skipped||0)+' · 出错 '+Number(b.error_total||0);
    if(b.companies_created)msg+='（自动建公司 '+Number(b.companies_created)+'）';
    $('impMsg').textContent=msg+((b.errors&&b.errors.length)?' —— '+b.errors.join('；'):'');
    toast('导入完成');
    loadAll();
  }).catch(function(err){$('impMsg').textContent='';toast(err.message,true);});
};

loadAll();
  }).catch(function(err){$('promoteMsg').textContent='';toast(err.message,true);});
};
$('coNew').onclick=function(){['ncName','ncDomain','ncCountry','ncIndustry'].forEach(function(id){$(id).value='';});openModal('mNewCo');};
$('ncSave').onclick=function(){
  if(!$('ncName').value.trim()){toast('公司名称不能为空',true);return;}
  api('/admin/api/crm/companies',{method:'POST',body:{name:$('ncName').value,domain:$('ncDomain').value,country:$('ncCountry').value,industry:$('ncIndustry').value}}).then(function(b){
    closeModal('mNewCo');toast('已创建公司: '+b.company.name);loadAll();
  }).catch(function(err){toast(err.message,true);});
};
$('dealNew').onclick=function(){
  var opts='';
  for(var i=0;i<STATE.companies.length;i++){
    var c=STATE.companies[i];
    opts+='<option value="'+esc(c.id)+'">'+esc(c.name)+'</option>';
  }
  $('ndCompany').innerHTML=opts||'<option value="">（先创建或提升一家公司）</option>';
  ['ndTitle','ndAmount','ndIncoterms','ndClose'].forEach(function(id){$(id).value='';});
  openModal('mNewDeal');
};
$('ndSave').onclick=function(){
  var body={company_id:$('ndCompany').value,title:$('ndTitle').value};
  if(!body.company_id||!body.title.trim()){toast('公司和商机名称必填',true);return;}
  if($('ndAmount').value!=='')body.amount=Number($('ndAmount').value);
  if($('ndIncoterms').value)body.incoterms=$('ndIncoterms').value;
  if($('ndClose').value)body.expected_close_date=$('ndClose').value;
  api('/admin/api/crm/deals',{method:'POST',body:body}).then(function(){
    closeModal('mNewDeal');toast('已创建商机');loadAll();
  }).catch(function(err){toast(err.message,true);});
};

/* 详情弹窗内的事件委托（innerHTML 重建不影响委托） */
$('dBody').addEventListener('click',function(e){
  var cs=e.target.closest('[data-close]');
  if(cs){closeModal(cs.getAttribute('data-close'));return;}
  var b=e.target.closest('[data-act]');if(!b)return;
  var act=b.getAttribute('data-act'),id=b.getAttribute('data-id');
  if(act==='saveCo'){
    api('/admin/api/crm/companies/'+encodeURIComponent(id),{method:'PATCH',body:{tier:$('dTier').value,lead_status:$('dStatus').value,source:$('dSource').value,chinese_remarks:$('dRemarks').value}}).then(function(){toast('公司信息已保存');loadAll();}).catch(function(err){toast(err.message,true);});
  }else if(act==='blockCo'||act==='unblockCo'){
    if(act==='blockCo'&&!confirm('标记后该公司的所有对外发送（含域名匹配）都会在发送前被拦截。确定？'))return;
    api('/admin/api/crm/companies/'+encodeURIComponent(id),{method:'PATCH',body:{do_not_contact:act==='blockCo'}}).then(function(){toast(act==='blockCo'?'已标记公司禁止联系，后续发送将被拦截':'已解除公司禁联');openDetail(id);loadCompanies().then(renderStats);}).catch(function(err){toast(err.message,true);});
  }else if(act==='blockCt'||act==='unblockCt'){
    api('/admin/api/crm/contacts/'+encodeURIComponent(id),{method:'PATCH',body:{do_not_contact:act==='blockCt'}}).then(function(){toast(act==='blockCt'?'已标记禁止联系':'已解除禁联（含退订状态）');var mid=document.querySelector('#dBody [data-act="merge"]').getAttribute('data-id');openDetail(mid);}).catch(function(err){toast(err.message,true);});
  }else if(act==='markEmailValid'||act==='markEmailInvalid'){
    api('/admin/api/crm/contacts/'+encodeURIComponent(id),{method:'PATCH',body:{email_status:act==='markEmailValid'?'valid':'invalid'}}).then(function(){toast('邮箱状态已更新');var mid=document.querySelector('#dBody [data-act="merge"]').getAttribute('data-id');openDetail(mid);}).catch(function(err){toast(err.message,true);});
  }else if(act==='addContact'){
    if(!$('dcName').value.trim()){toast('联系人姓名必填',true);return;}
    api('/admin/api/crm/contacts',{method:'POST',body:{company_id:id,full_name:$('dcName').value,job_title:$('dcTitle').value,email:$('dcEmail').value,whatsapp_or_phone:$('dcPhone').value}}).then(function(){toast('已添加联系人');openDetail(id);loadCompanies().then(renderStats);}).catch(function(err){toast(err.message,true);});
  }else if(act==='delContact'){
    if(!confirm('确定删除该联系人？'))return;
    api('/admin/api/crm/contacts/'+encodeURIComponent(id),{method:'DELETE'}).then(function(){toast('已删除');var mid=document.querySelector('#dBody [data-act="merge"]').getAttribute('data-id');openDetail(mid);}).catch(function(err){toast(err.message,true);});
  }else if(act==='mkPrimary'){
    api('/admin/api/crm/contacts/'+encodeURIComponent(id),{method:'PATCH',body:{is_primary:true}}).then(function(){var mid=document.querySelector('#dBody [data-act="merge"]').getAttribute('data-id');openDetail(mid);}).catch(function(err){toast(err.message,true);});
  }else if(act==='delDeal'){
    if(!confirm('确定删除该商机？'))return;
    api('/admin/api/crm/deals/'+encodeURIComponent(id),{method:'DELETE'}).then(function(){toast('已删除商机');var mid=document.querySelector('#dBody [data-act="merge"]').getAttribute('data-id');openDetail(mid);loadDeals().then(renderStats);}).catch(function(err){toast(err.message,true);});
  }else if(act==='addActivity'){
    if(!$('daSummary').value.trim()){toast('内容不能为空',true);return;}
    var body2={company_id:id,type:$('daType').value,summary:$('daSummary').value};
    if($('daDue').value&&body2.type==='task')body2.due_date=$('daDue').value;
    if(body2.type==='task'&&$('daOwner').value.trim())body2.owner=$('daOwner').value.trim();
    api('/admin/api/crm/activities',{method:'POST',body:body2}).then(function(){toast('已记录');openDetail(id);loadTasks().then(renderStats);}).catch(function(err){toast(err.message,true);});
  }else if(act==='recheckDomain'){
    toast('正在检测域名…');
    api('/admin/api/crm/companies/'+encodeURIComponent(id)+'/recheck-domain',{method:'POST'}).then(function(b){
      toast('域名检测：'+(DOMAIL_STATUS_L[b.check.verdict]||b.check.verdict));
      openDetail(id);loadDomains();
    }).catch(function(err){toast(err.message,true);});
  }else if(act==='recheckEmail'){
    toast('正在检测邮箱…');
    api('/admin/api/crm/contacts/'+encodeURIComponent(id)+'/recheck-email',{method:'POST'}).then(function(b){
      toast('邮箱检测：'+(DOMAIL_STATUS_L[b.check.verdict]||b.check.verdict));
      var mid=document.querySelector('#dBody [data-act="merge"]').getAttribute('data-id');
      openDetail(mid);loadDomains();
    }).catch(function(err){toast(err.message,true);});
  }else if(act==='checkSignals'){
    toast('正在搜索采购信号…');
    api('/admin/api/crm/companies/'+encodeURIComponent(id)+'/check-signals',{method:'POST'}).then(function(b2){
      toast('检查完成：新增信号 '+Number(b2.report.new_signals)+' 条'+(b2.report.tier_bumped?'，公司分级已上调 B':''));
      var mid=document.querySelector('#dBody [data-act="merge"]').getAttribute('data-id');
      openDetail(mid);loadSignals();
    }).catch(function(err){toast(err.message,true);});
  }else if(act==='linkDc'){
    var pick=document.querySelector('#dBody select[data-dcpick="'+id+'"]');
    var cid2=pick?pick.value:'';
    if(!cid2){toast('没有可关联的联系人',true);return;}
    api('/admin/api/crm/deals/'+encodeURIComponent(id)+'/contacts',{method:'POST',body:{contact_id:cid2}}).then(function(){
      toast('已关联到商机');
      var mid=document.querySelector('#dBody [data-act="merge"]').getAttribute('data-id');
      openDetail(mid);
    }).catch(function(err){toast(err.message,true);});
  }else if(act==='unlinkDc'){
    var cid3=b.getAttribute('data-cid');
    api('/admin/api/crm/deals/'+encodeURIComponent(id)+'/contacts/'+encodeURIComponent(cid3),{method:'DELETE'}).then(function(){
      toast('已解除关联');
      var mid=document.querySelector('#dBody [data-act="merge"]').getAttribute('data-id');
      openDetail(mid);
    }).catch(function(err){toast(err.message,true);});
  }else if(act==='mergeContact'){
    var src=$('cmSrc').value,tgt=$('cmTgt').value;
    if(!src||!tgt){toast('请选择要合并的两个联系人',true);return;}
    if(src===tgt){toast('来源与目标不能是同一个联系人',true);return;}
    if(!confirm('将把来源联系人并入目标联系人并删除来源（缺失字段自动补齐）。确定继续？'))return;
    api('/admin/api/crm/contacts/merge',{method:'POST',body:{target_contact_id:tgt,source_contact_id:src}}).then(function(){toast('联系人已合并');openDetail(id);loadCompanies().then(renderStats);}).catch(function(err){toast(err.message,true);});
  }else if(act==='enrollSeq'){
    var sid=$('dSeqPick').value;
    if(!sid){toast('请先选择一个序列',true);return;}
    api('/admin/api/crm/sequences/'+encodeURIComponent(sid)+'/enroll',{method:'POST',body:{company_id:id}}).then(function(r){toast(r.re_enrolled?'已重新入册：从头开始执行':'已加入序列，将按步骤天数自动跟进');loadSequences();}).catch(function(err){toast(err.message,true);});
  }else if(act==='merge'){
    var src=$('dMergeSrc').value;
    if(!src){toast('请先选择要并入的公司',true);return;}
    if(!confirm('将把所选公司的联系人、商机、动态全部并入本公司并删除所选公司（单事务、可溯源）。确定继续？'))return;
    api('/admin/api/crm/companies/merge',{method:'POST',body:{target_company_id:id,source_company_id:src}}).then(function(){toast('合并完成');loadAll();openDetail(id);}).catch(function(err){toast(err.message,true);});
  }
});
/* 角色下拉（⑦ 图谱）：切换即 PATCH 联系人 procurement_role。 */
$('dBody').addEventListener('change',function(e){
  var s=e.target;
  if(s.tagName==='SELECT'&&s.getAttribute('data-rolect')){
    api('/admin/api/crm/contacts/'+encodeURIComponent(s.getAttribute('data-rolect')),{method:'PATCH',body:{procurement_role:s.value}}).then(function(){toast('角色已更新');}).catch(function(err){toast(err.message,true);});
  }
});
document.querySelectorAll('.modal-back').forEach(function(m){
  m.addEventListener('click',function(e){if(e.target===m)m.classList.remove('open');});
});
document.querySelectorAll('[data-close]').forEach(function(b){
  b.addEventListener('click',function(){closeModal(b.getAttribute('data-close'));});
});

loadAll();
})();
</script></body></html>`;

/* ── WebAuthn 2FA pages (post-V2 Stage 29) ─────────────────────────────── */

/** The browser-facing MFA step, rendered when the master token checked out
 * but a WebAuthn credential is on file. The challenge payload rides in a
 * JSON data block (<script type="application/json"> — never executed, so
 * the CSP nonce set does not apply to it); the executable script drives
 * navigator.credentials.get() and offers the recovery-code form as the
 * fallback when no authenticator is available. */
function mfaChallengePage(mfa: MfaChallengePayload): string {
  // "<" is escaped in the JSON so a hostile value can never break out of the
  // data block; the payload itself is server-generated (UUID + base64url).
  const data = JSON.stringify(mfa).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>两步验证 - D1 CRM</title><style>
body{font-family:system-ui,sans-serif;background:#eef4fa;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#fff;padding:28px;border-radius:14px;box-shadow:0 8px 30px #123b6820;width:min(460px,calc(100% - 40px))}
h1{margin-top:0;color:#123b68;font-size:20px}label{display:block;font-weight:600;margin:16px 0 6px}
input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}
button{margin-top:14px;background:#1677d2;color:#fff;border:0;border-radius:8px;padding:12px 18px;cursor:pointer;font:inherit}
button.secondary{background:#475569}
.error{color:#b91c1c;min-height:20px;margin-top:10px;font-size:14px}
details{margin-top:18px}summary{cursor:pointer;color:#475569;font-size:14px}
.hint{font-size:12px;color:#7a8291;margin-top:8px}

/* stage30 auto: inline style -> class */
.s-fs14{font-size:14px}
.s-fs14-c334155{font-size:14px;color:#334155}
</style></head>
<body><main class="card">
<h1>🔐 两步验证</h1>
<p class="s-fs14-c334155">该账户已启用双因素认证。请使用安全密钥或通行密钥完成验证。</p>
<button id="authnBtn" type="button">使用安全密钥验证</button>
<div id="msg" class="error"></div>
<details><summary>无法使用安全密钥？使用恢复码</summary>
<label for="code">恢复码</label>
<input id="code" placeholder="xxxx-xxxx-xxxx-xxxx" autocomplete="off">
<button id="recoveryBtn" type="button" class="secondary">验证恢复码</button>
<p class="hint">每个恢复码只能使用一次。全部用完后请登录面板重新生成。</p>
</details>
</main>
<script type="application/json" id="mfaData">${data}</script>
<script>
(function(){
'use strict';
var mfa=JSON.parse(document.getElementById('mfaData').textContent);
var msg=document.getElementById('msg');
function b64uToU8(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var bin=atob(s);var u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u}
function u8ToB64u(u){var s='';for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
function post(path,body){return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return {status:r.status,body:j}})})}
document.getElementById('authnBtn').onclick=function(){
  msg.textContent='';
  var pk=mfa.public_key;
  var options={challenge:b64uToU8(pk.challenge),rpId:pk.rpId,timeout:pk.timeout,userVerification:pk.userVerification,allowCredentials:(pk.allowCredentials||[]).map(function(c){return {type:'public-key',id:b64uToU8(c.id),transports:c.transports}})};
  navigator.credentials.get({publicKey:options}).then(function(cred){
    var r=cred.response;
    return post('/admin/api/auth/mfa/assert',{
      flow_id:mfa.flow_id,
      credential_id:u8ToB64u(new Uint8Array(cred.rawId)),
      client_data_json:u8ToB64u(new Uint8Array(r.clientDataJSON)),
      authenticator_data:u8ToB64u(new Uint8Array(r.authenticatorData)),
      signature:u8ToB64u(new Uint8Array(r.signature))
    });
  }).then(function(res){
    if(res.status===200){location.href='/admin';return}
    msg.textContent=(res.body&&res.body.detail)||'验证失败，请重试';
  }).catch(function(e){
    if(e&&e.name==='NotAllowedError'){msg.textContent='操作已取消或无可用安全密钥 — 可改用下方恢复码';return}
    msg.textContent='验证失败：'+(e&&e.message?e.message:'未知错误');
  });
};
document.getElementById('recoveryBtn').onclick=function(){
  msg.textContent='';
  var code=document.getElementById('code').value;
  if(!code.trim()){msg.textContent='请输入恢复码';return}
  post('/admin/api/auth/mfa/recovery',{flow_id:mfa.flow_id,code:code}).then(function(res){
    if(res.status===200){location.href='/admin';return}
    msg.textContent=(res.body&&res.body.detail)||'恢复码无效';
  }).catch(function(e){msg.textContent='验证失败：'+(e&&e.message?e.message:'未知错误')});
};
})();
</script></body></html>`;
}

const SECURITY_PANEL_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>安全设置 - CRM</title><style>
body{font-family:system-ui,sans-serif;margin:0;background:#f3f5f9;color:#1f2430}
.top{background:#1f2430;color:#fff;padding:14px 24px;display:flex;justify-content:space-between;align-items:center}
.top h1{font-size:18px;margin:0}
.top a{color:#fff;text-decoration:none;background:rgba(255,255,255,.15);padding:8px 14px;border-radius:8px;font-weight:600;font-size:14px}
.wrap{max-width:1000px;margin:24px auto;padding:0 16px}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:20px;margin-bottom:20px}
h2{font-size:16px;margin:0 0 12px}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.btn{border:0;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px;font-weight:600;background:#3f9d63;color:#fff}
.btn.del{background:#fde8e8;color:#b23b3b}
.btn.gray{background:#8b93a3}
input{font:inherit;padding:7px 10px;border:1px solid #cbd5e1;border-radius:6px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f0f2f7;padding:8px;text-align:left;font-size:12px;color:#5a6270}
td{padding:8px;border-bottom:1px solid #eef1f6;vertical-align:top}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.badge{display:inline-block;border-radius:10px;padding:2px 10px;font-size:12px;font-weight:600;background:#dcfce7;color:#166534}
.badge.off{background:#e2e8f0;color:#475569}
#toast{position:fixed;top:18px;right:18px;background:#1f2430;color:#fff;padding:10px 16px;border-radius:8px;font-size:14px;display:none;max-width:420px;z-index:9}
#toast.err{background:#b23b3b}
.hint{font-size:12px;color:#7a8291;margin-top:6px}
#codeArea{width:100%;box-sizing:border-box;font-family:ui-monospace,Consolas,monospace;font-size:13px;padding:10px;border:1px solid #cbd5e1;border-radius:6px;margin-top:10px;display:none}
.warn{background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:10px 12px;font-size:13px;color:#92400e;margin-top:10px;display:none}

/* stage30 auto: inline style -> class */
.s-hidden{display:none}
.s-fs13{font-size:13px}
.s-mw220{min-width:220px}
.s-fs13-m0 0 10{font-size:13px;margin:0 0 10px}
</style></head><body>
<header class="top"><h1>🛡️ 安全设置</h1><a href="/admin">← 返回客户管理</a></header>
<div class="wrap">
<div class="card">
  <h2>双因素认证（WebAuthn / 通行密钥） <span id="statusBadge" class="badge off">未启用</span></h2>
  <div class="bar">
    <input id="credName" placeholder="名称备注（如 YubiKey 5C）" class="s-mw220">
    <button class="btn" id="addBtn">添加安全密钥</button>
    <button class="btn gray" id="refresh">刷新</button>
  </div>
  <table><thead><tr><th>名称</th><th>凭据 ID</th><th>添加时间 (UTC)</th><th>最近使用</th><th>传输方式</th><th></th></tr></thead>
  <tbody id="rows"><tr><td colspan="6">加载中…</td></tr></tbody></table>
  <p class="hint">启用后：登录需要「管理 Token + 安全密钥」两步验证；同时 <b>Bearer Token 直接调用 API 的方式将被禁用</b>（否则第二因子形同虚设）。移除最后一个凭据即恢复单因子登录。</p>
  <p class="hint">未配置 WEBAUTHN_RP_ID 时此功能处于休眠状态，添加按钮会返回 503。</p>
</div>
<div class="card">
  <h2>恢复码</h2>
  <p class="s-fs13-m0 0 10">安全密钥丢失时用于应急登录。每个恢复码仅可使用一次，当前可用：<b id="codesCount">—</b></p>
  <div class="bar"><button class="btn gray" id="regenBtn">重新生成恢复码</button><button class="btn gray s-hidden" id="copyBtn" >复制</button></div>
  <div id="codeWarn" class="warn">⚠️ 恢复码只在此时显示一次。请立即复制并离线妥善保管（密码管理器 / 打印件）。</div>
  <textarea id="codeArea" rows="6" readonly></textarea>
  <div id="codeMsg" class="hint"></div>
</div>
</div>
<div id="toast"></div>
<script>
(function(){
'use strict';
function esc(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function toast(msg,isErr){var t=document.getElementById('toast');t.textContent=msg;t.className=isErr?'err':'';t.style.display='block';setTimeout(function(){t.style.display='none'},3200)}
function api(path,init){return fetch(path,Object.assign({credentials:'same-origin'},init||{})).then(function(r){return r.json().then(function(body){if(!r.ok)throw new Error(body.detail||('HTTP '+r.status));return body})})}
function b64uToU8(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var bin=atob(s);var u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u}
function u8ToB64u(u){var s='';for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
function showCodes(codes){
  document.getElementById('codeArea').value=codes.join('\\n');
  document.getElementById('codeArea').style.display='block';
  document.getElementById('codeWarn').style.display='block';
  document.getElementById('copyBtn').style.display='inline-block';
  document.getElementById('codeMsg').textContent='';
}
function load(){
  api('/admin/api/auth/webauthn/credentials').then(function(body){
    var rows=body.credentials||[];
    var badge=document.getElementById('statusBadge');
    badge.textContent=body.two_factor_active?'已启用':'未启用';
    badge.className='badge'+(body.two_factor_active?'':' off');
    document.getElementById('codesCount').textContent=String(body.recovery_codes_remaining);
    var tb=document.getElementById('rows');
    if(!rows.length){tb.innerHTML='<tr><td colspan="6">尚未添加安全密钥</td></tr>';return}
    var html='';
    for(var i=0;i<rows.length;i++){
      var c=rows[i];
      html+='<tr><td>'+esc(c.name||'（未命名）')+'</td>'
        +'<td class="mono">'+esc(c.id.length>20?c.id.slice(0,20)+'…':c.id)+'</td>'
        +'<td class="mono">'+esc(c.created_at)+'</td>'
        +'<td class="mono">'+esc(c.last_used_at||'—')+'</td>'
        +'<td>'+esc(c.transports||'—')+'</td>'
        +'<td><button class="btn del" data-cid="'+esc(c.id)+'">移除</button></td></tr>';
    }
    tb.innerHTML=html;
    Array.prototype.forEach.call(tb.querySelectorAll('button[data-cid]'),function(b){
      b.onclick=function(){
        if(!confirm('确定移除该安全密钥？移除最后一个凭据将关闭双因素认证并恢复 Bearer 登录。'))return;
        api('/admin/api/auth/webauthn/credentials/'+encodeURIComponent(b.getAttribute('data-cid')),{method:'DELETE'})
        .then(function(body){toast(body.two_factor_active?'已移除':'已移除 — 双因素已关闭');load()})
        .catch(function(e){toast(e.message,true)});
      };
    });
  })
  .catch(function(e){toast(e.message,true)});
}
document.getElementById('refresh').onclick=load;
document.getElementById('addBtn').onclick=function(){
  var name=document.getElementById('credName').value;
  api('/admin/api/auth/webauthn/register/options',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})})
  .then(function(body){
    var pk=body.public_key;
    var options={
      rp:pk.rp,
      user:{id:new TextEncoder().encode(pk.user.id),name:pk.user.name,displayName:pk.user.displayName},
      challenge:b64uToU8(pk.challenge),
      pubKeyCredParams:pk.pubKeyCredParams,
      timeout:pk.timeout,
      attestation:pk.attestation,
      excludeCredentials:(pk.excludeCredentials||[]).map(function(c){return {type:'public-key',id:b64uToU8(c.id),transports:c.transports}}),
      authenticatorSelection:pk.authenticatorSelection
    };
    return navigator.credentials.create({publicKey:options}).then(function(cred){
      var r=cred.response;
      var transports=(r.getTransports&&r.getTransports())||[];
      return api('/admin/api/auth/webauthn/register/verify',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          flow_id:body.flow_id,
          client_data_json:u8ToB64u(new Uint8Array(r.clientDataJSON)),
          attestation_object:u8ToB64u(new Uint8Array(r.attestationObject)),
          transports:transports,
          name:name
        })
      });
    });
  })
  .then(function(body){
    toast('安全密钥已添加');
    if(body.recovery_codes)showCodes(body.recovery_codes);
    document.getElementById('credName').value='';
    load();
  })
  .catch(function(e){toast((e&&e.message)||'注册失败',true)});
};
document.getElementById('regenBtn').onclick=function(){
  if(!confirm('重新生成将作废现有全部恢复码（含未使用的）。确定继续？'))return;
  api('/admin/api/auth/webauthn/recovery/regenerate',{method:'POST'})
  .then(function(body){showCodes(body.recovery_codes);load()})
  .catch(function(e){toast(e.message,true)});
};
document.getElementById('copyBtn').onclick=function(){
  var text=document.getElementById('codeArea').value;
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){toast('已复制')},function(){toast('复制失败，请手动选择',true)});
  }else{
    document.getElementById('codeArea').select();
    document.execCommand('copy');
    toast('已复制');
  }
};
load();
})();
</script></body></html>`;



