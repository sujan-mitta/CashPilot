# CashPilot State Machines

_Phase 14–15 — authoritative reference. If code and this document disagree, the code in
`src/lib/engine/decisionStateMachine.ts` and `src/lib/engine/stateTransitions.ts` wins._

CashPilot runs **four** state machines. They are deliberately separate and each owns
exactly one concept. Nothing may write a status outside the guarded helpers.

| Machine | Model | Question it answers | Guard |
|---|---|---|---|
| Decision | `Decision.status` | What did the business decide, and did that decision reach a settled financial conclusion? | `validateDecisionTransition` / `transitionDecision` |
| Action | `AgentAction.status` | What physically happened when we tried to move this money? | `validateActionTransition` |
| Recovery | `PaymentRecovery.status` | Where is this specific payment in its collection lifecycle? | `validateRecoveryTransition` |
| Payout | `Payout.status` | Is this obligation scheduled, moved, paused or paid? | Set only inside `RESCHEDULE_PAYOUT` execution |

---

## 1. Decision — the human financial decision

One row per strategy. Append-forward only.

```
                    ┌──────────────┐
                    │  GENERATED   │  strategy simulated, not yet shown
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  PRESENTED   │  shown to the operator
                    └──────┬───────┘
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼─────┐ ┌────▼─────┐ ┌────▼─────────┐
        │ APPROVED  │ │ REJECTED │ │ NOT_EXECUTED │
        └─────┬─────┘ └────┬─────┘ └────┬─────────┘
              │            │            │
        ┌─────▼─────┐      │            │
        │ EXECUTED  │      │            │
        └─────┬─────┘      │            │
   ┌──────────┼───────────────┐         │
   │          │               │         │
┌──▼───────┐ ┌▼──────────────┐ ┌────────▼──────────────┐
│RECONCILED│ │NOT_RECONCILED │ │RECONCILIATION_MISMATCH│
└──┬───────┘ └┬──────────────┘ └────────┬──────────────┘
   │          │                         │
   └──────────┴────────┬────────────────┘
                       │
             ┌─────────▼─────────┐
             │ OUTCOME_MEASURED  │  TERMINAL — history is closed
             └───────────────────┘
```

### Transition table

| State | Valid next | Invalid next (rejected) | Enforced in |
|---|---|---|---|
| `GENERATED` | `PRESENTED`, `APPROVED`, `REJECTED`, `NOT_EXECUTED` | `EXECUTED`, `RECONCILED`, `OUTCOME_MEASURED` | `decisionStateMachine.ts` |
| `PRESENTED` | `APPROVED`, `REJECTED`, `NOT_EXECUTED` | `EXECUTED`, `RECONCILED`, `OUTCOME_MEASURED` | `decisionStateMachine.ts` |
| `APPROVED` | `EXECUTED`, `NOT_EXECUTED` | `RECONCILED`, `REJECTED`, `OUTCOME_MEASURED` | `api/execute` via `transitionDecision` |
| `REJECTED` | `OUTCOME_MEASURED` | `EXECUTED`, `APPROVED`, `RECONCILED` | `api/approve`, `api/execute` |
| `EXECUTED` | `RECONCILED`, `NOT_RECONCILED`, `RECONCILIATION_MISMATCH`, `OUTCOME_MEASURED` | `APPROVED`, `NOT_EXECUTED`, `REJECTED` | `settlement.ts`, `api/payment-status` |
| `NOT_EXECUTED` | `OUTCOME_MEASURED` | `RECONCILED`, `EXECUTED` | `outcomeMeasurer.ts` |
| `NOT_RECONCILED` | `RECONCILED`, `RECONCILIATION_MISMATCH`, `OUTCOME_MEASURED` | `EXECUTED`, `APPROVED` | `settlement.ts` |
| `RECONCILED` | `OUTCOME_MEASURED` | `EXECUTED`, `NOT_RECONCILED` | `outcomeMeasurer.ts` |
| `RECONCILIATION_MISMATCH` | `RECONCILED`, `OUTCOME_MEASURED` | `EXECUTED`, `APPROVED` | `settlement.ts` |
| `OUTCOME_MEASURED` | *(none — terminal)* | everything | `decisionStateMachine.ts` |

