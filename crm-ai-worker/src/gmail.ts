/* Gmail API email sending via Google Workspace service account with
 * domain-wide delegation (JWT bearer flow, RS256 signed with Web Crypto).
 *
 * Anti-ban principles:
 * - Daily send quota enforced in D1 (default 400/day, below Gmail's 500/day
 *   free Workspace limit and 2000/day for Workspace Business tiers).
 * - Per-request cooldown between sends (default 3s) to mimic human cadence.
 * - Access tokens are cached per service account until they expire.
 */

export interface GmailEnv {
  DB: D1Database;
  /** Service account private key in PEM format (BEGIN PRIVATE KEY). */
  GMAIL_SERVICE_ACCOUNT_KEY?: string;
  /** Service account email (…@….iam.gserviceaccount.com). */
  GMAIL_SERVICE_ACCOUNT_EMAIL?: string;
  /** Workspace mailbox to send from (impersonated via domain-wide delegation). */
  GMAIL_SENDER_EMAIL?: string;
  /** OAuth client ID for refresh-token pool accounts (no service-account keys needed). */
  GMAIL_OAUTH_CLIENT_ID?: string;
  /** OAuth client secret (empty for "installed app" type clients). */
  GMAIL_OAUTH_CLIENT_SECRET?: string;
  /** Optional daily send limit override (default 400). */
  GMAIL_DAILY_LIMIT?: string;
  /** Optional delay between sends in ms (default 3000). */
  GMAIL_SEND_DELAY_MS?: string;
}

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
/** Google's OAuth2 client for installed apps — the only public client allowed
 * to get a refresh token via the out-of-band loopback flow without a redirect
 * server. Only used to exchange refresh tokens, never for user login. */
const OAUTH_REFRESH_GRANT = "refresh_token";
const DEFAULT_DAILY_LIMIT = 400;
const DEFAULT_SEND_DELAY_MS = 3_000;
const TOKEN_SAFETY_WINDOW_MS = 60_000;
const EMAIL_ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/* ── Base64URL helpers ── */

function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlEncodeString(text: string): string {
  return b64urlEncode(new TextEncoder().encode(text));
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/* ── Service account JWT → access token ── */

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

export class GmailConfigError extends Error {}

export async function getAccessToken(
  env: GmailEnv,
  clientEmail: string,
  secret: string,
  senderEmail: string,
  credentialType: "service_account" | "oauth_refresh" = "service_account",
): Promise<string> {
  const cacheKey = `${credentialType}:${clientEmail}:${senderEmail}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + TOKEN_SAFETY_WINDOW_MS) {
    return cached.token;
  }

  if (credentialType === "oauth_refresh") {
    // Per-mailbox OAuth: the refresh token already carries the user consent;
    // just exchange it for a fresh access token.
    const clientId = env.GMAIL_OAUTH_CLIENT_ID?.trim();
    const clientSecret = env.GMAIL_OAUTH_CLIENT_SECRET?.trim() || "";
    if (!clientId) {
      throw new Error("缺少 GMAIL_OAUTH_CLIENT_ID Secret：OAuth 令牌账号需要配套的 OAuth 客户端 ID（面板/secrets 页可写）");
    }
    return await exchangeRefreshToken(clientEmail, secret, clientId, clientSecret);
  }

  const privateKeyPem = secret;
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncodeString(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlEncodeString(
    JSON.stringify({
      iss: clientEmail,
      sub: senderEmail, // domain-wide delegation impersonation
      scope: GMAIL_SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${b64urlEncode(signature)}`;

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!resp.ok) {
    const detail = (await resp.text()).replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`Gmail token 获取失败 HTTP ${resp.status}: ${detail}`);
  }
  const data = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Gmail token 响应缺少 access_token");
  const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  tokenCache.set(cacheKey, { token: data.access_token, expiresAt });
  return data.access_token;
}

