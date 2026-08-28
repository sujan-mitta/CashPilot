/**
 * Theme preference.
 *
 * Three states, not two. "system" is a real choice that must survive a reload:
 * it means "follow the OS", and it is represented by the ABSENCE of the
 * data-theme attribute so the `prefers-color-scheme` media query in globals.css
 * is what decides. An explicit light/dark stamps the attribute and wins over
 * the OS in both directions.
 */
export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "cashpilot_theme";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

/** Writes the preference to the document and to storage. */
export function applyTheme(pref: ThemePreference) {
  const root = document.documentElement;

  if (pref === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", pref);
  }

  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Private browsing or blocked storage. The theme still applies for this
    // page; it simply will not be remembered, which is the correct degradation.
  }
}

export function readStoredTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

/**
 * Runs before first paint, inlined into <head>.
 *
 * Without this the document renders once at the default (dark), then the React
 * tree mounts and corrects it — a white flash for every light-mode user on
 * every navigation. Deliberately dependency-free and synchronous; it must not
 * wait for hydration.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY
)});if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;