A **self-transition is allowed** and is a no-op. That is how a duplicate request lands
safely. It does **not** overwrite `approvalSnapshot` or `executionSnapshot`.

---

## 2. Why there is no `EXECUTING` DecisionStatus

This was flagged as a possible Phase 13 inconsistency. It is **intentional**, and the
separation is now documented and enforced rather than merely implied.

Execution is not a property of a decision. It is a property of each individual action.
A decision authorising four actions can be, at the same instant:

- action 1 `COMPLETED` (money settled),
- action 2 `EXECUTING` (payment link issued, awaiting the customer),
- action 3 `EXECUTION_UNKNOWN` (the request timed out — we do not know),
- action 4 `FAILED` (no matching payout existed).

There is no single honest `EXECUTING` value for the parent row. So:

> **`AgentAction.status` is the authoritative execution state.
> `Decision.status` records only whether execution reached a confirmed conclusion.**

Consequences, enforced in `src/app/api/execute/route.ts`:

- Every action confirmed → `Decision` → `EXECUTED`.
- Any action `FAILED`, none unknown → `Decision` → `NOT_EXECUTED`.
- **Any action `EXECUTION_UNKNOWN` → `Decision` stays `APPROVED`.** The attempt is
  recorded in `executionSnapshot.outcome = "EXECUTION_UNKNOWN"` with
  `requiresManualVerification: true`. Unknown is never promoted to success and never
  demoted to failure (PRINCIPLE 10).

---

## 3. Action — the mechanical action

```
PENDING ──► APPROVED ──► EXECUTION_REQUESTED ──► EXECUTING ──► EXECUTED ──► RECONCILING ──► COMPLETED
   │            │                 │                  │                          │
   │            │                 └──► EXECUTION_UNKNOWN ◄────────────┘         ├──► RECONCILIATION_FAILED
   │            │                            │                                  └──► RECONCILIATION_MISMATCH
   ├──► REJECTED (terminal)                  ├──► COMPLETED                               │
   └──► STALE    (terminal)                  ├──► RECONCILING                             └──► RECONCILING (retry)
                                             └──► FAILED ──► EXECUTING (retry)
```

Key rules:

- `COMPLETED`, `REJECTED`, `STALE` are terminal; they cannot walk backwards.
- `EXECUTION_UNKNOWN` is **not** terminal and **not** a failure. It resolves to
  `COMPLETED`, `RECONCILING` or `FAILED` once the truth is known. It may **not**
  go back to `EXECUTING` (Phase 15): the operation may already have landed, so
  re-dispatching risks a duplicate payment. Only from `FAILED` — which means
  reconciliation confirmed nothing happened — may a retry re-enter `EXECUTING`.
- Issuing a payment link sets `EXECUTING`, **never** `COMPLETED`. Only observed
  settlement (webhook or authoritative status fetch) may reach `COMPLETED`.
- An action whose target record does not exist is `FAILED`, not `COMPLETED` — a no-op
  is not a success.

---

## 4. Recovery — one payment's collection lifecycle

```
RECOVERY_CANDIDATE ──► RECOVERY_INITIATED ──► PAYMENT_LINK_CREATED ──► PAYMENT_PENDING ──► RECOVERED (terminal)
                                                                              ├──► EXPIRED ──┐
                                                                              └──► FAILED ───┴──► RECOVERY_INITIATED (retry)
```

`RECOVERED` is terminal and irreversible: a settled payment cannot be un-settled by a
late, duplicated or out-of-order webhook.

---

## 5. How the machines interact

