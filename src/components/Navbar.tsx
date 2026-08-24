"use client";

import React, { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { useCashPilot } from "@/context/CashPilotContext";
import { PilotIcon } from "./PilotIcon";
import { Check, ChevronDown, LogOut } from "lucide-react";
import { initialsOf } from "@/lib/format";
import { errorMessage } from "@/lib/errors";
import clsx from "clsx";

const steps = [
  { num: 1, label: "Runway Forecast" },
  { num: 2, label: "Root Investigation" },
  { num: 3, label: "Simulate Strategy" },
  { num: 4, label: "Human Gate" },
  { num: 5, label: "Action Execution" },
];

export function Navbar({ activeStep }: { activeStep: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, login, logout } = useCashPilot();
  const [businesses, setBusinesses] = React.useState<{ id: string; name: string }[]>([]);
  const [switchError, setSwitchError] = React.useState<string | null>(null);

  // Navigation guard: redirect if no session exists (after mount, to avoid an
  // SSR flash). Re-checked on every route change, since the Navbar lives at the
  // layout level and persists across navigations instead of remounting.
  useEffect(() => {
    const checkUser = localStorage.getItem("cashpilot_user");
    if (!checkUser) {
      router.push("/login");
    }
  }, [router, pathname]);

  useEffect(() => {
    if (user) {
      fetch("/api/auth/businesses")
        .then((res) => (res.ok ? res.json() : { businesses: [] }))
        .then((data) => {
          if (data?.businesses) setBusinesses(data.businesses);
        })
        .catch(() => {});
    }
  }, [user]);

  const handleSwitchBusiness = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const businessId = e.target.value;
    if (!businessId || businessId === user?.businessId) return;

    setSwitchError(null);
    try {
      const res = await fetch("/api/auth/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId }),
      });
      const data = await res.json();
      if (res.ok) {
        login(data.user);
        // Full reload so every cached figure is re-fetched under the new tenant.
        // Switching business must never leave one business's numbers on screen.
        window.location.reload();
      } else {
        setSwitchError(data.error || "Access denied.");
      }
    } catch (err) {
      setSwitchError(errorMessage(err));
    }
  };

  const handleLogout = () => {
    logout();
    router.push("/login");
  };

  const businessName = user?.businessName || "ABC Electronics Pvt Ltd";
  const operatorName = user?.name || "Aryan Mittal";
  const initials = initialsOf(operatorName);

  return (
    <header className="sticky top-0 z-50 glass border-b border-line-soft">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 gap-4">
          {/* ── Mark ─────────────────────────────────────────────────── */}
          <button
            onClick={() => router.push("/dashboard")}
            className="flex items-center gap-2.5 text-left outline-none group shrink-0 rounded-xl"
          >
            <motion.span
              whileHover={{ rotate: 8, scale: 1.06 }}
              transition={{ type: "spring", stiffness: 400, damping: 18 }}
              className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-400 via-brand-500 to-violet-500 flex items-center justify-center shadow-[0_1px_0_rgb(255_255_255/0.2)_inset,0_6px_18px_-6px_rgb(99_102_241/0.8)]"
            >
              <PilotIcon className="w-[18px] h-[18px] text-white" />
            </motion.span>
            <span className="flex items-center gap-2">
              <span className="font-semibold text-[1.05rem] tracking-[-0.03em] text-ink-100">
                CashPilot
              </span>
              <span className="hidden sm:inline text-[9px] bg-brand-500/12 text-brand-300 ring-1 ring-inset ring-brand-500/25 font-semibold px-1.5 py-0.5 rounded-md tracking-[0.08em] uppercase">
                Agent v1.0
              </span>
            </span>
          </button>

          {/* ── Workflow stepper ──────────────────────────────────────
              The pill is a shared layoutId, so moving between steps
              animates the highlight across rather than cross-fading it —
              which is what makes the five stages read as one progression. */}
          {activeStep > 0 && (
            <nav
              className="hidden lg:flex items-center"
              aria-label="Intervention workflow progress"
            >
              {steps.map((s, idx) => {
                const isCurrent = s.num === activeStep;
                const isPast = s.num < activeStep;

                return (
                  <React.Fragment key={s.num}>
                    <div
                      className="relative flex items-center gap-2 py-1.5 pl-1.5 pr-3.5 rounded-full"
                      aria-current={isCurrent ? "step" : undefined}
                    >
                      {isCurrent && (
                        <motion.span
                          layoutId="nav-step-pill"
                          className="absolute inset-0 rounded-full bg-gradient-to-r from-brand-500 to-brand-600 shadow-[0_0_0_1px_rgb(99_102_241/0.4),0_4px_16px_-4px_rgb(99_102_241/0.7)]"
                          transition={{ type: "spring", stiffness: 380, damping: 32 }}
                        />
                      )}
                      <span
                        className={clsx(
                          "relative z-10 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold transition-colors duration-300",
                          {
                            "bg-white text-brand-600": isCurrent,
                            "bg-safe-500/20 text-safe-400 ring-1 ring-inset ring-safe-500/40":
                              isPast,
                            "bg-ground-200 text-ink-400": !isCurrent && !isPast,
                          }
                        )}
                      >
                        {isPast ? <Check className="w-3 h-3" strokeWidth={3} /> : s.num}
                      </span>
                      <span
                        className={clsx(
                          "relative z-10 text-[11.5px] font-medium whitespace-nowrap transition-colors duration-300",
                          {
                            "text-white": isCurrent,
                            "text-safe-400": isPast,
                            "text-ink-400": !isCurrent && !isPast,
                          }
                        )}
                      >
                        {s.label}
                      </span>
                    </div>
                    {idx < steps.length - 1 && (
                      <span
                        className={clsx(
                          "h-px w-3 mx-0.5 rounded-full transition-colors duration-500",
                          isPast ? "bg-safe-500/40" : "bg-line-soft"
                        )}
                      />
                    )}
                  </React.Fragment>
                );
              })}
            </nav>
          )}

          {/* ── Operator ─────────────────────────────────────────────── */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => router.push("/profile")}
              className="flex items-center gap-2.5 text-left rounded-xl px-1.5 py-1 hover:bg-ground-200 transition-colors duration-200 outline-none group"
            >
              <div className="w-8 h-8 rounded-[10px] bg-brand-500/12 ring-1 ring-inset ring-brand-500/25 flex items-center justify-center text-[11px] font-semibold text-brand-300 group-hover:ring-brand-500/45 transition-all duration-200">
                {initials}
              </div>
              <div className="text-right hidden sm:block">
                <span className="text-[9px] uppercase font-semibold text-ink-400 block tracking-[0.09em] leading-none">
                  {operatorName}
                </span>
                {businesses.length > 1 ? (
                  <div className="relative mt-1">
                    <select
                      value={user?.businessId}
                      onChange={handleSwitchBusiness}
                      className="text-[11.5px] font-medium text-ink-200 block max-w-[150px] truncate bg-transparent border-none outline-none cursor-pointer hover:text-brand-300 focus:text-brand-300 transition p-0 pr-3.5 leading-none text-right appearance-none"
                      onClick={(e) => e.stopPropagation()}
                      aria-label="Switch business"
                    >
                      {businesses.map((b) => (
                        <option key={b.id} value={b.id} className="text-left bg-ground-200 text-ink-200">
                          {b.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="w-2.5 h-2.5 text-ink-500 absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none" />
                  </div>
                ) : (
                  <span className="text-[11.5px] font-medium text-ink-200 block max-w-[130px] truncate mt-1">
                    {businessName}
                  </span>
                )}
              </div>
            </button>

            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={handleLogout}
              title="Sign out"
              aria-label="Sign out"
              className="p-2 text-ink-400 hover:text-risk-400 hover:bg-risk-500/10 rounded-xl transition-colors duration-200 outline-none"
            >
              <LogOut className="w-4 h-4" />
            </motion.button>
          </div>
        </div>
      </div>

      {/* A failed tenant switch used to be an alert(). It belongs in the chrome,
          because the operator needs to know WHICH business they are looking at
          before they read any figure below. */}
      {switchError && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          role="alert"
          className="bg-risk-500/12 border-t border-risk-500/25 text-risk-400 text-[11.5px] font-medium px-6 py-2 text-center"
        >
          Could not switch business — {switchError} You are still viewing{" "}
          <strong className="font-semibold">{businessName}</strong>.
        </motion.div>
      )}
    </header>
  );
}
