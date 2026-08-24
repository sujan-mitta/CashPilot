"use client";

import React from "react";
import { motion, type Variants } from "framer-motion";
import { fadeUp, staggerContainer, staggerItem } from "./motion";

interface RevealProps {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  variants?: Variants;
  as?: "div" | "section";
}

/**
 * Fades + lifts its children in on mount. Use for individual sections so a
 * page never just "appears" — it settles into place.
 */
export function Reveal({ children, className, delay = 0, variants = fadeUp, as = "div" }: RevealProps) {
  const Component = motion[as];
  return (
    <Component
      className={className}
      initial="hidden"
      animate="show"
      variants={variants}
      transition={{ delay }}
    >
      {children}
    </Component>
  );
}

interface StaggerProps {
  children: React.ReactNode;
  className?: string;
  stagger?: number;
  delayChildren?: number;
  as?: "div" | "section" | "ul";
}

/** Container that reveals its direct children one after another. Pair with <StaggerItem>. */
export function Stagger({ children, className, stagger = 0.07, delayChildren = 0, as = "div" }: StaggerProps) {
  const Component = motion[as];
  return (
    <Component
      className={className}
      initial="hidden"
      animate="show"
      variants={staggerContainer(stagger, delayChildren)}
    >
      {children}
    </Component>
  );
}

export function StaggerItem({
  children,
  className,
  as = "div",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "div" | "li";
}) {
  const Component = motion[as];
  return (
    <Component className={className} variants={staggerItem}>
      {children}
    </Component>
  );
}
