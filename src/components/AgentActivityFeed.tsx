"use client";

import React, { useEffect, useState } from "react";
import { CheckCircle2, Circle } from "lucide-react";

export function AgentActivityFeed({
  steps,
  onComplete,
}: {
  steps: string[];
  onComplete?: () => void;
}) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);

  useEffect(() => {
    if (currentStepIndex < steps.length) {
      const timer = setTimeout(() => {
        setCurrentStepIndex((prev) => prev + 1);
      }, 600); // transition step every 600ms
      return () => clearTimeout(timer);
    } else if (onComplete) {
      onComplete();
    }
  }, [currentStepIndex, steps.length, onComplete]);

  return (
    <div className="space-y-4 p-6 bg-slate-50 border border-slate-200 rounded-xl max-w-lg mx-auto shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-200 pb-3 mb-2">
        <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">
          CashPilot Ledger Diagnostics
        </span>
        <span className="flex h-2 w-2 relative">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-600"></span>
        </span>
      </div>

      <div className="space-y-3.5">
        {steps.map((step, idx) => {
          const isActive = idx === currentStepIndex;
          const isDone = idx < currentStepIndex;

          return (
            <div key={idx} className="flex items-center gap-3">
              {isDone ? (
                <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0" />
              ) : isActive ? (
                <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin flex-shrink-0" />
              ) : (
                <Circle className="w-5 h-5 text-slate-300 flex-shrink-0" />
              )}
              <span
                className={
                  isDone
                    ? "text-slate-600 font-semibold"
                    : isActive
                    ? "text-indigo-600 font-bold"
                    : "text-slate-400 font-medium"
                }
              >
                {step}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
