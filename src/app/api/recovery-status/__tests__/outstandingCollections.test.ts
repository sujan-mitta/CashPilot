import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Money out for collection is counted whichever kind of link it is.
 *
 * WHAT WENT WRONG
 *
 * The execution page announced "nothing is currently out for collection" and
 * "still short by Rs 6,09,000" directly above two live Razorpay links worth
 * Rs 4,40,000 that the plan had just issued. Both statements were false, and
 * they were false because this endpoint measured "outstanding" by counting
 * PaymentRecovery rows alone.
 *
 * Only one of the two actions that issue links writes those.
 * RECOVER_FAILED_PAYMENTS does. PRIORITIZE_COLLECTIONS does not — it issues
 * links against invoices and records them as ExecutionIntents. So the entire
 * collections half of the product was invisible to the panel that reports on
 * it.
 *
 * The real figure was Rs 1,69,000 short, with Rs 4,40,000 already being chased.
 */

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  business: { findUnique: vi.fn() },
  paymentRecovery: { findMany: vi.fn() },
  executionIntent: { findMany: vi.fn() },
  invoice: { findMany: vi.fn() },
  agentAction: { findMany: vi.fn() },
  transaction: { findMany: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.session }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    business: mocks.business,
    paymentRecovery: mocks.paymentRecovery,
    executionIntent: mocks.executionIntent,
    invoice: mocks.invoice,
    agentAction: mocks.agentAction,
    transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/forecast/movements", () => ({
  buildMovementsForBusiness: vi.fn().mockResolvedValue([]),
}));
// A projection that sits 6,09,000 below the floor: the exact gap on screen.
vi.mock("@/lib/engine/forecast", () => ({
  buildForecast: vi.fn().mockReturnValue([{ closingBalance: -18_000_00 }]),
}));
vi.mock("@/lib/engine/liquiditySafety", () => ({
  calculateLiquiditySafetyRequirement: vi.fn().mockResolvedValue({ requiredBuffer: 42_900_00 }),
}));
vi.mock("@/lib/observability", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "../route";

const INVOICE_LINKS = [
  { id: "i1", targetId: "inv-a", externalRef: "plink_a", actionId: "act-1", amount: 30_000_00 },
  { id: "i2", targetId: "inv-b", externalRef: "plink_b", actionId: "act-1", amount: 14_000_00 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ businessId: "biz-1", userId: "u1" });
  mocks.business.findUnique.mockResolvedValue({ currentCash: 124_000_00 });
  // No failed-payment recoveries out: the panel's only source used to be this.
  mocks.paymentRecovery.findMany.mockResolvedValue([]);
  mocks.executionIntent.findMany.mockResolvedValue(INVOICE_LINKS);
  mocks.invoice.findMany.mockResolvedValue([
    { id: "inv-a", customerName: "Retail Chain A", amount: 30_000_00 },
    { id: "inv-b", customerName: "Distributor B", amount: 14_000_00 },
  ]);
  mocks.agentAction.findMany.mockResolvedValue([
    {
      result: JSON.stringify({
        links: [{ paymentLinkId: "plink_a", shortUrl: "https://rzp.io/i/aaa" }],
      }),
    },
  ]);
  mocks.transaction.findMany.mockResolvedValue([]);
});

const body = async () => (await GET()).json();

describe("Invoice collection links count as money out for collection", () => {
  it("no longer claims nothing is out when links are live", async () => {
    const d = await body();
    expect(d.progress.detail).not.toContain("nothing is currently out for collection");
  });

  it("subtracts them from what is still needed", async () => {
    const d = await body();
    // 4,29,000 floor minus a low of -1,80,000 is a 6,09,000 gap, of which
    // 4,40,000 is already being chased.
    expect(d.progress.shortfall).toBe(60_900_00);
    expect(d.progress.outstanding).toBe(44_000_00);
    expect(d.progress.stillNeededBeyondOutstanding).toBe(16_900_00);
  });

  it("lists them so the operator can open the link", async () => {
    const d = await body();
    expect(d.outstandingCount).toBe(2);
    expect(d.outstanding.map((o: { description: string }) => o.description)).toEqual([
      "Invoice — Retail Chain A",
      "Invoice — Distributor B",
    ]);
    expect(d.outstanding[0].shortUrl).toBe("https://rzp.io/i/aaa");
  });

  it("carries a null URL rather than inventing one", async () => {
    // Only the executor knows whether a sandbox path or a real Razorpay
    // short_url was issued, so an unrecorded link has no address to offer.
    const d = await body();
    expect(d.outstanding[1].shortUrl).toBeNull();
    expect(d.outstanding[1].paymentLinkId).toBe("plink_b");
  });

  it("counts an invoice once however many attempts it took", async () => {
    // A retried obligation has several intents against it; the money is owed
    // once, and double counting it would understate the gap.
    mocks.executionIntent.findMany.mockResolvedValue([
      { id: "i3", targetId: "inv-a", externalRef: "plink_a2", actionId: "act-2", amount: 30_000_00 },
      ...INVOICE_LINKS,
    ]);
    mocks.invoice.findMany.mockResolvedValue([
      { id: "inv-a", customerName: "Retail Chain A", amount: 30_000_00 },
      { id: "inv-b", customerName: "Distributor B", amount: 14_000_00 },
    ]);

    const d = await body();
    expect(d.progress.outstanding).toBe(44_000_00);
    // The newest attempt is the one to send an operator to.
    expect(d.outstanding[0].paymentLinkId).toBe("plink_a2");
  });

  it("drops an invoice once it has been paid", async () => {
    // The query excludes PAID; this proves the endpoint honours the result
    // rather than falling back to the intent's own amount.
    mocks.invoice.findMany.mockResolvedValue([
      { id: "inv-b", customerName: "Distributor B", amount: 14_000_00 },
    ]);

    const d = await body();
    expect(d.progress.outstanding).toBe(14_000_00);
    expect(d.outstandingCount).toBe(1);
  });

  it("still counts failed-payment recoveries alongside them", async () => {
    // The original source must not be lost in the widening.
    mocks.paymentRecovery.findMany.mockImplementation(({ where }: { where: { status: string } }) =>
      Promise.resolve(
        where.status === "PAYMENT_PENDING"
          ? [{ id: "r1", amount: 10_000_00, shortUrl: "https://rzp.io/i/r1", paymentLinkId: "plink_r1", transaction: { description: "Failed payment" } }]
          : []
      )
    );

    const d = await body();
    expect(d.progress.outstanding).toBe(54_000_00);
    expect(d.outstandingCount).toBe(3);
  });
});
