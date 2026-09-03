"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Database, Link2, ArrowRight, Check, AlertTriangle, ShieldCheck } from "lucide-react";
import { PilotIcon } from "@/components/PilotIcon";
import { Button } from "@/components/ui/Button";
import { EASE_GLIDE, DUR } from "@/components/ui/motion";
import { errorMessage } from "@/lib/errors";
import { useCashPilot } from "@/context/CashPilotContext";
import { rememberChosenStart } from "@/lib/onboardingChoice";
import { RazorpayConnect } from "@/components/RazorpayConnect";
import clsx from "clsx";

/**
 * The fork a verified account lands on.
 *
 * Two genuinely different starting points, and the difference is what the
 * numbers on the dashboard MEAN:
 *
 *   Sample data — a seeded scenario with a real projected shortfall, so the
 *   crisis and recovery flows can be walked end to end without owing anybody
 *   money. Nothing here is the user's.
 *
 *   Razorpay — an empty ledger, and confirmation that recovery links will
 *   actually reach a payer. Every figure that appears later is real.
 *
 * Offered as a choice rather than seeded by default, because writing invented
 * transactions into a book someone intends to use for their own business is not
 * a decision to make on their behalf. It is also reversible in one direction
 * only: sample data can be added later from the dashboard's empty state, but
 * removing it from a ledger already in use is not something the product does.
 */

type Choice = "SAMPLE" | "RAZORPAY";

interface RazorpayStatus {
  connected: boolean;
  mode: "TEST" | "LIVE" | "NOT_CONFIGURED";
  handlesRealMoney: boolean;
  detail: string;
}

