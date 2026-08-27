"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import clsx from "clsx";
import { applyTheme, resolveEffectiveTheme } from "@/lib/theme";

/**
 * Light/dark toggle. Reads the effective theme on mount (after hydration, so it
 * never mismatches the server-rendered markup) and flips between an explicit
 * light and dark choice. The pre-hydration script in <head> has already applied
 * any stored preference, so this only has to reflect and change it.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [effective, setEffective] = useState<"light" | "dark">("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setEffective(resolveEffectiveTheme());
    setMounted(true);
  }, []);

  const toggle = () => {
    const next = effective === "dark" ? "light" : "dark";
    applyTheme(next);
    setEffective(next);
  };

  const isDark = effective === "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className={clsx(
        "inline-flex items-center justify-center w-9 h-9 rounded-md",
        "border border-line-soft bg-ground-100 text-ink-300",
        "hover:text-ink-100 hover:border-line-firm",
        "transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
        className
      )}
    >
      {/* Before mount, render a stable icon so SSR and first client paint agree. */}
      {mounted && isDark ? <Sun className="w-4 h-4" strokeWidth={2} /> : <Moon className="w-4 h-4" strokeWidth={2} />}
    </button>
  );
}
