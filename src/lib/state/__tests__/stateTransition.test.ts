import { describe, it, expect } from "vitest";
import {
  classifyStateTransition,
  combineFreshness,
  type VersionedState,
  type StateTransitionVerdict,
} from "../stateTransition";
import { computeFinancialState, type FinancialStateInputs } from "../financialState";
import {
  classifyStaleness,
  computeContextFingerprint,
  type StalenessClassification,
  type FreshnessVerdict,
  type DecisionContext,
} from "@/lib/engine/strategyFreshness";
import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";

const TODAY = new Date("2026-09-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(TODAY.getTime() + days * DAY);

function state(overrides: Partial<FinancialStateInputs> = {}, version = 1): VersionedState {
  return {
    stateVersion: version,
    snapshot: computeFinancialState({
      currentCash: 1000000_00,
      requiredBuffer: 700000_00,
      today: TODAY,
      transactions: [],
      invoices: [],
      payouts: [],
      ...overrides,
    }),
  };
}

const invoice = (id: string, amount: number, status = "PENDING") => ({
  id,
  amount,
  status,
  dueDate: at(5),
});

describe("classifyStateTransition", () => {
  it("is NOT_TRACKED - not UNKNOWN - when the decision recorded no state", () => {
    // Blocking here would take the product down the moment this shipped.
    const v = classifyStateTransition(null, state());
    expect(v.classification).toBe("NOT_TRACKED");
    expect(v.blocksExecution).toBe(false);
  });

  it("is UNKNOWN when a recorded state can no longer be read", () => {
    const v = classifyStateTransition(state(), null);
    expect(v.classification).toBe("UNKNOWN");
    expect(v.blocksExecution).toBe(true);
  });

  it("is NO_CHANGE for an identical state", () => {
    const v = classifyStateTransition(state({}, 1), state({}, 2));
    expect(v.classification).toBe("NO_CHANGE");
    expect(v.blocksExecution).toBe(false);
  });

  it("is NO_CHANGE when only the clock moved", () => {
    const v = classifyStateTransition(
      state({ today: TODAY }, 1),
      state({ today: new Date(TODAY.getTime() + 6 * 36e5) }, 1)
    );
    expect(v.classification).toBe("NO_CHANGE");
  });

  it("calls a small cash move MINOR and a large one MATERIAL", () => {
    const base = 1000000_00;
    const small = classifyStateTransition(
      state({ currentCash: base }),
      state({ currentCash: base + 100 })
    );
    const large = classifyStateTransition(
      state({ currentCash: base }),
      state({ currentCash: Math.round(base * 0.8) })
    );

    expect(small.classification).toBe("MINOR_CHANGE");
    expect(small.blocksExecution).toBe(false);
    expect(large.classification).toBe("MATERIAL_CHANGE");
    expect(large.blocksExecution).toBe(true);
  });

  it("uses the same drift threshold as the decision-context check", () => {
    const base = 1000000_00;
    const justOver = Math.round(base * (1 + FINANCIAL_CONFIG.EXECUTION_DRIFT_THRESHOLD + 0.01));
    const justUnder = Math.round(base * (1 + FINANCIAL_CONFIG.EXECUTION_DRIFT_THRESHOLD - 0.01));

    expect(
      classifyStateTransition(state({ currentCash: base }), state({ currentCash: justOver }))
        .classification
    ).toBe("MATERIAL_CHANGE");
    expect(
      classifyStateTransition(state({ currentCash: base }), state({ currentCash: justUnder }))
        .classification
    ).toBe("MINOR_CHANGE");
  });

  it("treats the obligation count moving at all as material", () => {
    const v = classifyStateTransition(
      state(),
      state({
        payouts: [
          {
            id: "p1",
            amount: 1_00,
            scheduledDate: at(3),
            status: "SCHEDULED",
            vendor: "V",
            criticality: "LOW",
          },
        ],
      })
    );
    expect(v.classification).toBe("MATERIAL_CHANGE");
    expect(v.changes.map((c) => c.field)).toContain("activeCommitments");
  });

  it("treats a risk-state move as material", () => {
    const v = classifyStateTransition(
      state({ currentCash: 1000000_00, requiredBuffer: 100_00 }),
      state({ currentCash: 1000000_00, requiredBuffer: 2000000_00 })
    );
    expect(v.classification).toBe("MATERIAL_CHANGE");
    expect(v.changes.map((c) => c.field)).toContain("riskState");
  });

  it("is UNKNOWN when either side was built from incomplete inputs", () => {
    const v = classifyStateTransition(state(), state({ incomplete: true }));
    expect(v.classification).toBe("UNKNOWN");
    expect(v.blocksExecution).toBe(true);
  });

  it("treats a newly detected cross-source conflict as material (spec §14)", () => {
    const v = classifyStateTransition(
      state({ reconciliation: { total: 2, reconciled: 2, conflicts: 0, missing: 0, unknown: 0 } }),
      state({ reconciliation: { total: 2, reconciled: 1, conflicts: 1, missing: 0, unknown: 0 } })
    );
    expect(v.classification).toBe("MATERIAL_CHANGE");
    expect(v.changes.map((c) => c.field)).toContain("reconciliation.conflicts");
  });

  it("treats a newly missed expected payment as material (spec §17)", () => {
    const v = classifyStateTransition(
      state({ reconciliation: { total: 2, reconciled: 2, conflicts: 0, missing: 0, unknown: 0 } }),
      state({ reconciliation: { total: 2, reconciled: 1, conflicts: 0, missing: 1, unknown: 0 } })
    );
    expect(v.classification).toBe("MATERIAL_CHANGE");
    expect(v.changes.map((c) => c.field)).toContain("reconciliation.missing");
  });

  it("does not raise an alarm when conflicts are RESOLVED", () => {
    const v = classifyStateTransition(
      state({ reconciliation: { total: 2, reconciled: 1, conflicts: 1, missing: 0, unknown: 0 } }),
      state({ reconciliation: { total: 2, reconciled: 2, conflicts: 0, missing: 0, unknown: 0 } })
    );
    expect(v.changes.map((c) => c.field)).not.toContain("reconciliation.conflicts");
  });

  it("reports UNKNOWN rather than assuming safety when a hash change is unexplained", () => {
    const from = state();
    const to = state();
    // Force a hash difference nothing in the diff can attribute.
    const tampered: VersionedState = {
      stateVersion: 2,
      snapshot: { ...to.snapshot, stateHash: "unattributable" },
    };
    const v = classifyStateTransition(from, tampered);
    expect(v.classification).toBe("UNKNOWN");
    expect(v.blocksExecution).toBe(true);
  });

  it("carries both version numbers for the audit trail", () => {
    const v = classifyStateTransition(state({}, 7), state({ currentCash: 1 }, 9));
    expect(v.fromVersion).toBe(7);
    expect(v.toVersion).toBe(9);
  });
});

describe("why the state check must not REPLACE the fingerprint", () => {
  it("cannot see offsetting record changes that leave every aggregate identical", () => {
    // One ₹5L invoice is replaced by a DIFFERENT ₹5L invoice. Receivables,
    // cash, payables, flows and commitments are all unchanged, so the state is
    // byte-identical - yet the records a strategy would act on have changed
    // completely. This is precisely the blind spot the fingerprint covers.
    const before = state({ invoices: [invoice("inv_old", 500000_00)] });
    const after = state({ invoices: [invoice("inv_new", 500000_00)] }, 2);

    const stateVerdict = classifyStateTransition(before, after);
    expect(stateVerdict.classification).toBe("NO_CHANGE");
    expect(before.snapshot.stateHash).toBe(after.snapshot.stateHash);

    // The record-level fingerprint is not fooled.
    const fingerprintVerdict = classifyStaleness(
      computeContextFingerprint(context([movement("t_old", 500000_00)])),
      computeContextFingerprint(context([movement("t_new", 500000_00)]))
    );
    expect(fingerprintVerdict.classification).toBe("MATERIAL_CHANGE");

    // Combined, the conservative answer wins - which is the whole design.
    const combined = combineFreshness(fingerprintVerdict, stateVerdict);
    expect(combined.classification).toBe("MATERIAL_CHANGE");
    expect(combined.blocksExecution).toBe(true);
  });
});

function movement(id: string, amount: number) {
  return { id, amount, type: "INFLOW" as const, status: "PENDING", date: "2026-09-06" };
}

function context(movements: ReturnType<typeof movement>[]): DecisionContext {
  return {
    strategyType: "RECOVER_ONLY",
    startingCash: 1000000_00,
    requiredBuffer: 700000_00,
    forecastHorizonDays: FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS,
    movements,
    obligations: [],
    actionTargets: [],
    engineVersion: FINANCIAL_CONFIG.ENGINE_VERSION,
    scoringConfigVersion: FINANCIAL_CONFIG.SCORING_CONFIG_VERSION,
    liquidityConfigVersion: FINANCIAL_CONFIG.LIQUIDITY_CONFIG_VERSION,
  };
}

describe("combineFreshness - the safety property", () => {
  const CLASSES: StalenessClassification[] = [
    "NO_CHANGE",
    "MINOR_CHANGE",
    "MATERIAL_CHANGE",
    "UNKNOWN",
  ];
  const RANK: Record<StalenessClassification, number> = {
    NO_CHANGE: 0,
    MINOR_CHANGE: 1,
    MATERIAL_CHANGE: 2,
    UNKNOWN: 3,
  };

  function fingerprintVerdict(c: StalenessClassification): FreshnessVerdict {
    return {
      classification: c,
      fresh: c === "NO_CHANGE" || c === "MINOR_CHANGE",
      blocksExecution: c === "MATERIAL_CHANGE" || c === "UNKNOWN",
      changes: [],
      decisionFingerprint: "abc",
      currentFingerprint: c === "NO_CHANGE" ? "abc" : "def",
    };
  }

  function stateVerdict(c: StalenessClassification): StateTransitionVerdict {
    return {
      classification: c,
      changes: [],
      fromVersion: 1,
      toVersion: 2,
      blocksExecution: c === "MATERIAL_CHANGE" || c === "UNKNOWN",
    };
  }

  it("never returns a LESS severe verdict than the fingerprint alone", () => {
    // The property that makes shipping this safe: all sixteen combinations.
    for (const f of CLASSES) {
      for (const s of CLASSES) {
        const combined = combineFreshness(fingerprintVerdict(f), stateVerdict(s));
        expect(
          RANK[combined.classification],
          `fingerprint=${f} state=${s} produced ${combined.classification}`
        ).toBeGreaterThanOrEqual(RANK[f]);
      }
    }
  });

  it("never unblocks something the fingerprint blocked", () => {
    for (const f of CLASSES) {
      for (const s of CLASSES) {
        const fv = fingerprintVerdict(f);
        const combined = combineFreshness(fv, stateVerdict(s));
        if (fv.blocksExecution) expect(combined.blocksExecution).toBe(true);
      }
    }
  });

  it("takes the more severe of the two", () => {
    for (const f of CLASSES) {
      for (const s of CLASSES) {
        const combined = combineFreshness(fingerprintVerdict(f), stateVerdict(s));
        expect(RANK[combined.classification]).toBe(Math.max(RANK[f], RANK[s]));
      }
    }
  });

  it("passes the fingerprint verdict through untouched when NOT_TRACKED", () => {
    for (const f of CLASSES) {
      const fv = fingerprintVerdict(f);
      const combined = combineFreshness(fv, {
        classification: "NOT_TRACKED",
        changes: [],
        fromVersion: null,
        toVersion: null,
        blocksExecution: false,
      });
      // Identity, not merely equivalence: no existing decision changes at all.
      expect(combined).toBe(fv);
    }
  });

  it("keeps both halves' reasons so an explanation can cite the right one", () => {
    const fv = fingerprintVerdict("MINOR_CHANGE");
    fv.changes = [
      { field: "startingCash", severity: "MINOR", from: 1, to: 2, reason: "cash nudged" },
    ];
    const sv = stateVerdict("MATERIAL_CHANGE");
    sv.changes = [
      { field: "riskState", severity: "MATERIAL", from: "OK", to: "AT_RISK", reason: "risk rose" },
    ];

    const combined = combineFreshness(fv, sv);
    expect(combined.changes.map((c) => c.field)).toEqual(["startingCash", "riskState"]);
  });

  it("can tighten a fingerprint-clean verdict when the state moved materially", () => {
    const combined = combineFreshness(
      fingerprintVerdict("NO_CHANGE"),
      stateVerdict("MATERIAL_CHANGE")
    );
    expect(combined.classification).toBe("MATERIAL_CHANGE");
    expect(combined.blocksExecution).toBe(true);
    expect(combined.fresh).toBe(false);
  });
});
