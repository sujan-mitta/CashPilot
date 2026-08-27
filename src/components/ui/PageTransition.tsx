"use client";

import React from "react";

/**
 * Routes no longer animate in.
 *
 * Every navigation used to fade and rise the whole page over 450ms. On a
 * five-step flow that is a delay paid on every click, and it is the thing that
 * made moving between screens feel like a presentation rather than an
 * application.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col flex-1">{children}</div>;
}
