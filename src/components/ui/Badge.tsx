import React from "react";
import clsx from "clsx";

export type BadgeTone = "brand" | "success" | "warning" | "danger" | "neutral" | "dark";

const toneClasses: Record<BadgeTone, string> = {
  brand: "bg-indigo-100 text-indigo-700",
  success: "bg-emerald-100 text-emerald-800",
  warning: "bg-amber-100 text-amber-800",
  danger: "bg-red-100 text-red-800",
  neutral: "bg-slate-100 text-slate-600",
  dark: "bg-slate-800 text-slate-100",
};

const dotClasses: Record<BadgeTone, string> = {
  brand: "bg-indigo-600",
  success: "bg-emerald-600",
  warning: "bg-amber-600",
  danger: "bg-red-600",
  neutral: "bg-slate-400",
  dark: "bg-slate-300",
};

interface BadgeProps {
  tone?: BadgeTone;
  children: React.ReactNode;
  className?: string;
  /** Small pulsing status dot, useful for live/at-risk indicators. */
  dot?: boolean;
  size?: "xs" | "sm";
}

export function Badge({ tone = "neutral", children, className, dot = false, size = "xs" }: BadgeProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full font-black uppercase tracking-wider whitespace-nowrap",
        toneClasses[tone],
        size === "xs" ? "text-[10px] px-2.5 py-1" : "text-xs px-3 py-1.5",
        className
      )}
    >
      {dot && (
        <span className="relative mr-1.5 flex h-1.5 w-1.5">
          <span className={clsx("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", dotClasses[tone])} />
          <span className={clsx("relative inline-flex h-1.5 w-1.5 rounded-full", dotClasses[tone])} />
        </span>
      )}
      {children}
    </span>
  );
}

/** Maps a LOW/MEDIUM/HIGH risk level to the right badge tone + label. */
export function riskTone(level: string | undefined): BadgeTone {
  if (level === "HIGH") return "danger";
  if (level === "MEDIUM") return "warning";
  return "success";
}
