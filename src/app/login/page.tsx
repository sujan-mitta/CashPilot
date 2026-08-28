"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useCashPilot } from "@/context/CashPilotContext";
import { Eye, EyeOff, Lock, Mail, User, Briefcase, ArrowRight, ShieldCheck } from "lucide-react";
import { PilotIcon } from "@/components/PilotIcon";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/Button";
import { Stagger, StaggerItem } from "@/components/ui/Reveal";
import { EASE_GLIDE, DUR } from "@/components/ui/motion";
import clsx from "clsx";
import { errorMessage } from "@/lib/errors";

const highlights = [
  "Deterministic runway models — no model guesses at your money",
  "Live Razorpay recovery links, executed once and only once",
  "Every decision auditable from recommendation to settled rupee",
];

const fieldClass = clsx(
  "w-full pl-10 pr-4 py-3 rounded-md text-sm focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050",
  "bg-ground-200/70 border border-line-soft text-ink-100 font-medium",
  "placeholder:text-ink-400 placeholder:font-normal",
  "transition-[border-color,background,box-shadow] duration-200",
  "hover:border-line-firm",
  // `focus:` with nothing after it was a dangling class that emitted no CSS,
  // so the login inputs - the first controls anyone touches - had no focus
  // treatment beyond a border tint.
  "focus:border-brand-500 focus:bg-ground-200",
  "focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-100"
);

const labelClass = "label block mb-1.5";

