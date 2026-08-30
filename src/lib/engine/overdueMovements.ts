import type { DailyMovement } from "./forecast";

/**
 * What to do with a committed movement whose date has already passed.
 *
 * `buildForecast` walks days 1..N from today and matches movements by exact
 * date, so anything dated before today matches no day and is silently dropped.
 * On a real ledger that is not a rounding detail: an overdue payroll and an
 * overdue vendor payout simply vanished from the projection.
 *
 * The correct treatment is ASYMMETRIC, because the two directions carry
 * opposite risk.
 *
 * OUTFLOWS are carried forward. An obligation past its due date has not gone
 * away — if anything it is more urgent, and the money is still owed. Dropping
 * it understates committed spending and makes the business look better off than
 * it is. That is the same direction of error as the `Math.max` liquidity bug,
 * and it is the direction that gets a company into trouble.
 *
 * INFLOWS are NOT carried forward. Rolling an overdue receivable into the
 * projection would assume late money arrives, which overstates cash on exactly
 * the invoices least likely to pay. Absence of payment is evidence, and the
 * conservative reading is that an overdue inflow is not committed cash. It is
 * reported separately instead, so the operator can see the receivable rather
 * than have the forecast quietly bank it.
 *
 * Neither branch invents anything: an overdue outflow keeps its own amount, and
 * an overdue inflow is described rather than assumed.
 */

export interface OverdueSplit {
  /** Movements the forecast should model, with overdue outflows pulled to day 1. */
  movements: DailyMovement[];
  /** Overdue outflows that were carried forward, in paise. */
  carriedOutflows: number;
  /** Overdue inflows deliberately NOT counted as arriving, in paise. */
  uncountedInflows: number;
  /** How many movements were overdue at all. */
  overdueCount: number;
}

/** Start of the UTC day, matching how buildForecast buckets. */
function startOfUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Reclassify movements that are already overdue.
 *
 * `asOf` is normally today. Day 1 of the forecast is the day AFTER it, which is
 * where carried outflows land — the earliest point the projection actually
 * models, and the soonest an unpaid obligation could still be settled.
 */
export function reconcileOverdueMovements(
  movements: DailyMovement[],
  asOf: Date = new Date()
): OverdueSplit {
  const todayUtc = startOfUtcDay(asOf);
  const dayOne = new Date(todayUtc + 24 * 60 * 60 * 1000);

  const out: DailyMovement[] = [];
  let carriedOutflows = 0;
  let uncountedInflows = 0;
  let overdueCount = 0;

  for (const m of movements) {
    if (startOfUtcDay(m.date) > todayUtc) {
      out.push(m);
      continue;
    }

    overdueCount++;

    const outflows = m.outflows ?? 0;
    const inflows = m.inflows ?? 0;

    // The inflow half is dropped, and counted so it can be reported rather than
    // silently discarded the way it was before.
    if (inflows > 0) uncountedInflows += inflows;

    if (outflows > 0) {
      carriedOutflows += outflows;
      out.push({
        ...m,
        date: dayOne,
        inflows: 0,
        outflows,
        description: m.description
          ? `${m.description} (overdue, still owed)`
          : "Overdue obligation, still owed",
      });
    }
  }

  return { movements: out, carriedOutflows, uncountedInflows, overdueCount };
}
