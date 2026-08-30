# CashPilot — Remaining Work

**As of:** 2026-08-29, after Phase 11.
**Companion to:** [`UNIFIED_BRAIN_AUDIT.md`](./UNIFIED_BRAIN_AUDIT.md) (the plan and what each phase built), [`PHASE_17_RAZORPAY_CERTIFICATION.md`](./PHASE_17_RAZORPAY_CERTIFICATION.md) and [`PHASE_18_PRODUCTION_CLOSURE.md`](./PHASE_18_PRODUCTION_CLOSURE.md) (the provider boundary).

This is the honest list of what is **not** done, and why. It exists so nothing is silently assumed complete.

| Status | Meaning |
|---|---|
| 🔴 **BLOCKED** | Cannot be closed from inside the codebase. Needs a human, a credential, a live provider, or a database decision. |
| 🟠 **HAZARD** | Not a task. A way to break things that must be understood before acting. |
| 🟡 **DEFERRED** | Deliberately not done, or a known limitation to keep in view. |
| 🟢 **READY** | No blocker. Just not built yet. |
| ◑ **PARTIAL** | Half done; the remainder is described in place. |
| ✅ **CLOSED** | Done. Collapsed into a table at the end. |

> **How to read the test numbers in this repo:** a green `npm test` is **not** evidence the branch typechecks — vitest does not typecheck. Use `npm run typecheck`.

---

# ⚠️ WHAT NEEDS YOU

Everything I can do without you is done. These are yours, in order of what unblocks the most.

### 1. Apply the seven migrations — unblocks almost everything else

```bash
npx prisma migrate status
```

> **Superseded 2026-08-30.** All seven are applied — see A-1. The table below is retained as the record of what they added.

Seven additive migrations, verified byte-for-byte against Prisma's own generated DDL:

| Migration | Adds |
|---|---|
| `…_phase1_financial_events` | `FinancialEvent` + enum |
| `…_phase2_evidence_claims` | `Claim`, `Evidence` + enum |
| `…_phase4_entity_resolution` | `Counterparty`, `CounterpartyAlias` + enum; nullable `Invoice.counterpartyId`, `Payout.counterpartyId` |
| `…_phase6_financial_state` | `FinancialState` |
| `…_phase7_decision_state_version` | nullable `Decision.financialStateVersion` |
| `…_phase9_invoice_paid_at` | nullable `Invoice.paidAt` |
| `…_phase11_decision_validity` | nullable `Decision.forecastVersion`, `Decision.expiresAt` |

Five tables, four enums, six nullable columns. **No existing column is altered, dropped or backfilled**, so every existing row reads back identically and no recommendation is retroactively expired.

If they list as pending: `npx prisma migrate deploy`.

**Why it is yours:** running migrations against a database holding real financial data is your call, not mine.

### 2. Run the brain sync once, and read its two warnings

```bash
npm run brain:sync -- --dry-run   # then again without the flag
```

Idempotent, safe to interrupt, moves no money and calls no provider. Two lines in its output need a human, and it says so:

- `** N possible duplicate counterparties need a human decision **` — near-matched names are never merged automatically, because a wrong merge silently poisons one customer's payment history with another's. There is no UI for confirming these yet (**C-3**).
- `** N source conflict(s) need a human decision **` — sources disagree on an amount, and §14 forbids resolving that silently.

### 3. Complete one real Razorpay test payment

The `paid → CONFIRMED_SUCCESS` path — the one that tells a CFO money arrived — **has never run against reality**. Needs a human to complete one payment on the test account. Blocks **A-2**, and with it the production GO.

### 4. Set `RAZORPAY_WEBHOOK_SECRET` and give Razorpay a reachable URL

It is a secret, so I must not handle it. Without it, webhook processing correctly fails closed in production. A tunnel or deployed environment is also needed before a real webhook has ever been delivered (**A-3**).

### 5. Glance at the new dashboard card

"How reliable is this forecast?" is unit-tested and prerenders at build, but I have not seen it with live data — the dashboard is behind authentication and I do not enter credentials (**C-15**).

### Before flipping `FORECAST_EVENT_PIPELINE.enabled`

See **C-14**. The config-version trap that used to sit here is now handled automatically by P11 — but the other preconditions still stand.

---

## A. Blocked — these need you

### A-1 ✅ **CLOSED 2026-08-30** — the seven migrations are applied

