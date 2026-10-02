# Stage 2 Report — Role-Based Access Control

Branch: `feature/security-v2` · Follows: Stage 1 (auth sessions)

## Files Added
- `src/auth/rbac.ts` — the whole RBAC module: `AdminRole` (super_admin / operator / researcher / sender / readonly), 15 `Permission` values, the `ROLE_PERMISSIONS` matrix, `roleHasPermission()` (unknown roles fail closed) and `requiredPermission(url, method)` (route → permission mapping).
- `tests/rbac.test.ts` — 13 tests.

## Files Changed
- `src/admin.ts` — one import; a central authorization gate in `handleAdminRequest`; `/admin/secrets` page redirect for non-super_admin; removed the 5 per-route `authenticate()` calls the gate replaces.

## Design
- **Server-side only.** Enforcement lives in a single choke point in `handleAdminRequest`: every `/admin/api/*` request (except the `/admin/api/auth/*` lifecycle routes handled earlier, which `requiredPermission` also maps to `null` as defense-in-depth) authenticates once, then `requiredPermission(url, method)` decides the needed permission; a role without it gets `403 {detail}` naming the missing permission. Panel-side button hiding is UX, never a control.
- **Method-aware mapping.** Same path can read or mutate: `GET /admin/api/keys*` → `providers.read` vs any mutation → `providers.write`; `GET /admin/api/customers*` → `customers.read` vs POST/PATCH → `customers.write`; campaign subroutes split `campaigns.read/write` with `POST /campaigns/:id/send` → `outreach.send`.
- **Special cases encoded from the route inventory:** `GET /admin/api/customers/pre-filter?action=queue` re-queues rows for research ⇒ `research.run` (plain pre-filter stays `customers.read`); `POST /admin/api/gmail/accounts/:id/test` drives a real send ⇒ `outreach.send`; `/admin/api/keys/encrypt-all` + `/admin/api/keys/encryption-key` + `/admin/api/gmail/encrypt-all` ⇒ `credentials.write`; everything under `/admin/api/secrets*` ⇒ `secrets.write`.
- **Unknown roles fail closed** (`isAdminRole` gate inside `roleHasPermission`) — a hand-edited DB role string grants nothing.
- **No route lost auth:** the gate authenticates every `/admin/api/*` path even where `requiredPermission` returns `null` (unknown paths keep the old 404).
- **Bearer bootstrap** maps to synthetic super_admin (unchanged from Stage 1) — scripts/migrations keep full access.

### Matrix (verbatim from the stage spec)
| Role | Grants |
|---|---|
| super_admin | all 15 permissions |
| operator | customers r/w · research read/run · campaigns r/w · outreach read/generate |
| researcher | customers.read · research read/run |
| sender | customers.read · outreach.read · outreach.send |
| readonly | all 7 read permissions |

## Page-level behavior
- `/admin/secrets` (page): non-super_admin is redirected 303 to `/admin` instead of rendering a panel whose every API call would 403. The endpoint itself stays `secrets.write`-gated.
- `/admin/keys` (page): any authenticated role may load the shell; its API calls are permission-gated (readonly can read keys, sender's key mutations 403). Panel visibility is not a control — acceptable per spec.

## Tests Added (13, all passing)
Spec boundaries: operator PATCH `/admin/api/keys/:id` → 403 · researcher POST `send-batch` → 403 · sender create/patch/delete gmail account → 403 · sender POST keys + GET secrets → 403 · readonly PATCH customer → 403 · secrets: 4 non-root roles 403, super_admin passes gate (503 unbootstrapped, not 403) · `/admin/secrets` page 303 redirect for operator.
Positive paths (gate passed ⇒ handler's own response): readonly GET customers 200 · sender send-batch non-403 · operator POST groups reaches handler validation (400 empty name) · unknown role "evil-genius" fails closed 403.
Matrix sanity: every role ⊆ super_admin, all roles read customers · sender set exactly {customers.read, outreach.read, outreach.send}.
Fixture: per-role sessions minted directly into `admin_users`/`admin_sessions` (real `authenticate()` path, not mocks); `ADMIN_PANEL_TOKEN` present because `authenticate()` fails closed without it.

## Verification
- `npm test`: **197/197 pass** (was 184; +13)
- `npm run typecheck`: pass
- `node scripts/check-panel.mjs`: 5 panels clean
- `npx wrangler deploy --dry-run` (offline): pass, 400 KiB bundle

## Security Risks Fixed
- All-or-nothing admin surface (baseline P0 #2): knowing any valid credential = root over provider keys, Gmail credentials, Cloudflare secrets and customer mutations. Now: five roles, least-privilege by default, single enforcement point that cannot be bypassed by a forgotten route.

## Backward Compatibility
- No migrations this stage (roles already exist on `admin_users` from 0007; default `super_admin`).
- Single operator (`u_admin`, super_admin) keeps identical behavior.
- No API route shapes or business tables changed; 401 semantics unchanged, new 403s only for roles that did not exist before.

## Remaining Risks
- No admin UI to manage users/roles yet (roles are set via D1); a users-management surface is deferred until after Stage 9 (audit log) so every role change can be audited.
- Panels don't hide unauthorized buttons (403 surfaces as an error toast) — cosmetic, tracked for a later pass.
- Bearer bootstrap path remains all-powerful by design (master token compromise = root); narrowed only if/when the master token is rotated out after migration completes.
