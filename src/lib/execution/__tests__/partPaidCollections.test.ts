import { describe, it, expect, beforeEach, vi } from "vitest";
import { executePrioritizeCollections } from "../actionExecutors";
import { makeExecutionIntentFake } from "../../engine/__tests__/helpers/prismaFakes";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const createLink = vi.fn();
vi.mock("../../razorpay/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../razorpay/client")>();
  return { ...actual, createRecoveryPaymentLink: (...args: unknown[]) => createLink(...args) };
});

/**
 * A collection link asks for what is STILL OWED, and chases every invoice the
 * plan counted.
 *
 * TWO DIVERGENCES, WHICH INTERLOCK
 *
 * The planner counted OVERDUE and PARTIALLY_PAID invoices, and valued them at
 * `totalOutstanding` — amount minus what has already been paid. The executor
 * queried OVERDUE alone and billed `inv.amount`, the full face value.
 *
 * So the plan promised an inflow from invoices it would never issue a link for,
 * and any link it did issue against a part-paid invoice would have charged the
 * customer for money they had already sent. On a Rs 10L invoice with Rs 6L
 * paid, the plan promised Rs 4L and the link would have asked for Rs 10L.
 *
 * Fixing only the status filter would have exposed the overcharge, so both are
 * held here together.
 */

const BUSINESS = "biz-A";

const INVOICES = [
  // Nothing paid yet: outstanding is the face value, and billing must not change.
  { id: "cminvoice0000000000000001", customerName: "Retail Chain A", amount: 30000000, paidAmount: 0, status: "OVERDUE", businessId: BUSINESS },
  // Part paid and past due. Counted by the planner, never chased before.
  { id: "cminvoice0000000000000002", customerName: "Distributor B", amount: 100000000, paidAmount: 60000000, status: "PARTIALLY_PAID", businessId: BUSINESS },
];

let store: { intents: unknown[] };
let client: {
  executionIntent: ReturnType<typeof makeExecutionIntentFake>;
  invoice: { findMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  store = { intents: [] };
  let n = 0;
  createLink.mockImplementation(async () => ({ id: `plink_${++n}`, short_url: `https://rzp.io/i/${n}`, status: "created" }));
  client = {
    executionIntent: makeExecutionIntentFake(store),
    invoice: {
      // Honours the status filter the executor asks for, so the test can tell
      // whether PARTIALLY_PAID was requested at all.
      findMany: vi.fn(async (args: { where: { status: { in: string[] } } }) =>
        INVOICES.filter((i) => args.where.status.in.includes(i.status)).map((i) => ({ ...i }))
      ),
      updateMany: vi.fn(async () => ({ count: 2 })),
    },
  };
});

const run = () =>
  executePrioritizeCollections(
    client as never,
    { businessId: BUSINESS, strategyId: "strat-1", action: { id: "act-1", amount: 0 } as never }
  );

const billedAmounts = () => createLink.mock.calls.map((c) => c[0] as number);

describe("Collections bill what is still owed", () => {
  it("asks a part-paid customer only for the remainder", () => {
    // The overcharge this prevents: Rs 4L outstanding on a Rs 10L invoice.
    return run().then(() => {
      expect(billedAmounts()).toContain(40000000);
      expect(billedAmounts()).not.toContain(100000000);
    });
  });

  it("still bills the full amount when nothing has been paid", async () => {
    // Guards the guard: an outstanding calculation that always returned a
    // reduced figure would satisfy the test above and under-bill everyone else.
    await run();
    expect(billedAmounts()).toContain(30000000);
  });

  it("reports the billed figure, not the face value", async () => {
    const outcome = await run();
    const parsed = JSON.parse(outcome.result) as { links: Array<{ amount: number }> };
    expect(parsed.links.map((l) => l.amount).sort((a, b) => a - b)).toEqual([30000000, 40000000]);
  });
});

describe("Collections chase every invoice the plan counted", () => {
  it("includes part-paid overdue invoices, not just OVERDUE", async () => {
    await run();
    const statuses = client.invoice.findMany.mock.calls[0][0].where.status.in;
    expect(statuses).toContain("OVERDUE");
    expect(statuses).toContain("PARTIALLY_PAID");
  });

  it("issues a link for each of them", async () => {
    const outcome = await run();
    const parsed = JSON.parse(outcome.result) as { links: Array<{ customerName: string }> };
    // Distributor B was promised in the plan's inflow and previously never
    // chased, which is the whole defect.
    expect(parsed.links.map((l) => l.customerName)).toContain("Distributor B");
    expect(parsed.links).toHaveLength(2);
  });
});
