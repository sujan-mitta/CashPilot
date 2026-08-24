# Phase 18 — Production Closure

Status vocabulary: `VERIFIED_LIVE` · `VERIFIED_SDK` · `VERIFIED_MOCK` · `VERIFIED_TEST` · `UNVERIFIED` · `BLOCKED`

---

## 1. Environment

| | |
|---|---|
| Razorpay account | **TEST mode** (`rzp_test_` prefix), asserted before every call |
| Live-mode key present | **No** — a `rzp_live_` key aborts every probe and the live test tier |
| Database (app) | Local Prisma Postgres, port 51214 |
| Database (certification) | **Separate instance**, port 51218, own storage |
| `NODE_ENV` | unset (development) |
| Real money movement | **None possible** — test mode |
| Customer notification | **None** — `notify:{email:false,sms:false}`, `reminder_enable:false` |
| Test data prefix | `cp_phase18_*` |

## 2. Razorpay Account Mode

**TEST.** No production credentials were used at any point.

## 3. SDK Version

`razorpay@2.9.8`.

## 4–7. Identifiers From the Live Run

| Field | Value |
|---|---|
| Payment link ID | `plink_TTFlHLv3mAZ8wJ` (certification run) |
| Reference ID | `cp_cmt5xq9ds0002wguk4be5gdmd` |
| Additional links | `plink_TTFn2RqnKYG2ve` (lag probe), `plink_TTFogGnZsB7I3v` (fix proof) |
| Payment ID | **None — no payment was completed** |
| Webhook event ID | **None — no webhook was delivered** |

## 8. Actual Provider Lifecycle Observed

```
intent RECORDED
   ↓
intent DISPATCHING
   ↓
provider link created           status="created", amount_paid=0    VERIFIED_LIVE
   ↓
[provider LIST lag ~2–6s]                                          VERIFIED_LIVE
   ↓
reconciliation → PENDING        bound to the correct plink_        VERIFIED_LIVE
   ↓
payment completed               ── NOT PERFORMED ──                UNVERIFIED
   ↓
reconciliation → CONFIRMED_SUCCESS                                 UNVERIFIED
```

## 9. Settlement Evidence

**BLOCKED.** No payment was completed, so no settlement evidence exists.

The evidence field CashPilot uses for `CONFIRMED_SUCCESS` is the payment-link **`status == "paid"`**. That mapping is `VERIFIED_TEST` against a recorded entity shape. It has **never been observed against a real settlement**, and `amount_paid` is not currently used as corroborating evidence.

Nothing in the codebase treats HTTP 200, link creation, absence of an exception, or presence of a link ID as success — asserted by test.

## 10. Reconciliation Evidence — VERIFIED_LIVE

| Case | Result |
|---|---|
| Existing unpaid link, after settling | `PENDING`, correct `plink_` bound, `retrySafe:false` |
| Just-created link (1s old) | `UNKNOWN`, `retrySafe:false` — **after the Phase 18 fix** |
| Ghost reference, aged past settling | `NOT_FOUND`, `retrySafe:true` |
| Wrong-reference protection | Ghost lookup bound nothing while `items[0]` was non-null |

## 11. Webhook Evidence

**BLOCKED for live delivery.** No public HTTPS endpoint exists; no tunnel tooling (`ngrok`, `cloudflared`, `localtunnel`) is installed, and exposing the local server was not done unilaterally.

Signature verification, idempotency and fail-closed behaviour are **VERIFIED_TEST** (12 tests driving the real route handler with real HMAC signatures).

## 12. Duplicate Webhook Evidence — VERIFIED_TEST

Two and three deliveries of the same signed event settle **exactly once**; the second returns `ALREADY_PROCESSED`. Distinct event ids process independently. A rejected webhook does **not** consume the event id (claim-then-release).

## 13. Error Evidence — VERIFIED_LIVE (Phase 17, re-asserted by regression tests)

