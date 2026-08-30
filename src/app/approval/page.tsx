"use client";

import React, { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useCashPilot, type Strategy } from "@/context/CashPilotContext";
import { formatINR } from "@/lib/format";
import { planName } from "@/lib/planNames";
import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";
import { Card } from "@/components/ui/Card";
import { Button, buttonClasses } from "@/components/ui/Button";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { Reveal, Stagger, StaggerItem } from "@/components/ui/Reveal";
import { EASE_OUT_EXPO } from "@/components/ui/motion";
import { ShieldCheck, ShieldAlert, ArrowRight, CheckCircle2, XCircle, Lock } from "lucide-react";
import clsx from "clsx";
import { errorMessage } from "@/lib/errors";
import { useToast } from "@/components/ui/Toast";
import { buildRejectionRequest } from "./rejectionRequest";
import { describeFreshness } from "@/lib/engine/decisionFreshnessDisplay";

const actionCategory = (type: string) =>
  type === "RECOVER_FAILED_PAYMENTS"
    ? "Chase a customer payment that failed"
    : type === "PRIORITIZE_COLLECTIONS"
    ? "Ask overdue customers to pay early"
    : type === "RESCHEDULE_PAYOUT"
    ? "Push back one supplier payment"
    : "Pause a recurring subscription";

/**
 * What the system will ACTUALLY do, on the screen where a human authorises it.
 *
 * Two of these were promises the product does not keep:
 *
 *   - "Sends the customer a new payment link" / "Sends payment links to your
 *     overdue customers". Payment links are created with
 *     `notify: { email: false, sms: false }` and the Invoice model holds no
 *     customer email or phone at all, so nothing is ever sent to anybody. The
 *     operator receives a URL to pass on themselves.
 *
 *   - "Moves the payment date to day 15", while the executor moved it 20 days
 *     out. The approval gate is the last place a figure may be wrong; the day
 *     now comes from the same constant the executor applies.
 */
const executionMethod = (type: string) =>
  type === "RECOVER_FAILED_PAYMENTS"
    ? "Creates a new payment link for you to send to the customer"
    : type === "PRIORITIZE_COLLECTIONS"
    ? "Creates a payment link per overdue invoice for you to send"
    : type === "RESCHEDULE_PAYOUT"
    ? `Moves the payment date to day ${FINANCIAL_CONFIG.RESCHEDULE_DELAY_DAYS}`
    : "Stops the subscription billing for now";

const impactRealization = (type: string) =>
  type === "RECOVER_FAILED_PAYMENTS"
    ? "Only once you send the link and the customer pays."
    : type === "PRIORITIZE_COLLECTIONS"
    ? "Only once you send the links and those customers pay early."
    : type === "RESCHEDULE_PAYOUT"
    ? "Straight away — but you still owe it later."
    : "Straight away, as a lower bill.";

function ApprovalContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const strategyId = searchParams.get("strategyId");

  const { cachedForecast, cachedStrategies } = useCashPilot();
  const { toast } = useToast();
  const cachedStrategy = strategyId ? cachedStrategies?.find((s) => s.id === strategyId) ?? null : null;
  const [fetchedStrategy, setFetchedStrategy] = useState<Strategy | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Derived, not stored: a cache hit or a fetched result both flow into
  // `strategy` without the effect ever setting it synchronously, and this also
  // picks up the cache the moment it populates. loading/error fall out of the
  // same values.
  const strategy = cachedStrategy ?? fetchedStrategy;
  const error = strategyId ? fetchError : "No strategy selection was found in current session.";
  const loading = !!strategyId && !strategy && !fetchError;
  const [approving, setApproving] = useState(false);

  // Track stale state simulation
  const [isStale, setIsStale] = useState(false);

  // Modal controls
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showRejectPanel, setShowRejectPanel] = useState(false);
  const [fetchedBaseline, setFetchedBaseline] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejecting, setRejecting] = useState(false);

  /**
   * When this recommendation stops being executable.
   *
   * Fetched on its own rather than read off the strategy, because a cache hit
   * skips the detail request entirely — and whether the operator sees an expiry
   * warning must not depend on which path happened to load the plan.
   */
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  // The "if you do nothing" figure lives only in the in-memory cache, so a
  // refresh or a shared link rendered the most important comparison on this
  // screen as "Unavailable". It is recoverable: /api/forecast IS the do-nothing
  // projection, so fall back to it rather than dropping the number.
  useEffect(() => {
    if (cachedForecast?.forecast?.days?.length) return;
    let cancelled = false;
    fetch("/api/forecast")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.forecast?.days?.length) return;
        const days = data.forecast.days;
        setFetchedBaseline(days[days.length - 1]?.projectedBalance ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cachedForecast]);

  useEffect(() => {
    if (!strategyId) return;
    let cancelled = false;
    fetch(`/api/strategies/${strategyId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.decisionExpiresAt) setExpiresAt(data.decisionExpiresAt);
      })
      .catch(() => {
        // Expiry is advisory here. The gate at approval remains authoritative,
        // so failing to show a warning must never block the screen.
      });
    return () => {
      cancelled = true;
    };
  }, [strategyId]);

  useEffect(() => {
    // Only fetch when there is a selection with no cached copy. A cache hit is
    // reflected by the derived `strategy` above, so nothing is set here
    // synchronously; the request starts at the await.
    if (!strategyId || cachedStrategy) return;
    let cancelled = false;
    async function fetchStrategyDetails() {
      try {
        const res = await fetch(`/api/strategies/${strategyId}`);
        if (!res.ok) {
          throw new Error("Unable to retrieve strategy details.");
        }
        const data = await res.json();
        if (!cancelled) setFetchedStrategy(data);
      } catch (err) {
        if (!cancelled) setFetchError(errorMessage(err));
      }
    }
    fetchStrategyDetails();
    return () => {
      cancelled = true;
    };
  }, [strategyId, cachedStrategy]);

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
        // Staleness is a legitimate, expected, recoverable condition — the
        // ledger moved since this plan was simulated. It gets its own inline
        // state with a re-simulate path rather than being thrown as an error,
        // which is how it used to reach the operator: as an OS dialog reading
        // "Authorization error".
        if (data.error === "STRATEGY_STALE") {
          setIsStale(true);
          setApproving(false);
          toast({
            tone: "warning",
            title: "Your figures moved since this plan was made",
            description:
              data.message ||
              "Nothing was authorized. Re-run the comparison so you are approving current numbers.",
            action: { label: "Re-run comparison", onClick: () => router.push("/strategies") },
          });
          return;
        }
        throw new Error(data.message || "We could not record your approval.");
      }

      // Navigate to Screen 5 (Execution)
      router.push(`/execution?strategyId=${strategyId}`);
    } catch (err) {
      setApproving(false);
      toast({
        tone: "danger",
        title: "Approval was not recorded",
        description: `${errorMessage(err)} No money has moved and nothing was authorized.`,
      });
    }
  };

  const handleReject = () => setShowRejectPanel(true);

  const confirmReject = async () => {
    if (!strategyId || rejecting) return;

    // This used to be a toast and a redirect with no request at all. The
    // operator saw "Plan declined", and server-side nothing happened: the
    // decision stayed PRESENTED, the actions stayed PENDING, and the plan
    // remained approvable and executable. The typed reason was discarded with
    // it. A refusal that leaves the thing refusable is not a refusal.
    setRejecting(true);

    try {
      const res = await fetch("/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRejectionRequest(strategyId, rejectReason)),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.message || data.error || "We could not record your decision.");
      }

      setShowRejectPanel(false);
      setRejecting(false);
      toast({
        tone: "info",
        title: "Plan declined",
        description: "Recorded. Nothing was authorized and no money moved.",
      });
      router.push("/strategies");
    } catch (err) {
      // Stay on the panel. Navigating away after a failed decline would leave
      // the operator believing they had declined something they had not.
      setRejecting(false);
      toast({
        tone: "danger",
        title: "Your decision was not recorded",
        description: `${errorMessage(err)} The plan is still awaiting your decision.`,
      });
    }
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
          <h2 className="text-lg font-semibold text-ink-100">We lost track of that plan</h2>
          <p className="text-ink-300 text-xs mt-2 font-semibold">
            {error || "That plan is no longer in this session."} Nothing was approved and no money moved. Go back and pick a plan again.
          </p>
          <Link href="/strategies" className={buttonClasses("primary", "lg", "mt-6 w-full")}>
            Back to the plans
          </Link>
        </Card>
      </main>
    );
  }

  // null, not a fabricated -42000000. A missing forecast is an absence of
  // information; substituting the seed dataset's deficit would present a
  // fictitious figure as this business's projected position.
  const baselineClosing: number | null =
    cachedForecast?.forecast?.days?.[cachedForecast.forecast.days.length - 1]
      ?.projectedBalance ??
    fetchedBaseline ??
    null;

  // Was a fourth private naming scheme. The plan must be called the same thing
  // here as on the screen the operator just came from.
  const strategyTitle = planName(strategy.name);

  const preExecutionChecks = [
    {
      ok: !isStale,
      label: isStale
        ? "Your figures changed after this plan was worked out. It needs re-running before you approve."
        : "These figures match your ledger right now",
    },
    { ok: true, label: "Nothing here has already been sent — no risk of charging twice" },
    { ok: true, label: "Every invoice, payment and customer in this plan still exists" },
    { ok: true, label: "Locked until you approve — CashPilot cannot start on its own" },
  ];

  return (
    <main className="flex-1 max-w-4xl mx-auto px-6 py-10 w-full space-y-8">
      {/* Header section */}
      <Reveal className="flex items-center justify-between">
        <button
          onClick={() => router.push("/strategies")}
          className="text-xs font-bold text-ink-300 hover:text-ink-200 transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050"
        >
          ← Back to the plans
        </button>
        <div className="flex items-center gap-2">
          {/* Expiry, surfaced BEFORE it refuses (spec §25). Until now this
              reached the operator exactly once — as a refusal, after they had
              read the plan and decided. */}
          {(() => {
            const f = describeFreshness(expiresAt);
            if (f.band === "UNKNOWN") return null;
            return (
              <span title={f.detail}>
                <Badge
                  tone={
                    f.band === "EXPIRED"
                      ? "danger"
                      : f.band === "EXPIRING_SOON"
                      ? "warning"
                      : "neutral"
                  }
                >
                  {f.label}
                </Badge>
              </span>
            );
          })()}
          <Badge tone="warning">Waiting for you to approve</Badge>
        </div>
      </Reveal>

      <Stagger className="space-y-8" stagger={0.08}>
        {/* Recommended Strategy summary */}
        <StaggerItem>
          <Card className="rounded-md space-y-4">
            <div>
              <span className="label block">
                The plan you picked
              </span>
              <h2 className="text-xl font-semibold text-ink-100 mt-1 leading-tight">
                {strategyTitle}
              </h2>
            </div>

            <div className="grid grid-cols-2 gap-4 pt-4 border-t border-line-faint items-center">
              <div>
                <span className="label block">
                  If you do nothing
                </span>
                <span className="text-lg font-semibold text-risk-400 block mt-0.5">
                  {baselineClosing === null ? "Unavailable" : formatINR(baselineClosing)}
                </span>
              </div>

              <div>
                <span className="text-[11px] font-bold text-brand-300 block">
                  If you approve this
                </span>
                <span className="text-lg font-semibold text-brand-300 block mt-0.5">
                  {formatINR(strategy.result?.projectedBalance ?? strategy.projectedBalance)}
                </span>
              </div>
            </div>
          </Card>
        </StaggerItem>

        {/* SECTION B — Detailed Execution Plan */}
        <StaggerItem className="space-y-4">
          <span className="text-xs font-bold text-ink-400 block pl-1">
            What CashPilot will do
          </span>

          {strategy.actions.length === 0 ? (
            <Card className="rounded-md text-center text-xs text-ink-400 font-semibold italic">
              This strategy requires zero active interventions. No payment links will be created.
            </Card>
          ) : (
            <div className="space-y-4">
              {strategy.actions.map((act, idx: number) => (
                <Card key={act.id ?? `action-${idx}`} className="rounded-md space-y-4">
                  <div className="flex justify-between items-center border-b border-line-faint pb-3">
                    <span className="text-[11px] font-semibold text-brand-300 block">
                      Action {idx + 1} of {strategy.actions.length}
                    </span>
                    <Badge tone="neutral">Not started yet</Badge>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-semibold">
                    <div>
                      <span className="label block">What it does</span>
                      <span className="text-ink-100 font-semibold block mt-0.5">{actionCategory(act.type)}</span>
                    </div>

                    <div>
                      <span className="label block">Money it brings in</span>
                      <span className="text-safe-400 font-semibold block mt-0.5">+{formatINR(act.amount)}</span>
                    </div>

                    <div>
                      <span className="label block">How it works</span>
                      <span className="text-ink-100 block mt-0.5">{executionMethod(act.type)}</span>
                    </div>

                    <div>
                      <span className="label block">When you see the money</span>
                      <span className="text-ink-300 block mt-0.5 leading-relaxed font-semibold">{impactRealization(act.type)}</span>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </StaggerItem>

        {/* SECTION C — Pre-Execution Checks */}
        <StaggerItem>
          <Card className="rounded-md space-y-4">
            <h3 className="text-xs font-bold text-ink-400 block">
              Safety checks
            </h3>

            <div className="space-y-2.5">
              {preExecutionChecks.map((check, idx) => (
                <div key={idx} className="flex items-center gap-3 text-xs">
                  {check.ok ? (
                    <CheckCircle2 className="w-5 h-5 text-safe-400 flex-shrink-0" />
                  ) : (
                    <XCircle className="w-5 h-5 text-risk-400 flex-shrink-0" />
                  )}
                  <span className={clsx("font-semibold", check.ok ? "text-ink-300" : "text-risk-400")}>{check.label}</span>
                </div>
              ))}
            </div>
          </Card>
        </StaggerItem>

        {/* SECTION D — Visual Human Control Boundary Separator */}
        <StaggerItem className="py-2 text-center space-y-3">
          <div className="border-t-2 border-dashed border-line-firm w-full" />
          <span className="label bg-[var(--background)] px-4 inline-flex items-center gap-1.5 -mt-6 relative">
            <Lock className="w-3 h-3" /> Nothing happens without your approval
          </span>
          <div className="max-w-md mx-auto text-[11px] text-ink-400 leading-relaxed font-semibold">
            CashPilot can read your ledger but cannot move a rupee on its own.
            No payments can be processed, links generated, or invoices updated without explicit approval.
          </div>
          <div className="border-b-2 border-dashed border-line-firm w-full pt-1" />
        </StaggerItem>

        {/* Stale recalculation notice */}
        {isStale && (
          <StaggerItem>
            <Card className="rounded-md bg-risk-500/10 border-risk-500/25 flex items-start gap-4">
              <ShieldAlert className="w-6 h-6 text-risk-400 flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-bold text-risk-400">Your figures have moved on</h4>
                <p className="text-xs text-risk-400 leading-relaxed mt-1 font-semibold">
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
                  Re-run the comparison
                </Button>
              </div>
            </Card>
          </StaggerItem>
        )}

        {/* Decline panel — replaces window.confirm(). A person declining a
            financial plan deserves the app's own surface and a place to say
            why, not an unstyled OS box that records nothing. */}
        <AnimatePresence initial={false}>
          {showRejectPanel && (
            <StaggerItem>
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.28, ease: EASE_OUT_EXPO }}
                className="overflow-hidden"
              >
                <Card tone="risk" className="rounded-md space-y-4">
                  <div>
                    <h4 className="text-[15px] font-semibold text-ink-100">Decline this plan?</h4>
                    <p className="text-[13px] text-ink-300 leading-relaxed mt-1">
                      Nothing will be authorized and no money will move. You will go back to the
                      comparison so you can pick a different option.
                    </p>
                  </div>

                  <div>
                    <label htmlFor="reject-reason" className="label block mb-1.5">
                      Reason (optional)
                    </label>
                    <textarea
                      id="reject-reason"
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      rows={2}
                      placeholder="e.g. Supplier already agreed to wait — no need to chase invoices"
                      className="w-full rounded-md bg-ground-100 border border-line-soft text-[13px] text-ink-100 px-3.5 py-2.5 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050 placeholder:text-ink-400 focus:border-brand-500 transition-colors resize-none"
                    />
                  </div>

                  <div className="flex flex-wrap gap-2.5">
                    <Button
                      variant="danger"
                      size="md"
                      onClick={confirmReject}
                      loading={rejecting}
                      disabled={rejecting}
                    >
                      {rejecting ? "Recording" : "Decline and go back"}
                    </Button>
                    <Button
                      variant="secondary"
                      size="md"
                      onClick={() => setShowRejectPanel(false)}
                      disabled={rejecting}
                    >
                      Keep reviewing
                    </Button>
                  </div>
                </Card>
              </motion.div>
            </StaggerItem>
          )}
        </AnimatePresence>

        {/* Action CTA Buttons */}
        <StaggerItem className="flex flex-wrap gap-3 justify-between items-center pt-2">
          <Button variant="ghost" size="md" onClick={handleReject} disabled={showRejectPanel}>
            Decline
          </Button>

          <Button
            variant="success"
            size="lg"
            onClick={() => setShowConfirmModal(true)}
            disabled={approving || isStale}
            className="group"
          >
            {approving ? "Authorizing…" : "Approve and continue"}
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
            className="fixed inset-0 bg-ground-000/60 backdrop-blur-sm z-[999] flex items-center justify-center p-4"
            onClick={() => setShowConfirmModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 10 }}
              transition={{ duration: 0.25, ease: EASE_OUT_EXPO }}
              onClick={(e) => e.stopPropagation()}
              className="bg-ground-100 rounded-md p-6 max-w-sm w-full border border-line-faint space-y-4"
            >
              <div className="flex items-center gap-2.5 text-brand-300">
                <ShieldCheck className="w-6 h-6" />
                <h3 className="text-md font-semibold tracking-tight text-ink-100">
                  Confirm Human Authorization
                </h3>
              </div>

              <p className="text-xs text-ink-300 font-semibold leading-relaxed">
                You are authorizing a financial intervention.
              </p>

              <div className="text-xs font-semibold text-ink-200 space-y-2">
                <p>✓ Expected to: <strong>Eliminate {strategy.scoring?.counterfactual?.deficitDaysDelta ?? 0} projected deficit days</strong>.</p>
                {(() => {
                  const deferredAmount = strategy.scoring?.deferredObligations?.amount ?? 0;
                  if (deferredAmount > 0) {
                    return (
                      <p className="text-risk-400">
                        ⚠️ Note: <strong>{formatINR(deferredAmount)} remains payable</strong> after the current forecast horizon.
                      </p>
                    );
                  }
                  return <p className="text-ink-400 font-normal">No deferred liabilities outside the forecast window.</p>;
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
          <Skeleton className="h-28 rounded-md" />
          <Skeleton className="h-64 rounded-md" />
        </main>
      }
    >
      <ApprovalContent />
    </Suspense>
  );
}
