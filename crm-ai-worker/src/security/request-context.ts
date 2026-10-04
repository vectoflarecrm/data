/* Security V2 Stage 20 (spec §21) — request id / traceability.
 *
 * Every admin/API request gets one UUID (minted in handleAdminRequest,
 * never accepted from the client) that is:
 *  - returned as the X-Request-ID response header on every response,
 *  - written into audit_logs.request_id for every audit row produced while
 *    serving that request (auditAdminAction picks it up from here),
 *  - used by internalErrorResponse, so a 500's body request_id matches the
 *    header and the safeLog'd error line.
 *
 * Carrier: a WeakMap keyed by the Request object. The Request instance is
 * the one object every layer already has in hand, the key dies with the
 * request (no cross-request leakage, GC-friendly), and no function
 * signature in the call tree had to change. Workers isolates handle
 * requests concurrently, so NO module-scoped mutable "current id" variable
 * would be safe — the WeakMap per-Request keying is what makes this
 * concurrency-correct.
 */

const requestIds = new WeakMap<Request, string>();

export function setRequestId(request: Request, id: string): void {
  requestIds.set(request, id);
}

/** The id minted for this request, or null for cron/system contexts. */
export function getRequestId(request: Request | null): string | null {
  return request ? (requestIds.get(request) ?? null) : null;
}
