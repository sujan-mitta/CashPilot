/**
 * Shared formatting helpers. Every screen in the app was previously carrying
 * its own copy of `formatINR`; centralising it keeps the number formatting
 * (and any future currency/locale change) consistent everywhere.
 */

/** Formats an integer amount of paise as an Indian Rupee string, e.g. -420000 -> "₹-4,200". */
export function formatINR(paise: number): string {
  const rupees = paise / 100;
  const isNegative = rupees < 0;
  const formatted = Math.abs(rupees).toLocaleString("en-IN", {
    maximumFractionDigits: 0,
  });
  return isNegative ? `₹-${formatted}` : `₹${formatted}`;
}

/** Formats an integer amount of paise in lakhs, e.g. 960000000 -> "₹9.60L". */
export function formatLakhs(paise: number): string {
  const lakhs = paise / 10000000;
  const sign = lakhs < 0 ? "-" : "";
  return `₹${sign}${Math.abs(lakhs).toFixed(2)}L`;
}

/** Formats an integer amount of paise in lakhs if >= 1L, otherwise in rupees. */
export function formatPaise(paise: number): string {
  if (Math.abs(paise) >= 10000000) return `₹${(paise / 10000000).toFixed(2)}L`;
  return `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(0)}%`;
}

export function formatShortDate(dateInput: string | Date): string {
  const d = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export function formatDateTime(dateInput: string | Date): string {
  const d = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function initialsOf(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}
