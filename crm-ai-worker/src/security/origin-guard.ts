/*
 * Security V2 Stage 6 — Origin guard (CSRF defense-in-depth on top of
 * SameSite=Strict cookies).
 *
 * The session cookie is already SameSite=Strict, which stops modern browsers
 * from attaching it on cross-site requests. This module adds the second,
 * independent layer the spec asks for: every state-changing /admin request
 * (POST/PUT/PATCH/DELETE) must carry a same-origin `Origin` header — or no
 * Origin at all. A foreign origin is rejected before routing, auth, or any
 * side effect runs.
 *
 * Missing-Origin policy (deliberate, per spec §7.1 "明确处理"):
 * allowed. Browsers that enforce SameSite also always send `Origin` on
 * non-GET requests (Fetch spec), so an Origin-less state-changing request
 * cannot be an ambient-cookie browser request; it is a non-browser client
 * (curl, scripts, tests) whose credentials are explicit (Bearer header or
 * body token) and therefore not CSRF-able. `Referer` is deliberately not
 * consulted: this Worker answers with `Referrer-Policy: no-referrer`, so its
 * own panel sends no Referer — Origin is the only header that survives our
 * own policy.
 *
 * Literal-"null" policy (2026-10-13 amendment, operator decision): the
 * serialized opaque origin "null" is allowed, exactly like a missing Origin.
 * The operator's production browser serializes its form-POST Origin as the
 * literal "null" (opaque-origin Chromium shell) and worked before Security
 * V2 introduced this gate; rejecting it locked the operator out of the
 * panel. Risk bound: the session cookie stays SameSite=Strict, so a
 * cross-site opaque context cannot attach it — the primary CSRF layer
 * holds. Every other foreign or unparseable Origin value is still rejected.
 */

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Returns a 403 response when the request is state-changing and carries a
 * foreign Origin; null when the request may proceed.
 */
export function originGuardRejection(request: Request): Response | null {
  if (!STATE_CHANGING.has(request.method)) return null;
  const origin = request.headers.get("Origin");
  // Missing Origin and the literal opaque "null" are both allowed — see the
  // policy notes above (non-browser clients; opaque-origin browser clients).
  if (origin === null || origin === "null") return null;
  let originNormalized: string | null = origin;
  try {
    originNormalized = new URL(origin).origin;
  } catch {
    return forbidden(origin);
  }
  let ownOrigin: string;
  try {
    ownOrigin = new URL(request.url).origin;
  } catch {
    // Without a parseable URL we cannot prove same-origin: fail closed.
    return forbidden(origin);
  }
  if (originNormalized !== ownOrigin) return forbidden(origin);
  return null;
}

function forbidden(origin: string): Response {
  return new Response(
    JSON.stringify({ detail: `已拒绝跨域请求（Origin 不匹配：${origin}）` }),
    {
      status: 403,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Vary": "Origin",
      },
    },
  );
}
