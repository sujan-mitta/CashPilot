import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * No source file may contain a NUL byte.
 *
 * WHAT ONE NUL DID
 *
 * `src/app/api/payment-status/route.ts` carried a single 0x00 inside a string
 * literal — a sentinel businessId written as "\0-no-business". It cost two
 * separate things:
 *
 *   · Postgres text cannot hold a NUL. The query that used the sentinel did not
 *     match nothing as intended; it THREW, and the throw was swallowed by an
 *     enclosing catch, quietly disabling a concurrent-completion check.
 *
 *   · grep and ripgrep treat a file containing a NUL as binary and skip it. So
 *     every content search across this repository silently omitted that route.
 *     It was not hidden in a corner — it was invisible to the tools used to
 *     look for it, which is how it survived a full audit for contradictions.
 *
 * The second is the reason this test exists. A bug you cannot grep for is a bug
 * you will not find, and no amount of careful reading substitutes for search
 * working.
 */

const ROOTS = ["src", "scripts", "prisma"];
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".prisma", ".json", ".css", ".md"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "generated", ".git"]);

function sourceFiles(dir: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found; // A root that does not exist is not a failure.
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (EXTENSIONS.some((e) => entry.endsWith(e))) found.push(full);
  }
  return found;
}

const files = ROOTS.flatMap((r) => sourceFiles(join(process.cwd(), r)));

describe("Every source file is searchable", () => {
  it("contains no NUL bytes", () => {
    const offenders = files.filter((f) => readFileSync(f).includes(0x00));

    // Named, not counted: the whole problem was not knowing which file was
    // being skipped.
    expect(offenders).toEqual([]);
  });

  it("actually scanned the tree", () => {
    // Guards the guard. A walker that silently returned nothing — a bad root, a
    // throwing statSync — would make the assertion above pass forever while
    // checking no files at all.
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith("route.ts"))).toBe(true);
  });
});
