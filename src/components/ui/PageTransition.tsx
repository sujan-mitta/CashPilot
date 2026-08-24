"use client";

import React from "react";
import { motion } from "framer-motion";
import { EASE_OUT_EXPO } from "./motion";

/**
 * Wraps a route's content so every navigation gets a consistent, gentle
 * enter transition. Used from `src/app/template.tsx`, which Next.js
 * re-mounts on every route change — that remount is what drives the
 * animation, no router event wiring required.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: EASE_OUT_EXPO }}
      className="flex flex-col flex-1"
    >
      {children}
    </motion.div>
  );
}
