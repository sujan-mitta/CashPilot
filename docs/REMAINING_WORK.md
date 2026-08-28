# CashPilot — Remaining Work

**As of:** 2026-08-29, after Phase 13 + the brain sync runner. **The forecast chain is wired and one flag flip from live** — see C-14.
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

# ⚠️ WHAT NEEDS YOU

Everything I can do without you is done. These five are yours, in order of what unblocks the most.

### 1. Apply the six migrations — unblocks almost everything else

```bash
npx prisma migrate status
```

Six additive migrations are written and verified byte-for-byte against Prisma's own generated DDL, and **none has been applied**. They add five tables, three enums and four nullable columns; no existing column is altered, dropped or backfilled, so every existing row reads back identically.

If they list as pending: `npx prisma migrate deploy`.

**Why it is yours:** running migrations against a database holding real financial data is your call, not mine. Everything below marked "blocked behind A-1" is waiting on this and nothing else.

### 2. Run the brain sync once, and read what it reports

```bash
npm run brain:sync -- --dry-run
```

Then without `--dry-run`. It is idempotent and safe to re-run, and it moves no money and calls no provider.

**Read two lines of its output before trusting anything downstream:**
- `** N possible duplicate counterparties need a human decision **` — near-matched names are never merged automatically, because a wrong merge silently poisons one customer's payment history with another's. There is no UI for confirming these yet (C-3).
- `** N source conflict(s) need a human decision **` — sources disagree about an amount, and nothing resolves that automatically (§14).

### 3. Complete one real Razorpay test payment

The `paid → CONFIRMED_SUCCESS` path — the one that tells a CFO money arrived — **has never run against reality**. It needs a human to complete one payment on the test account. Blocks A-2, and with it the production GO.

### 4. Set `RAZORPAY_WEBHOOK_SECRET`, and give Razorpay a URL it can reach

It is a secret, so I must not handle it. Without it webhook processing correctly fails closed in production. A tunnel or deployed environment is also needed before a real webhook has ever been delivered (A-3).

### 5. Glance at the new dashboard card

The "How reliable is this forecast?" card is unit-tested and prerenders at build, but I have not seen it with live data — the dashboard is behind authentication and I do not enter credentials (C-15).

### Do NOT flip `FORECAST_EVENT_PIPELINE.enabled` yet

It is one boolean from changing every forecast number. **C-14 lists the five preconditions.** The one that will bite is bumping `SCORING_CONFIG_VERSION` / `LIQUIDITY_CONFIG_VERSION` in the same change — without it, strategies built under the old pipeline keep passing the freshness gate into a forecast that no longer matches them.

---

## A. Blocked — these need you

### A-1 🔴 Phase 1/2/4/6/7/9 migrations have never been applied to a database

Six migration directories exist and have never been run by me against your Neon database:

| Migration | Adds |
|---|---|
| `20260828000000_phase1_financial_events` | `FinancialEvent` + `FinancialEventType` |
| `20260828010000_phase2_evidence_claims` | `Claim`, `Evidence` + `ClaimType` |
| `20260828020000_phase4_entity_resolution` | `Counterparty`, `CounterpartyAlias`, `CounterpartyType`, nullable `Invoice.counterpartyId` / `Payout.counterpartyId` |
| `20260828030000_phase6_financial_state` | `FinancialState` |
| `20260828040000_phase7_decision_state_version` | nullable `Decision.financialStateVersion` |
| `20260828050000_phase9_invoice_paid_at` | nullable `Invoice.paidAt` |

All six are additive — new tables, one new enum each for P1/P2/P4, and four nullable columns with no default and no backfill — so no existing row is rewritten and every existing query reads back identically.

**Why blocked:** running migrations against a database holding real financial data is your call, not mine. The Phase 4 DDL was verified byte-for-byte against `prisma migrate diff` output, but *verified* is not *applied*.

**What unblocks it:** confirm, then:

```bash
npx prisma migrate status
```

and if the six are listed as pending, `npx prisma migrate deploy`.

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

