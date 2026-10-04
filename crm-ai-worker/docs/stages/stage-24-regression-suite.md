# Stage 24 — Regression Suite (spec §25)

## Requirement

Spec §25: all existing tests must keep passing, plus `npm test` / `npm run typecheck` / `npm run lint` / `npm run build` — or, for scripts the project does not define, the actual equivalent commands from `package.json`.

## Actual commands

`crm-ai-worker/package.json` defines only `dev`, `typecheck`, `test`, `deploy`. No `lint` or `build` script exists, and the repo has no linter configuration at all (no `.eslintrc*`, `eslint.config.*`, `biome.json`, `.ruff.toml` anywhere). The actual equivalents:

| Spec command | Actual command | Result |
|---|---|---|
| `npm test` | `npm test` → `vitest run` | **534 passed / 534, 44 files** — includes every pre-Security-V2 suite (admin-hardening, audit-log, auth-sessions, campaigns, outreach-send, …), every stage suite (Stages 2-20), the Stage 22 security acceptance suite (72) and the Stage 23 concurrency suite (59). Zero regressions across the whole program. |
| `npm run typecheck` | `npm run typecheck` → `tsc --noEmit` | **exit 0**, no diagnostics |
| `npm run lint` | No linter is configured. The static-analysis gates this project actually has both ran green: (a) `tsc --noEmit` (strict TS over the whole worker), (b) the repo-wide static guard tests inside `vitest run` — notably `tests/safe-log.test.ts:124` ("no direct console printing in `src/`", spec §20) and the Stage 22 schema/audit-shape assertions. | green (see rows above) |
| `npm run build` | No build script; the worker's build is Wrangler bundling. Actual command: `npx wrangler deploy --dry-run --outdir dist-dryrun` (CI env, metrics off) | **Total Upload 439.10 KiB / gzip 111.86 KiB**, clean exit, no type or binding errors; `scripts/check-panel.mjs` → **4 panels clean** |

## Notes

- The regression gate is cumulative by construction: every stage since Stage 1 has re-run the full suite before commit, and the Stage 22/23 suites deliberately overlap the per-stage suites (layered acceptance vs. storm invariants) — so "all existing tests pass" here means the 534-test superset, not a cherry-picked subset.
- Deploy is intentionally NOT part of the gate (per the standing constraint: no `wrangler deploy` from this program; CI deploys on push and runs `schema.sql` + migration steps).
- No product code changed in this stage; the deliverable is the verification record plus this report.

## Files changed

- `crm-ai-worker/docs/stages/stage-24-regression-suite.md` (this report)
