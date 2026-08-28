import { DailyMovement, transactionsToMovements } from "@/lib/engine/forecast";
import { sourceReliability } from "@/lib/evidence/confidence";
import type { TransactionRecord } from "@/lib/db/records";

/**
 * Phase 8 - the ForecastEvent pipeline (spec §22, §23).
 *
 * Every forecast in this system goes rows -> `transactionsToMovements` ->
 * `buildForecast`. That single seam is where the unified brain has to enter,
 * and this module is that seam:
 *
 *     transactions ──► ForecastEvent[] ──► DailyMovement[] ──► buildForecast
 *                          ▲
 *                          └── P9 adjusts expectedDate here, from behaviour
 *
 * ## What this phase deliberately does NOT do
 *
 * It does not change a single number. `expectedDate` is set equal to
 * `contractualDate`, the uncertainty band is collapsed onto it, and probability
 * is 1 - because the evidence that would justify moving them (customer payment
 * behaviour, communications) does not exist yet. Manufacturing a spread now
 * would be exactly the fake precision §64 forbids.
 *
 * The parity tests assert that the event pipeline produces movements STRICTLY
 * equal to the current path for every input shape. That is the deliverable: a
 * proven-identical pipe, ready for P9 to change what flows through it.
 *
 * ## Where the divergence will come from
 *
 * `applyExpectedTiming` is the extension point. Today it is the identity
 * function. When the behaviour model lands it will move `expectedDate` off
 * `contractualDate`, widen [earliestDate, latestDate], and record why in
 * `timingBasis` - at which point the forecast genuinely changes and the config
 * version must be bumped (see FORECAST_EVENT_PIPELINE below).
 */

/** A single expected future cash movement, with its provenance (spec §22). */
export interface ForecastEvent {
  /** Stable identity: the source record this event came from. */
  id: string;
  /**
   * UNKNOWN is not a placeholder - it is the faithful reading of a transaction
   * whose type the ledger does not recognise. The existing mapping gives such a
   * row zero inflow AND zero outflow, i.e. it contributes nothing. Collapsing
   * it to OUTFLOW instead would invent an outflow that does not exist, and the
   * parity suite catches exactly that.
   */
  kind: "INFLOW" | "OUTFLOW" | "UNKNOWN";
  /** Paise. */
  amount: number;
  currency: string;

  /**
   * The date the source states: an invoice due date, a scheduled payout date.
   * A contractual fact, never a prediction.
   */
  contractualDate: Date;
  /**
   * When the money is actually expected to move. Equal to `contractualDate`
   * until the behaviour model (P9) has grounds to move it.
   */
  expectedDate: Date;
  /** Uncertainty band. Collapsed onto `expectedDate` until P9. */
  earliestDate: Date;
  latestDate: Date;

  /** Probability the movement occurs at all, in [0,1]. */
  probability: number;

  sourceType: string;
  /** Source reliability in [0,1], from the Phase 3 model. */
  sourceConfidence: number;
  /** Evidence backing this event. Empty until claims are populated (B-2). */
  evidenceIds: string[];

  /** Source lifecycle status, carried through for downstream filtering. */
  status: string;
  /** Free-text description from the source, if any. */
  description: string | null;

  /**
   * Why `expectedDate` differs from `contractualDate`. Empty whenever the two
   * agree, so a non-empty basis is always a real, explainable adjustment (§58).
   */
  timingBasis: string[];
}

/**
 * Master switch for the event pipeline.
 *
 * OFF by default. While the pipeline is provably output-identical (see the
 * parity tests) this flag is a no-op either way, which is the point: the seam
 * ships and is exercised before it can affect a number.
 *
 * ⚠️ When P9 makes `applyExpectedTiming` move dates, flipping this ON changes
 * forecast output. At that moment `SCORING_CONFIG_VERSION` /
 * `LIQUIDITY_CONFIG_VERSION` must be bumped, so every strategy generated under
 * the old pipeline is correctly classified MATERIAL_CHANGE by the freshness
 * gate instead of silently surviving into a different forecast.
 */
