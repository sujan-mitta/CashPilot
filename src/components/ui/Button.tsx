"use client";

import React from "react";
import clsx from "clsx";
import { motion, type HTMLMotionProps } from "framer-motion";
import { Loader2 } from "lucide-react";
import { tapSpring } from "./motion";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success" | "subtle";
export type ButtonSize = "sm" | "md" | "lg";

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-indigo-600 text-white shadow-[0_10px_28px_-6px_rgb(79,70,229,0.38)] hover:bg-indigo-700 hover:shadow-[0_14px_32px_-6px_rgb(79,70,229,0.46)] disabled:bg-slate-300 disabled:shadow-none",
  secondary:
    "bg-white text-slate-700 border border-slate-200 shadow-sm hover:border-indigo-300 hover:text-indigo-700 hover:bg-indigo-50/40 disabled:opacity-50",
  ghost: "bg-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100 disabled:opacity-50",
  danger:
    "bg-red-600 text-white shadow-[0_10px_24px_-6px_rgb(220,38,38,0.35)] hover:bg-red-700 disabled:bg-slate-300 disabled:shadow-none",
  success:
    "bg-emerald-600 text-white shadow-[0_10px_24px_-6px_rgb(5,150,105,0.35)] hover:bg-emerald-700 disabled:bg-slate-300 disabled:shadow-none",
  subtle: "bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-800 disabled:opacity-50",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "text-xs font-bold px-3.5 py-2 rounded-lg gap-1.5",
  md: "text-xs font-bold px-5 py-2.5 rounded-xl gap-2",
  lg: "text-sm font-bold px-8 py-4 rounded-xl gap-2",
};

export function buttonClasses(variant: ButtonVariant = "primary", size: ButtonSize = "md", className?: string) {
  return clsx(
    "inline-flex items-center justify-center whitespace-nowrap outline-none transition-colors duration-200 select-none disabled:cursor-not-allowed",
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
  return (
    <motion.button
      ref={ref}
      whileTap={disabled || loading ? undefined : { scale: 0.97 }}
      transition={tapSpring}
      disabled={disabled || loading}
      className={buttonClasses(variant, size, className)}
      {...rest}
    >
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      {children}
    </motion.button>
  );
});