Stated in `PHASE_18_PRODUCTION_CLOSURE.md` §20. A-2 and A-3 remain the gating blockers. Phases 1–6, P8 and P9 added no observable production behaviour; P7 modifies the freshness gate but is provably inert for every existing decision (C-10). B-10 writes one new nullable column at settlement and changes no existing value (C-13).

---

## B. Deferred by design — the additive posture

Phases 1–6 were each built as *additive*: new tables, new libraries, full test coverage, and **deliberately zero production consumers**. P7 is the first to touch the money path, and does so under a proved safety property (C-10). No route and no forecast number has changed.

**⚠️ The additive posture ends at P9.** P8 built the forecast seam but is parity-proven to change no number. **P9 is the first phase that will intentionally change a forecast figure**, and flipping `FORECAST_EVENT_PIPELINE.enabled` at that point requires a config-version bump so existing strategies go stale (see C-11).

Verified by grep at the time of writing: `recordFinancialEvent`, `recordClaimWithEvidence` / `ingest*`, `resolveCounterparty` / `mergeCounterparties` / `backfill*`, and `reconcileObservations` / `sourceAuthority` have **no callers outside their own modules and tests**.

### B-1 🟡 Nothing writes `FinancialEvent` (Phase 1)

The append-only spine exists and is idempotent, but no source produces events into it. The writer is exercised only by its tests.

**Owned by:** the connector phases (P17) and the ingestion wiring that precedes them.

### B-2 ✅ Nothing writes `Claim` / `Evidence` — **DONE**

`syncFinancialBrain` stage 2 ingests every invoice, transaction and payout as claims + evidence. Run with `npm run brain:sync`.

### B-3 🟡 Nothing reads `counterpartyId` (Phase 4)

`Invoice.customerName` and `Payout.vendor` remain authoritative for display and for every engine path. The new column is written by nothing and read by nothing.

**Owned by:** P9 (behaviour model) is the first real consumer — it needs a stable entity to attach payment history to.

### B-4 ✅ The counterparty backfill is not wired — **DONE**

`syncFinancialBrain` stage 1 runs both backfills. Exposed as a **script, not a route or cron**, on purpose: the entity set it produces from free-text names is what every later behaviour metric hangs off, so the first run over real data should be a decision someone makes deliberately.

**Still blocked behind A-1** — the columns must exist before it can run.

### B-5 ✅ Nothing calls the cross-source reconciler — **DONE in P6**

`runReconciliation` now assembles groups from stored claims/evidence and writes `consistencyScore` + re-derived `derivedConfidence` back. Still not *scheduled* — see B-6.

### B-6 ◑ Scheduling state materialisation and reconciliation — **PARTLY DONE**

`syncFinancialBrain` stages 3 and 4 run both, and `npm run brain:sync` invokes it. What does *not* exist is any **automatic** trigger — no cron, no post-write hook. State advances only when someone runs the script.

That is deliberate for a first release, but it means `Decision.financialStateVersion` should not be populated until state is being kept current, or the freshness gate would compare against a stale snapshot (B-8).

### B-7 🟡 Nothing reads `FinancialState` for forecasting (Phase 6)

`buildForecast` still reads the canonical rows directly. P7 made the freshness gate read state, but only for decisions that record a version — which is none (B-8).

**Owned by:** P8 — feeding unified state into the forecast, behind a flag and parity-tested.

### B-8 🟡 Nothing writes `Decision.financialStateVersion` (Phase 7)

The freshness gate consults the financial state whenever a decision records the version it was generated against. No decision records one, so the state half reports `NOT_TRACKED` everywhere and contributes nothing.

This is deliberate ordering, not an oversight: arming a gate against states that nothing maintains (B-6) would block real work. Setting the version belongs with P8, where state acquires its first real reader.

**Owned by:** P8.

### B-9 ✅ No call site uses the ForecastEvent pipeline — **DONE**

All five production forecast routes (`forecast`, `explain`, `investigate`, `strategies`, `execute`) now call `buildMovementsForBusiness` instead of `transactionsToMovements`.

