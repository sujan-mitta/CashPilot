# CashPilot 🧭

> **A cash intervention controller.** It forecasts liquidity from your real ledger, finds the timing gap that causes a shortfall, and executes the recovery through Razorpay — with a human approving every rupee that moves.

Most businesses that die of cash flow are profitable on paper. They fail because the money arrives eleven days after payroll. Every finance tool will draw you a chart of that. CashPilot does something about it.

Built for the Razorpay Buildathon. **Razorpay is used strictly in TEST mode**; a `rzp_live_` key is refused before any network call.

---

## What it actually does

**1. Forecasts from behaviour, not promises.** Given enough settled history, CashPilot learns how late each customer really pays and moves their expected inflow accordingly. The difference is the whole product:

| | inflow lands | projected low | verdict |
|---|---|---|---|
| due dates as entered | 8 Sept | **+₹1,20,000** | safe, nothing to do |
| learned behaviour | 20 Sept | **−₹1,80,000** | deficit opens on day 7 |

Same ledger, same customer — six invoices, every one paid, every one ~12 days late. The deficit was always going to happen; only the promise said otherwise.

It refuses to guess. An inflow moves only when that counterparty has **at least five settled invoices** and their behaviour is **statistically stable**. No history, no adjustment — you get exactly the dates you entered, and the two pipelines are asserted output-identical in that case.

**2. Computes a safety floor from your own obligations.** Not a constant. `calculateLiquiditySafetyRequirement` derives a per-business buffer from real outflow history, with a temporal per-day variant for obligations that cluster.

**3. Plans, simulates, and ranks.** It builds every intervention available on your actual ledger — recover a failed payment, accelerate collections, reschedule a payout, pause a subscription — simulates each against the forecast, and recommends **the plan that gets you back above your safety floor**, not the one that scores highest. A gentler plan that leaves you short is not a recommendation; it's a nicer way to fail.

**4. Executes through Razorpay, behind a human gate.** Approved plans issue real test-mode payment links on **the merchant's own connected account**. Nothing moves without an explicit human approval recorded in the audit trail.

**5. Reconciles and learns.** Webhook or poll settles the payment, credits the ledger, writes an immutable `FinancialEvent`, emails a health report, and folds the new payment history back into the behaviour model.

---

## Architecture

```mermaid
graph TD
    L[Ledger: Postgres] --> M[Movement builder]
    M --> BM[Behaviour model<br/>observed payment delay]
    BM --> F[Forecast + runway]
    L --> SF[Safety floor<br/>from real obligations]
    F --> RC[Root cause]
    F --> P[Planner<br/>candidate selection]
    SF --> P
    P --> SIM[Simulator + scorer]
    SIM --> AI[AI narration<br/>Groq — explains, never calculates]
    SIM --> H[Human approval gate]
    H --> EI[Durable execution intent<br/>RECORD → CLAIM → DISPATCH → RESOLVE]
    EI --> RZ[Razorpay<br/>per-merchant credentials]
    RZ --> WH[Webhook / poll<br/>HMAC verified]
    WH --> S[Settlement]
    S --> L
    S --> BRAIN[Brain sync<br/>entities, claims, state]
    BRAIN --> BM
```

**The Golden Rule:** the AI narrates, it never calculates. Every number on screen comes from a deterministic engine that is unit-tested. The LLM only explains what the engine decided.

### Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16.3.2 (App Router), React 19.2 |
| Database | PostgreSQL via Prisma ORM 7.9 (driver adapters) |
| Styling | Tailwind CSS v4, Recharts, Lucide |
| Payments | Razorpay Node SDK 2.9 — **test mode only** |
| AI | Groq SDK (narration only) |
| Mail | Nodemailer (SMTP) with a Resend fallback |
| Tests | Vitest — **1,816 tests**, key paths mutation-tested |

---

## Safety properties

These are the parts that must not be wrong, and each is enforced in code and pinned by tests.

**Money cannot move twice.** Every action becomes a durable `ExecutionIntent` — recorded, claimed, dispatched, resolved. The idempotency key is scoped to the **obligation** (the debt), not the attempt, so a regenerated strategy, a double click, or a network timeout cannot bill the same customer again. Razorpay's own duplicate-reference rejection is treated as *positive evidence* that the first attempt succeeded.

