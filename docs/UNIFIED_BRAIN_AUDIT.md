# CashPilot — Unified Financial Brain: Audit, Gap Analysis & Phased Plan

**Branch:** `sujan` (from `main` @ `93bf6f2`)
**Status:** Audit only. **No production code has been modified.** This document is the mandated "FIRST TASK" deliverable: audit → gap analysis → smallest-safe plan → first phase to code.
**Author:** engineering audit pass, 2026-08-28.

---

## 0. Baseline (verified before any change)

`sujan` is cut from `main` at `93bf6f2`, which is green:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 problems |
| `npm test` | 68 files, **932 passed**, 5 skipped |
| `npm run build` | OK (24 routes + middleware) |

This is the regression floor. Every phase below must keep it green (spec §2, §50-A, §60).

---

## 1. The single most important finding

The target diagram (spec §1, §65) is a closed loop. **CashPilot already implements the entire back half of that loop** for a single-source world (a seeded/manual ledger + Razorpay). What the spec asks for is a **front half** — a multi-source evidence brain — bolted on *ahead of* the existing forecast, plus richer forecasting/behavioral intelligence.

```
   SPEC TARGET                          WHAT EXISTS TODAY
   ───────────                          ────────────────
   Sources ─┐
   Ingestion │   ← THE GAP (front half, mostly MISSING)
   Normalize │
   Entity Res│
   Evidence  │
   Confidence│
   Claims    │
   X-Src Rec.┘
   ──────────────────  ← the seam: forecast input
   Unified State ......  PARTIAL (state is computed on demand, not materialized/versioned)
   Forecast ..........  EXISTS  (buildForecast, deterministic)
   Scenarios .........  MISSING (single deterministic path only)
   Liquidity Risk ....  EXISTS  (liquiditySafety, riskDetector)
   Counterfactual ....  EXISTS  (scorer.ts counterfactual)
   Strategy Ranking ..  EXISTS  (scorer.ts)
   Approval ..........  EXISTS  (approve route, DecisionEvent)
   Freshness .........  EXISTS  (strategyFreshness, freshnessGate, contextFingerprint)
   Execution .........  EXISTS  (ExecutionIntent, executor, idempotency)
   Provider/Webhook ..  EXISTS  (webhooks route, ProcessedEvent, WebhookDeliveryAttempt)
   Reconciliation ....  EXISTS  (provider + ledger reconciliation, expectedState/observedState)
   Outcome Measure ...  EXISTS  (outcomeMeasurer, OutcomePhase, actualOutcome)
   Calibration/Learn .  PARTIAL (per-decision error captured; no behavior model feeding back)
   AI Explanation ....  EXISTS  (ai/agents, prompts; explain/investigate routes)
```

**Strategic consequence:** we do not rebuild the back half. We (a) introduce the front-half primitives additively, and (b) connect them to the *input* of `buildForecast` and to `contextFingerprint`. The existing deterministic decision/execution/reconciliation core is preserved verbatim (spec §2, §21, §30, §62).

---

## 2. Current architecture (as mapped from code)

**Data model (`prisma/schema.prisma`).** Financial primitives: `Business`, `Transaction` (INFLOW/OUTFLOW, status, expectedDate), `Invoice` (customerName string, dueDate, status, priority), `Payout` (vendor, criticality, status), `PaymentRecovery` (Razorpay link lifecycle), `CashForecast` (materialized forecast rows). Decision/execution: `Strategy` (+ `actions` Json, `scoring` Json, `actualOutcome` Json), `AgentAction`, `ExecutionIntent` (idempotencyKey UNIQUE, obligationKey, expectedState/observedState/reconciliationResult, retrySafe), `Decision` (snapshots, `contextFingerprint`, `fingerprintDetail`, `obligationSnapshot`, `outcomePhase`, config versions), `DecisionEvent` (append-only audit), `ProcessedEvent` (exactly-once), `WebhookDeliveryAttempt` (delivery observability), `User`.

**Engine (`src/lib/engine/`).** `forecast.ts` (buildForecast, calculateRunway), `riskDetector.ts`, `liquiditySafety.ts` (adaptive buffer, `extractObligations`), `strategyEngine.ts` (generateStrategies, 4 canonical strategies), `scorer.ts` (scoreAllStrategies + counterfactual), `strategyFreshness.ts` (`classifyStaleness` → NO_CHANGE/MINOR/MATERIAL/UNKNOWN), `freshnessGate.ts`, `decisionContext.ts` (fingerprint inputs), `decisionStateMachine.ts` (transitions + `appendDecisionEvent`), `outcomeMeasurer.ts`, `obligationOutcome.ts`, `rootCause.ts`.

**Execution / provider.** `execution/executionIntent.ts`, `executor.ts` (RECORDED→DISPATCHING→SUCCEEDED/FAILED/UNKNOWN), `actionExecutors.ts`, `providerReconciliation.ts`, `ledgerReconciliation.ts`; `razorpay/settlement.ts`, `amounts.ts`, `webhookDelivery.ts`, `client.ts`.

**Routes.** `strategies`, `strategies/[id]`, `execute`, `approve`, `decisions(/[id])`, `webhooks`, `forecast`, `investigate`, `payment-status`, `execution-intents(/reconcile)`, `strategy-performance`, `explain`, `sample-data`, `health`, full `auth/*`.

**Cross-cutting.** Tenant isolation via `businessId` scoping in every query; scrypt auth + rate limiting + SameSite=Strict CSRF; structured `observability.ts`; append-only `DecisionEvent`; property-based + golden-dataset + adversarial tests.

---

## 3. Gap analysis (spec concept → current state)

Legend: **✅ EXISTS** · **◑ PARTIAL** · **⭕ MISSING**

