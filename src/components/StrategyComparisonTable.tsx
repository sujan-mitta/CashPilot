import React from "react";
import { RiskBadge } from "./RiskBadge";
import { Strategy } from "@/context/CashPilotContext";

export function StrategyComparisonTable({ strategies }: { strategies: Strategy[] }) {
  const getStrategyDisplayName = (name: string) => {
    switch (name) {
      case "DO_NOTHING":
        return "Baseline (Do Nothing)";
      case "RECOVER_ONLY":
        return "From failed payments";
      case "RECOVER_AND_COLLECT":
        return "Recovery & Collections";
      case "FULL_INTERVENTION":
        return "Full Intervention";
      default:
        return name;
    }
  };

  return (
    <div className="overflow-hidden border border-line-soft rounded-md bg-ground-100">
      <table className="min-w-full divide-y divide-line-soft text-left text-sm text-ink-300">
        <thead className="bg-ground-200 font-semibold text-ink-200">
          <tr>
            <th className="px-6 py-4">Strategy</th>
            <th className="px-6 py-4">Projected Balance</th>
            <th className="px-6 py-4">Runway Crisis</th>
            <th className="px-6 py-4">Risk Level</th>
            <th className="px-6 py-4">Dynamic Score</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-faint font-medium">
          {strategies.map((s) => (
            <tr
              key={s.id}
              className={s.recommended ? "bg-brand-500/10 font-semibold text-ink-100" : ""}
            >
              <td className="px-6 py-4 flex items-center gap-1.5">
                {getStrategyDisplayName(s.name)}
                {s.recommended && (
                  <span className="bg-brand-500/15 text-brand-300 text-[11px] px-2 py-0.5 rounded font-bold">
                    Recommended
                  </span>
                )}
              </td>
              <td className="px-6 py-4">
                ₹{(s.result.projectedBalance / 10000000).toFixed(2)}L
              </td>
              <td className="px-6 py-4">
                {s.result.crisisDay ? (
                  <span className="text-risk-400 font-semibold">Day {s.result.crisisDay}</span>
                ) : (
                  <span className="text-safe-400">Resolved</span>
                )}
              </td>
              <td className="px-6 py-4">
                <RiskBadge level={s.result.riskLevel} />
              </td>
              <td className="px-6 py-4 text-ink-100 font-bold">{s.scoring.finalScore}/100</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