/* Exchange an OAuth2 refresh token for an access token (per-mailbox accounts). */
async function exchangeRefreshToken(
  mailbox: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      refresh_token: refreshToken,
      grant_type: OAUTH_REFRESH_GRANT,
    }).toString(),
  });
  if (!resp.ok) {
    const detail = (await resp.text()).replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`OAuth refresh token 换取 access_token 失败（${mailbox}）HTTP ${resp.status}: ${detail}`);
  }
  const data = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error(`OAuth refresh token 响应缺少 access_token（${mailbox}）`);
  const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  tokenCache.set(`oauth_refresh:${mailbox}:${mailbox}`, { token: data.access_token, expiresAt });
  return data.access_token;
}

/* ── RFC 2822 MIME message ── */

function escapeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeMimeHeaderWord(value: string): string {
  // RFC 2047 encoded-word for non-ASCII subject lines
  if (/^[\x20-\x7E]*$/.test(value)) return escapeHeader(value);
  const bytes = new TextEncoder().encode(value);
  return `=?UTF-8?B?${b64urlEncode(bytes).replace(/-/g, "+").replace(/_/g, "/")}?=`;
}

export interface MimeAttachment {
  filename: string;
  mimeType: string;
  /** Raw file bytes. */
  data: Uint8Array;
}

function wrap76(b64: string): string {
  return b64.replace(/(.{76})/g, "$1\r\n");
}

