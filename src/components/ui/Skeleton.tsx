import React from "react";
import clsx from "clsx";

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("skeleton", className)} aria-hidden />;
}

/**
 * Whole-page loading shell.
 *
 * Mirrors the real layout — nav bar, heading, tiles, then content blocks — so
 * the page does not visibly jump when data lands. A skeleton that does not
 * match what replaces it is worse than no skeleton.
 */
export function PageSkeleton({ blocks = 3 }: { blocks?: number }) {
  return (
    <div className="min-h-screen flex flex-col bg-ground-050" role="status" aria-label="Loading">
      <div className="glass border-b border-line-soft h-16 flex items-center justify-between px-6">
        <Skeleton className="h-6 w-32 rounded-lg" />
        <Skeleton className="h-6 w-24 rounded-lg" />
      </div>
      <main className="flex-1 max-w-6xl mx-auto px-6 py-12 w-full space-y-8">
        <Skeleton className="h-8 w-56 rounded-lg" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
        {Array.from({ length: blocks }).map((_, i) => (
          <Skeleton key={i} className="h-36 w-full rounded-2xl" />
        ))}
      </main>
      <span className="sr-only">Loading</span>
    </div>
  );
}