**Unknown never becomes success.** If the provider outcome cannot be established, the state is `EXECUTION_UNKNOWN` and it never silently promotes to `EXECUTED`.

**Each merchant uses their own Razorpay account.** Credentials are encrypted with **AES-256-GCM**; the key lives in the environment, never the database, and the system **fails closed** without it. Keys are verified against Razorpay before being stored, and live-mode keys are refused outright.

**Webhooks are verified per tenant.** Each business gets its own webhook URL (`/api/webhooks/<token>`) and its own secret. A payload signed for one merchant will not verify for another — HMAC-SHA256 compared with `timingSafeEqual`. An unknown token returns 404 and never falls back to a shared secret.

**Every decision is auditable.** `Decision` carries baseline, recommended, approval, execution and reconciliation snapshots plus the config versions it was built under. `DecisionEvent` and `FinancialEvent` are append-only.

**Stale plans are refused, not executed.** A freshness gate fingerprints the ledger and configuration behind a decision. If the world moved materially, execution is blocked with a `STRATEGY_STALE` explanation rather than acting on a stale picture.

**Planner and executor share one definition of eligibility.** `actionEligibility.ts` and `actionLibrary.ts` are the single source for what can be acted on and what it is worth — after four separate bugs where the planner proposed something the executor would refuse.

**Deleting an account deletes everything.** `scripts/deleteAccount.ts` clears ~21 child tables dependents-first, then re-queries every table to prove nothing dangles. A schema-driven test fails if a new model with a `businessId` is added and not covered.

---

## Feature map

| Area | What exists |
|---|---|
| **Auth** | Email + password, OTP email verification, Google OAuth, session cookies, route middleware |
| **Onboarding** | Fork between seeded sample data and connecting a real Razorpay account |
| **Forecast** | 14-day horizon, runway, risk level, scenario band, confidence, per-day expansion |
| **Diagnosis** | Root-cause analysis over transactions, invoices and payouts |
| **Planning** | Four strategy templates, simulated and scored; zero-value and duplicate plans dropped |
| **Approval** | Explicit human gate with a recorded snapshot |
| **Execution** | Durable intents, real Razorpay links, sandbox checkout for local development |
| **Reconciliation** | Webhook and poll paths, partial payments, discrepancy records |
| **Entities** | Counterparty resolution and aliasing, merge with conflict review |
| **Notifications** | Settlement emails with a health report, alert dispatch with cooldowns and suppression |
| **Observability** | Webhook delivery attempts, correlation ids, structured logs |

### Pages

`/dashboard` · `/investigation` · `/strategies` · `/approval` · `/execution` · `/history` · `/conflicts` · `/counterparties` · `/profile` · `/onboarding` · `/login`

---

## Getting started

**Requirements:** Node 20+, a PostgreSQL database (Neon, Prisma Postgres, or local).

```bash
npm install
```

Create `.env` in the project root:

