import "dotenv/config";
import { Client } from "pg";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TABLE_ORDER, JOIN_TABLE } from "./migrationManifest";

/**
 * STEP 6 - import the snapshot into the TARGET database.
 *
 * Safety properties, in order of importance:
 *
 *   1. It refuses to run against a database that already holds application
 *      rows. Re-running this against the source is the single worst outcome
 *      available - it would duplicate 18 ExecutionIntents and re-insert
 *      ProcessedEvent, destroying the audit evidence the migration exists to
 *      preserve. `--force` exists but must be typed deliberately.
 *   2. It verifies the snapshot checksum before touching anything.
 *   3. Each table is inserted inside its own transaction and rolled back on
 *      the first error, so a failure leaves that table empty rather than half
 *      populated.
 *   4. Row counts are re-read from the target and compared to the snapshot.
 *
 * Run against the TARGET (Neon):
 *   npm run db:import
 */

const FILE = path.join(process.cwd(), "migration-snapshots", "cashpilot-snapshot.json");
const FORCE = process.argv.includes("--force");

/** Reverses the tagging applied by export-database.ts. */
function decode(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(decode);
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (o.__t === "date") return new Date(o.v as string);
    if (o.__t === "bigint") return BigInt(o.v as string);
    if (o.__t === "buffer") return Buffer.from(o.v as string, "base64");
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = decode(v);
    return out;
  }
  return value;
}

/**
 * JSON columns must be handed to pg as a string, otherwise node-postgres
 * serialises a plain object as "[object Object]".
 */
function bind(value: unknown): unknown {
  const d = decode(value);
  if (d !== null && typeof d === "object" && !(d instanceof Date) && !Buffer.isBuffer(d)) {
    return JSON.stringify(d);
  }
  return d;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!fs.existsSync(FILE)) throw new Error(`Snapshot not found: ${FILE}. Run npm run db:export first.`);

  const body = fs.readFileSync(FILE, "utf8");
  const checksum = crypto.createHash("sha256").update(body).digest("hex");
  const expectedFile = `${FILE}.sha256`;
  if (fs.existsSync(expectedFile)) {
    const expected = fs.readFileSync(expectedFile, "utf8").trim().split(/\s+/)[0];
    if (expected !== checksum) {
      throw new Error(`Snapshot checksum mismatch.\n  expected ${expected}\n  actual   ${checksum}`);
    }
    console.log(`  snapshot checksum verified: ${checksum.slice(0, 16)}...`);
  }

  const snapshot = JSON.parse(body) as {
    meta: { totalRows: number; counts: Record<string, number>; sourceDatabase: string };
    tables: Record<string, Record<string, unknown>[]>;
  };

  const client = new Client({ connectionString: url });
  await client.connect();

  const who = await client.query(`SELECT current_database() AS db, version() AS v`);
  console.log(`  target: ${who.rows[0].db} (${String(who.rows[0].v).split(" ").slice(0, 2).join(" ")})`);

  // --- GUARD -------------------------------------------------------------
  let existing = 0;
  for (const t of TABLE_ORDER) {
    const r = await client.query(`SELECT count(*)::int AS n FROM "${t}"`);
    existing += r.rows[0].n;
  }
  if (existing > 0 && !FORCE) {
    await client.end();
    throw new Error(
      `REFUSING: target already contains ${existing} application rows.\n` +
        `  Importing would duplicate financial records.\n` +
        `  If this is genuinely the empty target, verify you are pointed at Neon.\n` +
        `  Re-run with --force only if you are certain.`
    );
  }
  // -----------------------------------------------------------------------

  const inserted: Record<string, number> = {};
  const failures: string[] = [];

  for (const table of [...TABLE_ORDER, JOIN_TABLE]) {
    const rows = snapshot.tables[table] ?? [];
    if (rows.length === 0) {
      inserted[table] = 0;
      console.log(`  ${table.padEnd(24)}     0  (empty)`);
      continue;
    }

    const columns = Object.keys(rows[0]);
    const colSql = columns.map((c) => `"${c}"`).join(", ");

    await client.query("BEGIN");
    try {
      for (const row of rows) {
        const params = columns.map((c) => bind(row[c]));
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
        await client.query(`INSERT INTO "${table}" (${colSql}) VALUES (${placeholders})`, params);
      }
      await client.query("COMMIT");
      inserted[table] = rows.length;
      console.log(`  ${table.padEnd(24)} ${String(rows.length).padStart(5)}`);
    } catch (e) {
      await client.query("ROLLBACK");
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${table}: ${msg}`);
      console.error(`  ${table.padEnd(24)}  FAILED - ${msg}`);
      break; // abort on first mismatch
    }
  }

  // Re-read the target and compare against the snapshot.
  console.log("\n  verification (target counts vs snapshot):");
  let mismatches = 0;
  let total = 0;
  for (const table of [...TABLE_ORDER, JOIN_TABLE]) {
    const r = await client.query(`SELECT count(*)::int AS n FROM "${table}"`);
    const actual = r.rows[0].n as number;
    const expected = snapshot.meta.counts[table] ?? 0;
    total += actual;
    if (actual !== expected) {
      mismatches++;
      console.log(`    ${table.padEnd(24)} ${actual} != ${expected}  MISMATCH`);
    }
  }
  await client.end();

  console.log(`    total rows in target: ${total} (snapshot: ${snapshot.meta.totalRows})`);
  console.log(`\n  failures: ${failures.length}  mismatches: ${mismatches}`);
  if (failures.length || mismatches || total !== snapshot.meta.totalRows) {
    console.error("  IMPORT: FAIL");
    process.exit(1);
  }
  console.log("  IMPORT: PASS");
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("\nIMPORT FAILED:\n  " + msg.replace(/postgres(ql)?:\/\/\S+/gi, "<redacted>"));
  process.exit(1);
});
