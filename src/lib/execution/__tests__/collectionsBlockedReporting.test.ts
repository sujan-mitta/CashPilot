import { describe, it, expect, beforeEach, vi } from "vitest";
import { executePrioritizeCollections } from "../actionExecutors";
import { executeWithDurableIntent } from "../executor";
import { makeExecutionIntentFake } from "../../engine/__tests__/helpers/prismaFakes";
import { ExecutionOperation } from "../../../../generated/prisma/client";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const createLink = vi.fn();
vi.mock("../../razorpay/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../razorpay/client")>();
  return { ...actual, createRecoveryPaymentLink: (...args: unknown[]) => createLink(...args) };
});

/**
 * REGRESSION: "Generated payment links for 0 of 2 overdue invoices." with an
 * empty `links` array and no reason whatsoever.
 *
 * Both invoices already had a SUCCEEDED intent from an earlier action. The
 * obligation guard correctly refused to create a second link for the same debt,
 * but the refusal came back as BLOCKED_BY_PRIOR_ATTEMPT - an outcome this
 * executor did not classify. It fell into the FAILED branch, which reads
 * `outcome.error`, a field the blocked path never populates. `undefined` was
 * then dropped by JSON.stringify, so the caller received a bare count.
 */

const BUSINESS = "biz-A";
const INVOICES = [
  { id: "cminvoice0000000000000001", customerName: "Retail Chain A", amount: 30000000, status: "OVERDUE", businessId: BUSINESS },
  { id: "cminvoice0000000000000002", customerName: "Distributor B", amount: 14000000, status: "OVERDUE", businessId: BUSINESS },
];

const store = { intents: [] as any[] };
const client: any = {
  executionIntent: makeExecutionIntentFake(store),
  invoice: {
    findMany: vi.fn(async () => INVOICES.map((i) => ({ ...i }))),
    updateMany: vi.fn(async () => ({ count: INVOICES.length })),
  },
};

const ctx = (actionId: string) => ({
  businessId: BUSINESS,
  strategyId: `strat-${actionId}`,
  action: { id: actionId, amount: 0 } as any,
});

/** Seeds one SUCCEEDED intent per invoice, as an earlier action would leave. */
async function seedEarlierSuccessfulRun(actionId: string) {
  for (const inv of INVOICES) {
    await executeWithDurableIntent(client, {
      businessId: BUSINESS,
      strategyId: `strat-${actionId}`,
      actionId,
      operation: ExecutionOperation.CREATE_PAYMENT_LINK,
      amount: inv.amount,
      targetType: "INVOICE",
      targetId: inv.id,
      dispatch: async () => ({ externalRef: `plink_FOR_${inv.id}`, externalStatus: "created" }),
    });
  }
}

beforeEach(() => {
  store.intents.length = 0;
  createLink.mockReset();
  createLink.mockRejectedValue(new Error("the provider must not be called"));
});

describe("PRIORITIZE_COLLECTIONS after an earlier successful run", () => {
  it("returns the links that already exist instead of 0 of 2", async () => {
    await seedEarlierSuccessfulRun("action-1");
    expect(store.intents).toHaveLength(2);

    // Strategy regenerated: same invoices, brand-new action id.
    const outcome = await executePrioritizeCollections(client, ctx("action-2"));
    const payload = JSON.parse(outcome.result);

    expect(payload.links).toHaveLength(2);
    expect(payload.message).toBe("Generated payment links for 2 of 2 overdue invoices.");
    expect(payload.links.map((l: any) => l.paymentLinkId)).toEqual([
      `plink_FOR_${INVOICES[0].id}`,
      `plink_FOR_${INVOICES[1].id}`,
    ]);
    // Each link is addressable from the CURRENT action.
    for (const link of payload.links) {
      expect(link.shortUrl).toContain("actionId=action-2");
    }

    // The provider was never contacted a second time, and no duplicate intents.
    expect(createLink).not.toHaveBeenCalled();
    expect(store.intents).toHaveLength(2);
    expect(outcome.status).toBe("EXECUTING");
  });

  it("never reports an empty result without a reason", async () => {
    // Both invoices genuinely unresolved: the guard refuses and cannot say more
    // than that the outcome is undetermined - but it must say at least that.
    for (const inv of INVOICES) {
      await executeWithDurableIntent(client, {
        businessId: BUSINESS,
        strategyId: "strat-1",
        actionId: "action-1",
        operation: ExecutionOperation.CREATE_PAYMENT_LINK,
        amount: inv.amount,
        targetType: "INVOICE",
        targetId: inv.id,
        dispatch: async () => {
          throw new Error("ETIMEDOUT");
        },
      });
    }

    const outcome = await executePrioritizeCollections(client, ctx("action-2"));
    const payload = JSON.parse(outcome.result);

    expect(payload.links).toHaveLength(0);
    // The defect was precisely this: a bare count and nothing else.
    expect(payload.unknown ?? payload.failed).toBeTruthy();
    expect(payload.unknown).toMatch(/may already have created a live payment link/i);
    expect(outcome.status).toBe("EXECUTION_UNKNOWN");
    expect(createLink).not.toHaveBeenCalled();
  });
});
