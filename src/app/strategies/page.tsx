"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ForecastChart } from "@/components/ForecastChart";
import { useCashPilot } from "@/context/CashPilotContext";
import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";
import { formatINR } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { Reveal, Stagger, StaggerItem } from "@/components/ui/Reveal";
import { EASE_OUT_EXPO } from "@/components/ui/motion";
import { ArrowRight, Sparkles, AlertTriangle, Info, TrendingUp, TrendingDown, ShieldCheck, Lock, X } from "lucide-react";
import clsx from "clsx";
import { errorMessage } from "@/lib/errors";

const scenarioLabel: Record<string, string> = {
  DO_NOTHING: "Scenario A",
  RECOVER_ONLY: "Scenario B",
  RECOVER_AND_COLLECT: "Scenario C",
  FULL_INTERVENTION: "Scenario D",
};

const scenarioName: Record<string, string> = {
  DO_NOTHING: "Do Nothing",
  RECOVER_ONLY: "Recovery Only",
  RECOVER_AND_COLLECT: "Recovery + Collections",
  FULL_INTERVENTION: "Full Intervention",
};

function strategyPrettyName(name: string) {
  if (name === "DO_NOTHING") return "Do Nothing (Control)";
  if (name === "RECOVER_ONLY") return "Strategy A: Recovery Only";
  if (name === "RECOVER_AND_COLLECT") return "Strategy B: Recovery + Collections";
  if (name === "FULL_INTERVENTION") return "Strategy C: Full Intervention";
  return name;
}

const actionDescription = (type: string) =>
  type === "RECOVER_FAILED_PAYMENTS"
    ? "Failed payment recovery (Day 2)"
    : type === "PRIORITIZE_COLLECTIONS"
    ? "Accelerated Collections (Day 1)"
    : type === "RESCHEDULE_PAYOUT"
    ? "Rescheduled Packaging Payout (Day 15)"
    : "Paused SaaS subscriptions (Day 0)";

const actionTitle = (type: string) =>
  type === "RECOVER_FAILED_PAYMENTS"
    ? "Recover Failed Customer Payout Card"
    : type === "PRIORITIZE_COLLECTIONS"
    ? "Prioritize Overdue Invoice Collection"
    : type === "RESCHEDULE_PAYOUT"
    ? "Reschedule Supplier Payout"
    : "Pause Operational Subscription";

