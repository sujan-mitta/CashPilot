import React from "react";
import clsx from "clsx";

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("skeleton rounded-xl", className)} />;
}

/** Full-page skeleton shell shared by every screen's initial loading state. */
export function PageSkeleton({ blocks = 3 }: { blocks?: number }) {
  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <div className="bg-white border-b border-slate-200 h-16 flex items-center justify-between px-6">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-6 w-24" />
      </div>
      <main className="flex-1 max-w-5xl mx-auto px-6 py-10 w-full space-y-8">
        <Skeleton className="h-6 w-40" />
        {Array.from({ length: blocks }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </main>
    </div>
  );
}
