import React from "react";
import { ArrowRight, Sparkles } from "lucide-react";

export function BeforeAfterPanel({ before, after }: { before: number; after: number }) {
  const beforeL = (before / 10000000).toFixed(2);
  const afterL = (after / 10000000).toFixed(2);

  return (
    <div className="bg-slate-950 text-white rounded-2xl p-8 relative overflow-hidden shadow-xl max-w-xl mx-auto border border-slate-800">
      <div className="absolute -top-12 -right-12 w-48 h-48 bg-indigo-550/20 bg-indigo-600/10 rounded-full blur-3xl" />
      <div className="flex justify-between items-center relative z-10">
        <div className="text-center flex-1">
          <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1.5">
            Committed Forecast
          </span>
          <span className="text-3xl font-black text-red-500">₹{beforeL}L</span>
          <span className="text-xs text-red-400 font-semibold block mt-1">High Cash Deficit</span>
        </div>

        <div className="flex flex-col items-center justify-center px-4">
          <ArrowRight className="w-8 h-8 text-indigo-500 animate-pulse" />
          <span className="text-[9px] text-indigo-400 uppercase tracking-widest font-black mt-1">
            Intervened
          </span>
        </div>

        <div className="text-center flex-1">
          <span className="text-[10px] uppercase tracking-widest text-indigo-400 font-bold block mb-1.5">
            Simulated Outlook
          </span>
          <span className="text-3xl font-black text-green-400">₹+{afterL}L</span>
          <span className="text-xs text-green-400 font-semibold block mt-1 flex items-center justify-center gap-1 font-bold">
            <Sparkles className="w-3.5 h-3.5 inline-block text-green-400 animate-spin" /> Runway Secured
          </span>
        </div>
      </div>
    </div>
  );
}