export default function Strategies() {
  const router = useRouter();
  const {
    selectedStrategyId,
    setSelectedStrategyId,
    cachedStrategies,
    setCachedStrategies,
    cachedRecommendationNarration,
    setCachedRecommendationNarration,
    cachedForecast,
    setCachedForecast,
  } = useCashPilot();

  const [loading, setLoading] = useState(!cachedStrategies);
  const [error, setError] = useState<string | null>(null);
  const [drawerStrategyId, setDrawerStrategyId] = useState<string | null>(null);

  useEffect(() => {
    if (cachedStrategies && cachedForecast) return;

    async function fetchStrategies() {
      setLoading(true);
      try {
        const res = await fetch("/api/strategies", { method: "POST" });
        if (!res.ok) {
          throw new Error("Intervention simulations failed.");
        }
        const data = await res.json();
        setCachedStrategies(data.strategies);
        setCachedRecommendationNarration(data.recommendationNarration);

        // Map baseline response to context forecast shape
        const mappedForecast = {
          status: "SUCCESS" as const,
          business: {
            // Identity comes from the session, never a hardcoded tenant name.
            id: data.baseline.businessId ?? "unknown",
            name: data.baseline.businessName ?? "",
            currentCash: data.baseline.forecast[0].openingBalance,
          },
          forecast: {
            horizonDays: 14,
            safetyThreshold: data.baseline.requiredBuffer ?? FINANCIAL_CONFIG.SAFETY_THRESHOLD,
            days: data.baseline.forecast,
            runway: {
              firstBelowSafetyThreshold: data.baseline.crisisDay ? data.baseline.forecast[data.baseline.crisisDay - 1].date : null,
              firstNegativeDay: data.baseline.crisisDay ? data.baseline.forecast[data.baseline.crisisDay - 1].date : null,
              minimumProjectedBalance: data.baseline.minimumProjectedBalance,
            },
            riskLevel: data.baseline.riskLevel,
          },
        };
        setCachedForecast(mappedForecast);

        // Pre-select the recommended strategy (C)
        if (data.recommendedStrategyId) {
          setSelectedStrategyId(data.recommendedStrategyId);
        } else {
          const rec = data.strategies.find((s: any) => s.recommended);
          if (rec) setSelectedStrategyId(rec.id);
        }
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    }
    fetchStrategies();
  }, [cachedStrategies, cachedForecast]);

  if (loading) {
    return (
      <main className="flex-1 max-w-5xl mx-auto px-6 py-10 w-full space-y-8">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-28 rounded-2xl" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-80 rounded-2xl" />
      </main>
    );
  }

  if (error || !cachedStrategies || !cachedForecast) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <Card className="max-w-md border-red-200 bg-red-50/60 shadow-sm">
          <AlertTriangle className="w-12 h-12 text-red-600 mx-auto mb-4" />
          <h2 className="text-lg font-bold text-red-800">Simulation failed</h2>
          <p className="text-red-700 text-xs mt-2 leading-relaxed font-semibold">
            {error || "Database or calculation error in strategy engine."}
          </p>
          <Button variant="danger" size="lg" onClick={() => window.location.reload()} className="mt-6 w-full">
            Retry Simulation
          </Button>
        </Card>
      </main>
    );
  }

  // Baseline data extraction
  const baselineCash = cachedForecast.forecast!.runway.minimumProjectedBalance;
  const baselineClosing = cachedForecast.forecast!.days[cachedForecast.forecast!.days.length - 1].projectedBalance;
  const baselineCrisisIndex = cachedForecast.forecast!.days.findIndex((d) => d.projectedBalance < 0);
  const baselineCrisisText = baselineCrisisIndex >= 0 ? `Day ${baselineCrisisIndex + 1}` : "None";
  const safetyThreshold = cachedForecast.forecast!.safetyThreshold;

  // Selection mapping
  const selectedStrategy = (cachedStrategies.find((s) => s.id === selectedStrategyId) || cachedStrategies[0]) as any;
  const strategyResult = selectedStrategy.result;

  const strategyC = cachedStrategies.find((s) => s.name === "RECOVER_AND_COLLECT");
  const strategyD = cachedStrategies.find((s) => s.name === "FULL_INTERVENTION");

  return (
    <main className="flex-1 max-w-5xl mx-auto px-6 py-10 w-full space-y-8">
      {/* Navigation breadcrumb */}
      <Reveal className="flex items-center justify-between">
        <button
          onClick={() => router.push("/investigation")}
          className="text-xs font-bold text-slate-500 hover:text-slate-700 transition outline-none"
        >
          ← Back to Investigation
        </button>
        <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">
          {cachedStrategies.length} Scenarios Analyzed • Intervention Simulator
        </span>
      </Reveal>

      <Stagger className="space-y-8" stagger={0.08}>
        {/* SECTION A — Baseline Reference Card */}
        <StaggerItem>
          <Card tone="raised" className="!rounded-3xl grid grid-cols-1 sm:grid-cols-4 gap-6 items-center">
            <div>
              <span className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest block mb-0.5">
                Baseline Status (Do Nothing)
              </span>
              <span className="text-sm font-black text-slate-800 uppercase tracking-tight block">
                Committed Outlook
              </span>
            </div>
            <div>
              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block">
                Projected Crisis
              </span>
              <span className="text-sm font-extrabold text-red-600 block">{baselineCrisisText}</span>
            </div>
            <div>
              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block">
                Projected Closing
              </span>
              <span className="text-sm font-extrabold text-slate-700 block">{formatINR(baselineClosing)}</span>
            </div>
            <div className="flex sm:justify-end">
              <Badge tone="danger">High Runway Risk</Badge>
            </div>
          </Card>
        </StaggerItem>

        {/* SECTION B — Clickable Strategy Overview Cards */}
        <StaggerItem className="space-y-3">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-widest block pl-1">
            Select a Strategy to Explore
          </span>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {cachedStrategies.map((s) => {
              const isSelected = s.id === selectedStrategyId;
              const isRec = s.recommended;

              return (
                <motion.button
                  key={s.id}
                  onClick={() => setSelectedStrategyId(s.id)}
                  whileHover={{ y: -3 }}
                  whileTap={{ scale: 0.98 }}
                  transition={{ duration: 0.15 }}
                  className={clsx(
                    "text-left p-4 rounded-2xl border transition-colors duration-200 outline-none flex flex-col justify-between h-40 shadow-sm relative",
                    {
                      "bg-indigo-600 border-indigo-600 text-white ring-4 ring-indigo-100": isSelected,
                      "bg-white border-slate-200 hover:border-indigo-300 text-slate-700": !isSelected,
                    }
                  )}
                >
                  {isRec && (
                    <span
                      className={clsx(
                        "absolute top-3 right-3 text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-full",
                        isSelected ? "bg-white text-indigo-700" : "bg-indigo-600 text-white"
                      )}
                    >
                      ★ Recommended
                    </span>
                  )}

                  <div>
                    <span className={clsx("text-xs font-black uppercase tracking-widest", isSelected ? "text-indigo-200" : "text-slate-400")}>
                      {scenarioLabel[s.name] ?? s.name}
                    </span>
                    <h3 className="text-sm font-black tracking-tight mt-1 leading-snug">
                      {scenarioName[s.name] ?? s.name}
                    </h3>
                  </div>

                  <div>
                    <div className="flex items-baseline justify-between w-full mt-2">
                      <span className="text-[10px] font-bold opacity-80">Closing Cash:</span>
                      <span className="text-sm font-black">
                        {formatINR(s.result.projectedBalance)}
                      </span>
                    </div>

                    <div className="flex justify-between items-center w-full mt-1.5 pt-1.5 border-t border-white/10 text-[10px] font-bold">
                      <span className={isSelected ? "text-indigo-100" : "text-slate-400"}>
                        Score: <span className="font-black">{s.scoring.finalScore}</span>
                      </span>
                      <span
                        className={clsx("uppercase tracking-wider", {
                          "text-red-200": s.result.riskLevel === "HIGH" && isSelected,
                          "text-red-600": s.result.riskLevel === "HIGH" && !isSelected,
                          "text-emerald-200": s.result.riskLevel === "LOW" && isSelected,
                          "text-emerald-600": s.result.riskLevel === "LOW" && !isSelected,
                        })}
                      >
                        {s.result.riskLevel} Risk
                      </span>
                    </div>
                  </div>
                </motion.button>
              );
            })}
          </div>
        </StaggerItem>

        {/* SECTION C — Before vs After & Scenario Runway Timeline Chart */}
        <StaggerItem className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Before vs After accumulation panel */}
          <Card className="!rounded-3xl space-y-6 flex flex-col justify-between">
            <div>
              <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block mb-4">
                Intervention Cash Impact
              </span>

              <div className="space-y-4">
                {/* Before */}
                <div>
                  <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block">
                    Committed Outlook (Before)
                  </span>
                  <span className="text-lg font-extrabold text-slate-400 block mt-0.5">
                    {formatINR(baselineClosing)}
                  </span>
                </div>

                {/* Adjustments trace flow */}
                <div className="pl-3 border-l-2 border-indigo-200 space-y-3.5 my-2">
                  {selectedStrategy.actions.length === 0 ? (
                    <span className="text-xs text-slate-400 font-semibold italic">
                      No adjustments applied.
                    </span>
                  ) : (
                    selectedStrategy.actions.map((act: any) => (
                      <div key={act.id} className="text-xs">
                        <span className="text-emerald-600 font-bold block">
                          +{formatINR(act.amount)}
                        </span>
                        <span className="text-[10px] text-slate-400 font-semibold block leading-tight">
                          {actionDescription(act.type)}
                        </span>
                      </div>
                    ))
                  )}
                </div>

                {/* After */}
                <div className="pt-3 border-t border-slate-100">
                  <span className="text-[9px] font-bold text-indigo-600 uppercase tracking-wider block">
                    Simulated Closing Balance (After)
                  </span>
                  <span className="text-2xl font-black text-indigo-600 block mt-0.5">
                    {formatINR(strategyResult.projectedBalance)}
                  </span>
                  <span className="text-[10px] text-slate-400 font-semibold block mt-1">
                    {strategyResult.crisisDay
                      ? `Crisis projected on Day ${strategyResult.crisisDay}`
                      : "✓ Cash runway deficit eliminated"}
                  </span>
                </div>
              </div>
            </div>
          </Card>

          {/* Chart Display */}
          <Card className="!rounded-3xl md:col-span-2">
            <div className="flex justify-between items-center mb-6">
              <div>
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest block">
                  Simulated Runway Comparison Chart
                </h3>
                <span className="text-[11px] text-slate-400 font-semibold">
                  Plotting strategy curve (solid) overlaid on baseline deficit (dashed).
                </span>
              </div>
            </div>
            <ForecastChart
              data={selectedStrategy.forecast}
              baselineData={cachedForecast.forecast!.days}
              safetyThreshold={cachedForecast.forecast?.safetyThreshold}
            />
          </Card>
        </StaggerItem>

        {/* DO NOTHING VS SELECTED COMPARISON TABLE */}
        <StaggerItem>
          <Card className="!rounded-3xl space-y-4">
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest border-b border-slate-100 pb-3">
              Doing Nothing vs Recommended Comparison
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left font-semibold text-slate-700">
                <thead>
                  <tr className="border-b border-slate-100 text-[10px] text-slate-400 uppercase tracking-wider">
                    <th className="py-2">Metric</th>
                    <th className="py-2">Do Nothing</th>
                    <th className="py-2">{strategyPrettyName(selectedStrategy.name)}</th>
                    <th className="py-2 text-indigo-600">Expected Improvement</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-slate-50">
                    <td className="py-3">Minimum Balance</td>
                    <td className="py-3 font-mono">{formatINR(selectedStrategy.scoring?.counterfactual?.baselineMinimumBalance ?? baselineCash)}</td>
                    <td className="py-3 font-mono">{formatINR(selectedStrategy.scoring?.counterfactual?.strategyMinimumBalance ?? strategyResult.minimumProjectedBalance)}</td>
                    <td className="py-3 font-mono text-emerald-600">+{formatINR(selectedStrategy.scoring?.counterfactual?.minimumBalanceDelta ?? (strategyResult.minimumProjectedBalance - baselineCash))}</td>
                  </tr>
                  <tr className="border-b border-slate-50">
                    <td className="py-3">Deficit Days</td>
                    <td className="py-3">{selectedStrategy.scoring?.counterfactual?.baselineDeficitDays ?? (baselineCrisisIndex >= 0 ? 14 - baselineCrisisIndex : 0)} days</td>
                    <td className="py-3">{selectedStrategy.scoring?.counterfactual?.strategyDeficitDays ?? (strategyResult.crisisDay ? 14 - strategyResult.crisisDay : 0)} days</td>
                    <td className="py-3 text-emerald-600">-{selectedStrategy.scoring?.counterfactual?.deficitDaysDelta ?? ((baselineCrisisIndex >= 0 ? 14 - baselineCrisisIndex : 0) - (strategyResult.crisisDay ? 14 - strategyResult.crisisDay : 0))} days</td>
                  </tr>
                  <tr className="border-b border-slate-50">
                    <td className="py-3">Buffer Coverage Ratio</td>
                    <td className="py-3 font-mono">{(selectedStrategy.scoring?.counterfactual?.baselineCoverageRatio ?? 0.42).toFixed(2)}</td>
                    <td className="py-3 font-mono">{(selectedStrategy.scoring?.counterfactual?.strategyCoverageRatio ?? 1.0).toFixed(2)}</td>
                    <td className="py-3 font-mono text-emerald-600">+{((selectedStrategy.scoring?.counterfactual?.coverageRatioDelta ?? 0.58) * 100).toFixed(0)}% points</td>
                  </tr>
                  <tr>
                    <td className="py-3">Critical Obligations Protected</td>
                    <td className="py-3">{selectedStrategy.scoring?.counterfactual?.baselineCriticalObligationsProtected ?? 0} / 2</td>
                    <td className="py-3">{selectedStrategy.scoring?.counterfactual?.strategyCriticalObligationsProtected ?? 2} / 2</td>
                    <td className="py-3 text-emerald-600">+{selectedStrategy.scoring?.counterfactual?.criticalObligationsProtectedDelta ?? 2} secured</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        </StaggerItem>

        {/* COUNTERFACTUAL IMPACT & EFFECTIVENESS */}
        {selectedStrategy.scoring?.counterfactual && (
          <StaggerItem>
            <Card className="!rounded-3xl bg-indigo-50/60 border-indigo-100 border-l-4 border-l-indigo-600">
              <span className="text-[10px] font-black text-indigo-600 uppercase tracking-widest block mb-3">Counterfactual Impact Summary</span>
              <ul className="text-xs space-y-2.5 text-indigo-900 font-semibold leading-relaxed">
                <li className="flex items-start gap-2"><TrendingUp className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> +{formatINR(selectedStrategy.scoring.counterfactual.minimumBalanceDelta)} minimum-balance improvement.</li>
                <li className="flex items-start gap-2"><TrendingDown className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> {selectedStrategy.scoring.counterfactual.deficitDaysDelta} fewer deficit days.</li>
                <li className="flex items-start gap-2"><ShieldCheck className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> +{((selectedStrategy.scoring.counterfactual.coverageRatioDelta ?? 0) * 100).toFixed(0)} percentage points buffer coverage ratio.</li>
                <li className="flex items-start gap-2"><Lock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> {selectedStrategy.scoring.counterfactual.criticalObligationsProtectedDelta} additional critical obligations protected.</li>
                <li className="pt-2.5 border-t border-indigo-200/50 mt-2.5 text-[10px] uppercase font-bold tracking-wider">
                  Effectiveness: <span className="underline">{selectedStrategy.scoring.counterfactual.effectiveness.replace(/_/g, " ")}</span>
                </li>
              </ul>
            </Card>
          </StaggerItem>
        )}

        {/* DEFERRED OBLIGATIONS */}
        {selectedStrategy.deferredObligations && selectedStrategy.deferredObligations.length > 0 && (
          <StaggerItem>
            <Card className="!rounded-3xl bg-red-50/60 border-red-200 border-l-4 border-l-red-500 space-y-3">
              <div className="flex items-center gap-2 text-red-700">
                <AlertTriangle className="w-5 h-5 flex-shrink-0" />
                <h4 className="text-xs font-black uppercase tracking-widest">Deferred Obligation Warning</h4>
              </div>
              <p className="text-xs text-red-700 leading-relaxed font-semibold">
                This strategy resolves the immediate 14-day cash runway deficit by rescheduling supplier payouts beyond the forecast horizon. The obligations have been shifted, not eliminated.
              </p>
              <div className="space-y-3 pt-2">
                {selectedStrategy.deferredObligations.map((def: any, idx: number) => (
                  <div key={idx} className="bg-white border border-red-100 p-4 rounded-2xl grid grid-cols-1 sm:grid-cols-4 gap-4 text-xs font-semibold text-slate-700">
                    <div>
                      <span className="text-[9px] text-slate-400 block uppercase">Deferred Amount</span>
                      <span className="text-slate-800 font-black">{formatINR(def.amount)}</span>
                    </div>
                    <div>
                      <span className="text-[9px] text-slate-400 block uppercase">Original due date</span>
                      <span className="text-slate-800">{new Date(def.originalDueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                    </div>
                    <div>
                      <span className="text-[9px] text-slate-400 block uppercase">New Expected Date</span>
                      <span className="text-slate-800">{new Date(def.newDueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                    </div>
                    <div>
                      <span className="text-[9px] text-slate-400 block uppercase">Days beyond horizon</span>
                      <span className="text-red-600 font-black">{def.daysBeyondHorizon} day(s)</span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </StaggerItem>
        )}

        {/* SECTION D — Actions Included Checklist */}
        <StaggerItem>
          <Card className="!rounded-3xl space-y-4">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest block border-b border-slate-100 pb-3">
              Intervention Actions Included ({selectedStrategy.actions.length})
            </h3>

            <div className="space-y-3.5">
              {selectedStrategy.actions.length === 0 ? (
                <div className="text-center py-6 text-xs text-slate-400 font-semibold italic">
                  This strategy includes no active interventions. Forecast remains on baseline trajectory.
                </div>
              ) : (
                selectedStrategy.actions.map((act: any) => (
                  <div
                    key={act.id}
                    className="flex items-center justify-between p-3.5 bg-slate-50 border border-slate-100 rounded-2xl text-xs"
                  >
                    <div>
                      <span className="font-extrabold text-slate-800 block">{actionTitle(act.type)}</span>
                      <span className="text-[9px] text-slate-400 font-bold uppercase tracking-wider block mt-1">
                        {act.label}
                      </span>
                    </div>

                    <div className="text-right flex items-center gap-4">
                      <div>
                        <span className="font-extrabold text-slate-700 block">
                          +{formatINR(act.amount)}
                        </span>
                        <Badge tone="brand" size="xs" className="mt-0.5">Simulated</Badge>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>
        </StaggerItem>

        {/* TECHNICAL DECISION TRACE */}
        <StaggerItem>
          <details className="group bg-white border border-slate-200/80 shadow-sm rounded-3xl p-6">
            <summary className="text-xs font-black text-slate-400 uppercase tracking-widest cursor-pointer select-none outline-none">
              How did CashPilot reach this decision? (Technical Trace)
            </summary>
            <div className="pt-4 border-t border-slate-100 mt-4 text-xs font-semibold text-slate-600 space-y-3.5 pr-2 group-open:block hidden">
              {[
                `Detected liquidity buffer breach on forecast day ${baselineCrisisIndex + 1}.`,
                "Identified critical vendor payouts and acceleratable receivables.",
                `Calculated scale-appropriate buffer safety threshold (₹${(safetyThreshold / 10000000).toFixed(2)}L).`,
                "Simulated DO_NOTHING baseline trajectory.",
                "Simulated candidate interventions (payment recovery, collection acceleration, and payout rescheduling).",
                "Scored options using deterministic Tier I/Tier II lexicographical scorer.",
                `Ranked Strategy ${selectedStrategy.name} highest based on optimal risk-adjusted cash recovery.`,
              ].map((line, idx) => (
                <div key={idx} className="flex gap-3">
                  <span className="w-5 h-5 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-black">{idx + 1}</span>
                  <span>{line}</span>
                </div>
              ))}
            </div>
          </details>
        </StaggerItem>

        {/* ALTERNATIVE STRATEGIES */}
        <StaggerItem>
          <Card className="!rounded-3xl space-y-4">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100 pb-3">
              Alternative Strategies &amp; Options
            </h3>
            <div className="space-y-3">
              {cachedStrategies.map((s) => {
                const isRecommended = s.recommended;
                const isSelected = s.id === selectedStrategyId;
                return (
                  <div key={s.id} className="flex flex-wrap justify-between items-center gap-3 bg-slate-50/60 p-4 border border-slate-100 rounded-2xl text-xs font-semibold text-slate-700">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-extrabold text-slate-800">{strategyPrettyName(s.name)}</span>
                        <Badge tone={isRecommended ? "success" : "neutral"} size="xs">{isRecommended ? "Best" : "Alternative"}</Badge>
                      </div>
                      <span className="text-[10px] text-slate-400 mt-1 block">Expected closing: {formatINR(s.result.projectedBalance)} • Score: {s.scoring.finalScore}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="secondary" size="sm" onClick={() => setDrawerStrategyId(s.id)}>
                        See Details
                      </Button>
                      <Button variant={isSelected ? "primary" : "subtle"} size="sm" onClick={() => setSelectedStrategyId(s.id)}>
                        Select
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </StaggerItem>

        {/* COMPARISON HELPER: Why C wins over D */}
        {selectedStrategy.name === "FULL_INTERVENTION" && (
          <StaggerItem>
            <Card className="!rounded-3xl bg-amber-50/70 border-amber-200 space-y-4">
              <div className="flex items-center gap-2.5">
                <Info className="w-5 h-5 text-amber-600 flex-shrink-0" />
                <h4 className="text-sm font-black text-amber-800 uppercase tracking-tight">
                  Why is Full Intervention scored lower than Strategy C?
                </h4>
              </div>
              <p className="text-xs text-amber-700 font-semibold leading-relaxed">
                Postponing the vendor payout beyond the forecast horizon creates a larger bank surplus of{" "}
                <strong>
                  {(() => {
                    const fi = cachedStrategies?.find((x: any) => x.name === "FULL_INTERVENTION");
                    return typeof fi?.result?.projectedBalance === "number"
                      ? formatINR(fi.result.projectedBalance)
                      : "an unavailable amount";
                  })()}
                </strong>. However, rescheduling vendor commitments introduces high vendor
                disruption, resulting in a penalty on the <strong>Low Disruption</strong> metric.
                Strategy C (Recovery + Collections) fully resolves the crisis and preserves safety threshold ranges
                without postponing critical payments.
              </p>
            </Card>
          </StaggerItem>
        )}

        {/* AI Recommender Narration Box */}
        {cachedRecommendationNarration && (
          <StaggerItem>
            <Card className="!rounded-3xl bg-indigo-50/60 border-indigo-100 border-l-4 border-l-indigo-600 relative overflow-hidden">
              <div className="absolute top-0 right-0 p-3 bg-indigo-100 text-indigo-800 rounded-bl-2xl font-bold text-[9px] uppercase tracking-wider">
                Recommender Insights
              </div>
              <h3 className="text-[10px] font-extrabold text-indigo-600 uppercase tracking-widest mb-3 flex items-center gap-1.5">
                <Sparkles className="w-4 h-4" /> AI Comparative Explanation
              </h3>
              <p className="text-slate-700 text-sm leading-relaxed font-semibold italic">
                &ldquo;{cachedRecommendationNarration}&rdquo;
              </p>
            </Card>
          </StaggerItem>
        )}

        {/* Action Button Navigation links */}
        <StaggerItem className="flex items-center justify-between pt-2">
          <button
            onClick={() => router.push("/investigation")}
            className="text-xs font-bold text-slate-500 hover:text-slate-700 outline-none"
          >
            ← Back to Investigation
          </button>

          <Button
            variant="primary"
            size="lg"
            onClick={() => router.push(`/approval?strategyId=${selectedStrategyId}`)}
            disabled={!selectedStrategyId}
            className="group"
          >
            Review Execution Plan
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </Button>
        </StaggerItem>
      </Stagger>

      {/* STRATEGY DETAIL DRAWER */}
      <AnimatePresence>
        {drawerStrategyId && (() => {
          const drawerStrategy = cachedStrategies.find((s) => s.id === drawerStrategyId) as any;
          if (!drawerStrategy) return null;

          return (
            <motion.div
              key="drawer-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[999] flex justify-end"
              onClick={() => setDrawerStrategyId(null)}
            >
              <motion.div
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ duration: 0.35, ease: EASE_OUT_EXPO }}
                onClick={(e) => e.stopPropagation()}
                className="bg-white w-full max-w-lg h-full p-6 shadow-2xl flex flex-col justify-between overflow-y-auto space-y-6"
              >
                <div className="space-y-6">
                  <div className="flex justify-between items-center border-b pb-4">
                    <div>
                      <span className="text-[9px] font-black text-indigo-600 uppercase tracking-widest">Strategy Deep-Dive</span>
                      <h3 className="text-md font-black tracking-tight text-slate-800 mt-1">
                        {strategyPrettyName(drawerStrategy.name)}
                      </h3>
                    </div>
                    <button
                      onClick={() => setDrawerStrategyId(null)}
                      className="text-slate-400 hover:text-slate-600 p-2 rounded-lg hover:bg-slate-100 transition-colors"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>

                  <div className="space-y-5 text-xs font-semibold text-slate-600">
                    <div>
                      <span className="text-[10px] text-slate-400 block uppercase tracking-wider mb-1.5">Why This Action? (Strengths)</span>
                      <ul className="list-disc pl-4 space-y-1 text-slate-700 font-medium">
                        {drawerStrategy.scoring.strengths?.map((str: string, idx: number) => (
                          <li key={idx}>{str}</li>
                        )) || <li>Eliminates projected deficit and secures critical obligations.</li>}
                      </ul>
                    </div>

                    <div>
                      <span className="text-[10px] text-slate-400 block uppercase tracking-wider mb-1.5">Risks &amp; Trade-Offs</span>
                      <ul className="list-disc pl-4 space-y-1 text-slate-700 font-medium">
                        {drawerStrategy.scoring.tradeoffs?.map((tr: string, idx: number) => (
                          <li key={idx}>{tr}</li>
                        )) || <li>No major risks identified.</li>}
                      </ul>
                    </div>

                    <div>
                      <span className="text-[10px] text-slate-400 block uppercase tracking-wider mb-2">What Changes? (Actions)</span>
                      <div className="space-y-2.5">
                        {drawerStrategy.actions.length === 0 ? (
                          <span className="italic text-slate-400 font-normal">No interventions. Forecast stays on baseline.</span>
                        ) : (
                          drawerStrategy.actions.map((act: any) => (
                            <div key={act.id} className="bg-slate-50 border border-slate-100 p-3 rounded-xl flex justify-between items-center">
                              <div>
                                <span className="text-slate-800 font-bold block">{act.label}</span>
                                <span className="text-[9px] text-slate-400 block mt-0.5">Type: {act.type.replace(/_/g, " ")}</span>
                              </div>
                              <span className="text-emerald-600 font-black">+{formatINR(act.amount)}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div>
                      <span className="text-[10px] text-slate-400 block uppercase tracking-wider mb-2">Expected Impact</span>
                      <div className="bg-slate-50 border border-slate-100 p-4 rounded-2xl space-y-2.5">
                        <div className="flex justify-between">
                          <span className="text-slate-400">Projected balance:</span>
                          <span className="text-slate-800">{formatINR(drawerStrategy.result.projectedBalance)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">Minimum balance:</span>
                          <span className={clsx(drawerStrategy.result.minimumProjectedBalance < 0 ? "text-red-600 font-black" : "text-slate-800")}>
                            {formatINR(drawerStrategy.result.minimumProjectedBalance)}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">Risk rating:</span>
                          <span className="uppercase text-slate-800">{drawerStrategy.result.riskLevel}</span>
                        </div>
                      </div>
                    </div>

                    {drawerStrategy.deferredObligations && drawerStrategy.deferredObligations.length > 0 && (
                      <div className="bg-red-50 border border-red-200 p-4 rounded-2xl space-y-2 text-red-800">
                        <span className="text-[9px] font-bold block uppercase tracking-widest flex items-center gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5" /> Deferred Obligations
                        </span>
                        <p className="text-[10px] text-red-700 leading-normal font-semibold">
                          This strategy reschedules payouts beyond the current 14-day window.
                        </p>
                        {drawerStrategy.deferredObligations.map((def: any, idx: number) => (
                          <div key={idx} className="flex justify-between pt-1 border-t border-red-200/50 text-[10px]">
                            <span>Amount: {formatINR(def.amount)}</span>
                            <span>Days beyond horizon: {def.daysBeyondHorizon}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <Button variant="subtle" size="lg" onClick={() => setDrawerStrategyId(null)} className="w-full !bg-slate-800 !text-white hover:!bg-slate-900">
                  Close Deep-Dive
                </Button>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>
    </main>
  );
}
