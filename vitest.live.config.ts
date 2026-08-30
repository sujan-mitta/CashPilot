/**
 * Config for the Tier C live-provider certification tests.
 *
 * Those tests are gated on RAZORPAY_LIVE_TEST=1 so an ordinary `npm test` can
 * never reach out to Razorpay. Setting that variable on the command line is not
 * portable (`VAR=x cmd` is a parse error in cmd.exe, and cross-env is only a
 * transitive dependency here), so it is set in-process instead.
 *
 * The flag and the credentials are both set up here rather than by importing
 * vitest.config.ts: an ESM `import` is hoisted above any statement in this
 * file, so the base config would run - and decide not to load credentials -
 * before the assignment below ever executed. Vitest forwards the main process's
 * env to its workers, so setting them here is what reaches the tests.
 */
import { defineConfig } from "vitest/config";
import dotenv from "dotenv";
import path from "path";

process.env.RAZORPAY_LIVE_TEST = "1";
dotenv.config();

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    // Parity with vitest.config.ts. Without this the live run fell back to
    // vitest's 5s default, and a test that passes normally failed at exactly
    // 5000ms — on the timeout, not on the assertion.
    testTimeout: 15000,
  },
});
