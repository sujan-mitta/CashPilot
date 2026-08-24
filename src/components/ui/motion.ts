import type { Transition, Variants } from "framer-motion";

/**
 * The motion language.
 *
 * One vocabulary, defined once. The point is not that every animation is
 * identical — it is that when two things move differently, the difference
 * MEANS something. A panel entering and a number updating should not share a
 * curve, because they are not the same kind of event.
 *
 * Four families:
 *   SWIFT  — the operator did something and the UI is responding. Short, no
 *            overshoot. Overshoot on a confirmation reads as flippant.
 *   GLIDE  — content arriving. Decelerating, slightly longer, no bounce.
 *   SPRING — physical objects: toggles, cards meeting a cursor, drag. The only
 *            family allowed to overshoot.
 *   GRAVE  — irreversible financial actions. Deliberately slow. A dialog that
 *            asks "move ₹4,40,000?" should not pop in like a tooltip.
 */

export const EASE_SWIFT: Transition["ease"] = [0.32, 0.72, 0, 1];
export const EASE_GLIDE: Transition["ease"] = [0.16, 1, 0.3, 1];
export const EASE_SPRING_CURVE: Transition["ease"] = [0.34, 1.56, 0.64, 1];
export const EASE_IN_OUT: Transition["ease"] = [0.65, 0, 0.35, 1];

/** Retained under the old name so existing imports keep working. */
export const EASE_OUT_EXPO = EASE_GLIDE;
export const EASE_SPRING = EASE_SPRING_CURVE;

export const DUR = {
  instant: 0.09,
  fast: 0.16,
  base: 0.26,
  slow: 0.42,
  deliberate: 0.68,
} as const;

/* ── Springs ──────────────────────────────────────────────────────────────
   Named by feel, not by number, so call sites read as intent. */

/** Buttons, toggles, small controls. Crisp, settles fast. */
export const springSnappy: Transition = { type: "spring", stiffness: 500, damping: 30 };
/** Cards, panels, anything with visual mass. */
export const springSoft: Transition = { type: "spring", stiffness: 260, damping: 28 };
/** Cursor-following: tilt, magnetic pull. Low stiffness or it feels twitchy. */
export const springFollow: Transition = { type: "spring", stiffness: 150, damping: 18, mass: 0.6 };
/** Large surfaces — drawers, sheets. */
export const springHeavy: Transition = { type: "spring", stiffness: 180, damping: 30, mass: 1.1 };

export const tapSpring = springSnappy;

/* ── Enter variants ───────────────────────────────────────────────────── */

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: DUR.slow, ease: EASE_GLIDE } },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: DUR.base, ease: EASE_GLIDE } },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.95 },
  show: { opacity: 1, scale: 1, transition: { duration: DUR.base, ease: EASE_GLIDE } },
};

/** Enters from depth. Reserve for hero elements — it is a big gesture. */
export const riseFromDepth: Variants = {
  hidden: { opacity: 0, y: 44, scale: 0.94, rotateX: 9 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    rotateX: 0,
    transition: { duration: DUR.deliberate, ease: EASE_GLIDE },
  },
};

/**
 * Slides in from a side. Panels, drawers, list rows.
 *
 * Written as two explicit branches rather than a computed `[axis]` key: a
 * computed key widens the variant to a string index signature, which no longer
 * matches framer-motion's Target and silently loses type checking on the rest
 * of the object.
 */
export const slideFrom = (axis: "x" | "y", distance = 24): Variants =>
  axis === "x"
    ? {
        hidden: { opacity: 0, x: distance },
        show: { opacity: 1, x: 0, transition: { duration: DUR.slow, ease: EASE_GLIDE } },
      }
    : {
        hidden: { opacity: 0, y: distance },
        show: { opacity: 1, y: 0, transition: { duration: DUR.slow, ease: EASE_GLIDE } },
      };

/** Blur-in. Expensive to composite — hero text only, never in a list. */
export const focusIn: Variants = {
  hidden: { opacity: 0, filter: "blur(10px)", y: 10 },
  show: {
    opacity: 1,
    filter: "blur(0px)",
    y: 0,
    transition: { duration: DUR.deliberate, ease: EASE_GLIDE },
  },
};

/* ── Orchestration ────────────────────────────────────────────────────── */

export const staggerContainer = (stagger = 0.07, delayChildren = 0): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren: stagger, delayChildren } },
});

export const staggerItem: Variants = fadeUp;

/** Reveals children back-to-front, so a grid settles from the far corner. */
export const staggerReverse = (stagger = 0.06): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren: stagger, staggerDirection: -1 } },
});

/* ── Interaction states ───────────────────────────────────────────────── */

export const hoverLift = { y: -2 };
export const hoverLiftLarge = { y: -4, scale: 1.012 };
export const pressDown = { scale: 0.975 };

/* ── Exit ─────────────────────────────────────────────────────────────── */

export const fadeOutDown: Variants = {
  exit: { opacity: 0, y: -8, transition: { duration: DUR.fast, ease: EASE_SWIFT } },
};

/**
 * Modal + backdrop pair.
 *
 * `grave` slows the entrance for irreversible actions. The exit stays quick
 * either way: once the operator has decided, waiting on an animation is just
 * latency.
 */
export const modalVariants = (grave = false): Variants => ({
  hidden: { opacity: 0, scale: grave ? 0.97 : 0.94, y: grave ? 12 : 8 },
  show: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: grave
      ? { duration: DUR.deliberate, ease: EASE_GLIDE }
      : springSoft,
  },
  exit: { opacity: 0, scale: 0.97, y: 6, transition: { duration: DUR.fast, ease: EASE_SWIFT } },
});

export const backdropVariants: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: DUR.base, ease: EASE_SWIFT } },
  exit: { opacity: 0, transition: { duration: DUR.fast, ease: EASE_SWIFT } },
};