| # | Spec concept | State | Notes / where |
|---|---|---|---|
| §5 | Canonical `FinancialEvent` | ⭕ | No event abstraction; sources write domain rows directly. **This is the keystone gap.** |
| §6 | Source adapter / connector interface | ⭕ | Only Razorpay + seeded/manual data. No pluggable ingestion. |
| §7 | Idempotent ingestion (source identity) | ◑ | Exactly-once exists for **webhooks** (`ProcessedEvent`), not for generic source records. |
| §8 | Entity resolution (Customer/Supplier) | ⭕ | `Invoice.customerName`/`Payout.vendor` are free strings. No canonical `Customer`/`Supplier`. |
| §9 | Evidence abstraction | ⭕ | No `Evidence`/`Claim` tables. |
| §10-12 | Source-specific & multi-dimensional confidence | ⭕ | Confidence today is only forecast/strategy scoring; no per-source reliability. |
| §13 | Claim types (ACTUAL/CONTRACTUAL/PREDICTED…) | ⭕ | Implicit only (Transaction.status, Invoice.status). |
| §14-17 | Cross-source reconciliation & contradiction | ◑ | Reconciliation exists **post-execution** (provider vs ledger). No cross-*source* reconciliation of inbound evidence. |
| §18 | Unified `FinancialState` | ◑ | State is computed on demand by `buildForecast`; `CashForecast` rows are a materialization but not a versioned unified state. |
| §19 | State versioning | ◑ | `Decision.contextFingerprint` is a per-decision content hash (a de-facto state identity) but there is no monotonic `FinancialState.stateVersion`. |
| §20 | Freshness ↔ state linkage | ✅ | `strategyFreshness` + `freshnessGate` + `fingerprintDetail`; NO_CHANGE/MINOR/MATERIAL/UNKNOWN already implemented. |
| §21-22 | Forecast engine + richer ForecastEvent | ◑ | `buildForecast` is solid & deterministic; forecast events lack date-range/probability/evidence links. |
| §23-24 | Receivable timing from behavior/comms | ⭕ | Forecast uses `expectedDate`/`dueDate` directly; no expected-vs-contractual split. |
| §25-26 | Customer/supplier behavior model | ⭕ | No historical payment-behavior metrics per entity. |
| §27 | Outcome-based calibration | ◑ | Per-decision prediction error captured (`actualOutcome`, `predictionActual`); not aggregated into a reusable behavior/calibration model. |
| §28-29 | Forecast scenarios + confidence bands | ⭕ | Single deterministic forecast; no OPTIMISTIC/BASE/CONSERVATIVE. |
| §30-32 | Deterministic decision, counterfactual, strategy versioning | ✅ | `scorer.ts` counterfactual; `Decision`/`Strategy` carry engine/config versions + fingerprint. |
| §36-41 | Execution lifecycle, webhook correctness, multi-action, concurrency, post-exec reconciliation | ✅ | `ExecutionIntent` state machine, idempotencyKey/obligationKey, `WebhookDeliveryAttempt`, freshness gate at execute. Multi-action tracked per `AgentAction`. |
| §42-43 | Outcome measurement & closed-loop learning | ◑ | Measurement ✅ (`OutcomePhase`); learning loop back into forecasting ⭕. |
| §44 | AI explanation over structured output | ✅ | `ai/agents.ts`, `prompts.ts`; AI never authoritative (containment tests exist). |
| §45-46 | Auditability, no evidence deletion | ◑ | `DecisionEvent` append-only ✅; but there is no evidence store to preserve yet (§46 becomes real only after §9). |
| §47-48 | Tenant isolation & security | ✅ | Enforced in queries; scrypt/CSRF/rate-limit; secrets never logged. **Must extend to every new table/route.** |
| §49 | Observability of pipeline stages | ◑ | `observability.ts` + `WebhookDeliveryAttempt`; new SYNC_/EVENT_/EVIDENCE_ stages ⭕. |
| §52-56 | Incremental recompute, background sync, sync health, staleness safety | ⭕ | No connectors, so none of this exists yet. |

**Summary:** the decision/execution/reconciliation/outcome **spine is done and certified**. The evidence/multi-source/behavioral **front half and the learning feedback are the real greenfield**, and they are almost entirely additive.

---

## 4. Architectural risks & constraints

1. **Do not fork financial reality (spec §3).** New evidence/state tables must *feed* `buildForecast`, not run a parallel forecast. The integration seam is a single adapter that turns Unified State → the `DailyMovement[]`/obligation inputs `buildForecast` already consumes.
2. **Fingerprint compatibility (§19-20).** A new `stateVersion` must not break the existing `contextFingerprint` freshness path. Plan: derive//include stateVersion *alongside* the fingerprint, never replace it, until parity is proven.
3. **Money stays in paise, server-authoritative (§62).** All new amounts `Int` paise; AI never authoritative.
4. **Tenant isolation on every new artifact (§47).** Every new model gets `businessId` + index; every new route re-uses `getSession` scoping. Add tenant-isolation tests per table (§50-D).
5. **Additive migrations only.** New tables/columns are nullable/optional; no destructive changes to `Transaction`/`Invoice`/`Payout`/`Decision`. Existing rows must read back identically.
6. **Scope realism.** The spec is ~17 phases / multi-month. This branch delivers the audit now and then **one phase at a time**, each independently shippable and green (§59-60). We do **not** implement all phases at once.

---

## 5. Phased plan (smallest-safe ordering)

Mapped from spec §59 but reordered so each step is additive and independently verifiable. Phases marked **(mostly done)** only need thin integration, not new build-out.

| Phase | Deliverable | Build vs. reuse |
|---|---|---|
| **P0** | This audit + baseline (done) | — |
| **P1** | `FinancialEvent` model + append-only writer + idempotent source identity; **no consumers yet** | new, additive |
| **P2** | `Evidence` + `Claim` models; write evidence from existing domain rows (Invoice/Transaction/Payout) as a backfill; claim types | new, additive |
| **P3** | Source-specific + multi-dimensional confidence (pure functions, unit-tested) | new lib |
| **P4** | Entity resolution: `Customer`/`Supplier` canonical + link existing `customerName`/`vendor` | new, additive + backfill |
| **P5** | Cross-source reconciliation of *inbound* evidence (state machine: UNMATCHED…RECONCILED/CONFLICT) | new lib, reuse recon patterns |
| **P6** | `FinancialState` materialization computed from canonical rows; **read-through only** at first | new, non-authoritative |
| **P7** | `stateVersion` advancing on material mutation; wire *alongside* `contextFingerprint` | integrate |
| **P8** | Feed unified state into `buildForecast` input adapter (behind a flag; parity-tested vs current) | integrate (highest care) |
| **P9** | Customer/supplier behavior model (metrics from actual outcomes) | new lib |
| **P10** | Scenario forecasting (OPTIMISTIC/BASE/CONSERVATIVE) | extend forecast |
| **P11** | Freshness ↔ stateVersion (**mostly done** — extend existing) | integrate |
| **P12** | Execution/webhook hardening (**mostly done** — audit vs Razorpay docs, add any missing tests) | verify |
| **P13** | Cross-source reconciliation surfaced in UI/observability | integrate |
| **P14** | Outcome measurement (**done** — connect to behavior model) | integrate |
| **P15** | Forecast calibration/learning loop (behavior model ← outcomes) | new, careful |
| **P16** | AI explanation over evidence/state (**extend** existing explain layer) | integrate |
| **P17** | Additional financial actions/connectors | new per-connector |