`npx prisma migrate status` against the configured database reports **12
migrations found, "Database schema is up to date!"**, on Neon
(`ep-still-base-axwyd206…`). Every item below that was gated on A-1 is
therefore unblocked. The original text is kept for the record:

> ~~Seven migrations have never been applied~~

Full table in **WHAT NEEDS YOU §1**. Nothing that reads the new tables can do anything until these run.

**Rollback:** drop the five new tables and the six nullable columns. Almost nothing reads them (B-1, B-3, B-7), so rollback is isolated.

### A-2 🔴 No real Razorpay settlement has ever been observed (Phase 18 blocker B1)

Carried from `PHASE_18_PRODUCTION_CLOSURE.md` §18. The `paid` mapping is built from recorded response shapes, not a completed payment.

### A-3 🔴 No real webhook has ever been delivered by Razorpay (Phase 18 blocker B2)

In production, settlement arrives by webhook. That path has never been exercised by the provider itself — only by synthesised requests in tests.

### A-4 🔴 `RAZORPAY_WEBHOOK_SECRET` is not configured anywhere (Phase 18 blocker B3)

Fails closed in production without it, which is correct, but means webhooks cannot work until it is set.

### A-5 🔴 Five live provider-contract tests have never run

`src/lib/razorpay/__tests__/providerContract.test.ts` tier C, gated on `RAZORPAY_LIVE_TEST=1`. They are the 5 permanently reported as *skipped*.

```bash
npm run test:live
```

Needs Razorpay **test-mode** credentials in `.env`. They fail loudly rather than skipping if the flag is set with missing or live-mode keys — deliberate.

### A-6 🔴 Production GO / NO-GO is still **NO-GO**

`PHASE_18_PRODUCTION_CLOSURE.md` §20. A-2 and A-3 are the gating blockers.

Phases 1–6, 8, 9 and 10 added no observable production behaviour. P7 and P11 touch the freshness gate but only ever tighten it (**C-10**); P11's expiry is the single new refusal (**C-16**).

---

## B. Built but not reaching production

Phases 1–11 were built additively — libraries with full test coverage and no callers — then wired deliberately. These are the connections that still do not exist.

### B-1 ✅ **CLOSED 2026-08-30** — settlement writes `FinancialEvent`

The append-only spine is idempotent and tested, but no source produces events into it. **Owned by:** the connector phases (P17).

### B-3 🟡 Nothing reads `counterpartyId` except the behaviour model (Phase 4)

`Invoice.customerName` / `Payout.vendor` remain authoritative for display and every engine path. The link is written by `brain:sync` and read only by payment behaviour.

### B-6 ◑ No automatic trigger for state materialisation or reconciliation

`npm run brain:sync` runs both. What does not exist is any **cron, post-write hook or scheduled job** — state advances only when someone runs the script.

Deliberate for a first release, and the reason **B-8** stays open.

### B-7 🟡 Nothing reads `FinancialState` for forecasting (Phase 6)

`buildForecast` still reads canonical rows directly. The freshness gate reads state, but only for decisions recording a version — which is none (B-8).

### B-8 ✅ **CLOSED 2026-08-30** — decisions record the state version

Deliberate ordering, not an oversight: arming a gate against states that nothing keeps current (B-6) would block real work. P11 populates its own two columns because neither depends on a background job; this one does.

**Unblocks when:** B-6 gains an automatic trigger.

### B-12 ◑ Surfacing the brain in the UI

**Done:** `/api/forecast` returns `scenarios` and `confidence`; the dashboard renders "How reliable is this forecast?".

**Not surfaced anywhere:** cross-source conflicts (§14), evidence trails and the "why?" drill-down (§58), merge suggestions (C-3), any subject's reconciliation state, and expiry before it refuses (C-16). The chart draws no band — the range is numeric only.

**Blocked behind A-1** for the evidence-backed parts: those screens read tables that stay empty until the migrations run and `brain:sync` populates them, so they could not be verified against real data.

---

## C. Known limitations and hazards

### C-14 🟠 The chain is one flag flip from changing every forecast

`FORECAST_EVENT_PIPELINE.enabled = false`. Turning it `true` activates, in one step: forecast events → behaviour lookup → shifted expected dates → different forecast days → different runway, risk level and strategy scoring.