`err.message` is empty on every real error; reasons come from `err.error.description`. `statusCode` is the discriminator (`error.code` is `BAD_REQUEST_ERROR` even for 401). 429 → indeterminate. Duplicate reference → `ProviderDuplicateError`.

**Newly observed in Phase 18:** sustained live testing triggers **HTTP 429** rate limiting. The classifier correctly returned `ProviderIndeterminateError` (safe), but there is no backoff.

## 14. Fresh DB Migration Evidence — VERIFIED_LIVE

**A previously reported PASS was wrong and is corrected here.**

The Prisma dev proxy **ignores the database name in the connection string** and routes everything to one shared store. `CREATE DATABASE cp_p18_fresh` succeeded, `migrate deploy` reported `Datasource "db": cp_p18_fresh`, and `current_database()` returned **`template1`**. The "fresh database" was the existing one. **Phase 16's clean-migration PASS was almost certainly invalid for the same reason.**

Corrected method — a genuinely separate server instance (`prisma dev --name p18fresh`, port 51218, own storage):

| Check | Result |
|---|---|
| Pre-migration tables | **0 (empty)** |
| `migrate deploy` | "The following migration(s) have been applied" — all 3 listed |
| `applied_steps_count` | **1 each** (vs `0` in the false run) |
| Rollbacks | None |
| Manual intervention | None; **no `migrate resolve`** |
| Tables / enums / indexes / FKs / columns | 15 / 15 / 39 / 13 / 138 |
| App boot on empty DB | OK — all counts 0, relations resolve |

## 15. Schema Drift — VERIFIED_LIVE

`migrate diff` in **both directions** against the genuinely fresh database: *"This is an empty migration."* **Zero drift.**

## 16. Security Evidence

| Control | Status |
|---|---|
| Correct signature accepted | VERIFIED_TEST |
| Invalid signature rejected, nothing settles | VERIFIED_TEST |
| Missing signature rejected | VERIFIED_TEST |
| Tampered body invalidates signature | VERIFIED_TEST |
| Production without secret refuses webhook | VERIFIED_TEST |
| Production with placeholder → fatal | VERIFIED_TEST |
| Test-mode key in production → fatal | VERIFIED_TEST |
| Production on localhost DB → fatal | VERIFIED_TEST |
| No secret in summaries/defects/logs | VERIFIED_TEST |
| Live-mode key refused in test runs | VERIFIED_TEST |
| `?businessId=` ignored; session authoritative | VERIFIED_TEST |

## 17. Audit-Trail Evidence — VERIFIED_TEST

Append-only `DecisionEvent`; no update/delete path; ordered `(createdAt, id)`; tenant-scoped; transition and event atomic (a failing event insert rolls the status change back). A full **live** payment lifecycle has not been traced through it because no payment occurred.

## 18. Remaining Unknowns

1. Real settlement never observed.
2. Real webhook never delivered by Razorpay.
3. `expired` / `cancelled` / `partially_paid` never observed live.
4. Page-cap → `UNKNOWN` never exercised live.
5. No backoff for provider 429.
6. Exact upper bound of the provider list lag — 6s observed once; 60s chosen as a margin, not a measured maximum.

## 19. Remaining Limitations

- `partially_paid` falls to `PENDING` — conservative but unmodelled.
- The 60s settling period delays legitimate `NOT_FOUND` conclusions by up to a minute. Deliberate: a slow correct answer beats a fast wrong one.
- Live tests are rate-limitable and should be run sparingly.
- `scripts/phase18Certify.ts` seeds test rows; point `CP_CERT_DB` at a disposable database.

## 20. Final GO / NO-GO

**NO-GO.**

B4 is now genuinely closed (and a previously false PASS corrected). B3 is configured and fails closed. But **B1 and B2 remain BLOCKED**, and the §2 gate requires both. Phase 18 also found and fixed a **critical false-`NOT_FOUND`** defect that would have authorised duplicate payment links.