function encodeWordIfNeeded(value: string): string {
  // Filenames with non-ASCII need RFC 2047 encoding. Remove control
  // characters and quote delimiters before placing the value in MIME headers.
  const safe = value.replace(/[\r\n\x00-\x1F\x7F]+/g, " ").replace(/["\\]/g, "_").trim();
  return /^[\x20-\x7E]*$/.test(safe) ? safe : encodeMimeHeaderWord(safe);
}

export function buildMime(options: {
  from: string; // plain address, or "Display Name <addr@…>"
  to: string;
  subject: string;
  body: string;
  attachments?: MimeAttachment[];
}): string {
  // Accept either a bare address or a "Display Name <addr>" combo.
  const combo = /^(.*)<([^>]+)>$/.exec(options.from.trim());
  const fromAddr = combo ? combo[2].trim() : options.from.trim();
  const fromName = combo ? combo[1].trim().replace(/^"|"$/g, "") : "";
  const fromHeader = fromName
    ? `${encodeMimeHeaderWord(fromName)} <${fromAddr}>`
    : fromAddr;
  const commonHeaders = [
    `From: ${fromHeader}`,
    `To: ${escapeHeader(options.to)}`,
    `Subject: ${encodeMimeHeaderWord(options.subject)}`,
    "MIME-Version: 1.0",
  ];
  const bodyB64 = wrap76(
    btoa(Array.from(new TextEncoder().encode(options.body)).map((b) => String.fromCharCode(b)).join("")),
  );

  const attachments = options.attachments ?? [];
  if (attachments.length === 0) {
    const headers = [
      ...commonHeaders,
      `Content-Type: text/plain; charset="UTF-8"`,
      "Content-Transfer-Encoding: base64",
    ];
    return `${headers.join("\r\n")}\r\n\r\n${bodyB64}\r\n`;
  }

  // multipart/mixed: text part + attachment parts
  const boundary = `bnd_${crypto.randomUUID().replace(/-/g, "")}`;
  const parts: string[] = [
    ...commonHeaders,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    bodyB64,
  ];
  for (const att of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.mimeType}; name="${encodeWordIfNeeded(att.filename)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${encodeWordIfNeeded(att.filename)}"`,
      "",
      wrap76(btoa(Array.from(att.data).map((b) => String.fromCharCode(b)).join(""))),
    );
  }
  parts.push(`--${boundary}--`, "");
  return parts.join("\r\n");
}

/* ── Gmail sender account pool (panel-managed, D1) ──
 * Multiple service accounts with domain-wide delegation. Pick order:
 *   1. The account a brand is explicitly bound to (outreach_settings.gmail_account)
 *   2. Env secret GMAIL_SERVICE_ACCOUNT_* (legacy single-account setup)
 *   3. The healthy pool account with the most remaining quota today (spreads load)
 * Accounts rejected by Google (401/403/invalid key) enter a 6h cooldown so the
 * batch never hammers a dead account.
 */

export interface PoolAccount {
  id: number;
  label: string | null;
  credential_type: string | null; // 'service_account' | 'oauth_refresh' | NULL(legacy)
  client_email: string;
  private_key: string;
  delegated_domain: string | null;
  daily_limit: number | null;
  enabled: number;
  last_error: string | null;
  cooldown_until: string | null;
}

const ACCOUNT_COOLDOWN_MS = 6 * 3600 * 1000;

let gmailAccountsEnsured = false;
async function ensureGmailAccountsTable(env: GmailEnv): Promise<void> {
  if (gmailAccountsEnsured) return;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS gmail_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT,
        client_email TEXT NOT NULL UNIQUE,
        private_key TEXT NOT NULL,
        delegated_domain TEXT,
        daily_limit INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        last_error TEXT,
        cooldown_until TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
    ).run();
  } catch { /* best-effort; schema.sql creates it on deploy */ }
  // credential_type was added when OAuth refresh-token accounts were introduced;
  // older deployments only have the service-account kind.
  try {
    await env.DB.prepare("ALTER TABLE gmail_accounts ADD COLUMN credential_type TEXT DEFAULT 'service_account'").run();
  } catch { /* column exists */ }
  gmailAccountsEnsured = true;
}

async function listPoolAccounts(env: GmailEnv, onlyEnabled = false): Promise<PoolAccount[]> {
  await ensureGmailAccountsTable(env);
  try {
    const rows = await env.DB.prepare(
      `SELECT id, label, credential_type, client_email, private_key, delegated_domain, daily_limit,
              enabled, last_error, cooldown_until
       FROM gmail_accounts ${onlyEnabled ? "WHERE enabled = 1" : ""} ORDER BY id`,
    ).all<PoolAccount>();
    return (rows.results ?? []).map((r) => ({ ...r, credential_type: r.credential_type || "service_account" }));
  } catch {
    return [];
  }
}

export interface ChosenAccount {
  clientEmail: string; // service account email, or From mailbox for oauth_refresh
  privateKeyPem: string; // PEM private key, or refresh token for oauth_refresh
  credentialType: "service_account" | "oauth_refresh";
  senderEmail: string;
  source: "pool" | "env" | "brand-binding";
}

/* Resolve which service account + From mailbox to use for one send. */
export async function chooseGmailAccount(
  env: GmailEnv,
  fromEmail?: string | null,
  brandGmailAccount?: string | null,
): Promise<ChosenAccount> {
  const accounts = await listPoolAccounts(env, true);
  const healthy = accounts.filter(
    (a) => !a.cooldown_until || new Date(a.cooldown_until).getTime() < Date.now(),
  );

  // 1. Brand binding: use that account as long as it exists and is healthy.
  if (brandGmailAccount?.trim()) {
    const bound = healthy.find((a) => a.client_email === brandGmailAccount.trim())
      ?? accounts.find((a) => a.client_email === brandGmailAccount.trim());
    if (bound) {
      return toChosen(bound, fromEmail, "brand-binding");
    }
  }

  // 2. Legacy env-secret service account.
  const envCfg = requireGmailConfig(env);
  if (envCfg) {
    return { clientEmail: envCfg.clientEmail, privateKeyPem: envCfg.privateKeyPem, credentialType: "service_account", senderEmail: fromEmail?.trim() || envCfg.senderEmail, source: "env" };
  }

  // 3. Pool fallback: the healthy enabled account with the most remaining quota.
  if (healthy.length > 0) {
    let best = healthy[0];
    let bestRemaining = -1;
    for (const acc of healthy) {
      const remaining = await accountRemainingQuota(env, acc);
      if (remaining > bestRemaining) {
        best = acc;
        bestRemaining = remaining;
      }
    }
    return toChosen(best, fromEmail, "pool");
  }

  throw new GmailConfigError("没有可用的 Gmail 发信账号：请在面板添加发信账号（OAuth 令牌或服务账号）");
}

/* oauth_refresh accounts send FROM their own mailbox; service accounts need a
 * delegated From (brand setting or env GMAIL_SENDER_EMAIL). */
function toChosen(acc: PoolAccount, fromEmail: string | null | undefined, source: ChosenAccount["source"]): ChosenAccount {
  const type = acc.credential_type === "oauth_refresh" ? "oauth_refresh" : "service_account";
  const sender = type === "oauth_refresh"
    ? acc.client_email // From is fixed to the authorized mailbox
    : fromEmail?.trim() || acc.client_email;
  return { clientEmail: acc.client_email, privateKeyPem: acc.private_key, credentialType: type, senderEmail: sender, source };
}

function requireGmailConfig(env: GmailEnv): { clientEmail: string; privateKeyPem: string; senderEmail: string } | null {
  const clientEmail = env.GMAIL_SERVICE_ACCOUNT_EMAIL?.trim();
  const privateKeyPem = env.GMAIL_SERVICE_ACCOUNT_KEY?.trim();
  const senderEmail = env.GMAIL_SENDER_EMAIL?.trim();
  if (!clientEmail || !privateKeyPem || !senderEmail) return null;
  if (!privateKeyPem.includes("PRIVATE KEY")) return null;
  if (!EMAIL_ADDRESS_RE.test(senderEmail)) return null;
  return { clientEmail, privateKeyPem, senderEmail };
}

/* Remaining send quota for one pool account (counts its own From mailboxes). */
export async function accountRemainingQuota(env: GmailEnv, acc: PoolAccount): Promise<number> {
  const limit = acc.daily_limit && acc.daily_limit > 0 ? acc.daily_limit : dailyLimit(env);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM gmail_send_log
     WHERE date(sent_at) = date('now') AND status = 'sent' AND sender_client_email = ?`,
  ).bind(acc.client_email).first<{ cnt: number }>();
  return Math.max(0, limit - (row?.cnt ?? 0));
}

/* Mark a pool account as failed (cooldown) or healthy after a send attempt. */
export async function noteGmailAccountResult(
  env: GmailEnv,
  clientEmail: string,
  ok: boolean,
  error?: string,
): Promise<void> {
  if (!ok && error) {
    const permanent = /HTTP (40[013]|400)/.test(error) || /invalid_grant|Invalid .*key|unauthorized_client/i.test(error);
    if (permanent) {
      await env.DB.prepare(
        `UPDATE gmail_accounts SET last_error = ?, cooldown_until = datetime('now', '+6 hours'), updated_at = CURRENT_TIMESTAMP WHERE client_email = ?`,
      ).bind(error.slice(0, 500), clientEmail).run().catch(() => {});
    } else {
      await env.DB.prepare(
        `UPDATE gmail_accounts SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE client_email = ?`,
      ).bind(error.slice(0, 500), clientEmail).run().catch(() => {});
    }
  } else if (ok) {
    await env.DB.prepare(
      `UPDATE gmail_accounts SET last_error = NULL, cooldown_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE client_email = ?`,
    ).bind(clientEmail).run().catch(() => {});
  }
}

/* ── Daily quota tracking (D1) ── */

function dailyLimit(env: GmailEnv): number {
  const parsed = Number(env.GMAIL_DAILY_LIMIT);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_LIMIT;
}

export function sendDelayMs(env: GmailEnv): number {
  const parsed = Number(env.GMAIL_SEND_DELAY_MS);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_SEND_DELAY_MS;
}

export interface QuotaInfo {
  sent_today: number;
  daily_limit: number;
  remaining: number;
}

export async function getQuota(env: GmailEnv): Promise<QuotaInfo> {
  // Aggregate view: each pool account contributes its own daily limit; when no
  // pool accounts exist the single env-secret limit is reported as before.
  const accounts = await listPoolAccounts(env, true);
  const totalLimit = accounts.length > 0
    ? accounts.reduce((sum, a) => sum + (a.daily_limit && a.daily_limit > 0 ? a.daily_limit : dailyLimit(env)), 0)
    : dailyLimit(env);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM gmail_send_log
     WHERE date(sent_at) = date('now') AND status = 'sent'`,
  ).first<{ cnt: number }>();
  const sentToday = row?.cnt ?? 0;
  return { sent_today: sentToday, daily_limit: totalLimit, remaining: Math.max(0, totalLimit - sentToday) };
}

async function assertQuota(env: GmailEnv): Promise<void> {
  const quota = await getQuota(env);
  if (quota.remaining <= 0) {
    throw new Error(`今日 Gmail 发送配额已用完（${quota.daily_limit} 封/天），明天再试、调高 GMAIL_DAILY_LIMIT 或在面板添加更多发信账号`);
  }
}

async function logSend(env: GmailEnv, emailId: number, to: string, status: string, detail: string | null, senderClientEmail: string | null): Promise<void> {
  await ensureSendLogSenderColumn(env);
  await env.DB.prepare(
    `INSERT INTO gmail_send_log (outreach_email_id, recipient, status, detail, sender_client_email) VALUES (?, ?, ?, ?, ?)`,
  ).bind(emailId, to, status, detail?.slice(0, 500) ?? null, senderClientEmail).run();
}

/* Older deployments have a gmail_send_log without the per-account column. */
let sendLogSenderEnsured = false;
async function ensureSendLogSenderColumn(env: GmailEnv): Promise<void> {
  if (sendLogSenderEnsured) return;
  try {
    await env.DB.prepare("ALTER TABLE gmail_send_log ADD COLUMN sender_client_email TEXT").run();
  } catch { /* column exists */ }
  sendLogSenderEnsured = true;
}

/* ── Send one email via Gmail API ── */

export interface SendResult {
  ok: boolean;
  gmail_message_id?: string;
  error?: string;
}

/* The attachments table originally had no language column; ALTER it in on
 * first use so older deployments keep working without a manual migration.
 * Runs at most once per isolate. */
let attachmentLangEnsured = false;
async function ensureAttachmentLanguageColumn(env: GmailEnv): Promise<void> {
  if (attachmentLangEnsured) return;
  try {
    await env.DB.prepare("ALTER TABLE outreach_attachments ADD COLUMN language TEXT").run();
  } catch {
    // Column already exists (or table not created yet) — safe to ignore.
  }
  attachmentLangEnsured = true;
}

/* Load attachments for one email. Attachments tagged with the recipient's
 * language (e.g. "es" for a Spanish customer) always match; attachments
 * tagged "all" are universal and match every language. Rows with NULL/empty
 * language predate the language column and are treated as "all" so nothing
 * that used to be attached disappears. When several per-language files exist
 * the most recently uploaded wins. */
async function loadBrandAttachments(
  env: GmailEnv,
  brandName: string,
  language: string,
): Promise<MimeAttachment[]> {
  await ensureAttachmentLanguageColumn(env);
  const attachments: MimeAttachment[] = [];
  try {
    const attRows = await env.DB.prepare(
      `SELECT filename, mime_type, content_base64, language FROM outreach_attachments
       WHERE brand_name = ? AND (language = ? OR language = 'all' OR language IS NULL OR language = '')
       ORDER BY CASE WHEN language = ? THEN 1 WHEN language = 'all' THEN 2 ELSE 3 END, created_at DESC
       LIMIT 5`,
    ).bind(brandName, language, language).all<{ filename: string; mime_type: string; content_base64: string; language: string | null }>();
    const seen = new Set<string>();
    for (const a of attRows.results ?? []) {
      if (seen.has(a.filename)) continue; // dedupe (e.g. same file uploaded twice)
      seen.add(a.filename);
      if (a.content_base64.length > 1_900_000) continue; // stay below D1's 2 MB row limit
      const binary = atob(a.content_base64);
      attachments.push({
        filename: a.filename,
        mimeType: /^[\w.+-]+\/[\w.+-]+$/.test(a.mime_type) ? a.mime_type : "application/octet-stream",
        data: Uint8Array.from(binary, (ch) => ch.charCodeAt(0)),
      });
    }
  } catch { /* attachments are best-effort; table may not exist yet */ }
  return attachments;
}

export async function sendOutreachEmail(
  env: GmailEnv,
  email: { id: number; email_to: string; subject: string | null; body: string | null },
  options?: { /** Per-brand sender mailbox (must be a Workspace user covered by the delegation). */
    fromEmail?: string | null;
    /** Optional display name for the From header (e.g. "Toby | Afarer Team"). */
    fromName?: string | null;
    /** Brand whose stored attachments should be attached. */
    brandName?: string | null;
    /** Recipient's language code (e.g. "es") used to pick language-tagged catalogs. */
    attachmentLanguage?: string | null;
    /** Brand-bound service account (gmail_accounts.client_email); empty = auto-pick. */
    gmailAccount?: string | null; },
): Promise<SendResult> {
  if (!email.email_to) return { ok: false, error: "收件人为空" };
  if (!email.subject || !email.body) return { ok: false, error: "主题或正文为空" };

  await assertQuota(env);

  // Resolve the sending service account: brand binding → env secret → healthiest pool account.
  let account: ChosenAccount;
  try {
    account = await chooseGmailAccount(env, options?.fromEmail, options?.gmailAccount);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const senderEmail = account.senderEmail;
  if (!EMAIL_ADDRESS_RE.test(senderEmail)) {
    return { ok: false, error: "发件邮箱无效" };
  }
  const fromDisplay = options?.fromName?.trim();
  let token: string;
  try {
    token = await getAccessToken(env, account.clientEmail, account.privateKeyPem, senderEmail, account.credentialType);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await noteGmailAccountResult(env, account.clientEmail, false, msg);
    return { ok: false, error: `发信账号 ${account.clientEmail} 获取 token 失败：${msg}` };
  }

  // Load the brand's attachments for the recipient's language (per-language
  // catalogs always win over universal ones).
  const attachments: MimeAttachment[] = [];
  if (options?.brandName) {
    const lang = options.attachmentLanguage?.trim().toLowerCase() || "en";
    attachments.push(...await loadBrandAttachments(env, options.brandName, lang));
  }

  const mime = buildMime({
    from: fromDisplay ? `${fromDisplay} <${senderEmail}>` : senderEmail,
    to: email.email_to,
    subject: email.subject,
    body: email.body,
    attachments,
  });

  const resp = await fetch(GMAIL_SEND_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: b64urlEncodeString(mime) }),
  });

  if (!resp.ok) {
    const detail = (await resp.text()).replace(/\s+/g, " ").slice(0, 300);
    await logSend(env, email.id, email.email_to, "failed", `HTTP ${resp.status}: ${detail}`, account.clientEmail);
    await noteGmailAccountResult(env, account.clientEmail, false, `HTTP ${resp.status}: ${detail}`);
    // 429 = Gmail rate limit: surface a clear message so the panel can back off
    return { ok: false, error: `HTTP ${resp.status}: ${detail}` };
  }

  const data = (await resp.json()) as { id?: string };
  await logSend(env, email.id, email.email_to, "sent", null, account.clientEmail);
  await noteGmailAccountResult(env, account.clientEmail, true);
  await env.DB.prepare(
    `UPDATE outreach_emails SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).bind(email.id).run();
  return { ok: true, gmail_message_id: data.id };
}