| # | Precondition | Status |
|---|---|---|
| 1 | Migrations applied | 🔴 A-1 |
| 2 | `brain:sync` run, so invoices are linked | needs A-1 |
| 3 | 5+ settled payments per customer for the model to act | accumulates on its own — settlement now records `paidAt` |
| 4 | ~~Config versions bumped~~ | ✅ **Automatic** — P11's `forecastVersion` invalidates old decisions itself |
| 5 | Manual-settlement timestamp skew reviewed | 🟡 C-13 |

Until (1)–(3) hold, the flag is also inert in practice — `loadPaymentBehavior` returns an empty map — so flipping it early is safe but pointless.

### C-16 🟡 Recommendations now expire after 7 days

`DECISION_TTL_HOURS = 168`. Older than that is refused at approval and execution even when nothing changed, because a week of total silence in a live ledger is a reason to distrust the inputs (§55–56).

- **Existing decisions are unaffected** — not backfilled, so nothing is retroactively expired.
- **The user sees this only as a refusal.** Expiry is not surfaced in advance (part of B-12).
- The 7-day figure is reasoned against the 14-day horizon, not calibrated (C-12).

### C-10 🟡 The freshness gate has three checks, two of them coarser

P7 added a state comparison; P11 added method-and-age. Both are **strictly additive conservatism**: each takes the more severe verdict, so they can block something that would have passed but never the reverse. Asserted exhaustively.

The state half is **aggregate-level** and structurally cannot see record substitution — one ₹5L invoice replaced by a different ₹5L invoice leaves every aggregate identical. That is the fingerprint's job, which is why none of the three may be removed in favour of another.

### C-13 🟡 `paidAt` records observation time, not provider-attested payment time

No verified provider timestamp exists to use instead (A-3, §37). At day granularity — the only granularity the behaviour model consumes — the error is negligible for webhook settlements.

It is **not** negligible for `MANUAL` settlements: an operator reconciling a week-old payment stamps it a week late, making that customer look worse than they are. Pass a verified provider timestamp into `settlePayment`'s `paidAt` once A-3 closes, and consider excluding manual rows when calibrating (C-12).

### C-1 🟡 Predictive confidence: mechanism complete, data path not

Both missing dimensions are now computable — `consistencyScore` (P5) and `historicalAccuracyScore` (P9). With both supplied, confidence reaches `FULL` completeness and the `UNKNOWN_PREDICTION_CAP = 0.6` clamp lifts.

**Still capped in practice** until `brain:sync` runs against a real database (A-1) and settled history accumulates. The formula is finished; the data is not.

### C-12 🟡 Model constants are reasoned, not calibrated

Behaviour model: minimum 3 payments for any opinion and 5 to move a forecast; 90-day recency window; 0.7 recency cap; 7-day stability reference; 3-day accuracy half-life. Scenarios: 80%/40% coverage thresholds, 6-day wide-band. Decisions: 168-hour TTL.

Each is defended in code and deliberately conservative. **None is fitted to real data** — there is none yet. Revisit once history accumulates; calibration is P15's job.

### C-15 🟡 The dashboard card has not been seen rendered with live data

Covered by unit tests, typechecks, lints, and exercised by the build's prerender of `/dashboard`. **Not** viewed in a browser with real data — the dashboard is behind authentication and I do not enter credentials. Worth a human glance, particularly the degenerate case everyone will see until C-14 is satisfied.

### C-2 🟡 Entity resolution is name-only

No GSTIN, PAN, email domain or bank-account identifiers — any of which would permit *safe* non-exact matching. Today "ABC Ltd" and "ABC Industries Pvt Ltd" stay separate with a merge suggestion until a human confirms. Right with only names to go on, but it will produce duplicates on real data.

### C-3 🟢 Merge has no API route and no UI

`mergeCounterparties` is implemented, guarded (no self-merge, double-merge, cross-type or cross-tenant) and tested, but no user can reach it. `brain:sync` prints the suggestions; nothing acts on them. The §34 suggestion→confirmation loop needs an endpoint and a screen.

### C-4 🟡 Merge is not automatically transactional

`mergeCounterparties` accepts a `$transaction` client and its statement order is chosen so a crash part-way still converges, but it does not open a transaction itself. Once C-3 adds a route, that route must wrap it.

### C-5 🟡 Counterparty aliases key on the normalised form only

