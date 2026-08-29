import type { NextConfig } from "next";

/**
 * Security response headers, applied to every route.
 *
 * The app previously sent none, so it had no clickjacking defence, no MIME-sniff
 * protection, and no HSTS. These are the low-cost, high-value baseline.
 *
 * script-src allows 'unsafe-inline' because Next.js emits inline hydration
 * scripts (the `self.__next_f` RSC payload). A bare `script-src 'self'` blocked
 * them, hydration failed with React error #412, and client-rendered pages -
 * the login form under Suspense - came up blank. Verified in the browser
 * console on production. A nonce would be stricter, but Next only applies a
 * nonce on dynamically-rendered routes; the statically prerendered pages here
 * would still break. `'unsafe-eval'` is NOT granted, and the real injection
 * surface is small because React escapes all interpolated output. All other
 * directives stay strict. `connect-src` is same-origin: the browser never
 * talks to Razorpay or Google directly - those exchanges are server-side.
 */
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
  // Defence in depth alongside the CSP frame-ancestors directive.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
