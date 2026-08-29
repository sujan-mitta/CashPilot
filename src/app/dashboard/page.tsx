"use client";

import React, { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
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
import { errorMessage } from "@/lib/errors";
import { useToast } from "@/components/ui/Toast";

/** Floor per diagnostic step, so a fast response does not flash unread. */
const MIN_STEP_MS = 260;

/**
 * Plain language for a confidence level.
 *
 * "Low" here means we have not measured enough payment history to say how
 * timing might move - not that the arithmetic is shaky. The wording below says
 * so, because a CFO reading "Low confidence" deserves to know which one it is.
 */
function confidenceLabel(level: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN"): string {
  switch (level) {
    case "HIGH":
      return "High confidence";
    case "MEDIUM":
      return "Medium confidence";
    case "LOW":
      return "Low confidence";
    case "UNKNOWN":
      return "Nothing to forecast";
  }
}

function confidenceTone(level: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN"): string {
  if (level === "HIGH") return "text-ink-300 font-semibold";
  if (level === "MEDIUM") return "text-ink-300 font-semibold";
  return "text-ink-400 font-semibold";
}

export default function Dashboard() {
  const router = useRouter();
  const { toast } = useToast();
  const { cachedForecast, setCachedForecast, setCachedInvestigation, logout } = useCashPilot();
  const chartRef = useRef<HTMLDivElement>(null);

  const [error, setError] = useState<string | null>(null);

  // Page states: "LOADING" | "SUCCESS" | "INVESTIGATING" | "ERROR"
  // Derived from the cache at mount so the effect never has to set them
  // synchronously; both still transition during fetch/diagnostics.
  const [pageState, setPageState] = useState<"LOADING" | "SUCCESS" | "INVESTIGATING" | "ERROR">(
    cachedForecast ? "SUCCESS" : "LOADING"
  );


  // Staged loading items for diagnostics transitions
  const [visibleStepCount, setVisibleStepCount] = useState(0);
  const [loadingDemo, setLoadingDemo] = useState(false);

  const fetchForecast = async () => {
    setPageState("LOADING");

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

    } catch (err) {
      setError(errorMessage(err));
      setPageState("ERROR");

    } finally {
    }
  };

  // First-load only. When the cache is already populated the initial state
  // above reflects it, so this returns without touching state. Otherwise it
  // loads inline, starting with the await so nothing is set synchronously; the
  // retry button and diagnostics reuse fetchForecast, where that is fine.
  useEffect(() => {
    if (cachedForecast) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/forecast");
        if (res.status === 401) {
          logout();
          router.push("/login");
          return;
        }
        if (!res.ok) throw new Error("Unable to generate the latest forecast.");
        const data = await res.json();
        if (cancelled) return;
        setCachedForecast(data);
        setPageState("SUCCESS");
  
      } catch (err) {
        if (!cancelled) {
          setError(errorMessage(err));
          setPageState("ERROR");
    
        }
      } finally {
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [cachedForecast, setCachedForecast, logout, router]);

  /**
   * Runs the ledger scan and narrates it while it works.
   *
   * The panel itself is worth keeping — it explains what the engine is doing
   * instead of showing a bare spinner. What was wrong was the timing: it
   * awaited four fixed 800ms sleeps before it would navigate, so every
   * investigation cost at least 3.2 seconds no matter how fast the API
   * answered. The reveal now races the real request and resolves the moment
   * it lands, keeping a short floor per step only so nothing flashes past
   * unread.
   */
  const runDiagnostics = async () => {
    setPageState("INVESTIGATING");
    setVisibleStepCount(0);

    let settled = false;
    const investigatePromise = fetch("/api/investigate", { method: "POST" })
      .then((res) => {
        if (!res.ok) throw new Error("We could not read your ledger.");
        return res.json();
      })
      .finally(() => {
        settled = true;
      });

    const advance = (async () => {
      for (let i = 1; i <= 4 && !settled; i++) {
        await new Promise((resolve) => setTimeout(resolve, MIN_STEP_MS));
        setVisibleStepCount(i);
      }
    })();

    try {
      const data = await investigatePromise;
      // Let whichever step is mid-reveal finish rather than cutting it off,
      // then show the set as complete before the route changes.
      await advance;
      setVisibleStepCount(4);
      setCachedInvestigation(data);
      router.push("/investigation");
    } catch (err) {
      setPageState("SUCCESS");
      toast({
        tone: "danger",
        title: "Could not scan your ledger",
        description: `${errorMessage(err)} Nothing was changed. You can try again.`,
        action: { label: "Try again", onClick: () => runDiagnostics() },
      });
    }
  };

  /**
   * Loads the demo scenario for the empty state (Case E).
   *
   * This button never actually did anything: it re-fetched /api/forecast — which
   * returns NO_DATA again when there is no data — and then reloaded the page,
   * landing the operator back on the identical empty screen. It now calls the
   * endpoint that writes the scenario, and reports honestly when it cannot.
   */
  const handleLoadDemo = async () => {
    if (loadingDemo) return;
    setLoadingDemo(true);
    try {
      const res = await fetch("/api/sample-data", { method: "POST" });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast({
          tone: res.status === 409 ? "warning" : "danger",
          title:
            res.status === 403
              ? "Sample data is turned off here"
              : res.status === 409
              ? "This business already has records"
              : "Could not load the sample data",
          description:
            data.message ||
            `${errorMessage(data.error) || "Something went wrong."} Nothing was changed.`,
        });
        return;
      }

      toast({
        tone: "success",
        title: "Sample data loaded",
        description: "Your demo ledger is ready — here is the forecast.",
      });

      setCachedForecast(null);
      await fetchForecast();
    } catch (err) {
      toast({
        tone: "danger",
        title: "Could not load the sample data",
        description: `${errorMessage(err)} Nothing was changed.`,
      });
    } finally {
      setLoadingDemo(false);
    }
  };

  if (pageState === "LOADING") {
    return (
      <main className="flex-1 max-w-5xl mx-auto px-6 py-10 w-full space-y-8">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-28 rounded-md" />
        <Skeleton className="h-80 rounded-md" />
        <Skeleton className="h-44 rounded-md" />
      </main>
    );
  }

  if (pageState === "ERROR") {
    return (
      <main className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <Reveal variants={{ hidden: { opacity: 0, scale: 0.96 }, show: { opacity: 1, scale: 1, transition: { duration: 0.4, ease: EASE_OUT_EXPO } } }}>
          <Card tone="default" className="max-w-md border-risk-500/25 bg-risk-500/10">
            <AlertTriangle className="w-12 h-12 text-risk-400 mx-auto mb-4" />
            <h2 className="text-lg font-bold text-risk-400">Unable to generate the latest forecast.</h2>
            <p className="text-risk-400 text-xs mt-2 leading-relaxed font-semibold">
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
          <Card className="max-w-md">
            <Calendar className="w-12 h-12 text-brand-300 mx-auto mb-4 animate-bounce" />
            <h2 className="text-lg font-bold text-ink-100">We need some data first</h2>
            <p className="text-ink-300 text-[13px] mt-2 leading-relaxed">
              CashPilot needs money coming in and going out before it can forecast anything.
              Load the sample business and you can try the whole flow straight away.
            </p>
            <Button
              variant="primary"
              size="lg"
              onClick={handleLoadDemo}
              loading={loadingDemo}
              className="mt-6 w-full"
            >
              {loadingDemo ? "Loading sample data…" : "Load the sample data"}
            </Button>
          </Card>
        </Reveal>
      </main>
    );
  }

  // Destructure variables from structured API response
  const business = cachedForecast!.business!;
  const forecast = cachedForecast!.forecast!;
  const currentCash = business.currentCash;
  const safetyThreshold = forecast.safetyThreshold;
  const days = forecast.days;
  const runway = forecast.runway;
  const minProjected = runway.minimumProjectedBalance;

  // Determine Case A-D
  let edgeCase: "CASE_A" | "CASE_B" | "CASE_C" | "CASE_D" = "CASE_A";

  if (currentCash < 0) {
    edgeCase = "CASE_D"; // Active Cash Deficit Today
  } else if (minProjected < 0) {
    edgeCase = "CASE_C"; // Negative Balance Projected
  } else if (minProjected < safetyThreshold) {
    edgeCase = "CASE_B"; // Safety Breach
  }

  /**
   * Days until the balance first goes negative, counted ONE way.
   *
   * This page derived the same number twice - a date difference (assigned to a
   * `crisisDaysLeft` that was then never rendered) and, in the alert below,
   * `days.findIndex(d => d.projectedBalance < 0) + 1`. Two derivations of one
   * figure on one screen is how they end up disagreeing; the dead one is gone
   * and the survivor is a named function.
   */
  const daysUntilNegative = (() => {
    const idx = days.findIndex((d) => d.projectedBalance < 0);
    return idx >= 0 ? idx + 1 : null;
  })();

  // Staged loading panel render
  if (pageState === "INVESTIGATING") {
    const diagnosticSteps = [
      { label: "Checked your forecast", done: visibleStepCount > 0, active: visibleStepCount === 0 },
      { label: "Listed what you owe", done: visibleStepCount > 1, active: visibleStepCount === 1 },
      { label: "Found the payments that cannot slip", done: visibleStepCount > 2, active: visibleStepCount === 2 },
      { label: "Looking for cash you can recover…", done: visibleStepCount > 3, active: visibleStepCount === 3 },
    ];

    return (
      <main className="flex-1 flex flex-col justify-center items-center p-6">
        {/* The step list updates over several seconds with no page change, so
            without a live region a screen-reader user is told nothing at all
            between clicking and the route changing under them. */}
        <div role="status" aria-live="polite" aria-busy="true">
          <Card className="max-w-md w-full space-y-6">
            <div className="flex items-center justify-between border-b border-line-faint pb-3">
              <span className="text-xs font-bold text-ink-400">
                Checking your ledger
              </span>
              <div className="w-2.5 h-2.5 rounded-full bg-brand-500 animate-pulse-ring" />
            </div>

            <div className="space-y-4">
              {diagnosticSteps.map((step, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-3"
                >
                  {step.done ? (
                    <CheckCircle2 className="w-5 h-5 text-safe-400 flex-shrink-0" />
                  ) : step.active ? (
                    <div className="w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                  ) : (
                    <Circle className="w-5 h-5 text-ink-300 flex-shrink-0" />
                  )}
                  <span
                    className={clsx("text-sm font-semibold transition-colors duration-300", {
                      "text-ink-200": step.done,
                      "text-brand-300 font-bold": step.active,
                      "text-ink-400": !step.done && !step.active,
                    })}
                  >
                    {step.label}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </main>
    );
  }

  const totalInflows = days.reduce((sum, d) => sum + d.expectedInflows, 0);
  const totalOutflows = days.reduce((sum, d) => sum + d.expectedOutflows, 0);
  const safetyRequirement = forecast.safetyRequirement;
  // Optional: a forecast cached before this shipped carries neither.
  const scenarioBand = forecast.scenarios;
  const forecastConfidence = forecast.confidence;

  const statusTone = minProjected < 0 ? "danger" : minProjected < safetyThreshold ? "warning" : "success";
  const statusLabel = minProjected < 0 ? "Critical" : minProjected < safetyThreshold ? "At Risk" : "Healthy";

  return (
    <main className="flex-1 max-w-5xl mx-auto px-6 py-10 w-full space-y-8">
      <div className="flex justify-between items-start gap-4 flex-wrap">
        <div>
          <h1 className="text-[20px] font-semibold text-ink-100 tracking-[-0.014em]">
            Your cash forecast
          </h1>
          <p className="text-ink-400 mt-0.5">
            The next 14 days, based only on money already committed.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => router.push("/history")}>
          <History className="w-3.5 h-3.5" />
          Past decisions
        </Button>
      </div>

      <Stagger className="space-y-8" stagger={0.08}>
        {/* CASH POSITION */}
        <StaggerItem>
          <div className="card">
            <div className="card-head">
              <h2>Where your cash stands today</h2>
              <Badge tone={statusTone} size="sm" dot>
                {statusLabel}
              </Badge>
            </div>
            <div className="card-body">
              <div className="kpi-row">
                <div>
                  <span className="kpi-label">Cash you have now</span>
                  <span className="kpi-value kpi-value-lead">{formatINR(currentCash)}</span>
                  <span className="kpi-note">In the bank today</span>
                </div>
                <div>
                  <span className="kpi-label">Lowest it will get</span>
                  <span
                    className={clsx("kpi-value", minProjected < 0 && "!text-risk-400")}
                  >
                    {formatINR(minProjected)}
                  </span>
                  <span className="kpi-note">
                    {runway.firstNegativeDay
                      ? `On ${new Date(runway.firstNegativeDay).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`
                      : "Stays positive"}
                  </span>
                </div>
                <div>
                  <span className="kpi-label">Safe minimum to hold</span>
                  <span className="kpi-value">{formatINR(safetyThreshold)}</span>
                  <span className="kpi-note">Your recommended floor</span>
                </div>
                <div>
                  <span className="kpi-label">Gap to safe minimum</span>
                  <span className={clsx("kpi-value", minProjected < safetyThreshold && "!text-risk-400")}>
                    {minProjected < safetyThreshold
                      ? formatINR(safetyThreshold - minProjected)
                      : "None"}
                  </span>
                  <span className="kpi-note">How far below the floor you dip</span>
                </div>
              </div>
            </div>
          </div>
        </StaggerItem>

        {/* PRIMARY ALERT */}
        {minProjected < 0 && (
          <StaggerItem>
            <div className="rounded-lg border border-risk-500/30 bg-risk-500/[0.06] p-5">
              <div className="flex items-start gap-3.5">
                <AlertTriangle className="w-5 h-5 text-risk-400 shrink-0 mt-0.5" strokeWidth={2} />
                <div className="min-w-0 flex-1">
                  <h3 className="text-[15px] font-semibold text-ink-100">
                    {daysUntilNegative === null
                      ? "Your balance dips below zero inside this window"
                      : daysUntilNegative === 1
                      ? "You run out of cash tomorrow"
                      : `You run out of cash in ${daysUntilNegative} days`}
                  </h3>
                  <p className="text-ink-300 mt-1 max-w-2xl">
                    On {runway.firstNegativeDay
                      ? new Date(runway.firstNegativeDay).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
                      : "the crisis day"} your balance goes to{" "}
                    <strong className="text-risk-400 font-semibold">{formatINR(minProjected)}</strong>. CashPilot can
                    find the cause and suggest ways to close the gap.
                  </p>
                  <Button variant="danger" size="sm" onClick={runDiagnostics} className="mt-3.5">
                    Find out why
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          </StaggerItem>
        )}

        {/* EXPLAIN WHY */}
        {edgeCase !== "CASE_A" && (
          <StaggerItem>
            <div className="card">
              <div className="card-head">
                <h2>Why this needs your attention</h2>
              </div>
              <div className="card-body space-y-4">
              <p className="text-ink-200 leading-relaxed max-w-3xl">
                Your bills land before your customers pay you. That timing gap — not a lack of
                business — is what pulls your balance below a safe level.
                {forecast.temporalRisk?.firstCriticalDate && (
                  <span>
                    {" "}The first bill you cannot miss is due on{" "}
                    {new Date(forecast.temporalRisk.firstCriticalDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}.
                  </span>
                )}
              </p>

              <div className="field-grid pt-4 border-t border-line-faint">
                <div>
                  <span className="field-label">Cash you have now</span>
                  <span className="field-value numeric">{formatINR(currentCash)}</span>
                </div>
                <div>
                  <span className="field-label">Money coming in</span>
                  <span className="field-value numeric text-safe-400">+{formatINR(totalInflows)}</span>
                </div>
                <div>
                  <span className="field-label">Money going out</span>
                  <span className="field-value numeric text-risk-400">-{formatINR(totalOutflows)}</span>
                </div>
                <div>
                  <span className="field-label">Must-pay bills</span>
                  <span className="field-value numeric">
                    {formatINR(forecast.criticalObligations?.amount || 0)}
                    <span className="text-ink-400 font-normal"> ({forecast.criticalObligations?.count || 0} due)</span>
                  </span>
                </div>
                <div>
                  <span className="field-label">Dips below safe on</span>
                  <span className="field-value text-warn-400">
                    {forecast.runway.firstBelowSafetyThreshold
                      ? new Date(forecast.runway.firstBelowSafetyThreshold).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
                      : "None"}
                  </span>
                </div>
              </div>
              </div>
            </div>
          </StaggerItem>
        )}

        {/* HOW RELIABLE IS THIS FORECAST (Phase 10/13, spec §29 + §57) */}
        {forecastConfidence && (
          <StaggerItem>
            <div className="card">
              <div className="card-head">
                <h2>How reliable is this forecast?</h2>
                <span className={confidenceTone(forecastConfidence.level)}>
                  {confidenceLabel(forecastConfidence.level)}
                </span>
              </div>
              <div className="card-body space-y-4">
                {scenarioBand && !scenarioBand.degenerate ? (
                  <div>
                    <span className="text-ink-400 block font-normal text-xs mb-1">
                      Lowest cash you are likely to see
                    </span>
                    <span className="numeric text-[30px] font-semibold text-ink-100 block tracking-[-0.022em]">
                      {formatINR(scenarioBand.conservative.minimumBalance)}
                      <span className="text-ink-400 font-normal text-[20px]">
                        {" "}to {formatINR(scenarioBand.optimistic.minimumBalance)}
                      </span>
                    </span>
                    <span className="text-ink-400 block font-normal text-xs mt-1">
                      Most likely {formatINR(scenarioBand.base.minimumBalance)}
                    </span>
                  </div>
                ) : (
                  <p className="text-sm text-ink-300 font-semibold leading-relaxed">
                    We cannot yet put a range around this forecast. Every date below is the
                    one that was agreed, not one we have seen this customer keep.
                  </p>
                )}

                <ul className="text-xs space-y-2 text-ink-300 font-semibold leading-relaxed">
                  {forecastConfidence.reasons.map((reason, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-ink-400">-</span>
                      <span>{reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </StaggerItem>
        )}

        {/* SAFETY BUFFER */}
        {safetyRequirement && (
          <StaggerItem>
            <div className="card">
              <div className="card-head">
                <h2>Cash you should keep on hand</h2>
                <span className="text-ink-400">
                  Enough to cover {safetyRequirement.coverageDays} days of normal spending
                </span>
              </div>
              <div className="card-body space-y-4">
              <span className="numeric text-[30px] font-semibold text-ink-100 block tracking-[-0.022em]">
                {formatINR(safetyRequirement.requiredBuffer)}
              </span>

              <details className="group border border-line-faint rounded-md p-4 bg-ground-200/50">
                <summary className="text-xs font-bold text-brand-300 cursor-pointer select-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050 flex items-center justify-between">
                  How we worked this out
                  <ChevronDown className="w-3.5 h-3.5 transition-transform duration-200 group-open:rotate-180" />
                </summary>
                <div className="text-xs space-y-3 text-ink-300 pt-3 border-t border-line-faint font-semibold leading-relaxed group-open:block hidden">
                  <p>{safetyRequirement.methodology}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                    <div>
                      <span className="text-ink-400 block font-normal">Average spend per day:</span>
                      <span className="text-ink-100">{formatINR(safetyRequirement.averageDailyOutflow)}/day</span>
                    </div>
                    <div>
                      <span className="text-ink-400 block font-normal">Never go below:</span>
                      <span className="text-ink-100">{formatINR(FINANCIAL_CONFIG.SAFETY_BUFFER_MIN_FLOOR)} (Applied: {safetyRequirement.absoluteFloorApplied ? "Yes" : "No"})</span>
                    </div>
                    <div>
                      <span className="text-ink-400 block font-normal">Weight on past spending:</span>
                      <span className="text-ink-100">70%</span>
                    </div>
                    <div>
                      <span className="text-ink-400 block font-normal">Weight on planned spending:</span>
                      <span className="text-ink-100">30%</span>
                    </div>
                  </div>
                </div>
              </details>
              </div>
            </div>
          </StaggerItem>
        )}

        {/* DATA CONFIDENCE & WARNINGS */}
        {safetyRequirement && (
          <StaggerItem>
            <div className="card">
              <div className="card-head">
                <h2>How reliable is this?</h2>
                <Badge
                  tone={
                    safetyRequirement.confidence === "HIGH"
                      ? "success"
                      : safetyRequirement.confidence === "MEDIUM"
                      ? "warning"
                      : "danger"
                  }
                >
                  {safetyRequirement.confidence === "HIGH"
                    ? "High confidence"
                    : safetyRequirement.confidence === "MEDIUM"
                    ? "Medium confidence"
                    : "Low confidence"}
                </Badge>
              </div>
              <div className="card-body">
                {safetyRequirement.dataWarnings && safetyRequirement.dataWarnings.length > 0 ? (
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="w-4 h-4 text-warn-400 shrink-0 mt-0.5" strokeWidth={2} />
                    <div className="min-w-0">
                      <p className="text-ink-200 font-medium">Worth knowing before you rely on this</p>
                      <ul className="mt-1.5 space-y-1 text-ink-300">
                        {safetyRequirement.dataWarnings.map((w: string, idx: number) => (
                          <li key={idx}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ) : (
                  <p className="text-ink-300">
                    These figures are based on a full history of your ledger.
                  </p>
                )}
              </div>
            </div>
          </StaggerItem>
        )}

        {/* 14-DAY CASH RUNWAY CHART */}
        <StaggerItem>
          <div className="card">
            <div className="card-head">
              <div className="min-w-0">
                <h2>Your cash over the next 14 days</h2>
                <p className="text-ink-400 mt-0.5">
                  Each point is your balance at the end of that day.
                </p>
              </div>
              <div className="hidden sm:flex items-center gap-4 text-ink-400 shrink-0">
                <span className="flex items-center gap-1.5">
                  <span className="w-3.5 border-t border-dashed border-risk-400 block" />
                  Out of cash
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3.5 border-t border-dashed border-brand-500 block" />
                  Safe minimum
                </span>
              </div>
            </div>
            <div className="card-body" ref={chartRef}>
              <ForecastChart data={days} safetyThreshold={safetyRequirement?.requiredBuffer} />
            </div>
          </div>
        </StaggerItem>

        {/* DYNAMIC EVENT TIMELINE */}
        <StaggerItem>
          <div className="card">
            <div className="card-head">
              <h2>What is coming in and going out</h2>
              <span className="text-ink-400">Only days with activity</span>
            </div>
            {/* A table, because this is tabular data. Amounts are right-aligned
                and tabular so the columns line up and can be scanned down. */}
            <div className="max-h-[420px] overflow-y-auto">
              <table className="dtable">
                <thead className="sticky top-0">
                  <tr>
                    <th>Day</th>
                    <th>What happens</th>
                    <th className="num">In</th>
                    <th className="num">Out</th>
                    <th className="num">Balance after</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((d, idx: number) => {
                    if (d.expectedInflows <= 0 && d.expectedOutflows <= 0) return null;
                    const date = new Date(d.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
                    return (
                      <tr key={idx}>
                        <td className="whitespace-nowrap">
                          <span className="text-ink-100 font-medium">Day {idx + 1}</span>
                          <span className="text-ink-400"> · {date}</span>
                        </td>
                        <td className="text-ink-300">
                          {d.expectedInflows > 0 && d.expectedOutflows > 0
                            ? "Money in and out"
                            : d.expectedInflows > 0
                            ? "Customer payments due"
                            : "Bills to pay"}
                        </td>
                        <td className="num text-safe-400">
                          {d.expectedInflows > 0 ? `+${formatINR(d.expectedInflows)}` : "—"}
                        </td>
                        <td className="num text-risk-400">
                          {d.expectedOutflows > 0 ? `-${formatINR(d.expectedOutflows)}` : "—"}
                        </td>
                        <td className={clsx("num font-medium", d.projectedBalance < 0 ? "text-risk-400" : "text-ink-100")}>
                          {formatINR(d.projectedBalance)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </StaggerItem>

        {/* Primary CTA. When there is a shortfall the call to action already
            sits inside the alert, next to the problem it addresses; repeating
            it at the bottom of the page just made the page end twice. */}
        <StaggerItem className="flex justify-end pt-2">
          {edgeCase !== "CASE_A" ? null : (
            <Button
              variant="secondary"
              size="lg"
              onClick={() => {
                chartRef.current?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              <ShieldCheck className="w-4 h-4 text-safe-400" />
              See the timeline
            </Button>
          )}
        </StaggerItem>
      </Stagger>
    </main>
  );
}
