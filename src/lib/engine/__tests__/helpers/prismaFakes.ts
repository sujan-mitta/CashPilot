import { vi } from "vitest";
import { buildDecisionContext } from "../../decisionContext";

/**
 * Shared in-memory fakes for the Phase 15 models.
 *
 * The route layer now touches ExecutionIntent, Decision and DecisionEvent on
 * every execution path, so a mock that omits them is not modelling the system
 * under test - it is modelling a system that cannot exist. These factories keep
 * the additions consistent across test files.
 */

export interface IntentStore {
  intents: any[];
}

/** Stateful ExecutionIntent model backed by an array. */
/**
 * Minimal Prisma `where` matcher.
 *
 * Supports plain equality and `{ in: [...] }`. The earlier version compared a
 * filter OBJECT against a scalar field with `===`, so any `{ in: [...] }` clause
 * matched nothing and a query that should have found rows quietly returned null.
 */
function matchesWhere(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    const actual = row?.[k];
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      const filter = v as Record<string, unknown>;
      if (Array.isArray(filter.in)) return (filter.in as unknown[]).includes(actual);
      if ("not" in filter) return actual !== filter.not;
      return true;
    }
    return actual === v;
  });
}

export function makeExecutionIntentFake(store: IntentStore) {
  let seq = 0;
  return {
    findUnique: vi.fn(async ({ where }: any) => {
      if (where.id) return store.intents.find((i) => i.id === where.id) ?? null;
      if (where.idempotencyKey)
        return store.intents.find((i) => i.idempotencyKey === where.idempotencyKey) ?? null;
      return null;
    }),
    findFirst: vi.fn(async ({ where }: any) =>
      store.intents.find((i) => matchesWhere(i, where)) ?? null
    ),
    findMany: vi.fn(async ({ where, select }: any) => {
      const rows = store.intents.filter((i) => {
        if (!where) return true;
        if (where.businessId && i.businessId !== where.businessId) return false;
        if (where.status && i.status !== where.status) return false;
        if (where.dispatchedAt?.lte && !(i.dispatchedAt && i.dispatchedAt <= where.dispatchedAt.lte))
          return false;
        return true;
      });
      return select ? rows.map((r) => ({ id: r.id })) : rows;
    }),
    create: vi.fn(async ({ data }: any) => {
      if (store.intents.some((i) => i.idempotencyKey === data.idempotencyKey)) {
        // Mirrors the real unique-constraint violation.
        throw new Error("Unique constraint failed on the fields: (`idempotencyKey`)");
      }
      const row = {
        id: `intent_${++seq}`,
        attempts: 0,
        externalRef: null,
        externalStatus: null,
        lastError: null,
        unknownReason: null,
        recordedAt: new Date(),
        dispatchedAt: null,
        resolvedAt: null,
        ...data,
      };
      store.intents.push(row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const i of store.intents) {
        if (where.id && i.id !== where.id) continue;
        if (where.status && i.status !== where.status) continue;
        const patch = { ...data };
        if (patch.attempts?.increment) {
          i.attempts = (i.attempts ?? 0) + patch.attempts.increment;
          delete patch.attempts;
        }
        Object.assign(i, patch);
        count++;
      }
      return { count };
    }),
  };
}

export interface DecisionStore {
  decisions: any[];
  events: any[];
}

/** Stateful Decision + DecisionEvent models backed by arrays. */
export function makeDecisionFakes(store: DecisionStore) {
  let seq = 0;
  const match = (d: any, where: any) =>
    Object.entries(where ?? {}).every(([k, v]) => {
      if (v && typeof v === "object" && "in" in (v as any)) {
        return ((v as any).in as any[]).includes(d[k]);
      }
      return d[k] === v;
    });

  return {
    decision: {
      findFirst: vi.fn(async ({ where }: any) => {
        const d = store.decisions.find((x) => match(x, where));
        return d ? { ...d } : null;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const d = store.decisions.find((x) => match(x, where));
        return d ? { ...d } : null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        store.decisions.filter((x) => match(x, where)).map((x) => ({ ...x }))
      ),
      count: vi.fn(async ({ where }: any) => store.decisions.filter((x) => match(x, where)).length),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `dec_${++seq}`, createdAt: new Date(), ...data };
        store.decisions.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const d = store.decisions.find((x) => match(x, where));
        if (d) Object.assign(d, data);
        return d ? { ...d } : null;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const d of store.decisions) {
          if (!match(d, where)) continue;
          Object.assign(d, data);
          count++;
        }
        return { count };
      }),
    },
    decisionEvent: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `ev_${store.events.length + 1}`, createdAt: new Date(), ...data };
        store.events.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        store.events.filter((e) => match(e, where))
      ),
    },
  };
}

/**
 * Seeds a Decision whose fingerprint matches the CURRENT world.
 *
 * Computed by calling the same builder the freshness gate uses, so the seeded
 * decision is genuinely fresh rather than fresh-by-assertion. A test that then
 * mutates the ledger will correctly observe staleness.
 */
export async function seedFreshDecision(
  client: any,
  store: DecisionStore,
  params: {
    businessId: string;
    strategyId: string;
    strategyType: string;
    actions: { type: string; amount: number; targetPayoutId?: string | null; targetTransactionId?: string | null }[];
    status?: string;
    today?: Date;
  }
) {
  const fingerprint = await buildDecisionContext(client, params.businessId, {
    strategyType: params.strategyType,
    actions: params.actions,
    today: params.today,
  });

  const row = {
    id: `dec_seed_${store.decisions.length + 1}`,
    businessId: params.businessId,
    strategyId: params.strategyId,
    status: params.status ?? "PRESENTED",
    engineVersion: "15.0.0",
    scoringConfigVersion: "15.0.0",
    liquidityConfigVersion: "15.0.0",
    outcomeRulesVersion: "15.0.0",
    createdAt: params.today ?? new Date(),
    contextFingerprint: fingerprint.fingerprint,
    fingerprintDetail: fingerprint,
    obligationSnapshot: [],
    outcomeMeasurementHorizonDays: 14,
    outcomePhase: "WINDOW_OPEN",
    baselineSnapshot: {},
    recommendedSnapshot: {},
    approvalSnapshot: null as any,
    executionSnapshot: null as any,
    reconciliationSnapshot: null as any,
    actualOutcome: null as any,
    outcomeMeasuredAt: null as any,
    finalOutcomeMeasuredAt: null as any,
  };
  store.decisions.push(row);
  return row;
}
