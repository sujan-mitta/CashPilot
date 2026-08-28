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
