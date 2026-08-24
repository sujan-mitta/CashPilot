import React from "react";

interface ActionItem {
  type: string;
  amount: number;
  label: string;
}

export function ActionPlanChecklist({ actions }: { actions: ActionItem[] }) {
  return (
    <div className="space-y-3 bg-white border border-slate-200 p-5 rounded-xl shadow-sm">
      <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100 pb-3 mb-4">
        Intervention Action Checklist
      </h3>
      <div className="space-y-2.5">
        {actions.map((action, idx) => (
          <div
            key={idx}
            className="flex justify-between items-center p-3.5 rounded-lg bg-slate-55 bg-slate-50 border border-slate-100"
          >
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked
                disabled
                className="w-4.5 h-4.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-not-allowed"
              />
              <span className="font-semibold text-slate-700 text-sm">{action.label}</span>
            </div>
            <span className="font-bold text-slate-900 text-sm">
              ₹{(action.amount / 10000000).toFixed(2)}L
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
