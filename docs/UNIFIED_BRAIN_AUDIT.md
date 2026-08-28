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
| **P5** Cross-source reconciliation | ✅ done | this change | claim-specific precedence, state machine, contradictions, consistency scoring |
| **P6** Unified `FinancialState` | next | — | materialised read-through, non-authoritative at first |

### Regression floor after P5

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | 0 problems |
| `npm test` | 77 files, **1082 passed**, 5 skipped (982 baseline + 59 P4 + 41 P5) |
| `npm run build` | OK — same 24 routes + middleware as before |

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