With the flag off this is **provably inert**: the disabled path issues no query at all and returns exactly what `transactionsToMovements` returned, asserted by test. `financialState.ts` deliberately still uses the direct call — it must stay pure and synchronous, and a materialised state should record contractual reality rather than a behavioural projection. `testEngine.ts` has no callers and was left alone.

### B-10 ✅ Nothing populates `Invoice.paidAt` — **DONE**

`settlePayment` now stamps `paidAt` in the same compare-and-swap that moves the invoice to `PAID`. There turned out to be exactly **one** place in the codebase that marks an invoice paid, so this is complete rather than partial.

The CAS guard makes it **write-once**: only the settler that actually moves the invoice out of its previous status writes a date, so a repeat or concurrent settlement cannot overwrite the original arrival time with a later one. Tested to ten redeliveries.

**Timestamp choice — deliberate.** It defaults to *observation time*, not a provider-attested `paid_at`. A provider timestamp would be strictly better, but this system has never received a real Razorpay webhook (A-3), so the field name and units cannot be verified, and §37 forbids assuming provider payload structure. Observation time has a known bounded meaning, and the behaviour model buckets by **day**, so webhook lag of seconds or minutes moves no metric. `settlePayment` takes an optional `paidAt` — pass a verified provider timestamp there as soon as A-3 is closed. See C-13.

### B-12 ◑ Surfacing scenarios and confidence — **PARTLY DONE**

`/api/forecast` now returns `scenarios` and `confidence`, and the dashboard renders a "How reliable is this forecast?" card stating the range and why. Done for the forecast.

**Still not surfaced anywhere:** cross-source conflicts (§14), evidence trails and the "why?" drill-down (§58), merge suggestions (C-3), and the reconciliation state of any subject. The chart also draws no band — the range is numeric only.

### B-11 ✅ Nothing assembles the behaviour map — **DONE**

`loadPaymentBehavior` reads settled invoices (tenant-scoped, bounded by a 365-day window and a row cap) and returns `Map<counterpartyId, PaymentBehavior>`. It reports what it could not use — `skippedUnlinked` counts settled invoices with no counterparty link, making the B-4 gap visible rather than silent.

`buildMovementsForBusiness` joins it to the forecast pipeline, degrading to contractual dates if the history read fails: behaviour is an enhancement, and losing it must not take the forecast down.

---

## C. Known limitations of what has been built

These are not bugs. They are places where the current implementation is deliberately conservative or deliberately incomplete, and where that fact must not be forgotten.

### C-1 ✅ Predictive confidence ceiling — **MECHANISM COMPLETE**

Both missing dimensions of `src/lib/evidence/confidence.ts` are now computable:

- `consistencyScore` — ✅ P5 `reconcile.ts` (cross-source agreement)
- `historicalAccuracyScore` — ✅ P9 `computePredictionAccuracy` (track record)

With both supplied, confidence reaches `FULL` completeness and the `UNKNOWN_PREDICTION_CAP = 0.6` clamp no longer applies. Asserted end-to-end in both phases' tests.

**But it is still capped in practice**, because nothing feeds it real data: nothing writes claims (B-2), nothing schedules reconciliation (B-6), and nothing populates `paidAt` (B-10). The formula is finished; the data path is not.

### C-10 🟡 The freshness gate now has a second, coarser check

P7 added a financial-state comparison alongside the record-level `contextFingerprint`. It is **strictly additive conservatism**: `combineFreshness` takes the more severe of the two verdicts, so it can only block something that would have passed — never the reverse. All sixteen verdict combinations are asserted.

Two things to keep in mind:

- The state half is **aggregate-level** and structurally cannot see record substitution. One ₹5L invoice replaced by a different ₹5L invoice leaves every aggregate identical. That is the fingerprint's job, and always will be — which is why neither check may be removed in favour of the other.
- It is currently **inert** (B-8). Once decisions start recording a state version, the gate becomes stricter, and a state that goes stale or unreadable will begin blocking execution. That is intended, but it is a behaviour change that will first appear when B-8 lands — not now.

