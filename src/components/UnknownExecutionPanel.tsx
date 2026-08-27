"use client";

import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { formatINR, formatDateTime } from "@/lib/format";
import { errorMessage } from "@/lib/errors";

/**
 * Operator panel for execution intents whose outcome is undetermined
 * (Phase 16 PART 6).
 *
 * The wording here is load-bearing. An UNKNOWN action is NOT "Failed" and NOT
 * "Completed" - saying either would be a claim the system cannot support. It
 * says the outcome could not be determined, and shows exactly what was checked.
 *
 * `retryPermitted` is decided by the SERVER from stored reconciliation evidence.
 * This component only renders it. It never computes retry eligibility itself,
 * because a client that could would be a client that could authorise a duplicate
 * payment.
 */

interface IntentView {
  intentId: string;
  actionId: string;
  actionType: string | null;
  operation: string;
  amount: number;
  targetType: string | null;
  targetId: string | null;
  idempotencyKey: string;
  externalRef: string | null;
  status: string;
  attempts: number;
  recordedAt: string;
  dispatchedAt: string | null;
  unknownReason: string | null;
  lastReconciledAt: string | null;
  lastReconciliation: {
    status: string;
    reason: string;
    expectedEvidence: string;
    observedEvidence: string;
    searchExhaustive: boolean;
    checkedAt: string;
  } | null;
  retryPermitted: boolean;
  nextSafeAction: string;
}

const ACTION_LABEL: Record<string, string> = {
  RECOVER_FAILED_PAYMENTS: "Recover failed payment",
  PRIORITIZE_COLLECTIONS: "Accelerate collections",
  RESCHEDULE_PAYOUT: "Reschedule vendor payout",
  PAUSE_EXPENSE: "Pause recurring expense",
};

export function UnknownExecutionPanel({
  strategyId,
  onRetry,
}: {
  strategyId?: string;
  onRetry?: (intent: IntentView) => void;
}) {
  const [intents, setIntents] = useState<IntentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [reconcilingId, setReconcilingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = strategyId ? `?strategyId=${encodeURIComponent(strategyId)}` : "";
      const res = await fetch(`/api/execution-intents${qs}`);
      if (!res.ok) throw new Error("Unable to load execution status.");
      const data = await res.json();
      setIntents(data.intents ?? []);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [strategyId]);

  useEffect(() => {
    load();
  }, [load]);

  const reconcile = async (intentId: string) => {
    if (reconcilingId) return; // in-flight guard
    setReconcilingId(intentId);
    try {
      const res = await fetch("/api/execution-intents/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intentId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Reconciliation could not be completed.");
      }
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setReconcilingId(null);
    }
  };

  if (loading && intents.length === 0) return null;
  if (intents.length === 0 && !error) return null;

  return (
    <Card className="rounded-md border-warn-500/25 bg-warn-500/10 space-y-4">
      <div className="flex items-center gap-2.5">
        <ShieldAlert className="w-5 h-5 text-warn-400 flex-shrink-0" />
        <h3 className="text-sm font-semibold text-warn-400 tracking-tight">
          Execution status could not be determined
        </h3>
      </div>

      <p className="text-xs text-warn-400 font-semibold leading-relaxed">
        The operations below were sent, but CashPilot did not receive a conclusive
        answer. They are <strong>not</strong> confirmed as completed and
        <strong> not</strong> confirmed as failed. Reconcile each one to establish
        what actually happened before taking any further action.
      </p>

      {error && (
        <p className="text-xs font-bold text-risk-400 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" /> {error}
        </p>
      )}

      <div className="space-y-3">
        {intents.map((intent) => (
          <div
            key={intent.intentId}
            className="rounded-md border border-warn-500/25 bg-ground-100 p-4 space-y-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="text-[11px] font-semibold text-warn-400 block">
                  {ACTION_LABEL[intent.actionType ?? ""] ?? intent.operation}
                </span>
                <span className="text-ink-100 font-semibold block mt-0.5">
                  {formatINR(intent.amount)}
                </span>
              </div>
              <span className="text-[11px] font-semibold px-2 py-1 rounded-full bg-warn-500/15 text-warn-400">
                {intent.status === "UNKNOWN" ? "Undetermined" : intent.status}
              </span>
            </div>

            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-[11px] font-semibold">
              <Row label="Target" value={intent.targetId ? `${intent.targetType}: ${intent.targetId}` : "—"} />
              <Row label="Attempted" value={formatDateTime(intent.dispatchedAt ?? intent.recordedAt)} />
              <Row label="Execution intent" value={intent.intentId} mono />
              <Row label="Reference key" value={intent.idempotencyKey} mono />
              {intent.externalRef && <Row label="Provider reference" value={intent.externalRef} mono />}
              <Row
                label="Last checked"
                value={intent.lastReconciledAt ? formatDateTime(intent.lastReconciledAt) : "Never"}
              />
            </dl>

            {intent.lastReconciliation ? (
              <div className="rounded-md bg-ground-200 border border-line-soft p-3 space-y-1.5 text-[11px]">
                <p className="font-semibold text-ink-200 text-[11px]">
                  Last reconciliation — {intent.lastReconciliation.status}
                </p>
                <p className="text-ink-300 font-semibold">{intent.lastReconciliation.reason}</p>
                <p className="text-ink-300">
                  <span className="font-bold">Expected:</span> {intent.lastReconciliation.expectedEvidence}
                </p>
                <p className="text-ink-300">
                  <span className="font-bold">Found:</span> {intent.lastReconciliation.observedEvidence}
                </p>
                {!intent.lastReconciliation.searchExhaustive && (
                  <p className="text-warn-400 font-bold">
                    The search did not complete, so absence has not been established.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[11px] text-ink-300 font-semibold">
                {intent.unknownReason ?? "No reconciliation has been attempted yet."}
              </p>
            )}

            <p className="text-[11px] font-bold text-ink-200">{intent.nextSafeAction}</p>

            <div className="flex gap-2 pt-1">
              <Button
                variant="subtle"
                size="sm"
                onClick={() => reconcile(intent.intentId)}
                disabled={reconcilingId === intent.intentId}
              >
                <Search className="w-3.5 h-3.5 mr-1.5" />
                {reconcilingId === intent.intentId ? "Checking…" : "Reconcile"}
              </Button>

              <Button
                variant="primary"
                size="sm"
                // Enabled ONLY when the server established the original
                // operation did not occur. Never decided here.
                disabled={!intent.retryPermitted}
                onClick={() => intent.retryPermitted && onRetry?.(intent)}
                title={
                  intent.retryPermitted
                    ? "Reconciliation proved the original operation did not occur."
                    : "Retry is blocked until reconciliation proves the original operation did not occur."
                }
              >
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                Retry
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className={`text-ink-200 ${mono ? "font-mono text-[11px] break-all" : ""}`}>{value}</dd>
    </div>
  );
}