---

## 6. Recommended first coding phase: **P1 — Canonical Financial Events**

Rationale: it is the keystone the entire front half hangs from, it is **purely additive** (a new table + a writer + tests; zero consumers, zero behavior change), and it lets every later phase (evidence, entity resolution, state) attach to a stable spine. Per spec §60 / the required change format:

> **FILE:** `prisma/schema.prisma`
> **CURRENT BEHAVIOR:** No canonical event abstraction; sources write domain rows.
> **PROBLEM:** No single append-only spine to attach evidence/claims/state to; no generic idempotent ingestion identity (§5, §7).
> **PROPOSED CHANGE:** Add `model FinancialEvent` (id, businessId, eventType enum, sourceType, sourceRecordId, entityId?, amount Int?, currency, occurredAt, effectiveAt, status, normalizedData Json, rawReference?, timestamps) + `@@unique([businessId, sourceType, sourceRecordId])` for idempotency + `@@index([businessId])`, `@@index([businessId, effectiveAt])`. Enum kept minimal (only event types the current domain produces), extensible later.
> **WHY:** Establishes the spine without touching any existing model or query.
> **DEPENDENCIES:** none (no consumers in P1).
> **MIGRATION IMPACT:** one additive `CREATE TABLE`; no column changes to existing tables; existing rows read identically.
> **TEST IMPACT:** new unit + idempotency tests (§50-B): same event 1×/2×/10×/after-restart/after-partial-failure must yield one row; tenant-isolation test (§50-D).
> **SECURITY IMPACT:** new table carries `businessId`; writer scoped to session tenant; `normalizedData` must never store secrets/raw provider credentials.
> **ROLLBACK PLAN:** drop-table migration; no other code references it, so rollback is isolated.

> **FILE:** `src/lib/events/financialEvent.ts` (new)
> **PROPOSED CHANGE:** `recordFinancialEvent(tx, tenantId, input)` — idempotent upsert on the source identity, append-only semantics, structured observability event `EVENT_INGESTED`. Pure/testable; no external calls.
> Plus a thin backfill/no-op so nothing else changes.

**Explicitly NOT in P1:** no forecast changes, no evidence/claim tables, no connectors, no UI. Those are P2+.

---

## 7. What I need from you before writing production code

Per the spec ("do not modify production code until this audit is complete" / "only then proceed"), I'm pausing here for a decision:

