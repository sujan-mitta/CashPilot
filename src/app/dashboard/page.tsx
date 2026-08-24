"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ForecastChart } from "@/components/ForecastChart";
import { useCashPilot } from "@/context/CashPilotContext";
import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";
import { formatINR } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatTile } from "@/components/ui/StatTile";
import { Reveal, Stagger, StaggerItem } from "@/components/ui/Reveal";
import { EASE_OUT_EXPO } from "@/components/ui/motion";
import {
  AlertTriangle,
  Calendar,
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
  Circle,
  History,
  ChevronDown,
} from "lucide-react";
import clsx from "clsx";

export default function Dashboard() {
  const router = useRouter();
  const { cachedForecast, setCachedForecast, setCachedInvestigation, logout } = useCashPilot();

  const [loading, setLoading] = useState(!cachedForecast);
  const [error, setError] = useState<string | null>(null);

  // Page states: "LOADING" | "SUCCESS" | "INVESTIGATING" | "ERROR"
  const [pageState, setPageState] = useState<"LOADING" | "SUCCESS" | "INVESTIGATING" | "ERROR">("LOADING");
  const [monitoringState, setMonitoringState] = useState<"ACTIVE" | "CALCULATING" | "ERROR">("CALCULATING");

  // Staged loading items for diagnostics transitions
  const [visibleStepCount, setVisibleStepCount] = useState(0);

  const fetchForecast = async () => {
    setPageState("LOADING");
    setMonitoringState("CALCULATING");
    try {
      const res = await fetch("/api/forecast");
      if (res.status === 401) {
        logout();
        router.push("/login");
        return;
      }
      if (!res.ok) {
        throw new Error("Unable to generate the latest forecast.");
      }
      const data = await res.json();
      setCachedForecast(data);
      setPageState("SUCCESS");
      setMonitoringState(data.status === "SUCCESS" ? "ACTIVE" : "ERROR");
    } catch (err: any) {
      setError(err.message);
      setPageState("ERROR");
      setMonitoringState("ERROR");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (cachedForecast) {
      setPageState("SUCCESS");
      setMonitoringState(cachedForecast.status === "SUCCESS" ? "ACTIVE" : "ERROR");
      setLoading(false);
      return;
    }
    fetchForecast();
  }, [cachedForecast]);

  // Execute diagnostics triggers the staged loading transition sequence
  const runDiagnostics = async () => {
    setPageState("INVESTIGATING");
    setVisibleStepCount(0);

    // Call API immediately in the background
    const investigatePromise = fetch("/api/investigate", { method: "POST" })
      .then((res) => {
        if (!res.ok) throw new Error("Ledger scan failed.");
        return res.json();
      });

    // Stagger reveal of diagnostic steps locally for the presentation UX
    const stepsTotal = 4;
    for (let i = 1; i <= stepsTotal; i++) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      setVisibleStepCount(i);
    }

    try {
      const data = await investigatePromise;
      setCachedInvestigation(data);
      router.push("/investigation");
    } catch (err: any) {
      alert("Diagnostics failed: " + err.message);
      setPageState("SUCCESS");
    }
  };

  // Re-seeding database in case of Case E (No Data)
  const handleLoadDemo = async () => {
    setPageState("LOADING");
    try {
      await fetch("/api/forecast"); // trigger fetch to check or mock seed
      window.location.reload();
    } catch (err) {
      window.location.reload();
    }
  };

  if (pageState === "LOADING") {
    return (
      <main className="flex-1 max-w-5xl mx-auto px-6 py-10 w-full space-y-8">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-80 rounded-2xl" />
        <Skeleton className="h-44 rounded-2xl" />
      </main>
    );
  }

  if (pageState === "ERROR") {
    return (
      <main className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <Reveal variants={{ hidden: { opacity: 0, scale: 0.96 }, show: { opacity: 1, scale: 1, transition: { duration: 0.4, ease: EASE_OUT_EXPO } } }}>
          <Card tone="default" className="max-w-md border-red-200 bg-red-50/60 shadow-sm">
            <AlertTriangle className="w-12 h-12 text-red-600 mx-auto mb-4" />
            <h2 className="text-lg font-bold text-red-800">Unable to generate the latest forecast.</h2>
            <p className="text-red-700 text-xs mt-2 leading-relaxed font-semibold">
              {error || "We encountered a database timeout or connection error while compiling your transactions."}
            </p>
            <Button variant="danger" size="lg" onClick={fetchForecast} className="mt-6 w-full">
              Retry Forecast
            </Button>
          </Card>
        </Reveal>
      </main>
    );
  }

  // Handle Case E: No Data in DB
  if (cachedForecast?.status === "NO_DATA") {
    return (
      <main className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <Reveal variants={{ hidden: { opacity: 0, scale: 0.96 }, show: { opacity: 1, scale: 1, transition: { duration: 0.4, ease: EASE_OUT_EXPO } } }}>
          <Card className="max-w-md shadow-sm">
            <Calendar className="w-12 h-12 text-indigo-600 mx-auto mb-4 animate-bounce" />
            <h2 className="text-lg font-bold text-slate-800">Cash monitoring needs data</h2>
            <p className="text-slate-500 text-xs mt-2 leading-relaxed font-medium">
              We need upcoming inflows and outflows to generate a runway model. Load the pre-configured sandbox
              buildathon records to proceed.
            </p>
            <Button variant="primary" size="lg" onClick={handleLoadDemo} className="mt-6 w-full">
              Load Demo Scenario
            </Button>
          </Card>
        </Reveal>
      </main>
    );
  }

  // Destructure variables from structured API response
  const business = cachedForecast!.business!;
  const forecast = cachedForecast!.forecast as any;
  const currentCash = business.currentCash;
  const safetyThreshold = forecast.safetyThreshold;
  const days = forecast.days;
  const runway = forecast.runway;
  const minProjected = runway.minimumProjectedBalance;

  // Determine Case A-D
  let edgeCase: "CASE_A" | "CASE_B" | "CASE_C" | "CASE_D" = "CASE_A";
  let crisisDaysLeft = 0;

  if (currentCash < 0) {
    edgeCase = "CASE_D"; // Active Cash Deficit Today
  } else if (minProjected < 0) {
    edgeCase = "CASE_C"; // Negative Balance Projected
    // Calculate days until crisis Day
    if (runway.firstNegativeDay) {
      const tDate = new Date(days[0].date);
      const cDate = new Date(runway.firstNegativeDay);
      crisisDaysLeft = Math.max(1, Math.round((cDate.getTime() - tDate.getTime()) / (1000 * 60 * 60 * 24)));
    }
  } else if (minProjected < safetyThreshold) {
    edgeCase = "CASE_B"; // Safety Breach
    if (runway.firstBelowSafetyThreshold) {
      const tDate = new Date(days[0].date);
      const sDate = new Date(runway.firstBelowSafetyThreshold);
      crisisDaysLeft = Math.max(1, Math.round((sDate.getTime() - tDate.getTime()) / (1000 * 60 * 60 * 24)));
    }
  }

  // Staged loading panel render
  if (pageState === "INVESTIGATING") {
    const diagnosticSteps = [
      { label: "Forecast integrity verified", done: visibleStepCount > 0, active: visibleStepCount === 0 },
      { label: "Upcoming obligations mapped", done: visibleStepCount > 1, active: visibleStepCount === 1 },
      { label: "Critical payment events identified", done: visibleStepCount > 2, active: visibleStepCount === 2 },
      { label: "Investigating recoverable liquidity signals...", done: visibleStepCount > 3, active: visibleStepCount === 3 },
    ];

    return (
      <main className="flex-1 flex flex-col justify-center items-center p-6">
        <motion.div
          initial={{ opacity: 0, y: 12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.4, ease: EASE_OUT_EXPO }}
        >
          <Card className="max-w-md w-full shadow-lg space-y-6">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">
                Ledger Diagnostics
              </span>
              <div className="w-2.5 h-2.5 rounded-full bg-indigo-600 animate-pulse-ring" />
            </div>

            <div className="space-y-4">
              {diagnosticSteps.map((step, idx) => (
                <motion.div
                  key={idx}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.05, duration: 0.3 }}
                  className="flex items-center gap-3"
                >
                  {step.done ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                  ) : step.active ? (
                    <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                  ) : (
                    <Circle className="w-5 h-5 text-slate-200 flex-shrink-0" />
                  )}
                  <span
                    className={clsx("text-sm font-semibold transition-colors duration-300", {
                      "text-slate-700": step.done,
                      "text-indigo-600 font-bold": step.active,
                      "text-slate-300": !step.done && !step.active,
                    })}
                  >
                    {step.label}
                  </span>
                </motion.div>
              ))}
            </div>
          </Card>
        </motion.div>
      </main>
    );
  }

  const totalInflows = days.reduce((sum: number, d: any) => sum + d.expectedInflows, 0);
  const totalOutflows = days.reduce((sum: number, d: any) => sum + d.expectedOutflows, 0);
  const safetyRequirement = forecast.safetyRequirement;

  const statusTone = minProjected < 0 ? "danger" : minProjected < safetyThreshold ? "warning" : "success";
  const statusLabel = minProjected < 0 ? "Critical" : minProjected < safetyThreshold ? "At Risk" : "Healthy";

  return (
    <main className="flex-1 max-w-5xl mx-auto px-6 py-10 w-full space-y-8">
      <Reveal className="flex justify-between items-center">
        <h1 className="text-xl font-black text-slate-900 tracking-tight">Runway Forecast</h1>
        <Button variant="secondary" size="sm" onClick={() => router.push("/history")}>
          <History className="w-3.5 h-3.5" />
          View Decision History
        </Button>
      </Reveal>

      <Stagger className="space-y-8" stagger={0.08}>
        {/* CASH POSITION */}
        <StaggerItem>
          <Card>
            <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block mb-4">
              CFO Cash Position Overview
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6 items-center">
              <StatTile label="Current Cash" numericValue={currentCash} format={formatINR} size="lg" />
              <StatTile
                label="14-Day Minimum"
                numericValue={minProjected}
                format={formatINR}
                tone={minProjected < 0 ? "danger" : "default"}
                size="lg"
              />
              <StatTile label="Required Liquidity" numericValue={safetyThreshold} format={formatINR} size="lg" />
              <div>
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1.5">Status</span>
                <Badge tone={statusTone} size="sm" dot>
                  {statusLabel}
                </Badge>
              </div>
            </div>
          </Card>
        </StaggerItem>

        {/* PRIMARY ALERT */}
        {minProjected < 0 && (
          <StaggerItem>
            <Card className="border-red-200 bg-red-50/60">
              <div className="flex items-start gap-4">
                <AlertTriangle className="w-8 h-8 text-red-600 flex-shrink-0 mt-1" />
                <div className="space-y-1 w-full">
                  <h3 className="text-sm font-black text-red-800 uppercase tracking-tight">
                    Cash shortfall expected in {days.findIndex((d: any) => d.projectedBalance < 0) + 1} days
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-semibold pt-2">
                    <div>
                      <span className="text-slate-500 font-medium block">Expected minimum balance:</span>
                      <span className="text-base font-black text-red-600">{formatINR(minProjected)}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 font-medium block">Required liquidity:</span>
                      <span className="text-base font-black text-slate-700">{formatINR(safetyThreshold)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          </StaggerItem>
        )}

        {/* EXPLAIN WHY */}
        {edgeCase !== "CASE_A" && (
          <StaggerItem>
            <Card className="space-y-4">
              <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Why Attention is Required</h3>

              <p className="text-sm font-semibold text-slate-700 leading-relaxed">
                Your projected cash position falls below the required operating buffer because of a timing gap between upcoming obligations and inflows.
                {forecast.temporalRisk?.firstCriticalDate && (
                  <span> Specifically, a critical obligation is due on {new Date(forecast.temporalRisk.firstCriticalDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}.</span>
                )}
              </p>

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 pt-2 border-t border-slate-100">
                <div className="p-3 bg-slate-50 rounded-xl">
                  <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider">Current Cash</span>
                  <span className="text-sm font-black text-slate-800 mt-1 block">{formatINR(currentCash)}</span>
                </div>
                <div className="p-3 bg-slate-50 rounded-xl">
                  <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider">Expected Inflows</span>
                  <span className="text-sm font-black text-emerald-600 mt-1 block">+{formatINR(totalInflows)}</span>
                </div>
                <div className="p-3 bg-slate-50 rounded-xl">
                  <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider">Expected Outflows</span>
                  <span className="text-sm font-black text-red-600 mt-1 block">-{formatINR(totalOutflows)}</span>
                </div>
                <div className="p-3 bg-slate-50 rounded-xl col-span-2 sm:col-span-1">
                  <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider">Critical Obligations</span>
                  <span className="text-sm font-black text-slate-800 mt-1 block">
                    {formatINR(forecast.criticalObligations?.amount || 0)} ({forecast.criticalObligations?.count || 0} due)
                  </span>
                </div>
                <div className="p-3 bg-slate-50 rounded-xl col-span-2 sm:col-span-1">
                  <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider">First Safety Breach</span>
                  <span className="text-sm font-black text-amber-600 mt-1 block">
                    {forecast.runway.firstBelowSafetyThreshold
                      ? new Date(forecast.runway.firstBelowSafetyThreshold).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
                      : "None"}
                  </span>
                </div>
              </div>
            </Card>
          </StaggerItem>
        )}

        {/* SAFETY BUFFER */}
        {safetyRequirement && (
          <StaggerItem>
            <Card className="space-y-4">
              <div className="flex justify-between items-center flex-wrap gap-4">
                <div>
                  <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Required Operating Liquidity</h3>
                  <span className="text-2xl font-black text-slate-800 mt-1 block">{formatINR(safetyRequirement.requiredBuffer)}</span>
                </div>
                <span className="text-xs text-slate-500 font-bold">
                  Target: {safetyRequirement.coverageDays} days of expected operating outflows
                </span>
              </div>

              <details className="group border border-slate-100 rounded-xl p-4 bg-slate-50/50">
                <summary className="text-xs font-bold text-indigo-600 cursor-pointer select-none outline-none flex items-center justify-between">
                  View Safety Buffer Methodology &amp; Weights
                  <ChevronDown className="w-3.5 h-3.5 transition-transform duration-200 group-open:rotate-180" />
                </summary>
                <div className="text-xs space-y-3 text-slate-600 pt-3 border-t border-slate-100/50 font-semibold leading-relaxed group-open:block hidden">
                  <p>{safetyRequirement.methodology}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                    <div>
                      <span className="text-slate-400 block font-normal">Average Daily Outflow (Weighted):</span>
                      <span className="text-slate-800">{formatINR(safetyRequirement.averageDailyOutflow)}/day</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block font-normal">Absolute Safety Floor:</span>
                      <span className="text-slate-800">{formatINR(FINANCIAL_CONFIG.SAFETY_BUFFER_MIN_FLOOR)} (Applied: {safetyRequirement.absoluteFloorApplied ? "Yes" : "No"})</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block font-normal">Historical Outflow Weighting:</span>
                      <span className="text-slate-800">70%</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block font-normal">Projected Outflow Weighting:</span>
                      <span className="text-slate-800">30%</span>
                    </div>
                  </div>
                </div>
              </details>
            </Card>
          </StaggerItem>
        )}

        {/* DATA CONFIDENCE & WARNINGS */}
        {safetyRequirement && (
          <StaggerItem>
            <Card className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-black text-slate-400 uppercase tracking-widest">Data Confidence</span>
                <Badge
                  tone={
                    safetyRequirement.confidence === "HIGH"
                      ? "success"
                      : safetyRequirement.confidence === "MEDIUM"
                      ? "warning"
                      : "danger"
                  }
                >
                  {safetyRequirement.confidence} Confidence
                </Badge>
              </div>
              {safetyRequirement.dataWarnings && safetyRequirement.dataWarnings.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs space-y-1.5">
                  <span className="font-extrabold text-amber-800 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" /> Data warnings detected:
                  </span>
                  <ul className="list-disc pl-4 space-y-1 text-amber-700 font-semibold">
                    {safetyRequirement.dataWarnings.map((w: string, idx: number) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          </StaggerItem>
        )}

        {/* 14-DAY CASH RUNWAY CHART */}
        <StaggerItem>
          <Card>
            <div className="flex justify-between items-center mb-6 flex-wrap gap-3">
              <div>
                <h2 className="text-md font-black text-slate-800 uppercase tracking-tight">
                  14-Day Cash Runway Forecast
                </h2>
                <span className="text-xs text-slate-400 font-medium">
                  Committed forecast snapshot showing cumulative balances day-by-day.
                </span>
              </div>
              <div className="flex items-center gap-4 text-xs font-bold text-slate-500">
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-0.5 border-t border-dashed border-red-400 block" />
                  Deficit (₹0)
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-0.5 border-t border-dashed border-indigo-400 block" />
                  Safety ({formatINR(safetyThreshold)})
                </span>
              </div>
            </div>
            <ForecastChart data={days} safetyThreshold={safetyRequirement?.requiredBuffer} />
          </Card>
        </StaggerItem>

        {/* DYNAMIC EVENT TIMELINE */}
        <StaggerItem>
          <Card>
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100 pb-3 mb-4">
              Upcoming Committed Events Timeline
            </h3>

            <div className="space-y-3.5 max-h-96 overflow-y-auto pr-2">
              {days.map((d: any, idx: number) => {
                const showDay = d.expectedInflows > 0 || d.expectedOutflows > 0;
                if (!showDay) return null;

                return (
                  <div key={idx} className="flex flex-col gap-2 py-3 border-b border-slate-100 last:border-0">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-extrabold text-slate-400">Day {idx + 1} ({new Date(d.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })})</span>
                      <div className="flex gap-4">
                        {d.expectedInflows > 0 && (
                          <span className="text-xs font-extrabold text-emerald-600">+{formatINR(d.expectedInflows)}</span>
                        )}
                        {d.expectedOutflows > 0 && (
                          <span className="text-xs font-extrabold text-red-600">-{formatINR(d.expectedOutflows)}</span>
                        )}
                      </div>
                    </div>
                    <div className="text-xs text-slate-500 font-semibold pl-4">
                      {d.expectedInflows > 0 && d.expectedOutflows > 0 ? (
                        <span>Multiple inflows and outflows scheduled</span>
                      ) : d.expectedInflows > 0 ? (
                        <span>Customer invoice settlements due</span>
                      ) : (
                        <span>Committed business payouts due</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </StaggerItem>

        {/* Primary CTA */}
        <StaggerItem className="flex justify-end pt-2">
          {edgeCase !== "CASE_A" ? (
            <Button variant="primary" size="lg" onClick={runDiagnostics} className="group">
              {edgeCase === "CASE_D" ? "Investigate Immediate Recovery" : edgeCase === "CASE_B" ? "Investigate Liquidity Risk" : "Run Cash Diagnostics"}
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="lg"
              onClick={() => {
                const element = document.querySelector(".recharts-responsive-container");
                element?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              View Forecast Timeline
            </Button>
          )}
        </StaggerItem>
      </Stagger>
    </main>
  );
}
