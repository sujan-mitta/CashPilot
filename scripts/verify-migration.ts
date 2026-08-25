import "dotenv/config";
import { Client } from "pg";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TABLE_ORDER, JOIN_TABLE } from "./migrationManifest";

/**
 * STEP 7 - financial integrity verification after migration.
 *
 * READ-ONLY. Every statement is a SELECT.
 *
 * Row counts alone are a weak check: they would pass even if every
 * idempotencyKey had been mangled. So this compares the actual VALUES that
 * carry financial meaning - the identifiers duplicate-execution protection
 * depends on, and the cash ledger itself - by recomputing a checksum over them
 * from the target and comparing it to the same checksum over the snapshot.
 *
 * Run against the TARGET after import:
 *   npm run db:verify
 */

const FILE = path.join(process.cwd(), "migration-snapshots", "cashpilot-snapshot.json");

/** Invariants asserted independently of the snapshot, from the Phase 20/21 audits. */
const EXPECTED = {
  businessId: "cmt4ncdm80000vsuk5q9crvax",
  currentCash: 144000000,
  ExecutionIntent: 18,
  ProcessedEvent: 1,
  WebhookDeliveryAttempt: 2,
  DecisionEvent: 78,
  AgentAction: 166,
  Strategy: 97,
  Decision: 97,
};

type Row = Record<string, unknown>;

/** Stable digest over the fields that carry financial identity. */
function financialDigest(intents: Row[]): string {
  const canonical = intents
    .map((i) => [i.id, i.idempotencyKey, i.obligationKey ?? "", i.externalRef ?? "", i.status, i.amount].join("|"))
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const snapshot = JSON.parse(fs.readFileSync(FILE, "utf8")) as {
    meta: { counts: Record<string, number>; totalRows: number };
    tables: Record<string, Row[]>;
  };

  const c = new Client({ connectionString: url });
  await c.connect();
  const who = await c.query(`SELECT current_database() AS db, version() AS v`);
  console.log(`  target: ${who.rows[0].db} (${String(who.rows[0].v).split(" ").slice(0, 2).join(" ")})\n`);

  const failures: string[] = [];
  const check = (label: string, actual: unknown, expected: unknown) => {
    const ok = actual === expected;
    if (!ok) failures.push(`${label}: got ${actual}, expected ${expected}`);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(38)} ${actual}${ok ? "" : ` (expected ${expected})`}`);
  };

  // --- 1. row counts -----------------------------------------------------
  let total = 0;
  for (const t of [...TABLE_ORDER, JOIN_TABLE]) {
    const r = await c.query(`SELECT count(*)::int AS n FROM "${t}"`);
    total += r.rows[0].n as number;
  }
  check("total rows", total, snapshot.meta.totalRows);

  for (const [t, n] of Object.entries(EXPECTED)) {
    if (t === "businessId" || t === "currentCash") continue;
    const r = await c.query(`SELECT count(*)::int AS n FROM "${t}"`);
    check(`${t} rows`, r.rows[0].n, n);
  }

  // --- 2. the ledger -----------------------------------------------------
  const cash = await c.query(`SELECT "currentCash" FROM "Business" WHERE id = $1`, [EXPECTED.businessId]);
  check("Business.currentCash", cash.rows[0]?.currentCash ?? null, EXPECTED.currentCash);

  // --- 3. financial identity values --------------------------------------
  const intents = (await c.query(`SELECT * FROM "ExecutionIntent" ORDER BY id`)).rows as Row[];
  const srcIntents = snapshot.tables.ExecutionIntent as Row[];

  const targetDigest = financialDigest(intents);
  const sourceDigest = financialDigest(srcIntents);
  check("ExecutionIntent financial digest", targetDigest, sourceDigest);

  const missingKeys = srcIntents.filter(
    (s) => !intents.some((t) => t.idempotencyKey === s.idempotencyKey)
  );
  check("idempotencyKey values preserved", missingKeys.length, 0);

  const srcObl = srcIntents.filter((s) => s.obligationKey).map((s) => s.obligationKey);
  const tgtObl = new Set(intents.filter((t) => t.obligationKey).map((t) => t.obligationKey));
  check("obligationKey values preserved", srcObl.filter((o) => !tgtObl.has(o)).length, 0);

  const srcRefs = srcIntents.filter((s) => s.externalRef).map((s) => s.externalRef);
  const tgtRefs = new Set(intents.filter((t) => t.externalRef).map((t) => t.externalRef));
  check("externalRef values preserved", srcRefs.filter((r) => !tgtRefs.has(r)).length, 0);

  // Uniqueness is a financial guarantee, not a cosmetic one.
  const dupKeys = await c.query(
    `SELECT count(*)::int AS n FROM (SELECT "idempotencyKey" FROM "ExecutionIntent" GROUP BY 1 HAVING count(*) > 1) d`
  );
  check("duplicate idempotencyKeys", dupKeys.rows[0].n, 0);

  const dupObl = await c.query(
    `SELECT count(*)::int AS n FROM (SELECT "obligationKey" FROM "ExecutionIntent"
       WHERE "obligationKey" IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d`
  );
  check("obligations with >1 intent", dupObl.rows[0].n, 0);

  // --- 4. referential integrity ------------------------------------------
  const orphanIntents = await c.query(
    `SELECT count(*)::int AS n FROM "ExecutionIntent" i
       LEFT JOIN "AgentAction" a ON a.id = i."actionId" WHERE a.id IS NULL`
  );
  check("ExecutionIntent -> AgentAction orphans", orphanIntents.rows[0].n, 0);

  const orphanDecisions = await c.query(
    `SELECT count(*)::int AS n FROM "Decision" d
       LEFT JOIN "Strategy" s ON s.id = d."strategyId" WHERE s.id IS NULL`
  );
  check("Decision -> Strategy orphans", orphanDecisions.rows[0].n, 0);

  const orphanRecovery = await c.query(
    `SELECT count(*)::int AS n FROM "PaymentRecovery" p
       LEFT JOIN "Transaction" t ON t.id = p."transactionId" WHERE t.id IS NULL`
  );
  check("PaymentRecovery -> Transaction orphans", orphanRecovery.rows[0].n, 0);

  await c.end();

  console.log(`\n  FINANCIAL INTEGRITY: ${failures.length === 0 ? "PASS" : "FAIL"}`);
  if (failures.length) {
    for (const f of failures) console.error(`    - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("VERIFY FAILED:", msg.replace(/postgres(ql)?:\/\/\S+/gi, "<redacted>"));
  process.exit(1);
});
