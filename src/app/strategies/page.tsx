"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ForecastChart } from "@/components/ForecastChart";
import { useCashPilot, type Strategy } from "@/context/CashPilotContext";
import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";
import { formatINR } from "@/lib/format";
import { planName, planNameShort, planSummary } from "@/lib/planNames";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge, riskTone } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { Reveal, Stagger, StaggerItem } from "@/components/ui/Reveal";
import { EASE_OUT_EXPO } from "@/components/ui/motion";
import { ArrowRight, Sparkles, AlertTriangle, Info, TrendingUp, TrendingDown, ShieldCheck, Lock, X } from "lucide-react";
import clsx from "clsx";
import { errorMessage } from "@/lib/errors";


/** The engine's effectiveness enum, in plain words. */
const effectivenessLabel = (v: string) =>
  ({
    DEFICIT_ELIMINATED: "Shortfall closed",
    DEFICIT_REDUCED: "Shortfall reduced, not closed",
    NO_MATERIAL_IMPROVEMENT: "Barely changes anything",
    WORSENED: "Leaves you worse off",
  } as Record<string, string>)[v] ?? v.toLowerCase().replace(/_/g, " ");

// "Packaging" and "SaaS" are vendor names from the demo dataset. Shown to a
// real business they name somebody else's suppliers. The reschedule day also
// read 15 while the executor applied 20.
const actionDescription = (type: string) =>
  type === "RECOVER_FAILED_PAYMENTS"
    ? "Failed payment recovery (Day 2)"
    : type === "PRIORITIZE_COLLECTIONS"
    ? "Accelerated collections (Day 1)"
    : type === "RESCHEDULE_PAYOUT"
    ? `Rescheduled supplier payout (Day ${FINANCIAL_CONFIG.RESCHEDULE_DELAY_DAYS})`
    : "Paused recurring subscription (today)";

