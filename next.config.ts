import type { NextConfig } from "next";

/**
 * Security response headers, applied to every route.
 *
 * The app previously sent none, so it had no clickjacking defence, no MIME-sniff
 * protection, and no HSTS. These are the low-cost, high-value baseline.
 *
 * The CSP is intentionally strict but allows what this app genuinely uses:
 * `'unsafe-inline'` for styles (Tailwind's injected styles and inline style
 * attributes) and `'unsafe-eval'` is NOT granted. Framer Motion and the
 * Three.js hero run without eval. `connect-src` stays same-origin: the browser
 * never talks to Razorpay or Google directly - those exchanges are server-side.
 */
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self'",
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
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