function LoginForm() {
  const router = useRouter();
  const { user, login } = useCashPilot();

  const [mode, setMode] = useState<"SIGN_IN" | "SIGN_UP">("SIGN_IN");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // Why Google sign-in bounced us back, if it did. Derived rather than stored:
  // it is a pure function of the URL, so it needs neither state nor an effect.
  const searchParams = useSearchParams();
  const oauthError = (() => {
    const reason = searchParams.get("error");
    if (!reason) return null;
    const messages: Record<string, string> = {
      google_not_configured: "Google sign-in is not configured on this deployment.",
      google_denied: "Google sign-in was cancelled.",
      google_no_account:
        "No CashPilot account exists for that Google address. Sign up with your email first.",
      google_email_unverified: "That Google address is not verified with Google.",
      google_state_mismatch: "Google sign-in expired or was tampered with. Please try again.",
      google_state_missing: "Google sign-in expired. Please try again.",
      google_invalid_response: "Google returned an unexpected response. Please try again.",
      google_failed: "Google sign-in failed. Please try again.",
    };
    return messages[reason] ?? "Google sign-in failed. Please try again.";
  })();

  /** A form error takes precedence over a stale one carried in the URL. */
  const shownError = error ?? oauthError;
  const [isLoading, setIsLoading] = useState(false);

  // Redirect if already authenticated.
  useEffect(() => {
    if (user) {
      router.push("/dashboard");
    }
  }, [user, router]);
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === "SIGN_UP" && !name.trim()) {
      setError("Please enter your full name.");
      return;
    }
    if (!email.trim() || !email.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }
    if (mode === "SIGN_UP" && !businessName.trim()) {
      setError("Please enter your business name.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters long.");
      return;
    }

    setIsLoading(true);

    try {
      const url = mode === "SIGN_UP" ? "/api/auth/signup" : "/api/auth/login";
      const payload =
        mode === "SIGN_UP"
          ? { name, email, businessName, password }
          : { email, password, businessName };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Authentication failed.");
        setIsLoading(false);
        return;
      }

      // The redirect is driven solely by the `user` effect above. Pushing here
      // as well meant two navigations for one sign-in.
      login(data.user);
      setIsLoading(false);
    } catch (err) {
      setError(errorMessage(err, "Unable to connect to auth server."));
      setIsLoading(false);
    }
  };

  const handleGoogleSignIn = () => {
    // A top-level navigation, not a popup. The browser never asserts the
    // identity; it only carries an opaque code that the server exchanges with
    // Google directly.
    //
    // router.push() is wrong here despite the lint rule: this path is an API
    // route that answers 302 to accounts.google.com. Client-side navigation
    // would try to render it as a page instead of leaving the app, so the
    // handoff to Google would never happen.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/api/auth/google/start";
  };

  const toggleMode = () => {
    setError(null);
    setMode((prev) => (prev === "SIGN_IN" ? "SIGN_UP" : "SIGN_IN"));
  };

  return (
    <div className="relative min-h-screen flex overflow-hidden bg-ground-050">
      {/* Sign-in renders without the app chrome, so the theme control has to
          live here too — otherwise the first screen anyone sees is the one
          screen where they cannot change it. */}
      <ThemeToggle className="absolute top-5 right-5 z-30" />

      {/* ══════════════════════════ Brand side ══════════════════════════ */}
      <div className="hidden lg:flex lg:w-[54%] relative z-10 p-12 xl:p-16 flex-col justify-between">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-md bg-brand-500 flex items-center justify-center">
            <PilotIcon className="w-6 h-6 text-white" />
          </div>
          <div>
            <span className="font-semibold text-[1.35rem] tracking-[-0.035em] text-ink-100 block leading-none">
              CashPilot
            </span>
            <span className="label block mt-1">Cash intervention controller</span>
          </div>
        </div>

        <Stagger className="my-auto max-w-2xl space-y-7" stagger={0.09} delayChildren={0.15}>
          <StaggerItem>
            <span className="inline-flex items-center gap-2 text-[12px] font-medium px-2 py-1 rounded border border-line-soft bg-ground-100 text-ink-300">
              Razorpay Buildathon MVP
            </span>
          </StaggerItem>

          <h1 className="display max-w-xl">
            Stop cash crises before they reach your payroll.
          </h1>

          <StaggerItem>
            <p className="text-ink-300 text-[0.95rem] leading-relaxed max-w-lg">
              CashPilot forecasts liquidity from your real ledger, finds the timing gap that
              causes the shortfall, and executes recovery through Razorpay — with a human
              approving every rupee that moves.
            </p>
          </StaggerItem>

          <StaggerItem className="space-y-3.5 pt-3">
            {highlights.map((h) => (
              <div key={h} className="flex items-start gap-3">
                <ShieldCheck className="w-4 h-4 mt-0.5 text-safe-400 shrink-0" strokeWidth={2} />
                <span className="text-[13px] text-ink-300 leading-snug">{h}</span>
              </div>
            ))}
          </StaggerItem>
        </Stagger>

        <div className="text-[11.5px] text-ink-400">
          © 2026 CashPilot. Every execution passes a human gate.
        </div>
      </div>

      {/* ══════════════════════════ Auth side ═══════════════════════════ */}
      <div className="w-full lg:w-[46%] relative z-10 flex items-center justify-center p-6 sm:p-10">
        <div
          className="max-w-[26rem] w-full bg-ground-100 border border-line-soft rounded-md p-7 space-y-5"
        >
          <div className="text-center">
            <div className="lg:hidden flex items-center justify-center gap-2.5 mb-5">
              <div className="w-9 h-9 rounded-md bg-ground-200 flex items-center justify-center">
                <PilotIcon className="w-5 h-5 text-white" />
              </div>
              <span className="font-semibold text-[1.15rem] tracking-[-0.03em] text-ink-100">
                CashPilot
              </span>
            </div>

            <AnimatePresence mode="wait">
              <motion.div
                key={mode}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: DUR.base, ease: EASE_GLIDE }}
              >
                <h2 className="text-[1.35rem] font-semibold text-ink-100 tracking-[-0.03em]">
                  {mode === "SIGN_IN" ? "Sign in to your deck" : "Create your account"}
                </h2>
                <p className="text-ink-400 text-[12.5px] mt-1.5 leading-relaxed">
                  {mode === "SIGN_IN"
                    ? "Access the cash diagnostics and execution controls."
                    : "Register your business to seed the runway simulator."}
                </p>
              </motion.div>
            </AnimatePresence>
          </div>

          <button
            type="button"
            onClick={handleGoogleSignIn}
            className="w-full py-3 rounded-md text-[13px] font-semibold focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050 flex items-center justify-center gap-2.5 bg-ground-200 border border-line-soft text-ink-200 hover:bg-ground-300 hover:border-line-firm transition-colors duration-200"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden>
              {/* The blue stroke's path data was corrupt ("...6.69c-.29 1.5-.1.14-.1.14v2.54h1.03...")
                  and rendered as a stray wedge across the mark. This is the
                  canonical Google "G" geometry. */}
              <path
                fill="#4285F4"
                d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.44a5.5 5.5 0 0 1-2.39 3.62v3h3.86c2.26-2.09 3.58-5.17 3.58-8.86z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.24 0 5.97-1.08 7.96-2.91l-3.45-2.68c-.96.64-2.2 1.02-3.51 1.02-2.7 0-5-1.82-5.81-4.28H1.63v2.77C3.62 21.94 7.55 24 12 24z"
              />
              <path
                fill="#FBBC05"
                d="M6.19 15.15A7.18 7.18 0 0 1 5.75 12c0-1.1.2-2.15.56-3.15V6.08H1.63A11.96 11.96 0 0 0 0 12c0 2.22.6 4.3 1.63 6.08l4.56-3.08z"
              />
              <path
                fill="#EA4335"
                d="M12 4.75c1.77 0 3.35.6 4.6 1.8l3.43-3.43C17.95 1.19 15.22 0 12 0 7.55 0 3.62 2.06 1.63 6.08l4.56 3.07C7 6.57 9.3 4.75 12 4.75z"
              />
            </svg>
            Continue with Google
          </button>

          <div className="flex items-center gap-4 text-ink-500">
            <span className="h-px bg-line-soft grow" />
            <span className="label">Or use email</span>
            <span className="h-px bg-line-soft grow" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <AnimatePresence>
              {shownError && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: DUR.base, ease: EASE_GLIDE }}
                  role="alert"
                  className="overflow-hidden"
                >
                  <div className="p-3.5 rounded-md bg-risk-500/10 border border-risk-500/25 text-[12.5px] font-medium text-risk-400">
                    {shownError}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence initial={false}>
              {mode === "SIGN_UP" && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: DUR.base, ease: EASE_GLIDE }}
                  className="overflow-hidden"
                >
                  <div className="pb-0.5">
                    <label htmlFor="cp-name" className={labelClass}>
                      Full name
                    </label>
                    <div className="relative">
                      <User className="absolute left-3.5 top-3.5 w-4 h-4 text-ink-500" aria-hidden />
                      <input
                        id="cp-name"
                        type="text"
                        required
                        autoComplete="name"
                        placeholder="Enter your name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className={fieldClass}
                      />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div>
              <label htmlFor="cp-email" className={labelClass}>
                Email address
              </label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-3.5 w-4 h-4 text-ink-500" aria-hidden />
                <input
                  id="cp-email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="name@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={fieldClass}
                />
              </div>
            </div>

            <div>
              <label htmlFor="cp-business" className={labelClass}>
                Business name
              </label>
              <div className="relative">
                <Briefcase className="absolute left-3.5 top-3.5 w-4 h-4 text-ink-500" aria-hidden />
                <input
                  id="cp-business"
                  type="text"
                  required
                  autoComplete="organization"
                  placeholder="e.g. ABC Electronics Ltd"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  className={fieldClass}
                />
              </div>
            </div>

            <div>
              <label htmlFor="cp-password" className={labelClass}>
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-3.5 w-4 h-4 text-ink-500" aria-hidden />
                <input
                  id="cp-password"
                  type={showPassword ? "text" : "password"}
                  required
                  autoComplete={mode === "SIGN_IN" ? "current-password" : "new-password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={clsx(fieldClass, "pr-10")}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((p) => !p)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-3.5 top-3.5 text-ink-500 hover:text-ink-200 transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <Button type="submit" variant="primary" size="lg" loading={isLoading} className="mt-1 w-full">
              {!isLoading && (
                <>
                  {mode === "SIGN_IN" ? "Access dashboard" : "Register & seed demo"}
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </Button>
          </form>

          {/* An account with no password set is told to "reset your password"
              by /api/auth/login, and there is no reset route to send them to.
              Saying so plainly is better than a link that goes nowhere. */}
          {mode === "SIGN_IN" && (
            <p className="text-center text-[11.5px] text-ink-500 leading-relaxed">
              Forgotten your password? Password reset is not available yet — ask
              whoever set up your CashPilot account.
            </p>
          )}

          <div className="text-center pt-1">
            <button
              onClick={toggleMode}
              className="text-[12.5px] text-brand-300 font-medium hover:text-brand-400 transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050 rounded"
            >
              {mode === "SIGN_IN"
                ? "Don't have an account? Sign up"
                : "Already have an account? Sign in"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * useSearchParams() opts a route into client-side rendering, so Next requires
 * it to sit under a Suspense boundary or the static prerender of /login fails
 * the build outright. The boundary is here rather than around a fragment
 * because the whole form reads the OAuth error.
 */
export default function Login() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
