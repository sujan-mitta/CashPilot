"use client";

import React from "react";
import clsx from "clsx";
import { motion, type HTMLMotionProps } from "framer-motion";
import { useSpotlight } from "./useInteraction";

/**
 * The panel every surface is built from.
 *
 * `tone` carries financial meaning where it is not "default": a card toned
 * `risk` is stating that the data inside it represents a deficit, not that the
 * designer wanted red there. Tone is chosen from data, never from layout.
 */

interface CardProps extends Omit<HTMLMotionProps<"div">, "children"> {
  children?: React.ReactNode;
  /** Lift + shadow on hover. For cards that are clickable or selectable. */
  hoverable?: boolean;
  /** Cursor-following highlight. Reserve for large hero or feature cards. */
  spotlight?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
  tone?: "default" | "raised" | "glass" | "brand" | "safe" | "warn" | "risk" | "unknown";
}

const paddingMap: Record<NonNullable<CardProps["padding"]>, string> = {
  none: "",
  sm: "p-4",
  md: "p-6",
  lg: "p-8",
};

const toneMap: Record<NonNullable<CardProps["tone"]>, string> = {
  default: "bg-ground-100 border-line-soft shadow-[var(--lift-1)]",
  raised: "bg-ground-200 border-line-soft shadow-[var(--lift-2)]",
  glass: "glass",
  brand: "bg-brand-500/[0.07] border-brand-500/25",
  safe: "bg-safe-500/[0.07] border-safe-500/25",
  warn: "bg-warn-500/[0.07] border-warn-500/25",
  risk: "bg-risk-500/[0.07] border-risk-500/25",
  unknown: "bg-unknown-500/[0.07] border-unknown-500/25",
};

export const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card(
  {
    className,
    hoverable = false,
    spotlight = false,
    padding = "md",
    tone = "default",
    children,
    style,
    ...rest
  },
  ref
) {
  const spot = useSpotlight<HTMLDivElement>();

  return (
    <motion.div
      ref={ref}
      className={clsx(
        "relative rounded-2xl border",
        toneMap[tone],
        paddingMap[padding],
        hoverable && "lift",
        spotlight && "overflow-hidden",
        className
      )}
      style={style}
      {...rest}
    >
      {spotlight && (
        // Sits behind content, follows the cursor, and fades out on leave.
        // Driven by CSS custom properties written from a pointer handler, so
        // moving the cursor never causes a React render.
        <span
          ref={spot.ref}
          {...spot.handlers}
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-[var(--spot-on,0)] transition-opacity duration-300"
          style={{
            background:
              "radial-gradient(22rem 22rem at var(--spot-x, 50%) var(--spot-y, 50%), rgb(99 102 241 / 0.16), transparent 68%)",
          }}
        />
      )}
      {children}
    </motion.div>
  );
});

/**
 * Header row for a card: a label, an optional figure, and optional trailing
 * controls. Exists so twelve screens do not each invent their own.
 */
export function CardHeader({
  label,
  title,
  trailing,
  className,
}: {
  label?: React.ReactNode;
  title?: React.ReactNode;
  trailing?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        {label && <div className="label mb-1.5">{label}</div>}
        {title && (
          <h3 className="text-[0.95rem] font-semibold text-ink-100 truncate">{title}</h3>
        )}
      </div>
      {trailing && <div className="shrink-0">{trailing}</div>}
    </div>
  );
}
