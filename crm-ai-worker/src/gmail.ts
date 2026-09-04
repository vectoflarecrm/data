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
  /** Optional daily send limit override (default 400). */
  GMAIL_DAILY_LIMIT?: string;
  /** Optional delay between sends in ms (default 3000). */
  GMAIL_SEND_DELAY_MS?: string;
}

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
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

function requireGmailConfig(env: GmailEnv): {
  clientEmail: string;
  privateKeyPem: string;
  senderEmail: string;
} {
  const clientEmail = env.GMAIL_SERVICE_ACCOUNT_EMAIL?.trim();
  const privateKeyPem = env.GMAIL_SERVICE_ACCOUNT_KEY?.trim();
  const senderEmail = env.GMAIL_SENDER_EMAIL?.trim();
  if (!clientEmail || !privateKeyPem || !senderEmail) {
    throw new GmailConfigError(
      "Gmail 未配置：需要 GMAIL_SERVICE_ACCOUNT_EMAIL、GMAIL_SERVICE_ACCOUNT_KEY、GMAIL_SENDER_EMAIL 三个 Secret",
    );
  }
  if (!privateKeyPem.includes("PRIVATE KEY")) {
    throw new GmailConfigError("GMAIL_SERVICE_ACCOUNT_KEY 必须是 PEM 格式私钥（-----BEGIN PRIVATE KEY-----）");
  }
  if (!EMAIL_ADDRESS_RE.test(senderEmail)) {
    throw new GmailConfigError("GMAIL_SENDER_EMAIL 必须是有效的邮箱地址");
  }
  return { clientEmail, privateKeyPem, senderEmail };
}

async function getAccessToken(env: GmailEnv, clientEmail: string, privateKeyPem: string, senderEmail: string): Promise<string> {
  const cacheKey = `${clientEmail}:${senderEmail}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + TOKEN_SAFETY_WINDOW_MS) {
    return cached.token;
  }

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
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM gmail_send_log
     WHERE date(sent_at) = date('now') AND status = 'sent'`,
  ).first<{ cnt: number }>();
  const sentToday = row?.cnt ?? 0;
  const limit = dailyLimit(env);
  return { sent_today: sentToday, daily_limit: limit, remaining: Math.max(0, limit - sentToday) };
}

async function assertQuota(env: GmailEnv): Promise<void> {
  const quota = await getQuota(env);
  if (quota.remaining <= 0) {
    throw new Error(`今日 Gmail 发送配额已用完（${quota.daily_limit} 封/天），明天再试或调高 GMAIL_DAILY_LIMIT`);
  }
}

async function logSend(env: GmailEnv, emailId: number, to: string, status: string, detail: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO gmail_send_log (outreach_email_id, recipient, status, detail) VALUES (?, ?, ?, ?)`,
  ).bind(emailId, to, status, detail?.slice(0, 500) ?? null).run();
}

/* ── Send one email via Gmail API ── */

export interface SendResult {
  ok: boolean;
  gmail_message_id?: string;
  error?: string;
}

export async function sendOutreachEmail(
  env: GmailEnv,
  email: { id: number; email_to: string; subject: string | null; body: string | null },
  options?: { /** Per-brand sender mailbox (must be a Workspace user covered by the delegation). */
    fromEmail?: string | null;
    /** Optional display name for the From header (e.g. "Toby | Afarer Team"). */
    fromName?: string | null;
    /** Brand whose stored attachments should be attached. */
    brandName?: string | null; },
): Promise<SendResult> {
  const { clientEmail, privateKeyPem, senderEmail: defaultSender } = requireGmailConfig(env);
  if (!email.email_to) return { ok: false, error: "收件人为空" };
  if (!email.subject || !email.body) return { ok: false, error: "主题或正文为空" };

  await assertQuota(env);

  const senderEmail = options?.fromEmail?.trim() || defaultSender;
  if (!EMAIL_ADDRESS_RE.test(senderEmail)) {
    return { ok: false, error: "发件邮箱无效" };
  }
  const fromDisplay = options?.fromName?.trim();
  const token = await getAccessToken(env, clientEmail, privateKeyPem, senderEmail);

  // Load the brand's attachments (cap: 3 files, 4 MB each) for the email.
  const attachments: MimeAttachment[] = [];
  if (options?.brandName) {
    try {
      const attRows = await env.DB.prepare(
        `SELECT filename, mime_type, content_base64 FROM outreach_attachments
         WHERE brand_name = ? ORDER BY created_at LIMIT 5`,
      ).bind(options.brandName).all<{ filename: string; mime_type: string; content_base64: string }>();
      for (const a of attRows.results ?? []) {
        if (a.content_base64.length > 1_900_000) continue; // stay below D1's 2 MB row limit
        const binary = atob(a.content_base64);
        attachments.push({
          filename: a.filename,
          mimeType: /^[\w.+-]+\/[\w.+-]+$/.test(a.mime_type) ? a.mime_type : "application/octet-stream",
          data: Uint8Array.from(binary, (ch) => ch.charCodeAt(0)),
        });
      }
    } catch { /* attachments are best-effort; table may not exist yet */ }
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
    await logSend(env, email.id, email.email_to, "failed", `HTTP ${resp.status}: ${detail}`);
    // 429 = Gmail rate limit: surface a clear message so the panel can back off
    return { ok: false, error: `HTTP ${resp.status}: ${detail}` };
  }

  const data = (await resp.json()) as { id?: string };
  await logSend(env, email.id, email.email_to, "sent", null);
  await env.DB.prepare(
    `UPDATE outreach_emails SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).bind(email.id).run();
  return { ok: true, gmail_message_id: data.id };
}
