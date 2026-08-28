# CashPilot — Remaining Work

**As of:** 2026-08-28, after Phase 8 (ForecastEvent seam).
**Companion to:** [`UNIFIED_BRAIN_AUDIT.md`](./UNIFIED_BRAIN_AUDIT.md) (the plan), [`PHASE_17_RAZORPAY_CERTIFICATION.md`](./PHASE_17_RAZORPAY_CERTIFICATION.md) and [`PHASE_18_PRODUCTION_CLOSURE.md`](./PHASE_18_PRODUCTION_CLOSURE.md) (the provider boundary).

This is the honest list of what is **not** done, and why. It exists so that nothing is silently assumed complete.

Every item is one of:

| Status | Meaning |
|---|---|
| 🔴 **BLOCKED** | Cannot be closed from inside the codebase. Needs a human, a credential, a live provider, or a database decision. |
| 🟡 **DEFERRED** | Deliberately not done. The phase that owns it has not run yet, or doing it early would violate the additive posture. |
| 🟢 **READY** | No blocker. Just not built yet. |

A note on how to read the test numbers anywhere in this repo: **a green `npm test` is not evidence that the branch typechecks** — vitest does not typecheck. Use `npm run typecheck` (see `R-13`).

---

## A. Blocked — these need you

### A-1 🔴 Phase 1/2/4/6/7 migrations have never been applied to a database

Five migration directories exist and have never been run by me against your Neon database:

| Migration | Adds |
|---|---|
| `20260828000000_phase1_financial_events` | `FinancialEvent` + `FinancialEventType` |
| `20260828010000_phase2_evidence_claims` | `Claim`, `Evidence` + `ClaimType` |
| `20260828020000_phase4_entity_resolution` | `Counterparty`, `CounterpartyAlias`, `CounterpartyType`, nullable `Invoice.counterpartyId` / `Payout.counterpartyId` |
| `20260828030000_phase6_financial_state` | `FinancialState` |
| `20260828040000_phase7_decision_state_version` | nullable `Decision.financialStateVersion` |

All five are additive — new tables, one new enum each for P1/P2/P4, and three nullable columns with no default and no backfill — so no existing row is rewritten and every existing query reads back identically.

**Why blocked:** running migrations against a database holding real financial data is your call, not mine. The Phase 4 DDL was verified byte-for-byte against `prisma migrate diff` output, but *verified* is not *applied*.

**What unblocks it:** confirm, then:

```bash
npx prisma migrate status
```

and if the five are listed as pending, `npx prisma migrate deploy`.

**Rollback:** drop the new tables and the two nullable columns. Nothing reads them (see B-1), so rollback is isolated.

---

### A-2 🔴 No real Razorpay settlement has ever been observed (Phase 18 blocker B1)

Carried forward unchanged from `PHASE_18_PRODUCTION_CLOSURE.md` §18. The `paid` → `CONFIRMED_SUCCESS` path — the one that tells a CFO the money actually arrived — has never run against reality. The mapping is built from recorded response shapes, not from a completed payment.

**Why blocked:** it needs a human to complete one real payment on the Razorpay **test** account. I cannot make a payment.

---

### A-3 🔴 No real webhook has ever been delivered by Razorpay (Phase 18 blocker B2)

In production, settlement arrives by webhook. That path has never been exercised end-to-end by the provider itself — only by synthesised requests in tests.

**Why blocked:** needs a public tunnel or a deployed environment for Razorpay to call.

---

### A-4 🔴 `RAZORPAY_WEBHOOK_SECRET` is not configured anywhere (Phase 18 blocker B3)

The code fails closed in production without it — which is correct — but it means webhook processing cannot work in production until the secret is set.

**Why blocked:** it is a secret. I must not handle it. Set it in your deployment environment yourself.

---

### A-5 🔴 Five live provider-contract tests have never run

`src/lib/razorpay/__tests__/providerContract.test.ts` tier C — 5 tests, gated on `RAZORPAY_LIVE_TEST=1` so an ordinary `npm test` can never reach out to Razorpay. They are the 5 permanently reported as *skipped*.

```bash
npm run test:live
```

**Why blocked:** needs Razorpay **test-mode** credentials in `.env`. They fail loudly rather than skipping if the flag is set with missing or live-mode keys — that is deliberate.

---

