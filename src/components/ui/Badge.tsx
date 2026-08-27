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
  brand: "bg-brand-500/10 text-brand-400 border border-brand-500/25",
  success: "bg-safe-500/10 text-safe-400 border border-safe-500/25",
  warning: "bg-warn-500/10 text-warn-400 border border-warn-500/25",
  danger: "bg-risk-500/10 text-risk-400 border border-risk-500/25",
  unknown: "bg-unknown-500/10 text-unknown-400 border border-unknown-500/25",
  neutral: "bg-ground-200 text-ink-300 border border-line-soft",
  live: "bg-live-500/10 text-live-400 border border-live-500/25",
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
        // Sentence case, 4px corners, normal tracking. The tracked
        // pill is a styling tic; a status chip should read as a word.
        "inline-flex items-center rounded font-medium whitespace-nowrap",
        toneClasses[tone],
        size === "xs" ? "text-[12px] px-1.5 py-0.5" : "text-[12.5px] px-2 py-1",
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
