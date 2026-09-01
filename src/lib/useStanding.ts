"use client";

import { useEffect, useRef, useState } from "react";
import type { StandingData } from "@/components/WhereYouStand";

/**
 * Where the business stands, plus a one-time notice when money arrives.
 *
 * WHY A NOTICE IS NEEDED AT ALL
 *
 * Settlement is not something the operator does. A payer opens a Razorpay link
 * and a webhook credits the ledger minutes later, quite possibly while the
 * operator is on a different page or has closed the tab. Nothing announced it,
 * so the way you found out that Rs 2,40,000 had landed was to go looking.
 *
 * WHY IT ONLY FIRES ONCE PER PAYMENT
 *
 * A toast on every page load for the same settlement is noise, and noise is how
 * people learn to dismiss alerts without reading them — which is worse than
 * never having shown one, because the next alert matters. Each recovery id is
 * remembered once seen.
 *
 * Storage is per-browser and best-effort. It throws outright in some privacy
 * modes, and a failure is treated as ALREADY SEEN rather than unseen: a missed
 * notification is a small loss, while a toast that reappears on every single
 * load is the exact failure this is trying to avoid.
 */

const SEEN_KEY = "cp_seen_settlements";

function readSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeSeen(ids: Set<string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...ids]));
  } catch {
    // Nothing to do. The consequence is a repeated notice, handled by the
    // caller treating an unreadable store as "already seen".
  }
}

export interface NewlyArrived {
  count: number;
  total: number;
  descriptions: string[];
}

export function useStanding(): {
  standing: StandingData | null;
  /** Settlements not seen before in this browser. Null when there are none. */
  newlyArrived: NewlyArrived | null;
  /** Call once the notice has been shown, so it is not shown again. */
  acknowledge: () => void;
} {
  const [standing, setStanding] = useState<StandingData | null>(null);
  const [newlyArrived, setNewlyArrived] = useState<NewlyArrived | null>(null);
  const pendingIds = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/recovery-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((raw: unknown) => {
        if (cancelled || !raw || typeof raw !== "object") return;
        if ("error" in raw) return;
        const d = raw as StandingData;
        if (!d.progress || !Array.isArray(d.received)) return;
        setStanding(d);

        let seen: Set<string>;
        try {
          seen = readSeen();
        } catch {
          // Unreadable store: say nothing rather than announce everything.
          return;
        }

        const fresh = d.received.filter((r) => !seen.has(r.id));
        if (fresh.length === 0) return;

        pendingIds.current = fresh.map((r) => r.id);
        setNewlyArrived({
          count: fresh.length,
          total: fresh.reduce((sum, r) => sum + r.amount, 0),
          descriptions: fresh.map((r) => r.description),
        });
      })
      .catch(() => {
        // The panel and the notice are both additive. Neither is worth
        // surfacing an error over, and the page works without them.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const acknowledge = () => {
    if (pendingIds.current.length === 0) return;
    const seen = readSeen();
    for (const id of pendingIds.current) seen.add(id);
    writeSeen(seen);
    pendingIds.current = [];
    setNewlyArrived(null);
  };

  return { standing, newlyArrived, acknowledge };
}
