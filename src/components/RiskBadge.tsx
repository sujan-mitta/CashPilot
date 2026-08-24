import React from "react";
import clsx from "clsx";

export function RiskBadge({ level }: { level: string }) {
  const isHigh = level === "HIGH";
  const isMedium = level === "MEDIUM";

  return (
    <span
      className={clsx(
        "inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider",
        {
          "bg-red-100 text-red-800 border border-red-200": isHigh,
          "bg-orange-100 text-orange-800 border border-orange-200": isMedium,
          "bg-green-100 text-green-800 border border-green-200": !isHigh && !isMedium,
        }
      )}
    >
      <span
        className={clsx("w-2 h-2 mr-1.5 rounded-full inline-block animate-pulse", {
          "bg-red-600": isHigh,
          "bg-orange-600": isMedium,
          "bg-green-600": !isHigh && !isMedium,
        })}
      />
      {level} RISK
    </span>
  );
}
