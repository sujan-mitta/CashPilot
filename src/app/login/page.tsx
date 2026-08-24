"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useCashPilot } from "@/context/CashPilotContext";
import { Eye, EyeOff, Lock, Mail, User, Briefcase, ArrowRight, ShieldCheck } from "lucide-react";
import { PilotIcon } from "@/components/PilotIcon";
import { Button } from "@/components/ui/Button";
import { Reveal, Stagger, StaggerItem } from "@/components/ui/Reveal";
import { EASE_OUT_EXPO } from "@/components/ui/motion";
import clsx from "clsx";
import { errorMessage } from "@/lib/errors";

const highlights = [
  "Deterministic Financial Runway Models",
  "Live Razorpay Test Payment Recovery Links",
  "Honest Qwen AI Ledger Diagnostics Narration",
];

const fieldClass =
  "w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm outline-none transition-colors duration-200 focus:border-indigo-500 focus:bg-white focus:ring-4 focus:ring-indigo-50 text-slate-800 font-semibold placeholder:text-slate-400 placeholder:font-medium";

export default function Login() {
  const router = useRouter();
  const { user, login } = useCashPilot();

  // Mode state: "SIGN_IN" | "SIGN_UP"
  const [mode, setMode] = useState<"SIGN_IN" | "SIGN_UP">("SIGN_IN");

  // Form inputs
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // Form error and loading states
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Redirect if already authenticated
  useEffect(() => {
    if (user) {
      router.push("/dashboard");
    }
  }, [user, router]);

  // Listen to message events from the popup Google account chooser
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
        } catch (e) {
          setError("Google authentication sync failed.");
        }
      }
    };
    window.addEventListener("message", handleGoogleMessage);
    return () => window.removeEventListener("message", handleGoogleMessage);
  }, [login, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Basic Validations
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
      const payload = mode === "SIGN_UP"
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
      setError("Unable to connect to auth server.");
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
    <div className="min-h-screen flex bg-[var(--background)]">
      {/* Left side: Premium Branding Panel */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-indigo-950 via-indigo-800 to-indigo-600 text-white p-12 flex-col justify-between relative overflow-hidden">
        {/* Abstract background art */}
        <div className="absolute inset-0 bg-grid-dot opacity-40" />
        <div className="absolute top-0 right-0 w-[28rem] h-[28rem] bg-indigo-400 rounded-full opacity-20 blur-3xl transform translate-x-32 -translate-y-32 animate-float-slow" />
        <div
          className="absolute bottom-0 left-0 w-[28rem] h-[28rem] bg-indigo-950 rounded-full opacity-40 blur-3xl transform -translate-x-24 translate-y-24 animate-float-slow"
          style={{ animationDelay: "-4s" }}
        />

        {/* Logo */}
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE_OUT_EXPO }}
          className="flex items-center gap-3 relative z-10"
        >
          <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center backdrop-blur-md border border-white/10">
            <PilotIcon className="w-6 h-6 text-white" />
          </div>
          <div>
            <span className="font-black text-xl tracking-tight block">CashPilot</span>
            <span className="text-[10px] uppercase font-bold tracking-widest text-indigo-200 block -mt-1">
              Cash Intervention Controller
            </span>
          </div>
        </motion.div>

        {/* Hero Illustration details */}
        <Stagger className="my-auto max-w-md space-y-6 relative z-10" stagger={0.09} delayChildren={0.1}>
          <StaggerItem>
            <span className="text-xs uppercase font-extrabold bg-white/10 px-3 py-1 rounded-full text-indigo-100 backdrop-blur-md tracking-wider inline-block border border-white/10">
              Razorpay Buildathon MVP
            </span>
          </StaggerItem>
          <StaggerItem>
            <h1 className="text-4xl font-black leading-tight tracking-tight">
              Stop cash crises before they interrupt your payroll.
            </h1>
          </StaggerItem>
          <StaggerItem>
            <p className="text-indigo-100 text-sm leading-relaxed font-semibold">
              CashPilot connects to your business bank accounts and payment ledgers to forecast liquidity, scan timing
              gaps, and initiate recovery links in one click.
            </p>
          </StaggerItem>

          <StaggerItem className="space-y-4 pt-4">
            {highlights.map((h) => (
              <div key={h} className="flex items-center gap-3">
                <div className="w-5 h-5 rounded bg-white/20 flex items-center justify-center flex-shrink-0">
                  <ShieldCheck className="w-3.5 h-3.5 text-white" />
                </div>
                <span className="text-xs font-bold text-indigo-100">{h}</span>
              </div>
            ))}
          </StaggerItem>
        </Stagger>

        {/* Bottom footer */}
        <div className="text-xs text-indigo-200 font-medium relative z-10">
          © 2026 CashPilot. Protected by human-in-the-loop validation protocol.
        </div>
      </div>

      {/* Right side: Interactive Form Card */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-6 sm:p-12">
        <Reveal
          className="max-w-md w-full bg-white p-8 rounded-3xl border border-slate-200/80 shadow-xl shadow-slate-200/60 space-y-6"
          variants={{
            hidden: { opacity: 0, y: 16, scale: 0.98 },
            show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.5, ease: EASE_OUT_EXPO } },
          }}
        >
          <div className="text-center">
            <div className="lg:hidden flex items-center justify-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center">
                <PilotIcon className="w-5 h-5 text-white" />
              </div>
              <span className="font-black text-lg text-slate-800">CashPilot</span>
            </div>

            <AnimatePresence mode="wait">
              <motion.div
                key={mode}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.25, ease: EASE_OUT_EXPO }}
              >
                <h2 className="text-2xl font-black text-slate-800 tracking-tight">
                  {mode === "SIGN_IN" ? "Sign in to your Dashboard" : "Create your CashPilot Account"}
                </h2>
                <p className="text-slate-400 text-xs font-semibold mt-1">
                  {mode === "SIGN_IN"
                    ? "Enter your credentials to manage corporate cash diagnostics."
                    : "Register your business details to seed the financial runway simulator."}
                </p>
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Sign In with Google Button */}
          <button
            type="button"
            onClick={handleGoogleSignIn}
            className="w-full py-3 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 text-slate-700 rounded-2xl text-sm font-bold shadow-sm transition-colors duration-200 flex items-center justify-center gap-2.5 outline-none"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24">
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

          {/* Divider */}
          <div className="flex items-center justify-between gap-4 py-1 text-slate-300 font-bold uppercase tracking-widest text-[9px]">
            <div className="h-px bg-slate-100 flex-grow" />
            <span>Or use email</span>
            <div className="h-px bg-slate-100 flex-grow" />
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                  animate={{ opacity: 1, height: "auto", marginBottom: 0 }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.25, ease: EASE_OUT_EXPO }}
                  className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs font-semibold text-red-600 overflow-hidden"
                >
                  {error}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Name (Sign up only) */}
            <AnimatePresence initial={false}>
              {mode === "SIGN_UP" && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.3, ease: EASE_OUT_EXPO }}
                  className="overflow-hidden"
                >
                  <div className="space-y-1 pb-0.5">
                    <label className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">
                      Full Name
                    </label>
                    <div className="relative">
                      <User className="absolute left-3.5 top-3.5 w-4 h-4 text-slate-400" />
                      <input
                        type="text"
                        required
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

            {/* Email */}
            <div className="space-y-1">
              <label className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-3.5 w-4 h-4 text-slate-400" />
                <input
                  type="email"
                  required
                  placeholder="name@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={fieldClass}
                />
              </div>
            </div>

            {/* Business Name */}
            <div className="space-y-1">
              <label className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">
                Business Name
              </label>
              <div className="relative">
                <Briefcase className="absolute left-3.5 top-3.5 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  required
                  placeholder="e.g. ABC Electronics Ltd"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  className={fieldClass}
                />
              </div>
            </div>

            {/* Password */}
            <div className="space-y-1">
              <label className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-3.5 w-4 h-4 text-slate-400" />
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={clsx(fieldClass, "pr-10")}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((p) => !p)}
                  className="absolute right-3.5 top-3.5 text-slate-400 hover:text-slate-600 outline-none"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Submit */}
            <Button type="submit" variant="primary" size="lg" loading={isLoading} className="mt-2 w-full">
              {!isLoading && (
                <>
                  {mode === "SIGN_IN" ? "Access Dashboard" : "Register & Seed Demo"}
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </Button>
          </form>

          {/* Toggle link */}
          <div className="text-center pt-2">
            <button
              onClick={toggleMode}
              className="text-xs text-indigo-600 font-bold hover:underline outline-none"
            >
              {mode === "SIGN_IN" ? "Don't have an account? Sign Up" : "Already have an account? Sign In"}
            </button>
          </div>
        </Reveal>
      </div>
    </div>
  );
}
