import "dotenv/config";
import { Client } from "pg";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TABLE_ORDER, JOIN_TABLE, assertManifestCovers } from "./migrationManifest";

/**
 * STEP 5 - export the source database to a single verifiable snapshot.
 *
 * READ-ONLY. Every statement is a SELECT.
 *
 * Uses raw pg rather than Prisma deliberately: Prisma would coerce values
 * through its type layer on the way out and again on the way in, and a money
 * migration should move bytes, not interpretations. Raw rows preserve ids,
 * timestamps, enum labels, JSON structure and nulls exactly as stored.
 *
 * Run against the SOURCE database (local PGlite):
 *   npm run db:export
 */

const OUT_DIR = path.join(process.cwd(), "migration-snapshots");

/** JSON cannot represent Date or BigInt; tag them so import can restore them. */
function encode(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return { __t: "date", v: value.toISOString() };
  if (typeof value === "bigint") return { __t: "bigint", v: value.toString() };
  if (Buffer.isBuffer(value)) return { __t: "buffer", v: value.toString("base64") };
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = encode(v);
    return out;
  }
  return value;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const client = new Client({ connectionString: url });
  await client.connect();

  const meta = await client.query(
    `SELECT current_database() AS db, version() AS version`
  );
  const present = await client.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );
  const actual = present.rows.map((r: { tablename: string }) => r.tablename);
  assertManifestCovers(actual);

  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  let total = 0;

  for (const table of TABLE_ORDER) {
    // Deterministic order so the same database always yields the same bytes,
    // which is what makes the checksum comparison meaningful.
    const r = await client.query(`SELECT * FROM "${table}" ORDER BY "id"`);
    const rows = r.rows.map((row) => encode(row));
    tables[table] = rows;
    counts[table] = rows.length;
    total += rows.length;
    console.log(`  ${table.padEnd(24)} ${String(rows.length).padStart(5)}`);
  }

  // Implicit m2m join table - no id column, so order by both sides.
  const join = await client.query(`SELECT * FROM "${JOIN_TABLE}" ORDER BY "A", "B"`);
  tables[JOIN_TABLE] = join.rows.map((row) => encode(row));
  counts[JOIN_TABLE] = join.rows.length;
  total += join.rows.length;
  console.log(`  ${JOIN_TABLE.padEnd(24)} ${String(join.rows.length).padStart(5)}`);

  await client.end();

  const snapshot = {
    meta: {
      exportedAt: new Date().toISOString(),
      sourceDatabase: meta.rows[0].db,
      sourceVersion: String(meta.rows[0].version).split(" ").slice(0, 2).join(" "),
      tableOrder: [...TABLE_ORDER, JOIN_TABLE],
      counts,
      totalRows: total,
    },
    tables,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, "cashpilot-snapshot.json");
  const body = JSON.stringify(snapshot, null, 2);
  fs.writeFileSync(file, body, "utf8");

  const checksum = crypto.createHash("sha256").update(body).digest("hex");
  fs.writeFileSync(`${file}.sha256`, `${checksum}  cashpilot-snapshot.json\n`, "utf8");

  console.log(`\n  TOTAL ROWS : ${total}`);
  console.log(`  FILE       : ${path.relative(process.cwd(), file)}`);
  console.log(`  SIZE       : ${(Buffer.byteLength(body) / 1024).toFixed(1)} kB`);
  console.log(`  SHA256     : ${checksum}`);
  console.log(`  SOURCE     : ${snapshot.meta.sourceDatabase} (${snapshot.meta.sourceVersion})`);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("EXPORT FAILED:", msg.replace(/postgres(ql)?:\/\/\S+/gi, "<redacted>"));
  process.exit(1);
});
