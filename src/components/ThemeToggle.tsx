"use client";

import React from "react";
import { motion } from "framer-motion";
import { Monitor, Moon, Sun } from "lucide-react";
import clsx from "clsx";
import {
  applyTheme,
  readStoredTheme,
  type ThemePreference,
} from "@/lib/theme";

/**
 * Theme control.
 *
 * A three-way segmented control rather than a cycling icon button. A cycling
 * button hides the current state — you press it and find out what you get —
 * which is exactly the kind of guessing this UI is trying to remove. Here all
 * three options are visible and the selected one is marked.
 */

const OPTIONS: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "system", label: "Match device", Icon: Monitor },
  { value: "dark", label: "Dark", Icon: Moon },
];

/**
 * The stored preference is a value React does not own — it lives in
 * localStorage and can change in another tab. useSyncExternalStore is the
 * built-in for exactly that, and it is what ForecastChart already uses in this
 * codebase for the same server-says-one-thing / client-says-another problem.
 * A useState + useEffect pair would work too, but it sets state during an
 * effect on every mount, which is the cascading-render pattern React now warns
 * about.
 */
const themeStore = {
  subscribe(onChange: () => void) {
    // A `storage` event only fires in OTHER tabs, which is precisely what is
    // wanted: change the theme in one tab and every other tab follows.
    window.addEventListener("storage", onChange);
    return () => window.removeEventListener("storage", onChange);
  },
  getSnapshot: () => readStoredTheme(),
  // No preference is knowable on the server, so nothing renders as selected
  // until hydration. Guessing here would be a hydration mismatch.
  getServerSnapshot: (): ThemePreference | null => null,
};

export function ThemeToggle({ className }: { className?: string }) {
  const pref = React.useSyncExternalStore(
    themeStore.subscribe,
    themeStore.getSnapshot,
    themeStore.getServerSnapshot
  );

  // Local mirror so the pressed segment updates instantly; a `storage` event
  // does not fire in the tab that wrote the value.
  const [optimistic, setOptimistic] = React.useState<ThemePreference | null>(null);
  const selectedPref = optimistic ?? pref;

  const choose = (next: ThemePreference) => {
    setOptimistic(next);
    applyTheme(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      // No `relative` here on purpose. The selected marker positions against
      // each BUTTON (which sets its own `relative`), so this wrapper never
      // needed it — and having it meant a caller passing `absolute` via
      // className got both classes, with `relative` winning in Tailwind's
      // generated order. On the sign-in page that put the control at x=-20,
      // off the left edge of the screen.
      className={clsx(
        "flex items-center gap-0.5 p-0.5 rounded-md",
        "bg-ground-200 border border-line-soft",
        className
      )}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const selected = selectedPref === value;

        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            onClick={() => choose(value)}
            className={clsx(
              "relative w-7 h-7 rounded flex items-center justify-center focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050",
              "transition-colors duration-200",
              selected ? "text-ink-100" : "text-ink-400 hover:text-ink-200"
            )}
          >
            {selected && (
              // Shared layoutId, so choosing a mode slides the marker across
              // instead of cross-fading — the same technique the step indicator
              // uses, which keeps the two controls feeling like one system.
              <motion.span
                layoutId="theme-toggle-marker"
                className="absolute inset-0 rounded bg-ground-400 border border-line-firm"
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            )}
            <Icon className="relative z-10 w-3.5 h-3.5" strokeWidth={2.2} />
          </button>
        );
      })}
    </div>
  );
}
