"use client";

import React, { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useReducedMotion } from "framer-motion";

/**
 * Gate in front of the WebGL scene.
 *
 * The 3D terrain is the one heavy thing on the site, so it is treated as an
 * enhancement that has to earn its place on each visit:
 *
 *   · loaded only in the browser, and only after the page is interactive, so
 *     it never delays first paint or blocks the main thread during hydration;
 *   · skipped entirely when the device reports no WebGL, when the OS asks for
 *     reduced motion, or on small screens where it would burn a phone battery
 *     to be mostly hidden behind text;
 *   · replaced by a static gradient in all of those cases, so the section is
 *     never empty.
 *
 * Nothing below the fold depends on it rendering.
 */

const RunwayTerrain = dynamic(() => import("./RunwayTerrain"), {
  ssr: false,
  loading: () => <StaticFallback />,
});

/** Painted stand-in. Same palette, no GPU. */
function StaticFallback() {
  return (
    <div
      aria-hidden
      className="absolute inset-0"
      style={{
        background: [
          "radial-gradient(38rem 22rem at 50% 78%, rgb(16 185 129 / 0.16), transparent 65%)",
          "radial-gradient(30rem 18rem at 26% 92%, rgb(244 63 94 / 0.12), transparent 62%)",
          "radial-gradient(46rem 26rem at 62% 100%, rgb(99 102 241 / 0.20), transparent 68%)",
        ].join(","),
      }}
    />
  );
}

function hasWebGL(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext("webgl2") || canvas.getContext("webgl"))
    );
  } catch {
    // Some privacy tooling throws rather than returning null.
    return false;
  }
}

export function HeroScene({ className }: { className?: string }) {
  const reduced = useReducedMotion();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (reduced) return;
    // Below this width the terrain sits almost entirely behind the headline.
    if (window.matchMedia("(max-width: 767px)").matches) return;
    if (!hasWebGL()) return;

    // Wait for an idle moment so the scene never competes with hydration.
    const idle =
      window.requestIdleCallback?.(() => setEnabled(true), { timeout: 1800 }) ??
      window.setTimeout(() => setEnabled(true), 380);

    return () => {
      if (window.cancelIdleCallback && typeof idle === "number") {
        window.cancelIdleCallback(idle);
      } else {
        clearTimeout(idle as number);
      }
    };
  }, [reduced]);

  return (
    <div className={className}>
      {enabled ? <RunwayTerrain className="absolute inset-0" /> : <StaticFallback />}
    </div>
  );
}
