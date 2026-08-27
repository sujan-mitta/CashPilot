/**
 * Theme control shared by the pre-hydration init script and the toggle.
 *
 * The CSS in globals.css resolves themes in this precedence:
 *   :root                                    -> light (default)
 *   @media dark :root:not([data-theme=light]) -> dark when the OS says so
 *   :root[data-theme="dark"|"light"]          -> an explicit choice wins
 *
 * So a stored preference is expressed by stamping data-theme on <html>; "system"
 * is the absence of that attribute. The value lives in localStorage so it is
 * per-browser and survives reloads.
 */

export type Theme = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "cashpilot-theme";

/**
 * Runs in <head> before first paint. Reads the stored preference and stamps
 * data-theme so a light-mode operator never sees the dark default flash. Kept
 * tiny and dependency-free because it is inlined as a string; wrapped in
 * try/catch because storage can throw in private mode.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}else{document.documentElement.removeAttribute('data-theme');}}catch(e){}})();`;

/** The stored preference, or "system" when none is set or storage is unavailable. */
export function getStoredTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_STORAGE_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

/** Persists a preference and applies it to <html> immediately. */
export function applyTheme(theme: Theme): void {
  try {
    if (theme === "system") {
      localStorage.removeItem(THEME_STORAGE_KEY);
      document.documentElement.removeAttribute("data-theme");
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
      document.documentElement.setAttribute("data-theme", theme);
    }
  } catch {
    // Storage blocked (private mode): still apply to the DOM for this session.
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  }
}

/** What the viewer is actually seeing right now, resolving "system". */
export function resolveEffectiveTheme(): "light" | "dark" {
  const stored = getStoredTheme();
  if (stored !== "system") return stored;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}
