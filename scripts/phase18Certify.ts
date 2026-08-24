/**
 * Phase 18 — live settlement certification harness.
 *
 * Runs the REAL CashPilot execution path against the REAL Razorpay TEST
 * account and prints the complete correlation trace. It does not simulate
 * anything: the payment link it creates is a genuine provider object, and the
 * reconciliation it runs is the same adapter production uses.
 *
 * Usage:
 *   CP_CERT_DB=<url> npx tsx scripts/phase18Certify.ts create
 *   CP_CERT_DB=<url> npx tsx scripts/phase18Certify.ts reconcile <intentId>
 *   CP_CERT_DB=<url> npx tsx scripts/phase18Certify.ts trace <intentId>
 *
 * SAFETY: refuses to run unless RAZORPAY_KEY_ID is a rzp_test_ key. It never
 * prints a secret, and it writes only to the database named in CP_CERT_DB.
 */
import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { executeWithDurableIntent, reconcileUnknownIntent } from "../src/lib/execution/executor";
import { reconcilePaymentLink, createRecoveryPaymentLink } from "../src/lib/razorpay/client";
import { ExecutionOperation } from "../generated/prisma/client";

const keyId = process.env.RAZORPAY_KEY_ID ?? "";
if (!keyId.startsWith("rzp_test_")) {
  console.error("REFUSING: RAZORPAY_KEY_ID is not a rzp_test_ key. Phase 18 is test-mode only.");
  process.exit(1);
}

const dbUrl = process.env.CP_CERT_DB;
if (!dbUrl) {
  console.error("REFUSING: set CP_CERT_DB to the certification database URL.");
  process.exit(1);
}

const pool = new Pool({ connectionString: dbUrl });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const TAG = "cp_phase18";

async function seedContext() {
  const stamp = Date.now().toString(36);

  const business = await prisma.business.create({
    data: { name: `${TAG}_business_${stamp}`, currentCash: 10000000 },
  });

  const strategy = await prisma.strategy.create({
    data: {
      businessId: business.id,
      name: "RECOVER_ONLY",
      actions: [] as any,
      projectedBalance: 12000000,
      riskLevel: "MEDIUM",
      score: 80,
      recommended: true,
      startingCash: business.currentCash,
      agentActions: {
        create: [{ actionType: "RECOVER_FAILED_PAYMENTS", amount: 100000, status: "APPROVED" }],
      },
    },
    include: { agentActions: true },
  });

  const decision = await prisma.decision.create({
    data: {
      businessId: business.id,
      strategyId: strategy.id,
      status: "APPROVED",
      baselineSnapshot: { startingCash: business.currentCash, minimumBalance: -500000, deficitDays: 3 } as any,
      recommendedSnapshot: { minimumBalance: 200000, deficitDays: 0, strategyType: "RECOVER_ONLY" } as any,
      obligationSnapshot: [] as any,
    },
  });

  await prisma.decisionEvent.create({
    data: {
      decisionId: decision.id,
      businessId: business.id,
      eventType: "APPROVED",
      toStatus: "APPROVED",
      actorType: "HUMAN",
      actorId: `${TAG}_operator`,
      metadata: { note: "Phase 18 certification seed" } as any,
    },
  });

  return { business, strategy, decision, action: strategy.agentActions[0] };
}