```env
# Database
DATABASE_URL="postgresql://USER:PASSWORD@HOST/DB?sslmode=require"
DIRECT_URL="postgresql://USER:PASSWORD@HOST/DB?sslmode=require"

# Session signing (any long random string)
SESSION_SECRET="..."

# Encrypts per-merchant Razorpay credentials. 32+ chars.
# Without it, connecting an account fails closed by design.
CREDENTIAL_ENCRYPTION_KEY="..."

# Razorpay — TEST MODE ONLY. A rzp_live_ key is refused.
RAZORPAY_KEY_ID="rzp_test_..."
RAZORPAY_KEY_SECRET="..."
RAZORPAY_WEBHOOK_SECRET="..."

# AI narration (optional — the app works without it)
GROQ_API_KEY="..."

# Email: OTP verification and settlement reports (optional)
SMTP_HOST="smtp.gmail.com"
SMTP_PORT="465"
SMTP_SECURE="true"
SMTP_USER="you@example.com"
SMTP_PASSWORD="app-password"
EMAIL_FROM="CashPilot <you@example.com>"

# Google OAuth (optional)
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
GOOGLE_REDIRECT_URI="http://localhost:3000/api/auth/google/callback"

# Scheduled alert dispatch (optional)
CRON_SECRET="..."

NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

Then:

```bash
npx prisma migrate deploy
npm run dev
```

Open <http://localhost:3000>, sign up, verify your email, and choose **sample data** on the onboarding screen.

### Seeing the behavioural forecast

The sample ledger has no settled history, so the behaviour model correctly forms no opinion. To give it one:

```bash
npx tsx scripts/seedPaymentHistory.ts --business "Your Business Name"
```

That creates a customer with six invoices all paid ~12 days late, plus one upcoming invoice. Regenerate your plan and the forecast will expect that money 12 days after its due date. `--undo` removes it.

### Payments locally

**You do not need a webhook.** Razorpay cannot deliver to `localhost`, so the sandbox checkout settles through `/api/payment-status`, which calls the same `settlePayment` function the webhook does. It is gated on `NODE_ENV !== "production"` and inert in a deployed environment.

For real webhooks, either use a deployed instance or expose localhost with a tunnel and register `<public-url>/api/webhooks/<your-token>` in the Razorpay dashboard.

---

## Development

```bash
npm run typecheck    # prisma generate && tsc --noEmit
npm run lint
npm test             # 1,816 tests
npm run build
npm run brain:sync   # entity resolution + state snapshot for a tenant
```

Vitest is capped at 4 workers deliberately — the default spawns one per core and starves the heaviest suites past their timeout, producing red runs that have nothing to do with the code. See the comment in `vitest.config.ts`.

### Useful scripts

| Script | Purpose |
|---|---|
| `scripts/deleteAccount.ts` | Delete an account and everything under it, then verify nothing dangles |
| `scripts/seedPaymentHistory.ts` | Give a business learnable payment history |
| `scripts/syncBrain.ts` | Run entity resolution and state materialisation manually |
| `scripts/export-database.ts` / `import-database.ts` | Move data between environments |

All destructive scripts are **dry-run by default** and require `--confirm`.

---

## Layout

```
prisma/schema.prisma          Data model: ledger, decisions, intents, entities, audit
src/lib/engine/               Deterministic core — forecast, risk, scoring, eligibility
src/lib/forecast/             Movement building and the behavioural timing pipeline
src/lib/execution/            Durable intents and per-action executors
src/lib/razorpay/             Provider client, settlement, per-merchant connections
src/lib/brain/                Entity resolution, claims, state snapshots
src/lib/crypto/secretBox.ts   AES-256-GCM credential encryption
src/lib/notifications/        Email, health assessment, alert dispatch
src/app/api/                  33 route handlers
docs/STATE_MACHINE.md         The four state machines and their guards
```

---

## Known limitations

Stated plainly, because the alternative is a demo that surprises you.

- **Candidate selection is demo-shaped.** The reschedule action picks a payout by vendor name and the pause action matches expense descriptions on keywords. A real ledger with several reschedulable payouts will only ever be offered one of them.
- **Invoices do not reach the forecast.** The projection is built from transactions only, so outstanding receivables are invisible to the runway even though collections act on them.
- **A plan mixes certain and uncertain outcomes.** Rescheduling a payout is guaranteed on execution; a customer paying is not. Both are currently added into one headline figure.
- **Entity resolution is name-only** and runs on ledger change, not continuously.
- **`paidAt` records observation time**, not a provider-attested payment timestamp. The behaviour model buckets by day, so delivery lag does not move a metric — but the field is not provider truth.
- **Model constants are reasoned, not calibrated** against a real portfolio.

---

## Roadmap

**Connect it to where the data already lives.** Direct integration with Tally, Zoho and QuickBooks so the forecast runs on the books as they change — no import, no upkeep.

**Widen what it can act on.** Search across every payout that could move and every invoice that could be chased, and find the combination that closes the gap with the least disruption — instead of one candidate per action type.

**Separate the promise from the guarantee.** Show both numbers: what approving a plan *guarantees*, and what it reaches *if* customers pay. A founder deciding whether to make payroll deserves to know which half of that number is a hope.

---

## License

Not currently licensed for reuse. Built as a Razorpay Buildathon submission.
