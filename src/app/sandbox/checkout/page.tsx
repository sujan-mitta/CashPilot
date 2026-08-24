"use client";

import React, { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { CreditCard, CheckCircle2, ShieldCheck, AlertTriangle, ArrowRight } from "lucide-react";
import { PilotIcon } from "@/components/PilotIcon";
import { Button } from "@/components/ui/Button";
import { EASE_OUT_EXPO } from "@/components/ui/motion";

function CheckoutContent() {
  const searchParams = useSearchParams();
  const paymentLinkId = searchParams.get("paymentLinkId");
  const actionId = searchParams.get("actionId");

  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!paymentLinkId || !actionId) {
      setError("Invalid session params. paymentLinkId and actionId are required.");
      setLoading(false);
      return;
    }

    // Check if already paid
    async function checkCurrentStatus() {
      try {
        const res = await fetch(`/api/payment-status?paymentLinkId=${paymentLinkId}&actionId=${actionId}`);
        if (!res.ok) throw new Error("Verification check failed.");
        const data = await res.json();
        if (data.status === "paid") {
          setSuccess(true);
        }
      } catch (err: any) {
        console.error("Error checking initial status:", err);
      } finally {
        setLoading(false);
      }
    }
    checkCurrentStatus();
  }, [paymentLinkId, actionId]);

  const handleSimulatePayment = async () => {
    if (!paymentLinkId || !actionId || paying) return;
    setPaying(true);
    setError(null);

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
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPaying(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-8 space-y-4">
        <div className="w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        <span className="text-xs text-slate-500 font-bold">Initializing sandbox session...</span>
      </div>
    );
  }

  if (error && !success) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-red-50 p-6 rounded-2xl border border-red-200 text-center max-w-sm space-y-4"
      >
        <AlertTriangle className="w-10 h-10 text-red-600 mx-auto" />
        <h3 className="text-md font-bold text-red-800">Checkout Session Failure</h3>
        <p className="text-xs text-red-700 font-medium leading-relaxed">{error}</p>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.45, ease: EASE_OUT_EXPO }}
      className="bg-white border border-slate-200 rounded-3xl w-full max-w-md overflow-hidden shadow-2xl shadow-slate-300/40"
    >
      {/* simulated payment gateway header */}
      <div className="bg-gradient-to-r from-indigo-600 to-indigo-700 text-white p-6 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center backdrop-blur-md border border-white/10">
            <PilotIcon className="w-4 h-4" />
          </div>
          <div>
            <span className="font-extrabold text-sm block">CashPilot Checkout Sandbox</span>
            <span className="text-[9px] uppercase tracking-widest text-indigo-200 block -mt-0.5">
              Razorpay Simulation Mode
            </span>
          </div>
        </div>
        <div className="text-[10px] bg-white/10 px-2 py-0.5 rounded font-black tracking-wider uppercase">
          Demo Card
        </div>
      </div>

      <div className="p-6 space-y-6">
        <AnimatePresence mode="wait">
          {success ? (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.35, ease: EASE_OUT_EXPO }}
              className="text-center py-6 space-y-4"
            >
              <motion.div
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.1, type: "spring", stiffness: 260, damping: 16 }}
              >
                <CheckCircle2 className="w-16 h-16 text-emerald-500 mx-auto" />
              </motion.div>
              <div>
                <h3 className="text-lg font-black text-slate-800">✓ Test Payment Completed</h3>
                <p className="text-xs text-slate-500 font-semibold leading-relaxed mt-2">
                  Simulated transaction approved successfully. The recovery record has transitioned to{" "}
                  <span className="text-emerald-600 font-bold">RECOVERED</span>, and the action status is updated to{" "}
                  <span className="text-emerald-600 font-bold">COMPLETED</span> in the ledger database.
                </p>
              </div>
              <div className="pt-4 border-t border-slate-100 text-[10px] text-slate-400 font-semibold leading-normal">
                You can now close this window, return to the CashPilot execution control center tab, and click
                &quot;Verify Status&quot; to fetch the updated balance.
              </div>
            </motion.div>
          ) : (
            <motion.div key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
              <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100 space-y-2 text-xs text-slate-600 font-semibold">
                <div className="flex justify-between">
                  <span>Payment Link reference:</span>
                  <span className="font-mono text-slate-800">{paymentLinkId}</span>
                </div>
                <div className="flex justify-between">
                  <span>Ledger Action reference:</span>
                  <span className="font-mono text-slate-800">{actionId}</span>
                </div>
              </div>

              {/* Simulated credit card fields */}
              <div className="space-y-3.5">
                <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block pl-1">
                  Enter simulated Card Details
                </span>

                <div className="space-y-3 p-4 bg-slate-50 rounded-2xl border border-slate-200">
                  <div className="flex items-center gap-2 border-b pb-2 border-slate-200">
                    <CreditCard className="w-4 h-4 text-slate-400" />
                    <input
                      type="text"
                      disabled
                      value="4111 •••• •••• 1111 (Razorpay Sandbox)"
                      className="w-full text-xs font-bold text-slate-700 bg-transparent outline-none"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-xs font-bold text-slate-500">
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

              <div className="flex items-center justify-center gap-1.5 text-[9px] font-black text-slate-400 uppercase tracking-widest">
                <ShieldCheck className="w-3.5 h-3.5" /> SECURE TEST-MODE ENVIRONMENT
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

export default function SandboxCheckout() {
  return (
    <div className="min-h-screen bg-[var(--background)] flex items-center justify-center p-6">
      <Suspense fallback={
        <div className="flex flex-col items-center justify-center p-8 space-y-4">
          <div className="w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          <span className="text-xs text-slate-500 font-bold">Loading sandbox shell...</span>
        </div>
      }>
        <CheckoutContent />
      </Suspense>
    </div>
  );
}
