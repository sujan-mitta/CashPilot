"use client";

import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import clsx from "clsx";
import { EASE_OUT_EXPO } from "./motion";

/**
 * Toasts.
 *
 * Replaces window.alert(), which blocks the page, cannot be styled, cannot be
 * dismissed by the app, and leaves no trace once accepted — all of which are
 * wrong on a screen where the operator may need to re-read what happened to
 * their money.
 *
 * Tone follows the same financial vocabulary as everything else: `danger` is a
 * real failure, `warning` is unresolved, `success` is confirmed. Nothing here
 * invents a colour for emphasis.
 */

export type ToastTone = "success" | "danger" | "warning" | "info";

export interface ToastOptions {
  title: string;
  /** The recovery step. An error that does not say what to do next is half an error. */
  description?: string;
  tone?: ToastTone;
  /** Milliseconds. Pass 0 to require an explicit dismiss. */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastRecord extends ToastOptions {
  id: number;
  tone: ToastTone;
}

interface ToastApi {
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = React.createContext<ToastApi | null>(null);

const toneRing: Record<ToastTone, string> = {
  success: "border-safe-500/30",
  danger: "border-risk-500/35",
  warning: "border-warn-500/35",
  info: "border-brand-500/30",
};

const toneIconColor: Record<ToastTone, string> = {
  success: "text-safe-400",
  danger: "text-risk-400",
  warning: "text-warn-400",
  info: "text-brand-400",
};

const ToneIcon: Record<ToastTone, typeof Info> = {
  success: CheckCircle2,
  danger: XCircle,
  warning: AlertTriangle,
  info: Info,
};

/** Failures stay put long enough to be read and acted on; confirmations don't. */
const DEFAULT_DURATION: Record<ToastTone, number> = {
  success: 4000,
  info: 5000,
  warning: 8000,
  danger: 0,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastRecord[]>([]);
  const nextId = React.useRef(1);
  const timers = React.useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = React.useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = React.useCallback(
    (options: ToastOptions) => {
      const id = nextId.current++;
      const tone = options.tone ?? "info";
      const duration = options.duration ?? DEFAULT_DURATION[tone];

      setToasts((prev) => {
        const next = [...prev, { ...options, id, tone }];
        // More than a few stacked toasts is noise, not information. The oldest
        // go first so the most recent outcome is always the visible one.
        return next.length > 4 ? next.slice(next.length - 4) : next;
      });

      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration)
        );
      }
      return id;
    },
    [dismiss]
  );

  React.useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  const api = React.useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        // polite, not assertive: these announce outcomes, and an assertive
        // region would interrupt a screen reader mid-sentence on every success.
        aria-live="polite"
        aria-atomic="false"
        className="fixed bottom-0 right-0 z-[200] flex flex-col items-end gap-2.5 p-4 sm:p-6 pointer-events-none w-full sm:max-w-md"
      >
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const Icon = ToneIcon[t.tone];
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 16, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: 24, scale: 0.97 }}
                transition={{ duration: 0.28, ease: EASE_OUT_EXPO }}
                className={clsx(
                  "pointer-events-auto w-full glass-strong rounded-md border shadow-[var(--lift-3)]",
                  "px-4 py-3.5 flex items-start gap-3",
                  toneRing[t.tone]
                )}
                role={t.tone === "danger" ? "alert" : "status"}
              >
                <Icon
                  className={clsx("w-[18px] h-[18px] shrink-0 mt-px", toneIconColor[t.tone])}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-ink-100 leading-snug">{t.title}</p>
                  {t.description && (
                    <p className="text-[12.5px] text-ink-300 leading-relaxed mt-1">{t.description}</p>
                  )}
                  {t.action && (
                    <button
                      type="button"
                      onClick={() => {
                        t.action!.onClick();
                        dismiss(t.id);
                      }}
                      className="mt-2.5 text-[12px] font-semibold text-brand-300 hover:text-brand-400 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050 rounded"
                    >
                      {t.action.label}
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => dismiss(t.id)}
                  aria-label="Dismiss"
                  className="shrink-0 text-ink-400 hover:text-ink-100 p-1 -m-1 rounded-md focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return ctx;
}
