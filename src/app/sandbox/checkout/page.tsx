"use client";

import React, { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AnimatePresence } from "framer-motion";
import { CreditCard, CheckCircle2, ShieldCheck, AlertTriangle, ArrowRight } from "lucide-react";
import { PilotIcon } from "@/components/PilotIcon";
import { Button } from "@/components/ui/Button";
import { errorMessage } from "@/lib/errors";

function CheckoutContent() {
  const searchParams = useSearchParams();
  const paymentLinkId = searchParams.get("paymentLinkId");
  const actionId = searchParams.get("actionId");

  // Whether the parameters are usable is knowable during render, so it is
  // derived rather than assigned from an effect. Setting it in the effect made
  // the page show a spinner for one frame before an error it already had.
  const paramError =
    !paymentLinkId || !actionId
      ? "Invalid session params. paymentLinkId and actionId are required."
      : null;

  const [loading, setLoading] = useState(!paramError);
  const [paying, setPaying] = useState(false);
  const [success, setSuccess] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const error = paramError ?? fetchError;

  useEffect(() => {
    if (paramError) return;

    // Check if already paid
    async function checkCurrentStatus() {
      try {
        const res = await fetch(`/api/payment-status?paymentLinkId=${paymentLinkId}&actionId=${actionId}`);
        if (!res.ok) throw new Error("Verification check failed.");
        const data = await res.json();
        if (data.status === "paid") {
          setSuccess(true);
        }
      } catch (err) {
        console.error("Error checking initial status:", err);
      } finally {
        setLoading(false);
      }
    }
    checkCurrentStatus();
  }, [paymentLinkId, actionId, paramError]);

  const handleSimulatePayment = async () => {
    if (!paymentLinkId || !actionId || paying) return;
    setPaying(true);
    setFetchError(null);

    try {
      const res = await fetch(
        `/api/payment-status?paymentLinkId=${paymentLinkId}&actionId=${actionId}&simulatePaid=true`
      );
      if (!res.ok) throw new Error("Simulated payment transaction failed.");
      const data = await res.json();

      if (data.status === "paid") {
        setSuccess(true);
      } else {
        throw new Error("Unable to authorize checkout simulation.");
      }
    } catch (err) {
      setFetchError(errorMessage(err));
    } finally {
      setPaying(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-8 space-y-4">
        <div className="w-10 h-10 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-xs text-ink-300 font-bold">Initializing sandbox session...</span>
      </div>
    );
  }

  if (error && !success) {
    return (
      <div
        className="bg-risk-500/10 p-6 rounded-md border border-risk-500/25 text-center max-w-sm space-y-4"
      >
        <AlertTriangle className="w-10 h-10 text-risk-400 mx-auto" />
        <h3 className="text-md font-bold text-risk-400">Checkout Session Failure</h3>
        <p className="text-xs text-risk-400 font-medium leading-relaxed">{error}</p>
      </div>
    );
  }

  return (
    <div
      className="bg-ground-100 border border-line-soft rounded-md w-full max-w-md overflow-hidden shadow-black/50"
    >
      {/* simulated payment gateway header */}
      <div className="bg-brand-500 text-white p-6 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-md bg-white/10 flex items-center justify-center backdrop-blur-md border border-white/10">
            <PilotIcon className="w-4 h-4" />
          </div>
          <div>
            <span className="font-semibold text-sm block">CashPilot Checkout Sandbox</span>
            <span className="text-[11px] text-brand-300 block -mt-0.5">
              Razorpay Simulation Mode
            </span>
          </div>
        </div>
        <div className="text-[11px] bg-white/10 px-2 py-0.5 rounded font-semibold">
          Demo Card
        </div>
      </div>

      <div className="p-6 space-y-6">
        <AnimatePresence mode="wait">
          {success ? (
            <div
              key="success"
              className="text-center py-6 space-y-4"
            >
              <div
              >
                <CheckCircle2 className="w-16 h-16 text-safe-400 mx-auto" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-ink-100">✓ Test Payment Completed</h3>
                <p className="text-xs text-ink-300 font-semibold leading-relaxed mt-2">
                  Simulated transaction approved successfully. The recovery record has transitioned to{" "}
                  <span className="text-safe-400 font-bold">RECOVERED</span>, and the action status is updated to{" "}
                  <span className="text-safe-400 font-bold">COMPLETED</span> in the ledger database.
                </p>
              </div>
              <div className="pt-4 border-t border-line-faint text-[11px] text-ink-400 font-semibold leading-normal">
                You can now close this window, return to the CashPilot execution control center tab, and click
                &quot;Verify Status&quot; to fetch the updated balance.
              </div>
            </div>
          ) : (
            <div key="form" className="space-y-6">
              <div className="bg-ground-200 p-4 rounded-md border border-line-faint space-y-2 text-xs text-ink-300 font-semibold">
                <div className="flex justify-between">
                  <span>Payment Link reference:</span>
                  <span className="font-mono text-ink-100">{paymentLinkId}</span>
                </div>
                <div className="flex justify-between">
                  <span>Ledger Action reference:</span>
                  <span className="font-mono text-ink-100">{actionId}</span>
                </div>
              </div>

              {/* Simulated credit card fields */}
              <div className="space-y-3.5">
                <span className="label block pl-1">
                  Enter simulated Card Details
                </span>

                <div className="space-y-3 p-4 bg-ground-200 rounded-md border border-line-soft">
                  <div className="flex items-center gap-2 border-b pb-2 border-line-soft">
                    <CreditCard className="w-4 h-4 text-ink-400" />
                    <input
                      type="text"
                      disabled
                      value="4111 •••• •••• 1111 (Razorpay Sandbox)"
                      className="w-full text-xs font-bold text-ink-200 bg-transparent focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-xs font-bold text-ink-300">
                    <div>Expiry: 12/29</div>
                    <div className="text-right">CVV: 111</div>
                  </div>
                </div>
              </div>

              {/* Sim checkout button */}
              <Button variant="success" size="lg" loading={paying} onClick={handleSimulatePayment} className="w-full group">
                {!paying && (
                  <>
                    Simulate Successful Payment
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                  </>
                )}
              </Button>

              <div className="label flex items-center justify-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5" /> SECURE TEST-MODE ENVIRONMENT
              </div>
            </div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export default function SandboxCheckout() {
  return (
    <div className="min-h-screen bg-[var(--background)] flex items-center justify-center p-6">
      <Suspense fallback={
        <div className="flex flex-col items-center justify-center p-8 space-y-4">
          <div className="w-10 h-10 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-xs text-ink-300 font-bold">Loading sandbox shell...</span>
        </div>
      }>
        <CheckoutContent />
      </Suspense>
    </div>
  );
}