### A-6 🔴 Production GO / NO-GO is still **NO-GO**

Stated in `PHASE_18_PRODUCTION_CLOSURE.md` §20. A-2 and A-3 remain the gating blockers. Phases 1–6 and P8 added no production behaviour at all; P7 modifies the freshness gate but is provably inert for every existing decision (see C-10).

---

## B. Deferred by design — the additive posture

Phases 1–6 were each built as *additive*: new tables, new libraries, full test coverage, and **deliberately zero production consumers**. P7 is the first to touch the money path, and does so under a proved safety property (C-10). No route and no forecast number has changed.

**⚠️ The additive posture ends at P9.** P8 built the forecast seam but is parity-proven to change no number. **P9 is the first phase that will intentionally change a forecast figure**, and flipping `FORECAST_EVENT_PIPELINE.enabled` at that point requires a config-version bump so existing strategies go stale (see C-11).

Verified by grep at the time of writing: `recordFinancialEvent`, `recordClaimWithEvidence` / `ingest*`, `resolveCounterparty` / `mergeCounterparties` / `backfill*`, and `reconcileObservations` / `sourceAuthority` have **no callers outside their own modules and tests**.

### B-1 🟡 Nothing writes `FinancialEvent` (Phase 1)

The append-only spine exists and is idempotent, but no source produces events into it. The writer is exercised only by its tests.

**Owned by:** the connector phases (P17) and the ingestion wiring that precedes them.

### B-2 🟡 Nothing writes `Claim` / `Evidence` (Phase 2)

`deriveFromInvoice` / `deriveFromTransaction` / `deriveFromPayout` map existing domain rows to claims and evidence, and `recordClaimWithEvidence` persists them idempotently. Neither is called, and **no backfill runner exists** to walk existing invoices/transactions/payouts.

**Owned by:** P6, the first phase that actually needs claims to read. P5 consumes claim *types* but takes its observations as arguments.

### B-3 🟡 Nothing reads `counterpartyId` (Phase 4)

`Invoice.customerName` and `Payout.vendor` remain authoritative for display and for every engine path. The new column is written by nothing and read by nothing.

**Owned by:** P9 (behaviour model) is the first real consumer — it needs a stable entity to attach payment history to.

### B-4 🟡 The counterparty backfill is not wired to a route or a job

`backfillInvoiceCounterparties` / `backfillPayoutCounterparties` are implemented, tenant-safe and tested (including re-run safety), but nothing invokes them. Running a backfill over real data should be an explicit, deliberate action — not a side effect of a deploy.

**Blocked behind:** A-1 (the columns must exist first).

### B-5 ✅ Nothing calls the cross-source reconciler — **DONE in P6**

`runReconciliation` now assembles groups from stored claims/evidence and writes `consistencyScore` + re-derived `derivedConfidence` back. Still not *scheduled* — see B-6.

### B-6 🟡 Nothing schedules state materialisation or reconciliation (Phase 6)

`materializeFinancialState` and `runReconciliation` are implemented and tested, but no route, cron or post-write hook invokes either. And since B-2 still stands, a real run today would reconcile zero subjects.

**Owned by:** P7/P8, where the state acquires its first reader.

### B-7 🟡 Nothing reads `FinancialState` for forecasting (Phase 6)

`buildForecast` still reads the canonical rows directly. P7 made the freshness gate read state, but only for decisions that record a version — which is none (B-8).

**Owned by:** P8 — feeding unified state into the forecast, behind a flag and parity-tested.

### B-8 🟡 Nothing writes `Decision.financialStateVersion` (Phase 7)

The freshness gate consults the financial state whenever a decision records the version it was generated against. No decision records one, so the state half reports `NOT_TRACKED` everywhere and contributes nothing.

This is deliberate ordering, not an oversight: arming a gate against states that nothing maintains (B-6) would block real work. Setting the version belongs with P8, where state acquires its first real reader.

**Owned by:** P8.

### B-9 🟡 No call site uses the ForecastEvent pipeline (Phase 8)

The five production forecast call sites (`forecast`, `explain`, `investigate`, `strategies`, `execute` routes, plus `strategyEngine` and `testEngine`) still call `transactionsToMovements` directly rather than `buildMovements`. Switching them is safe — parity is proven strictly, including the resulting forecasts and runway metrics — but it is a separate, reviewable change and buys nothing until P9 gives the pipeline something to do.

