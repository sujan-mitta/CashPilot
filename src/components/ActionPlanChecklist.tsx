import React from "react";

interface ActionItem {
  type: string;
  amount: number;
  label: string;
}

export function ActionPlanChecklist({ actions }: { actions: ActionItem[] }) {
  return (
    <div className="space-y-3 bg-ground-100 border border-line-soft p-5 rounded-md">
      <h3 className="text-xs font-bold text-ink-400 border-b border-line-faint pb-3 mb-4">
        Intervention Action Checklist
      </h3>
      <div className="space-y-2.5">
        {actions.map((action, idx) => (
          <div
            key={idx}
            className="flex justify-between items-center p-3.5 rounded-md bg-ground-200 border border-line-faint"
          >
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked
                disabled
                className="w-4.5 h-4.5 rounded border-line-firm text-brand-300 focus:ring-brand-500 cursor-not-allowed"
              />
              <span className="font-semibold text-ink-200 text-sm">{action.label}</span>
            </div>
            <span className="font-bold text-ink-100 text-sm">
              ₹{(action.amount / 10000000).toFixed(2)}L
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
