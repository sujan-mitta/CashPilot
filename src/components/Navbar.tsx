"use client";

import React, { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { useCashPilot } from "@/context/CashPilotContext";
import { useStanding } from "@/lib/useStanding";
import { isPlanStale } from "@/lib/planStaleness";
import { PilotIcon } from "./PilotIcon";
import { ThemeToggle } from "./ThemeToggle";
import { NotificationCenter } from "./NotificationCenter";
import { Check, ChevronDown, LogOut, Scale, Users } from "lucide-react";
import { initialsOf } from "@/lib/format";
import { errorMessage } from "@/lib/errors";
import { useToast } from "./ui/Toast";
import clsx from "clsx";

/**
 * Step names are written for someone who has never used the product.
 *
 * The previous set ("Your cash forecast", "Root Investigation", "Human Gate",
 * "Action Execution") described the ENGINE. These describe what the person is
 * about to do, which is what a stepper is for. `route` is what makes a
 * completed step navigable.
 */
const steps = [
  { num: 1, label: "See the problem", route: "/dashboard" },
  { num: 2, label: "Find the cause", route: "/investigation" },
  { num: 3, label: "Compare fixes", route: "/strategies" },
  { num: 4, label: "Approve", route: "/approval" },
  { num: 5, label: "Run it", route: "/execution" },
];

export function Navbar({ activeStep }: { activeStep: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, login, logout, selectedStrategyId, cachedStrategies } = useCashPilot();

  /**
   * Has money arrived since the plan these ticks describe was built?
   *
   * The completed steps promise "this is settled, you can go back and look".
   * After a payment lands that promise is false — the figures those steps were
   * reasoned from have moved — and a green tick is the strongest possible
   * signal that nothing is wrong. Left alone it invites approving a plan built
   * on superseded numbers, which is a real mistake rather than a cosmetic one.
   *
   * The comparison is exact: a settlement timestamp later than the plan's own
   * creation time. Nothing is inferred, so a plan that genuinely predates
   * nothing stays green.
   */
  const { standing } = useStanding();
  const planIsStale = isPlanStale(standing, cachedStrategies, selectedStrategyId);
  const { toast } = useToast();
  const [businesses, setBusinesses] = React.useState<{ id: string; name: string }[]>([]);

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
        // Blunt, and deliberately kept that way: every in-memory figure in the
        // app belongs to the previous tenant and none of it may survive.
        window.location.reload();
      } else {
        toast({
          tone: "danger",
          title: "Could not switch business",
          description: `${data.error || "Access denied."} You are still viewing ${businessName}.`,
        });
      }
    } catch (err) {
      toast({
        tone: "danger",
        title: "Could not switch business",
        description: `${errorMessage(err)} You are still viewing ${businessName}.`,
      });
    }
  };

  const handleLogout = () => {
    logout();
    router.push("/login");
  };

  // NEVER fall back to a name.
  //
  // These read `user?.businessName || "ABC Electronics Pvt Ltd"` and
  // `user?.name || "Aryan Mittal"`, so during the mount gap - before the
  // session is read - every operator was shown a different company's name and
  // an invented person. On a product whose whole job is telling you about YOUR
  // money, displaying the wrong tenant even briefly is not cosmetic. An empty
  // identity renders as a placeholder instead.
  const businessName = user?.businessName ?? "";
  const operatorName = user?.name ?? "";
  const initials = operatorName ? initialsOf(operatorName) : "";
  const identityReady = Boolean(user);

  const currentStep = steps.find((s) => s.num === activeStep);

  return (
    <header className="sticky top-0 z-50 glass border-b border-line-soft">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 gap-4">
          {/* ── Mark ─────────────────────────────────────────────────── */}
          <button
            onClick={() => router.push("/dashboard")}
            className="flex items-center gap-2.5 text-left group shrink-0 rounded-md focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <motion.span
              whileHover={{ rotate: 8, scale: 1.06 }}
              transition={{ type: "spring", stiffness: 400, damping: 18 }}
              className="w-9 h-9 rounded-md bg-brand-500 flex items-center justify-center"
            >
              <PilotIcon className="w-[18px] h-[18px] text-white" />
            </motion.span>
            <span className="hidden sm:flex items-center gap-2">
              <span className="font-semibold text-[1.05rem] tracking-[-0.03em] text-ink-100">
                CashPilot
              </span>
            </span>
          </button>

          {/* ── Workflow stepper ──────────────────────────────────────
              The pill is a shared layoutId, so moving between steps
              animates the highlight across rather than cross-fading it —
              which is what makes the five stages read as one progression.

              Completed steps are real buttons: the checkmark promises you
              can go back and look, so it has to be true. Future steps stay
              inert, which keeps the flow strictly forward. */}
          {activeStep > 0 && (
            <nav
              className="hidden lg:flex items-center"
              aria-label="Progress through the intervention"
            >
              {steps.map((s, idx) => {
                const isCurrent = s.num === activeStep;
                const isPast = s.num < activeStep;
                const Tag = isPast ? "button" : "div";

                return (
                  <React.Fragment key={s.num}>
                    <Tag
                      {...(isPast
                        ? {
                            onClick: () => router.push(s.route),
                            title: planIsStale
                              ? `Step ${s.num}: ${s.label} — the figures behind this changed after a payment arrived. Start again from the dashboard.`
                              : `Back to step ${s.num}: ${s.label}`,
                            type: "button" as const,
                          }
                        : {})}
                      className={clsx(
                        "relative flex items-center gap-2 py-1.5 pl-1.5 pr-3.5 rounded-full focus-visible:ring-2 focus-visible:ring-brand-500",
                        isPast && "hover:bg-ground-200 transition-colors cursor-pointer"
                      )}
                      aria-current={isCurrent ? "step" : undefined}
                    >
                      {isCurrent && (
                        <motion.span
                          layoutId="nav-step-pill"
                          className="absolute inset-0 rounded-full bg-brand-500"
                          transition={{ type: "spring", stiffness: 380, damping: 32 }}
                        />
                      )}
                      <span
                        className={clsx(
                          "relative z-10 w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-semibold transition-colors duration-300",
                          {
                            "bg-white text-brand-600": isCurrent,
                            // A completed step whose figures have been overtaken
                            // is no longer a reassurance, so it stops looking
                            // like one.
                            "bg-safe-500/20 text-safe-400 ring-1 ring-inset ring-safe-500/40":
                              isPast && !planIsStale,
                            "bg-warn-500/20 text-warn-400 ring-1 ring-inset ring-warn-500/40":
                              isPast && planIsStale,
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
                            "text-safe-400": isPast && !planIsStale,
                            "text-warn-400": isPast && planIsStale,
                            "text-ink-400": !isCurrent && !isPast,
                          }
                        )}
                      >
                        {s.label}
                      </span>
                    </Tag>
                    {idx < steps.length - 1 && (
                      <span
                        className={clsx(
                          "h-px w-3 mx-0.5 rounded-full transition-colors duration-500",
                          isPast
                            ? planIsStale
                              ? "bg-warn-500/40"
                              : "bg-safe-500/40"
                            : "bg-line-soft"
                        )}
                      />
                    )}
                  </React.Fragment>
                );
              })}
            </nav>
          )}

          {/* ── Operator ─────────────────────────────────────────────── */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {/* Review queues.
                Both of these existed as routes nobody could reach — the merge
                screen and the conflict screen had to be typed as URLs. A review
                queue nobody can find is a review queue nobody works through,
                and both hold decisions only a human is allowed to make. */}
            <button
              onClick={() => router.push("/conflicts")}
              title="Source disagreements needing your decision"
              aria-label="Source disagreements needing your decision"
              className="hidden sm:flex p-2 rounded-md text-ink-400 hover:text-ink-100 hover:bg-ground-200 transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <Scale className="w-4 h-4" />
            </button>
            <button
              onClick={() => router.push("/counterparties")}
              title="Possible duplicate counterparties"
              aria-label="Possible duplicate counterparties"
              className="hidden sm:flex p-2 rounded-md text-ink-400 hover:text-ink-100 hover:bg-ground-200 transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <Users className="w-4 h-4" />
            </button>

            <NotificationCenter />
            <ThemeToggle />

            {/* The profile link and the business switcher are SIBLINGS.
                A <select> nested inside a <button> is invalid HTML, and the
                e.stopPropagation() that used to hold it together did not help
                keyboard users: tabbing to the select and pressing Enter fired
                the surrounding button and navigated away mid-switch.

                The switcher is also no longer `hidden md:block`. Below 768px a
                multi-business operator could neither switch tenants nor even
                SEE which one they were looking at - on a screen full of that
                tenant's money. */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => router.push("/profile")}
                className="flex items-center gap-2.5 text-left rounded-md px-1.5 py-1 hover:bg-ground-200 transition-colors duration-200 group focus-visible:ring-2 focus-visible:ring-brand-500"
                aria-label={operatorName ? `Profile for ${operatorName}` : "Your profile"}
              >
                <div className="w-8 h-8 rounded-md bg-brand-500/12 ring-1 ring-inset ring-brand-500/25 flex items-center justify-center text-[11px] font-semibold text-brand-300 group-hover:ring-brand-500/45 transition-all duration-200">
                  {identityReady ? initials : <span className="sr-only">Loading</span>}
                </div>
                <div className="text-right hidden md:block">
                  <span className="text-[11px] font-medium text-ink-400 block leading-none">
                    {identityReady ? operatorName : "\u00a0"}
                  </span>
                  {businesses.length <= 1 && (
                    <span className="text-[11.5px] font-medium text-ink-200 block max-w-[130px] truncate mt-1">
                      {identityReady ? businessName : "\u00a0"}
                    </span>
                  )}
                </div>
              </button>

              {businesses.length > 1 && (
                <div className="relative">
                  <label htmlFor="cp-business-switch" className="sr-only">
                    Switch business
                  </label>
                  <select
                    id="cp-business-switch"
                    value={user?.businessId ?? ""}
                    onChange={handleSwitchBusiness}
                    className="text-[11.5px] font-medium text-ink-200 max-w-[110px] sm:max-w-[150px] truncate bg-transparent border border-line-soft rounded-md cursor-pointer hover:text-brand-300 transition py-1 pl-2 pr-5 leading-none appearance-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    {businesses.map((b) => (
                      <option key={b.id} value={b.id} className="text-left bg-ground-200 text-ink-200">
                        {b.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-2.5 h-2.5 text-ink-500 absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              )}
            </div>

            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={handleLogout}
              title="Sign out"
              aria-label="Sign out"
              className="p-2 text-ink-400 hover:text-risk-400 hover:bg-risk-500/10 rounded-md transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <LogOut className="w-4 h-4" />
            </motion.button>
          </div>
        </div>
      </div>

      {/* ── Compact progress, below lg ────────────────────────────────
          The full stepper is hidden under 1024px, which left tablet and
          phone users with no sense of position at all in a five-step flow
          whose entire premise is knowing where you are. */}
      {activeStep > 0 && currentStep && (
        <div className="lg:hidden border-t border-line-faint px-4 sm:px-6 py-2 flex items-center gap-3">
          <span className="label shrink-0">
            Step {activeStep} of {steps.length}
          </span>
          <span className="text-[12px] font-medium text-ink-200 truncate">{currentStep.label}</span>
          <div className="ml-auto flex items-center gap-1 shrink-0" aria-hidden>
            {steps.map((s) => (
              <span
                key={s.num}
                className={clsx(
                  "h-1 rounded-full transition-all duration-300",
                  s.num === activeStep
                    ? "w-5 bg-brand-500"
                    : s.num < activeStep
                    ? "w-1.5 bg-safe-500/60"
                    : "w-1.5 bg-line-firm"
                )}
              />
            ))}
          </div>
        </div>
      )}
    </header>
  );
}
