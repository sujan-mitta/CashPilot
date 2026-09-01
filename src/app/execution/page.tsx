"use client";

import React, { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence } from "framer-motion";
import { useCashPilot, type Strategy } from "@/context/CashPilotContext";
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
import { errorMessage } from "@/lib/errors";
import { useToast } from "@/components/ui/Toast";
import {
  executionErrorDetail,
  executionErrorTitle,
  timelineLineFor,
} from "./timeline";

interface ActionStepLog {
  id: string;
  action: string;
  status: string;
  result: string;
  narration: string;
  /** Provider ids this step produced. Empty when nothing was dispatched. */
  externalRefs?: string[];
  /** Where a payer is sent. An id is not an address; see below. */
  shortUrl?: string;
  intentIds?: string[];
}

/** Plain-language name for an action type, with no demo vendor names in it. */




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
  // Not started is not a failure. Most often the action is healthy and already
  // in flight, awaiting settlement of a link that exists.
  if (status === "NOT_STARTED") return "warning";
  if (status === "EXECUTION_UNKNOWN" || status === "RECONCILIATION_MISMATCH") return "warning";
  return "brand";
}

function LifecycleTrack({ status }: { status: string }) {
  return (
    <div className="label flex items-center gap-1.5 mt-1.5">
      {LIFECYCLE_STATES.map((sName, sIdx) => {
        const isPastOrCurrent = getStatusOrder(status) >= sIdx + 1;
        return (
          <div key={sName} className="flex items-center gap-1">
            <span className={clsx("px-1.5 py-0.5 rounded transition-colors duration-300", isPastOrCurrent ? "bg-brand-500/15 text-brand-300 font-semibold" : "bg-ground-200 text-ink-400")}>
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
  const { toast } = useToast();

  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Execution states
  const [started, setStarted] = useState(false);

  /**
   * Money that has already arrived, read from the server on every load.
   *
   * Settlement does not happen on this page. A payer opens a Razorpay link and
   * a webhook credits the ledger minutes later, quite possibly after this tab
   * was closed. Without asking the server, the page only knows whether IT
   * started an execution in this browser session — so a real payment could land,
   * move the cash and write the ledger event while the screen still said
   * "Awaiting Execution" and offered to run the plan again.
   */
  const [receipts, setReceipts] = useState<{
    currentCash: number;
    totalReceived: number;
    outstandingCount: number;
    received: Array<{ id: string; amount: number; description: string; settledAt: string }>;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/recovery-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d && !d.error) setReceipts(d); })
      .catch(() => { /* The panel is additive; its absence must not break the page. */ });
    return () => { cancelled = true; };
  }, []);
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
        } catch (err) {
          setError(errorMessage(err));
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
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // /api/execute answers with specific, actionable failures - a stale
        // strategy with the list of what changed, a drift percentage, the
        // missing configuration keys, a 409 conflict. All of it used to be
        // discarded and replaced with "API call failed during engine
        // execution", leaving the operator a dead end on the money screen.
        setStarted(false);
        addTimelineEvent(`Execution refused: ${executionErrorTitle(data)}`);
        toast({
          tone: data.error === "STRATEGY_STALE" ? "warning" : "danger",
          title: executionErrorTitle(data),
          description: `${executionErrorDetail(data, res.status)} Nothing was executed.`,
          action:
            data.error === "STRATEGY_STALE" || data.error === "STATE_DRIFT_DETECTED"
              ? { label: "Re-run comparison", onClick: () => router.push("/strategies") }
              : undefined,
        });
        setExecuting(false);
        return;
      }
      setSteps(data.steps);

      // The timeline reports the step's ACTUAL status.
      //
      // This used to log "...successfully" for every step regardless of
      // `step.status`, so a FAILED or EXECUTION_UNKNOWN action - the exact
      // cases an operator most needs to see - was announced as a success on
      // the screen where money moves. It also named "Packaging Co" and "SaaS"
      // from the demo dataset, which is somebody else's vendor for every real
      // business.
      data.steps.forEach((step: { action: string; status: string; result?: string }) => {
        addTimelineEvent(timelineLineFor(step));
      });

      if (data.executionOutcome === "EXECUTION_UNKNOWN" || data.requiresManualVerification) {
        addTimelineEvent(
          "At least one step has an undetermined outcome. Do NOT re-run it - verify at the provider first."
        );
      }
    } catch (err) {
      setError(errorMessage(err));
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
    } catch (err) {
      setStatusNotice((prev) => ({
        ...prev,
        [paymentLinkId]: { tone: "error", message: `Could not verify payment: ${errorMessage(err)}` },
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
        <Skeleton className="h-28 rounded-md" />
        <Skeleton className="h-64 rounded-md" />
      </main>
    );
  }

  if (error || !strategy) {
    return (
      <main className="flex-1 flex items-center justify-center py-16">
        <Card className="max-w-md text-center border-risk-500/25 bg-risk-500/10">
          <ShieldAlert className="w-12 h-12 text-risk-400 mx-auto mb-4" />
          <h2 className="text-lg font-bold text-ink-100">Execution Interrupted</h2>
          <p className="text-ink-300 text-xs mt-2 font-semibold">{error || "Strategy details not found."}</p>
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
  const doNothing = cachedStrategies?.find((s) => s.name === "DO_NOTHING");
  const baselineShortfall: number | null =
    typeof doNothing?.result?.projectedBalance === "number"
      ? doNothing.result.projectedBalance
      : null;
  const hasBaseline = baselineShortfall !== null;

  // Retrieve amount variables from actions
  const failedAction = strategy.actions.find((a) => a.type === "RECOVER_FAILED_PAYMENTS");
  const failedActionAmount = failedAction ? failedAction.amount : 0;

  const collectionsAction = strategy.actions.find((a) => a.type === "PRIORITIZE_COLLECTIONS");

  // Locate the individual link URLs and reference IDs.
  //
  // From the structured `externalRefs` the API now returns, not by slicing the
  // human-readable `result` string on "generated: ". That string is also where
  // the "Already in flight" and "Not in a claimable state" explanations are
  // written, so the old parse produced null or a fragment of an error message
  // on every path except the happy one.
  const failedStep = steps.find((s) => s.action === "RECOVER_FAILED_PAYMENTS");

  // THE CHECKOUT ADDRESS, which is not the same thing as the link id.
  //
  // This button used to be `href={failedPaymentLinkId}` — a provider ID used
  // directly as a URL. The browser resolved it relative to our own origin, so
  // "Open Test Checkout" navigated to /plink_TWLacSR5QT2y0D on cash-pilot and
  // returned a 404. The step now carries the URL the executor already knew.
  const failedCheckoutUrl = failedStep?.shortUrl ?? null;
  const failedPaymentLinkId =
    failedStep?.externalRefs?.[0] ??
    (failedStep?.result?.includes("generated: ")
      ? // Legacy fallback for steps recorded before externalRefs existed.
        failedStep.result.split("generated: ")[1] ?? null
      : null);

  const collectionsStep = steps.find((s) => s.action === "PRIORITIZE_COLLECTIONS");
  let collectionsInvoices: Array<{
    paymentLinkId: string;
    amount: number;
    invoiceId: string;
    customerName: string;
    shortUrl: string;
  }> = [];
  if (collectionsStep?.result) {
    try {
      const parsed = JSON.parse(collectionsStep.result);
      collectionsInvoices = parsed.links || [];
    } catch (e) {
      console.error("Failed to parse collectionsStep result:", e);
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
        <span className="text-xs font-semibold text-ink-300">
          Running your plan
        </span>
        <Badge tone="brand">Approved</Badge>
      </Reveal>

      {/* MONEY THAT HAS ARRIVED
          Deliberately the first thing on the page and written in plain words:
          an operator who has just paid a link wants one question answered — did
          it land? — and previously nothing here answered it. */}
      {receipts && receipts.received.length > 0 && (
        <Reveal>
          <div className="rounded-md border border-safe-500/30 bg-safe-500/[0.07] p-5">
            <div className="flex items-start gap-3.5">
              <CheckCircle2 className="w-5 h-5 text-safe-400 shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-semibold text-ink-100">
                  {receipts.received.length === 1
                    ? "Payment received"
                    : `${receipts.received.length} payments received`}
                </h2>
                <p className="text-ink-300 text-[13px] mt-1 leading-relaxed">
                  <strong className="text-safe-400 font-semibold">
                    {formatINR(receipts.totalReceived)}
                  </strong>{" "}
                  has arrived and is already counted in your balance. You have{" "}
                  <strong className="text-ink-100 font-semibold">
                    {formatINR(receipts.currentCash)}
                  </strong>{" "}
                  in the bank now.
                </p>

                <ul className="mt-3.5 space-y-2">
                  {receipts.received.map((r) => (
                    <li
                      key={r.id}
                      className="flex items-center justify-between gap-4 text-[12.5px] border-t border-line-faint pt-2"
                    >
                      <span className="text-ink-300 truncate">{r.description}</span>
                      <span className="text-safe-400 font-semibold shrink-0">
                        + {formatINR(r.amount)}
                      </span>
                    </li>
                  ))}
                </ul>

                <p className="text-ink-400 text-[11.5px] mt-3 leading-relaxed">
                  {receipts.outstandingCount > 0
                    ? `${receipts.outstandingCount} more payment link${receipts.outstandingCount === 1 ? " is" : "s are"} still waiting to be paid.`
                    : "Nothing else is outstanding."}{" "}
                  Because this money has landed, any plan built before it arrived is now
                  working from out-of-date figures — start again from the dashboard to get one
                  based on what you actually have.
                </p>
              </div>
            </div>
          </div>
        </Reveal>
      )}

      {/* Trigger state wrapper */}
      {!started ? (
        <Reveal
          variants={{ hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE_OUT_EXPO } } }}
        >
          <Card className="rounded-md text-center space-y-6 py-10">
            <div className="relative w-14 h-14 mx-auto">
              <div className="absolute inset-0 rounded-full bg-safe-500/15 animate-pulse-ring" />
              <CheckCircle2 className="w-14 h-14 text-safe-400 relative" />
            </div>
            <div className="max-w-md mx-auto space-y-2">
              <h2 className="text-xl font-semibold text-ink-100">Plan Approved &amp; Awaiting Execution</h2>
              <p className="text-xs text-ink-300 leading-relaxed font-semibold">
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
            <Card className="rounded-md space-y-3">
              <div className="flex justify-between items-center text-xs font-bold text-ink-300">
                <span>Intervention Progress</span>
                <span>
                  {isEverythingCleared
                    ? "ALL ACTIONS COMPLETED"
                    : isFailedCardPaid || collectionsInvoices.some((inv) => paymentStatusMap[inv.paymentLinkId] === "paid")
                    ? "IN PROGRESS (PARTIAL SETTLEMENT)"
                    : "PAYMENT LINKS DISPATCHED"}
                </span>
              </div>
              <div className="h-3 bg-ground-200 rounded-full overflow-hidden">
                {/* Width is meaningful here — it tracks how much of the money
                    has actually settled — so it still moves. A CSS transition
                    does it without a JS animation loop. */}
                <div
                  className="h-full bg-safe-500 rounded-full transition-[width] duration-500 ease-out"
                  style={{
                    width: `${totalExecutableAmount > 0 ? (confirmedRecovery / totalExecutableAmount) * 100 : 100}%`,
                  }}
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
                <Card className="rounded-md space-y-4">
                  <div className="flex justify-between items-center border-b border-line-faint pb-3">
                    <div>
                      <span className="label block">
                        Action 1: Failed Card Recovery
                      </span>
                      <LifecycleTrack status={stepStatus} />
                    </div>
                    <Badge tone={statusTone(stepStatus, isFailedCardPaid)}>{stepStatus.replace(/_/g, " ")}</Badge>
                  </div>

                  <div className="flex justify-between items-center flex-wrap gap-4 text-xs">
                    <div>
                      <h4 className="font-semibold text-ink-100 text-sm">ABC Industries</h4>
                      <span className="text-[11px] text-ink-400 block mt-0.5">
                        Original failure: 2 days ago • Method: Razorpay Payment Link
                      </span>
                    </div>
                    <span className="font-semibold text-ink-200 text-base">{formatINR(failedActionAmount)}</span>
                  </div>

                  {/* Structured Failure Output */}
                  {(stepStatus === "FAILED" || stepStatus === "RECONCILIATION_FAILED") && stepObj?.result && (
                    <div className="bg-risk-500/10 border border-risk-500/25 rounded-md p-4 text-xs font-semibold text-risk-400">
                      <span className="font-semibold block text-risk-400 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Execution Failure Detail:</span>
                      <p className="mt-1 font-medium">{stepObj.result}</p>
                    </div>
                  )}

                  {/* Did not start. Its own panel, because presenting it in the
                      red failure box is what made a correct refusal look like a
                      break and sent an operator re-running it. */}
                  {stepStatus === "NOT_STARTED" && stepObj?.result && (
                    <div className="bg-warn-500/10 border border-warn-500/25 rounded-md p-4 text-xs text-warn-400">
                      <span className="font-semibold block text-warn-400 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Not started &mdash; nothing was changed</span>
                      <p className="mt-1 font-medium">{stepObj.result}</p>
                      {/* The refusal says to settle the outstanding link, so it
                          has to be reachable from here. */}
                      {stepObj.shortUrl && (
                        <a
                          href={stepObj.shortUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-3 inline-flex items-center gap-1.5 bg-warn-500/20 hover:bg-warn-500/30 text-warn-400 font-semibold px-3 py-1.5 rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050"
                        >
                          Open the outstanding link <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  )}

                  {/* Reconciliation Mismatch Panel */}
                  {stepStatus === "RECONCILIATION_MISMATCH" && (
                    <div className="bg-warn-500/10 border border-warn-500/25 rounded-md p-4 text-xs font-semibold space-y-2">
                      <span className="font-semibold text-warn-400 block">⚠ Reconciliation Mismatch Detected</span>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <span className="text-ink-400 block font-normal text-[11px]">Expected Ledger Balance</span>
                          <span className="text-ink-100 font-semibold text-sm">{formatINR(failedActionAmount)}</span>
                        </div>
                        <div>
                          <span className="text-ink-400 block font-normal text-[11px]">Actual Ledger Balance</span>
                          <span className="text-risk-400 font-semibold text-sm">{formatINR(0)}</span>
                        </div>
                      </div>
                      <p className="text-[11px] text-ink-300 font-medium">Expected recovery was not found in the latest ledger bank feed reconciliation.</p>
                    </div>
                  )}

                  {failedPaymentLinkId && (
                    <div className="pt-2 flex items-center gap-3 border-t border-line-faint flex-wrap">
                      {/* Rendered only when we hold a real address. Offering a
                          checkout button that leads to a 404 is worse than not
                          offering one: the money is genuinely owed, and the
                          payer concludes the link is broken. */}
                      {failedCheckoutUrl && !isFailedCardPaid && stepStatus !== "COMPLETED" && (
                        <a
                          href={failedCheckoutUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 bg-brand-500 hover:bg-brand-600 text-white font-bold text-xs px-4 py-2 rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050"
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
                            "text-xs font-semibold leading-relaxed rounded-md px-3 py-2 border",
                            statusNotice[failedPaymentLinkId].tone === "error"
                              ? "text-risk-400 bg-risk-500/10 border-risk-500/25"
                              : "text-warn-400 bg-warn-500/10 border-warn-500/25"
                          )}
                        >
                          {statusNotice[failedPaymentLinkId].message}
                        </p>
                      )}

                      {(isFailedCardPaid || stepStatus === "COMPLETED") && (
                        <span className="text-xs text-safe-400 font-bold flex items-center gap-1.5">
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
                <Card className="rounded-md space-y-5">
                  <div className="flex justify-between items-center border-b border-line-faint pb-3">
                    <div>
                      <span className="label">
                        Action 2: Prioritize Collections
                      </span>
                      <LifecycleTrack status={stepStatus} />
                    </div>
                    <Badge tone={statusTone(stepStatus, isEverythingCleared)}>{stepStatus.replace(/_/g, " ")}</Badge>
                  </div>

                  {(stepStatus === "FAILED" || stepStatus === "RECONCILIATION_FAILED") && stepObj?.result && (
                    <div className="bg-risk-500/10 border border-risk-500/25 rounded-md p-4 text-xs font-semibold text-risk-400">
                      <span className="font-semibold block text-risk-400 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Execution Failure Detail:</span>
                      <p className="mt-1 font-medium">{stepObj.result}</p>
                    </div>
                  )}

                  {stepStatus === "NOT_STARTED" && stepObj?.result && (
                    <div className="bg-warn-500/10 border border-warn-500/25 rounded-md p-4 text-xs text-warn-400">
                      <span className="font-semibold block text-warn-400 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Not started &mdash; nothing was changed</span>
                      <p className="mt-1 font-medium">{stepObj.result}</p>
                      {/* The refusal says to settle the outstanding link, so it
                          has to be reachable from here. */}
                      {stepObj.shortUrl && (
                        <a
                          href={stepObj.shortUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-3 inline-flex items-center gap-1.5 bg-warn-500/20 hover:bg-warn-500/30 text-warn-400 font-semibold px-3 py-1.5 rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050"
                        >
                          Open the outstanding link <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  )}

                  {stepStatus === "RECONCILIATION_MISMATCH" && (
                    <div className="bg-warn-500/10 border border-warn-500/25 rounded-md p-4 text-xs font-semibold space-y-2">
                      <span className="font-semibold text-warn-400 block">⚠ Reconciliation Mismatch Detected</span>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <span className="text-ink-400 block font-normal text-[11px]">Expected Ledger Balance</span>
                          <span className="text-ink-100 font-semibold text-sm">{formatINR(collectionsAction.amount)}</span>
                        </div>
                        <div>
                          <span className="text-ink-400 block font-normal text-[11px]">Actual Ledger Balance</span>
                          <span className="text-risk-400 font-semibold text-sm">{formatINR(confirmedRecovery - (isFailedCardPaid ? failedActionAmount : 0))}</span>
                        </div>
                      </div>
                      <p className="text-[11px] text-ink-300 font-medium">Reconciled invoice payments do not match simulated collections value.</p>
                    </div>
                  )}

                  {collectionsInvoices.length === 0 ? (
                    <div className="flex items-center gap-3 text-xs text-ink-400 font-semibold py-2">
                      <RefreshCw className="w-4 h-4 animate-spin text-brand-300" />
                      Generating invoice payment recovery links...
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {collectionsInvoices.map((inv) => {
                        const isPaid = paymentStatusMap[inv.paymentLinkId] === "paid";

                        return (
                          <div key={inv.invoiceId} className="bg-ground-200/60 p-4 border border-line-soft rounded-md space-y-3">
                            <div className="flex justify-between items-center text-xs">
                              <div>
                                <span className="font-semibold text-ink-100 block">{inv.customerName}</span>
                                <span className="text-[11px] text-ink-400 block mt-0.5">
                                  Overdue Invoice: {inv.invoiceId} • Method: Razorpay Payment Link
                                </span>
                              </div>
                              <span className="font-semibold text-ink-200">{formatINR(inv.amount)}</span>
                            </div>

                            <div className="flex items-center gap-3 pt-2 border-t border-line-faint flex-wrap">
                              {!isPaid && (
                                <a
                                  href={inv.shortUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1.5 bg-brand-500 hover:bg-brand-600 text-white font-bold text-xs px-3.5 py-2 rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050"
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
                                    "text-xs font-semibold leading-relaxed rounded-md px-3 py-2 border",
                                    statusNotice[inv.paymentLinkId].tone === "error"
                                      ? "text-risk-400 bg-risk-500/10 border-risk-500/25"
                                      : "text-warn-400 bg-warn-500/10 border-warn-500/25"
                                  )}
                                >
                                  {statusNotice[inv.paymentLinkId].message}
                                </p>
                              )}

                              {isPaid && (
                                <span className="text-xs text-safe-400 font-bold flex items-center gap-1.5">
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
            <Card className="rounded-md space-y-4">
              <h3 className="text-xs font-bold text-ink-400 block border-b border-line-faint pb-3">
                Live Cash Impact Matrix
              </h3>

              <div className="space-y-3.5 text-xs font-semibold">
                <div className="flex justify-between">
                  <span className="text-ink-400">Baseline Deficit Outlook</span>
                  <span className="text-risk-400 font-semibold">{hasBaseline ? formatINR(baselineShortfall as number) : "Unavailable"}</span>
                </div>

                <div className="flex justify-between">
                  <span className="text-ink-400">Confirmed Cash Recovered</span>
                  <span className="text-safe-400 font-semibold">+{formatINR(confirmedRecovery)}</span>
                </div>

                <div className="flex justify-between">
                  <span className="text-ink-400">Pending Potential Recovery</span>
                  <span className="text-brand-300 font-semibold">+{formatINR(pendingRecovery)}</span>
                </div>

                <div className="border-t border-line-faint pt-3 flex justify-between">
                  <span className="text-ink-100 font-bold">Current Confirmed Ledger Balance</span>
                  <span className={clsx("font-semibold text-sm", (currentConfirmedPosition ?? 0) < 0 ? "text-risk-400" : "text-ink-100")}>
                    {currentConfirmedPosition === null ? "Unavailable" : formatINR(currentConfirmedPosition)}
                  </span>
                </div>

                <div className="flex justify-between text-[11px] text-ink-400 font-bold italic">
                  <span>Projected Balance If All Pending Clear</span>
                  <span>{potentialPosition === null ? "Unavailable" : formatINR(potentialPosition)}</span>
                </div>
              </div>
            </Card>
          </StaggerItem>

          {/* Chronological Timeline */}
          <StaggerItem>
            <Card className="rounded-md space-y-4">
              <h3 className="text-xs font-bold text-ink-400 block border-b border-line-faint pb-3">
                Execution Timeline Logs
              </h3>
              <div className="space-y-2 max-h-40 overflow-y-auto font-mono text-[11px] text-ink-300">
                <AnimatePresence initial={false}>
                  {timeline.map((event, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-2"
                    >
                      <span className="text-brand-400 font-bold">●</span>
                      <span>{event}</span>
                    </div>
                  ))}
                </AnimatePresence>
                {timeline.length === 0 && (
                  <span className="italic text-ink-400 block py-2">
                    Awaiting execution sequences to populate logs...
                  </span>
                )}
              </div>
            </Card>
          </StaggerItem>

          {/* Outcome completions message */}
          <AnimatePresence>
            {isEverythingCleared && (
              <div
              >
                <Card tone="raised" className="rounded-md bg-ground-200 border-brand-500/30 text-center flex flex-col items-center justify-center space-y-2">
                  <Sparkles className="w-8 h-8 text-warn-400" />
                  <h2 className="text-lg font-semibold tracking-tight">
                    All Obligations Secured &amp; Resolved
                  </h2>
                  <p className="text-xs text-brand-300 max-w-md leading-relaxed font-semibold">
                    All payment links successfully cleared. Dynamic cash ledger balance increased to{" "}
                    <strong>{currentConfirmedPosition === null ? "an unavailable amount" : formatINR(currentConfirmedPosition)}</strong>. Runway risk resolved (LOW Risk).
                  </p>
                </Card>
              </div>
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
          <Skeleton className="h-44 w-full max-w-2xl rounded-md" />
          <Skeleton className="h-64 w-full max-w-2xl rounded-md" />
        </main>
      }
    >
      <ExecutionContent />
    </Suspense>
  );
}