- **Approve P1** as scoped above (additive `FinancialEvent` + writer + tests), and I implement it on `sujan` following the §60 workflow (implement → migration → unit/integration/adversarial tests → full regression → tsc → build → security & tenant review → document → stop).
- Or **adjust scope/ordering** (e.g., you'd rather start with entity resolution, or want a specific connector first).

I will not run migrations against your Neon database without explicit confirmation; P1's migration can be developed and validated locally first.

---

## 8. Phase progress

| Phase | Status | Commit | Notes |
|---|---|---|---|
| **P0** Audit + baseline | ✅ done | `a239f67` | this document |
| **P1** Canonical Financial Events | ✅ done | `57e9131` | `FinancialEvent` + idempotent writer; no consumers |
| **P2** Evidence + Claims | ✅ done | `e3dca50` | `Claim`/`Evidence` + idempotent store + domain-row mappers |
| **P3** Source-specific confidence | ✅ done | `94b9274` | multi-dimensional, claim-aware; unknown dimensions stay null |
| **P4** Entity resolution | ✅ done | `dae385b` | `Counterparty`/`CounterpartyAlias`, resolver, merge, backfill |
| **P5** Cross-source reconciliation | ✅ done | `a6b278f` | claim-specific precedence, state machine, contradictions, consistency scoring |
| **P6** Unified `FinancialState` | ✅ done | `44c78c8` | materialised read-through + reconciliation run + write-back |
| **P7** State versioning ↔ freshness | ✅ done | `5e1efcc` | state transition classifier, wired *alongside* the fingerprint in the gate |
| **P8** ForecastEvent seam | ✅ done | `c6635bf` | flag-gated pipeline, parity-proven identical; P9's extension point |
| **P9** Behaviour model | ✅ done | `69192ee` | payment behaviour + prediction accuracy; **closes the C-1 confidence gap** |
| **B-10/11/9** Wiring | ✅ done | `4e1ee2b`, `280efb1` | `paidAt` at settlement; behaviour map; routes switched |
| **P10** Scenario forecasting | ✅ done | `0ef2e9c` | OPTIMISTIC / BASE / CONSERVATIVE + forecast confidence |
| **P13** Surface it | ✅ done | this change | `/api/forecast` returns scenarios + confidence; dashboard shows them |
| **P11** Freshness ↔ stateVersion | mostly done in P7 | — | remaining: expiry, `forecastVersion` |

### Regression floor after P13

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | 0 problems |
| `npm test` | 89 files, **1287 passed**, 5 skipped (982 baseline + 305 across P4–P13) |
| `npm run build` | OK — same 24 routes + middleware; `/dashboard` still prerenders |

> **Baseline note.** `tsc` fails on a fresh checkout until `npx prisma generate` is run: the Prisma client is gitignored and regenerated by `postinstall`, so a stale local client does not know about the Phase 1–4 models. Tests do not typecheck, so they pass regardless — run `prisma generate` before trusting a green test run.

---

## 9. Phase 4 — Entity Resolution, as built

Per the §60 change format.

> **FILE:** `prisma/schema.prisma`, `prisma/migrations/20260828020000_phase4_entity_resolution/`
> **CURRENT BEHAVIOR:** A customer exists only as `Invoice.customerName` and a supplier only as `Payout.vendor` — free strings, so "ABC Ltd" and "ABC LIMITED" are two unrelated businesses.
> **PROBLEM:** Nothing can accumulate per-counterparty history, so the behaviour model (§25) and cross-source evidence (§8) have no identity to attach to.
> **PROPOSED CHANGE:** `Counterparty` (tenant + type + `normalizedName` unique, `mergedIntoId` for merges) and `CounterpartyAlias` (spelling → entity, unique on `(businessId, type, normalizedName)`), plus a **nullable** `counterpartyId` on `Invoice` and `Payout`.
> **WHY:** One canonical identity per real company, reachable from every source, without touching how the engine reads invoices or payouts.
> **DEPENDENCIES:** none — no production code reads these yet.
> **MIGRATION IMPACT:** two `CREATE TABLE` + one enum + two nullable `ADD COLUMN` + indexes. No column altered, dropped or backfilled; existing rows read back identically. DDL verified byte-for-byte against `prisma migrate diff` output. **Not yet applied to any database.**
> **TEST IMPACT:** +59 tests across normalisation, resolution, persistence, merge and backfill, including the four §50-D cases and five tenant-isolation cases.
> **SECURITY IMPACT:** every query is `businessId`-scoped; links are written with `updateMany` filtered on `businessId`, never `update` by id, so a leaked row id is not authorisation. No PII beyond the counterparty names already stored on `Invoice`/`Payout`.
> **ROLLBACK PLAN:** drop both tables and the two nullable columns. Nothing reads them, so rollback is isolated.

> **FILES:** `src/lib/entities/normalize.ts`, `resolver.ts`, `store.ts` (new)
> **PROPOSED CHANGE:** deterministic name normalisation + token-overlap similarity (pure); a pure resolution decision returning `ALIAS | EXACT | CANDIDATE | AMBIGUOUS | NEW | UNRESOLVABLE`; idempotent persistence, merge and backfill.

### The central design decision

**Automatic matching is exact-only.** Risk here is asymmetric: a duplicate entity is recoverable — a user merges it and history is preserved — but merging two *different* companies silently poisons one customer's payment behaviour with another's, and nothing downstream would ever flag it. So:

- `normalizeEntityName` collapses only *notational* difference (case, punctuation, accents, `&`/`and`, legal forms like Ltd/Limited/Pvt). Two names with the same canonical form are auto-matched.
- `nameSimilarity` (token-set Jaccard) **never** matches anything. It only ranks near-matches, and every fuzzy outcome returns `matchedId: null` so a caller cannot mistake a suggestion for a match.
- `CANDIDATE`/`AMBIGUOUS` still create a *separate* entity and report the near-matches (`ENTITY_MERGE_SUGGESTED`). Splitting is reversible; joining is not.
- Similarity is token overlap, not edit distance: "Alpha Traders"/"Alpha Trading" are one edit apart and may be different companies.
- A blank or punctuation-only name is `UNRESOLVABLE` — no entity is invented (§64).
- A name made entirely of legal tokens ("Ltd") keeps its un-stripped form, so those don't all collide into one bogus counterparty.

Merges keep the losing row forever with `mergedIntoId` set (§46); resolution follows the chain and throws on a cycle rather than returning a superseded identity.

### Limitations (explicit)

1. **No production consumer.** Nothing in forecast, scoring or execution reads `counterpartyId`. `customerName`/`vendor` remain authoritative for display. This is deliberate: P4 is additive like P1–P3.
2. **Backfill is not wired to a route or job.** `backfillInvoiceCounterparties` / `backfillPayoutCounterparties` exist and are tested, but nothing calls them. Running one is a separate, explicit decision.
3. **Migration not applied.** The SQL is written and verified against Prisma's own generated DDL but has not been run against the Neon database — that needs your confirmation.
4. **Resolution is name-only.** No use of GSTIN/PAN/email/bank-account identifiers, which would allow *safe* non-exact matching. That is the natural P4.1 once a source actually supplies them.
5. **Backfill is sequential** by design (it reads the entity set it writes to). Bounded by a tenant's counterparty count, not row count, but it is not parallelised.
6. **Merge is not exposed to users.** `mergeCounterparties` has no API route or UI; the suggestion→confirmation loop (§34) needs both, and that belongs with the UI phase.
7. **Aliases key on the normalised form**, so only the first raw spelling producing a given key is retained. Full spelling history belongs on `FinancialEvent`/`Evidence`, not here.

---

## 10. Phase 5 — Cross-Source Reconciliation, as built

> **FILES:** `src/lib/evidence/precedence.ts`, `src/lib/evidence/reconcile.ts` (new)
> **CURRENT BEHAVIOR:** Reconciliation existed only *post-execution* (`execution/providerReconciliation.ts`, `execution/ledgerReconciliation.ts`) — it reconciles the outcome of an action we took. Nothing reconciled what different sources were *telling us* about the same money.
> **PROBLEM:** §14 makes cross-source reconciliation mandatory; §16 forbids a universal source hierarchy; §17 requires contradiction detection. Separately, Phase 3 left `consistencyScore` permanently `null`, capping every predictive claim at 0.6.
> **PROPOSED CHANGE:** Two pure modules — a claim-specific authority model, and a reconciliation state machine that also emits per-observation consistency scores.
> **WHY:** It is the first phase that makes several sources disagree *productively*, and it lifts half of the Phase 3 confidence ceiling.
> **DEPENDENCIES:** P2 claim types, P3 `computeConfidence`. No schema change — `Evidence.consistencyScore` already exists from P2.
> **MIGRATION IMPACT:** none. No new table, no new column.
> **TEST IMPACT:** +41 tests, including golden scenarios 1, 4 and 8 from §51.
> **SECURITY IMPACT:** none — both modules are pure, take no client, touch no database and hold no tenant data. `Contradiction.detail` is plain language and never carries a raw payload.
> **ROLLBACK PLAN:** delete both files. Nothing imports them outside their tests.

### No universal hierarchy (§16)

`precedence.ts` indexes authority by **question**, not by source. The test suite asserts the ordering genuinely inverts:

| Question | Authority order (top three) |
|---|---|
| `MONEY_ARRIVED` | BANK 1.0 → RAZORPAY 0.9 → … → ERP 0.4 |
| `OBLIGATION_EXISTS` | ERP 1.0 → INVOICE 0.85 → … → BANK 0.25 |
| `COUNTERPARTY_STATED` | EMAIL 1.0 → USER 0.9 → … → BANK 0.05 |
| `LIKELY_TIMING` | USER 0.8 → EMAIL/HISTORICAL 0.7 → … |

A test asserts **no source dominates every question**, so any future edit that reintroduces a universal ranking fails the suite. `authoritativeSources("LIKELY_TIMING")` is deliberately empty: nothing settles the future (§12).

### The state machine (§15)

`UNMATCHED → CANDIDATE_MATCH → MATCHED → VERIFIED → RECONCILED`, with `CONFLICT` / `DUPLICATE` / `MISSING` / `EXPIRED` / `UNKNOWN` as exits.

Two rules do the real work:

1. **Verification is question-scoped.** An authoritative source only verifies with a claim that can *settle* that question. The bank is the authority on cash, but a bank record of an *expected* inflow does not confirm arrival — that group reaches `MATCHED`, not `RECONCILED`.
2. **Disagreement is never resolved automatically.** Two sources with different amounts produce `CONFLICT` with the delta reported — never an average, never "the more reliable one wins". The default amount tolerance is **zero**, because §14/§41 treat ₹5,00,000 vs ₹4,98,750 as a mismatch; a tolerance is a policy that belongs to whoever is accountable for it.

`DUPLICATE` is checked *before* anything is counted — otherwise a redelivered webhook would look like a second source corroborating the first.

`EXPIRED` requires an explicit `expiryDays` policy. Without one, a missed expectation stays `MISSING` forever rather than being silently written off the books.

### Closing half the Phase 3 gap

`computeConsistency` scores each observation by the *weighted* agreement of the others — weighted by how much each other source knows **about this question**. Being contradicted by the bank about cash costs far more than being contradicted by a behavioural model. It returns `null`, never `0`, when nothing comparable exists to check against: "unknown" and "no agreement" are different facts and confidence treats them differently.

Feeding that into the existing `computeConfidence` is the payoff, and is asserted end-to-end in the tests:

| Evidence | `consistencyScore` | Prediction factor |
|---|---|---|
| Uncorroborated | `null` | capped at 0.6 |
| Corroborated by the bank | 1.0 | ~0.95 — **exceeds the cap** |
| Contradicted by the bank | 0.0 | 0 |

The other half of the ceiling (`historicalAccuracyScore`) still needs P9.

### Limitations

1. **No persistence.** Outcomes are computed, not stored. There is no `Reconciliation` table and `Evidence.consistencyScore` is not written back yet — that belongs with P6/P13, where there is a state to attach it to.
2. **No production consumer**, consistent with P1–P4.
3. **Grouping is the caller's job.** `reconcileObservations` takes observations for one subject and one tenant and cannot verify either. The query that assembles a group — and enforces tenancy on it — arrives with the persistence layer.
4. **Amount-only matching.** Reconciliation compares amounts, not dates. Differing dates across sources are legitimately *not* contradictions (§17), but a payment matched to the wrong invoice of the same value would not be caught here.
5. **`EXPECTED_EVENT_MISSED` needs an `effectiveAt`.** An expectation with no date can never be detected as missed.
6. **Authority weights are an ordering, not measurements.** Only the ordering is relied upon, and only it is tested. They are not calibrated against outcomes — that is P15's job.

---

## 11. Phase 6 — Unified Financial State, as built

> **FILES:** `prisma/schema.prisma`, `prisma/migrations/20260828030000_phase6_financial_state/`, `src/lib/state/financialState.ts`, `src/lib/state/store.ts`, `src/lib/evidence/reconciliationRun.ts` (new); `src/lib/evidence/confidence.ts`, `src/lib/engine/strategyFreshness.ts` (two additive edits)
> **CURRENT BEHAVIOR:** Financial state was computed on demand inside `buildForecast` and never materialised. `CashForecast` rows are a forecast materialisation, not a versioned state.
> **PROBLEM:** §18 requires one unified state; §19 requires a deterministic revision identifier. Separately, P5's reconciler had no caller (B-5) and `Evidence.consistencyScore` was never written.
> **PROPOSED CHANGE:** A `FinancialState` table (append-only, versioned per tenant), a pure computation over canonical rows, an idempotent materialiser, and a reconciliation run that assembles observation groups from stored claims/evidence and writes derived scores back.
> **WHY:** Gives every later phase a stable, addressable "what did we believe, and when".
> **DEPENDENCIES:** engine `extractObligations` / `buildForecast` / `calculateRunway`; P2 claims/evidence; P5 reconciler.
> **MIGRATION IMPACT:** one additive `CREATE TABLE` + 4 indexes. No existing table touched. **Not applied to any database.**
> **TEST IMPACT:** +49 tests.
> **SECURITY IMPACT:** every read and write is `businessId`-scoped; the evidence write-back uses `updateMany` filtered on `businessId`, never `update` by id. `evidenceRefs` holds internal ids only.
> **ROLLBACK PLAN:** drop the table, delete `src/lib/state/` and `reconciliationRun.ts`, revert the two additive edits. Nothing else reads any of it.

### Not a second opinion about money

The one thing this phase must not do is invent its own definitions. It doesn't: `computeFinancialState` **calls** `extractObligations`, `transactionsToMovements`, `buildForecast` and `calculateRunway` rather than restating what an obligation or a movement is. A test asserts `payables` equals `extractObligations(...)`'s total *by construction*.

The same reasoning drove two small additive edits rather than new copies:

- `sha256` / `stableStringify` are now **exported** from `strategyFreshness.ts` instead of being duplicated. Two hashing schemes that drifted would make state identity and strategy freshness disagree about whether anything changed.
- `combineConfidence` was **extracted** from `computeConfidence`, so re-deriving confidence for stored evidence runs the same formula the ingest path ran. One formula, two entry points.

Neither changes behaviour; the existing 26 freshness tests and 23 confidence tests pass untouched.

### State identity excludes the clock

`stateHash` covers financial content only — `asOf` is reported but never hashed. Without that, a periodic recompute would mint a new version every tick and `stateVersion` would measure *how often we looked* rather than how often anything changed. `materializeFinancialState` returns `unchanged: true` and writes nothing when the hash matches; a test runs it ten times and asserts one row.

Versions are append-only and per tenant. Returning to an earlier reality produces a **new** version, never a rewind — v1 stays readable forever (§46). The version race is resolved by re-reading: a competitor that stored our exact content means there is nothing to write.

`riskState` has four values, and `INCOMPLETE` outranks the numbers — a state built on partial data must not report a confident `OK` just because the rows it did read looked healthy (§64).

### Closing B-5

`reconciliationRun.ts` is the half P5 was missing. `groupObservations` assembles groups **by subject**, so the ERP's contractual assertion and the bank's settlement about invoice X land side by side. One source record supporting several claims about one subject collapses to a single observation — otherwise it would look like two sources corroborating each other.

The write-back touches **only** `consistencyScore` and `derivedConfidence`. Those are derived values re-derived from better information; no observation field is ever modified, and a test asserts the update payload contains exactly those two keys.

### Limitations

1. **Still non-authoritative.** `buildForecast` reads canonical rows directly; nothing reads `FinancialState`. Wiring is P7/P8.
2. **No scheduler.** Nothing calls `materializeFinancialState` or `runReconciliation` — no route, no cron, no post-write hook.
3. **`stateVersion` is not yet connected to strategy freshness.** That is P7's whole job, and it must run *alongside* `contextFingerprint`, never replace it, until parity is proven.
4. **Materiality is not classified.** `changedComponents` reports *what* differs; deciding whether a difference is MINOR or MATERIAL is P7.
5. **The reconciliation rollup is counts only** — conflicts are counted, not linked. Surfacing which subject conflicted is P13.
6. **`runReconciliation` loads all of a tenant's claims and evidence.** Fine at current volumes, but it is a full scan per run; §52's dependency-aware recomputation is not implemented.
7. **B-2 still stands:** nothing writes claims or evidence, so a real run today reconciles zero subjects.

---

## 12. Phase 7 — State Versioning ↔ Freshness, as built

**This is the first phase that touches the money path.** Phases 1–6 sat entirely beside the engine; P7 modifies `checkStrategyFreshness`, which runs at approval and at execution. The design is therefore organised around one property, proved rather than asserted.

> **FILES:** `src/lib/state/stateTransition.ts` (new), `src/lib/engine/freshnessGate.ts` (modified), `prisma/schema.prisma` + `prisma/migrations/20260828040000_phase7_decision_state_version/`
> **CURRENT BEHAVIOR:** Freshness is decided solely by `contextFingerprint`, a record-level hash of the decision context.
> **PROBLEM:** §19/§20 require state changes to drive strategy staleness, and §32 requires a strategy to be traceable to the state that generated it.
> **PROPOSED CHANGE:** `classifyStateTransition` (state-level, same vocabulary and thresholds), `combineFreshness` (takes the more severe verdict), a nullable `Decision.financialStateVersion`, and the gate consulting both halves.
> **WHY:** Aggregate-level change detection catches things a record diff cannot express — a risk-state flip, a newly detected cross-source conflict, a missed expected payment.
> **DEPENDENCIES:** P6 (`FinancialState`, `toSnapshot`).
> **MIGRATION IMPACT:** one nullable column, no default, no backfill. Every existing decision keeps `null`.
> **TEST IMPACT:** +31, of which 10 are gate integration tests.
> **SECURITY IMPACT:** both state lookups are `businessId`-scoped, asserted by test. An unreadable state table blocks rather than throwing or passing.
> **ROLLBACK PLAN:** revert the gate edit; the column can stay (nothing else reads it).

### The safety property

**Adding the state check can only ever block something that would have passed. It can never pass something that would have been blocked.**

`combineFreshness` takes the more severe of the two verdicts under the ordering `NO_CHANGE < MINOR_CHANGE < MATERIAL_CHANGE < UNKNOWN`. A test walks **all sixteen combinations** and asserts the combined rank is never below the fingerprint's own, and that anything the fingerprint blocked stays blocked.

### Why a missing state is `NOT_TRACKED`, not `UNKNOWN`

`classifyStaleness` treats a missing fingerprint as `UNKNOWN` and blocks — correct, since an unverifiable strategy must not execute. Applying that rule to state would have blocked **every decision in the system** the moment this shipped, because no state has ever been materialised (B-6).

So a decision with `financialStateVersion = null` yields `NOT_TRACKED`, which contributes nothing: `combineFreshness` returns the fingerprint verdict *by identity*. The gate does not even issue a state query — asserted by test. Every existing decision behaves exactly as it did before, at zero added cost.

The distinction is preserved where it matters: a decision that *did* record a version whose state can no longer be read is `UNKNOWN` and blocks, because that is a genuine verification failure rather than a feature not yet in use.

### Why the state check does not REPLACE the fingerprint

A state is a set of aggregates; the fingerprint diffs individual records. A test makes the gap concrete: **one ₹5L invoice replaced by a different ₹5L invoice** leaves cash, receivables, payables, flows and commitment count all identical — the state hash is byte-identical and reports `NO_CHANGE` — while the records a strategy was about to act on have changed completely. The fingerprint correctly reports `MATERIAL_CHANGE`, and the combined verdict blocks.

Each half sees what the other cannot. That is why both run.

### What the state half adds

Changes that are invisible to a record-level diff:

| Signal | Severity | Rationale |
|---|---|---|
| `riskState` moved (e.g. `OK` → `AT_RISK`) | MATERIAL | The plan's premise changed |
| `activeCommitments` count moved | MATERIAL | The obligation set is what a plan is built around |
| `reconciliation.conflicts` **increased** | MATERIAL | Sources now disagree about figures this plan rests on (§14) |
| `reconciliation.missing` **increased** | MATERIAL | An expected payment did not arrive (§17) |
| Either state `INCOMPLETE` | UNKNOWN | A partial view cannot certify freshness (§64) |

Conflicts being *resolved* raises no alarm — only new disagreement does.

Thresholds come from `FINANCIAL_CONFIG` (`EXECUTION_DRIFT_THRESHOLD`, `FRESHNESS_BUFFER_DRIFT_THRESHOLD`, `FRESHNESS_MATERIALITY_RATIO`), the same constants `classifyStaleness` uses, so the two halves cannot disagree about what "material" means.

### Limitations

1. **Nothing writes `financialStateVersion` yet.** No decision records one, so the state half is `NOT_TRACKED` everywhere in practice. Setting it belongs with P8, where state acquires its first real reader — writing it before then would arm a gate against states nothing maintains.
2. **B-6 still stands:** nothing schedules materialisation, so states do not advance on their own.
3. **Aggregate-only.** By construction the state half cannot see record-level substitution; that is the fingerprint's job and always will be.
4. **No `expiresAt`.** §32 also lists strategy expiry; freshness here is comparison-based, not time-based.
5. **`forecastVersion` from §32 is not modelled** — there is no separately versioned forecast artifact yet.

---

## 13. Phase 8 — The ForecastEvent seam, as built

> **FILES:** `src/lib/forecast/forecastEvent.ts`, `src/lib/forecast/__tests__/parity.test.ts` (new). **No existing file modified.**
> **CURRENT BEHAVIOR:** Every forecast path in the product runs `rows → transactionsToMovements → buildForecast`. Timing comes straight from `expectedDate`; there is no expected-vs-contractual split (§23) and no per-event provenance (§22).
> **PROBLEM:** The unified brain has nowhere to enter the forecast.
> **PROPOSED CHANGE:** A `ForecastEvent` layer at that single seam, plus `buildMovements` as a flag-gated entry point.
> **WHY:** It establishes — and *proves* — the pipe before anything flows differently through it.
> **DEPENDENCIES:** `engine/forecast`, P3 `sourceReliability`.
> **MIGRATION IMPACT:** none. No schema change.
> **TEST IMPACT:** +39, of which 26 are parity assertions.
> **SECURITY IMPACT:** none — pure functions, no client, no tenant data.
> **ROLLBACK PLAN:** delete both files. Nothing imports them.

### The claim, and the evidence for it

**This phase changes no number.** `expectedDate` is set equal to `contractualDate`, the uncertainty band is collapsed onto it, and probability is 1 — because the evidence that would justify moving them does not exist yet. Manufacturing a spread now would be exactly the fake precision §64 forbids.

The evidence is a parity suite over 13 input shapes — empty ledger, failed rows, null/empty descriptions, same-day collisions, ISO-string dates, zero and negative amounts, dates outside the horizon, a 200-row ledger — asserting with `toStrictEqual` that the event path produces movements *and forecasts and runway metrics* identical to the current path. `toStrictEqual` rather than `toEqual` is deliberate: `toEqual` ignores undefined-valued keys, which would let the event path quietly grow a field.

### The parity suite immediately earned its keep

It caught a real divergence in the first implementation. `transactionsToMovements` gives a transaction whose `type` is neither `INFLOW` nor `OUTFLOW` **zero inflow and zero outflow** — it contributes nothing. The first draft of the event mapping wrote `kind = type === "INFLOW" ? "INFLOW" : "OUTFLOW"`, which would have **invented an outflow that does not exist** in the ledger, silently depressing every forecast containing such a row.

`ForecastEvent.kind` now carries an explicit `UNKNOWN`, which lands 0 in both columns and matches the existing behaviour exactly. This is precisely the class of bug a "harmless refactor" ships when it is not compared strictly against the thing it replaces.

### Where P9 plugs in

`applyExpectedTiming` is the extension point and is the identity function today. Two tests pin down that the pipe is wired to `expectedDate` (not `contractualDate`): move an event's expected date and both the movement and the resulting forecast day shift with it. So when P9 starts moving dates, the change flows through with no further plumbing.

### The flag, and what flipping it will mean

`FORECAST_EVENT_PIPELINE.enabled` is **off** by default. While the pipeline is provably output-identical the flag is a no-op either way, which is the point: the seam ships and gets exercised before it can affect a number.

⚠️ **When P9 makes `applyExpectedTiming` move dates, turning this on changes forecast output.** At that moment `SCORING_CONFIG_VERSION` / `LIQUIDITY_CONFIG_VERSION` must be bumped, so that every strategy generated under the old pipeline is classified `MATERIAL_CHANGE` by the freshness gate rather than silently surviving into a different forecast. This is written in the code beside the flag.

### Limitations

1. **No call site uses it.** The five production forecast call sites still call `transactionsToMovements` directly. Switching them over is safe (parity is proven) but is a separate, reviewable change.
2. **Transactions only.** Invoices and payouts do not yet become forecast events; the forecast has never consumed them directly either.
3. **`recurrence` from §22 is not modelled.**
4. **`probability` is always 1.** Nothing yet estimates the chance a movement fails to occur.
5. **`evidenceIds` is always empty** (B-2).

---

## 14. Phase 9 — Payment-behaviour intelligence, as built

> **FILES:** `src/lib/behavior/paymentBehavior.ts` + tests (new); `src/lib/forecast/forecastEvent.ts`, `src/lib/db/records.ts`, `prisma/schema.prisma` + `prisma/migrations/20260828050000_phase9_invoice_paid_at/` (modified)
> **CURRENT BEHAVIOR:** The forecast assumes money arrives on its contractual date — the one thing we know is usually wrong.
> **PROBLEM:** §23–27 require expected timing to come from actual behaviour, and §25 requires explicit sample sizes.
> **PROPOSED CHANGE:** A pure behaviour model, wired into P8's `applyExpectedTiming`; `computePredictionAccuracy` for §27; a nullable `Invoice.paidAt`.
> **MIGRATION IMPACT:** one nullable column, **no backfill**.
> **TEST IMPACT:** +38.
> **SECURITY IMPACT:** none — pure functions, no client, no tenant data.
> **ROLLBACK PLAN:** revert `applyExpectedTiming` to the identity function; the model and column are then unreferenced.

### The finding that shaped this phase

**Nothing in the schema recorded when an invoice was actually paid.** `Invoice.status` flipped to `PAID` and the date was simply lost. "How late does this customer usually pay?" was therefore *unanswerable from stored data* — the behaviour model had no possible input.

`Invoice.paidAt` is that input. It is **not backfilled**, deliberately: a historical invoice genuinely has no recorded payment date, and deriving one from a row timestamp would fabricate exactly the history the model exists to measure.

### Three rules

1. **Sample size is explicit and named** (§25). Nothing is called `sampleSize`: `paymentHistorySampleSize` counts settled payments, `recentSampleSize` those in the recency window, `forecastObservationCount` prediction/actual pairs. A test asserts the ambiguous name never appears.
2. **Too little history means no opinion.** Under 3 payments → every metric null, `INSUFFICIENT`. At 3–4 → metrics are *reported* but `expectedDelayDays` stays null: observable, not actionable. Only at 5+ can a forecast move.
3. **Recent behaviour outweighs old, but never erases it** (§26). Recency weight rises with recent observations to a cap of 0.7. The spec's own example — historically +4 days, last five on time — lands strictly between the two, and a test asserts it is *both* below the historical average *and* above zero. Five good payments are not a guarantee.

### Closing the C-1 confidence gap

`computePredictionAccuracy` supplies `historicalAccuracyScore`, the dimension that has been `null` since Phase 3. With P5's `consistencyScore` it completes the set:

| | consistency | accuracy | completeness | predictive ceiling |
|---|---|---|---|---|
| Phase 3 alone | null | null | MINIMAL | **capped at 0.6** |
| After P5 | measured | null | PARTIAL | uncapped |
| After P9 | measured | measured | **FULL** | uncapped |

Like every other unmeasured dimension it returns `null`, never `0` — "not yet measured" and "measured and terrible" are different facts.

### What actually moves

`applyExpectedTiming` shifts an inflow by the blended delay, widens `[earliestDate, latestDate]` by the observed spread, and records a readable `timingBasis`. Guards, each with a test:

- No behaviour, no counterparty link, or `SPARSE` history → **unchanged**, and P8's strict parity still holds.
- A delay rounding to **0 days** → unchanged. Sub-day precision cannot survive day bucketing, so applying it would be churn plus false precision.
- **Outflows are never shifted.** A payout's date is our own decision, not a counterparty's behaviour.
- `timingBasis` is empty whenever the date was not moved, so a non-empty basis is a *guarantee* that an adjustment happened.

The test that shows why this matters: a ₹4L receivable that slipped past a ₹6L payout turns a comfortable projection into a real trough. The naive forecast never saw it.

### Limitations

1. **Nothing populates `paidAt`.** Every real counterparty is `INSUFFICIENT` today, so the forecast is unchanged in practice. Writing it at settlement is the remaining gap.
2. **Nothing assembles the behaviour map.** No query groups payments by counterparty and calls the model; callers must build the map themselves.
3. **Depends on P4 links.** `Transaction.counterpartyId` is not a stored column — the model reads it off the record shape, and the P4 backfill has never run (B-4).
4. **Invoice-level history only.** Partial payments, disputes and credit notes are not modelled.
5. **Amount is carried but unused** — no amount-weighted or amount-conditional behaviour.
6. **`computePredictionAccuracy` has no stored source** of prediction/actual pairs; `Decision.actualOutcome` holds per-decision error but is not aggregated per counterparty (P15).
7. **Constants are reasoned, not calibrated**: min 3/5 payments, 90-day window, 0.7 recency cap, 7-day stability reference, 3-day accuracy half-life. Each is defended in the code; none is fitted to data.

---

## 15. Phase 10 — Scenario forecasting, as built

> **FILES:** `src/lib/forecast/scenarios.ts` + tests (new). **No existing file modified.**
> **PROBLEM:** §28 asks for OPTIMISTIC/BASE/CONSERVATIVE; §29 asks for an understandable forecast confidence.
> **PROPOSED CHANGE:** Three deterministic brackets built from P9's per-event uncertainty band, plus a confidence derivation.
> **DEPENDENCIES:** P8 `ForecastEvent`, P9 behaviour band.
> **MIGRATION IMPACT:** none. **TEST IMPACT:** +18. **SECURITY IMPACT:** none — pure functions.
> **ROLLBACK PLAN:** delete both files; nothing imports them.

### Brackets, not a probability model

§28 permits a probabilistic model but demands its assumptions be explicit *and validated against historical data*. We have neither a fitted distribution nor the history to validate one, so this brackets outcomes by taking each event at the ends of its **own measured range**:

| Scenario | Inflows | Outflows |
|---|---|---|
| CONSERVATIVE | latest plausible | earliest plausible |
| BASE | expected | expected |
| OPTIMISTIC | earliest plausible | latest plausible |

The band comes from measured payment behaviour, so the spread is an *observation about this customer* rather than a guessed confidence interval. Nothing invents a percentile.

### The trap this module avoids

When no behaviour exists, all three scenarios collapse and the spread is zero. It is tempting to read zero spread as high confidence. **It is the opposite.** A zero band means we have no information about timing and are falling back on the contractual date — the one assumption we know is usually wrong.

A degenerate scenario set is therefore reported as **LOW** confidence, never HIGH, with the reason *"Every date is the contractual one; no payment history has been measured, so timing risk is unquantified."* That single assertion is the most important test in the file.

### A real defect the tests caught

The first `degenerate` check compared only the minimum and closing balances. Those **coincide for any set of pure inflows** — the balance never dips, so the minimum is always the opening balance — so a forecast with genuine timing uncertainty was reported as having none, and then handed the "nothing is measured" LOW-confidence reason. It now compares the full day-by-day path.

### Limitations

1. **No consumer.** No route returns scenarios; the UI still shows a single line.
2. **Inert without behaviour** — which today is everywhere (C-14).
3. **Timing only.** `probability` is always 1, so no scenario drops an unlikely inflow. When probability becomes real, CONSERVATIVE should exclude sub-threshold inflows.
4. **A band edge can push an event out of the horizon**, so closing balances are not comparable across scenarios in general — only the minimum ordering is. Tested and documented rather than hidden.
5. **The band is ±1 standard deviation**, not a percentile. It is a spread, and is described as one.
6. **Confidence thresholds** (80%/40% coverage, 6-day band) are reasoned, not calibrated — as with C-12.

---

## 16. Phase 13 — Surfacing it, as built

The first change in this whole sequence that alters **what a user sees**.

> **FILES:** `src/app/api/forecast/route.ts`, `src/context/CashPilotContext.tsx`, `src/app/dashboard/page.tsx`, `src/lib/forecast/movements.ts` (modified); `src/lib/forecast/__tests__/forecastContext.test.ts` (new)
> **PROBLEM:** §29 and §57 ask the UI to state forecast confidence and a plausible range. The dashboard showed a single line with no stated uncertainty, and P10's scenarios reached nobody (B-12).
> **PROPOSED CHANGE:** `/api/forecast` additionally returns `scenarios` and `confidence`; the dashboard renders a "How reliable is this forecast?" card.
> **MIGRATION IMPACT:** none. **TEST IMPACT:** +8.
> **SECURITY IMPACT:** none new — same session guard, same tenant scoping; the added fields are aggregates already derived from data the caller can see.
> **ROLLBACK PLAN:** drop the two response fields and the card; both are additive.

### The band must bracket the line it is drawn around

`buildForecastContextForBusiness` returns movements **and** the events behind them from a single behaviour lookup. That is not an optimisation: if the two were built separately, the BASE scenario could disagree with the headline number printed directly above it, and a scenario band that contradicts its own centre line is worse than showing none.

Two tests assert `scenarios.base.days` is strictly equal to the headline forecast — with the pipeline off *and* on.

### What it says today, and why that is the right answer

With no measured payment history, all three scenarios coincide and the card reads:

> **Low confidence** — We cannot yet put a range around this forecast. Every date below is the one that was agreed, not one we have seen this customer keep.

That is the honest statement, and it is new information the operator did not previously have: the old dashboard presented the same single line with no indication that every date on it was an assumption. The card also spells out the distinction in `confidenceLabel`'s comment — "Low" means *we have not measured enough history*, not *the arithmetic is shaky*.

Both new response fields are **optional** in `ForecastResponse`, so a cached response from an earlier session cannot crash the dashboard.

### Verification, stated precisely

- `npm test` 1287 pass, `typecheck` clean, `lint` 0 problems, `npm run build` OK.
- The dev server was started and the app served: `/login` 200, `/` correctly 307s behind the auth guard.
- `/dashboard` **prerenders at build time** (`○ /dashboard`), which exercises the component tree including the new card.
- **Not verified:** the card rendered with live data in a browser. The dashboard is behind authentication and I do not enter credentials. Its data path is covered by unit tests, not by a screenshot.

### Limitations

1. **Only the dashboard.** The strategies, execution and investigation screens are unchanged.
2. **The chart is unchanged** — no shaded band is drawn on `ForecastChart`; the range is stated numerically only.
3. **Degenerate today**, and will stay so until C-14's preconditions are met.
4. **Cross-source conflicts and evidence trails are still not surfaced** anywhere (§57's "Evidence" section, §58's "why" trace). That is the remaining part of P13.