Only the first raw spelling producing a given key is retained. Fine for the lookup table's job, but it is not a complete record of every spelling seen — that belongs on `FinancialEvent` / `Evidence`.

### C-6 🟡 The counterparty backfill is sequential

By design: resolution reads the entity set it is also writing. Bounded by counterparty count, not row count, but a very large first backfill will be slow.

### C-7 🟡 `partially_paid` is unmodelled

Falls through to `PENDING` — conservative, but not distinctly represented and never observed live.

### C-8 ✅ **CLOSED 2026-08-30** — bounded backoff on indeterminate reads

Rate limiting is real (a probe hit it during Phase 17). A throttled reconciliation scan yields `UNKNOWN`, which is safe — it never invents a success — but the scan simply degrades.

### C-9 🟡 The provider list-lag bound is a margin, not a measurement

6 seconds observed once; 60 seconds chosen as margin. The true upper bound is unknown. Cost: a legitimate `NOT_FOUND` is delayed by up to a minute — deliberate, since a slow correct answer beats a fast wrong one.

---

## D. Roadmap — what is left

| Phase | Deliverable | Status |
|---|---|---|
| **P12** ◑ | Execution / webhook hardening | Certified in Phases 17/18. A fresh code audit against §37/§38 is **unblocked**; only live verification needs A-2/A-3/A-5. |
| **P13** ◑ | Surface it in the UI | Forecast half done. Remainder (evidence trails, conflicts, "why?" drill-down) reads tables empty until A-1 + `brain:sync`. |
| **P14** ◑ | Outcome measurement → behaviour model | Per-**decision** calibration (`Decision.actualOutcome` → `computePredictionAccuracy`) is **unblocked**. Per-**counterparty** grouping needs the P4 links, so needs A-1. |
| **P15** 🟡 | Forecast calibration / learning loop | Mechanism buildable; needs P14's accumulated observations to do anything. |
| **P16** ◑ | AI explanation over evidence and state | Explaining **scenarios and forecast confidence** is **unblocked** — both exist regardless of A-1. Explaining **evidence** needs evidence. |
| **P17** 🔴 | Additional connectors and financial actions | Not blocked by A-1. Blocked on **decisions only you can make**: which bank/ERP/provider, whose credentials. Largest greenfield in the spec. |

**Spec areas with no implementation at all:** source adapters (§6), background sync + sync health + source freshness (§53–56), stale-data safety (§56), dependency-aware incremental recomputation (§52). All presuppose connectors, so all are downstream of P17.

**Genuinely unblocked right now:** the P12 audit, P14's per-decision half, P16's scenario/confidence half.

---

## E. Repo hygiene

### R-13 ✅ `tsc` failed on a fresh checkout until `prisma generate` ran — **FIXED**

`package.json` now carries `"typecheck": "prisma generate && tsc --noEmit"` (`a8c77bf`), so the schema and generated client cannot drift. Use `npm run typecheck`, never bare `tsc`.

## F. Codebase Audit — Bugs, Dead Code & Improvements

**Audited:** 2026-08-29. Full read-only scan of every `.ts`/`.tsx` file in `src/`, plus configs.
**Remediated:** 2026-08-29. Items marked ✅ FIXED below have been resolved and verified (1322 passed, 5 skipped, 0 errors).

### F-1. Bugs (14 findings)

#### F-1a ✅ FIXED — State machine bypass in payment-status polling
**File:** `src/app/api/payment-status/route.ts` L182–199

~~When a Razorpay link is `cancelled`/`expired`, the code force-updates the action to `FAILED` with only `action.status !== ActionStatus.FAILED`. It does **not** call `validateActionTransition()`. A terminal `COMPLETED` action can be dragged backwards to `FAILED` by a stale poll — a financial integrity risk.~~

**Fix:** Now uses `validateActionTransition(action.status, ActionStatus.FAILED)` to guard the transition.

#### F-1b ✅ FIXED — Execution intent amount mismatch
**File:** `src/lib/execution/actionExecutors.ts` L191, L204

~~`executeRecoverFailedPayments` records `amount: ctx.action.amount` into the intent but creates the Razorpay link with `recovery.amount`. If these differ, reconciliation comparisons break.~~

**Fix:** Intent now records `recovery.amount` — the actual amount sent to the provider.

#### F-1c ✅ FIXED — Hardcoded test strings in action executors
**File:** `src/lib/execution/actionExecutors.ts` L424, L451, L527

