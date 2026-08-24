"use client";

import React from "react";
import clsx from "clsx";
import { motion, type HTMLMotionProps } from "framer-motion";

interface CardProps extends HTMLMotionProps<"div"> {
  /** Adds a lift + shadow transition on hover. Use for clickable / selectable cards. */
  hoverable?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
  tone?: "default" | "muted" | "dark" | "brand";
}

const paddingMap: Record<NonNullable<CardProps["padding"]>, string> = {
  none: "",
  sm: "p-4",
  md: "p-6",
  lg: "p-8",
};

const toneMap: Record<NonNullable<CardProps["tone"]>, string> = {
  default: "bg-white border-slate-200/80 shadow-sm",
  muted: "bg-slate-50 border-slate-200/60",
  dark: "bg-slate-900 border-slate-800 text-white",
  brand: "bg-indigo-50/60 border-indigo-100",
};

export const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, hoverable = false, padding = "md", tone = "default", children, ...rest },
  ref
) {
  return (
    <motion.div
      ref={ref}
      className={clsx(
        "rounded-3xl border",
        toneMap[tone],
        paddingMap[padding],
        hoverable && "card-hover",
        className
      )}
      {...rest}
    >
      {children}
    </motion.div>
  );
});
