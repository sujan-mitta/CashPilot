"use client";

import React from "react";
import clsx from "clsx";
import { motion, type HTMLMotionProps } from "framer-motion";

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
  /** Accepted and ignored: the cursor-following wash was removed. */
  spotlight?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
  tone?: "default" | "raised" | "glass" | "brand" | "safe" | "warn" | "risk" | "unknown";
}

const paddingMap: Record<NonNullable<CardProps["padding"]>, string> = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-5",
};

const toneMap: Record<NonNullable<CardProps["tone"]>, string> = {
  // A border defines the card. The shadow underneath it was doing the same job
  // twice, and at rounded-md it read as a floating tile rather than a panel.
  default: "bg-ground-100 border-line-soft",
  raised: "bg-ground-200 border-line-soft",
  glass: "bg-ground-100 border-line-soft",
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    spotlight,
    padding = "md",
    tone = "default",
    children,
    style,
    ...rest
  },
  ref
) {
  return (
    <motion.div
      ref={ref}
      className={clsx(
        "relative rounded-md border",
        toneMap[tone],
        paddingMap[padding],
        hoverable && "lift",
        className
      )}
      style={style}
      {...rest}
    >
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
          <h3 className="text-[14px] font-semibold text-ink-100 truncate">{title}</h3>
        )}
      </div>
      {trailing && <div className="shrink-0">{trailing}</div>}
    </div>
  );
}