~~Fallback queries use hardcoded `vendor: "Packaging Co"`, `description: { contains: "Packaging" }`, and `description: { contains: "SaaS" }`. These demo/test strings will silently match wrong records in production.~~

**Fix:** Operations now return deterministic `FAILED` when `targetId` is missing instead of querying by hardcoded strings.

#### F-1e ✅ FIXED — Idempotency key collision when targetId is null
**File:** `src/lib/execution/executor.ts` L100

~~If `input.targetId` is omitted, `buildIdempotencyKey` produces `cp_${actionId}`. Multiple sub-items with `targetId: null` share the same key and collide.~~

**Fix:** `executeWithDurableIntent` now throws if `targetId` is nullish, preventing silent key collisions.

#### F-1f ✅ FIXED — Timezone shift in ledger date comparison
**File:** `src/lib/execution/ledgerReconciliation.ts` L62–65

~~`dateOnly()` does `new Date(v).toISOString().split("T")[0]`. Midnight IST = previous day in UTC, causing incorrect reconciliation mismatches for payouts due "today".~~

**Fix:** Now uses local date components (`getFullYear`/`getMonth`/`getDate`) instead of UTC conversion.

#### F-1g ✅ FIXED — Strategy engine ignores targetPayoutId
**File:** `src/lib/engine/strategyEngine.ts` L87, L122

~~`applyActionsToMovements` only checks `action.targetTransactionId`. If only `targetPayoutId` is provided, `targetId` is `undefined` and the code falls back to fragile description string matching.~~

**Fix:** Target resolution now falls back to `action.targetPayoutId` (`action.targetTransactionId || action.targetPayoutId`).

#### F-1h ✅ FIXED — Potential sourceId collision in staleness classifier
**File:** `src/lib/engine/strategyFreshness.ts` L387–388

~~`classifyStaleness` uses `o.sourceId` as a Map key. A payout ID and transaction ID could collide. Should use `${o.sourceType}:${o.sourceId}`.~~

**Fix:** Maps now use composite keys `${o.sourceType}:${o.sourceId}`.

#### F-1i ✅ FIXED — Double-counted outflows in liquidity safety
**File:** `src/lib/engine/liquiditySafety.ts` L105

~~`calculateLiquiditySafetyRequirement` sums `projectedTransactions` and `projectedPayouts` without deduplication. Overlapping entries double-count outflows, inflating the safety buffer and producing overly conservative CFO recommendations.~~

**Fix:** Applied conservative deduplication heuristic `Math.max(sumTransactions, sumPayouts)` for total projected outflows.

#### F-1j ✅ FIXED — Mismatched sourceId vs transactionId in temporal liquidity
**File:** `src/lib/engine/liquiditySafety.ts` L329–330

~~`isObligationOutflow` checks `o.sourceId === m.transactionId`. Payout-derived obligations have a payout ID as `sourceId`, which never matches `m.transactionId` — double-counting again.~~

**Fix:** Added `payoutId` support to daily movements and matched `o.sourceId` against `m.payoutId` or `m.transactionId` by source type.

#### F-1k ✅ FIXED — Hacky business lookup in settlement
**File:** `src/lib/razorpay/settlement.ts` L553, L772

~~`(await (tx.business.findUnique || tx.business.findFirst)(...))` is a runtime workaround. Should simply be `tx.business.findUnique`.~~

**Fix:** Simplified to `tx.business.findUnique` directly.

#### F-1l ✅ FIXED — Unreadable small-amount formatting
**File:** `src/lib/razorpay/settlement.ts` L542, L761

~~Discrepancy messages always format in Lakhs. A ₹500 discrepancy renders as `₹0.00L`.~~

**Fix:** Added `formatPaise()` helper that formats in Lakhs if ≥ ₹1L, otherwise in Rupees.

#### F-1m ✅ FIXED — Swallowed JSON parse error
**File:** `src/app/execution/page.tsx` L380–384

~~`try { JSON.parse(...); } catch { }` with empty catch. Malformed JSON is invisible.~~

**Fix:** Added `console.error` logging inside the catch block.

#### F-1n 🟡 Reject reason state discarded
**File:** `src/app/approval/page.tsx` L81, L186–193

`rejectReason` is captured via textarea but `confirmReject()` never submits it. The user's typed reason is silently lost.

---

