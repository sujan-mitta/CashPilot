"use client";

import React from "react";
import clsx from "clsx";
import { Loader2 } from "lucide-react";

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
  // Solid fills. The gradient + coloured drop-glow these used to carry is the
  // most recognisable "generated UI" signal there is, and it made every button
  // look like a call to action on a landing page.
  primary: clsx(
    // brand-600, not brand-500: the filled control needs 4.5:1 against white
    // text in BOTH themes, and the lighter accent only clears it on light.
    "text-white bg-brand-600 border border-brand-600",
    "hover:bg-brand-700 hover:border-brand-700",
    "disabled:bg-ground-300 disabled:text-ink-500 disabled:border-line-soft"
  ),
  secondary: clsx(
    "bg-ground-100 text-ink-200 border border-line-firm",
    "hover:bg-ground-200 hover:text-ink-100",
    "disabled:bg-ground-200 disabled:text-ink-500 disabled:border-line-soft"
  ),
  ghost: clsx(
    "bg-transparent text-ink-300 border border-transparent",
    "hover:text-ink-100 hover:bg-ground-200",
    "disabled:text-ink-500 disabled:hover:bg-transparent"
  ),
  danger: clsx(
    "text-white bg-risk-solid border border-risk-solid",
    "hover:bg-risk-solid-hover hover:border-risk-solid-hover",
    "disabled:bg-ground-300 disabled:text-ink-500 disabled:border-line-soft"
  ),
  success: clsx(
    "text-white bg-safe-solid border border-safe-solid",
    "hover:bg-safe-solid-hover hover:border-safe-solid-hover",
    "disabled:bg-ground-300 disabled:text-ink-500 disabled:border-line-soft"
  ),
  subtle: clsx(
    "bg-ground-200 text-ink-300 border border-line-soft",
    "hover:bg-ground-300 hover:text-ink-100",
    "disabled:text-ink-500"
  ),
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "text-[13px] font-medium px-2.5 py-1.5 rounded-md gap-1.5",
  md: "text-[13px] font-medium px-3.5 py-2 rounded-md gap-2",
  lg: "text-[14px] font-medium px-4 py-2.5 rounded-md gap-2",
};

export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string
) {
  return clsx(
    "relative inline-flex items-center justify-center whitespace-nowrap select-none",
    "tracking-normal",
    "transition-[background-color,border-color,color] duration-100 ease-[cubic-bezier(0.2,0,0.2,1)]",
    "disabled:cursor-not-allowed",
    variantClasses[variant],
    sizeClasses[size],
    className
  );
}

interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
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
    <button
      ref={ref}
      disabled={inert}
      // Communicates the wait to assistive tech, which a spinner alone does not.
      aria-busy={loading || undefined}
      className={buttonClasses(variant, size, className)}
      {...rest}
    >
      {loading && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});
