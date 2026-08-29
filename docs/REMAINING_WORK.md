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

Seven additive migrations are written and verified byte-for-byte against Prisma's own generated DDL, and **none has been applied**:

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

### A-1 🔴 Seven migrations have never been applied

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

### B-1 🟡 Nothing writes `FinancialEvent` (Phase 1)

The append-only spine is idempotent and tested, but no source produces events into it. **Owned by:** the connector phases (P17).

### B-3 🟡 Nothing reads `counterpartyId` except the behaviour model (Phase 4)

`Invoice.customerName` / `Payout.vendor` remain authoritative for display and every engine path. The link is written by `brain:sync` and read only by payment behaviour.

### B-6 ◑ No automatic trigger for state materialisation or reconciliation

`npm run brain:sync` runs both. What does not exist is any **cron, post-write hook or scheduled job** — state advances only when someone runs the script.

Deliberate for a first release, and the reason **B-8** stays open.

### B-7 🟡 Nothing reads `FinancialState` for forecasting (Phase 6)

`buildForecast` still reads canonical rows directly. The freshness gate reads state, but only for decisions recording a version — which is none (B-8).

### B-8 🟡 Nothing writes `Decision.financialStateVersion` (Phase 7)

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

### C-8 🟡 No backoff on provider HTTP 429

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
