"use client";

import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MailCheck, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EASE_GLIDE, DUR } from "@/components/ui/motion";
import { errorMessage } from "@/lib/errors";
import clsx from "clsx";

/**
 * The step where someone proves the address they typed actually exists.
 *
 * Nothing before this point can establish that. Shape validation cannot tell
 * "sujan@gmail.com" from "sujan@gmial.com" — both are well formed, only one
 * receives mail — so accounts were created on addresses that bounce, and every
 * alert to them came back to us as "recipient does not exist".
 *
 * The session is issued here rather than at signup, which is why this screen
 * cannot be skipped.
 */

const RESEND_COOLDOWN_SECONDS = 60;
const CODE_LENGTH = 6;

interface SessionUser {
  userId: string;
  name: string;
  email: string;
  businessId: string;
  businessName: string;
}

interface VerifyStepProps {
  email: string;
  /** Message carried over from signup or login, shown before the first attempt. */
  notice?: string | null;
  onVerified: (user: SessionUser) => void;
  onBack: () => void;
}

export function VerifyStep({ email, notice, onVerified, onBack }: VerifyStepProps) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(notice ?? null);
  const [isLoading, setIsLoading] = useState(false);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A resend button that is always live invites people to hammer it, and every
  // press is another email to an address that may not exist.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== CODE_LENGTH) {
      setError(`Enter the ${CODE_LENGTH}-digit code from your email.`);
      return;
    }

    setError(null);
    setInfo(null);
    setIsLoading(true);

    try {
      const res = await fetch("/api/auth/verify/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "That code could not be verified.");
        setCode("");
        inputRef.current?.focus();
        setIsLoading(false);
        return;
      }

      onVerified(data.user);
      setIsLoading(false);
    } catch (err) {
      setError(errorMessage(err, "Unable to reach the verification service."));
      setIsLoading(false);
    }
  };

  const resend = async () => {
    if (cooldown > 0) return;
    setError(null);
    setInfo(null);
    try {
      await fetch("/api/auth/verify/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      // The endpoint answers the same way whether or not a code went out, so
      // that it cannot be used to discover which addresses are registered. The
      // wording here matches that: it describes what was requested, not what
      // the server found.
      setInfo("If that address is awaiting verification, a new code is on its way.");
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(errorMessage(err, "Could not request a new code."));
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DUR.base, ease: EASE_GLIDE }}
      className="space-y-5"
    >
      <div className="text-center">
        <div className="w-11 h-11 rounded-md bg-brand-500/12 border border-brand-500/25 flex items-center justify-center mx-auto mb-4">
          <MailCheck className="w-5 h-5 text-brand-300" aria-hidden />
        </div>
        <h2 className="text-[1.35rem] font-semibold text-ink-100 tracking-[-0.03em]">
          Confirm your email
        </h2>
        <p className="text-ink-400 text-[12.5px] mt-1.5 leading-relaxed">
          We sent a {CODE_LENGTH}-digit code to{" "}
          <span className="text-ink-200 font-medium break-all">{email}</span>. Enter it to finish
          setting up your account.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <AnimatePresence>
          {(error || info) && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: DUR.base, ease: EASE_GLIDE }}
              role="alert"
              className="overflow-hidden"
            >
              <div
                className={clsx(
                  "p-3.5 rounded-md text-[12.5px] font-medium border",
                  error
                    ? "bg-risk-500/10 border-risk-500/25 text-risk-400"
                    : "bg-brand-500/10 border-brand-500/25 text-brand-300"
                )}
              >
                {error || info}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div>
          <label htmlFor="cp-code" className="label block mb-1.5">
            Verification code
          </label>
          <input
            id="cp-code"
            ref={inputRef}
            // `inputMode` and `autoComplete` together are what make a phone
            // offer the code straight from the notification instead of making
            // someone switch apps to read it.
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={CODE_LENGTH}
            required
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))}
            className={clsx(
              "w-full px-4 py-3.5 rounded-md text-center text-[1.4rem] font-semibold tracking-[0.4em]",
              "bg-ground-200/70 border border-line-soft text-ink-100 font-mono",
              "placeholder:text-ink-500 placeholder:font-normal placeholder:tracking-[0.4em]",
              "transition-[border-color,background,box-shadow] duration-200 hover:border-line-firm",
              "focus:border-brand-500 focus:bg-ground-200",
              "focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-100"
            )}
          />
        </div>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={isLoading}
          disabled={code.length !== CODE_LENGTH}
          className="mt-1 w-full"
        >
          {!isLoading && "Verify and continue"}
        </Button>
      </form>

      <div className="flex items-center justify-between pt-0.5">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-400 hover:text-ink-200 transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050 rounded"
        >
          <ArrowLeft className="w-3.5 h-3.5" aria-hidden />
          Use a different email
        </button>

        <button
          type="button"
          onClick={resend}
          disabled={cooldown > 0}
          className={clsx(
            "text-[12.5px] font-medium transition-colors rounded",
            "focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050",
            cooldown > 0
              ? "text-ink-500 cursor-not-allowed"
              : "text-brand-300 hover:text-brand-400"
          )}
        >
          {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
        </button>
      </div>

      <p className="text-center text-[11.5px] text-ink-500 leading-relaxed">
        No code? Check spam, and confirm the address is spelled correctly — CashPilot only sends
        alerts to addresses it has confirmed can receive them.
      </p>
    </motion.div>
  );
}
