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

/**
 * A short, scannable amount for summaries: ₹2.81L, ₹1.2Cr.
 *
 * Two figures like ₹2,81,428 and ₹3,21,428 differ by a lakh, and at a glance
 * they are nearly indistinguishable — the eye has to parse seven digits and two
 * separators before the difference appears. Rounded, the same comparison is
 * immediate.
 *
 * DELIBERATELY NOT FOR ANYTHING ACTED ON. A rounded figure is a lie by a small
 * margin, which is fine for "roughly where do I stand" and unacceptable for a
 * payment amount, an invoice total, or anything reconciled against a provider.
 * Use `formatINR` there. Callers pair this with the exact value in a title
 * attribute so the precise number is always one hover away.
 *
 * Indian units, because the whole product is denominated in rupees and
 * lakh/crore is how the amounts are read aloud by the people using it.
 */
export function formatINRCompact(paise: number): string {
  const rupees = paise / 100;
  const abs = Math.abs(rupees);
  const sign = rupees < 0 ? "-" : "";

  // Below a lakh, plain grouping is already short enough and rounding would
  // discard meaningful precision on amounts people track to the rupee.
  if (abs < 100_000) return formatINR(paise);

  if (abs < 10_000_000) {
    const lakhs = abs / 100_000;
    return `₹${sign}${trimZero(lakhs)}L`;
  }

  const crores = abs / 10_000_000;
  return `₹${sign}${trimZero(crores)}Cr`;
}

/** 2.80 -> "2.8", 3.00 -> "3". A trailing zero adds width and no information. */
function trimZero(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}
