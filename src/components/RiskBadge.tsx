import React from "react";
import clsx from "clsx";

/**
 * Risk level as a pill.
 *
 * MEDIUM previously used Tailwind's `orange` palette, which was outside the
 * design system entirely — so when everything else moved to the dark ground it
 * kept rendering as a near-white light-theme badge. It uses the `warn` token
 * now, the same one every other "unresolved / caution" state uses.
 *
 * The dot does not pulse. A risk level is a STATE, not something in flight, and
 * the system reserves motion in the operator's peripheral vision for things
 * that are actually happening right now.
 */
export function RiskBadge({ level }: { level: string }) {
  const isHigh = level === "HIGH";
  const isMedium = level === "MEDIUM";

  return (
    <span
      className={clsx(
        "inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider",
        {
          "bg-risk-500/15 text-risk-400 border border-risk-500/25": isHigh,
          "bg-warn-500/15 text-warn-400 border border-warn-500/25": isMedium,
          "bg-safe-500/15 text-safe-400 border border-safe-500/25": !isHigh && !isMedium,
        }
      )}
    >
      <span
        aria-hidden
        className={clsx("w-2 h-2 mr-1.5 rounded-full inline-block", {
          "bg-risk-400": isHigh,
          "bg-warn-400": isMedium,
          "bg-safe-400": !isHigh && !isMedium,
        })}
      />
      {level} RISK
    </span>
  );
}
