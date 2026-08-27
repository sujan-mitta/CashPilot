"use client";

import React from "react";
import clsx from "clsx";
import { AnimatedNumber } from "./AnimatedNumber";

/**
 * A single figure with its label.
 *
 * The figure is the largest, brightest thing in the tile and everything else
 * recedes — that hierarchy is the whole job. `tone` is derived from what the
 * number MEANS, so a tile never renders green because green looked better.
 */

interface StatTileProps {
  label: string;
  /** Static value. Omit when passing numericValue + format for an animated count. */
  value?: React.ReactNode;
  /** With `format`, renders an animated count instead of a static value. */
  numericValue?: number;
  format?: (n: number) => string;
  sublabel?: React.ReactNode;
  tone?: "default" | "danger" | "success" | "warning" | "brand";
  className?: string;
  size?: "sm" | "lg" | "xl";
}

const toneText: Record<NonNullable<StatTileProps["tone"]>, string> = {
  default: "text-ink-100",
  danger: "text-risk-400",
  success: "text-safe-400",
  warning: "text-warn-400",
  brand: "text-brand-300",
};

const sizeText: Record<NonNullable<StatTileProps["size"]>, string> = {
  sm: "text-[17px]",
  lg: "text-[22px]",
  xl: "text-[28px] leading-[1.15]",
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
      <span className="label block mb-1">{label}</span>
      <span
        className={clsx(
          "numeric font-semibold block tracking-[-0.012em]",
          toneText[tone],
          sizeText[size]
        )}
      >
        {numericValue !== undefined && format ? (
          <AnimatedNumber value={numericValue} format={format} />
        ) : (
          value
        )}
      </span>
      {sublabel && (
        <span className="text-[12px] text-ink-400 mt-1 block">{sublabel}</span>
      )}
    </div>
  );
}