| Trigger | Action effect | Decision effect |
|---|---|---|
| Operator approves | `PENDING → APPROVED` | `→ APPROVED` (snapshot written once) |
| Operator rejects | `PENDING → REJECTED` | `→ REJECTED` |
| Execute, link issued | `APPROVED → EXECUTING` | unchanged until all actions resolve |
| Execute, target missing | `APPROVED → FAILED` | `→ NOT_EXECUTED` |
| Execute, timeout | `APPROVED → EXECUTION_UNKNOWN` | **stays `APPROVED`** |
| Execute, all confirmed | `→ COMPLETED` | `→ EXECUTED` |
| Webhook: payment paid | `EXECUTING → RECONCILING → COMPLETED` | `→ RECONCILED` |
| Webhook: wrong amount | `→ RECONCILIATION_MISMATCH` | `→ RECONCILIATION_MISMATCH` |
| Window closes | unchanged | `→ OUTCOME_MEASURED` |

Reconciliation status is derived from action states in exactly one place —
`reconcileDecisionForStrategy()` in `src/lib/razorpay/settlement.ts` — and is skipped
entirely while any action is still in flight. Declaring `NOT_RECONCILED` for work that
has not finished would be a verdict we have not earned.

---

## 6. Immutability contract

`transitionDecision()` refuses outright to write:

- `baselineSnapshot` — the DO_NOTHING counterfactual as it stood at decision time
- `recommendedSnapshot` — the prediction
- `engineVersion` — the engine that produced it
- `createdAt`

and will not overwrite an existing `approvalSnapshot` / `executionSnapshot`.

Historical decisions are therefore never recomputed, never re-versioned, and never
re-attributed to a second approver. Measured reality lives in `actualOutcome` and
nowhere else.

---

# Phase 15 additions

## 7. ExecutionIntent — durable intent for external operations

A database transaction cannot make a Razorpay call atomic. It can only record,
durably, that one is about to happen. Everything below follows from that.

```
RECORD ──► CLAIM ──► EXTERNAL CALL ──► RESOLVE
(RECORDED) (DISPATCHING)              (SUCCEEDED | FAILED | UNKNOWN)
```

| crash point | intent left as | safe next step |
|---|---|---|
| after RECORD, before CLAIM | `RECORDED` | dispatch — nothing external happened |
| after CLAIM, before the call | `DISPATCHING` | sweep to `UNKNOWN` |
| after the call, before RESOLVE | `DISPATCHING` | sweep to `UNKNOWN` |
| after RESOLVE | terminal | nothing |

`DISPATCHING` is deliberately indistinguishable from "the call may have landed".
We cannot tell those apart from our side, so both sweep to `UNKNOWN`.

**An `UNKNOWN` intent is never re-dispatched.** It is resolved by asking the
provider whether an operation exists under our stable idempotency key:

- found → `SUCCEEDED`
- definitively absent → `FAILED` (a fresh attempt is now safe)
- provider unreachable → stays `UNKNOWN`

### Idempotency identity

`cp_{actionId}` or `cp_{actionId}_{targetId}` for fan-out (one link per invoice).
No timestamp, no randomness — a retry of the same logical operation produces the
same key. It is sent to Razorpay as `reference_id`, which the provider enforces
as unique, and is also the lookup key during reconciliation.

## 8. Decision → EXECUTED aggregation rule

For a multi-action strategy:

| child actions | Decision |
|---|---|
| all confirmed | `EXECUTED` |
| any `FAILED`, none unknown | `NOT_EXECUTED` |
| **any `EXECUTION_UNKNOWN`** | **stays `APPROVED`** |

Partial execution is never called `EXECUTED`. The attempt is recorded in
`executionSnapshot.outcome` with `requiresManualVerification`.

`ActionStatus.EXECUTION_UNKNOWN → EXECUTING` was **removed** from the allowed
transitions. Recovery goes `UNKNOWN → COMPLETED` (it happened) or
`UNKNOWN → FAILED` (it did not); only from `FAILED` may a retry re-enter
`EXECUTING`.

## 9. Strategy freshness

A fingerprint over the financial **facts** a recommendation rests on: cash,
obligations (absolute dates), the specific records each action targets, ledger
movements, the required buffer, and configuration identity.

Deliberately excluded: rolling-window aggregates. They are anchored on "now" and
drift daily, which would make "the clock advanced" indistinguishable from "the
money moved".