export default function Onboarding() {
  const router = useRouter();
  const { user } = useCashPilot();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rzp, setRzp] = useState<RazorpayStatus | null>(null);
  const [rzpLoading, setRzpLoading] = useState(true);

  // Fetched up front so the Razorpay card can state what it will actually do
  // before it is chosen, rather than promising a connection and then revealing
  // there is none.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/integrations/razorpay")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) {
          setRzp(d);
          setRzpLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setRzpLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadSampleData = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sample-data", { method: "POST" });
      const data = await res.json().catch(() => ({}));

      // 409 means the ledger already has records. That is not a failure worth
      // stopping on — the destination is the same either way.
      if (!res.ok && res.status !== 409) {
        setError(
          data.message ||
            `${errorMessage(data.error) || "The sample data could not be loaded."} Nothing was changed.`
        );
        setBusy(false);
        return;
      }
      rememberChosenStart(user?.businessId);
      router.push("/dashboard");
    } catch (err) {
      setError(errorMessage(err, "Could not reach the server."));
      setBusy(false);
    }
  };

  const continueWithRazorpay = () => {
    setBusy(true);
    // Nothing is written to the ledger — it stays empty on purpose, so the
    // first numbers on the dashboard are the user's own. The choice itself is
    // remembered, though: this is the one branch that leaves no trace in the
    // data, and without a marker the dashboard would send them straight back
    // here on every visit.
    rememberChosenStart(user?.businessId);
    router.push("/dashboard");
  };

  const confirm = () => {
    if (choice === "SAMPLE") return loadSampleData();
    if (choice === "RAZORPAY") return continueWithRazorpay();
  };

  return (
    <div className="min-h-screen bg-ground-050 flex items-center justify-center px-5 py-12">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: DUR.base, ease: EASE_GLIDE }}
        className="w-full max-w-[46rem]"
      >
        <div className="flex items-center gap-2.5 mb-7">
          <div className="w-9 h-9 rounded-md bg-ground-200 flex items-center justify-center">
            <PilotIcon className="w-5 h-5 text-white" />
          </div>
          <span className="font-semibold text-[1.15rem] tracking-[-0.03em] text-ink-100">
            CashPilot
          </span>
        </div>

        <h1 className="text-[1.6rem] font-semibold text-ink-100 tracking-[-0.03em]">
          Your email is verified. How should we start?
        </h1>
        <p className="text-ink-400 text-[13px] mt-2 leading-relaxed max-w-[38rem]">
          Pick one. You can add the sample scenario later from the dashboard, but a ledger you have
          started using is not something we will write invented transactions into.
        </p>

        <div className="grid sm:grid-cols-2 gap-4 mt-7">
          <ChoiceCard
            selected={choice === "SAMPLE"}
            onSelect={() => setChoice("SAMPLE")}
            icon={<Database className="w-5 h-5" aria-hidden />}
            title="Explore with sample data"
            body="A seeded business with a real projected shortfall, so you can walk the crisis, strategy and recovery flow end to end without owing anyone money."
            footnote="Nothing here is yours. Every figure is invented."
          />

          <ChoiceCard
            selected={choice === "RAZORPAY"}
            onSelect={() => setChoice("RAZORPAY")}
            icon={<Link2 className="w-5 h-5" aria-hidden />}
            title="Start with Razorpay"
            body="An empty ledger you fill with your own invoices and payouts. Recovery links are issued through Razorpay, so every figure on the dashboard is real."
            footnote={
              rzpLoading
                ? "Checking the Razorpay connection…"
                : rzp?.detail ?? "Could not read the Razorpay status."
            }
            tone={
              rzpLoading
                ? "neutral"
                : rzp?.mode === "TEST"
                ? "good"
                : rzp?.mode === "LIVE"
                ? "warn"
                : "bad"
            }
          />
        </div>

        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: DUR.base, ease: EASE_GLIDE }}
              role="alert"
              className="overflow-hidden"
            >
              <div className="mt-5 p-3.5 rounded-md bg-risk-500/10 border border-risk-500/25 text-[12.5px] font-medium text-risk-400">
                {error}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Picking Razorpay opens the connection form in place.
            Making it the next thing on the same screen, rather than a setting
            to be found later, is the difference between an option that reads as
            real and one that reads as a label. */}
        {choice === "RAZORPAY" && (
          <div className="mt-5">
            <RazorpayConnect />
          </div>
        )}

        {/* Choosing Razorpay when nothing is configured is allowed but not
            silent: the ledger works, and only the recovery step is unavailable.
            Saying so here beats discovering it at the moment of execution. */}
        {choice === "RAZORPAY" && !rzpLoading && rzp && !rzp.connected && (
          <div className="mt-5 p-3.5 rounded-md bg-warn-500/10 border border-warn-500/25 text-[12.5px] text-warn-400 flex gap-2.5">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-px" aria-hidden />
            <span>
              You can continue, and your ledger will work normally. Recovery links will be
              unavailable until Razorpay credentials are configured for this deployment.
            </span>
          </div>
        )}

        <div className="mt-7 flex items-center gap-3">
          <Button
            variant="primary"
            size="lg"
            onClick={confirm}
            loading={busy}
            disabled={!choice}
          >
            {!busy && (
              <>
                Continue
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </Button>
          {!choice && (
            <span className="text-[12px] text-ink-500">Choose one to continue.</span>
          )}
        </div>
      </motion.div>
    </div>
  );
}

function ChoiceCard({
  selected,
  onSelect,
  icon,
  title,
  body,
  footnote,
  tone = "neutral",
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
  footnote: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={clsx(
        "text-left p-5 rounded-md border transition-[border-color,background,box-shadow] duration-200",
        "focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050",
        selected
          ? "bg-ground-200 border-brand-500"
          : "bg-ground-100 border-line-soft hover:border-line-firm hover:bg-ground-150"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className={clsx(
            "w-10 h-10 rounded-md flex items-center justify-center shrink-0",
            selected ? "bg-brand-500/15 text-brand-300" : "bg-ground-200 text-ink-300"
          )}
        >
          {icon}
        </div>
        {selected && (
          <span className="w-5 h-5 rounded-full bg-brand-500 flex items-center justify-center shrink-0">
            <Check className="w-3 h-3 text-white" aria-hidden />
          </span>
        )}
      </div>

      <h2 className="mt-4 text-[15px] font-semibold text-ink-100 tracking-[-0.02em]">{title}</h2>
      <p className="mt-1.5 text-[12.5px] text-ink-400 leading-relaxed">{body}</p>

      <p
        className={clsx(
          "mt-3 text-[11.5px] leading-relaxed flex gap-1.5",
          tone === "good"
            ? "text-brand-300"
            : tone === "warn"
            ? "text-warn-400"
            : tone === "bad"
            ? "text-ink-500"
            : "text-ink-500"
        )}
      >
        {tone === "good" && <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />}
        {tone === "warn" && <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />}
        <span>{footnote}</span>
      </p>
    </button>
  );
}
