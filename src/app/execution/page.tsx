"use client";

import React, { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useCashPilot } from "@/context/CashPilotContext";
import { formatINR } from "@/lib/format";
import { UnknownExecutionPanel } from "@/components/UnknownExecutionPanel";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { Reveal, Stagger, StaggerItem } from "@/components/ui/Reveal";
import { EASE_OUT_EXPO } from "@/components/ui/motion";
import { CheckCircle2, RefreshCw, ArrowRight, ExternalLink, Sparkles, ShieldAlert, AlertTriangle } from "lucide-react";
import clsx from "clsx";

interface ActionStepLog {
  id: string;
  action: string;
  status: string;
  result: string;
  narration: string;
}

const LIFECYCLE_STATES = ["APPROVED", "EXECUTION_REQUESTED", "EXECUTING", "RECONCILING", "COMPLETED"];

function getStatusOrder(status: string) {
  if (status === "COMPLETED") return 5;
  if (status === "RECONCILING") return 4;
  if (status === "EXECUTED" || status === "EXECUTING") return 3;
  if (status === "EXECUTION_REQUESTED") return 2;
  if (status === "APPROVED") return 1;
  return 0;
}

function statusTone(status: string, resolved: boolean): BadgeTone {
  if (resolved || status === "COMPLETED") return "success";
  if (status === "FAILED" || status === "RECONCILIATION_FAILED") return "danger";
  if (status === "EXECUTION_UNKNOWN" || status === "RECONCILIATION_MISMATCH") return "warning";
  return "brand";
}

function LifecycleTrack({ status }: { status: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[8px] font-black text-slate-400 uppercase tracking-wider mt-1.5">
      {LIFECYCLE_STATES.map((sName, sIdx) => {
        const isPastOrCurrent = getStatusOrder(status) >= sIdx + 1;
        return (
          <div key={sName} className="flex items-center gap-1">
            <span className={clsx("px-1.5 py-0.5 rounded transition-colors duration-300", isPastOrCurrent ? "bg-indigo-100 text-indigo-900 font-black" : "bg-slate-100 text-slate-400")}>
              {sName === "EXECUTION_REQUESTED" ? "REQ" : sName === "RECONCILING" ? "RECON" : sName}
            </span>
            {sIdx < 4 && <span>→</span>}
          </div>
        );
      })}
    </div>
  );
}

function ExecutionContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const strategyId = searchParams.get("strategyId");

  const { setCachedForecast, setCachedStrategies, setCachedInvestigation, cachedStrategies } = useCashPilot();

  const [strategy, setStrategy] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Execution states
  const [started, setStarted] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [steps, setSteps] = useState<ActionStepLog[]>([]);

  // Real-time payment verification statuses
  const [paymentStatusMap, setPaymentStatusMap] = useState<Record<string, "pending" | "paid">>({});
  const [checkingStatusId, setCheckingStatusId] = useState<string | null>(null);
  /**
   * Per-payment-link feedback rendered inline. Replaces window.alert(), which
   * blocks the page, cannot be styled, and disappears without trace - poor for
   * a financial screen where the operator needs the message to stay put.
   */
  const [statusNotice, setStatusNotice] = useState<
    Record<string, { tone: "pending" | "error"; message: string }>
  >({});

  // Timeline events
  const [timeline, setTimeline] = useState<string[]>([]);

  useEffect(() => {
    if (!strategyId) {
      setError("No strategy ID specified for execution.");
      setLoading(false);
      return;
    }

    const cached = cachedStrategies?.find((s) => s.id === strategyId);
    if (cached) {
      setStrategy(cached);
      setLoading(false);
    } else {
      async function fetchStrategy() {
        try {
          const res = await fetch(`/api/strategies/${strategyId}`);
          if (!res.ok) throw new Error("Failed to load strategy details.");
          const data = await res.json();
          setStrategy(data);
        } catch (err: any) {
          setError(err.message);
        } finally {
          setLoading(false);
        }
      }
      fetchStrategy();
    }
  }, [strategyId, cachedStrategies]);

  const addTimelineEvent = (msg: string) => {
    const time = new Date().toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    setTimeline((prev) => [...prev, `[${time}] ${msg}`]);
  };

  const handleStartExecution = async () => {
    if (!strategyId || executing) return;
    setStarted(true);
    setExecuting(true);
    addTimelineEvent("Execution sequence initiated by operator.");

    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategyId }),
      });
      if (!res.ok) {
        throw new Error("API call failed during engine execution.");
      }
      const data = await res.json();
      setSteps(data.steps);

      // Add timeline logs for links
      data.steps.forEach((step: any) => {
        if (step.action === "RECOVER_FAILED_PAYMENTS") {
          addTimelineEvent("Failed payment link generated successfully via Razorpay.");
        } else if (step.action === "PRIORITIZE_COLLECTIONS") {
          addTimelineEvent("Overdue collection payment links compiled successfully.");
        } else if (step.action === "RESCHEDULE_PAYOUT") {
          addTimelineEvent("Vendor Packaging Co payout rescheduled in ledger databases.");
        } else if (step.action === "PAUSE_EXPENSE") {
          addTimelineEvent("Recurring SaaS subscription payout paused successfully.");
        }
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setExecuting(false);
    }
  };

  // Check the status of a specific payment link
  const checkPaymentStatus = async (paymentLinkId: string, actionId: string, label: string) => {
    setCheckingStatusId(paymentLinkId);
    try {
      const res = await fetch(`/api/payment-status?paymentLinkId=${paymentLinkId}&actionId=${actionId}`);
      if (!res.ok) throw new Error("Failed to check status.");
      const data = await res.json();

      if (data.status === "paid") {
        setPaymentStatusMap((prev) => ({ ...prev, [paymentLinkId]: "paid" }));
        setStatusNotice((prev) => {
          const next = { ...prev };
          delete next[paymentLinkId];
          return next;
        });
        addTimelineEvent(`Payment verified for ${label} (Razorpay Link: ${paymentLinkId}).`);
      } else {
        setStatusNotice((prev) => ({
          ...prev,
          [paymentLinkId]: {
            tone: "pending",
            message:
              "Not settled yet. This link exists but no payment has been received — open the checkout and complete it, then check again.",
          },
        }));
      }
    } catch (err: any) {
      setStatusNotice((prev) => ({
        ...prev,
        [paymentLinkId]: { tone: "error", message: `Could not verify payment: ${err.message}` },
      }));
    } finally {
      setCheckingStatusId(null);
    }
  };

  const handleReturn = () => {
    // Clear cache to trigger fresh API reads of the resolved database state
    setCachedForecast(null);
    setCachedStrategies(null);
    setCachedInvestigation(null);
    router.push("/dashboard");
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
          <h2 className="text-lg font-bold text-slate-800">Execution Interrupted</h2>
          <p className="text-slate-500 text-xs mt-2 font-semibold">{error || "Strategy details not found."}</p>
          <Button variant="primary" size="lg" onClick={() => router.push("/strategies")} className="mt-6 w-full">
            Return to Simulator
          </Button>
        </Card>
      </main>
    );
  }

  // Define calculations for Live Cash Impact.
  // The baseline shortfall is read from the simulated DO_NOTHING forecast, not
  // hardcoded: -42000000 was the seed dataset's deficit and was being shown to
  // every business.
  // The DO_NOTHING simulation IS the baseline. If it is not in cache we say so
  // rather than inventing a figure.
  const doNothing = cachedStrategies?.find((s: any) => s.name === "DO_NOTHING");
  const baselineShortfall: number | null =
    typeof doNothing?.result?.projectedBalance === "number"
      ? doNothing.result.projectedBalance
      : null;
  const hasBaseline = baselineShortfall !== null;

  // Retrieve amount variables from actions
  const failedAction = strategy.actions.find((a: any) => a.type === "RECOVER_FAILED_PAYMENTS");
  const failedActionAmount = failedAction ? failedAction.amount : 0;

  const collectionsAction = strategy.actions.find((a: any) => a.type === "PRIORITIZE_COLLECTIONS");

  // Locate the individual link URLs and reference IDs
  const failedStep = steps.find((s) => s.action === "RECOVER_FAILED_PAYMENTS");
  const failedPaymentLinkId = failedStep?.result?.includes("generated: ")
    ? failedStep.result.split("generated: ")[1]
    : null;

  const collectionsStep = steps.find((s) => s.action === "PRIORITIZE_COLLECTIONS");
  let collectionsInvoices: any[] = [];
  if (collectionsStep?.result) {
    try {
      const parsed = JSON.parse(collectionsStep.result);
      collectionsInvoices = parsed.links || [];
    } catch {
      // Fallback if not json
    }
  }

  // Calculate current confirmed recovery amount dynamically
  let confirmedRecovery = 0;

  // Failed card recovery check
  const isFailedCardPaid = failedPaymentLinkId ? paymentStatusMap[failedPaymentLinkId] === "paid" : false;
  if (isFailedCardPaid) {
    confirmedRecovery += failedActionAmount;
  }

  // Invoices checks
  collectionsInvoices.forEach((inv) => {
    if (paymentStatusMap[inv.paymentLinkId] === "paid") {
      confirmedRecovery += inv.amount;
    }
  });

  const pendingRecovery = (failedActionAmount + (collectionsAction ? collectionsAction.amount : 0)) - confirmedRecovery;
  const currentConfirmedPosition = hasBaseline
    ? (baselineShortfall as number) + confirmedRecovery
    : null;
  const potentialPosition = hasBaseline
    ? (baselineShortfall as number) + failedActionAmount + (collectionsAction ? collectionsAction.amount : 0)
    : null;

  // Status check completions
  const totalExecutableAmount = failedActionAmount + (collectionsAction ? collectionsAction.amount : 0);
  const isEverythingCleared = confirmedRecovery >= totalExecutableAmount && totalExecutableAmount > 0;

  return (
    <main className="flex-1 max-w-4xl mx-auto px-6 py-10 w-full space-y-8">
      {/* Header breadcrumb */}
      <Reveal className="flex items-center justify-between">
        <span className="text-xs font-extrabold text-slate-500">
          Intervention Controller Console
        </span>
        <Badge tone="brand">Strategy Approved</Badge>
      </Reveal>

      {/* Trigger state wrapper */}
      {!started ? (
        <Reveal
          variants={{ hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE_OUT_EXPO } } }}
        >
          <Card className="!rounded-3xl text-center space-y-6 py-10">
            <div className="relative w-14 h-14 mx-auto">
              <div className="absolute inset-0 rounded-full bg-emerald-100 animate-pulse-ring" />
              <CheckCircle2 className="w-14 h-14 text-emerald-500 relative" />
            </div>
            <div className="max-w-md mx-auto space-y-2">
              <h2 className="text-xl font-black text-slate-800">Plan Approved &amp; Awaiting Execution</h2>
              <p className="text-xs text-slate-500 leading-relaxed font-semibold">
                This strategy is fully authorized by human review.
                Clicking the button below will generate test-mode payment links via the Razorpay API.
              </p>
            </div>
            <Button variant="primary" size="lg" onClick={handleStartExecution}>
              Begin Approved Execution
            </Button>
          </Card>
        </Reveal>
      ) : (
        <Stagger className="space-y-8" stagger={0.08}>
          {/* Undetermined executions come FIRST: an operator must see what the
              system cannot vouch for before reading any progress figure. */}
          <StaggerItem>
            <UnknownExecutionPanel strategyId={strategyId ?? undefined} />
          </StaggerItem>

          {/* Progress bar */}
          <StaggerItem>
            <Card className="!rounded-3xl space-y-3">
              <div className="flex justify-between items-center text-xs font-bold text-slate-600">
                <span>Intervention Progress</span>
                <span>
                  {isEverythingCleared
                    ? "ALL ACTIONS COMPLETED"
                    : isFailedCardPaid || collectionsInvoices.some((inv) => paymentStatusMap[inv.paymentLinkId] === "paid")
                    ? "IN PROGRESS (PARTIAL SETTLEMENT)"
                    : "PAYMENT LINKS DISPATCHED"}
                </span>
              </div>
              <div className="h-3 bg-slate-100 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-emerald-500 rounded-full"
                  initial={{ width: 0 }}
                  animate={{
                    width: `${totalExecutableAmount > 0 ? (confirmedRecovery / totalExecutableAmount) * 100 : 100}%`,
                  }}
                  transition={{ duration: 0.6, ease: EASE_OUT_EXPO }}
                />
              </div>
            </Card>
          </StaggerItem>

          {/* Action 1 card */}
          {failedAction && (() => {
            const stepObj = steps.find((s) => s.action === "RECOVER_FAILED_PAYMENTS");
            const stepStatus = stepObj?.status || (isFailedCardPaid ? "COMPLETED" : "APPROVED");
            return (
              <StaggerItem>
                <Card className="!rounded-3xl space-y-4">
                  <div className="flex justify-between items-center border-b border-slate-100 pb-3">
                    <div>
                      <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">
                        Action 1: Failed Card Recovery
                      </span>
                      <LifecycleTrack status={stepStatus} />
                    </div>
                    <Badge tone={statusTone(stepStatus, isFailedCardPaid)}>{stepStatus.replace(/_/g, " ")}</Badge>
                  </div>

                  <div className="flex justify-between items-center flex-wrap gap-4 text-xs">
                    <div>
                      <h4 className="font-extrabold text-slate-800 text-sm">ABC Industries</h4>
                      <span className="text-[9px] text-slate-400 block mt-0.5">
                        Original failure: 2 days ago • Method: Razorpay Payment Link
                      </span>
                    </div>
                    <span className="font-black text-slate-700 text-base">{formatINR(failedActionAmount)}</span>
                  </div>

                  {/* Structured Failure Output */}
                  {(stepStatus === "FAILED" || stepStatus === "RECONCILIATION_FAILED") && stepObj?.result && (
                    <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-xs font-semibold text-red-700">
                      <span className="font-black block uppercase text-red-800 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Execution Failure Detail:</span>
                      <p className="mt-1 font-medium">{stepObj.result}</p>
                    </div>
                  )}

                  {/* Reconciliation Mismatch Panel */}
                  {stepStatus === "RECONCILIATION_MISMATCH" && (
                    <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-xs font-semibold space-y-2">
                      <span className="font-black text-amber-800 block">⚠ Reconciliation Mismatch Detected</span>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <span className="text-slate-400 block font-normal text-[10px] uppercase">Expected Ledger Balance</span>
                          <span className="text-slate-800 font-extrabold text-sm">{formatINR(failedActionAmount)}</span>
                        </div>
                        <div>
                          <span className="text-slate-400 block font-normal text-[10px] uppercase">Actual Ledger Balance</span>
                          <span className="text-red-600 font-black text-sm">{formatINR(0)}</span>
                        </div>
                      </div>
                      <p className="text-[10px] text-slate-500 font-medium">Expected recovery was not found in the latest ledger bank feed reconciliation.</p>
                    </div>
                  )}

                  {failedPaymentLinkId && (
                    <div className="pt-2 flex items-center gap-3 border-t border-slate-50 flex-wrap">
                      {!isFailedCardPaid && stepStatus !== "COMPLETED" && (
                        <a
                          href={failedPaymentLinkId}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs px-4 py-2 rounded-xl transition-colors shadow-sm outline-none"
                        >
                          Open Test Checkout <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}

                      {!isFailedCardPaid && stepStatus !== "COMPLETED" && (
                        <Button
                          variant={stepStatus === "EXECUTION_UNKNOWN" ? "primary" : "secondary"}
                          size="sm"
                          loading={checkingStatusId === failedPaymentLinkId}
                          onClick={() => checkPaymentStatus(failedPaymentLinkId, failedAction.id, "Customer")}
                        >
                          {checkingStatusId !== failedPaymentLinkId && (stepStatus === "EXECUTION_UNKNOWN" ? <RefreshCw className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />)}
                          {stepStatus === "EXECUTION_UNKNOWN" ? "Query Status Check" : "Verify Payment Status"}
                        </Button>
                      )}

                      {statusNotice[failedPaymentLinkId] && (
                        <p
                          className={clsx(
                            "text-xs font-semibold leading-relaxed rounded-lg px-3 py-2 border",
                            statusNotice[failedPaymentLinkId].tone === "error"
                              ? "text-red-700 bg-red-50 border-red-200"
                              : "text-amber-800 bg-amber-50 border-amber-200"
                          )}
                        >
                          {statusNotice[failedPaymentLinkId].message}
                        </p>
                      )}

                      {(isFailedCardPaid || stepStatus === "COMPLETED") && (
                        <span className="text-xs text-emerald-600 font-bold flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4" /> Cash settled &amp; resolved in ledger.
                        </span>
                      )}
                    </div>
                  )}
                </Card>
              </StaggerItem>
            );
          })()}

          {/* Action 2 collections card */}
          {collectionsAction && (() => {
            const stepObj = steps.find((s) => s.action === "PRIORITIZE_COLLECTIONS");
            const stepStatus = stepObj?.status || (isEverythingCleared ? "COMPLETED" : "APPROVED");
            return (
              <StaggerItem>
                <Card className="!rounded-3xl space-y-5">
                  <div className="flex justify-between items-center border-b border-slate-100 pb-3">
                    <div>
                      <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">
                        Action 2: Prioritize Collections
                      </span>
                      <LifecycleTrack status={stepStatus} />
                    </div>
                    <Badge tone={statusTone(stepStatus, isEverythingCleared)}>{stepStatus.replace(/_/g, " ")}</Badge>
                  </div>

                  {(stepStatus === "FAILED" || stepStatus === "RECONCILIATION_FAILED") && stepObj?.result && (
                    <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-xs font-semibold text-red-700">
                      <span className="font-black block uppercase text-red-800 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Execution Failure Detail:</span>
                      <p className="mt-1 font-medium">{stepObj.result}</p>
                    </div>
                  )}

                  {stepStatus === "RECONCILIATION_MISMATCH" && (
                    <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-xs font-semibold space-y-2">
                      <span className="font-black text-amber-800 block">⚠ Reconciliation Mismatch Detected</span>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <span className="text-slate-400 block font-normal text-[10px] uppercase">Expected Ledger Balance</span>
                          <span className="text-slate-800 font-extrabold text-sm">{formatINR(collectionsAction.amount)}</span>
                        </div>
                        <div>
                          <span className="text-slate-400 block font-normal text-[10px] uppercase">Actual Ledger Balance</span>
                          <span className="text-red-600 font-black text-sm">{formatINR(confirmedRecovery - (isFailedCardPaid ? failedActionAmount : 0))}</span>
                        </div>
                      </div>
                      <p className="text-[10px] text-slate-500 font-medium">Reconciled invoice payments do not match simulated collections value.</p>
                    </div>
                  )}

                  {collectionsInvoices.length === 0 ? (
                    <div className="flex items-center gap-3 text-xs text-slate-400 font-semibold py-2">
                      <RefreshCw className="w-4 h-4 animate-spin text-indigo-600" />
                      Generating invoice payment recovery links...
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {collectionsInvoices.map((inv) => {
                        const isPaid = paymentStatusMap[inv.paymentLinkId] === "paid";

                        return (
                          <div key={inv.invoiceId} className="bg-slate-50/60 p-4 border border-slate-200 rounded-2xl space-y-3">
                            <div className="flex justify-between items-center text-xs">
                              <div>
                                <span className="font-extrabold text-slate-800 block">{inv.customerName}</span>
                                <span className="text-[9px] text-slate-400 block mt-0.5">
                                  Overdue Invoice: {inv.invoiceId} • Method: Razorpay Payment Link
                                </span>
                              </div>
                              <span className="font-black text-slate-700">{formatINR(inv.amount)}</span>
                            </div>

                            <div className="flex items-center gap-3 pt-2 border-t border-slate-100 flex-wrap">
                              {!isPaid && (
                                <a
                                  href={inv.shortUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs px-3.5 py-2 rounded-xl transition-colors shadow-sm outline-none"
                                >
                                  Open Test Checkout <ExternalLink className="w-3.5 h-3.5" />
                                </a>
                              )}

                              {!isPaid && (
                                <Button
                                  variant={stepStatus === "EXECUTION_UNKNOWN" ? "primary" : "secondary"}
                                  size="sm"
                                  loading={checkingStatusId === inv.paymentLinkId}
                                  onClick={() => checkPaymentStatus(inv.paymentLinkId, collectionsAction.id, inv.customerName)}
                                >
                                  {checkingStatusId !== inv.paymentLinkId && (stepStatus === "EXECUTION_UNKNOWN" ? <RefreshCw className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />)}
                                  {stepStatus === "EXECUTION_UNKNOWN" ? "Query Status Check" : "Verify Status"}
                                </Button>
                              )}

                              {statusNotice[inv.paymentLinkId] && (
                                <p
                                  className={clsx(
                                    "text-xs font-semibold leading-relaxed rounded-lg px-3 py-2 border",
                                    statusNotice[inv.paymentLinkId].tone === "error"
                                      ? "text-red-700 bg-red-50 border-red-200"
                                      : "text-amber-800 bg-amber-50 border-amber-200"
                                  )}
                                >
                                  {statusNotice[inv.paymentLinkId].message}
                                </p>
                              )}

                              {isPaid && (
                                <span className="text-xs text-emerald-600 font-bold flex items-center gap-1.5">
                                  <CheckCircle2 className="w-4 h-4" /> Invoice collected &amp; verified.
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Card>
              </StaggerItem>
            );
          })()}

          {/* SECTION I — Live Cash Impact progress panel */}
          <StaggerItem>
            <Card className="!rounded-3xl space-y-4">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest block border-b border-slate-100 pb-3">
                Live Cash Impact Matrix
              </h3>

              <div className="space-y-3.5 text-xs font-semibold">
                <div className="flex justify-between">
                  <span className="text-slate-400">Baseline Deficit Outlook</span>
                  <span className="text-red-600 font-extrabold">{hasBaseline ? formatINR(baselineShortfall as number) : "Unavailable"}</span>
                </div>

                <div className="flex justify-between">
                  <span className="text-slate-400">Confirmed Cash Recovered</span>
                  <span className="text-emerald-600 font-extrabold">+{formatINR(confirmedRecovery)}</span>
                </div>

                <div className="flex justify-between">
                  <span className="text-slate-400">Pending Potential Recovery</span>
                  <span className="text-indigo-600 font-extrabold">+{formatINR(pendingRecovery)}</span>
                </div>

                <div className="border-t border-slate-100 pt-3 flex justify-between">
                  <span className="text-slate-800 font-bold">Current Confirmed Ledger Balance</span>
                  <span className={clsx("font-black text-sm", (currentConfirmedPosition ?? 0) < 0 ? "text-red-600" : "text-slate-800")}>
                    {currentConfirmedPosition === null ? "Unavailable" : formatINR(currentConfirmedPosition)}
                  </span>
                </div>

                <div className="flex justify-between text-[11px] text-slate-400 font-bold italic">
                  <span>Projected Balance If All Pending Clear</span>
                  <span>{formatINR(potentialPosition)}</span>
                </div>
              </div>
            </Card>
          </StaggerItem>

          {/* Chronological Timeline */}
          <StaggerItem>
            <Card className="!rounded-3xl space-y-4">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest block border-b border-slate-100 pb-3">
                Execution Timeline Logs
              </h3>
              <div className="space-y-2 max-h-40 overflow-y-auto font-mono text-[10px] text-slate-500">
                <AnimatePresence initial={false}>
                  {timeline.map((event, idx) => (
                    <motion.div
                      key={idx}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="flex items-center gap-2"
                    >
                      <span className="text-indigo-500 font-bold">●</span>
                      <span>{event}</span>
                    </motion.div>
                  ))}
                </AnimatePresence>
                {timeline.length === 0 && (
                  <span className="italic text-slate-400 block py-2">
                    Awaiting execution sequences to populate logs...
                  </span>
                )}
              </div>
            </Card>
          </StaggerItem>

          {/* Outcome completions message */}
          <AnimatePresence>
            {isEverythingCleared && (
              <motion.div
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.4, ease: EASE_OUT_EXPO }}
              >
                <Card tone="dark" className="!rounded-3xl bg-gradient-to-br from-indigo-600 to-indigo-800 border-indigo-700 text-center flex flex-col items-center justify-center space-y-2">
                  <Sparkles className="w-8 h-8 text-amber-300" />
                  <h2 className="text-lg font-black tracking-tight">
                    All Obligations Secured &amp; Resolved
                  </h2>
                  <p className="text-xs text-indigo-100 max-w-md leading-relaxed font-semibold">
                    All payment links successfully cleared. Dynamic cash ledger balance increased to{" "}
                    <strong>{currentConfirmedPosition === null ? "an unavailable amount" : formatINR(currentConfirmedPosition)}</strong>. Runway risk resolved (LOW Risk).
                  </p>
                </Card>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Return CTA */}
          <StaggerItem className="flex justify-end pt-2">
            <Button variant="primary" size="lg" onClick={handleReturn} className="group">
              Return to Cash Dashboard
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </Button>
          </StaggerItem>
        </Stagger>
      )}
    </main>
  );
}

export default function Execution() {
  return (
    <Suspense
      fallback={
        <main className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-6 w-full">
          <Skeleton className="h-10 w-1/4" />
          <Skeleton className="h-44 w-full max-w-2xl rounded-2xl" />
          <Skeleton className="h-64 w-full max-w-2xl rounded-2xl" />
        </main>
      }
    >
      <ExecutionContent />
    </Suspense>
  );
}
