import React from "react";
import clsx from "clsx";

/**
 * Status pill.
 *
 * The tone is a claim about state, so the vocabulary matches the engine's:
 * `unknown` is its own tone because an undetermined provider outcome is
 * genuinely not "warning" and absolutely not "success" — conflating it with
 * either is how an operator concludes money moved when nobody knows.
 */

export type BadgeTone =
  | "brand"
  | "success"
  | "warning"
  | "danger"
  | "unknown"
  | "neutral"
  | "live";

const toneClasses: Record<BadgeTone, string> = {
  brand: "bg-brand-500/12 text-brand-300 ring-1 ring-inset ring-brand-500/25",
  success: "bg-safe-500/12 text-safe-400 ring-1 ring-inset ring-safe-500/25",
  warning: "bg-warn-500/12 text-warn-400 ring-1 ring-inset ring-warn-500/25",
  danger: "bg-risk-500/12 text-risk-400 ring-1 ring-inset ring-risk-500/25",
  unknown: "bg-unknown-500/12 text-unknown-400 ring-1 ring-inset ring-unknown-500/25",
  neutral: "bg-ground-300 text-ink-300 ring-1 ring-inset ring-line-soft",
  live: "bg-live-500/12 text-live-400 ring-1 ring-inset ring-live-500/30",
};

const dotClasses: Record<BadgeTone, string> = {
  brand: "bg-brand-400",
  success: "bg-safe-400",
  warning: "bg-warn-400",
  danger: "bg-risk-400",
  unknown: "bg-unknown-400",
  neutral: "bg-ink-400",
  live: "bg-live-400",
};

interface BadgeProps {
  tone?: BadgeTone;
  children: React.ReactNode;
  className?: string;
  /** Pulsing dot. Only for states that are genuinely in flight. */
  dot?: boolean;
  size?: "xs" | "sm";
}

export function Badge({
  tone = "neutral",
  children,
  className,
  dot = false,
  size = "xs",
}: BadgeProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full font-semibold uppercase whitespace-nowrap tracking-[0.08em]",
        toneClasses[tone],
        size === "xs" ? "text-[10px] px-2.5 py-1" : "text-[11px] px-3 py-1.5",
        className
      )}
    >
      {dot && (
        <span className="relative mr-1.5 flex h-1.5 w-1.5" aria-hidden>
          <span
            className={clsx(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
              dotClasses[tone]
            )}
          />
          <span className={clsx("relative inline-flex h-1.5 w-1.5 rounded-full", dotClasses[tone])} />
        </span>
      )}
      {children}
    </span>
  );
}

/** Maps a LOW/MEDIUM/HIGH risk level to the right badge tone. */
export function riskTone(level: string | undefined): BadgeTone {
  if (level === "HIGH") return "danger";
  if (level === "MEDIUM") return "warning";
  return "success";
}
