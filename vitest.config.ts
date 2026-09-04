import { defineConfig } from "vitest/config";
import path from "path";

// Live provider certification (Phase 17) needs real test-account credentials.
// They are loaded ONLY when explicitly requested, so the default suite keeps
// running against the simulated provider and cannot accidentally reach out to
// Razorpay during an ordinary `npm test`.
if (process.env.RAZORPAY_LIVE_TEST === "1") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv/config");
}

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    testTimeout: 15000,
    /**
     * Capped, because the default oversubscribes the machine and the suite
     * fails for a reason that has nothing to do with the code.
     *
     * Vitest defaults to roughly one worker per core. On a 16-core machine that
     * starves the heaviest files: the property-based scoring tests run several
     * thousand scorings, and the webhook suites each build and verify real
     * HMACs. Run alone every one of them finishes in about two seconds. Run
     * with sixteen workers competing, they blow the 15s timeout and the suite
     * reports failures that vanish on the next run — the worst kind, because it
     * teaches you to re-run instead of read.
     *
     * Four workers is empirically clean here: 1816 tests, no timeouts. This
     * changes SCHEDULING only. No assertion is relaxed and no test is skipped;
     * raising testTimeout instead would have hidden starvation behind a longer
     * wait rather than removing it.
     */
    maxWorkers: 4,
    // The live tier is a separate file, excluded here rather than skipped
    // inside the suite. `npm test` therefore reports zero skipped tests, and
    // still cannot reach Razorpay. `npm run test:live` includes it.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/*.live.test.ts"],
  },
});