const actionTitle = (type: string) =>
  type === "RECOVER_FAILED_PAYMENTS"
    ? "Recover the failed customer payment"
    : type === "PRIORITIZE_COLLECTIONS"
    ? "Prioritise overdue invoice collection"
    : type === "RESCHEDULE_PAYOUT"
    ? "Reschedule a supplier payout"
    : "Pause a recurring subscription";

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

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (cachedStrategies && cachedForecast) return;

    // Declared inside the effect on purpose. As a useCallback it was reachable
    // by react-hooks/set-state-in-effect, which then (correctly) objected to
    // an effect that synchronously sets state. Retrying is driven by
    // `reloadKey` instead, so the error state can re-run this without the
    // window.location.reload() it used to use.
    let cancelled = false;

    async function runSimulation() {
      try {
        const res = await fetch("/api/strategies", { method: "POST" });
        if (!res.ok) {
          throw new Error("We could not finish comparing your options.");
        }
        const data = await res.json();
        if (!cancelled) setCachedStrategies(data.strategies);
        if (!cancelled) setCachedRecommendationNarration(data.recommendationNarration);

        // The shared forecast cache is filled from /api/forecast, which is the
        // ONE endpoint that produces a complete ForecastResponse.
        //
        // This used to fabricate a partial object from the strategies baseline,
        // with two consequences on the dashboard the operator returns to:
        //
        //   1. It omitted `safetyRequirement`, `criticalObligations` and
        //      `temporalRisk`, so three whole cards and the safe-minimum line
        //      on the chart silently disappeared on the second visit - and the
        //      dashboard never refetches when the cache is populated.
        //   2. It set `firstBelowSafetyThreshold` and `firstNegativeDay` to the
        //      SAME date (both derived from crisisDay), so "Dips below safe on"
        //      displayed the out-of-cash date instead.
        //
        // Fetching the real thing costs one request and cannot drift from what
        // the dashboard would have shown on its own.
        if (!cancelled) {
          try {
            const forecastRes = await fetch("/api/forecast");
            if (forecastRes.ok) {
              const forecastData = await forecastRes.json();
              if (!cancelled && forecastData?.status === "SUCCESS") {
                setCachedForecast(forecastData);
              }
            }
          } catch {
            // A missing baseline degrades the comparison panel to
            // "Unavailable", which the render already handles. It must never
            // take down the strategy comparison itself.
          }
        }

        // Pre-select the recommended strategy (C)
        if (data.recommendedStrategyId) {
          if (!cancelled) setSelectedStrategyId(data.recommendedStrategyId);
        } else {
          const rec = data.strategies.find((s: Strategy) => s.recommended);
          if (rec && !cancelled) setSelectedStrategyId(rec.id);
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    runSimulation();
    return () => {
      cancelled = true;
    };
  }, [
    cachedStrategies,
    cachedForecast,
    reloadKey,
    setCachedStrategies,
    setCachedRecommendationNarration,
    setCachedForecast,
    setSelectedStrategyId,
  ]);

  /** Retry from the error state. An event handler, so setting state here is fine. */
  const retrySimulation = () => {
    setError(null);
    setLoading(true);
    setReloadKey((k) => k + 1);
  };


  if (loading) {
    return (
      <main className="flex-1 max-w-5xl mx-auto px-6 py-10 w-full space-y-8">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-28 rounded-md" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-md" />
          ))}
        </div>
        <Skeleton className="h-80 rounded-md" />
      </main>
    );
  }

  if (error || !cachedStrategies || !cachedForecast) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <Card className="max-w-md border-risk-500/25 bg-risk-500/10">
          <AlertTriangle className="w-12 h-12 text-risk-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-ink-100">We couldn’t compare your options</h2>
          <p className="text-ink-300 text-[13px] mt-2 leading-relaxed">
            {error || "The engine could not reach your ledger."} Nothing was changed and no money moved. Try again — if it keeps failing, your database connection is the place to look.
          </p>
          <Button variant="primary" size="lg" onClick={retrySimulation} className="mt-6 w-full">
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
  const selectedStrategy = cachedStrategies.find((s) => s.id === selectedStrategyId) || cachedStrategies[0];
  const strategyResult = selectedStrategy.result;

  return (
    <main className="flex-1 max-w-5xl mx-auto px-6 py-10 w-full space-y-8">
      {/* Navigation breadcrumb */}
      <Reveal className="flex items-center justify-between">
        <button
          onClick={() => router.push("/investigation")}
          className="text-xs font-bold text-ink-300 hover:text-ink-200 transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050"
        >
          ← Back to Investigation
        </button>
        <span className="label block">
          {cachedStrategies.length} plans compared
        </span>
      </Reveal>

      <Stagger className="space-y-8" stagger={0.08}>
        {/* SECTION A — Baseline Reference Card */}
        <StaggerItem>
          <Card tone="raised" className="rounded-md grid grid-cols-1 sm:grid-cols-4 gap-6 items-center">
            <div>
              <span className="label block mb-0.5">
                If you do nothing
              </span>
              <span className="text-sm font-semibold text-ink-100 tracking-tight block">
                Your current path
              </span>
            </div>
            <div>
              <span className="label block">
                Runs short on
              </span>
              <span className="text-sm font-semibold text-risk-400 block">{baselineCrisisText}</span>
            </div>
            <div>
              <span className="label block">
                Ends the period at
              </span>
              <span className="text-sm font-semibold text-ink-200 block">{formatINR(baselineClosing)}</span>
            </div>
            <div className="flex sm:justify-end">
              {/* Derived, not assumed: this card previously always claimed HIGH
                  risk, so a solvent business was told it was in danger on the
                  same card whose figures said otherwise. */}
              <Badge tone={riskTone(cachedForecast.forecast!.riskLevel)}>
                {cachedForecast.forecast!.riskLevel === "HIGH"
                  ? "High risk"
                  : cachedForecast.forecast!.riskLevel === "MEDIUM"
                  ? "Needs attention"
                  : "On track"}
              </Badge>
            </div>
          </Card>
        </StaggerItem>

        {/* SECTION B — Clickable Strategy Overview Cards */}
        <StaggerItem className="space-y-3">
          <span className="text-xs font-bold text-ink-400 block pl-1">
            Pick a plan to see what it does
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
                    // min-h, not h-40: the recommended card carries an extra
                    // badge row, and a fixed height pushed its figure out of
                    // the card entirely.
                    "text-left p-4 rounded-md border transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050 flex flex-col gap-3 min-h-44 relative",
                    {
                      // brand-600, not brand-500: white text on #6366f1 measured 4.28-4.47:1,
                      // just under the 4.5 needed. One step darker clears it in both themes.
                      "bg-brand-600 border-brand-600 ": isSelected,
                      "bg-ground-100 border-line-soft hover:border-brand-500/40": !isSelected,
                    }
                  )}
                >
                  {/* In normal flow, not absolutely positioned — as an overlay
                      it sat on top of the plan name and clipped it. */}
                  {isRec && (
                    <span
                      className={clsx(
                        "self-start text-[10.5px] font-semibold tracking-[0.09em] px-2 py-0.5 rounded-full",
                        isSelected ? "bg-white/20 text-white" : "bg-brand-500/15 text-brand-300"
                      )}
                    >
                      ★ Recommended
                    </span>
                  )}

                  {/* Name first, then the explanation. The summary used to sit
                      above the name in label styling, which inverted
                      the hierarchy — a three-line sentence outweighed
                      the thing it was describing, and running text is
                      the hardest case to read at small sizes. */}
                  <div>
                    <h3
                      className={clsx(
                        "text-[15px] font-semibold tracking-tight leading-snug",
                        isSelected ? "text-white" : "text-ink-100"
                      )}
                    >
                      {planName(s.name)}
                    </h3>
                    <p
                      className={clsx(
                        "text-[12.5px] leading-relaxed mt-1.5",
                        isSelected ? "text-white/90" : "text-ink-300"
                      )}
                    >
                      {planSummary(s.name)}
                    </p>
                  </div>

                  <div className="mt-auto">
                    <div>
                      <span
                        className={clsx(
                          "label block",
                          // .label is --ink-400, which is a mid grey tuned for
                          // the card ground. On the saturated indigo of the
                          // selected card it disappears.
                          isSelected && "!text-white/70"
                        )}
                      >
                        Cash left at the end
                      </span>
                      <span
                        className={clsx(
                          "numeric text-[19px] font-semibold block mt-0.5 tracking-[-0.02em]",
                          isSelected
                            ? "text-white"
                            : s.result.projectedBalance < 0
                            ? "text-risk-400"
                            : "text-ink-100"
                        )}
                      >
                        {formatINR(s.result.projectedBalance)}
                      </span>
                    </div>

                    <div
                      className={clsx(
                        "flex justify-between items-center w-full mt-2.5 pt-2 border-t text-[11px] font-semibold",
                        isSelected ? "border-white/25" : "border-line-faint"
                      )}
                    >
                      <span className={isSelected ? "text-white/80" : "text-ink-400"}>
                        Score: <span className="font-semibold">{s.scoring.finalScore}</span>
                      </span>
                      <span
                        // The selected card used to need a lighter shade because
                        // it sat on saturated indigo. On the dark ground both
                        // states share a surface, so risk reads the same either
                        // way - and one colour per risk level is the point.
                        className={clsx(
                          "",
                          isSelected
                            ? "text-white/90"
                            : {
                                "text-risk-400": s.result.riskLevel === "HIGH",
                                "text-warn-400": s.result.riskLevel === "MEDIUM",
                                "text-safe-400": s.result.riskLevel === "LOW",
                              }
                        )}
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
          <Card className="rounded-md space-y-6 flex flex-col justify-between">
            <div>
              <span className="label block mb-4">
                What this plan changes
              </span>

              <div className="space-y-4">
                {/* Before */}
                <div>
                  <span className="label block">
                    Where you end up now
                  </span>
                  <span className="text-lg font-semibold text-ink-400 block mt-0.5">
                    {formatINR(baselineClosing)}
                  </span>
                </div>

                {/* Adjustments trace flow */}
                <div className="pl-3 border-l-2 border-brand-500/30 space-y-3.5 my-2">
                  {selectedStrategy.actions.length === 0 ? (
                    <span className="text-xs text-ink-400 font-semibold italic">
                      No adjustments applied.
                    </span>
                  ) : (
                    selectedStrategy.actions.map((act) => (
                      <div key={act.id} className="text-xs">
                        <span className="text-safe-400 font-bold block">
                          +{formatINR(act.amount)}
                        </span>
                        <span className="text-[11px] text-ink-400 font-semibold block leading-tight">
                          {actionDescription(act.type)}
                        </span>
                      </div>
                    ))
                  )}
                </div>

                {/* After */}
                <div className="pt-3 border-t border-line-faint">
                  <span className="text-[11px] font-bold text-brand-300 block">
                    Where you end up with this plan
                  </span>
                  <span className="text-2xl font-semibold text-brand-300 block mt-0.5">
                    {formatINR(strategyResult.projectedBalance)}
                  </span>
                  <span className="text-[11px] text-ink-400 font-semibold block mt-1">
                    {strategyResult.crisisDay
                      ? `Crisis projected on Day ${strategyResult.crisisDay}`
                      : "✓ No longer runs out of cash"}
                  </span>
                </div>
              </div>
            </div>
          </Card>

          {/* Chart Display */}
          <Card className="rounded-md md:col-span-2">
            <div className="flex justify-between items-center mb-6">
              <div>
                <h3 className="text-xs font-bold text-ink-400 block">
                  Your cash, now versus with this plan
                </h3>
                <span className="text-[11px] text-ink-400 font-semibold">
                  Solid line is this plan. Dashed line is doing nothing.
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
          <Card className="rounded-md space-y-4">
            <h3 className="text-xs font-semibold text-ink-400 border-b border-line-faint pb-3">
              Doing nothing versus this plan
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left font-semibold text-ink-200">
                <thead>
                  <tr className="label border-b border-line-faint">
                    <th className="py-2">Metric</th>
                    <th className="py-2">Do Nothing</th>
                    <th className="py-2">{planNameShort(selectedStrategy.name)}</th>
                    <th className="py-2 text-brand-300">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-line-faint">
                    <td className="py-3">Lowest balance</td>
                    <td className="py-3 font-mono">{formatINR(selectedStrategy.scoring?.counterfactual?.baselineMinimumBalance ?? baselineCash)}</td>
                    <td className="py-3 font-mono">{formatINR(selectedStrategy.scoring?.counterfactual?.strategyMinimumBalance ?? strategyResult.minimumProjectedBalance)}</td>
                    <td className="py-3 font-mono text-safe-400">+{formatINR(selectedStrategy.scoring?.counterfactual?.minimumBalanceDelta ?? (strategyResult.minimumProjectedBalance - baselineCash))}</td>
                  </tr>
                  <tr className="border-b border-line-faint">
                    <td className="py-3">Days in the red</td>
                    <td className="py-3">{selectedStrategy.scoring?.counterfactual?.baselineDeficitDays ?? (baselineCrisisIndex >= 0 ? 14 - baselineCrisisIndex : 0)} days</td>
                    <td className="py-3">{selectedStrategy.scoring?.counterfactual?.strategyDeficitDays ?? (strategyResult.crisisDay ? 14 - strategyResult.crisisDay : 0)} days</td>
                    {/* deficitDaysDelta is already signed, so the literal "-" in front of it
                        rendered "--7 days". Show the magnitude and let the word carry
                        the direction. */}
                    <td className="py-3 text-safe-400">
                      {(() => {
                        const delta =
                          selectedStrategy.scoring?.counterfactual?.deficitDaysDelta ??
                          ((baselineCrisisIndex >= 0 ? 14 - baselineCrisisIndex : 0) -
                            (strategyResult.crisisDay ? 14 - strategyResult.crisisDay : 0));
                        const n = Math.abs(delta);
                        return delta === 0 ? "No change" : `${n} ${n === 1 ? "day" : "days"} fewer`;
                      })()}
                    </td>
                  </tr>
                  <tr className="border-b border-line-faint">
                    <td className="py-3">Cover against the safe minimum</td>
                    <td className="py-3 font-mono">{(selectedStrategy.scoring?.counterfactual?.baselineCoverageRatio ?? 0.42).toFixed(2)}</td>
                    <td className="py-3 font-mono">{(selectedStrategy.scoring?.counterfactual?.strategyCoverageRatio ?? 1.0).toFixed(2)}</td>
                    <td className="py-3 font-mono text-safe-400">+{((selectedStrategy.scoring?.counterfactual?.coverageRatioDelta ?? 0.58) * 100).toFixed(0)}% points</td>
                  </tr>
                  <tr>
                    <td className="py-3">Must-pay bills covered</td>
                    <td className="py-3">{selectedStrategy.scoring?.counterfactual?.baselineCriticalObligationsProtected ?? 0} / 2</td>
                    <td className="py-3">{selectedStrategy.scoring?.counterfactual?.strategyCriticalObligationsProtected ?? 2} / 2</td>
                    <td className="py-3 text-safe-400">+{selectedStrategy.scoring?.counterfactual?.criticalObligationsProtectedDelta ?? 2} secured</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        </StaggerItem>

        {/* COUNTERFACTUAL IMPACT & EFFECTIVENESS */}
        {selectedStrategy.scoring?.counterfactual && (
          <StaggerItem>
            <Card className="rounded-md bg-brand-500/10 border-brand-500/25 border-l-4 border-l-indigo-600">
              <span className="text-[11px] font-semibold text-brand-300 block mb-3">What changes if you approve this</span>
              <ul className="text-xs space-y-2.5 text-brand-300 font-semibold leading-relaxed">
                <li className="flex items-start gap-2"><TrendingUp className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> +{formatINR(selectedStrategy.scoring.counterfactual.minimumBalanceDelta)} better at its lowest point.</li>
                <li className="flex items-start gap-2"><TrendingDown className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> {Math.abs(selectedStrategy.scoring.counterfactual.deficitDaysDelta)} fewer days in the red.</li>
                <li className="flex items-start gap-2"><ShieldCheck className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> +{((selectedStrategy.scoring.counterfactual.coverageRatioDelta ?? 0) * 100).toFixed(0)} percentage points more cover.</li>
                <li className="flex items-start gap-2"><Lock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> {selectedStrategy.scoring.counterfactual.criticalObligationsProtectedDelta} more must-pay bills covered.</li>
                <li className="pt-2.5 border-t border-brand-500/25 mt-2.5 text-[11px] font-bold">
                  Outcome:{" "}
                  <span className="font-medium text-ink-100">
                    {effectivenessLabel(selectedStrategy.scoring.counterfactual.effectiveness)}
                  </span>
                </li>
              </ul>
            </Card>
          </StaggerItem>
        )}

        {/* DEFERRED OBLIGATIONS */}
        {selectedStrategy.deferredObligations && selectedStrategy.deferredObligations.length > 0 && (
          <StaggerItem>
            <Card className="rounded-md bg-risk-500/10 border-risk-500/25 border-l-4 border-l-red-500 space-y-3">
              <div className="flex items-center gap-2 text-risk-400">
                <AlertTriangle className="w-5 h-5 flex-shrink-0" />
                <h4 className="text-xs font-semibold">Deferred Obligation Warning</h4>
              </div>
              <p className="text-xs text-risk-400 leading-relaxed font-semibold">
                This strategy resolves the immediate 14-day cash runway deficit by rescheduling supplier payouts beyond the forecast horizon. The obligations have been shifted, not eliminated.
              </p>
              <div className="space-y-3 pt-2">
                {(selectedStrategy.deferredObligations ?? []).map((def, idx: number) => (
                  <div key={idx} className="bg-ground-100 border border-risk-500/20 p-4 rounded-md grid grid-cols-1 sm:grid-cols-4 gap-4 text-xs font-semibold text-ink-200">
                    <div>
                      <span className="text-[11px] text-ink-400 block">Deferred Amount</span>
                      <span className="text-ink-100 font-semibold">{formatINR(def.amount)}</span>
                    </div>
                    <div>
                      <span className="text-[11px] text-ink-400 block">Original due date</span>
                      <span className="text-ink-100">{new Date(def.originalDueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                    </div>
                    <div>
                      <span className="text-[11px] text-ink-400 block">New Expected Date</span>
                      <span className="text-ink-100">{new Date(def.newDueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                    </div>
                    <div>
                      <span className="text-[11px] text-ink-400 block">Days beyond horizon</span>
                      <span className="text-risk-400 font-semibold">{def.daysBeyondHorizon} day(s)</span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </StaggerItem>
        )}

        {/* SECTION D — Actions Included Checklist */}
        <StaggerItem>
          <Card className="rounded-md space-y-4">
            <h3 className="text-xs font-bold text-ink-400 block border-b border-line-faint pb-3">
              What this plan does ({selectedStrategy.actions.length})
            </h3>

            <div className="space-y-3.5">
              {selectedStrategy.actions.length === 0 ? (
                <div className="text-center py-6 text-xs text-ink-400 font-semibold italic">
                  This strategy includes no active interventions. Forecast remains on baseline trajectory.
                </div>
              ) : (
                selectedStrategy.actions.map((act) => (
                  <div
                    key={act.id}
                    className="flex items-center justify-between p-3.5 bg-ground-200 border border-line-faint rounded-md text-xs"
                  >
                    <div>
                      <span className="font-semibold text-ink-100 block">{actionTitle(act.type)}</span>
                      <span className="label block mt-1">
                        {act.label}
                      </span>
                    </div>

                    <div className="text-right flex items-center gap-4">
                      <div>
                        <span className="font-semibold text-ink-200 block">
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
          <details className="group bg-ground-100 border border-line-soft rounded-md p-6">
            <summary className="text-xs font-semibold text-ink-400 cursor-pointer select-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050">
              How did CashPilot reach this decision? (Technical Trace)
            </summary>
            <div className="pt-4 border-t border-line-faint mt-4 text-xs font-semibold text-ink-300 space-y-3.5 pr-2 group-open:block hidden">
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
                  <span className="w-5 h-5 bg-brand-500/10 text-brand-300 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-semibold">{idx + 1}</span>
                  <span>{line}</span>
                </div>
              ))}
            </div>
          </details>
        </StaggerItem>

        {/* ALTERNATIVE STRATEGIES */}
        <StaggerItem>
          <Card className="rounded-md space-y-4">
            <h3 className="text-xs font-bold text-ink-400 border-b border-line-faint pb-3">
              Alternative Strategies &amp; Options
            </h3>
            <div className="space-y-3">
              {cachedStrategies.map((s) => {
                const isRecommended = s.recommended;
                const isSelected = s.id === selectedStrategyId;
                return (
                  <div key={s.id} className="flex flex-wrap justify-between items-center gap-3 bg-ground-200/60 p-4 border border-line-faint rounded-md text-xs font-semibold text-ink-200">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-ink-100">{planName(s.name)}</span>
                        <Badge tone={isRecommended ? "success" : "neutral"} size="xs">{isRecommended ? "Best" : "Alternative"}</Badge>
                      </div>
                      <span className="text-[11px] text-ink-400 mt-1 block">Expected closing: {formatINR(s.result.projectedBalance)} • Score: {s.scoring.finalScore}</span>
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
            <Card className="rounded-md bg-warn-500/12 border-warn-500/25 space-y-4">
              <div className="flex items-center gap-2.5">
                <Info className="w-5 h-5 text-warn-400 flex-shrink-0" />
                <h4 className="text-sm font-semibold text-warn-400 tracking-tight">
                  Why is Full Intervention scored lower than Strategy C?
                </h4>
              </div>
              <p className="text-xs text-warn-400 font-semibold leading-relaxed">
                Postponing the vendor payout beyond the forecast horizon creates a larger bank surplus of{" "}
                <strong>
                  {(() => {
                    const fi = cachedStrategies?.find((x) => x.name === "FULL_INTERVENTION");
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
            <Card className="rounded-md bg-brand-500/10 border-brand-500/25 border-l-4 border-l-indigo-600 relative overflow-hidden">
              <div className="absolute top-0 right-0 p-3 bg-brand-500/15 text-brand-300 rounded-bl-2xl font-bold text-[11px]">
                Why this plan
              </div>
              <h3 className="text-[11px] font-semibold text-brand-300 mb-3 flex items-center gap-1.5">
                <Sparkles className="w-4 h-4" /> AI summary
              </h3>
              <p className="text-ink-200 text-sm leading-relaxed font-semibold italic">
                &ldquo;{cachedRecommendationNarration}&rdquo;
              </p>
            </Card>
          </StaggerItem>
        )}

        {/* Action Button Navigation links */}
        <StaggerItem className="flex items-center justify-between pt-2">
          <button
            onClick={() => router.push("/investigation")}
            className="text-xs font-bold text-ink-300 hover:text-ink-200 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050"
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
            Review and approve
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </Button>
        </StaggerItem>
      </Stagger>

      {/* STRATEGY DETAIL DRAWER */}
      <AnimatePresence>
        {drawerStrategyId && (() => {
          const drawerStrategy = cachedStrategies.find((s) => s.id === drawerStrategyId);
          if (!drawerStrategy) return null;

          return (
            <motion.div
              key="drawer-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 bg-ground-000/60 backdrop-blur-sm z-[999] flex justify-end"
              onClick={() => setDrawerStrategyId(null)}
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
                  <div className="flex justify-between items-center border-b border-line-faint pb-4">
                    <div>
                      <span className="text-[11px] font-semibold text-brand-300">Plan details</span>
                      <h3 className="text-md font-semibold tracking-tight text-ink-100 mt-1">
                        {planName(drawerStrategy.name)}
                      </h3>
                    </div>
                    <button
                      onClick={() => setDrawerStrategyId(null)}
                      className="text-ink-400 hover:text-ink-300 p-2 rounded-md hover:bg-ground-200 transition-colors"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>

                  <div className="space-y-5 text-xs font-semibold text-ink-300">
                    <div>
                      <span className="label block mb-1.5">What is good about this plan</span>
                      <ul className="list-disc pl-4 space-y-1 text-ink-200 font-medium">
                        {drawerStrategy.scoring.strengths?.map((str: string, idx: number) => (
                          <li key={idx}>{str}</li>
                        )) || <li>Eliminates projected deficit and secures critical obligations.</li>}
                      </ul>
                    </div>

                    <div>
                      <span className="label block mb-1.5">What you give up</span>
                      <ul className="list-disc pl-4 space-y-1 text-ink-200 font-medium">
                        {drawerStrategy.scoring.tradeoffs?.map((tr: string, idx: number) => (
                          <li key={idx}>{tr}</li>
                        )) || <li>No major risks identified.</li>}
                      </ul>
                    </div>

                    <div>
                      <span className="label block mb-2">What CashPilot will do</span>
                      <div className="space-y-2.5">
                        {drawerStrategy.actions.length === 0 ? (
                          <span className="italic text-ink-400 font-normal">No interventions. Forecast stays on baseline.</span>
                        ) : (
                          drawerStrategy.actions.map((act) => (
                            <div key={act.id} className="bg-ground-200 border border-line-faint p-3 rounded-md flex justify-between items-center">
                              <div>
                                <span className="text-ink-100 font-bold block">{act.label}</span>
                                <span className="text-[11px] text-ink-400 block mt-0.5">Type: {act.type.replace(/_/g, " ")}</span>
                              </div>
                              <span className="text-safe-400 font-semibold">+{formatINR(act.amount)}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div>
                      <span className="label block mb-2">What you end up with</span>
                      <div className="bg-ground-200 border border-line-faint p-4 rounded-md space-y-2.5">
                        <div className="flex justify-between">
                          <span className="text-ink-400">Balance at the end:</span>
                          <span className="text-ink-100">{formatINR(drawerStrategy.result.projectedBalance)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-ink-400">Lowest point:</span>
                          <span className={clsx(drawerStrategy.result.minimumProjectedBalance < 0 ? "text-risk-400 font-semibold" : "text-ink-100")}>
                            {formatINR(drawerStrategy.result.minimumProjectedBalance)}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-ink-400">Risk:</span>
                          <span className=" text-ink-100">{drawerStrategy.result.riskLevel}</span>
                        </div>
                      </div>
                    </div>

                    {drawerStrategy.deferredObligations && drawerStrategy.deferredObligations.length > 0 && (
                      <div className="bg-risk-500/10 border border-risk-500/25 p-4 rounded-md space-y-2 text-risk-400">
                        <span className="text-[11px] font-bold block flex items-center gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5" /> Bills pushed to later
                        </span>
                        <p className="text-[11px] text-risk-400 leading-normal font-semibold">
                          This plan delays some payments past the 14 days shown above — they still have to be paid.
                        </p>
                        {(drawerStrategy.deferredObligations ?? []).map((def, idx: number) => (
                          <div key={idx} className="flex justify-between pt-1 border-t border-risk-500/25 text-[11px]">
                            <span>Amount: {formatINR(def.amount)}</span>
                            <span>Days beyond horizon: {def.daysBeyondHorizon}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <Button variant="subtle" size="lg" onClick={() => setDrawerStrategyId(null)} className="w-full !bg-ground-300 !text-white hover:!bg-ground-000">
                  Close
                </Button>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>
    </main>
  );
}
