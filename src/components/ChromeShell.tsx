"use client";

import React from "react";
import { usePathname } from "next/navigation";
import { Navbar } from "./Navbar";
import { PageTransition } from "./ui/PageTransition";

const NO_CHROME_EXACT = new Set(["/"]);
const NO_CHROME_PREFIXES = ["/login", "/auth", "/sandbox"];

const STEP_BY_PREFIX: [string, number][] = [
  ["/dashboard", 1],
  ["/investigation", 2],
  ["/strategies", 3],
  ["/approval", 4],
  ["/execution", 5],
];

function shouldHideChrome(pathname: string) {
  if (NO_CHROME_EXACT.has(pathname)) return true;
  return NO_CHROME_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function computeActiveStep(pathname: string): number {
  const match = STEP_BY_PREFIX.find(([prefix]) => pathname.startsWith(prefix));
  return match ? match[1] : 0;
}

/**
 * Owns the app chrome (the Navbar + its 5-step indicator) at the layout
 * level so it persists across navigations instead of remounting on every
 * page — that's what lets the step indicator animate smoothly between
 * steps, and what gives every route a consistent enter transition.
 * Auth/login/sandbox routes render full-bleed with no chrome at all.
 */
export function ChromeShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "";

  if (shouldHideChrome(pathname)) {
    return <>{children}</>;
  }

  return (
    <>
      <Navbar activeStep={computeActiveStep(pathname)} />
      <PageTransition key={pathname}>{children}</PageTransition>
    </>
  );
}
