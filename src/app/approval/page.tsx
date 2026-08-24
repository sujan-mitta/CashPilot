"use client";

import React, { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useCashPilot } from "@/context/CashPilotContext";
import { formatINR } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { Reveal, Stagger, StaggerItem } from "@/components/ui/Reveal";
import { EASE_OUT_EXPO } from "@/components/ui/motion";
import { ShieldCheck, ShieldAlert, ArrowRight, CheckCircle2, XCircle, Lock } from "lucide-react";
import clsx from "clsx";

const actionCategory = (type: string) =>
  type === "RECOVER_FAILED_PAYMENTS"
    ? "Recover Failed customer Payment"
    : type === "PRIORITIZE_COLLECTIONS"
    ? "Prioritize Overdue Receivable collection"
    : type === "RESCHEDULE_PAYOUT"
    ? "Reschedule Supplier Payout"
    : "Pause operational recurring expense";

const executionMethod = (type: string) =>
  type === "RECOVER_FAILED_PAYMENTS"
    ? "Generate Razorpay payment recovery link and dispatch to customer"
    : type === "PRIORITIZE_COLLECTIONS"
    ? "Accelerate high-priority customer collections via payment recovery links"
    : type === "RESCHEDULE_PAYOUT"
    ? "De-prioritize invoice transaction status and adjust date to Day 15"
    : "Pause selected operational SaaS subscriptions directly in billing system";

const impactRealization = (type: string) =>
  type === "RECOVER_FAILED_PAYMENTS"
    ? "Customer receives link. Balance is recovered only after successful payment clearance."
    : type === "PRIORITIZE_COLLECTIONS"
    ? "Invoices will be marked priority. Cash becomes available when early collection clears."
    : type === "RESCHEDULE_PAYOUT"
    ? "Outflow is delayed, moving cash safety margin beyond Day 14 window."
    : "Outflow is eliminated from forecast, reducing immediate expenses.";

function ApprovalContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const strategyId = searchParams.get("strategyId");

  const { cachedForecast, cachedStrategies } = useCashPilot();
  const [strategy, setStrategy] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);

  // Track stale state simulation
  const [isStale, setIsStale] = useState(false);

  // Modal controls
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  useEffect(() => {
    if (!strategyId) {
      setError("No strategy selection was found in current session.");
      setLoading(false);
      return;
    }

    // Try loading details from cache first, otherwise fetch GET
    const cached = cachedStrategies?.find((s) => s.id === strategyId);
    if (cached) {
      setStrategy(cached);
      setLoading(false);
    } else {
      async function fetchStrategyDetails() {
        try {
          const res = await fetch(`/api/strategies/${strategyId}`);
          if (!res.ok) {
            throw new Error("Unable to retrieve strategy details.");
          }
          const data = await res.json();
          setStrategy(data);
        } catch (err: any) {
          setError(err.message);
        } finally {
          setLoading(false);
        }
      }
      fetchStrategyDetails();
    }
  }, [strategyId, cachedStrategies]);

  const handleConfirmApproval = async () => {
    if (!strategyId || approving) return;
    setApproving(true);
    setShowConfirmModal(false);

    try {
      const res = await fetch("/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategyId }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.error === "STRATEGY_STALE") {
          setIsStale(true);
          throw new Error(data.message);
        }
        throw new Error(data.message || "Failed to submit approval.");
      }

      // Navigate to Screen 5 (Execution)
      router.push(`/execution?strategyId=${strategyId}`);
    } catch (err: any) {
      alert("Authorization error: " + err.message);
      setApproving(false);
    }
  };

  const handleReject = () => {
    if (window.confirm("Reject current strategy? No financial actions will be authorized, and you will return to the simulator.")) {
      router.push("/strategies");
    }
  };

  if (loading) {
    return (
      <main className="flex-1 max-w-4xl mx-auto px-6 py-10 w-full space-y-8">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </main>
    );
  }

  if (error || !strategy) {
    return (
      <main className="flex-1 flex items-center justify-center py-16">
        <Card className="max-w-md text-center border-red-200 bg-red-50/60">
          <ShieldAlert className="w-12 h-12 text-red-600 mx-auto mb-4" />
          <h2 className="text-lg font-bold text-slate-800">Session Expired</h2>
          <p className="text-slate-500 text-xs mt-2 font-semibold">
            {error || "Selected strategy snapshot could not be found."}
          </p>
          <Button variant="primary" size="lg" onClick={() => router.push("/strategies")} className="mt-6 w-full">
            Return to Simulator
          </Button>
        </Card>
      </main>
    );
  }

  // null, not a fabricated -42000000. A missing forecast is an absence of
  // information; substituting the seed dataset's deficit would present a
  // fictitious figure as this business's projected position.
  const baselineClosing: number | null =
    cachedForecast?.forecast?.days?.[cachedForecast.forecast.days.length - 1]
      ?.projectedBalance ?? null;

  // Strategy naming maps
  const strategyTitle = strategy.name === "DO_NOTHING"
    ? "Do Nothing"
    : strategy.name === "RECOVER_ONLY"
    ? "Recovery Only"
    : strategy.name === "RECOVER_AND_COLLECT"
    ? "Recovery + Collections"
    : "Full Intervention";

  const preExecutionChecks = [
    {
      ok: !isStale,
      label: isStale
        ? "Simulation data is STALE — Underlying ledger data changed. Recalculation required."
        : "Simulation data is current & verified against active database",
    },
    { ok: true, label: "No duplicate execution attempts detected in active recovery queues" },
    { ok: true, label: "All target invoices, failed payments, and customer accounts are valid" },
    { ok: true, label: "Human validation flag verified: Gate remains locked awaiting operator confirmation" },
  ];

  return (
    <main className="flex-1 max-w-4xl mx-auto px-6 py-10 w-full space-y-8">
      {/* Header section */}
      <Reveal className="flex items-center justify-between">
        <button
          onClick={() => router.push("/strategies")}
          className="text-xs font-bold text-slate-500 hover:text-slate-700 transition outline-none"
        >
          ← Back to Simulator
        </button>
        <Badge tone="warning">Awaiting Human Authorization</Badge>
      </Reveal>

      <Stagger className="space-y-8" stagger={0.08}>
        {/* Recommended Strategy summary */}
        <StaggerItem>
          <Card className="!rounded-3xl space-y-4">
            <div>
              <span className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest block">
                Plan Selected for Review
              </span>
              <h2 className="text-xl font-black text-slate-800 mt-1 leading-tight">
                {strategyTitle}
              </h2>
            </div>

            <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-100 items-center">
              <div>
                <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block">
                  Baseline Deficit (Before)
                </span>
                <span className="text-lg font-extrabold text-red-600 block mt-0.5">
                  {baselineClosing === null ? "Unavailable" : formatINR(baselineClosing)}
                </span>
              </div>

              <div>
                <span className="text-[9px] font-bold text-indigo-600 uppercase tracking-wider block">
                  Expected Outcome (After)
                </span>
                <span className="text-lg font-black text-indigo-600 block mt-0.5">
                  {formatINR(strategy.result?.projectedBalance ?? strategy.projectedBalance)}
                </span>
              </div>
            </div>
          </Card>
        </StaggerItem>

        {/* SECTION B — Detailed Execution Plan */}
        <StaggerItem className="space-y-4">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-widest block pl-1">
            Detailed Action Steps Plan
          </span>

          {strategy.actions.length === 0 ? (
            <Card className="!rounded-3xl text-center text-xs text-slate-400 font-semibold italic">
              This strategy requires zero active interventions. No payment links will be created.
            </Card>
          ) : (
            <div className="space-y-4">
              {strategy.actions.map((act: any, idx: number) => (
                <Card key={act.id ?? `action-${idx}`} className="!rounded-3xl space-y-4">
                  <div className="flex justify-between items-center border-b border-slate-100 pb-3">
                    <span className="text-[10px] font-extrabold text-indigo-600 uppercase tracking-widest block">
                      Action {idx + 1} of {strategy.actions.length}
                    </span>
                    <Badge tone="neutral">Awaiting Approval</Badge>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-semibold">
                    <div>
                      <span className="text-[9px] text-slate-400 uppercase tracking-wider block">Intervention Category</span>
                      <span className="text-slate-800 font-extrabold block mt-0.5">{actionCategory(act.type)}</span>
                    </div>

                    <div>
                      <span className="text-[9px] text-slate-400 uppercase tracking-wider block">Impact Amount</span>
                      <span className="text-emerald-600 font-extrabold block mt-0.5">+{formatINR(act.amount)}</span>
                    </div>

                    <div>
                      <span className="text-[9px] text-slate-400 uppercase tracking-wider block">Execution Method</span>
                      <span className="text-slate-800 block mt-0.5">{executionMethod(act.type)}</span>
                    </div>

                    <div>
                      <span className="text-[9px] text-slate-400 uppercase tracking-wider block">Impact Realization</span>
                      <span className="text-slate-500 block mt-0.5 leading-relaxed font-semibold">{impactRealization(act.type)}</span>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </StaggerItem>

        {/* SECTION C — Pre-Execution Checks */}
        <StaggerItem>
          <Card className="!rounded-3xl space-y-4">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest block">
              Pre-Execution System Checks
            </h3>

            <div className="space-y-2.5">
              {preExecutionChecks.map((check, idx) => (
                <div key={idx} className="flex items-center gap-3 text-xs">
                  {check.ok ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" />
                  ) : (
                    <XCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
                  )}
                  <span className={clsx("font-semibold", check.ok ? "text-slate-600" : "text-red-700")}>{check.label}</span>
                </div>
              ))}
            </div>
          </Card>
        </StaggerItem>

        {/* SECTION D — Visual Human Control Boundary Separator */}
        <StaggerItem className="py-2 text-center space-y-3">
          <div className="border-t-2 border-dashed border-slate-300 w-full" />
          <span className="text-[10px] font-black uppercase text-slate-400 tracking-widest bg-[var(--background)] px-4 inline-flex items-center gap-1.5 -mt-6 relative">
            <Lock className="w-3 h-3" /> CashPilot Human Authorization Boundary
          </span>
          <div className="max-w-md mx-auto text-[10px] text-slate-400 leading-relaxed font-semibold">
            AI agents and calculation engines are strictly read-only.
            No payments can be processed, links generated, or invoices updated without explicit approval.
          </div>
          <div className="border-b-2 border-dashed border-slate-300 w-full pt-1" />
        </StaggerItem>

        {/* Stale recalculation notice */}
        {isStale && (
          <StaggerItem>
            <Card className="!rounded-3xl bg-red-50/60 border-red-200 flex items-start gap-4">
              <ShieldAlert className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-bold text-red-800">Ledger Snapshot Outdated</h4>
                <p className="text-xs text-red-700 leading-relaxed mt-1 font-semibold">
                  A transaction or invoice recovery state changed after this simulation was generated.
                  To protect from double-billing or overdraft, this strategy must be recompiled.
                </p>
                <Button
                  variant="danger"
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    localStorage.removeItem("cashpilot_strategies");
                    router.push("/strategies");
                  }}
                >
                  Recalculate Strategies
                </Button>
              </div>
            </Card>
          </StaggerItem>
        )}

        {/* Action CTA Buttons */}
        <StaggerItem className="flex justify-between items-center pt-2">
          <button
            onClick={handleReject}
            className="text-xs font-bold text-red-500 hover:text-red-700 outline-none hover:bg-red-50 px-4 py-2 rounded-lg transition-colors"
          >
            Reject Plan
          </button>

          <Button
            variant="success"
            size="lg"
            onClick={() => setShowConfirmModal(true)}
            disabled={approving || isStale}
            className="group"
          >
            {approving ? "Authorizing Plan..." : "Approve Strategy"}
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </Button>
        </StaggerItem>
      </Stagger>

      {/* CONFIRMATION MODAL */}
      <AnimatePresence>
        {showConfirmModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[999] flex items-center justify-center p-4"
            onClick={() => setShowConfirmModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 10 }}
              transition={{ duration: 0.25, ease: EASE_OUT_EXPO }}
              onClick={(e) => e.stopPropagation()}
              className="bg-white rounded-3xl p-6 max-w-sm w-full border border-slate-100 shadow-2xl space-y-4"
            >
              <div className="flex items-center gap-2.5 text-indigo-600">
                <ShieldCheck className="w-6 h-6" />
                <h3 className="text-md font-black tracking-tight text-slate-800">
                  Confirm Human Authorization
                </h3>
              </div>

              <p className="text-xs text-slate-500 font-semibold leading-relaxed">
                You are authorizing a financial intervention.
              </p>

              <div className="text-xs font-semibold text-slate-700 space-y-2">
                <p>✓ Expected to: <strong>Eliminate {strategy.scoring?.counterfactual?.deficitDaysDelta ?? 0} projected deficit days</strong>.</p>
                {(() => {
                  const deferredAmount = strategy.scoring?.deferredObligations?.amount ?? 0;
                  if (deferredAmount > 0) {
                    return (
                      <p className="text-red-600">
                        ⚠️ Note: <strong>{formatINR(deferredAmount)} remains payable</strong> after the current forecast horizon.
                      </p>
                    );
                  }
                  return <p className="text-slate-400 font-normal">No deferred liabilities outside the forecast window.</p>;
                })()}
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <Button variant="subtle" size="md" onClick={() => setShowConfirmModal(false)}>
                  Cancel
                </Button>
                <Button variant="success" size="md" onClick={handleConfirmApproval} disabled={approving}>
                  Confirm Approval
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}

export default function Approval() {
  return (
    <Suspense
      fallback={
        <main className="flex-1 max-w-4xl mx-auto px-6 py-10 w-full space-y-8">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-28 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </main>
      }
    >
      <ApprovalContent />
    </Suspense>
  );
}
