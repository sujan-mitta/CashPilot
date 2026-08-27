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
    <div className="space-y-4 p-6 bg-ground-200 border border-line-soft rounded-md max-w-lg mx-auto">
      <div className="flex items-center justify-between border-b border-line-soft pb-3 mb-2">
        <span className="text-xs font-bold text-ink-400">
          CashPilot Checking your ledger
        </span>
        <span className="flex h-2 w-2 relative">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-brand-500"></span>
        </span>
      </div>

      <div className="space-y-3.5">
        {steps.map((step, idx) => {
          const isActive = idx === currentStepIndex;
          const isDone = idx < currentStepIndex;

          return (
            <div key={idx} className="flex items-center gap-3">
              {isDone ? (
                <CheckCircle2 className="w-5 h-5 text-safe-400 flex-shrink-0" />
              ) : isActive ? (
                <div className="w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
              ) : (
                <Circle className="w-5 h-5 text-ink-400 flex-shrink-0" />
              )}
              <span
                className={
                  isDone
                    ? "text-ink-300 font-semibold"
                    : isActive
                    ? "text-brand-300 font-bold"
                    : "text-ink-400 font-medium"
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
