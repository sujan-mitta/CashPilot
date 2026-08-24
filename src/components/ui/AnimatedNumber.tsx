"use client";

import React, { useEffect, useRef } from "react";
import { motion, useSpring, useTransform, useReducedMotion } from "framer-motion";
import clsx from "clsx";

interface AnimatedNumberProps {
  /** Raw numeric value, e.g. an amount in paise. */
  value: number;
  /** Formats the (possibly fractional, mid-animation) value for display. */
  format?: (n: number) => string;
  className?: string;
}

/**
 * Counts a figure from its previous value to its next one.
 *
 * Two things matter here and both are about honesty rather than polish:
 *
 *  - It starts from the PREVIOUS value, not from zero. Counting up from zero
 *    on every mount implies a change that did not happen.
 *  - Under prefers-reduced-motion it renders the exact value immediately. A
 *    partially-counted figure is a wrong figure, and someone who asked for
 *    less motion should not be the one reading wrong numbers.
 */
export function AnimatedNumber({
  value,
  format = (n) => Math.round(n).toLocaleString("en-IN"),
  className,
}: AnimatedNumberProps) {
  const reduced = useReducedMotion();
  const spring = useSpring(value, { stiffness: 120, damping: 22, mass: 0.9 });
  const display = useTransform(spring, (v) => format(v));
  const mounted = useRef(false);

  useEffect(() => {
    // First commit: sit on the value rather than animating in from nowhere.
    if (!mounted.current) {
      mounted.current = true;
      spring.jump(value);
      return;
    }
    if (reduced) spring.jump(value);
    else spring.set(value);
  }, [value, spring, reduced]);

  if (reduced) {
    return <span className={clsx("numeric", className)}>{format(value)}</span>;
  }

  return <motion.span className={clsx("numeric", className)}>{display}</motion.span>;
}