**Owned by:** P9.

---

## C. Known limitations of what has been built

These are not bugs. They are places where the current implementation is deliberately conservative or deliberately incomplete, and where that fact must not be forgotten.

### C-1 🟡 Predictive confidence: half the ceiling lifted, half remains

`src/lib/evidence/confidence.ts` computes five dimensions. As of **P5**:

- `consistencyScore` — ✅ **now computable** via `reconcile.ts`. A corroborated prediction reaches ~0.95 where it was capped at 0.6; a contradicted one drops to 0.
- `historicalAccuracyScore` — ❌ still `null`, needs the behaviour model (**P9**)

The `UNKNOWN_PREDICTION_CAP = 0.6` clamp still applies to any claim where *neither* dimension is known. P6 added `runReconciliation`, which writes the score back to `Evidence` — but nothing schedules it (B-6) and nothing writes claims in the first place (B-2), so in practice every stored claim is still capped.

### C-10 🟡 The freshness gate now has a second, coarser check

P7 added a financial-state comparison alongside the record-level `contextFingerprint`. It is **strictly additive conservatism**: `combineFreshness` takes the more severe of the two verdicts, so it can only block something that would have passed — never the reverse. All sixteen verdict combinations are asserted.

Two things to keep in mind:

- The state half is **aggregate-level** and structurally cannot see record substitution. One ₹5L invoice replaced by a different ₹5L invoice leaves every aggregate identical. That is the fingerprint's job, and always will be — which is why neither check may be removed in favour of the other.
- It is currently **inert** (B-8). Once decisions start recording a state version, the gate becomes stricter, and a state that goes stale or unreadable will begin blocking execution. That is intended, but it is a behaviour change that will first appear when B-8 lands — not now.

### C-11 🟡 Turning on the forecast pipeline will eventually need a config bump

`FORECAST_EVENT_PIPELINE.enabled` is off and currently a no-op either way — the pipeline is parity-proven identical. That stops being true the moment P9 makes `applyExpectedTiming` move dates.

**When that happens, `SCORING_CONFIG_VERSION` / `LIQUIDITY_CONFIG_VERSION` must be bumped in the same change.** Otherwise strategies generated under the old pipeline would survive into a different forecast without the freshness gate classifying them `MATERIAL_CHANGE`. The requirement is written in the code beside the flag, but it is a manual step and nothing enforces it.

### C-2 🟡 Entity resolution is name-only

No use of GSTIN, PAN, email domain, or bank-account identifiers. Those would permit *safe* non-exact matching — two spellings sharing a GSTIN are the same company, with no fuzzy guessing involved.

Currently, `"ABC Ltd"` and `"ABC Industries Pvt Ltd"` stay separate with a merge suggestion, forever, until a human confirms. That is the right default with only names to go on, but it will produce duplicate entities on real data.

**Unblocked when:** a source actually supplies a strong identifier. Natural P4.1.

### C-3 🟢 Merge has no API route and no UI

`mergeCounterparties` is implemented, guarded (no self-merge, no double-merge, no cross-type, no cross-tenant) and tested, but there is no way for a user to reach it. The suggestion → confirmation loop that spec §34 describes needs both an endpoint and a screen.

`ENTITY_MERGE_SUGGESTED` is logged, so suggestions are observable today — but only in logs.

### C-4 🟡 Merge is not automatically transactional

`mergeCounterparties` accepts a `$transaction` client and its statement order is chosen so that a crash part-way still converges (aliases are repointed *before* the loser is marked merged, so the old name resolves forward either way). But it does not open a transaction itself — the caller must. Once C-3 adds a route, that route must wrap it.

### C-5 🟡 Counterparty aliases key on the normalised form only

The alias unique is `(businessId, type, normalizedName)`, so only the **first** raw spelling that produced a given key is retained. `"ABC Ltd"` and `"ABC LIMITED"` collapse to one alias row.

This is fine for the alias table's job (fast lookup), but it means the alias table is **not** a complete record of every spelling ever seen. Full spelling history belongs on `FinancialEvent` / `Evidence`.

### C-6 🟡 The counterparty backfill is sequential