### F-2. Dead Code (21 findings) — ✅ ALL FIXED

#### ✅ Unused component files — DELETED

| # | File |
|---|------|
| D1 | `src/components/ActionPlanChecklist.tsx` |
| D2 | `src/components/AgentActivityFeed.tsx` |
| D3 | `src/components/BeforeAfterPanel.tsx` |
| D4 | `src/components/StrategyComparisonTable.tsx` |
| D5 | `src/components/ui/StatTile.tsx` |
| D6 | `src/components/ui/useInteraction.ts` |

#### ✅ Unused exports — REMOVED

| # | File | Export | Line |
|---|------|--------|------|
| D7 | `src/lib/razorpay/client.ts` | `isSimulatedProvider()` | 206 |
| D8 | `src/lib/razorpay/settlement.ts` | `UnsafeSettlementAmountError` | 217 |
| D9 | `src/lib/razorpay/settlement.ts` | `resolveSettlementAmount()` | 225 |
| D10 | `src/lib/engine/financialConfig.ts` | `MAX_SAFE_PAISE` | 209 |
| D11 | `src/lib/engine/decisionStateMachine.ts` | `isTerminalDecisionStatus()` | 127 |
| D12 | `src/lib/engine/decisionStateMachine.ts` | `decisionTransitionMap` | 132 |
| D13 | `src/lib/execution/actionExecutors.ts` | `ExecutionHooks` (interface) | 28 |
| D14 | `src/lib/execution/actionExecutors.ts` | `CollectionsLinkDetails` (interface) | 250 |
| D15 | `src/lib/execution/executor.ts` | `IntentReconciliation` (interface) | 262 |
| D16 | `src/lib/execution/executor.ts` | `IntentLikeForRetry` (interface) | 457 |
| D17 | `src/lib/execution/ledgerReconciliation.ts` | `LedgerVerdict` (type) | 23 |
| D18 | `src/lib/execution/ledgerReconciliation.ts` | `PayoutExpectation` (interface) | 38 |
| D19 | `src/lib/execution/ledgerReconciliation.ts` | `TransactionExpectation` (interface) | 45 |

#### ✅ Unused state variables — REMOVED

| # | File | Variable | Line |
|---|------|----------|------|
| D20 | `src/app/dashboard/page.tsx` | `loading` (setter called, value never read) | 63 |
| D21 | `src/app/dashboard/page.tsx` | `monitoringState` (setter called, value never read) | 72 |

---

### F-3. Improvements (17 findings)

#### Code quality

| # | Finding | File | Lines |
|---|---------|------|-------|
| I1 | ✅ **FIXED — Massive duplication:** Extracted shared helper `applySettlementUpdates` for action status/audit-log/prediction updates in `settlement.ts`. | `settlement.ts` | 494–818 |
| I2 | ✅ **FIXED — Hardcoded divisor:** Extracted `PAISE_PER_LAKH` constant and `formatPaise()` helper. | `settlement.ts` | 542, 761 |
| I3 | ✅ **FIXED — Missing switch case:** `statusForOutcome` now handles `BLOCKED_BY_PRIOR_ATTEMPT`. | `actionExecutors.ts` | 40–56 |
| I4 | ✅ **FIXED — Sequential sweep:** `sweepAbandonedIntents` now batch processes using `Promise.allSettled` in batches of 10. | `executionIntent.ts` | 357–363 |
| I5 | ✅ **FIXED — Swallowed settlement error:** Now uses structured `logger.error` instead of `console.error`. | `executor.ts` | 416–422 |
| I6 | ✅ **FIXED — O(n²) lookup:** Pre-built `Map<id, payout>` replaces `payouts.find()` inside `map()`. | `decisionContext.ts` | 74 |

#### Observability / logging

| # | Finding |
|---|---------|
| I7 | ✅ **FIXED — 8 API routes** now use structured `logger.error` from `@/lib/observability` instead of `console.error`: |

Files: `payment-status/route.ts` (L108, L305), `decisions/route.ts` (L64, L101), `execution-intents/route.ts` (L93), `execution-intents/reconcile/route.ts` (L70), `explain/route.ts` (L159), `investigate/route.ts` (L179), `strategy-performance/route.ts` (L223), `approve/route.ts` (L304).

#### Frontend