| classification | meaning | blocks execution |
|---|---|---|
| `NO_CHANGE` | identical fingerprint | no |
| `MINOR_CHANGE` | every change below threshold | no |
| `MATERIAL_CHANGE` | config changed, target vanished/settled, critical obligation added/removed, amount or date beyond tolerance, cash or buffer drift | **yes** |
| `UNKNOWN` | no stored fingerprint, incomplete inputs, or an unattributable difference | **yes** |

Enforced server-side at **both** approval and execution. Skipped once execution
has begun — executing changes the very records the fingerprint covers, so
re-gating a resumed run would flag the strategy's own effects as staleness.

Rejecting a stale strategy is always permitted.

## 10. Outcome measurement lifecycle

`Decision.outcomePhase` is separate from `Decision.status`: "what did we decide"
and "how far has measurement got" are different facts.

```
NOT_STARTED → WINDOW_OPEN → POST_HORIZON_PENDING → FINAL_MEASURED
                                                 ↘ UNRESOLVED_AFTER_WINDOW
```

The **forecast** horizon stays 14 days. The **outcome** horizon is per-decision
and stretches to cover any deferred obligation. `Decision.status` only reaches
the terminal `OUTCOME_MEASURED` when the phase reaches `FINAL_MEASURED` or
`UNRESOLVED_AFTER_WINDOW`, so history is written exactly once.

### Obligation verdicts

Each snapshotted obligation is judged against its live record:
`PROTECTED`, `PAID_ON_TIME`, `PAID_LATE`, `RESCHEDULED`, `UNPAID`, `FAILED`,
`BEYOND_WINDOW`, `UNVERIFIABLE`.

`actualCriticalObligationsProtected` is **derived** from these verdicts.
Unresolved obligations are counted separately and folded into neither the
protected nor the breached bucket — an absence of evidence is not a claim.

## 11. Classification precedence

Highest first; each rung is mutually exclusive with those below it:

1. decision-level terminal facts (`REJECTED`, `NOT_EXECUTED`, mismatch)
2. no reliable actual data → `PARTIALLY_MEASURED`
3. critical obligation breached → `FAILED`
4. worse than baseline → `FAILED`
5. unresolved external execution → `PARTIALLY_MEASURED`
6. broken deferral → `PARTIAL_SUCCESS`
7. unmeasured deferred liability → `PARTIALLY_MEASURED`
8. solvent and deficit-free → `SUCCESS`
9. improved but not whole → `PARTIAL_SUCCESS`
10. otherwise → `FAILED`

## 12. DecisionEvent — append-only audit

Written on the **same client** as the status change it describes, so inside a
transaction both commit or both roll back. State and audit history cannot
disagree. No update or delete path exists.


---

# Operational notes (Phase 20, learned from live verification)

## After any Prisma migration, restart the dev server

The Next.js dev server holds the generated Prisma client in memory. Adding a
column and running `prisma generate` is not enough - a long-running dev server
keeps the stale client and fails with *"The column X does not exist"* or
*"Unknown argument X"*, which reads like a migration failure but is not one.

```bash
npx prisma migrate deploy   # or db execute + migrate resolve
npx prisma generate
# then RESTART the dev server
```

## Settlement discrepancies are recorded, not silent

Two situations previously returned silently. Both now append an immutable
`DecisionEvent` (type `RECONCILIATION_MISMATCH`) without mutating any money:

1. **Target already settled** - a second settlement attempt against an invoice
   or recovery that is already PAID/RECOVERED. The compare-and-set still
   prevents the double credit; the event records that it was caught.
2. **Reconciliation transition refused** - settlement completed against the
   ledger, but the decision could not legally advance from its current status
   (e.g. `NOT_EXECUTED -> RECONCILIATION_MISMATCH`). The state machine is right
   to refuse; the event records the divergence so it is visible.

In both cases the ledger is authoritative and the event is an OBSERVATION:
`fromStatus === toStatus`. Neither path can throw into settlement.

## Cloudflare quick tunnels do not log individual requests

At default log level, `cloudflared tunnel --url` logs startup and connection
events only. An absence of request lines is NOT evidence that no request
arrived. Diagnose webhook delivery from the application's own logs
(`Webhook signature validation failed` carries a `failureClassification`),
never from the tunnel log.
