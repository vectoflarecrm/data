/*
 * Security V2 Stage 5 — uniform security headers on every admin response.
 *
 * The panel is the most exposed surface this Worker serves: operator-entered
 * labels, upstream provider error strings and AI model names all end up
 * rendered there, so every response produced by handleAdminRequest leaves
 * through applySecurityHeaders() and carries the same baseline:
 *   - X-Content-Type-Options / X-Frame-Options / Referrer-Policy
 *   - Permissions-Policy (no camera / microphone / geolocation)
 *   - HSTS (Workers terminate TLS; browsers cache it for a year)
 *   - Content-Security-Policy: nonce-based for HTML, deny-all for the rest
 */

/** Headers applied verbatim to every admin response. */
const STATIC_SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "no-referrer"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
  ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
];

/**
 * CSP for HTML responses. htmlResponse() rewrites every inline
 * <script>/<style> tag to carry `nonce="…"`, so script-src and style-src
 * need neither 'unsafe-inline' nor 'unsafe-eval'.
 *
 * Stage 30 removed style-src-attr 'unsafe-inline': the admin panels no
 * longer emit any style="" attribute (static styles moved to classes,
 * dynamic widths are applied via CSSOM el.style.width, which CSP does not
 * restrict). Inline event handlers were never allowed (script-src has no
 * 'unsafe-inline'), and the last onclick="" remnant was converted to an
 * event delegation listener in stage 30 as well.
 */
export function htmlCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * CSP for non-HTML payloads (JSON, plain-text 404s): nothing may load
 * anything, nothing may frame it. Used as the fail-closed fallback for any
 * response that reaches the wrapper without an explicit CSP — including an
 * HTML body that somehow bypassed htmlResponse(); a nonce policy would break
 * its un-nonces scripts, and broken-but-safe beats working-but-unpinned.
 */
export function jsonCsp(): string {
  return "default-src 'none'; frame-ancestors 'none'";
}

function contentTypeIsHtml(response: Response): boolean {
  return (response.headers.get("Content-Type") || "").toLowerCase().includes("text/html");
}

/**
 * Merge the stage-5 header set onto a response, in place.
 *
 * Safe to mutate: every response this module builds comes from
 * `new Response(...)` (headers carry the fetch-spec "response" guard, which
 * allows setting these names), and no Response.redirect() is used. Headers
 * already present on the response win — htmlResponse() sets the nonce-bearing
 * CSP before this runs and must not be clobbered.
 */
export function applySecurityHeaders(response: Response): Response {
  for (const [name, value] of STATIC_SECURITY_HEADERS) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "no-store");
  if (!response.headers.has("Content-Security-Policy")) {
    response.headers.set("Content-Security-Policy", jsonCsp());
  } else if (contentTypeIsHtml(response) && !response.headers.get("Content-Security-Policy")?.includes("'nonce-")) {
    // HTML that carries a CSP without a nonce means the body was not run
    // through htmlResponse()'s rewrite; fail closed rather than guessing.
    response.headers.set("Content-Security-Policy", jsonCsp());
  }
  return response;
}
