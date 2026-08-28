import { buildDecisionContext } from "./decisionContext";
import { classifyStaleness, FreshnessVerdict, FingerprintDetail } from "./strategyFreshness";
import { appendDecisionEvent } from "./decisionStateMachine";
import { DecisionEventType, Prisma } from "../../../generated/prisma/client";
import { toSnapshot } from "@/lib/state/store";
import {
  classifyStateTransition,
  combineFreshness,
  type StateTransitionVerdict,
  type VersionedState,
} from "@/lib/state/stateTransition";
import {
  checkDecisionValidity,
  tightenForValidity,
  type DecisionValidityVerdict,
} from "./decisionValidity";
import { currentForecastVersion } from "@/lib/forecast/forecastEvent";

/**
 * Server-side strategy freshness gate (PART 11 / PART 14).
 *
 * Runs at BOTH boundaries:
 *
 *   approval  - so a human is never asked to authorise a recommendation that no
 *               longer matches reality
 *   execution - so nothing moves money on a plan that went stale between the
 *               click and the request, which is exactly the window an attacker
 *               or a slow user opens
 *
 * The frontend does not participate. It cannot be trusted to have re-checked,
 * and a replayed request would bypass it entirely.
 */
export interface FreshnessGateResult {
  verdict: FreshnessVerdict;
  /** True when the caller must refuse the operation. */
  blocked: boolean;
  /**
   * Phase 7. The financial-state half of the check, reported separately so an
   * explanation can say which half fired. `NOT_TRACKED` whenever the decision
   * recorded no state version - which is every decision made before Phase 7.
   */
  stateVerdict: StateTransitionVerdict;
  /**
   * Phase 11. The method-and-age half, reported separately like the state half.
   * `UNTRACKED` whenever the decision recorded neither a forecast method nor an
   * expiry - which is every decision made before Phase 11.
   */
  validityVerdict: DecisionValidityVerdict;
}

export async function checkStrategyFreshness(
  client: Prisma.TransactionClient,
  params: {
    businessId: string;
    strategyId: string;
    strategyType: string;
    actions: { type: string; amount: number; targetPayoutId?: string | null; targetTransactionId?: string | null }[];
    today?: Date;
  }
): Promise<FreshnessGateResult> {
  const decision = client?.decision
    ? await client.decision.findFirst({ where: { strategyId: params.strategyId } })
    : null;

  const current = await buildDecisionContext(client, params.businessId, {
    strategyType: params.strategyType,
    actions: params.actions,
    today: params.today,
  });

  const fingerprintVerdict = classifyStaleness(
    (decision?.fingerprintDetail as unknown as FingerprintDetail | null) ?? null,
    current
  );

  // Phase 7: the financial-state half, layered ON TOP of the fingerprint and
  // never in place of it. A state is an aggregate view, so it cannot see
  // offsetting record-level changes the fingerprint catches; combining takes
  // the more conservative verdict, so this can only ever tighten the gate.
  const stateVerdict = await checkStateFreshness(client, params.businessId, decision);

  // Phase 11: the two axes neither of the above can see - the forecasting
  // METHOD changing underneath an unchanged set of facts, and plain AGE. Both
  // read from columns that are null on every pre-Phase-11 decision, so they
  // contribute nothing until something starts recording them.
  const validityVerdict = checkDecisionValidity(decision, {
    now: params.today,
    currentForecastVersion: currentForecastVersion(),
  });

  const verdict = tightenForValidity(
    combineFreshness(fingerprintVerdict, stateVerdict),
    validityVerdict
  );

  return { verdict, blocked: verdict.blocksExecution, stateVerdict, validityVerdict };
}

/**
 * Compare the state a decision was generated against with the current one.
 *
 * Returns NOT_TRACKED - which contributes nothing to the combined verdict -
 * whenever the decision carries no `financialStateVersion`. That is the case for
 * every decision written before Phase 7, so no existing recommendation changes
 * behaviour, and no extra query is issued for one either.
 */
