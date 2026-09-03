"use client";

import React, { useState, useEffect } from "react";
import { Link2, ShieldCheck, AlertTriangle, Check, Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { errorMessage } from "@/lib/errors";
import clsx from "clsx";

/**
 * Connecting a merchant's own Razorpay account, as a walkthrough.
 *
 * WHY IT IS STAGED RATHER THAN ONE FORM
 *
 * The setup is genuinely a loop: Razorpay needs a webhook URL before it can be
 * configured, and the secret only exists once the merchant invents one there.
 * A single form asking for all three at once cannot be filled in one pass — the
 * third field is unknowable until the first two are saved.
 *
 * So it is three steps, and each one states exactly where to go, what to copy,
 * and what to paste. Someone who has never opened a Razorpay dashboard should
 * be able to follow it without leaving the page to find out what a webhook is.
 *
 * Secrets go into password fields with autocomplete off, are cleared from state
 * the moment they are submitted, and are never read back — the API cannot
 * return them, so nothing here can display one even by accident.
 */

interface Summary {
  connected: boolean;
  mode: "TEST" | "LIVE" | null;
  keyFingerprint: string | null;
  webhooksConfigured: boolean;
  connectedAt: string | null;
  webhookToken: string | null;
}

export function RazorpayConnect({ onConnected }: { onConnected?: () => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const webhookUrl =
    summary?.webhookToken && typeof window !== "undefined"
      ? `${window.location.origin}/api/webhooks/${summary.webhookToken}`
      : null;

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations/razorpay/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyId, keySecret }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || errorMessage(data.error) || "That connection could not be saved.");
        setBusy(false);
        return;
      }
      // Cleared at once. There is no reason for a secret to remain in memory
      // after it has been submitted, and every reason for it not to.
      setKeySecret("");
      setSummary(data.summary);
      onConnected?.();
    } catch (err) {
      setError(errorMessage(err, "Could not reach the server."));
    } finally {
      setBusy(false);
    }
  };

  const saveWebhookSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations/razorpay/connect", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookSecret }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || "That webhook secret could not be saved.");
        setBusy(false);
        return;
      }
      setWebhookSecret("");
      setSummary(data.summary);
    } catch (err) {
      setError(errorMessage(err, "Could not reach the server."));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await fetch("/api/integrations/razorpay/connect", { method: "DELETE" });
      setSummary(null);
    } finally {
      setBusy(false);
    }
  };

  const errorBox = error && (
    <div
      role="alert"
      className="mt-3.5 p-3 rounded-md bg-risk-500/10 border border-risk-500/25 text-[12px] text-risk-400 flex gap-2"
    >
      <AlertTriangle className="w-4 h-4 shrink-0 mt-px" aria-hidden />
      <span>{error}</span>
    </div>
  );

  // ── Fully set up ────────────────────────────────────────────────────────
  if (summary?.connected && summary.webhooksConfigured) {
    return (
      <div className="rounded-md border border-safe-500/30 bg-safe-500/[0.07] p-5">
        <div className="flex items-start gap-3.5">
          <ShieldCheck className="w-5 h-5 text-safe-400 shrink-0 mt-0.5" aria-hidden />
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold text-ink-100">
              Your Razorpay account is connected
            </h3>
            <p className="text-ink-300 text-[12.5px] mt-1 leading-relaxed">
              Recovery links are issued on your account in {summary.mode} mode, payments land with
              you, and they will be recorded here automatically. Account{" "}
              <code className="text-ink-200">{summary.keyFingerprint}</code>.
            </p>
            {webhookUrl && <WebhookUrl url={webhookUrl} copied={copied} setCopied={setCopied} />}
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

  // ── Step 3: the webhook ─────────────────────────────────────────────────
  if (summary?.connected) {
    return (
      <form onSubmit={saveWebhookSecret} className="rounded-md border border-line-soft bg-ground-100 p-5">
        <StepHeading n={3} of={3} title="Tell Razorpay where to send payment updates" />
        <p className="text-ink-300 text-[12.5px] mt-1.5 leading-relaxed">
          Your keys are saved. Without this last step, payments will still be collected but nothing
          here will know they arrived, so your forecast will keep showing the money as outstanding.
        </p>

        {webhookUrl && <WebhookUrl url={webhookUrl} copied={copied} setCopied={setCopied} />}

        <ol className="mt-4 space-y-2.5 text-[12.5px] text-ink-300">
          <li className="flex gap-2.5">
            <span className="text-ink-500 shrink-0">1.</span>
            <span>
              In Razorpay, open{" "}
              <strong className="text-ink-200">Settings → Webhooks → Add New Webhook</strong>.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="text-ink-500 shrink-0">2.</span>
            <span>
              Paste the URL above into <strong className="text-ink-200">Webhook URL</strong>.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="text-ink-500 shrink-0">3.</span>
            <span>
              In <strong className="text-ink-200">Secret</strong>, type any random text you like —
              you are choosing it, not looking it up. Keep it to hand for the next step.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="text-ink-500 shrink-0">4.</span>
            <span>
              Under <strong className="text-ink-200">Active Events</strong>, tick{" "}
              <code className="text-ink-200 bg-ground-200 px-1 rounded">payment_link.paid</code> and
              nothing else. It is the only event this uses.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="text-ink-500 shrink-0">5.</span>
            <span>Save it there, then enter the same secret below.</span>
          </li>
        </ol>

        {errorBox}

        <div className="mt-4">
          <Field
            id="rzp-webhook-secret"
            label="The webhook secret you just chose"
            placeholder="Exactly what you typed in Razorpay's Secret field"
            value={webhookSecret}
            onChange={setWebhookSecret}
            secret
          />
        </div>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={busy}
          disabled={!webhookSecret.trim()}
          className="mt-4"
        >
          {!busy && "Finish setup"}
        </Button>

        {/* Saving this does NOT change the URL above, so what was just pasted
            into Razorpay stays correct. */}
        <p className="text-ink-500 text-[11px] mt-2.5">
          Saving this keeps the same webhook URL, so you will not need to update Razorpay again.
        </p>
      </form>
    );
  }

  // ── Steps 1 & 2: the keys ───────────────────────────────────────────────
  return (
    <form onSubmit={connect} className="rounded-md border border-line-soft bg-ground-100 p-5">
      <div className="flex items-start gap-3.5">
        <Link2 className="w-5 h-5 text-brand-300 shrink-0 mt-0.5" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-ink-100">Connect your Razorpay account</h3>
          <p className="text-ink-300 text-[12.5px] mt-1 leading-relaxed">
            Recovery links will be issued on your account, so customers pay you directly rather than
            through us. Three short steps.
          </p>

          <div className="mt-3.5 rounded-md border border-line-soft bg-ground-200/50 p-3 text-[11.5px] text-ink-400 leading-relaxed space-y-1.5">
            <p>
              <strong className="text-ink-300">Test keys only.</strong> CashPilot has not been
              audited for holding credentials that move real money, so live keys are refused rather
              than accepted on trust.
            </p>
            <p>
              <strong className="text-ink-300">Your secret is encrypted</strong> before storage,
              under a key held outside the database. No screen can display it back, including this
              one.
            </p>
            <p>
              <strong className="text-ink-300">Disconnect whenever you like</strong> — it deletes
              what we hold.
            </p>
          </div>

          <div className="mt-4">
            <StepHeading n={1} of={3} title="Copy your API keys from Razorpay" />
            <p className="text-ink-300 text-[12.5px] mt-1.5 leading-relaxed">
              Open{" "}
              <a
                href="https://dashboard.razorpay.com/app/website-app-settings/api-keys"
                target="_blank"
                rel="noreferrer"
                className="text-brand-300 hover:text-brand-400 font-medium inline-flex items-center gap-1"
              >
                Settings → API Keys <ExternalLink className="w-3 h-3" aria-hidden />
              </a>{" "}
              and press <strong className="text-ink-200">Generate Test Key</strong>. Razorpay shows
              the secret once and never again, so copy both before closing that dialog.
            </p>
          </div>

          <div className="mt-4">
            <StepHeading n={2} of={3} title="Paste them here" />
          </div>

          {errorBox}

          <div className="mt-3 space-y-3">
            <Field
              id="rzp-key-id"
              label="Key ID"
              placeholder="rzp_test_..."
              help="Begins with rzp_test_. Safe to paste — it identifies your account rather than authorising it."
              value={keyId}
              onChange={setKeyId}
            />
            <Field
              id="rzp-key-secret"
              label="Key Secret"
              placeholder="The secret shown beside that key"
              help="Shown once by Razorpay when the key is generated. If you have lost it, generate a new key."
              value={keySecret}
              onChange={setKeySecret}
              secret
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
            {!busy && "Check and connect"}
          </Button>

          <p className="text-ink-500 text-[11px] mt-2.5">
            We check these against Razorpay before saving, so a typo fails now rather than later.
            The webhook comes next.
          </p>
        </div>
      </div>
    </form>
  );
}

function StepHeading({ n, of, title }: { n: number; of: number; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-5 h-5 rounded-full bg-brand-500/15 text-brand-300 text-[11px] font-semibold flex items-center justify-center shrink-0">
        {n}
      </span>
      <h4 className="text-[13px] font-semibold text-ink-100">{title}</h4>
      <span className="text-ink-500 text-[11px]">
        step {n} of {of}
      </span>
    </div>
  );
}

function WebhookUrl({
  url,
  copied,
  setCopied,
}: {
  url: string;
  copied: boolean;
  setCopied: (v: boolean) => void;
}) {
  return (
    <div className="mt-3.5">
      <p className="text-[12px] font-semibold text-ink-200">Your webhook URL</p>
      <div className="mt-1.5 flex items-center gap-2">
        <code className="text-[11.5px] text-ink-300 bg-ground-200 rounded px-2 py-1.5 truncate flex-1">
          {url}
        </code>
        <button
          type="button"
          onClick={() => navigator.clipboard?.writeText(url).then(() => setCopied(true))}
          className="shrink-0 inline-flex items-center gap-1 text-[12px] text-brand-300 hover:text-brand-400 font-semibold rounded focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {/* It identifies which account a webhook belongs to, so it is reissued on
          every reconnect — an old URL stops working the moment credentials are
          replaced. */}
      <p className="text-ink-500 text-[11px] mt-1.5">
        Unique to your business. It changes if you disconnect and connect again.
      </p>
    </div>
  );
}

function Field({
  id,
  label,
  placeholder,
  help,
  value,
  onChange,
  secret,
}: {
  id: string;
  label: string;
  placeholder: string;
  help?: string;
  value: string;
  onChange: (v: string) => void;
  secret?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="label block mb-1.5">
        {label}
      </label>
      <input
        id={id}
        // A secret in a plain text field is a secret on a projector, in a screen
        // recording, and in the browser's saved-form data.
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
      {help && <p className="text-ink-500 text-[11px] mt-1.5 leading-relaxed">{help}</p>}
    </div>
  );
}
