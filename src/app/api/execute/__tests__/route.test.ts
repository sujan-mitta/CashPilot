import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "../route";
import { prisma } from "@/lib/prisma";
import { ActionStatus } from "../../../../../generated/prisma/client";
import { seedFreshDecision } from "../../../../lib/engine/__tests__/helpers/prismaFakes";

// vi.mock factories are hoisted, so the backing arrays must exist first.
const stores = vi.hoisted(() => ({
  intents: [] as any[],
  decisions: [] as any[],
  events: [] as any[],
}));

vi.mock("@/lib/prisma", async () => {
  const { makeExecutionIntentFake, makeDecisionFakes } = await import(
    "../../../../lib/engine/__tests__/helpers/prismaFakes"
  );
  const executionIntentFake = makeExecutionIntentFake(stores as any);
  const decisionFakes = makeDecisionFakes(stores as any);
  return {
    prisma: {
      executionIntent: executionIntentFake,
      decision: decisionFakes.decision,
      decisionEvent: decisionFakes.decisionEvent,
      strategy: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
      },
      business: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
      },
      transaction: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      invoice: {
        findMany: vi.fn(),
        updateMany: vi.fn(),
      },
      agentAction: {
        findUnique: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
      payout: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
      $transaction: vi.fn(),
    },
  };
});

/**
 * Isolation must not depend on credentials being ABSENT.
 *
 * This suite exercises PRIORITIZE_COLLECTIONS and RECOVER_FAILED_PAYMENTS, both
 * of which call the provider. It used to rely on `isPlaceholder` being true
 * because no RAZORPAY_* vars were set - so running the suite with
 * RAZORPAY_LIVE_TEST=1 (which loads dotenv globally, see vitest.config.ts) made
 * these tests create REAL payment links against the test account and burn its
 * 30-link quota. A unit test's hermeticity cannot hinge on the ambient env.
 */
vi.mock("@/lib/razorpay/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/razorpay/client")>("@/lib/razorpay/client");
  return {
    ...actual,
    createRecoveryPaymentLink: vi.fn(async (_amount: number, _desc: string, key?: string) => ({
      id: `plink_sim_${key}`,
      short_url: `/sandbox/checkout?paymentLinkId=plink_sim_${key}`,
      status: "created",
    })),
  };
});

vi.mock("@/lib/auth", () => {
  return {
    getSession: vi.fn(() => Promise.resolve({ userId: "mock-user-id", name: "Mock User", email: "mock@company.com", businessId: "business-1", businessName: "Mock Business" })),
  };
});

vi.mock("@/lib/ai/agents", () => {
  return {
    runAgent: vi.fn(() => Promise.resolve("Mocked narrative")),
  };
});

/**
 * Prisma's interactive `$transaction(fn)` runs `fn` with a transactional client.
 * A bare vi.fn() returns undefined and silently skips the body, so any code
 * routed through a transaction would appear to do nothing.
 */
function installTransactionFake() {
  vi.mocked(prisma.$transaction).mockImplementation((async (arg: any) =>
    typeof arg === "function" ? arg(prisma) : arg) as any);
}