async function create() {
  const { business, strategy, decision, action } = await seedContext();

  const outcome = await executeWithDurableIntent(prisma, {
    businessId: business.id,
    strategyId: strategy.id,
    actionId: action.id,
    operation: ExecutionOperation.CREATE_PAYMENT_LINK,
    amount: action.amount,
    targetType: "PAYMENT_RECOVERY",
    targetId: null,
    dispatch: async (idempotencyKey) => {
      const link = await createRecoveryPaymentLink(
        action.amount,
        "Phase 18 settlement certification",
        idempotencyKey
      );
      return { externalRef: link.id, externalStatus: link.status };
    },
  });

  const intent = await prisma.executionIntent.findUnique({ where: { id: outcome.intentId } });

  // The link URL is not stored on the intent, so fetch it back from the provider
  // record we just created.
  const verdict = await reconcilePaymentLink(intent!.idempotencyKey, {
    from: new Date(intent!.recordedAt.getTime() - 60000),
    to: new Date(),
  });

  console.log(
    JSON.stringify(
      {
        PHASE_18_TRACE: {
          businessId: business.id,
          decisionId: decision.id,
          strategyId: strategy.id,
          actionId: action.id,
          intentId: intent!.id,
          idempotencyKey: intent!.idempotencyKey,
          providerPaymentLinkId: intent!.externalRef,
          providerStatusAtCreation: intent!.externalStatus,
          intentStatus: intent!.status,
          executionOutcome: outcome.outcome,
        },
        RECONCILIATION_BEFORE_PAYMENT: {
          status: verdict.status,
          providerReference: verdict.providerReference,
          providerStatus: verdict.providerStatus,
          searchExhaustive: verdict.searchExhaustive,
          retrySafe: verdict.retrySafe,
        },
      },
      null,
      2
    )
  );

  console.log("\nOPERATOR ACTION REQUIRED — open this link and complete ONE Razorpay TEST payment:");
  console.log(await shortUrlFor(intent!.externalRef!));
  console.log(`\nThen run:  CP_CERT_DB=<url> npx tsx scripts/phase18Certify.ts reconcile ${intent!.id}`);
}

async function shortUrlFor(paymentLinkId: string): Promise<string> {
  const Razorpay = (await import("razorpay")).default;
  const rp = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID!,
    key_secret: process.env.RAZORPAY_KEY_SECRET!,
  });
  const link: any = await rp.paymentLink.fetch(paymentLinkId);
  return link.short_url;
}

async function reconcile(intentId: string) {
  const before = await prisma.executionIntent.findUnique({ where: { id: intentId } });
  if (!before) throw new Error("intent not found");

  const result = await reconcileUnknownIntent(prisma, intentId);
  const after = await prisma.executionIntent.findUnique({ where: { id: intentId } });

  console.log(
    JSON.stringify(
      {
        intentId,
        idempotencyKey: before.idempotencyKey,
        statusBefore: before.status,
        statusAfter: after!.status,
        reconciliation: {
          status: result.result.status,
          providerReference: result.result.providerReference ?? null,
          providerStatus: result.result.providerStatus ?? null,
          reason: result.result.reason,
          expectedEvidence: result.result.expectedEvidence,
          observedEvidence: result.result.observedEvidence,
          searchExhaustive: result.result.searchExhaustive,
          retrySafe: result.result.retrySafe,
        },
      },
      null,
      2
    )
  );
}

async function trace(intentId: string) {
  const intent = await prisma.executionIntent.findUnique({ where: { id: intentId } });
  if (!intent) throw new Error("intent not found");
  const action = await prisma.agentAction.findUnique({ where: { id: intent.actionId } });
  const decision = await prisma.decision.findFirst({ where: { strategyId: intent.strategyId } });
  const events = decision
    ? await prisma.decisionEvent.findMany({
        where: { decisionId: decision.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    : [];

  console.log(
    JSON.stringify(
      {
        correlation: {
          businessId: intent.businessId,
          decisionId: decision?.id ?? null,
          strategyId: intent.strategyId,
          actionId: intent.actionId,
          intentId: intent.id,
          idempotencyKey: intent.idempotencyKey,
          providerPaymentLinkId: intent.externalRef,
        },
        actionStatus: action?.status ?? null,
        intentStatus: intent.status,
        decisionStatus: decision?.status ?? null,
        decisionEvents: events.map((e) => ({
          seq: e.id,
          type: e.eventType,
          from: e.fromStatus,
          to: e.toStatus,
          actor: e.actorType,
          at: e.createdAt,
        })),
      },
      null,
      2
    )
  );
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "create") await create();
  else if (cmd === "reconcile") await reconcile(arg);
  else if (cmd === "trace") await trace(arg);
  else console.error("usage: create | reconcile <intentId> | trace <intentId>");
  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (e) => {
  console.error("CERTIFY ERROR:", e?.message ?? e);
  process.exit(1);
});
