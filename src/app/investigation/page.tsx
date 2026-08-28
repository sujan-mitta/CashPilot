"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useCashPilot } from "@/context/CashPilotContext";
import { formatINR } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { Reveal, Stagger, StaggerItem } from "@/components/ui/Reveal";
import { EASE_OUT_EXPO } from "@/components/ui/motion";
import { ChevronDown, ArrowLeft, ArrowRight, ShieldCheck, Lightbulb, AlertTriangle } from "lucide-react";
import clsx from "clsx";
import { errorMessage } from "@/lib/errors";

export default function Investigation() {
  const router = useRouter();
  const { cachedInvestigation, setCachedInvestigation, cachedForecast } = useCashPilot();

  const [loading, setLoading] = useState(!cachedInvestigation);
  const [error, setError] = useState<string | null>(null);

  // Track which root cause card is expanded
  const [expandedCauseId, setExpandedCauseId] = useState<string | null>(null);
  const [fetchedDays, setFetchedDays] = useState<{ openingBalance: number; expectedInflows: number; expectedOutflows: number }[]>([]);

  useEffect(() => {
    if (cachedForecast?.forecast?.days?.length) return;
    let cancelled = false;
    fetch("/api/forecast")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.forecast?.days?.length) setFetchedDays(data.forecast.days);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cachedForecast]);

  const fetchInvestigation = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/investigate", { method: "POST" });
      if (!res.ok) {
        throw new Error("Unable to retrieve diagnostic details.");
      }
      const data = await res.json();
      setCachedInvestigation(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // Run the diagnostic once when there is no cached result. Inlined and started
  // with the await (loading already initialises from the cache) so the effect
  // body sets no state synchronously; the retry button still uses
  // fetchInvestigation, where a synchronous setState is fine.
  useEffect(() => {
    if (cachedInvestigation) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/investigate", { method: "POST" });
        if (!res.ok) throw new Error("Unable to retrieve diagnostic details.");
        const data = await res.json();
        if (!cancelled) setCachedInvestigation(data);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [cachedInvestigation, setCachedInvestigation]);

  const toggleExpand = (id: string) => {
    setExpandedCauseId((prev) => (prev === id ? null : id));
  };

  if (loading) {
    return (
      <main className="flex-1 max-w-4xl mx-auto px-6 py-10 w-full space-y-8">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-28 rounded-md" />
        <Skeleton className="h-40 rounded-md" />
        <Skeleton className="h-80 rounded-md" />
      </main>
    );
  }

  if (error || !cachedInvestigation) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <Card className="max-w-md border-risk-500/25 bg-risk-500/10">
          <AlertTriangle className="w-12 h-12 text-risk-400 mx-auto mb-4" />
          <h2 className="text-lg font-bold text-risk-400">Diagnostic investigation failed</h2>
          <p className="text-risk-400 text-xs mt-2 leading-relaxed font-semibold">
            {error || "AI narrative service or connection pool is temporarily unavailable."}
          </p>
          <Button variant="danger" size="lg" onClick={fetchInvestigation} className="mt-6 w-full">
            Retry Diagnostic
          </Button>
        </Card>
      </main>
    );
  }

  const { summary, causes, opportunities, aiNarrative } = cachedInvestigation;

  // Reconciled numbers formatting
  const deficit = Math.abs(summary.projectedDeficit);
  const crisisDayText = summary.crisisDay ? `Day ${summary.crisisDay}` : "None";

  // Every figure below is derived from this business's own forecast. They were
  // previously hardcoded to the seed dataset, so any other business was shown
  // somebody else's balance sheet as if it were their own.
  // Same recovery as the approval screen: these figures live only in the
  // in-memory cache, so a refresh or a shared link rendered the whole causal
  // chain as "Unavailable". /api/forecast holds exactly this data.
  const forecastDays = cachedForecast?.forecast?.days ?? fetchedDays;
  const startingCash = forecastDays[0]?.openingBalance ?? null;
  const committedInflows = forecastDays.reduce(
    (sum, d) => sum + (d.expectedInflows ?? 0),
    0
  );
  const upcomingObligations = forecastDays.reduce(
    (sum, d) => sum + (d.expectedOutflows ?? 0),
    0
  );
  const availableLiquidity =
    startingCash === null ? null : startingCash + committedInflows;

  // "Unavailable" is the honest rendering of a figure we do not have. Showing
  // ₹0 would be a claim about the business's cash, not an absence of one.
  const money = (v: number | null) => (v === null ? "Unavailable" : formatINR(v));

  const causalMap = [
    { label: "Cash you start with", value: money(startingCash), tone: "bg-ground-200 border-line-soft text-ink-200" },
    { label: "Money due in", value: forecastDays.length ? `+${formatINR(committedInflows)}` : "Unavailable", tone: "bg-safe-500/10 border-safe-500/25 text-safe-400" },
    { label: "Total available", value: money(availableLiquidity), tone: "bg-brand-500/10 border-brand-500/25 text-brand-300" },
    { label: "Money you owe", value: forecastDays.length ? `-${formatINR(upcomingObligations)}` : "Unavailable", tone: "bg-risk-500/10 border-risk-500/25 text-risk-400" },
  ];

  return (
    <main className="flex-1 max-w-4xl mx-auto px-6 py-10 w-full space-y-8">
      {/* Navigation Breadcrumb */}
      <Reveal className="flex items-center justify-between">
        <button
          onClick={() => router.push("/dashboard")}
          className="flex items-center gap-1.5 text-xs font-bold text-ink-300 hover:text-ink-200 transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Dashboard
        </button>
        <span className="label block">
          {causes.length} causes found
        </span>
      </Reveal>

      <Stagger className="space-y-8" stagger={0.08}>
        {/* SECTION B — Crisis Summary */}
        <StaggerItem>
          <Card padding="md" className="rounded-md grid grid-cols-1 sm:grid-cols-3 gap-6 items-center">
            <div>
              <span className="label block mb-1">
                How much you will be short
              </span>
              <span className="text-3xl font-semibold text-risk-400 block">
                {formatINR(deficit)}
              </span>
              <span className="text-[11px] text-ink-400 font-semibold mt-1 block">
                The gap you need to close
              </span>
            </div>

            <div className="border-t sm:border-t-0 sm:border-l sm:border-r border-line-faint py-4 sm:py-0 sm:px-6">
              <span className="label block mb-1">
                When it happens
              </span>
              <span className="text-xl font-semibold text-ink-100 block">
                {crisisDayText}
              </span>
              <span className="text-[11px] text-ink-400 font-semibold mt-1.5 block">
                First day your balance goes negative
              </span>
            </div>

            <div>
              <span className="label block mb-1">
                How serious
              </span>
              <Badge tone="danger">{summary.riskLevel} Risk</Badge>
              <span className="text-[11px] text-ink-400 font-semibold mt-2.5 block leading-relaxed">
                Based on payments already committed — not estimates.
              </span>
            </div>
          </Card>
        </StaggerItem>

        {/* SECTION C — AI Diagnostic Narrative */}
        <StaggerItem>
          <Card className="rounded-md border-brand-500/25 border-l-4 border-l-indigo-600 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-3 bg-brand-500/10 text-brand-300 rounded-bl-2xl font-bold text-[11px]">
              AI summary
            </div>
            <h3 className="text-[11px] font-semibold text-brand-300 mb-3 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4" /> What this means
            </h3>
            <p className="text-ink-200 text-sm leading-relaxed font-semibold italic">
              &ldquo;{aiNarrative}&rdquo;
            </p>
          </Card>
        </StaggerItem>

        {/* SECTION D — Root Cause Ranking (with SECTION E Expandable Evidence) */}
        <StaggerItem className="space-y-4">
          <h3 className="text-xs font-bold text-ink-400 block pl-1">
            What is causing this, and what you can do
          </h3>

          {causes.map((cause) => {
            const isExpanded = expandedCauseId === cause.id;

            return (
              <Card key={cause.id} padding="none" className="rounded-md overflow-hidden">
                {/* Header Row */}
                <div
                  onClick={() => toggleExpand(cause.id)}
                  className="p-5 flex items-center justify-between cursor-pointer hover:bg-ground-200/70 transition-colors duration-150 select-none"
                >
                  <div className="flex items-center gap-4">
                    <span className="text-lg font-semibold text-ink-400">0{cause.rank}</span>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-ink-100 tracking-tight">
                          {cause.title}
                        </span>
                        <Badge tone={cause.classification === "ROOT_CAUSE" ? "danger" : "brand"} size="xs">
                          {cause.classification === "ROOT_CAUSE" ? "Root Cause" : "Opportunity"}
                        </Badge>
                      </div>
                      <span className="text-xs text-ink-400 font-semibold mt-0.5 block">
                        {cause.deterministicExplanation}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <span className="text-md font-semibold text-ink-100">
                      {formatINR(cause.amount)}
                    </span>
                    <button className="text-ink-400 hover:text-ink-300 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050">
                      <ChevronDown className={clsx("w-4 h-4 transition-transform duration-300", isExpanded && "rotate-180")} />
                    </button>
                  </div>
                </div>

                {/* SECTION E — Expandable Evidence Details */}
                <AnimatePresence initial={false}>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3, ease: EASE_OUT_EXPO }}
                      className="overflow-hidden"
                    >
                      <div className="bg-ground-200/60 border-t border-line-faint p-5 space-y-4">
                        {/* Cause 1: Timing mismatch evidence */}
                        {cause.type === "TIMING_MISMATCH" && (
                          <div className="space-y-3">
                            <span className="label block">
                              Money in versus money out
                            </span>
                            <div className="space-y-2 max-h-52 overflow-y-auto">
                              {(cause.evidence.events ?? []).map((e, idx: number) => {
                                const isNegative = e.amount < 0;
                                const isPayroll = e.description.toLowerCase().includes("payroll");
                                const isSupplier = e.description.toLowerCase().includes("supplier");

                                return (
                                  <div
                                    key={idx}
                                    className="flex items-center justify-between text-xs py-1.5 border-b border-line-faint last:border-0"
                                  >
                                    <span className="text-ink-300 font-semibold">
                                      {new Date(e.expectedDate).toLocaleDateString("en-IN", {
                                        day: "2-digit",
                                        month: "short",
                                      })}
                                    </span>
                                    <div className="flex-1 px-4 flex items-center gap-2">
                                      <span className="text-ink-200 font-semibold">{e.description}</span>
                                      {(isPayroll || isSupplier) && (
                                        <Badge tone="danger" size="xs">High Criticality</Badge>
                                      )}
                                    </div>
                                    <span className={clsx("font-semibold", isNegative ? "text-risk-400" : "text-safe-400")}>
                                      {isNegative ? "-" : "+"}
                                      {formatINR(Math.abs(e.amount))}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                            {(() => {
                              const inflows = (cause.evidence.events ?? []).filter((e) => e.amount > 0).reduce((sum, e) => sum + e.amount, 0);
                              const outflows = (cause.evidence.events ?? []).filter((e) => e.amount < 0).reduce((sum, e) => sum + e.amount, 0);
                              const timingGap = inflows + outflows;
                              return (
                                <div className="pt-2 border-t border-line-soft flex flex-wrap justify-between gap-2 text-xs font-bold text-ink-300">
                                  <span>Money due in: {formatINR(inflows)}</span>
                                  <span>Committed Outflows: {formatINR(Math.abs(outflows))}</span>
                                  <span className="text-risk-400">Projected Shortfall: {formatINR(Math.abs(timingGap))}</span>
                                </div>
                              );
                            })()}
                          </div>
                        )}

                        {/* Cause 2: Failed payment evidence */}
                        {cause.type === "FAILED_PAYMENT" && (
                          <div className="space-y-3">
                            <span className="label block">
                              A payment that failed
                            </span>
                            {(cause.evidence.transactions ?? []).map((tx, idx: number) => (
                              <div
                                key={idx}
                                className="bg-ground-100 border border-line-soft p-4 rounded-md flex items-center justify-between"
                              >
                                <div>
                                  <span className="text-xs font-semibold text-ink-100 block">
                                    {tx.description}
                                  </span>
                                  <span className="text-[11px] text-ink-400 block mt-1">
                                    Was due {new Date(tx.expectedDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                                    <span className="hidden sm:inline"> · ref {tx.id.slice(-8)}</span>
                                  </span>
                                </div>
                                <span className="text-sm font-semibold text-ink-200">{formatINR(tx.amount)}</span>
                              </div>
                            ))}
                            <p className="text-[11px] text-ink-400 font-semibold leading-relaxed flex items-start gap-1.5">
                              <Lightbulb className="w-3.5 h-3.5 text-warn-400 flex-shrink-0 mt-0.5" />
                              <span><strong className="text-ink-300">Why this matters:</strong> This payment failed card processor authorizations and is not included
                              in your committed cash forecast. Recovering it via a dynamic checkout link represents direct,
                              non-disruptive liquidity.</span>
                            </p>
                          </div>
                        )}

                        {/* Cause 3: Overdue invoices evidence */}
                        {cause.type === "OVERDUE_RECEIVABLE" && (
                          <div className="space-y-3">
                            <span className="label block">
                              Invoices past their due date
                            </span>
                            <div className="space-y-2">
                              {(cause.evidence.invoices ?? []).map((inv, idx: number) => {
                                const due = new Date(inv.dueDate);
                                const todayDate = new Date();
                                const diffDays = Math.max(1, Math.round((todayDate.getTime() - due.getTime()) / (1000 * 60 * 60 * 24)));
                                const isHigh = inv.amount >= 30000000;
                                return (
                                  <div
                                    key={idx}
                                    className="bg-ground-100 border border-line-soft p-3 rounded-md flex items-center justify-between text-xs"
                                  >
                                    <div>
                                      <span className="font-bold text-ink-200 block">{inv.customerName}</span>
                                      <span className="text-[11px] text-ink-400 font-semibold block mt-0.5">
                                        Invoice ID: {inv.id} • Due date:{" "}
                                        {new Date(inv.dueDate).toLocaleDateString("en-IN", {
                                          day: "2-digit",
                                          month: "short",
                                        })}
                                      </span>
                                    </div>
                                    <div className="text-right">
                                      <span className="font-semibold text-ink-200 block">
                                        {formatINR(inv.amount)}
                                      </span>
                                      <Badge tone={isHigh ? "danger" : "warning"} size="xs" className="mt-1">
                                        {diffDays} Days Overdue
                                      </Badge>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            <p className="text-[11px] text-ink-400 font-semibold leading-relaxed flex items-start gap-1.5">
                              <AlertTriangle className="w-3.5 h-3.5 text-warn-400 flex-shrink-0 mt-0.5" />
                              <span><strong className="text-ink-300">Note on collection:</strong> Overdue receivables are marked as potentially acceleratable.
                              They represent customer balances that we can pursue immediately via early-settlement prompts,
                              but are not guaranteed today.</span>
                            </p>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </Card>
            );
          })}
        </StaggerItem>

        {/* SECTION F — Cash Causal Map */}
        <StaggerItem>
          <Card className="rounded-md space-y-6">
            <div>
              <h3 className="text-xs font-bold text-ink-400 block">
                How the shortfall builds up
              </h3>
              <span className="text-[12px] text-ink-400 font-medium">
                How the money you start with turns into the shortfall below.
              </span>
            </div>

            <div className="flex flex-col items-center py-4">
              {causalMap.map((step, idx) => (
                <React.Fragment key={step.label}>
                  <div className={clsx("border px-4 py-2.5 rounded-md text-center w-56", step.tone)}>
                    <span className="text-[12px] block mb-0.5">{step.label}</span>
                    <span className="numeric text-[15px] font-semibold">{step.value}</span>
                  </div>
                  {idx < causalMap.length - 1 && <div className="h-6 w-0.5 bg-brand-500/30 my-1" />}
                </React.Fragment>
              ))}

              {/* Down Arrow into crisis */}
              <div className="h-8 w-0.5 bg-risk-500/45 my-1 relative">
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 border-l-[4px] border-r-[4px] border-t-[6px] border-l-transparent border-r-transparent border-t-red-400" />
              </div>

              {/* Cash Deficit */}
              <div className="bg-risk-500/10 border border-risk-500/25 px-6 py-3 rounded-md text-center w-64">
                <span className="label !text-risk-400 block">
                  {summary.crisisDay ? `Shortfall on day ${summary.crisisDay}` : "Projected shortfall"}
                </span>
                <span className="numeric text-lg font-semibold text-risk-400 mt-1 block">
                  -{formatINR(deficit)}
                </span>
              </div>
            </div>
          </Card>
        </StaggerItem>

        {/* SECTION G — Intervention Opportunities */}
        <StaggerItem>
          <Card className="rounded-md space-y-4">
            <h3 className="text-xs font-bold text-ink-400 block border-b border-line-faint pb-3">
              Cash you could bring in
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-4 bg-ground-200 border border-line-faint rounded-md">
                <span className="label block">
                  From failed payments
                </span>
                <span className="text-lg font-semibold text-ink-100 mt-1 block">
                  {formatINR(opportunities.failedPaymentRecovery)}
                </span>
                <span className="text-[11px] text-ink-400 font-semibold mt-1 block">
                  Card payments that did not go through
                </span>
              </div>

              <div className="p-4 bg-ground-200 border border-line-faint rounded-md">
                <span className="label block">
                  From overdue invoices
                </span>
                <span className="text-lg font-semibold text-ink-100 mt-1 block">
                  {formatINR(opportunities.overdueReceivables)}
                </span>
                <span className="text-[11px] text-ink-400 font-semibold mt-1 block">
                  Invoices you could chase early
                </span>
              </div>
            </div>

            <div className="pt-2 flex items-center justify-between text-xs font-semibold text-ink-200 bg-brand-500/10 p-3 rounded-md">
              <span>Total you could bring in</span>
              <span className="text-sm font-semibold text-brand-300">
                {formatINR(opportunities.totalPotentialLiquidity)}
              </span>
            </div>
          </Card>
        </StaggerItem>

        {/* Action Bottom Nav Links */}
        <StaggerItem className="flex items-center justify-between pt-2">
          <button
            onClick={() => router.push("/dashboard")}
            className="text-xs font-bold text-ink-300 hover:text-ink-200 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050"
          >
            ← Back to Dashboard
          </button>

          <Button variant="primary" size="lg" onClick={() => router.push("/strategies")} className="group">
            See your options
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </Button>
        </StaggerItem>
      </Stagger>
    </main>
  );
}
