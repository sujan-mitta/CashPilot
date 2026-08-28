import { DailyMovement } from "@/lib/engine/forecast";
import { logger } from "@/lib/observability";
import { errorMessage } from "@/lib/errors";
import { loadPaymentBehavior, type BehaviorClient } from "@/lib/behavior/behaviorStore";
import type { TransactionRecord } from "@/lib/db/records";
import { buildMovements, FORECAST_EVENT_PIPELINE } from "./forecastEvent";

/**
 * B-9 - the one call every forecast site makes to turn transactions into
 * movements.
 *
 * This is the join between the two halves that were built separately: the
 * ForecastEvent pipeline (P8) and the behaviour model (P9/B-11). It exists so
 * that switching a call site over is a one-line change with no behavioural
 * risk, and so that turning the whole chain on is one flag rather than five
 * edits.
 *
 * Three properties, each tested:
 *
 *   1. **Disabled is free.** With the pipeline off this issues NO query and
 *      returns exactly what `transactionsToMovements` has always returned.
 *      Behaviour history is not read, so switching a call site costs nothing
 *      until someone decides otherwise.
 *
 *   2. **Enabled without history is identical.** Parity is proven in P8, and
 *      a counterparty with no usable history changes nothing (P9).
 *
 *   3. **A failure to read history is not a failure to forecast.** Behaviour is
 *      an enhancement; if the query throws, the forecast falls back to the
 *      contractual dates rather than failing. A forecast that is slightly less
 *      clever beats no forecast at all - and the fallback is logged, never
 *      silent.
 */

export interface MovementOptions {
  /** Override the master switch, for tests and staged rollout. */
  useEventPipeline?: boolean;
  /** Clock, for deciding which payment history counts as recent. */
  now?: Date;
}

/**
 * Build the day-bucketed movements a forecast consumes, applying payment
 * behaviour when it is enabled and there is enough history to justify it.
 */
export async function buildMovementsForBusiness(
  client: BehaviorClient,
  businessId: string,
  transactions: TransactionRecord[],
  options: MovementOptions = {}
): Promise<DailyMovement[]> {
  const useEvents = options.useEventPipeline ?? FORECAST_EVENT_PIPELINE.enabled;

  // The disabled path must not touch the database at all: a call site that
  // switches to this function should not acquire a new query as a side effect.
  if (!useEvents) {
    return buildMovements(transactions, { useEventPipeline: false });
  }

  try {
    const { byCounterparty } = await loadPaymentBehavior(client, businessId, { now: options.now });
    return buildMovements(transactions, {
      useEventPipeline: true,
      behaviorByCounterparty: byCounterparty,
    });
  } catch (error) {
    // Degrade to contractual dates. This is the same instinct the rest of the
    // engine follows: a missing input produces a stated, weaker answer rather
    // than an exception on the money path.
    logger.warn("Payment behaviour unavailable; forecasting on contractual dates", {
      businessId,
      error: errorMessage(error),
    });
    return buildMovements(transactions, { useEventPipeline: true });
  }
}
