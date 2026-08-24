"use client";

import React, { useEffect } from "react";
import { motion, useSpring, useTransform } from "framer-motion";
import clsx from "clsx";

interface AnimatedNumberProps {
  /** Raw numeric value, e.g. an amount in paise. */
  value: number;
  /** Formats the (possibly fractional, mid-animation) numeric value for display. */
  format?: (n: number) => string;
  className?: string;
}

/**
 * Springs a numeric value up (or down) from its previous value whenever it
 * changes, rendering through `format`. Gives financial figures a sense of
 * being live/computed rather than just appearing.
 */
export function AnimatedNumber({ value, format = (n) => Math.round(n).toLocaleString("en-IN"), className }: AnimatedNumberProps) {
  const spring = useSpring(0, { stiffness: 120, damping: 22, mass: 0.9 });
  const display = useTransform(spring, (v) => format(v));

  useEffect(() => {
    spring.set(value);
  }, [value, spring]);

  return <motion.span className={clsx("tabular-nums", className)}>{display}</motion.span>;
}