By design: resolution reads the entity set it is also writing to, so concurrent rows for the same new name would race on every insert. Bounded by a tenant's *counterparty* count rather than its row count, so this is unlikely to matter — but it is not parallelised, and a very large first backfill will be slow.

### C-7 🟡 `partially_paid` is unmodelled

Carried from Phase 17/18. It currently falls through to `PENDING` — conservative, but the state is not distinctly represented and has never been observed live.

### C-8 🟡 No backoff on provider HTTP 429

Rate limiting from Razorpay is real (a probe hit it during Phase 17). A busy reconciliation scan that gets throttled yields `UNKNOWN`, which is *safe* — it never invents a success — but there is no retry backoff, so the scan simply degrades.

### C-9 🟡 The provider list-lag bound is a margin, not a measurement

6 seconds was observed once; 60 seconds was chosen as a safety margin. The true upper bound is unknown. The cost is that a legitimate `NOT_FOUND` conclusion is delayed by up to a minute — deliberate, since a slow correct answer beats a fast wrong one.

---

## D. Not started — the rest of the roadmap

From `UNIFIED_BRAIN_AUDIT.md` §5. P0–P4 are done; everything below is untouched.

| Phase | Deliverable | Notes |
|---|---|---|
| ~~**P5**~~ | ~~Cross-source reconciliation of inbound evidence~~ | ✅ **Done.** See `UNIFIED_BRAIN_AUDIT.md` §10. Persistence deferred to P6 (B-5). |
| ~~**P6**~~ | ~~`FinancialState` materialisation~~ | ✅ **Done.** See `UNIFIED_BRAIN_AUDIT.md` §11. Not scheduled (B-6), not read (B-7). |
| ~~**P7**~~ | ~~`stateVersion` ↔ freshness~~ | ✅ **Done.** See §12. Wired alongside the fingerprint; inert until B-8 writes the version. |
| ~~**P8**~~ | ~~ForecastEvent seam~~ | ✅ **Done.** See §13. Parity-proven identical; no call site switched over yet (B-9). |
| **P9** 🟢 | Customer/supplier behaviour model | **Recommended next.** First real consumer of P4, lifts the other half of C-1, and the first phase to intentionally change a forecast number. |
| **P10** 🟢 | Scenario forecasting (OPTIMISTIC / BASE / CONSERVATIVE) | |
| **P11** 🟢 | Freshness ↔ `stateVersion` | Mostly done already; needs integration only |
| **P12** 🟢 | Execution/webhook hardening | Mostly done; the open part is A-2/A-3/A-5 verification |
| **P13** 🟢 | Cross-source reconciliation surfaced in UI/observability | |
| **P14** 🟢 | Outcome measurement → behaviour model | Measurement exists; the connection does not |
| **P15** 🟢 | Forecast calibration / learning loop | |
| **P16** 🟢 | AI explanation over evidence and state | Extends the existing explain layer |
| **P17** 🟢 | Additional connectors and financial actions | Bank, ERP, email, documents — none exist today |

**Spec areas with no implementation at all yet:** source adapters (§6), background sync + sync health + source freshness (§53–56), stale-data safety (§56), and dependency-aware incremental recomputation (§52). All of these presuppose connectors, so they are downstream of P17.

---

## E. Repo hygiene

### R-13 ✅ `tsc` fails on a fresh checkout until `prisma generate` runs — **FIXED**

Found while establishing the Phase 4 baseline, and it bit this session: `npx tsc --noEmit` reported 16 errors on a clean tree because the generated Prisma client is gitignored (regenerated by `postinstall`) and the local copy predated the Phase 1–3 models. `FinancialEvent`, `Claim`, `Evidence` and `ClaimType` simply did not exist as types.

**The trap:** vitest does not typecheck, so `npm test` was fully green throughout. A green test run says nothing about whether the branch compiles.

**Fixed** in `a8c77bf` — `package.json` now carries:

```json
"typecheck": "prisma generate && tsc --noEmit"
```

so the two can never drift apart again. Use `npm run typecheck` rather than bare `tsc`.

### R-14 ✅ Phase 4 is uncommitted — **DONE**

Committed as `dae385b`.

---

## Regression floor

Any change must keep this green.

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | 0 problems |
| `npm test` | 83 files, **1201 passed**, 5 skipped |
| `npm run build` | OK — 24 routes + middleware |

The 5 skipped are A-5.