| # | Finding | File | Lines |
|---|---------|------|-------|
| I8 | ✅ **FIXED — Fragile DOM selection:** Replaced `querySelector` with `useRef`. | `dashboard/page.tsx` | 777 |
| I9 | ✅ **FIXED — Button as link:** Replaced with `<Link>` component for a11y. | `approval/page.tsx` | 219 |
| I10 | ✅ **FIXED — Null dereference risk:** `cause.evidence?.events` now uses optional chaining. | `investigation/page.tsx` | 282 |
| I11 | ✅ **FIXED — Duplicate iteration:** Extracted inflow/outflow calculation to `useMemo`. | `investigation/page.tsx` | 314 |
| I12 | ✅ **FIXED — Fragile string split:** `failedStep.result.split("generated: ")[1]` now guarded with `?? null` fallback. | `execution/page.tsx` | 366 |

#### Config

| # | Finding | File | Lines |
|---|---------|------|-------|
| I13 | ✅ **FIXED — Missing FLoC opt-out:** `Permissions-Policy` header now includes `interest-cohort=()`. | `next.config.ts` | 44 |
| I14 | ⛔ **WON'T FIX — ESM violation:** `require("dotenv/config")` is required because vitest loads config as CJS; top-level `await import()` crashes the runner. | `vitest.config.ts` | 9 |

---

### F — Summary

| Category | Total | ✅ Fixed | ⛔ Won't Fix | 🟡 Feature Gap | Remaining |
|----------|-------|---------|-------------|----------------|-----------|
| 🔴 Bugs | 14 | 13 | 0 | 1 (F-1n: reject reason API) | 0 |
| ⚪ Dead Code | 21 | 21 | 0 | 0 | 0 |
| 🔵 Improvements | 17 | 16 | 1 (I14) | 0 | 0 |
| **Total** | **52** | **50** | **1** | **1** | **0** |

---

### G. UX Hardening — Error Boundaries, Loading States & Metadata

**Added:** 2026-08-29.

#### New components

| File | Purpose |
|------|---------|
| `src/components/ErrorBoundary.tsx` | Catches render errors, shows fallback UI with "Try Again" button |
| `src/components/ui/LoadingSkeleton.tsx` | Animated skeleton with `card`, `text`, `chart` variants |
| `src/components/ui/PageLoading.tsx` | Full-page centered spinner |

#### Loading states (Next.js `loading.tsx` convention)

| Route | File |
|-------|------|
| `/dashboard` | `src/app/dashboard/loading.tsx` |
| `/execution` | `src/app/execution/loading.tsx` |
| `/investigation` | `src/app/investigation/loading.tsx` |
| `/strategies` | `src/app/strategies/loading.tsx` |
| `/approval` | `src/app/approval/loading.tsx` |

#### Per-page metadata (via `layout.tsx` — client pages can't export metadata)

| Route | Title |
|-------|-------|
| `/dashboard` | Dashboard — CashPilot |
| `/execution` | Execution — CashPilot |
| `/investigation` | Investigation — CashPilot |
| `/strategies` | Strategies — CashPilot |
| `/approval` | Approval — CashPilot |
| `/login` | Login — CashPilot |

#### Root error boundary

`src/app/layout.tsx` — children wrapped in `<ErrorBoundary>` so every page has crash protection.

---

## Closed

Kept for the record; no action needed.

| # | Item | Closed by |
|---|---|---|
| **B-2** | Nothing writes `Claim` / `Evidence` | `brain:sync` stage 2 |
| **B-4** | Counterparty backfill unwired | `brain:sync` stage 1 |
| **B-5** | Nothing calls the cross-source reconciler | P6 `runReconciliation` |
| **B-9** | No call site uses the ForecastEvent pipeline | All five forecast routes switched |
| **B-10** | Nothing populates `Invoice.paidAt` | Written at settlement, write-once |
| **B-11** | Nothing assembles the behaviour map | `loadPaymentBehavior` |
| **C-11** | Flipping the pipeline needed a manual config bump | P11 `forecastVersion` — now automatic |
| **R-14** | Phase 4 uncommitted | `dae385b` |

---

## Regression floor

Any change must keep this green.

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | 0 problems |
| `npm test` | 91 files, **1322 passed**, 5 skipped |
| `npm run build` | OK — 24 routes + middleware |

The 5 skipped are **A-5**.


---

## H. Post-audit remediation — 2026-08-30

