"use client";

import React from "react";
import clsx from "clsx";
import { AnimatedNumber } from "./AnimatedNumber";

interface StatTileProps {
  label: string;
  /** Static value. Omit when passing numericValue + format for an animated count instead. */
  value?: React.ReactNode;
  /** If provided (with format), renders an animated count instead of a static value. */
  numericValue?: number;
  format?: (n: number) => string;
  sublabel?: React.ReactNode;
  tone?: "default" | "danger" | "success" | "brand";
  className?: string;
  size?: "sm" | "lg";
}

const toneText: Record<NonNullable<StatTileProps["tone"]>, string> = {
  default: "text-slate-800",
  danger: "text-red-600",
  success: "text-emerald-600",
  brand: "text-indigo-600",
};

export function StatTile({
  label,
  value,
  numericValue,
  format,
  sublabel,
  tone = "default",
  className,
  size = "sm",
}: StatTileProps) {
  return (
    <div className={className}>
      <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">{label}</span>
      <span className={clsx("font-black block", toneText[tone], size === "lg" ? "text-2xl sm:text-3xl" : "text-xl")}>
        {numericValue !== undefined && format ? <AnimatedNumber value={numericValue} format={format} /> : value}
      </span>
      {sublabel && <span className="text-[11px] text-slate-400 font-semibold mt-1 block">{sublabel}</span>}
    </div>
  );
}
