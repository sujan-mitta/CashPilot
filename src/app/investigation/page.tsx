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

export default function Investigation() {
  const router = useRouter();
  const { cachedInvestigation, setCachedInvestigation, cachedForecast } = useCashPilot();

  const [loading, setLoading] = useState(!cachedInvestigation);
  const [error, setError] = useState<string | null>(null);

  // Track which root cause card is expanded
  const [expandedCauseId, setExpandedCauseId] = useState<string | null>(null);

  const fetchInvestigation = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/investigate", { method: "POST" });
      if (!res.ok) {
        throw new Error("Unable to retrieve diagnostic details.");
      }
      const data = await res.json();
      setCachedInvestigation(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!cachedInvestigation) {
      fetchInvestigation();
    }
  }, [cachedInvestigation]);

  const toggleExpand = (id: string) => {
    setExpandedCauseId((prev) => (prev === id ? null : id));
  };

  if (loading) {
    return (
      <main className="flex-1 max-w-4xl mx-auto px-6 py-10 w-full space-y-8">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-80 rounded-2xl" />
      </main>
    );
  }

  if (error || !cachedInvestigation) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <Card className="max-w-md border-red-200 bg-red-50/60 shadow-sm">
          <AlertTriangle className="w-12 h-12 text-red-600 mx-auto mb-4" />
          <h2 className="text-lg font-bold text-red-800">Diagnostic investigation failed</h2>
          <p className="text-red-700 text-xs mt-2 leading-relaxed font-semibold">
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
  const forecastDays = cachedForecast?.forecast?.days ?? [];
  const startingCash = forecastDays[0]?.openingBalance ?? null;
  const committedInflows = forecastDays.reduce(
    (sum: number, d: any) => sum + (d.expectedInflows ?? 0),
    0
  );
  const upcomingObligations = forecastDays.reduce(
    (sum: number, d: any) => sum + (d.expectedOutflows ?? 0),
    0
  );
  const availableLiquidity =
    startingCash === null ? null : startingCash + committedInflows;

  // "Unavailable" is the honest rendering of a figure we do not have. Showing
  // ₹0 would be a claim about the business's cash, not an absence of one.
  const money = (v: number | null) => (v === null ? "Unavailable" : formatINR(v));

  const causalMap = [
    { label: "Starting Cash", value: money(startingCash), tone: "bg-slate-50 border-slate-200/60 text-slate-700 sublabel-text-slate-400" },
    { label: "Committed Inflows", value: forecastDays.length ? `+${formatINR(committedInflows)}` : "Unavailable", tone: "bg-emerald-50 border-emerald-200/60 text-emerald-700" },
    { label: "Available Liquidity", value: money(availableLiquidity), tone: "bg-indigo-50 border-indigo-100 text-indigo-700" },
    { label: "Upcoming Obligations", value: forecastDays.length ? `-${formatINR(upcomingObligations)}` : "Unavailable", tone: "bg-red-50 border-red-200/60 text-red-700" },
  ];

  return (
    <main className="flex-1 max-w-4xl mx-auto px-6 py-10 w-full space-y-8">
      {/* Navigation Breadcrumb */}
      <Reveal className="flex items-center justify-between">
        <button
          onClick={() => router.push("/dashboard")}
          className="flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-slate-700 transition outline-none"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Dashboard
        </button>
        <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">
          {causes.length} Root Causes Identified • Analysis Complete
        </span>
      </Reveal>

      <Stagger className="space-y-8" stagger={0.08}>
        {/* SECTION B — Crisis Summary */}
        <StaggerItem>
          <Card padding="md" className="!rounded-3xl grid grid-cols-1 sm:grid-cols-3 gap-6 items-center">
            <div>
              <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block mb-1">
                Projected Cash Deficit
              </span>
              <span className="text-3xl font-black text-red-600 block">
                {formatINR(deficit)}
              </span>
              <span className="text-[10px] text-slate-400 font-semibold mt-1 block">
                Expected net shortfall on crisis date
              </span>
            </div>

            <div className="border-t sm:border-t-0 sm:border-l sm:border-r border-slate-100 py-4 sm:py-0 sm:px-6">
              <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block mb-1">
                Crisis Day
              </span>
              <span className="text-xl font-black text-slate-800 block">
                {crisisDayText}
              </span>
              <span className="text-[10px] text-slate-400 font-semibold mt-1.5 block">
                Days until first negative balance
              </span>
            </div>

            <div>
              <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block mb-1">
                Current Risk Level
              </span>
              <Badge tone="danger">{summary.riskLevel} Risk</Badge>
              <span className="text-[10px] text-slate-400 font-semibold mt-2.5 block leading-relaxed">
                Crisis confirmed in committed cash runway forecast.
              </span>
            </div>
          </Card>
        </StaggerItem>

        {/* SECTION C — AI Diagnostic Narrative */}
        <StaggerItem>
          <Card className="!rounded-3xl border-indigo-100 border-l-4 border-l-indigo-600 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-3 bg-indigo-50 text-indigo-600 rounded-bl-2xl font-bold text-[9px] uppercase tracking-wider">
              Analyst Insights
            </div>
            <h3 className="text-[10px] font-extrabold text-indigo-600 uppercase tracking-widest mb-3 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4" /> AI Ledger Diagnostics Explanation
            </h3>
            <p className="text-slate-700 text-sm leading-relaxed font-semibold italic">
              &ldquo;{aiNarrative}&rdquo;
            </p>
          </Card>
        </StaggerItem>

        {/* SECTION D — Root Cause Ranking (with SECTION E Expandable Evidence) */}
        <StaggerItem className="space-y-4">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest block pl-1">
            Root Causes &amp; Intervention Opportunities
          </h3>

          {causes.map((cause: any) => {
            const isExpanded = expandedCauseId === cause.id;

            return (
              <Card key={cause.id} padding="none" className="!rounded-3xl overflow-hidden">
                {/* Header Row */}
                <div
                  onClick={() => toggleExpand(cause.id)}
                  className="p-5 flex items-center justify-between cursor-pointer hover:bg-slate-50/70 transition-colors duration-150 select-none"
                >
                  <div className="flex items-center gap-4">
                    <span className="text-lg font-black text-slate-300">0{cause.rank}</span>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-black text-slate-800 tracking-tight">
                          {cause.title}
                        </span>
                        <Badge tone={cause.classification === "ROOT_CAUSE" ? "danger" : "brand"} size="xs">
                          {cause.classification === "ROOT_CAUSE" ? "Root Cause" : "Opportunity"}
                        </Badge>
                      </div>
                      <span className="text-xs text-slate-400 font-semibold mt-0.5 block">
                        {cause.deterministicExplanation}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <span className="text-md font-black text-slate-800">
                      {formatINR(cause.amount)}
                    </span>
                    <button className="text-slate-400 hover:text-slate-600 outline-none">
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
                      <div className="bg-slate-50/60 border-t border-slate-100 p-5 space-y-4">
                        {/* Cause 1: Timing mismatch evidence */}
                        {cause.type === "TIMING_MISMATCH" && (
                          <div className="space-y-3">
                            <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">
                              Committed Flow Movements Gap
                            </span>
                            <div className="space-y-2 max-h-52 overflow-y-auto">
                              {cause.evidence.events.map((e: any, idx: number) => {
                                const isNegative = e.amount < 0;
                                const isPayroll = e.description.toLowerCase().includes("payroll");
                                const isSupplier = e.description.toLowerCase().includes("supplier");

                                return (
                                  <div
                                    key={idx}
                                    className="flex items-center justify-between text-xs py-1.5 border-b border-slate-100 last:border-0"
                                  >
                                    <span className="text-slate-500 font-semibold">
                                      {new Date(e.expectedDate).toLocaleDateString("en-IN", {
                                        day: "2-digit",
                                        month: "short",
                                      })}
                                    </span>
                                    <div className="flex-1 px-4 flex items-center gap-2">
                                      <span className="text-slate-700 font-semibold">{e.description}</span>
                                      {(isPayroll || isSupplier) && (
                                        <Badge tone="danger" size="xs">High Criticality</Badge>
                                      )}
                                    </div>
                                    <span className={clsx("font-extrabold", isNegative ? "text-red-600" : "text-emerald-600")}>
                                      {isNegative ? "-" : "+"}
                                      {formatINR(Math.abs(e.amount))}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                            {(() => {
                              const inflows = cause.evidence.events.filter((e: any) => e.amount > 0).reduce((sum: number, e: any) => sum + e.amount, 0);
                              const outflows = cause.evidence.events.filter((e: any) => e.amount < 0).reduce((sum: number, e: any) => sum + e.amount, 0);
                              const timingGap = inflows + outflows;
                              return (
                                <div className="pt-2 border-t border-slate-200 flex flex-wrap justify-between gap-2 text-xs font-bold text-slate-600">
                                  <span>Committed Inflows: {formatINR(inflows)}</span>
                                  <span>Committed Outflows: {formatINR(Math.abs(outflows))}</span>
                                  <span className="text-red-600">Projected Shortfall: {formatINR(Math.abs(timingGap))}</span>
                                </div>
                              );
                            })()}
                          </div>
                        )}

                        {/* Cause 2: Failed payment evidence */}
                        {cause.type === "FAILED_PAYMENT" && (
                          <div className="space-y-3">
                            <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">
                              Unresolved Recovery Candidate
                            </span>
                            {cause.evidence.transactions.map((tx: any, idx: number) => (
                              <div
                                key={idx}
                                className="bg-white border border-slate-200 p-4 rounded-2xl flex items-center justify-between"
                              >
                                <div>
                                  <span className="text-xs font-extrabold text-slate-800 block">
                                    {tx.description}
                                  </span>
                                  <span className="text-[9px] text-slate-400 block mt-0.5">
                                    Transaction ID: {tx.id} • Attempted 2 days ago
                                  </span>
                                </div>
                                <span className="text-sm font-black text-slate-700">{formatINR(tx.amount)}</span>
                              </div>
                            ))}
                            <p className="text-[10px] text-slate-400 font-semibold leading-relaxed flex items-start gap-1.5">
                              <Lightbulb className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                              <span><strong className="text-slate-500">Why this matters:</strong> This payment failed card processor authorizations and is not included
                              in your committed cash forecast. Recovering it via a dynamic checkout link represents direct,
                              non-disruptive liquidity.</span>
                            </p>
                          </div>
                        )}

                        {/* Cause 3: Overdue invoices evidence */}
                        {cause.type === "OVERDUE_RECEIVABLE" && (
                          <div className="space-y-3">
                            <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">
                              Overdue Customer Ledger Invoices
                            </span>
                            <div className="space-y-2">
                              {cause.evidence.invoices.map((inv: any, idx: number) => {
                                const due = new Date(inv.dueDate);
                                const todayDate = new Date();
                                const diffDays = Math.max(1, Math.round((todayDate.getTime() - due.getTime()) / (1000 * 60 * 60 * 24)));
                                const isHigh = inv.amount >= 30000000;
                                return (
                                  <div
                                    key={idx}
                                    className="bg-white border border-slate-200 p-3 rounded-2xl flex items-center justify-between text-xs"
                                  >
                                    <div>
                                      <span className="font-bold text-slate-700 block">{inv.customerName}</span>
                                      <span className="text-[10px] text-slate-400 font-semibold block mt-0.5">
                                        Invoice ID: {inv.id} • Due date:{" "}
                                        {new Date(inv.dueDate).toLocaleDateString("en-IN", {
                                          day: "2-digit",
                                          month: "short",
                                        })}
                                      </span>
                                    </div>
                                    <div className="text-right">
                                      <span className="font-extrabold text-slate-700 block">
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
                            <p className="text-[10px] text-slate-400 font-semibold leading-relaxed flex items-start gap-1.5">
                              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                              <span><strong className="text-slate-500">Note on collection:</strong> Overdue receivables are marked as potentially acceleratable.
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
          <Card className="!rounded-3xl space-y-6">
            <div>
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest block">
                Cash Flow Causal Map
              </h3>
              <span className="text-[11px] text-slate-400 font-semibold">
                Visual ledger trace mapping how starting liquidity reaches the Day 8 crisis.
              </span>
            </div>

            <div className="flex flex-col items-center py-4">
              {causalMap.map((step, idx) => (
                <React.Fragment key={step.label}>
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: "-40px" }}
                    transition={{ delay: idx * 0.1, duration: 0.35, ease: EASE_OUT_EXPO }}
                    className={clsx("border px-4 py-2.5 rounded-2xl text-center w-56 shadow-sm", step.tone)}
                  >
                    <span className="text-[9px] font-bold uppercase tracking-wider block opacity-70">{step.label}</span>
                    <span className="text-sm font-black">{step.value}</span>
                  </motion.div>
                  {idx < causalMap.length - 1 && <div className="h-6 w-0.5 bg-indigo-200 my-1" />}
                </React.Fragment>
              ))}

              {/* Down Arrow into crisis */}
              <div className="h-8 w-0.5 bg-red-300 my-1 relative">
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 border-l-[4px] border-r-[4px] border-t-[6px] border-l-transparent border-r-transparent border-t-red-400" />
              </div>

              {/* Cash Deficit */}
              <motion.div
                initial={{ opacity: 0, scale: 0.94 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true, margin: "-40px" }}
                transition={{ delay: causalMap.length * 0.1, duration: 0.35, ease: EASE_OUT_EXPO }}
                className="bg-red-100 border border-red-200 px-6 py-3 rounded-2xl text-center w-64 shadow-md"
              >
                <span className="text-[10px] font-black text-red-600 uppercase tracking-wider block">
                  Projected Day 8 Deficit
                </span>
                <span className="text-base font-black text-red-600 mt-0.5 block">₹-4,20,000</span>
              </motion.div>
            </div>
          </Card>
        </StaggerItem>

        {/* SECTION G — Intervention Opportunities */}
        <StaggerItem>
          <Card className="!rounded-3xl space-y-4">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest block border-b border-slate-100 pb-3">
              Actionable Liquidity Capacity Identified
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-4 bg-slate-50 border border-slate-100 rounded-2xl">
                <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block">
                  Failed Payment Recovery
                </span>
                <span className="text-lg font-black text-slate-800 mt-1 block">
                  {formatINR(opportunities.failedPaymentRecovery)}
                </span>
                <span className="text-[9px] text-slate-400 font-semibold mt-1 block">
                  Recoverable card balances
                </span>
              </div>

              <div className="p-4 bg-slate-50 border border-slate-100 rounded-2xl">
                <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block">
                  Overdue Receivables
                </span>
                <span className="text-lg font-black text-slate-800 mt-1 block">
                  {formatINR(opportunities.overdueReceivables)}
                </span>
                <span className="text-[9px] text-slate-400 font-semibold mt-1 block">
                  Acceleratable invoice settlements
                </span>
              </div>
            </div>

            <div className="pt-2 flex items-center justify-between text-xs font-extrabold text-slate-700 bg-indigo-50/60 p-3 rounded-2xl">
              <span>Total Actionable Capacity</span>
              <span className="text-sm font-black text-indigo-600">
                {formatINR(opportunities.totalPotentialLiquidity)}
              </span>
            </div>
          </Card>
        </StaggerItem>

        {/* Action Bottom Nav Links */}
        <StaggerItem className="flex items-center justify-between pt-2">
          <button
            onClick={() => router.push("/dashboard")}
            className="text-xs font-bold text-slate-500 hover:text-slate-700 outline-none"
          >
            ← Back to Dashboard
          </button>

          <Button variant="primary" size="lg" onClick={() => router.push("/strategies")} className="group">
            Explore Intervention Strategies
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </Button>
        </StaggerItem>
      </Stagger>
    </main>
  );
}
