"use client";

import React from "react";
import clsx from "clsx";
import { motion, type HTMLMotionProps } from "framer-motion";
import { Loader2 } from "lucide-react";
import { tapSpring } from "./motion";

/**
 * Buttons.
 *
 * `primary` is the one action a screen wants. `danger` and `success` are NOT
 * decorative alternatives to it — they mean the action moves money or ends a
 * decision, and a screen should rarely have more than one.
 *
 * Every variant keeps its own disabled treatment rather than dropping opacity
 * globally: a disabled primary must not still look like the brightest thing on
 * the screen, or the operator keeps aiming at it.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success" | "subtle";
export type ButtonSize = "sm" | "md" | "lg";

const variantClasses: Record<ButtonVariant, string> = {
  // Gradient + inset top highlight is what makes a dark-UI button look lit
  // rather than painted.
  primary: clsx(
    "text-white bg-gradient-to-b from-brand-500 to-brand-600",
    "shadow-[0_1px_0_rgb(255_255_255/0.14)_inset,0_8px_24px_-8px_rgb(99_102_241/0.65)]",
    "hover:from-brand-400 hover:to-brand-500",
    "hover:shadow-[0_1px_0_rgb(255_255_255/0.18)_inset,0_12px_32px_-8px_rgb(99_102_241/0.8)]",
    "disabled:from-ground-300 disabled:to-ground-300 disabled:text-ink-500 disabled:shadow-none"
  ),
  secondary: clsx(
    "bg-ground-200 text-ink-200 border border-line-soft",
    "shadow-[0_1px_0_rgb(255_255_255/0.05)_inset]",
    "hover:bg-ground-300 hover:border-line-firm hover:text-ink-100",
    "disabled:bg-ground-100 disabled:text-ink-500 disabled:border-line-faint"
  ),
  ghost: clsx(
    "bg-transparent text-ink-300",
    "hover:text-ink-100 hover:bg-ground-200",
    "disabled:text-ink-500 disabled:hover:bg-transparent"
  ),
  danger: clsx(
    "text-white bg-gradient-to-b from-risk-400 to-risk-500",
    "shadow-[0_1px_0_rgb(255_255_255/0.14)_inset,0_8px_24px_-8px_rgb(244_63_94/0.6)]",
    "hover:from-risk-400 hover:to-risk-400",
    "disabled:from-ground-300 disabled:to-ground-300 disabled:text-ink-500 disabled:shadow-none"
  ),
  success: clsx(
    "text-white bg-gradient-to-b from-safe-400 to-safe-500",
    "shadow-[0_1px_0_rgb(255_255_255/0.14)_inset,0_8px_24px_-8px_rgb(16_185_129/0.6)]",
    "hover:from-safe-400 hover:to-safe-400",
    "disabled:from-ground-300 disabled:to-ground-300 disabled:text-ink-500 disabled:shadow-none"
  ),
  subtle: clsx(
    "bg-ground-100 text-ink-300 border border-line-faint",
    "hover:bg-ground-200 hover:text-ink-100",
    "disabled:text-ink-500"
  ),
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "text-[0.78rem] font-semibold px-3.5 py-2 rounded-[10px] gap-1.5",
  md: "text-[0.82rem] font-semibold px-5 py-2.5 rounded-xl gap-2",
  lg: "text-[0.92rem] font-semibold px-7 py-3.5 rounded-xl gap-2.5",
};

export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string
) {
  return clsx(
    "relative inline-flex items-center justify-center whitespace-nowrap select-none",
    "outline-none tracking-[-0.01em]",
    "transition-[background,border-color,color,box-shadow,transform] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]",
    "disabled:cursor-not-allowed",
    variantClasses[variant],
    sizeClasses[size],
    className
  );
}

interface ButtonProps extends Omit<HTMLMotionProps<"button">, "ref" | "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, disabled, className, children, ...rest },
  ref
) {
  const inert = disabled || loading;

  return (
    <motion.button
      ref={ref}
      whileTap={inert ? undefined : { scale: 0.975 }}
      whileHover={inert ? undefined : { y: -1 }}
      transition={tapSpring}
      disabled={inert}
      // Communicates the wait to assistive tech, which a spinner alone does not.
      aria-busy={loading || undefined}
      className={buttonClasses(variant, size, className)}
      {...rest}
    >
      {loading && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
      {children}
    </motion.button>
  );
});
