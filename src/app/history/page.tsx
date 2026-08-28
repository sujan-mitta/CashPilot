"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { formatINR, formatPercent, formatDateTime } from "@/lib/format";
import { planName } from "@/lib/planNames";
import { Card } from "@/components/ui/Card";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Reveal, Stagger, StaggerItem } from "@/components/ui/Reveal";
import { EASE_OUT_EXPO } from "@/components/ui/motion";
import { BarChart2, Clock, ChevronRight, X, ShieldAlert, ArrowLeft } from "lucide-react";
import clsx from "clsx";
import { errorMessage } from "@/lib/errors";


const FILTERS = ["ALL", "RECOMMENDED", "APPROVED", "REJECTED", "EXECUTED", "SUCCESSFUL", "PENDING_OUTCOME"];

function lifecycleTone(status: string): BadgeTone {
  if (["EXECUTED", "RECONCILED", "OUTCOME_MEASURED"].includes(status)) return "success";
  if (["APPROVED", "PRESENTED"].includes(status)) return "warning";
  if (["REJECTED", "NOT_EXECUTED", "RECONCILIATION_MISMATCH"].includes(status)) return "danger";
  return "neutral";
}

function outcomeTone(status: string): BadgeTone {
  if (status === "SUCCESS") return "success";
  if (status === "PARTIAL_SUCCESS" || status === "OUTCOME_PENDING") return "warning";
  if (["FAILED", "REJECTED", "NOT_EXECUTED", "RECONCILIATION_MISMATCH"].includes(status)) return "danger";
  return "neutral";
}