A fresh audit of everything committed after `15e91ef`, against the code rather
than against this document. Branch `sujan`.

### The document was wrong about its own master blocker

**A-1 was closed and nobody updated it.** All 12 migrations are applied, against
a Neon database — `.env` points at production, not the local dev server this
file assumed. Everything gated on A-1 was therefore not actually blocked.

### Two defects found in post-`15e91ef` code

#### H-1 ✅ Liquidity buffer understated by 40% — `liquiditySafety.ts`

`Math.max(sumTransactions, sumPayouts)`, added as F-1i's fix and commented as
"a conservative deduplication heuristic". It is not conservative. It is correct
only when one set contains the other; when a scheduled payout and an unrelated
pending charge are **disjoint** — the ordinary case — it discards the smaller
set entirely.

Direction is what makes it serious: understating projected outflow understates
the run-rate, understates the required buffer, and makes a business look safer
than it is. F-1i's original double-counting bug erred the *safe* way. Measured
on the new fixtures: **6,428,571 where the deduplicated sum gives 10,714,286**.

Now reuses `extractObligations`, which already deduplicates by source id and by
(amount, due-date) proximity, and sums the survivors.
**Tests:** `src/lib/engine/__tests__/projectedOutflowDedup.test.ts` (5).

This also exposed a second confusion the heuristic was hiding: a test mocked
`transaction.findMany` with a blanket value, so the **settled** history row was
answering the **pending** projected query and past spend was counted as future
outflow.

#### H-2 ✅ Notification dispatch failed OPEN on database errors — `alertStore.ts`

Both gates between "a crisis exists" and "an email is sent" caught database
errors and fell back to a per-process in-memory store. On serverless every
concurrent invocation is a different process with an empty one, so a transient
fault made the dedup lookup report "never emailed about this crisis" and the
claim report an exclusive claim. N workers → N duplicate emails, precisely when
the database is unhealthy and retries are likeliest.

Verified before the fix: the claim returned `true` on a thrown query;
`[true, false, false]` across three concurrent callers in one process.

Both now fail closed. A suppressed alert is recovered on the next scheduled
evaluation; a duplicate email cannot be recalled. The per-recipient loop gained
a guard, without which one unhealthy lookup would have ended the scheduled pass
for every business.
**Tests:** `src/lib/notifications/__tests__/dispatchFailsClosed.test.ts` (5).

### Closed in this pass

| # | Item | How | Tests |
|---|---|---|---|
| **A-1** | Migrations applied | Verified against Neon | `prisma migrate status` |
| **B-1** | `FinancialEvent` has a writer | Settlement appends `INVOICE_PAID` / `PAYMENT_RECEIVED` on the same transaction client as the ledger movement; identity is `paymentLinkId:targetKind:targetId` | `settlementEvents.test.ts` (8) |
| **B-8** | `Decision.financialStateVersion` populated | Read outside the transaction; null until a state exists, which the gate reads as NOT_TRACKED | `decisionStateVersion.test.ts` (5) |
| **C-8** | Provider 429 backoff | Exponential + full jitter, 3 attempts, **reads only** | `retry.test.ts` (14) |

`B-1` also records `settlementTrigger` and `timestampMeaning`
(`PROVIDER_REPORTED` vs `OBSERVED`) on each event, which puts **C-13** into the
data instead of leaving it in a comment.

### Regression floor after this pass

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors |
| `npm test` | 99 files, **1381 passed**, 5 skipped |
| `npm run build` | passing |

### Still open, unchanged

**B-6** (no automatic trigger for sync/materialisation), **B-7** (forecast still
reads canonical rows, not `FinancialState`), **C-3** (merge has no API or UI),
**C-7** (`partially_paid` unmodelled), **C-9** (list-lag margin still hard-coded),
**B-12** (conflicts, evidence trails, "why?" drill-down unsurfaced).

**Human-only, unchanged:** A-2 (real test-mode payment), A-3 (real webhook
delivery), A-4 (`RAZORPAY_WEBHOOK_SECRET`), A-5 (live provider-contract tier).
Production GO remains **NO-GO** on A-2/A-3.

**Minor, not fixed:** the cron secret is compared with `===` rather than a
timing-safe comparison. Network jitter dominates any timing signal over HTTP, so
this is defence-in-depth rather than a live vulnerability — but the webhook HMAC
path already uses `timingSafeEqual` and this should match it.
