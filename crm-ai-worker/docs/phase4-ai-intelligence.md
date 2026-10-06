# Phase 4 — AI Intelligence: design

Status: design (stages follow after this lands; same rules as Phase 3 —
additive migrations, fail-open provenance, every stage green on the full
suite before commit).

Source requirements: 建议.txt §二十一 (the layer pipeline), §十四
(provenance questions — answered by runs/evidence/facts since Stage 14/36/37),
phase3-research-engine.md outlook, phase3b-normalization-review.md §6.5
(the documented trigger: "per-run versioned profiles → outreach_profiles
— likely Phase 4").

## 1. What §二十一 asks for

The intelligence pipeline as layers:

```
Raw Evidence → Fact Extraction → Entity Resolution → Company Profile
  → Buyer Persona → Buying Signal → Lead Score → Outreach Strategy → Email
```

"而不是：网页 → AI → 一大坨 JSON" — each layer must be a typed,
queryable substrate row, so the system is an "AI B2B Intelligence
Database", not an "AI 爬虫 + CRM".

## 2. Layer-by-layer current state (evidence, HEAD 225ba08)

| Layer | State | Evidence |
| --- | --- | --- |
| Raw Evidence | **typed** | `research_sources` (Stage 36): per-run, versioned, content-hashed. |
| Fact Extraction | **typed** | `research_facts` (Stage 37): per-run, `(fact_type, fact_value)` grain. |
| Entity Resolution | **gap** | Contacts dedup is a write-time fingerprint skip (`index.ts:2245-2257`, name+email+cell+whatsapp lowercased): the same person with a newly found email becomes a second row. No fact↔contact link; no merge semantics; no run attribution on contacts. |
| Company Profile | **half** | `customers.company_profile` JSON, overwritten per run (`index.ts:2302`); read by the outreach prompt (`outreach.ts:380`). No history. |
| Buyer Persona | **weak** | `customers.personas_and_solutions` JSON, overwritten; consumed ONLY by the panel renderer (`admin.ts:3535`). The outreach prompt never sees personas (`OUTREACH_CUSTOMER_COLUMNS`, `outreach.ts:484`). |
| Buying Signal | **weakest** | `customers.buying_signals` JSON array, overwritten — and **read by nobody**: selected in both column lists (`admin.ts:281/300`), never rendered in the panel, never consumed by outreach or campaigns. |
| Lead Score | **typed** | deterministic `computeLeadScore`/`computeCompletenessScore` (Stage 15, semantic separation pinned). |
| Outreach Strategy | **half** | `customers.outreach_context` JSON, overwritten; read by the outreach prompt (`outreach.ts:381`). No history. |
| Email | **typed** | `outreach_emails` + campaigns (generate/send pipeline). |

Provenance already answers §十四's "who/when/which page": `evidence` →
`research_runs` (model_name/model_version), `research_sources`
(content_hash), `research_facts` (source_type) — except at contact grain
(§4.4).

## 3. Pinned principles

1. **One AI call stays.** The layers are STORAGE layers, not call layers.
   The research call already returns every layer at temperature 0.1 in one
   shot; splitting it into per-layer calls would multiply credits, latency
   and failure modes for zero quality gain. "一大坨 JSON" dies by
   persisting the layers as typed rows (exactly what evidence/facts
   already do), not by splitting the call. The research prompt's output
   shape does not change in Phase 4.
2. **Evidence pattern for every new table**: append + supersede in one D1
   batch, `is_current`/`valid_from`/`valid_until`, fail-open (provenance
   must never fail paid research), writer-side caps, retention parity
   (superseded-only prune + `DATA_PRUNE` key) from day one.
3. **Every table gets a reader in this phase** (§35 discipline): the panel
   is the transition reader; the durable consumers are campaigns (signals)
   and the outreach prompt (personas).
4. **Cache columns stay caches — no deprecation cutover.** Unlike the
   Stage 38 blob (50 000 chars, history-destroying), the profile/persona/
   signal JSON columns are small and 1:1-hot. Dual-write: rows serve
   history + cross-run queries + new consumers; the columns keep serving
   the panel and the outreach prompt as the "latest" fast path. No replay
   of 36→38 is needed and none is scheduled.
5. **contacts IS the people table** (Phase 3b pinned). Entity resolution
   grows contacts in place — no new people table.

## 4. Target model

### 4.1 `research_signals` — the buying-signal layer (n rows per run)

```
id INTEGER PK AUTOINCREMENT
research_run_id TEXT          -- soft ref, fail-open start (same as sources)
customer_id TEXT NOT NULL
signal_text TEXT NOT NULL     -- one concrete signal, e.g. "2026 扩张新仓库"
parser_version TEXT           -- 'signals-v1'
created_at TEXT NOT NULL
is_current INTEGER NOT NULL DEFAULT 1
valid_from TEXT, valid_until TEXT
```
Indexes: `(customer_id, is_current)`, `(research_run_id)`. Writer caps:
`SIGNALS_PER_RUN_CAP = 20`, `SIGNAL_TEXT_CAP = 500`. Grain: one row per
distinct signal string per run (dedup within the run, preserve AI order).

### 4.2 `research_personas` — the persona layer (n rows per run)

```
id, research_run_id, customer_id (as above)
persona_name TEXT NOT NULL
persona_role TEXT
needs_json TEXT               -- json_valid, string array
pain_points_json TEXT         -- json_valid, string array
parser_version TEXT           -- 'personas-v1'
created_at, is_current, valid_from, valid_until
```
Grain: one row per persona per run. Solutions stay in the profile payload
(§4.3): they are prompt material read together with the strategy, not a
query target — splitting them would be grain-mixing without a consumer.

### 4.3 `research_profiles` — profile + strategy, versioned (1:1 per run)

```
id, research_run_id, customer_id (as above)
company_profile_json TEXT     -- json_valid; the company_profile payload
strategy_json TEXT            -- json_valid; the outreach_context payload
solutions_json TEXT           -- json_valid; the solutions array
parser_version TEXT           -- 'profiles-v1'
created_at, is_current, valid_from, valid_until
```
One row per run: all three payloads are written by the same call and read
by the same prompt. History is the motivation (this is the 3b review's
documented `outreach_profiles` trigger, one run = one row).

### 4.4 Entity resolution, light — link facts to contacts

`research_facts` gains a nullable `contact_id TEXT` (migration:
`ALTER TABLE ADD COLUMN` — safe, no table rebuild for a nullable column).
When a run persists `found_contacts` and then writes facts, an email/phone
fact whose value matches a just-persisted contact links to it. That
answers §十四's question at contact grain — "这个邮箱是谁、什么时候、从哪个
网页提取的" becomes one JOIN (fact → contact → run → sources) — and gives
the facts substrate its entity dimension. **Deferred with trigger**:
contact MERGE (same person, new channel → one row) needs dedup keys, merge
semantics and a panel UI with no consumer today; revisit when a
persona-targeted campaign needs per-person dedup counts.

## 5. Migration strategy

Additive only: three `CREATE TABLE IF NOT EXISTS` (schema.sql + change
records; no CI backfill steps — nothing to backfill, rows accumulate from
the next run onward, exactly like facts in Stage 37) and one
`ALTER TABLE research_facts ADD COLUMN contact_id TEXT`. Dual-write from
day one (§3.4); readers are new code paths, existing responses keep their
shape.

## 6. Staged plan

**Stage 40 — `research_signals`.** Table + writer (`appendResearchSignals`,
evidence pattern, caps) + fresh-path wiring + panel detail gains a 采购信号
section (current rows; today the panel shows NOTHING for buying_signals —
this is the phase's clearest reader win) + retention prune + tests
(mirroring research-sources/facts test structure).

**Stage 41 — `research_personas` + persona-aware outreach.** Table +
writer + fresh-path wiring; the outreach prompt builder consumes current
persona rows (angle per persona — "Purchasing Manager 关心成本, CEO 关心
增长" grounding); panel personas section reads rows with JSON-column
fallback; retention + tests.

**Stage 42 — `research_profiles` + fact→contact linkage.** Table + writer
(same batch as the personas/signals writers where cheap) + fresh-path
wiring; `research_facts.contact_id` linkage (match email/phone facts
against the contacts persisted by the same run, link, fail-open); panel
evidence section annotates linked facts with the contact name; retention +
tests.

Each stage: full suite green, `tsc` clean, dry-run size recorded, stage
report in `docs/stages/`, commit `phase4: stage NN - ...`.

## 7. Explicitly not in Phase 4

- No split of the research AI call (§3.1).
- No research-prompt changes (the outreach prompt evolves in Stage 41; the
  research prompt's JSON contract is stable).
- No cache-column deprecation (§3.4).
- No contact merge/dedup UI (§4.4, deferred with trigger).
- No schema split of `customers` (Phase 3b verdicts, operator-signed).
