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
  },
});