export const FORECAST_EVENT_PIPELINE = {
  enabled: false,
} as const;

/** Transactions the ledger has settled or abandoned are not future movements. */
function isForecastable(t: { status: string }): boolean {
  // Mirrors transactionsToMovements exactly: FAILED is not a committed inflow.
  return t.status !== "FAILED";
}

/**
 * Turn ledger transactions into forecast events.
 *
 * The mapping is deliberately lossless in both directions for the fields the
 * forecast consumes, so the round-trip through events cannot perturb output.
 */
export function transactionsToForecastEvents(
  transactions: TransactionRecord[]
): ForecastEvent[] {
  return transactions.filter(isForecastable).map((t) => {
    const contractualDate = new Date(t.expectedDate);
    const kind: ForecastEvent["kind"] =
      t.type === "INFLOW" ? "INFLOW" : t.type === "OUTFLOW" ? "OUTFLOW" : "UNKNOWN";

    const base: ForecastEvent = {
      id: t.id,
      kind,
      amount: t.amount,
      currency: "INR",
      contractualDate,
      // Until there is evidence to say otherwise, the contractual date IS the
      // expectation. Not a guess dressed up as one.
      expectedDate: contractualDate,
      earliestDate: contractualDate,
      latestDate: contractualDate,
      probability: 1,
      sourceType: "BANK",
      sourceConfidence: sourceReliability("BANK"),
      evidenceIds: [],
      status: t.status,
      description: t.description ?? null,
      timingBasis: [],
    };

    return applyExpectedTiming(base);
  });
}

/**
 * The extension point where behavioural intelligence will move an event's
 * expected timing away from its contractual date (spec §23, §24).
 *
 * Today: the identity function. It exists now so the pipeline has one place to
 * change in P9, rather than the change being threaded through the adapter.
 */
export function applyExpectedTiming(event: ForecastEvent): ForecastEvent {
  return event;
}

/**
 * Collapse forecast events back into the day-bucketed movements
 * `buildForecast` consumes.
 *
 * Uses `expectedDate` - which is what makes P9's adjustment flow through to the
 * forecast automatically once it starts differing from `contractualDate`.
 *
 * The returned objects carry EXACTLY the keys `transactionsToMovements`
 * produces, and in the same order, because the parity tests compare them
 * strictly. Adding a field here without adding it there breaks parity, which is
 * the intended alarm.
 */
export function forecastEventsToMovements(events: ForecastEvent[]): DailyMovement[] {
  return events.map((e) => ({
    date: e.expectedDate,
    // An UNKNOWN kind lands 0 in both, matching the existing mapping exactly.
    inflows: e.kind === "INFLOW" ? e.amount : 0,
    outflows: e.kind === "OUTFLOW" ? e.amount : 0,
    description: e.description || undefined,
    transactionId: e.id,
  }));
}

export interface BuildMovementsOptions {
  /** Override the master switch, for tests and for a staged rollout. */
  useEventPipeline?: boolean;
}

/**
 * The single entry point call sites should use.
 *
 * With the pipeline off (the default) this calls `transactionsToMovements`
 * directly - the identical code path the product has always run. With it on,
 * the same movements are produced via forecast events.
 */
export function buildMovements(
  transactions: TransactionRecord[],
  options: BuildMovementsOptions = {}
): DailyMovement[] {
  const useEvents = options.useEventPipeline ?? FORECAST_EVENT_PIPELINE.enabled;

  if (!useEvents) {
    return transactionsToMovements(
      transactions.map((t) => ({
        id: t.id,
        amount: t.amount,
        type: t.type as "INFLOW" | "OUTFLOW",
        status: t.status,
        expectedDate: new Date(t.expectedDate),
        description: t.description ?? null,
      }))
    );
  }

  return forecastEventsToMovements(transactionsToForecastEvents(transactions));
}
