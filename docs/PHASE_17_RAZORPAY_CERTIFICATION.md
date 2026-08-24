# Phase 17 — Razorpay Provider Boundary Certification

Status vocabulary used throughout, exactly as specified:
`VERIFIED_LIVE` · `VERIFIED_SDK` · `VERIFIED_MOCK` · `VERIFIED_TEST` · `UNVERIFIED` · `BLOCKED`

---

## 1. Environment Used

| | |
|---|---|
| Razorpay account | **TEST mode**, key prefix `rzp_test_` |
| Live-mode key present? | **No** — asserted before every probe; a `rzp_live_` key aborts the run |
| Database | `localhost:51214` (local Prisma Postgres) — no production DB reachable |
| `NODE_ENV` | unset (development) |
| Real money movement | **None possible** — test mode only |
| Customer notification | **None** — `notify: {email:false, sms:false}`, `reminder_enable:false` |
| Test data prefix | `cp_phase17_<scenario>_<unique>` |
| Secrets | Never printed. Probes report presence/prefix only. |

## 2. SDK Version

`razorpay@2.9.8`.

## 3. API Operations Tested Live

`paymentLink.create`, `paymentLink.all({from,to,count,skip})`, `paymentLink.fetch`.

## 4. Exact Provider Assumptions Under Test

1. `reference_id` accepted on creation
2. `reference_id` returned on the entity
3. `all()` returns records containing `reference_id`
4. Duplicate `reference_id` behaviour
5. Real errors are correctly classifiable
6. The `customer` object CashPilot sends is accepted
7. The created link is retrievable
8. Lifecycle fields match our reconciliation model
9. A real settlement is observable
10. Unpaid is distinguishable from paid
11. Ambiguity never becomes SUCCESS

---

## 5. Live Verification Results

| # | Assumption | Result | Status |
|---|---|---|---|
| 1 | `reference_id` accepted on create | Accepted | **VERIFIED_LIVE** |
| 2 | `reference_id` returned, exact match | `referenceMatches: true` | **VERIFIED_LIVE** |
| 3 | `all()` returns `reference_id` | Present on **every** item (13/13) | **VERIFIED_LIVE** |
| 4 | Duplicate `reference_id` | **`DUPLICATE_REJECTED`** (HTTP 400) | **VERIFIED_LIVE** |
| 5 | Error classification | 400/401/404/429 all classified correctly | **VERIFIED_LIVE** |
| 6 | `customer` payload accepted | Accepted **with empty email and contact** | **VERIFIED_LIVE** |
| 7 | Link retrievable | Retrieved via listing + exact match | **VERIFIED_LIVE** |
| 8 | Lifecycle fields | `status`, `amount_paid`, `created_at` as modelled | **VERIFIED_LIVE** |
| 9 | Real settlement observed | **0 paid links; not performed** | **UNVERIFIED** |
| 10 | Unpaid ≠ paid | Unpaid link → `PENDING` | **VERIFIED_LIVE** |
| 11 | Ambiguity never SUCCESS | Ghost ref → `NOT_FOUND`; no false bind | **VERIFIED_LIVE** |

## 6. Observed Response Shape

Payment-link entity keys returned live:

```
accept_partial, allow_full_payment, amount, amount_paid, cancelled_at,
created_at, currency, customer, description, expire_by, expired_at,
first_min_partial_amount, id, notes, notify, payment_plan, payments,
reference_id, reminder_enable, reminders, short_url, status, updated_at,
upi_link, user_id, whatsapp_link
```

Sample (real): `id: plink_TTFNCrlMdjokHY`, `reference_id: cp_phase17_adapter_mt5wwydi`, `status: "created"`, `amount_paid: 0`.

## 7. Error Classifications — VERIFIED_LIVE

| Trigger | statusCode | `err.message` | `err.error.description` | CashPilot class |
|---|---|---|---|---|
| Negative amount | 400 | **`""`** | `amount: amount should be minimum 1.00 for INR…` | `ProviderRejectedError` |
| Zero amount | 400 | **`""`** | `amount: cannot be blank.` | `ProviderRejectedError` |
| Bad currency | 400 | **`""`** | `currency: wrong input field…` | `ProviderRejectedError` |
| Invalid auth | 401 | **`""`** | `Authentication failed` | `ProviderRejectedError` |
| Nonexistent fetch | 404 | **`""`** | *(absent)* | `ProviderRejectedError` |
| Rate limited | 429 | **`""`** | `Too many requests` | `ProviderIndeterminateError` ✅ |
| Duplicate reference | 400 | **`""`** | `payment link with given reference_id: … already exists` | `ProviderDuplicateError` |

**Two defects found and fixed:**

1. **`err.message` is empty on every real error.** The old classifier built its message from `err.message`, so every provider failure was recorded with a **blank reason**. Fixed by `describeProviderError()`, which reads `err.error.description`/`reason`/`code`. **VERIFIED_LIVE.**
2. **`err.error.code` is `BAD_REQUEST_ERROR` even for a 401**, so `code` is not a usable discriminator. `statusCode` is. Documented in code.

## 8. Timestamp Observations — VERIFIED_LIVE

| Run | Local create ts | Provider `created_at` | Skew |
|---|---|---|---|
| 1 | 1787495662 | 1787495664 | **+2s** |
| 2 | 1787495913 | 1787495915 | **+2s** |

Provider timestamps run **~2 s ahead** of our local clock, consistently. The existing **±60 s** window is ample. **No change made** — the evidence did not require one.

## 9. Pagination Observations — VERIFIED_LIVE

