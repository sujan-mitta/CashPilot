"use client";

import React from "react";

/**
 * These used to fade-and-rise every section into view on a stagger, on every
 * screen — 69 wrappers in total. Content that assembles itself as you scroll
 * is the house style of a marketing page, not of a tool somebody uses all day
 * to read numbers. An operator opening the dashboard wants the figures to be
 * there, not to arrive.
 *
 * The components are kept (rather than deleted from 69 call sites) so the page
 * structure stays readable, and so a future decision to animate has one place
 * to go. They now render a plain element.
 */

type DivProps = React.HTMLAttributes<HTMLDivElement>;

/** Accepts and ignores the old motion props so call sites need no edits. */
type LegacyMotionProps = {
  variants?: unknown;
  stagger?: number;
  delayChildren?: number;
  delay?: number;
  once?: boolean;
  amount?: number;
};

export function Reveal({
  children,
  variants,
  delay,
  once,
  amount,
  ...rest
}: DivProps & LegacyMotionProps) {
  void variants; void delay; void once; void amount;
  return <div {...rest}>{children}</div>;
}

export function Stagger({
  children,
  stagger,
  delayChildren,
  variants,
  ...rest
}: DivProps & LegacyMotionProps) {
  void stagger; void delayChildren; void variants;
  return <div {...rest}>{children}</div>;
}

export function StaggerItem({ children, variants, ...rest }: DivProps & LegacyMotionProps) {
  void variants;
  return <div {...rest}>{children}</div>;
}
