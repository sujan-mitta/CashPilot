import type { Transition, Variants } from "framer-motion";

/**
 * Shared motion language for CashPilot. Keeping these in one place means every
 * page enters, staggers, and responds to touch the same way instead of each
 * screen inventing its own timing.
 */

export const EASE_OUT_EXPO: Transition["ease"] = [0.16, 1, 0.3, 1];
export const EASE_SPRING: Transition["ease"] = [0.34, 1.56, 0.64, 1];

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: EASE_OUT_EXPO },
  },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.4, ease: EASE_OUT_EXPO } },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.95 },
  show: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.35, ease: EASE_OUT_EXPO },
  },
};

/** Container that staggers its direct motion children in on mount. */
export const staggerContainer = (stagger = 0.07, delayChildren = 0): Variants => ({
  hidden: {},
  show: {
    transition: {
      staggerChildren: stagger,
      delayChildren,
    },
  },
});

export const staggerItem: Variants = fadeUp;

/** Standard spring used for buttons, toggles, and small interactive controls. */
export const tapSpring: Transition = { type: "spring", stiffness: 500, damping: 30 };

export const hoverLift = { y: -2 };