| Property | Observed |
|---|---|
| `count` honoured | Yes (3, 3) |
| Overlap between pages | **None** |
| Duplicates across pages | **None** |
| Paged union ⊆ single large page | Yes |
| `reference_id` on every item | Yes |
| Total in test account | 13 |

Page-cap behaviour (`maxPages` reached → `UNKNOWN`, never `NOT_FOUND`) is **VERIFIED_TEST**, not exercised live — 13 links do not force 20 pages.

## 10. Duplicate-Reference Result — VERIFIED_LIVE

**`DUPLICATE_REJECTED`.** Razorpay enforces `reference_id` uniqueness per account:

> `payment link with given reference_id: cp_phase17_dup_mt5wt6z8 already exists. Please create a payment link with a different reference_id`

This is a **genuine second line of defence** against duplicate payment links, independent of CashPilot's own intent uniqueness.

**Architecture change driven by this finding:** a duplicate rejection means the operation **already exists** — so classifying it as a plain failure would mark a *live payment link* as FAILED and unlock a retry against money that already moved. It now maps to `ProviderDuplicateError` → intent becomes `UNKNOWN` → reconciliation resolves it from evidence.

## 11. Customer Validation Result — VERIFIED_LIVE

The exact payload CashPilot sends — `{name, email: "", contact: ""}` — **is accepted**. My Phase 16 concern that blank contact details would be rejected was **unfounded**. No weakening of validation was needed and none was done.

## 12. Successful Payment Result — **UNVERIFIED**

**Not performed.** Completing a payment requires entering card details into Razorpay's hosted checkout. **I do not enter payment card details into forms — including test cards.** No settled link existed in the account to observe instead (`paidLinksFound: 0`).

The `paid` → `CONFIRMED_SUCCESS` mapping is **VERIFIED_TEST** only (recorded-shape fixture). **It has never been observed against a real settlement.**

**To close this yourself:** open a created link's `short_url`, pay with a Razorpay test card, then run `RAZORPAY_LIVE_TEST=1 npx vitest run src/lib/razorpay/__tests__/providerContract.test.ts` and confirm the reference reconciles to `CONFIRMED_SUCCESS`.

## 13. Unpaid Result — VERIFIED_LIVE

Unpaid link reconciled through the **real adapter**: `status: PENDING`, bound to the correct `plink_…`, `retrySafe: false`, `searchExhaustive: true`. Link creation is correctly **not** treated as settlement.

## 14. Reconciliation Results — VERIFIED_LIVE

| Scenario | Result |
|---|---|
| Existing unpaid reference | `PENDING`, correct link bound |
| Nonexistent reference, exhaustive scan | `NOT_FOUND`, `retrySafe: true` |
| Wrong-reference protection | Ghost lookup returned **nothing** while `items[0]` was non-null |

The Phase 15 `?? items[0]` bug is **proven** to have been dangerous: a real unrelated link sat at `items[0]` during the ghost lookup. Repository audit confirms no `items[0]` selection remains in live code (only comments documenting the bug).

## 15. Webhook Results — **UNVERIFIED**

Webhook delivery requires a publicly reachable URL; the dev server is local-only. Signature verification, idempotency, claim-then-release, and ordering remain **VERIFIED_TEST**. `RAZORPAY_WEBHOOK_SECRET` is **not set** in this environment.

## 16. Security Results

| Control | Status |
|---|---|
| Live-mode key refused in test runs | **VERIFIED_TEST** (asserted in every probe and the contract suite) |
| Test-mode key in production → FATAL | **VERIFIED_TEST** |
| Production on localhost DB → FATAL | **VERIFIED_TEST** |
| Malformed key / short session secret → rejected | **VERIFIED_TEST** |
| Empty/whitespace value counts as absent | **VERIFIED_TEST** |
| No secret in summaries, defects, or logs | **VERIFIED_TEST** |
| Unsigned webhook impossible in production | **VERIFIED_TEST** |
| Tenant isolation | **VERIFIED_TEST** |

## 17. Remaining Unknowns

1. **Real settlement never observed** (§12) — the `paid` mapping is untested against reality.
2. **Webhook never delivered by Razorpay** (§15).
3. **Page-cap → UNKNOWN never exercised live** (§9).
4. **`expired` / `cancelled` transitions never observed live** — mapping is recorded-shape only.
5. **Partial payment (`partially_paid`)** is not handled distinctly; it currently falls to `PENDING`. Conservative, but unverified and unmodelled.
6. Rate limiting is real (a probe hit HTTP 429). A busy reconciliation scan could be throttled; that yields `UNKNOWN` (safe) but no backoff exists.

## 18. Go / No-Go Recommendation

**NO-GO for production.**

The provider boundary is now *substantially* certified — 9 of the 11 required assumptions are `VERIFIED_LIVE`, and live testing found and fixed two real defects. But the §23 Go rule requires **"at least one complete real Razorpay TEST-account payment-link lifecycle succeeds"** including settlement, and that has **not** happened.

**Blockers:**

| # | Blocker | Why it blocks |
|---|---|---|
| B1 | No real settlement observed | The `paid` → `CONFIRMED_SUCCESS` path — the one that tells a CFO money arrived — has never run against reality |
| B2 | No real webhook delivered | Settlement in production arrives by webhook; that path is untested end-to-end |
| B3 | `RAZORPAY_WEBHOOK_SECRET` unset | Correctly fails closed in production, but is not configured anywhere |

B1 needs a human to complete one test payment. B2 needs a tunnel or deployed environment. Neither is an architecture problem — both are verification gaps that I could not close myself.
