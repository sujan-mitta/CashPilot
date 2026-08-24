"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useMotionValue,
  useSpring,
  useTransform,
  useReducedMotion,
  type MotionValue,
} from "framer-motion";

/**
 * Pointer-driven interaction hooks.
 *
 * Every hook here checks `useReducedMotion()` and returns a neutral, inert
 * result when the operator has asked for reduced motion. That check lives
 * inside the hook rather than at each call site on purpose — a motion effect
 * that has to be remembered at twenty call sites will be forgotten at one.
 *
 * All of them drive `transform` and `opacity` only, so the compositor handles
 * them and nothing triggers layout during a pointer move.
 */

/* ────────────────────────────────────────────────────────────────────────
   TILT — a surface that turns to face the cursor.
   ──────────────────────────────────────────────────────────────────────── */

export interface TiltOptions {
  /** Max rotation in degrees at the edge of the element. Above ~14 it warps. */
  strength?: number;
  /** Push the element toward the viewer on hover, in px. */
  lift?: number;
  /** Invert the rotation, so the surface tips away from the cursor instead. */
  invert?: boolean;
}

export function useTilt<T extends HTMLElement = HTMLDivElement>({
  strength = 8,
  lift = 0,
  invert = false,
}: TiltOptions = {}) {
  const ref = useRef<T>(null);
  const reduced = useReducedMotion();

  // -0.5 … 0.5, the pointer's position within the element.
  const px = useMotionValue(0);
  const py = useMotionValue(0);

  const rx = useSpring(px, { stiffness: 150, damping: 18, mass: 0.6 });
  const ry = useSpring(py, { stiffness: 150, damping: 18, mass: 0.6 });

  const sign = invert ? -1 : 1;
  // Vertical pointer movement rotates about X; horizontal about Y.
  const rotateX = useTransform(ry, [-0.5, 0.5], [strength * sign, -strength * sign]);
  const rotateY = useTransform(rx, [-0.5, 0.5], [-strength * sign, strength * sign]);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<T>) => {
      if (reduced) return;
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      px.set((event.clientX - rect.left) / rect.width - 0.5);
      py.set((event.clientY - rect.top) / rect.height - 0.5);
    },
    [px, py, reduced]
  );

  const onPointerLeave = useCallback(() => {
    px.set(0);
    py.set(0);
  }, [px, py]);

  if (reduced) {
    return {
      ref,
      handlers: {},
      style: {},
      // Constant motion values, so a caller reading these still gets a
      // MotionValue and does not need a separate branch.
      rotateX: rx,
      rotateY: ry,
    };
  }

  return {
    ref,
    handlers: { onPointerMove, onPointerLeave },
    style: {
      rotateX,
      rotateY,
      transformStyle: "preserve-3d" as const,
      ...(lift ? { translateZ: lift } : {}),
    },
    rotateX,
    rotateY,
  };
}

/* ────────────────────────────────────────────────────────────────────────
   MAGNETIC — an element that leans toward the cursor as it approaches.
   ──────────────────────────────────────────────────────────────────────── */

export function useMagnetic<T extends HTMLElement = HTMLButtonElement>(pull = 0.28) {
  const ref = useRef<T>(null);
  const reduced = useReducedMotion();

  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const x = useSpring(mx, { stiffness: 260, damping: 22, mass: 0.5 });
  const y = useSpring(my, { stiffness: 260, damping: 22, mass: 0.5 });

  const onPointerMove = useCallback(
    (event: React.PointerEvent<T>) => {
      if (reduced) return;
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      mx.set((event.clientX - (rect.left + rect.width / 2)) * pull);
      my.set((event.clientY - (rect.top + rect.height / 2)) * pull);
    },
    [mx, my, pull, reduced]
  );

  const onPointerLeave = useCallback(() => {
    mx.set(0);
    my.set(0);
  }, [mx, my]);

  return {
    ref,
    handlers: reduced ? {} : { onPointerMove, onPointerLeave },
    style: reduced ? {} : { x, y },
  };
}

/* ────────────────────────────────────────────────────────────────────────
   SPOTLIGHT — a light that follows the cursor across a surface.
   Writes CSS custom properties rather than React state, so a pointer move
   never triggers a render.
   ──────────────────────────────────────────────────────────────────────── */

export function useSpotlight<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const reduced = useReducedMotion();

  const onPointerMove = useCallback((event: React.PointerEvent<T>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--spot-x", `${event.clientX - rect.left}px`);
    el.style.setProperty("--spot-y", `${event.clientY - rect.top}px`);
    el.style.setProperty("--spot-on", "1");
  }, []);

  const onPointerLeave = useCallback(() => {
    ref.current?.style.setProperty("--spot-on", "0");
  }, []);

  return {
    ref,
    handlers: reduced ? {} : { onPointerMove, onPointerLeave },
  };
}

/* ────────────────────────────────────────────────────────────────────────
   POINTER — normalised cursor position for the whole window.
   Used to parallax background layers against each other.
   ──────────────────────────────────────────────────────────────────────── */

export function usePointer(): { x: MotionValue<number>; y: MotionValue<number> } {
  const reduced = useReducedMotion();
  const raw = { x: useMotionValue(0), y: useMotionValue(0) };
  const x = useSpring(raw.x, { stiffness: 90, damping: 20, mass: 0.7 });
  const y = useSpring(raw.y, { stiffness: 90, damping: 20, mass: 0.7 });

  useEffect(() => {
    if (reduced) return;
    const onMove = (event: PointerEvent) => {
      raw.x.set(event.clientX / window.innerWidth - 0.5);
      raw.y.set(event.clientY / window.innerHeight - 0.5);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
    // raw.x / raw.y are stable MotionValues for the lifetime of the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  return { x, y };
}

/* ────────────────────────────────────────────────────────────────────────
   IN-VIEW — reveal on scroll, once.
   ──────────────────────────────────────────────────────────────────────── */

export function useInView<T extends HTMLElement = HTMLDivElement>(
  { threshold = 0.15, once = true }: { threshold?: number; once?: boolean } = {}
) {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // No IntersectionObserver (or a test environment): show the content rather
    // than leaving it permanently hidden.
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          if (once) observer.disconnect();
        } else if (!once) {
          setInView(false);
        }
      },
      { threshold, rootMargin: "0px 0px -8% 0px" }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold, once]);

  return { ref, inView };
}

/* ────────────────────────────────────────────────────────────────────────
   COUNT UP — animates a figure to a new value.
   ──────────────────────────────────────────────────────────────────────── */

export function useCountUp(value: number, duration = 900) {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const frameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (reduced || duration <= 0) {
      setDisplay(value);
      fromRef.current = value;
      return;
    }

    const from = fromRef.current;
    if (from === value) return;

    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      // easeOutExpo — fast then settling, which reads as a figure "landing".
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      setDisplay(from + (value - from) * eased);
      if (t < 1) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        fromRef.current = value;
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
      // Land on the target so an interrupted run never leaves a stale figure
      // on screen — a half-counted number is a wrong number.
      fromRef.current = value;
    };
  }, [value, duration, reduced]);

  return display;
}