describe("Execute Strategy Route", () => {
  beforeEach(() => {
  installTransactionFake();
    vi.clearAllMocks();
  });

  it("Concurrent Execution: losing request does not execute the action and receives controlled status", async () => {
    const mockStrategy = {
      id: "strategy-1",
      name: "FULL_INTERVENTION",
      projectedBalance: 10000000,
      // A real Strategy row always records the cash position it was simulated
      // from; execution now refuses to run against an unknown baseline.
      startingCash: 10000000,
      agentActions: [
        { id: "action-1", actionType: "PAUSE_EXPENSE", status: "APPROVED", amount: 1500000 },
      ],
    };

    const mockBusiness = {
      id: "business-1",
      currentCash: 10000000,
    };

    vi.mocked(prisma.strategy.findFirst).mockResolvedValue(mockStrategy as any);
    vi.mocked(prisma.business.findFirst).mockResolvedValue(mockBusiness as any);
    vi.mocked(prisma.business.findUnique).mockResolvedValue(mockBusiness as any);
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.payout.findMany).mockResolvedValue([] as any);
    // The pause runs inside a transaction; the fake executes the callback so the
    // ledger write actually happens rather than silently returning undefined.
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: any) =>
      fn({
        transaction: {
          findFirst: vi.fn().mockResolvedValue({ id: "tx-saas", amount: 1500000, businessId: "business-1" }),
          update: vi.fn(),
        },
        payout: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
      })) as any);
    stores.intents.length = 0;
    await seedFreshDecision(prisma, stores as any, {
      businessId: "business-1",
      strategyId: "strategy-1",
      strategyType: "FULL_INTERVENTION",
      actions: [{ type: "PAUSE_EXPENSE", amount: 1500000 }],
      status: "APPROVED",
    });

    // Mock updateMany for action claim status: first returns 1, second returns 0
    let claimCount = 0;
    vi.mocked(prisma.agentAction.updateMany).mockImplementation(() => {
      claimCount++;
      return Promise.resolve({ count: claimCount === 1 ? 1 : 0 }) as any;
    });

    // Mock findUnique to return COMPLETED or EXECUTING for the concurrent check refetch
    vi.mocked(prisma.agentAction.findUnique).mockResolvedValue({
      id: "action-1",
      status: ActionStatus.COMPLETED,
      result: "Already completed concurrently",
    } as any);

    const req1 = new Request("http://localhost/api/execute", {
      method: "POST",
      body: JSON.stringify({ strategyId: "strategy-1" }),
    });
    const req2 = new Request("http://localhost/api/execute", {
      method: "POST",
      body: JSON.stringify({ strategyId: "strategy-1" }),
    });

    const [res1, res2] = await Promise.all([
      POST(req1),
      POST(req2)
    ]);

    const body1 = await res1.json();
    const body2 = await res2.json();

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Winning request has COMPLETED step
    expect(body1.steps[0].status).toBe("COMPLETED");

    // Losing request has already completed step or controlled output
    expect(body2.steps[0].narration).toContain("already completed");
  });

  // =========================================================================
  // PHASE 14 - EXECUTION HONESTY
  // =========================================================================

  /**
   * Seeds a decision whose fingerprint matches the world the test just built,
   * so the Phase 15 freshness gate sees a genuinely fresh strategy rather than
   * being bypassed. Returns the live row so assertions can read its status.
   */
  async function installDecision(status: string, actions: any[] = []) {
    stores.decisions.length = 0;
    stores.events.length = 0;
    const row = await seedFreshDecision(prisma, stores as any, {
      businessId: "business-1",
      strategyId: "strategy-1",
      strategyType: "FULL_INTERVENTION",
      actions: actions.map((a) => ({
        type: a.actionType,
        amount: a.amount,
        targetPayoutId: a.targetPayoutId ?? null,
        targetTransactionId: a.targetTransactionId ?? null,
      })),
      status,
    });
    row.approvalSnapshot = { approvedBy: "u1" };
    return row;
  }

  function installStrategy(actions: any[], cash = 10000000) {
    stores.intents.length = 0;
    vi.mocked(prisma.strategy.findFirst).mockResolvedValue({
      id: "strategy-1",
      name: "FULL_INTERVENTION",
      projectedBalance: -4200000,
      startingCash: cash,
      riskLevel: "HIGH",
      agentActions: actions,
    } as any);
    vi.mocked(prisma.business.findUnique).mockResolvedValue({ id: "business-1", currentCash: cash } as any);
    vi.mocked(prisma.business.findFirst).mockResolvedValue({ id: "business-1", currentCash: cash } as any);
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.payout.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.agentAction.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.agentAction.update).mockResolvedValue({} as any);
  }

  // =========================================================================
  // REGRESSION: "Concurrency block: Action is no longer APPROVED (current: X)"
  //
  // The claim compare-and-set admitted APPROVED only, while the action state
  // machine declares FAILED -> EXECUTING a legal retry. A FAILED action
  // therefore passed the transition gate, lost the claim, and was reported as a
  // concurrency block caused by a request that never existed - permanently
  // unable to be retried.
  // =========================================================================
  describe("retrying an action that previously failed", () => {
    /** Records the `where` of each claim so the admitted set can be asserted. */
    function captureClaims(behaviour: (where: any) => number) {
      const seen: any[] = [];
      vi.mocked(prisma.agentAction.updateMany).mockImplementation((async ({ where }: any) => {
        seen.push(where);
        return { count: behaviour(where) };
      }) as any);
      return seen;
    }

    /** Matches the real compare-and-set against a row's actual status. */
    const claimAgainst = (actualStatus: string) => (where: any) => {
      const filter = where?.status;
      const admits = filter?.in ? filter.in.includes(actualStatus) : filter === actualStatus;
      return admits ? 1 : 0;
    };

    it("claims a FAILED action instead of reporting a phantom concurrency block", async () => {
      const actions = [
        { id: "action-1", actionType: "PRIORITIZE_COLLECTIONS", status: "FAILED", amount: 4400000 },
      ];
      installStrategy(actions);
      await installDecision("APPROVED", actions);
      vi.mocked(prisma.invoice.findMany).mockResolvedValue([
        { id: "inv-1", amount: 4400000, customerName: "Acme", status: "OVERDUE", businessId: "business-1" },
      ] as any);
      vi.mocked(prisma.invoice.updateMany).mockResolvedValue({ count: 1 } as any);

      const claims = captureClaims(claimAgainst("FAILED"));

      const res = await POST(new Request("http://localhost/api/execute", {
        method: "POST",
        body: JSON.stringify({ strategyId: "strategy-1" }),
      }));
      const body = await res.json();

      // The claim must admit FAILED - this is what the state machine already
      // declares legal via ALLOWED_TRANSITIONS[FAILED] = [EXECUTING].
      expect(claims[0].status.in).toContain(ActionStatus.FAILED);
      expect(claims[0].status.in).toContain(ActionStatus.APPROVED);

      // The retry actually ran rather than dying at the claim.
      expect(body.steps[0].status).toBe("EXECUTING");
      expect(body.steps[0].result).not.toMatch(/Concurrency block/i);
    });

    it("END TO END: retrying the failed collections action returns the links that already exist", async () => {
      // This is the exact sequence the user hit, both defects in one run:
      //   1. an earlier action issued links for both invoices;
      //   2. the strategy was regenerated, so a NEW action targeted the same
      //      invoices, was refused by the obligation guard, reported
      //      "0 of 2 overdue invoices" with no reason, and went FAILED;
      //   3. re-running it hit "Concurrency block: no longer APPROVED (FAILED)".
      // After both fixes the retry must run AND hand back the existing links,
      // without contacting the provider a second time.
      const actions = [
        { id: "action-2", actionType: "PRIORITIZE_COLLECTIONS", status: "FAILED", amount: 4400000 },
      ];
      installStrategy(actions);
      await installDecision("APPROVED", actions);
      vi.mocked(prisma.invoice.findMany).mockResolvedValue([
        { id: "inv-1", amount: 3000000, customerName: "Retail Chain A", status: "OVERDUE", businessId: "business-1" },
        { id: "inv-2", amount: 1400000, customerName: "Distributor B", status: "OVERDUE", businessId: "business-1" },
      ] as any);
      vi.mocked(prisma.invoice.updateMany).mockResolvedValue({ count: 2 } as any);
      captureClaims(claimAgainst("FAILED"));

      // Step 1: the earlier action's intents, SUCCEEDED, under DIFFERENT
      // idempotency keys - a regenerated strategy mints a new actionId.
      stores.intents.push(
        {
          id: "intent-old-1", businessId: "business-1", strategyId: "strategy-0", actionId: "action-1",
          idempotencyKey: "cp_oldkey_1", operation: "CREATE_PAYMENT_LINK",
          targetType: "INVOICE", targetId: "inv-1", obligationKey: "INVOICE:inv-1",
          amount: 3000000, status: "SUCCEEDED", externalRef: "plink_EXISTING_1",
          externalStatus: "created", attempts: 1, recordedAt: new Date(),
        },
        {
          id: "intent-old-2", businessId: "business-1", strategyId: "strategy-0", actionId: "action-1",
          idempotencyKey: "cp_oldkey_2", operation: "CREATE_PAYMENT_LINK",
          targetType: "INVOICE", targetId: "inv-2", obligationKey: "INVOICE:inv-2",
          amount: 1400000, status: "SUCCEEDED", externalRef: "plink_EXISTING_2",
          externalStatus: "created", attempts: 1, recordedAt: new Date(),
        }
      );

      const res = await POST(new Request("http://localhost/api/execute", {
        method: "POST",
        body: JSON.stringify({ strategyId: "strategy-1" }),
      }));
      const body = await res.json();

      // Step 3 fixed: the retry was claimed and ran.
      expect(body.steps[0].result).not.toMatch(/Concurrency block/i);
      expect(body.steps[0].status).toBe("EXECUTING");

      // Step 2 fixed: both links come back, and they are the ORIGINAL ones.
      const payload = JSON.parse(body.steps[0].result);
      expect(payload.message).toBe("Generated payment links for 2 of 2 overdue invoices.");
      expect(payload.links.map((l: any) => l.paymentLinkId)).toEqual([
        "plink_EXISTING_1",
        "plink_EXISTING_2",
      ]);

      // No second provider execution: no new intent rows, and nothing bearing a
      // freshly-minted link id.
      expect(stores.intents).toHaveLength(2);
      expect(JSON.stringify(payload)).not.toMatch(/plink_sim_/);
    });

    it("still refuses an action another request is executing, and says why", async () => {
      const actions = [
        { id: "action-1", actionType: "PRIORITIZE_COLLECTIONS", status: "EXECUTING", amount: 4400000 },
      ];
      installStrategy(actions);
      await installDecision("APPROVED", actions);
      captureClaims(claimAgainst("EXECUTING"));
      vi.mocked(prisma.agentAction.findUnique).mockResolvedValue({
        id: "action-1",
        status: ActionStatus.EXECUTING,
        result: "",
      } as any);

      const res = await POST(new Request("http://localhost/api/execute", {
        method: "POST",
        body: JSON.stringify({ strategyId: "strategy-1" }),
      }));
      const body = await res.json();

      // EXECUTING is genuinely not claimable: an earlier run owns it.
      expect(body.steps[0].result).toMatch(/already in flight/i);
      // The old message blamed a race for every refusal, including this one,
      // and never said what to do about it.
      expect(body.steps[0].result).toMatch(/settle or cancel/i);
      expect(body.steps[0].result).not.toMatch(/no longer APPROVED/i);
    });

    it("never re-dispatches an EXECUTION_UNKNOWN action", async () => {
      // Caught by the transition gate: ALLOWED_TRANSITIONS[EXECUTION_UNKNOWN]
      // deliberately omits EXECUTING, because the operation may already have
      // landed at the provider.
      const actions = [
        { id: "action-1", actionType: "PRIORITIZE_COLLECTIONS", status: "EXECUTION_UNKNOWN", amount: 4400000 },
      ];
      installStrategy(actions);
      await installDecision("APPROVED", actions);
      const claims = captureClaims(() => 1);

      const res = await POST(new Request("http://localhost/api/execute", {
        method: "POST",
        body: JSON.stringify({ strategyId: "strategy-1" }),
      }));
      const body = await res.json();

      // Refused before the claim is even attempted.
      expect(claims).toHaveLength(0);
      expect(body.steps[0].result).toMatch(/Cannot transition from EXECUTION_UNKNOWN/i);
    });

    it("refuses when the status changed after the gate read it", async () => {
      // The gate reads the snapshot loaded at the top of the request; the claim
      // is the authoritative check. A concurrent run can move the row in
      // between, which is the only genuine race here - and the one case the old
      // "Concurrency block" wording actually described.
      const actions = [
        { id: "action-1", actionType: "PRIORITIZE_COLLECTIONS", status: "APPROVED", amount: 4400000 },
      ];
      installStrategy(actions);
      await installDecision("APPROVED", actions);
      captureClaims(claimAgainst("EXECUTION_UNKNOWN")); // row moved under us
      vi.mocked(prisma.agentAction.findUnique).mockResolvedValue({
        id: "action-1",
        status: ActionStatus.EXECUTION_UNKNOWN,
        result: "",
      } as any);

      const res = await POST(new Request("http://localhost/api/execute", {
        method: "POST",
        body: JSON.stringify({ strategyId: "strategy-1" }),
      }));
      const body = await res.json();

      expect(body.steps[0].result).toMatch(/undetermined/i);
      expect(body.steps[0].result).toMatch(/reconcile/i);
    });
  });

  it("PART 33: issuing a payment link marks the action EXECUTING, never COMPLETED", async () => {
    const actions = [
      { id: "action-1", actionType: "PRIORITIZE_COLLECTIONS", status: "APPROVED", amount: 4400000 },
    ];
    installStrategy(actions);
    await installDecision("APPROVED", actions);
    vi.mocked(prisma.invoice.findMany).mockResolvedValue([
      { id: "inv-1", amount: 4400000, customerName: "Acme", status: "OVERDUE", businessId: "business-1" },
    ] as any);
    vi.mocked(prisma.invoice.updateMany).mockResolvedValue({ count: 1 } as any);

    const res = await POST(new Request("http://localhost/api/execute", {
      method: "POST",
      body: JSON.stringify({ strategyId: "strategy-1" }),
    }));
    const body = await res.json();

    // A link exists; the money has not arrived. COMPLETED here would confuse
    // execution with settlement (PRINCIPLE 5).
    expect(body.steps[0].status).toBe("EXECUTING");
    expect(body.settlementConfirmed).toBe(false);
  });

  it("PART 33: the committed balance excludes money that has not settled", async () => {
    installStrategy([
      { id: "action-1", actionType: "PRIORITIZE_COLLECTIONS", status: "APPROVED", amount: 4400000 },
    ]);
    await installDecision("APPROVED", [
      { id: "action-1", actionType: "PRIORITIZE_COLLECTIONS", status: "APPROVED", amount: 4400000 },
    ]);
    vi.mocked(prisma.invoice.findMany).mockResolvedValue([
      { id: "inv-1", amount: 4400000, customerName: "Acme", status: "OVERDUE", businessId: "business-1" },
    ] as any);
    vi.mocked(prisma.invoice.updateMany).mockResolvedValue({ count: 1 } as any);

    const res = await POST(new Request("http://localhost/api/execute", {
      method: "POST",
      body: JSON.stringify({ strategyId: "strategy-1" }),
    }));
    const body = await res.json();

    // `after` is the real ledger; the optimistic number is separate and labelled.
    expect(body.after).toBe(10000000);
    expect(body.afterIfAllSettles).toBe(10000000 + 4400000);
    expect(body.pendingSettlementAmount).toBe(4400000);
  });

  it("a reschedule that moves nothing is FAILED, not COMPLETED", async () => {
    const actions = [
      { id: "action-1", actionType: "RESCHEDULE_PAYOUT", status: "APPROVED", amount: 5500000, targetPayoutId: "missing" },
    ];
    installStrategy(actions);
    await installDecision("APPROVED", actions);
    // No matching payout exists.
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: any) =>
      fn({
        payout: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
        transaction: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
      })) as any);

    const res = await POST(new Request("http://localhost/api/execute", {
      method: "POST",
      body: JSON.stringify({ strategyId: "strategy-1" }),
    }));
    const body = await res.json();

    expect(body.steps[0].status).toBe("FAILED");
    expect(body.executionOutcome).toBe("NOT_EXECUTED");
  });

  it("PART 31: an unknown execution result leaves the decision APPROVED, not EXECUTED or NOT_EXECUTED", async () => {
    const actions = [
      { id: "action-1", actionType: "RESCHEDULE_PAYOUT", status: "APPROVED", amount: 5500000, targetPayoutId: "p1" },
    ];
    installStrategy(actions);
    const decision = await installDecision("APPROVED", actions);
    // The LEDGER WRITE times out: we genuinely do not know whether it landed.
    // Scoped to the payout lookup rather than failing every transaction - the
    // decision status write is a separate transaction and must still succeed,
    // otherwise the test would be simulating a total database outage instead of
    // one ambiguous operation.
    vi.mocked(prisma.$transaction).mockImplementation((async (arg: any) => {
      if (typeof arg !== "function") return arg;
      return arg({
        ...prisma,
        payout: {
          findFirst: async () => {
            throw new Error("ETIMEDOUT contacting database");
          },
          update: vi.fn(),
        },
      });
    }) as any);

    const res = await POST(new Request("http://localhost/api/execute", {
      method: "POST",
      body: JSON.stringify({ strategyId: "strategy-1" }),
    }));
    const body = await res.json();

    expect(body.steps[0].status).toBe("EXECUTION_UNKNOWN");
    expect(body.executionOutcome).toBe("EXECUTION_UNKNOWN");
    expect(body.requiresManualVerification).toBe(true);
    // PRINCIPLE 10: unknown is neither success nor failure.
    expect(decision.status).toBe("APPROVED");
    expect(decision.executionSnapshot.outcome).toBe("EXECUTION_UNKNOWN");
  });

  it("PART 7: execution is refused when live cash has drifted from the simulation baseline", async () => {
    const actions = [{ id: "action-1", actionType: "PAUSE_EXPENSE", status: "APPROVED", amount: 1500000 }];
    installStrategy(actions, 10000000);
    const decision = await installDecision("APPROVED", actions);
    // Live cash is now 50% below the figure the strategy was simulated against.
    vi.mocked(prisma.business.findUnique).mockResolvedValue({ id: "business-1", currentCash: 5000000 } as any);

    const res = await POST(new Request("http://localhost/api/execute", {
      method: "POST",
      body: JSON.stringify({ strategyId: "strategy-1" }),
    }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("STATE_DRIFT_DETECTED");
    expect(decision.status).toBe("NOT_EXECUTED");
  });

  it("PART 3: a REJECTED action can never be executed", async () => {
    const actions = [
      { id: "action-1", actionType: "PAUSE_EXPENSE", status: "REJECTED", amount: 1500000 },
    ];
    installStrategy(actions);
    await installDecision("APPROVED", actions);

    const res = await POST(new Request("http://localhost/api/execute", {
      method: "POST",
      body: JSON.stringify({ strategyId: "strategy-1" }),
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("REJECTED_ACTION_EXECUTION");
  });

  it("PART 18: a zero or negative action amount is refused as tampering", async () => {
    const actions = [
      { id: "action-1", actionType: "PAUSE_EXPENSE", status: "APPROVED", amount: 0 },
    ];
    installStrategy(actions);
    await installDecision("APPROVED", actions);

    const res = await POST(new Request("http://localhost/api/execute", {
      method: "POST",
      body: JSON.stringify({ strategyId: "strategy-1" }),
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("PARAMETER_TAMPERING");
  });

  it("PART 23: a strategy belonging to another tenant is not found", async () => {
    await installDecision("APPROVED", []);
    let capturedWhere: any = null;
    vi.mocked(prisma.business.findUnique).mockResolvedValue({ id: "business-1", currentCash: 10000000 } as any);
    vi.mocked(prisma.strategy.findFirst).mockImplementation((async (args: any) => {
      capturedWhere = args.where;
      return null;
    }) as any);

    const res = await POST(new Request("http://localhost/api/execute", {
      method: "POST",
      body: JSON.stringify({ strategyId: "someone-elses-strategy" }),
    }));



    expect(res.status).toBe(404);
    // Tenant scoping is in the query, not applied after the fact.
    expect(capturedWhere.businessId).toBe("business-1");
  });
});