async function checkStateFreshness(
  client: Prisma.TransactionClient,
  businessId: string,
  decision: { financialStateVersion?: number | null } | null
): Promise<StateTransitionVerdict> {
  const recordedVersion = decision?.financialStateVersion ?? null;
  if (recordedVersion === null) {
    return {
      classification: "NOT_TRACKED",
      changes: [],
      fromVersion: null,
      toVersion: null,
      blocksExecution: false,
    };
  }

  // Optional-chained like `client.decision` above: engine tests supply partial
  // clients, and an absent table must degrade rather than throw.
  if (!client?.financialState) {
    return {
      classification: "UNKNOWN",
      changes: [
        {
          field: "financialState",
          severity: "UNKNOWN",
          from: recordedVersion,
          to: null,
          reason:
            "This decision recorded a financial state that cannot be read back, so it cannot be verified.",
        },
      ],
      fromVersion: recordedVersion,
      toVersion: null,
      blocksExecution: true,
    };
  }

  const [recorded, latest] = await Promise.all([
    client.financialState.findFirst({
      where: { businessId, stateVersion: recordedVersion },
    }),
    client.financialState.findFirst({
      where: { businessId },
      orderBy: { stateVersion: "desc" },
    }),
  ]);

  const from: VersionedState | null = recorded
    ? { stateVersion: recorded.stateVersion, snapshot: toSnapshot(recorded) }
    : null;
  const to: VersionedState | null = latest
    ? { stateVersion: latest.stateVersion, snapshot: toSnapshot(latest) }
    : null;

  // `from` null here means the decision named a version that is gone - a real
  // problem, not an untracked decision. classifyStateTransition would read a
  // null `from` as NOT_TRACKED, so say UNKNOWN explicitly instead.
  if (!from) {
    return {
      classification: "UNKNOWN",
      changes: [
        {
          field: "financialState",
          severity: "UNKNOWN",
          from: recordedVersion,
          to: to?.stateVersion ?? null,
          reason:
            "The financial state this decision was generated against is no longer on record, so it cannot be verified.",
        },
      ],
      fromVersion: recordedVersion,
      toVersion: to?.stateVersion ?? null,
      blocksExecution: true,
    };
  }

  return classifyStateTransition(from, to);
}

/**
 * Records that a strategy was refused on freshness grounds.
 *
 * Deliberately an event rather than a status change: being blocked is something
 * that HAPPENED to the decision, not a new state for it. Writing STALE into
 * Decision.status would conflate "what the business decided" with "what we
 * refused to do about it", which Phase 14 established as separate concepts.
 */
export async function recordStaleBlock(
  client: Prisma.TransactionClient,
  decision: { id: string; businessId: string },
  verdict: FreshnessVerdict,
  actorId?: string | null
): Promise<void> {
  await appendDecisionEvent(client, decision, {
    eventType: DecisionEventType.STALE_BLOCKED,
    actorType: "SYSTEM",
    actorId: actorId ?? null,
    metadata: {
      classification: verdict.classification,
      decisionFingerprint: verdict.decisionFingerprint,
      currentFingerprint: verdict.currentFingerprint,
      changes: verdict.changes.slice(0, 20),
    },
  });
}

/** Human-readable summary of why a strategy was refused. */
export function describeStaleness(verdict: FreshnessVerdict): string {
  if (verdict.classification === "UNKNOWN") {
    // PART 12: a strategy with no stored fingerprint predates Phase 15. It is
    // never given a fabricated fingerprint and never executed - it is
    // regenerated. Say so precisely rather than reporting a generic unknown.
    const noFingerprint = verdict.decisionFingerprint === null;
    return noFingerprint
      ? "This strategy was generated by an older engine version and carries no decision-time fingerprint. It cannot be verified against current financial reality, so it cannot be executed. Regenerate the recommendation."
      : "The financial context could not be verified against the one this strategy was simulated from. Regenerate the strategy.";
  }
  const material = verdict.changes.filter((c) => c.severity === "MATERIAL");
  const lead = material[0]?.reason ?? "The underlying financial data has changed materially.";
  const more = material.length > 1 ? ` (and ${material.length - 1} further material change(s))` : "";
  return `${lead}${more} Regenerate the strategy before executing.`;
}
