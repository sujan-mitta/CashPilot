import { settlementsSincePlan, type StandingData } from "@/components/WhereYouStand";

/**
 * Whether the plan currently on screen has been overtaken by money arriving.
 *
 * The lookup is the part worth isolating. `settlementsSincePlan` is a tested
 * timestamp comparison, but reaching it requires finding the right plan among
 * the cached ones — and if THAT is wrong, staleness silently never fires and
 * the completed steps stay reassuringly green forever. A failure of this shape
 * is invisible: nothing errors, the warning simply never appears.
 *
 * Every unknown resolves to "not stale", deliberately. A false staleness
 * warning trains people to ignore the true ones, which costs more than the
 * occasional missed one.
 */
export interface PlanLike {
  id: string;
  createdAt?: string;
}

export function isPlanStale(
  standing: Pick<StandingData, "received"> | null | undefined,
  plans: PlanLike[] | null | undefined,
  selectedPlanId: string | null | undefined
): boolean {
  if (!standing?.received?.length) return false;
  if (!plans?.length || !selectedPlanId) return false;

  const plan = plans.find((p) => p.id === selectedPlanId);
  // A selected id with no matching plan means the cache and the selection have
  // drifted apart. Saying nothing is right: we cannot know what the plan was
  // built from, so we cannot claim it is out of date.
  if (!plan?.createdAt) return false;

  return settlementsSincePlan(standing.received, plan.createdAt).length > 0;
}
