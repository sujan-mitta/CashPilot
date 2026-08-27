"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import clsx from "clsx";

export type ToastTone = "info" | "success" | "warning" | "danger";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  tone?: ToastTone;
  title: string;
  description?: string;
  action?: ToastAction;
  /** Auto-dismiss delay in ms. Defaults to 6000; pass 0 to require manual dismiss. */
  duration?: number;
}

interface ToastRecord extends ToastOptions {
  id: number;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** Access the toast API. Must be used under <ToastProvider>. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}

const TONE_STYLES: Record<
  ToastTone,
  { icon: typeof Info; iconClass: string; accent: string }
> = {
  info: { icon: Info, iconClass: "text-brand-500", accent: "before:bg-brand-500" },
  success: { icon: CheckCircle2, iconClass: "text-safe-500", accent: "before:bg-safe-500" },
  warning: { icon: AlertTriangle, iconClass: "text-warn-500", accent: "before:bg-warn-500" },
  danger: { icon: XCircle, iconClass: "text-risk-500", accent: "before:bg-risk-500" },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (options: ToastOptions) => {
      const id = nextId.current++;
      const record: ToastRecord = { tone: "info", duration: 6000, ...options, id };
      setToasts((prev) => [...prev, record]);
      if (record.duration && record.duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), record.duration)
        );
      }
      return id;
    },
    [dismiss]
  );

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="fixed bottom-4 right-4 z-[100] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2"
      >
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const tone = TONE_STYLES[t.tone ?? "info"];
            const Icon = tone.icon;
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 12, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: 24, scale: 0.98 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                role="status"
                className={clsx(
                  "relative overflow-hidden rounded-lg border border-line-soft bg-ground-100 shadow-lg",
                  "pl-4 pr-3 py-3 flex items-start gap-3",
                  "before:absolute before:left-0 before:top-0 before:h-full before:w-1 before:content-['']",
                  tone.accent
                )}
              >
                <Icon className={clsx("mt-0.5 h-5 w-5 shrink-0", tone.iconClass)} strokeWidth={2} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-100">{t.title}</p>
                  {t.description && (
                    <p className="mt-0.5 text-sm text-ink-300 break-words">{t.description}</p>
                  )}
                  {t.action && (
                    <button
                      type="button"
                      onClick={() => {
                        t.action!.onClick();
                        dismiss(t.id);
                      }}
                      className="mt-2 text-sm font-medium text-brand-500 hover:text-brand-600 focus:outline-none focus-visible:underline"
                    >
                      {t.action.label}
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => dismiss(t.id)}
                  aria-label="Dismiss notification"
                  className="mt-0.5 shrink-0 rounded p-0.5 text-ink-400 hover:text-ink-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <X className="h-4 w-4" strokeWidth={2} />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
