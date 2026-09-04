# CashPilot 🧭
> **AI-Powered Payment & Cash-Flow Intervention Controller**
> Built for the Razorpay Buildathon (13-Day Scope MVP)

CashPilot is a payment-centric cash-flow control system. It monitors corporate ledgers to identify liquidity risks, runs deterministic root-cause analysis, simulates cash recovery strategies using dynamic scoring, and allows operators to orchestrate test-mode payments (via Razorpay API) to resolve deficits—enforcing a strict **human-in-the-loop** authorization gate.

---

## 🏗️ Core Architecture & Tech Stack

```mermaid
graph TD
    A[Ledger / DB: Postgres] --> B[Deterministic Financial Engine]
    B --> C[Forecast & Runway Timeline]
    B --> D[Causal Investigator]
    B --> E[Intervention Simulator & Scorer]
    E --> F[AI Narration Layer: Groq Qwen]
    E --> G[Orchestration Layer: Razorpay test-mode]
    G --> H[Human Gate Confirmation]
    H --> A
```

* **Frontend**: Next.js 16 (App Router + Turbopack), Tailwind CSS v4, Recharts (responsive area timelines), Lucide Icons.
* **Backend**: Next.js API Routes, Prisma ORM v7 (PostgreSQL Client with native driver adapters).
* **Database**: PostgreSQL (Prisma Postgres dev server).
* **AI Engine**: Groq SDK (`qwen/qwen3.6-27b` model for ultra-low latency).
* **Payment gateway**: Razorpay Node.js SDK (test mode link generation).

---

## 📈 The Canonical Demo Scenario

All financial figures are processed as integers in **paise** to prevent precision leakage:
* **Current Cash**: ₹10,00,000 (Available liquidity)
* **Committed Inflows**: ₹5,80,000 (Day 3 & Day 6 customer invoice payments)
* **Critical Outflows**: ₹20,00,000 (High-criticality payroll runs and component suppliers scheduled before collections land)
* **Projected Deficit**: **₹-4,20,000** (leads to a **Day 8 Runway Crisis** in the committed forecast)
* **Recoverable failed-payment**: ₹2,40,000 (unresolved Day -2 credit card transactions)
* **Acceleratable Overdue Receivables**: ₹4,40,000 (overdue customer invoice balances)

### Simulated Strategies & Dynamic Scores:
1. **Strategy A: Do Nothing** — Closing Balance: `₹-4.20L`, Risk: **HIGH**, Score: `35`
2. **Strategy B: Recovery Only** — Closing Balance: `₹-1.80L`, Risk: **HIGH**, Score: `56`
3. **Strategy C: Recovery + Collections (Recommended)** — Closing Balance: `₹+2.60L`, Risk: **LOW**, Score: `80` (Winner)
4. **Strategy D: Full Intervention (Payout Rescheduling)** — Closing Balance: `₹+9.60L`, Risk: **LOW**, Score: `78` (Lower score due to high vendor disruption from postponing payouts)

---

## 📂 Project Directory Mapping

* [`/prisma/schema.prisma`](prisma/schema.prisma) — Database layout and the `PaymentRecovery` state machine.
* [`/src/lib/engine/`](src/lib/engine) — Deterministic engines:
  * [`forecast.ts`](src/lib/engine/forecast.ts) (Runway timelines)
  * [`riskDetector.ts`](src/lib/engine/riskDetector.ts) (Categorizations)
  * [`rootCause.ts`](src/lib/engine/rootCause.ts) (Ledger diagnostics)
  * [`strategyEngine.ts`](src/lib/engine/strategyEngine.ts) (Simulations)
  * [`scorer.ts`](src/lib/engine/scorer.ts) (Dynamic Multi-Factor Scorer)
* [`/src/lib/ai/`](src/lib/ai) — Groq client connections and prompts enforcing the **Golden Rule** (AI cannot calculate math).
* [`/src/lib/razorpay/client.ts`](src/lib/razorpay/client.ts) — Gateway link creator with mock checkouts.
* [`/src/app/api/`](src/app/api) — API route handlers managing ledger requests.
* [`/src/app/`](src/app) — Stepper screens:
  1. **Dashboard** (`/dashboard`)
  2. **Ledger Investigation** (`/investigation`)
  3. **Intervention Simulator** (`/strategies`)
  4. **Human Approval Gate** (`/approval`)
  5. **Action execution** (`/execution`)

---

## 🏃 Getting Started & Local Setup

### 1. Database Provisioning
Ensure the local database server is running in the background and seed the workspace:
```bash
# Verify/Start the local Prisma database
npx prisma dev start default

# Synchronize tables
npx prisma db push

# Populate scenario seeds
npx prisma db seed
```

### 2. Configure Credentials
Add your API credentials to a `.env` file in the project root:
```env
DATABASE_URL="postgres://USER:PASSWORD@localhost:5432/cashpilot?sslmode=disable&pgbouncer=true"
DIRECT_URL="postgres://USER:PASSWORD@localhost:5432/cashpilot?sslmode=disable&pgbouncer=true"
GROQ_API_KEY="your_groq_api_key"
RAZORPAY_KEY_ID="your_razorpay_test_key_id"
RAZORPAY_KEY_SECRET="your_razorpay_test_key_secret"
```

### 3. Run Web Server
Start the Next.js development server:
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.