### C-15 🟡 The dashboard card has not been seen rendered with live data

The "How reliable is this forecast?" card is covered by unit tests on its data path, typechecks, lints, and is exercised by the build's prerender of `/dashboard`. It has **not** been viewed in a browser with real data, because the dashboard is behind authentication and I do not enter credentials.

Worth a human glance on the next login — particularly the degenerate case, which is what everyone will see until C-14 is satisfied.

### C-14 🟠 The whole chain is now one flag flip from changing forecasts

`FORECAST_EVENT_PIPELINE.enabled = false`. Turning it `true` activates, in one step: forecast events → behaviour lookup → shifted expected dates → different forecast days → different runway, risk level and strategy scoring.

**Before flipping it, all of these must be true:**

| # | Precondition | Status |
|---|---|---|
| 1 | Migrations applied (`paidAt`, `counterpartyId` exist) | 🔴 A-1 |
| 2 | Counterparty backfill run, so invoices are linked | 🟡 B-4 |
| 3 | Enough settled history for the model to act (5+ payments per customer) | accumulates from B-10 |
| 4 | `SCORING_CONFIG_VERSION` / `LIQUIDITY_CONFIG_VERSION` bumped | 🟡 C-11 |
| 5 | Manual-settlement timestamp skew reviewed | 🟡 C-13 |

Until (1)–(3) hold the flag is *also* inert in practice — `loadPaymentBehavior` returns an empty map — so flipping it early is safe but pointless. Flipping it after (1)–(3) but without (4) is the actual hazard: forecasts would change while existing strategies kept passing the freshness gate.

### C-13 🟡 `paidAt` records observation time, not provider-attested payment time

`settlePayment` stamps `paidAt` with when *we processed* the settlement, because no verified provider timestamp exists to use instead (A-3, §37).

The error this introduces is webhook/operator lag. At day granularity — the only granularity the behaviour model consumes — that is negligible for webhook settlements. It is **not** negligible for `MANUAL` settlements: an operator reconciling a week-old payment stamps it a week late, making that customer look worse than they are.

Two consequences to keep in view:
- Pass a verified provider timestamp into `settlePayment`'s `paidAt` parameter once A-3 is closed.
- Manual-settlement rows may need excluding or down-weighting when the behaviour data is first calibrated (C-12).

### C-12 🟡 The behaviour model's constants are reasoned, not calibrated

Minimum 3 payments for any opinion and 5 to move a forecast; a 90-day recency window; a 0.7 cap on recency weight; a 7-day stability reference; a 3-day accuracy half-life. Each is defended in the code and each is deliberately conservative, but **none is fitted to real data** — there is none yet. They should be revisited once B-10 produces actual payment history, and calibrated in P15.

### C-11 🟡 Turning on the forecast pipeline will eventually need a config bump

`FORECAST_EVENT_PIPELINE.enabled` is off. It is still a no-op **in practice**, because no counterparty has enough history for P9 to shift anything (B-10) — but `applyExpectedTiming` is now capable of moving dates, so this is no longer a no-op *by construction*.

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
| ~~**P9**~~ | ~~Behaviour model~~ | ✅ **Done.** See §14. Completes the C-1 mechanism. Inert until `paidAt` is populated (B-10). |
| ~~**P10**~~ | ~~Scenario forecasting~~ | ✅ **Done.** See §15. Not surfaced by any route (B-12). |
| **P11** ◑ | Freshness ↔ `stateVersion` | Largely delivered by P7. Remaining: strategy `expiresAt`, `forecastVersion` (§32) |
| **P13** ◑ | Surface scenarios, confidence and conflicts in the UI | Forecast half done (§16). Remaining: evidence trails, conflicts, the "why?" drill-down — all of which read tables that are empty until A-1 + `brain:sync` run. |
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
| `npm test` | 90 files, **1298 passed**, 5 skipped |
| `npm run build` | OK — 24 routes + middleware |

The 5 skipped are A-5.
