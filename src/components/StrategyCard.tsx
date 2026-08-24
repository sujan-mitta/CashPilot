import React from "react";
import clsx from "clsx";
import { RiskBadge } from "./RiskBadge";
import { Strategy } from "@/context/CashPilotContext";

interface StrategyCardProps {
  strategy: Strategy;
  isSelected: boolean;
  onSelect: () => void;
}

export function StrategyCard({ strategy, isSelected, onSelect }: StrategyCardProps) {
  const formattedBalance = (strategy.result.projectedBalance / 10000000).toFixed(2);
  const formattedMinBalance = (strategy.result.minimumProjectedBalance / 10000000).toFixed(2);

  const getStrategyDisplayName = (name: string) => {
    switch (name) {
      case "DO_NOTHING":
        return "Baseline (Do Nothing)";
      case "RECOVER_ONLY":
        return "Failed Payment Recovery";
      case "RECOVER_AND_COLLECT":
        return "Recovery & Collection Acceleration";
      case "FULL_INTERVENTION":
        return "Full Liquidity Intervention";
      default:
        return name;
    }
  };

  return (
    <div
      onClick={onSelect}
      className={clsx(
        "cursor-pointer p-5 rounded-xl border-2 transition-all duration-200 bg-ground-100 relative hover:shadow-md",
        {
          "border-brand-500 shadow-md ring-2 ring-brand-500/25": isSelected,
          "border-line-soft hover:border-line-firm": !isSelected,
        }
      )}
    >
      {strategy.recommended && (
        <span className="absolute -top-3 left-4 bg-brand-500 text-white px-2.5 py-0.5 rounded-full text-xs font-semibold tracking-wider flex items-center shadow-sm">
          ⭐ RECOMMENDED CHOICE
        </span>
      )}

      <div className="flex justify-between items-start mb-3 mt-1">
        <div>
          <h3 className="font-bold text-ink-100 text-lg">
            {getStrategyDisplayName(strategy.name)}
          </h3>
          <p className="text-ink-300 text-xs mt-0.5">
            {strategy.actions.length} action{strategy.actions.length === 1 ? "" : "s"} simulated
          </p>
        </div>

        <div className="flex flex-col items-end">
          <span className="text-2xl font-black text-ink-100">
            {strategy.scoring.finalScore}
            <span className="text-xs text-ink-400 font-medium ml-0.5">/100</span>
          </span>
          <span className="text-[10px] text-ink-400 font-bold uppercase tracking-wider">Score</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mt-4 pt-4 border-t border-line-faint">
        <div>
          <span className="text-xs text-ink-400 block font-medium">Projected End Balance</span>
          <span
            className={clsx("text-lg font-bold", {
              "text-risk-400": strategy.result.projectedBalance < 0,
              "text-ink-100": strategy.result.projectedBalance >= 0,
            })}
          >
            ₹{formattedBalance}L
          </span>
        </div>

        <div>
          <span className="text-xs text-ink-400 block font-medium">Minimum Cash Position</span>
          <span
            className={clsx("text-lg font-bold", {
              "text-risk-400": strategy.result.minimumProjectedBalance < 0,
              "text-ink-100": strategy.result.minimumProjectedBalance >= 0,
            })}
          >
            ₹{formattedMinBalance}L
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between mt-4 pt-4 border-t border-line-faint">
        <RiskBadge level={strategy.result.riskLevel} />
        <span className="text-xs font-semibold text-ink-300">
          {strategy.result.crisisDay
            ? `Crisis Expected: Day ${strategy.result.crisisDay}`
            : "No Liquidity Crisis"}
        </span>
      </div>
    </div>
  );
}
