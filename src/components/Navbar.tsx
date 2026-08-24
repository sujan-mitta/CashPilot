"use client";

import React, { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { useCashPilot } from "@/context/CashPilotContext";
import { PilotIcon } from "./PilotIcon";
import { Check, ChevronDown, LogOut } from "lucide-react";
import { initialsOf } from "@/lib/format";
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

  // Navigation Guard: Redirect if no session exists (after mount to avoid SSR flashes).
  // Re-checked on every route change since the Navbar now lives at the layout level
  // and persists across navigations instead of remounting per page.
  useEffect(() => {
    const checkUser = localStorage.getItem("cashpilot_user");
    if (!checkUser) {
      router.push("/login");
    }
  }, [router, pathname]);

  useEffect(() => {
    if (user) {
      fetch("/api/auth/businesses")
        .then((res) => {
          if (res.ok) return res.json();
          return { businesses: [] };
        })
        .then((data) => {
          if (data?.businesses) {
            setBusinesses(data.businesses);
          }
        })
        .catch(() => {});
    }
  }, [user]);

  const handleSwitchBusiness = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const businessId = e.target.value;
    if (!businessId || businessId === user?.businessId) return;

    try {
      const res = await fetch("/api/auth/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId }),
      });
      const data = await res.json();
      if (res.ok) {
        // Update user session in context
        login(data.user);
        // Reload page to re-fetch business data
        window.location.reload();
      } else {
        alert("Failed to switch business: " + (data.error || "Access denied"));
      }
    } catch {
      alert("Failed to switch business.");
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
    <header className="sticky top-0 z-50 bg-white/85 backdrop-blur-xl border-b border-slate-200/70">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 gap-4">
          {/* Logo */}
          <button
            onClick={() => router.push("/dashboard")}
            className="flex items-center gap-2.5 text-left outline-none group flex-shrink-0"
          >
            <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center shadow-sm shadow-indigo-200 transition-shadow duration-300 group-hover:shadow-md group-hover:shadow-indigo-300">
              <PilotIcon className="w-5 h-5 text-white" />
            </span>
            <span className="flex items-center gap-2">
              <span className="font-black text-lg tracking-tight text-slate-900">CashPilot</span>
              <span className="hidden sm:inline text-[9px] bg-indigo-50 text-indigo-700 font-bold px-1.5 py-0.5 rounded-md tracking-wide uppercase">
                Agent v1.0
              </span>
            </span>
          </button>

          {/* Stepper progress indicator */}
          {activeStep > 0 && (
            <nav className="hidden md:flex items-center" aria-label="Intervention workflow progress">
              {steps.map((s, idx) => {
                const isCurrent = s.num === activeStep;
                const isPast = s.num < activeStep;

                return (
                  <React.Fragment key={s.num}>
                    <div className="relative flex items-center gap-2 py-1.5 pl-1.5 pr-3.5 rounded-full">
                      {isCurrent && (
                        <motion.span
                          layoutId="nav-step-pill"
                          className="absolute inset-0 bg-indigo-600 rounded-full"
                          transition={{ type: "spring", stiffness: 380, damping: 32 }}
                        />
                      )}
                      <span
                        className={clsx(
                          "relative z-10 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black transition-colors duration-300",
                          {
                            "bg-white text-indigo-600": isCurrent,
                            "bg-emerald-500 text-white": isPast,
                            "bg-slate-100 text-slate-400": !isCurrent && !isPast,
                          }
                        )}
                      >
                        {isPast ? <Check className="w-3 h-3" strokeWidth={3} /> : s.num}
                      </span>
                      <span
                        className={clsx(
                          "relative z-10 text-xs font-bold whitespace-nowrap transition-colors duration-300",
                          {
                            "text-white": isCurrent,
                            "text-emerald-700": isPast,
                            "text-slate-400": !isCurrent && !isPast,
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
                          isPast ? "bg-emerald-300" : "bg-slate-200"
                        )}
                      />
                    )}
                  </React.Fragment>
                );
              })}
            </nav>
          )}

          <div className="flex items-center gap-3 flex-shrink-0">
            {/* Clickable Avatar profile trigger */}
            <button
              onClick={() => router.push("/profile")}
              className="flex items-center gap-2.5 text-left hover:opacity-85 transition outline-none group"
            >
              <div className="w-8 h-8 rounded-xl bg-indigo-50 group-hover:bg-indigo-100 border border-indigo-100 flex items-center justify-center text-xs font-black text-indigo-700 transition-colors duration-200">
                {initials}
              </div>
              <div className="text-right hidden sm:block">
                <span className="text-[9px] uppercase font-extrabold text-slate-400 block tracking-wider leading-none">
                  {operatorName}
                </span>
                {businesses.length > 1 ? (
                  <div className="relative mt-0.5">
                    <select
                      value={user?.businessId}
                      onChange={handleSwitchBusiness}
                      className="text-xs font-bold text-slate-700 block max-w-[150px] truncate bg-transparent border-none outline-none cursor-pointer focus:ring-0 focus:text-indigo-600 transition p-0 pr-3.5 leading-none select-none text-right appearance-none"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {businesses.map((b) => (
                        <option key={b.id} value={b.id} className="text-left font-semibold text-slate-700">
                          {b.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="w-2.5 h-2.5 text-slate-400 absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none" />
                  </div>
                ) : (
                  <span className="text-xs font-bold text-slate-700 block max-w-[120px] truncate mt-0.5">
                    {businessName}
                  </span>
                )}
              </div>
            </button>

            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={handleLogout}
              title="Sign Out"
              className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-colors duration-200 outline-none"
            >
              <LogOut className="w-4 h-4" />
            </motion.button>
          </div>
        </div>
      </div>
    </header>
  );
}
