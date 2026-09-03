import { describe, it, expect } from "vitest";

/**
 * A debt that has already been collected is not a recovery candidate.
 *
 * WHAT WENT WRONG
 *
 * Recovering a failed payment leaves its transaction FAILED. That is correct —
 * the original payment DID fail, the behaviour model needs that fact, and the
 * money arrived by another route and is counted in currentCash.
 *
 * But the planner selected candidates on transaction status alone, so it
 * proposed recovering a debt that was already paid. The executor then refused
 * with "No candidate failed payment found to recover", and the operator saw a
 * plan presented as approved whose first action could never run — on the very
 * money they had just successfully recovered.
 *
 * The two sides were asking different questions: the planner asked "did this
 * payment fail?", the executor asked "is there a recovery still to do?".
 *
 * This pins the selection rule itself, which is the thing that was wrong.
 */

type Tx = { id: string; status: string; type: string; amount: number };
type Rec = { transactionId: string; status: string };

/**
 * The rule as the route applies it.
 *
 * Mirrored rather than imported because the route is an HTTP handler wrapped
 * around a database; the rule is the part worth testing, and it is one line of
 * logic that was wrong for a reason worth recording.
 */
const HANDLED = ["RECOVERED", "PAYMENT_PENDING", "RECOVERY_INITIATED"];

function recoveryCandidates(transactions: Tx[], recoveries: Rec[]): Tx[] {
  const alreadyHandled = new Set(
    recoveries.filter((r) => HANDLED.includes(r.status)).map((r) => r.transactionId)
  );
  return transactions
    .filter((t) => t.status === "FAILED" && t.type === "INFLOW" && !alreadyHandled.has(t.id))
    .sort((a, b) => b.amount - a.amount || a.id.localeCompare(b.id));
}

const failedInflow = (id: string, amount: number): Tx => ({
  id,
  status: "FAILED",
  type: "INFLOW",
  amount,
});

describe("Money already recovered is not offered again", () => {
  it("excludes a debt whose recovery succeeded", () => {
    // The exact live failure: paid the link, built a fresh plan, and the first
    // action targeted the debt that had just been settled.
    const candidates = recoveryCandidates(
      [failedInflow("tx1", 240_000_00)],
      [{ transactionId: "tx1", status: "RECOVERED" }]
    );
    expect(candidates).toHaveLength(0);
  });

  it("excludes a debt with a link already out", () => {
    // Issuing a second link asks the same customer to pay twice.
    for (const status of ["PAYMENT_PENDING", "RECOVERY_INITIATED"]) {
      const candidates = recoveryCandidates(
        [failedInflow("tx1", 240_000_00)],
        [{ transactionId: "tx1", status }]
      );
      expect(candidates).toHaveLength(0);
    }
  });

  it("still offers a debt whose recovery attempt failed", () => {
    // A failed attempt is exactly the case worth retrying. Excluding it would
    // be as wrong as offering an already-paid one.
    const candidates = recoveryCandidates(
      [failedInflow("tx1", 240_000_00)],
      [{ transactionId: "tx1", status: "RECOVERY_FAILED" }]
    );
    expect(candidates).toHaveLength(1);
  });

  it("offers a failed payment that has never been attempted", () => {
    expect(recoveryCandidates([failedInflow("tx1", 240_000_00)], [])).toHaveLength(1);
  });
});

describe("It keeps the rules it already had", () => {
  it("ignores failed OUTFLOWS", () => {
    // A payment WE failed to make is not recoverable revenue.
    const outflow = { id: "tx1", status: "FAILED", type: "OUTFLOW", amount: 100 };
    expect(recoveryCandidates([outflow], [])).toHaveLength(0);
  });

  it("ignores inflows that did not fail", () => {
    const pending = { id: "tx1", status: "PENDING", type: "INFLOW", amount: 100 };
    expect(recoveryCandidates([pending], [])).toHaveLength(0);
  });

  it("still picks the largest deterministically", () => {
    // The decision fingerprint assumes the same ledger yields the same
    // recommendation.
    const candidates = recoveryCandidates(
      [failedInflow("b", 100), failedInflow("a", 500), failedInflow("c", 500)],
      []
    );
    expect(candidates.map((t) => t.id)).toEqual(["a", "c", "b"]);
  });
});

describe("Mixed ledgers", () => {
  it("skips the settled debt and offers the next one", () => {
    // The case that matters after a partial recovery: something WAS collected,
    // something else still needs collecting, and the plan should target the
    // second.
    const candidates = recoveryCandidates(
      [failedInflow("paid", 240_000_00), failedInflow("unpaid", 90_000_00)],
      [{ transactionId: "paid", status: "RECOVERED" }]
    );
    expect(candidates.map((t) => t.id)).toEqual(["unpaid"]);
  });

  it("returns nothing when every failure is handled", () => {
    // And nothing is the right answer — the planner should then not propose a
    // recovery action at all, rather than proposing one that cannot run.
    const candidates = recoveryCandidates(
      [failedInflow("a", 100), failedInflow("b", 200)],
      [
        { transactionId: "a", status: "RECOVERED" },
        { transactionId: "b", status: "PAYMENT_PENDING" },
      ]
    );
    expect(candidates).toHaveLength(0);
  });
});
