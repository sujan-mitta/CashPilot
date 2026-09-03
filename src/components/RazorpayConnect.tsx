"use client";

import React, { useState, useEffect } from "react";
import { Link2, ShieldCheck, AlertTriangle, Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { errorMessage } from "@/lib/errors";
import clsx from "clsx";

/**
 * Connecting a merchant's own Razorpay account.
 *
 * Until this exists, every business's payment links are issued on the
 * DEPLOYMENT's account and the money lands there — correct for a single
 * merchant, wrong the moment there are two.
 *
 * WHAT THIS SCREEN OWES THE USER
 *
 * They are about to hand over credentials that move their money. So it says,
 * before they type anything: what is stored, how, that test keys are the only
 * ones accepted, and that it can be undone. A form that asks for a secret and
 * explains nothing is asking to be trusted without giving a reason.
 *
 * Secrets are typed into password fields with autocomplete off, submitted once,
 * and never read back — the API cannot return them, so nothing here can display
 * them even by mistake.
 */

interface Summary {
  connected: boolean;
  mode: "TEST" | "LIVE" | null;
  keyFingerprint: string | null;
  webhooksConfigured: boolean;
  connectedAt: string | null;
}

export function RazorpayConnect({ onConnected }: { onConnected?: () => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/integrations/razorpay")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.connection) setSummary(d.connection);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations/razorpay/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyId, keySecret, webhookSecret: webhookSecret || undefined }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.message || errorMessage(data.error) || "That connection could not be saved.");
        setBusy(false);
        return;
      }

      // Cleared immediately. There is no reason for a secret to stay in memory
      // once it has been submitted, and every reason for it not to.
      setKeySecret("");
      setWebhookSecret("");
      setSummary(data.summary);
      setWebhookUrl(`${window.location.origin}/api/webhooks/${data.webhookToken}`);
      setBusy(false);
      onConnected?.();
    } catch (err) {
      setError(errorMessage(err, "Could not reach the server."));
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await fetch("/api/integrations/razorpay/connect", { method: "DELETE" });
      setSummary({
        connected: false,
        mode: null,
        keyFingerprint: null,
        webhooksConfigured: false,
        connectedAt: null,
      });
      setWebhookUrl(null);
    } finally {
      setBusy(false);
    }
  };

  if (summary?.connected) {
    return (
      <div className="rounded-md border border-safe-500/30 bg-safe-500/[0.07] p-5">
        <div className="flex items-start gap-3.5">
          <ShieldCheck className="w-5 h-5 text-safe-400 shrink-0 mt-0.5" aria-hidden />
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold text-ink-100">
              Your Razorpay account is connected
            </h3>
            <p className="text-ink-300 text-[12.5px] mt-1 leading-relaxed">
              Recovery links are now issued on your account in {summary.mode} mode, and payments
              land there rather than with us. Account{" "}
              <code className="text-ink-200">{summary.keyFingerprint}</code>.
            </p>

            {!summary.webhooksConfigured && (
              <p className="text-warn-400 text-[12px] mt-2.5 leading-relaxed">
                No webhook secret is saved, so payments will not be recorded automatically. Add one
                by reconnecting with it filled in.
              </p>
            )}

            {webhookUrl && (
              <div className="mt-3.5">
                <p className="text-[12px] font-semibold text-ink-200">
                  Paste this into your Razorpay webhook settings
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="text-[11.5px] text-ink-300 bg-ground-200 rounded px-2 py-1.5 truncate flex-1">
                    {webhookUrl}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(webhookUrl).then(() => setCopied(true));
                    }}
                    className="shrink-0 inline-flex items-center gap-1 text-[12px] text-brand-300 hover:text-brand-400 font-semibold rounded focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                {/* Shown once, at the moment it is needed. It identifies which
                    account a webhook belongs to, so it is regenerated on every
                    reconnect — an old URL stops working the moment credentials
                    are replaced. */}
                <p className="text-ink-500 text-[11px] mt-1.5">
                  This URL is unique to your business and changes if you reconnect.
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={disconnect}
              disabled={busy}
              className="mt-4 text-[12px] text-ink-400 hover:text-risk-400 transition-colors rounded focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Disconnect this account
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-md border border-line-soft bg-ground-100 p-5">
      <div className="flex items-start gap-3.5">
        <Link2 className="w-5 h-5 text-brand-300 shrink-0 mt-0.5" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-ink-100">Connect your Razorpay account</h3>
          <p className="text-ink-300 text-[12.5px] mt-1 leading-relaxed">
            Recovery links will be issued on your account, so payments go to you rather than
            through us. Find these under <strong className="text-ink-200">Settings → API Keys</strong>{" "}
            in your Razorpay dashboard.
          </p>

          {/* Said before anything is typed, not buried underneath the form. */}
          <div className="mt-3.5 rounded-md border border-line-soft bg-ground-200/50 p-3 text-[11.5px] text-ink-400 leading-relaxed space-y-1.5">
            <p>
              <strong className="text-ink-300">Test keys only.</strong> CashPilot has not been
              audited for holding credentials that move real money, so live keys are refused rather
              than accepted on trust.
            </p>
            <p>
              <strong className="text-ink-300">Your secret is encrypted</strong> before it is
              stored, under a key held outside the database. No screen here can display it back,
              including this one.
            </p>
            <p>
              <strong className="text-ink-300">You can disconnect at any time</strong>, which
              deletes what we hold.
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="mt-3.5 p-3 rounded-md bg-risk-500/10 border border-risk-500/25 text-[12px] text-risk-400 flex gap-2"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-px" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          <div className="mt-4 space-y-3">
            <Field
              id="rzp-key-id"
              label="Key ID"
              placeholder="rzp_test_..."
              value={keyId}
              onChange={setKeyId}
            />
            <Field
              id="rzp-key-secret"
              label="Key Secret"
              placeholder="Your key secret"
              value={keySecret}
              onChange={setKeySecret}
              secret
            />
            <Field
              id="rzp-webhook-secret"
              label="Webhook Secret"
              placeholder="Optional — needed for payments to record automatically"
              value={webhookSecret}
              onChange={setWebhookSecret}
              secret
              optional
            />
          </div>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={busy}
            disabled={!keyId.trim() || !keySecret.trim()}
            className="mt-4"
          >
            {!busy && "Connect account"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  placeholder,
  value,
  onChange,
  secret,
  optional,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  secret?: boolean;
  optional?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="label block mb-1.5">
        {label}
        {optional && <span className="text-ink-500 font-normal"> (optional)</span>}
      </label>
      <input
        id={id}
        // A secret in a plain text field is a secret on a projector, in a
        // screen recording, and in the browser's saved-form data.
        type={secret ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={clsx(
          "w-full px-3.5 py-2.5 rounded-md text-[13px]",
          "bg-ground-200/70 border border-line-soft text-ink-100 font-medium",
          "placeholder:text-ink-500 placeholder:font-normal",
          "transition-[border-color,background] duration-200 hover:border-line-firm",
          "focus:border-brand-500 focus:bg-ground-200",
          "focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-100"
        )}
      />
    </div>
  );
}
