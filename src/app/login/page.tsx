"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useCashPilot } from "@/context/CashPilotContext";
import { Eye, EyeOff, Lock, Mail, User, Briefcase, ArrowRight, ShieldCheck } from "lucide-react";
import { PilotIcon } from "@/components/PilotIcon";
import { HeroScene } from "@/components/hero/HeroScene";
import { Button } from "@/components/ui/Button";
import { Stagger, StaggerItem } from "@/components/ui/Reveal";
import { EASE_GLIDE, DUR, focusIn } from "@/components/ui/motion";
import clsx from "clsx";
import { errorMessage } from "@/lib/errors";

const highlights = [
  "Deterministic runway models — no model guesses at your money",
  "Live Razorpay recovery links, executed once and only once",
  "Every decision auditable from recommendation to settled rupee",
];

const fieldClass = clsx(
  "w-full pl-10 pr-4 py-3 rounded-xl text-sm outline-none",
  "bg-ground-200/70 border border-line-soft text-ink-100 font-medium",
  "placeholder:text-ink-500 placeholder:font-normal",
  "transition-[border-color,background,box-shadow] duration-200",
  "hover:border-line-firm",
  "focus:border-brand-500 focus:bg-ground-200 focus:shadow-[0_0_0_3px_rgb(99_102_241/0.18)]"
);

const labelClass = "label block mb-1.5";

export default function Login() {
  const router = useRouter();
  const { user, login } = useCashPilot();

  const [mode, setMode] = useState<"SIGN_IN" | "SIGN_UP">("SIGN_IN");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Redirect if already authenticated.
  useEffect(() => {
    if (user) {
      router.push("/dashboard");
    }
  }, [user, router]);

  // Messages from the popup Google account chooser.
  useEffect(() => {
    const handleGoogleMessage = async (event: MessageEvent) => {
      if (event.data?.type === "GOOGLE_AUTH_SUCCESS") {
        const { name, email, businessName } = event.data.user;
        try {
          const res = await fetch("/api/auth/signup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, email, businessName }),
          });
          const data = await res.json();
          if (res.ok) {
            login(data.user);
            router.push("/dashboard");
          } else {
            setError(data.error || "Google authentication sync failed.");
          }
        } catch (err) {
          setError(errorMessage(err, "Google authentication sync failed."));
        }
      }
    };
    window.addEventListener("message", handleGoogleMessage);
    return () => window.removeEventListener("message", handleGoogleMessage);
  }, [login, router]);

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
    if (password.length < 6) {
      setError("Password must be at least 6 characters long.");
      return;
    }

    setIsLoading(true);

    try {
      const url = mode === "SIGN_UP" ? "/api/auth/signup" : "/api/auth/login";
      const payload =
        mode === "SIGN_UP"
          ? { name, email, businessName }
          : { email, businessName: businessName || "ABC Electronics Pvt Ltd" };

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

      login(data.user);
      setIsLoading(false);
      router.push("/dashboard");
    } catch (err) {
      setError(errorMessage(err, "Unable to connect to auth server."));
      setIsLoading(false);
    }
  };

  const handleGoogleSignIn = () => {
    const width = 450;
    const height = 550;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;
    window.open(
      "/auth/google",
      "google-oauth-popup",
      `width=${width},height=${height},left=${left},top=${top},scrollbars=no,resizable=no`
    );
  };

  const toggleMode = () => {
    setError(null);
    setMode((prev) => (prev === "SIGN_IN" ? "SIGN_UP" : "SIGN_IN"));
  };

  return (
    <div className="relative min-h-screen flex overflow-hidden bg-ground-000 mesh-bg grain">
      {/* The runway terrain sits behind everything, anchored to the lower half
          where there is no text over it. */}
      <HeroScene className="pointer-events-none absolute inset-x-0 bottom-0 h-[78vh] z-0" />

      {/* ══════════════════════════ Brand side ══════════════════════════ */}
      <div className="hidden lg:flex lg:w-[54%] relative z-10 p-12 xl:p-16 flex-col justify-between">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: DUR.slow, ease: EASE_GLIDE }}
          className="flex items-center gap-3"
        >
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-brand-400 via-brand-500 to-violet-500 flex items-center justify-center shadow-[0_1px_0_rgb(255_255_255/0.2)_inset,0_10px_30px_-8px_rgb(99_102_241/0.85)]">
            <PilotIcon className="w-6 h-6 text-white" />
          </div>
          <div>
            <span className="font-semibold text-[1.35rem] tracking-[-0.035em] text-ink-100 block leading-none">
              CashPilot
            </span>
            <span className="label block mt-1.5">Cash Intervention Controller</span>
          </div>
        </motion.div>

        <Stagger className="my-auto max-w-2xl space-y-7" stagger={0.09} delayChildren={0.15}>
          <StaggerItem>
            <span className="inline-flex items-center gap-2 text-[10px] uppercase font-semibold tracking-[0.1em] glass px-3.5 py-1.5 rounded-full text-brand-300">
              <span className="pip" aria-hidden />
              Razorpay Buildathon MVP
            </span>
          </StaggerItem>

          <motion.h1 variants={focusIn} className="display max-w-xl">
            Stop cash crises
            <br />
            before they reach
            <br />
            <span className="text-gradient">your payroll.</span>
          </motion.h1>

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
                <div className="w-5 h-5 mt-px rounded-md bg-safe-500/12 ring-1 ring-inset ring-safe-500/30 flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-3 h-3 text-safe-400" strokeWidth={2.5} />
                </div>
                <span className="text-[13px] text-ink-300 leading-snug">{h}</span>
              </div>
            ))}
          </StaggerItem>
        </Stagger>

        <div className="text-[11.5px] text-ink-500">
          © 2026 CashPilot. Every execution passes a human gate.
        </div>
      </div>

      {/* ══════════════════════════ Auth side ═══════════════════════════ */}
      <div className="w-full lg:w-[46%] relative z-10 flex items-center justify-center p-6 sm:p-10">
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: DUR.deliberate, ease: EASE_GLIDE, delay: 0.1 }}
          className="max-w-[26rem] w-full glass-strong rounded-2xl p-8 space-y-6 shadow-[var(--lift-4)]"
        >
          <div className="text-center">
            <div className="lg:hidden flex items-center justify-center gap-2.5 mb-5">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-400 to-violet-500 flex items-center justify-center">
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
            className="w-full py-3 rounded-xl text-[13px] font-semibold outline-none flex items-center justify-center gap-2.5 bg-ground-200 border border-line-soft text-ink-200 hover:bg-ground-300 hover:border-line-firm transition-colors duration-200"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden>
              <path
                fill="#4285F4"
                d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v3.9h6.69c-.29 1.5-.1.14-.1.14v2.54h1.03l2.42-1.87c2-1.86 3.7-4.64 3.7-8.64z"
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
              {error && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: DUR.base, ease: EASE_GLIDE }}
                  role="alert"
                  className="overflow-hidden"
                >
                  <div className="p-3.5 rounded-xl bg-risk-500/10 border border-risk-500/25 text-[12.5px] font-medium text-risk-400">
                    {error}
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
                  className="absolute right-3.5 top-3.5 text-ink-500 hover:text-ink-200 transition-colors outline-none"
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

          <div className="text-center pt-1">
            <button
              onClick={toggleMode}
              className="text-[12.5px] text-brand-300 font-medium hover:text-brand-400 transition-colors outline-none rounded"
            >
              {mode === "SIGN_IN"
                ? "Don't have an account? Sign up"
                : "Already have an account? Sign in"}
            </button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