export default function DecisionHistoryPage() {
  const router = useRouter();
  const [decisions, setDecisions] = useState<any[]>([]);
  const [performance, setPerformance] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<string>("ALL");
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null);

  const fetchHistory = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/decisions");
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) throw new Error("Failed to load decision history.");
      const data = await res.json();
      setDecisions(data.decisions || []);

      const perfRes = await fetch("/api/strategy-performance");
      if (perfRes.ok) {
        const perfData = await perfRes.json();
        setPerformance(perfData.performance || null);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, []);

  const filteredDecisions = decisions.filter((d) => {
    if (selectedFilter === "ALL") return true;
    if (selectedFilter === "RECOMMENDED") return d.strategy?.recommended;
    if (selectedFilter === "APPROVED") return d.status === "APPROVED";
    if (selectedFilter === "REJECTED") return d.status === "REJECTED";
    if (selectedFilter === "EXECUTED") return d.status === "EXECUTED";
    if (selectedFilter === "SUCCESSFUL") return d.actualOutcome?.status === "SUCCESS";
    if (selectedFilter === "PENDING_OUTCOME") return d.actualOutcome?.status === "OUTCOME_PENDING";
    return true;
  });

  const selectedDecision = decisions.find((d) => d.id === selectedDecisionId);

  return (
    <main className="flex-1 max-w-6xl mx-auto px-6 py-10 w-full space-y-10">
      {/* Header navigation bar */}
      <Reveal className="flex justify-between items-center flex-wrap gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink-100 tracking-tight">Decision Memory &amp; Strategy Performance</h1>
          <p className="text-ink-300 text-xs mt-1">
            Verify intervention predictions against reality. Immutably track historical forecasts.
          </p>
        </div>
        <button
          onClick={() => router.push("/dashboard")}
          className="flex items-center gap-1.5 px-4 py-2 bg-ground-100 border border-line-soft rounded-md text-xs font-bold text-ink-200 hover:bg-ground-200 hover:border-line-firm transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Runway Dashboard
        </button>
      </Reveal>

      {error && (
        <Reveal>
          <Card className="rounded-md bg-risk-500/10 border-risk-500/25 flex items-center gap-3">
            <ShieldAlert className="w-5 h-5 text-risk-400 flex-shrink-0" />
            <p className="text-xs font-semibold text-risk-400">{error}</p>
          </Card>
        </Reveal>
      )}

      <Stagger className="space-y-10" stagger={0.1}>
        {/* SECTION 1: STRATEGY PERFORMANCE GRID */}
        <StaggerItem>
          <Card className="rounded-md space-y-6">
            <div className="flex items-center gap-2 border-b border-line-faint pb-4">
              <BarChart2 className="w-5 h-5 text-brand-300" />
              <h2 className="text-sm font-semibold text-ink-100">
                Strategy Success &amp; Prediction Errors
              </h2>
            </div>

            {loading ? (
              <div className="py-8 text-center text-xs text-ink-400 font-medium">Loading strategy performance…</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                {performance &&
                  Object.keys(performance).map((key) => {
                    const p = performance[key];
                    const isSmallSample = p.sampleSize < 5;

                    return (
                      <div key={key} className="bg-ground-200 border border-line-faint rounded-md p-5 space-y-4">
                        <div>
                          <span className="label block leading-none">
                            {planName(p.strategyType)}
                          </span>
                          <span className="text-xs font-bold text-ink-300 mt-1 block">
                            Recs: {p.timesRecommended} • Appr: {p.timesApproved}
                          </span>
                        </div>

                        <div className="border-t border-line-soft pt-3 space-y-2">
                          <div className="flex justify-between text-[11px] font-semibold">
                            <span className="text-ink-400">Success Rate:</span>
                            <span className="text-ink-100">
                              {p.sampleSize > 0 ? `${((p.successCount / p.sampleSize) * 100).toFixed(0)}%` : "0%"}
                            </span>
                          </div>
                          <div className="flex justify-between text-[11px] font-semibold">
                            <span className="text-ink-400">Measured Sample:</span>
                            <span className="text-ink-100 flex items-center gap-1">
                              {p.sampleSize}
                              {isSmallSample && <Badge tone="warning" size="xs">Small Sample</Badge>}
                            </span>
                          </div>
                          <div className="flex justify-between text-[11px] font-semibold">
                            <span className="text-ink-400">Median Min Bal Error:</span>
                            <span className={clsx("font-bold", p.medianPredictionError < 0 ? "text-risk-400" : "text-safe-400")}>
                              {formatINR(p.medianPredictionError)}
                            </span>
                          </div>
                          <div className="flex justify-between text-[11px] font-semibold">
                            <span className="text-ink-400">Avg Error vs Predicted:</span>
                            <span className={clsx("font-bold", p.avgPredictionError < 0 ? "text-risk-400" : "text-safe-400")}>
                              {formatINR(p.avgPredictionError)}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </Card>
        </StaggerItem>

        {/* SECTION 2: DECISIONS HISTORY TABLE */}
        <StaggerItem>
          <Card className="rounded-md space-y-6">
            <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 border-b border-line-faint pb-4">
              <div className="flex items-center gap-2">
                <Clock className="w-5 h-5 text-brand-300" />
                <h2 className="text-sm font-semibold text-ink-100">
                  Decision Log Memory (Engine Version 13.0.0)
                </h2>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {FILTERS.map((f) => (
                  <button
                    key={f}
                    onClick={() => setSelectedFilter(f)}
                    className={clsx(
                      "px-3 py-1.5 rounded-md text-[11px] font-bold border transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050 select-none",
                      selectedFilter === f
                        ? "bg-brand-500 border-brand-500 text-white"
                        : "bg-ground-100 border-line-soft text-ink-300 hover:bg-ground-200"
                    )}
                  >
                    {f.replace("_", " ")}
                  </button>
                ))}
              </div>
            </div>

            {loading ? (
              <div className="py-12 text-center text-xs text-ink-400 font-medium">
                Loading decisions history log...
              </div>
            ) : filteredDecisions.length === 0 ? (
              <div className="py-12 text-center text-xs text-ink-400 font-medium">
                No historical decisions found matching the current filter.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-line-faint text-ink-400 font-semibold">
                      <th className="py-3.5 px-3">Date</th>
                      <th className="py-3.5 px-3">Intervention Action</th>
                      <th className="py-3.5 px-3">Difference</th>
                      <th className="py-3.5 px-3">Lifecycle status</th>
                      <th className="py-3.5 px-3">Actual outcome</th>
                      <th className="py-3.5 px-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredDecisions.map((d) => {
                      const rec = d.recommendedSnapshot as any;
                      const base = d.baselineSnapshot as any;
                      const expectedDiff = rec ? rec.minimumBalance - base.minimumBalance : 0;

                      const actualOut = d.actualOutcome as any;
                      const actualDiff =
                        actualOut && actualOut.status !== "OUTCOME_PENDING" ? actualOut.actualMinimumBalance - base.minimumBalance : null;

                      return (
                        <tr
                          key={d.id}
                          className="border-b border-line-faint hover:bg-ground-200/70 transition-colors cursor-pointer"
                          onClick={() => setSelectedDecisionId(d.id)}
                        >
                          <td className="py-4 px-3 font-semibold text-ink-300">{formatDateTime(d.createdAt)}</td>
                          <td className="py-4 px-3">
                            <span className="font-semibold text-ink-200 block">{planName(rec?.strategyType)}</span>
                            <span className="text-[11px] text-ink-400">Version: {d.engineVersion}</span>
                          </td>
                          <td className="py-4 px-3 font-bold text-ink-300">+{formatINR(expectedDiff)}</td>
                          <td className="py-4 px-3">
                            <Badge tone={lifecycleTone(d.status)}>{d.status}</Badge>
                          </td>
                          <td className="py-4 px-3">
                            {actualOut ? (
                              <Badge tone={outcomeTone(actualOut.status)}>
                                {actualOut.status === "OUTCOME_PENDING"
                                  ? "Pending Window"
                                  : actualOut.status === "SUCCESS"
                                  ? `Success (+${formatINR(actualDiff || 0)})`
                                  : actualOut.status}
                              </Badge>
                            ) : (
                              <span className="text-ink-400">—</span>
                            )}
                          </td>
                          <td className="py-4 px-3 text-right">
                            <button className="p-1.5 hover:bg-ground-200 rounded-md text-ink-400 hover:text-brand-300 transition-colors">
                              <ChevronRight className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </StaggerItem>
      </Stagger>

      {/* SINGLE DECISION DRILL-DOWN DRAWER */}
      <AnimatePresence>
        {selectedDecisionId && selectedDecision && (() => {
          const d = selectedDecision;
          const rec = d.recommendedSnapshot as any;
          const base = d.baselineSnapshot as any;
          const expectedDiff = rec ? rec.minimumBalance - base.minimumBalance : 0;

          const actualOut = d.actualOutcome as any;

          return (
            <motion.div
              key="history-drawer-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 bg-ground-000/60 backdrop-blur-sm z-[999] flex justify-end"
              onClick={() => setSelectedDecisionId(null)}
            >
              <motion.div
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ duration: 0.35, ease: EASE_OUT_EXPO }}
                onClick={(e) => e.stopPropagation()}
                className="bg-ground-100 w-full max-w-lg h-full p-6 flex flex-col justify-between overflow-y-auto space-y-6"
              >
                <div className="space-y-6">
                  <div className="flex justify-between items-center border-b pb-4">
                    <div>
                      <span className="text-[11px] font-semibold text-brand-300">Decision memory deep-dive</span>
                      <h3 className="text-base font-semibold text-ink-100 mt-1">{planName(rec?.strategyType)}</h3>
                      <p className="text-[11px] text-ink-400 mt-0.5">
                        Decision ID: {d.id} • Engine: v{d.engineVersion}
                      </p>
                    </div>
                    <button
                      onClick={() => setSelectedDecisionId(null)}
                      className="p-1.5 hover:bg-ground-200 rounded-md text-ink-400 hover:text-ink-300 transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>

                  {/* WHAT WE KNEW VS WHAT WE PREDICTED VS ACTUAL OUTCOME */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-ground-200 border border-line-faint p-4 rounded-md space-y-2.5">
                      <span className="label block leading-none">
                        Baseline (Do Nothing)
                      </span>
                      <div className="space-y-1.5 text-[11px] font-semibold text-ink-300">
                        <div className="flex justify-between">
                          <span>Cash you start with:</span>
                          <span className="text-ink-100">{formatINR(base.startingCash)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Lowest balance:</span>
                          <span className={clsx(base.minimumBalance < 0 ? "text-risk-400" : "text-ink-100")}>
                            {formatINR(base.minimumBalance)}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>Days in the red:</span>
                          <span className="text-ink-100">{base.deficitDays} days</span>
                        </div>
                      </div>
                    </div>

                    <div className="bg-brand-500/10 border border-brand-500/25 p-4 rounded-md space-y-2.5">
                      <span className="text-[11px] font-semibold text-brand-300 block leading-none">
                        Predicted Intervention
                      </span>
                      <div className="space-y-1.5 text-[11px] font-semibold text-ink-300">
                        <div className="flex justify-between">
                          <span>Projected Cash:</span>
                          <span className="text-ink-100">{formatINR(rec.finalBalance)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Lowest balance:</span>
                          <span className="text-ink-100 font-bold">{formatINR(rec.minimumBalance)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Days in the red:</span>
                          <span className="text-ink-100">{rec.deficitDays} days</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* ACTUAL OUTCOMES SECTION */}
                  {actualOut && (
                    <div
                      className={clsx("border p-4 rounded-md space-y-3", {
                        "bg-safe-500/10 border-safe-500/25 text-safe-400": actualOut.status === "SUCCESS",
                        "bg-warn-500/10 border-warn-500/25 text-warn-400": actualOut.status === "PARTIAL_SUCCESS" || actualOut.status === "OUTCOME_PENDING",
                        "bg-risk-500/10 border-risk-500/25 text-risk-400": ["FAILED", "REJECTED", "NOT_EXECUTED", "RECONCILIATION_MISMATCH"].includes(actualOut.status),
                      })}
                    >
                      <div className="flex justify-between items-center leading-none">
                        <span className="text-[11px] font-semibold">Actual Outcome Measurement</span>
                        <span className="text-[11px] font-bold">{actualOut.status}</span>
                      </div>

                      {actualOut.status === "OUTCOME_PENDING" ? (
                        <p className="text-[11px] leading-normal font-semibold">
                          The 14-day outcome tracking window is still open. CashPilot is streaming actual ledger records to measure accuracy.
                        </p>
                      ) : (
                        <div className="space-y-2 text-[11px] font-semibold">
                          <div className="flex justify-between">
                            <span>Actual Lowest balance:</span>
                            <span>{formatINR(actualOut.actualMinimumBalance)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>Actual Final Balance:</span>
                            <span>{formatINR(actualOut.actualFinalBalance)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>Actual Days in the red:</span>
                            <span>{actualOut.actualDeficitDays} days</span>
                          </div>
                          <div className="flex justify-between border-t border-line-soft pt-2 font-bold">
                            <span>Prediction Error (Min Bal):</span>
                            <span>{formatINR(actualOut.predictionError.minimumBalance)}</span>
                          </div>
                          <div className="flex justify-between font-bold">
                            <span>Days in the red Variance:</span>
                            <span>{actualOut.predictionError.deficitDays} days</span>
                          </div>
                          <div className="text-[11px] italic mt-1 font-bold">
                            Variance rating: {actualOut.varianceClassification}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* WARNINGS & ALERTS */}
                  {actualOut?.dataWarnings && actualOut.dataWarnings.length > 0 && (
                    <div className="bg-warn-500/10 border border-warn-500/25 text-warn-400 p-4 rounded-md flex gap-2.5 items-start">
                      <ShieldAlert className="w-5 h-5 flex-shrink-0 text-warn-400 mt-0.5" />
                      <div className="space-y-1">
                        <span className="text-[11px] font-semibold block leading-none">Outcome warnings</span>
                        {actualOut.dataWarnings.map((w: string, idx: number) => (
                          <p key={idx} className="text-[11px] leading-normal font-semibold text-warn-400">
                            • {w}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ORIGINAL DECISION CONTEXT */}
                  <div className="bg-ground-200 border border-line-soft p-4 rounded-md space-y-2">
                    <span className="label block leading-none mb-1">
                      Original Decision Context
                    </span>
                    <div className="space-y-1.5 text-[11px] font-semibold text-ink-300">
                      <div className="flex justify-between">
                        <span>Forecast Horizon:</span>
                        <span className="text-ink-100">{base.forecastHorizon} days</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Required Buffer:</span>
                        <span className="text-ink-100">{formatINR(base.requiredLiquidity)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Difference:</span>
                        <span className="text-ink-100 font-bold">+{formatINR(expectedDiff)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Coverage Ratio:</span>
                        <span className="text-ink-100">{formatPercent(base.coverageRatio)}</span>
                      </div>
                    </div>
                  </div>

                  {/* DECISION TIMELINE */}
                  <div className="space-y-2.5">
                    <span className="label block leading-none">
                      Timeline Logs
                    </span>
                    <div className="border-l border-line-soft pl-4 space-y-3.5">
                      <div className="relative">
                        <div className="absolute -left-[21px] top-1 w-2 h-2 rounded-full bg-brand-500" />
                        <span className="text-[11px] text-ink-400 font-bold block leading-none">{formatDateTime(d.createdAt)}</span>
                        <span className="text-xs font-bold text-ink-200 mt-1 block">
                          Intervention Risk Detected &amp; Strategy Presented
                        </span>
                      </div>

                      {d.approvalSnapshot && (
                        <div className="relative">
                          <div className="absolute -left-[21px] top-1 w-2 h-2 rounded-full bg-brand-500" />
                          <span className="text-[11px] text-ink-400 font-bold block leading-none">
                            {formatDateTime(d.approvalSnapshot.approvedAt || d.approvalSnapshot.rejectedAt)}
                          </span>
                          <span className="text-xs font-bold text-ink-200 mt-1 block">
                            Human Gate Action: {d.approvalSnapshot.status.toUpperCase()} by {d.approvalSnapshot.approvedByName || d.approvalSnapshot.rejectedByName}
                          </span>
                          {d.approvalSnapshot.rejectionReason && (
                            <span className="text-[11px] text-ink-300 italic mt-0.5 block">
                              &ldquo;Reason: {d.approvalSnapshot.rejectionReason}&rdquo;
                            </span>
                          )}
                        </div>
                      )}

                      {d.executionSnapshot && (
                        <div className="relative">
                          <div className="absolute -left-[21px] top-1 w-2 h-2 rounded-full bg-brand-500" />
                          <span className="text-[11px] text-ink-400 font-bold block leading-none">
                            {formatDateTime(d.executionSnapshot.timestamp)}
                          </span>
                          <span className="text-xs font-bold text-ink-200 mt-1 block">Execution Confirmed</span>
                        </div>
                      )}

                      {d.reconciliationSnapshot && (
                        <div className="relative">
                          <div className="absolute -left-[21px] top-1 w-2 h-2 rounded-full bg-brand-500" />
                          <span className="text-[11px] text-ink-400 font-bold block leading-none">
                            {formatDateTime(d.reconciliationSnapshot.timestamp)}
                          </span>
                          <span className="text-xs font-bold text-ink-200 mt-1 block">Authoritative Ledger Reconciliation Complete</span>
                        </div>
                      )}

                      {d.outcomeMeasuredAt && (
                        <div className="relative">
                          <div className="absolute -left-[21px] top-1 w-2 h-2 rounded-full bg-safe-500" />
                          <span className="text-[11px] text-ink-400 font-bold block leading-none">{formatDateTime(d.outcomeMeasuredAt)}</span>
                          <span className="text-xs font-semibold text-safe-400 mt-1 block">
                            Outcome measured successfully (14-Day Horizon Complete)
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => setSelectedDecisionId(null)}
                  className="w-full py-3.5 bg-ground-300 hover:bg-ground-000 text-white font-bold rounded-md text-xs transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050"
                >
                  Close Drawer
                </button>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>
    </main>
  );
}
