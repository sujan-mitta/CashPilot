"use client";

import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, ChevronRight, Users, X } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { Reveal, Stagger, StaggerItem } from "@/components/ui/Reveal";
import { errorMessage } from "@/lib/errors";

/**
 * Duplicate counterparty review (spec §6).
 *
 * The screen exists to slow one specific decision down. A wrong merge silently
 * attaches one customer's payment history to another, and the behaviour model
 * then makes confident predictions from fabricated history — there is no error
 * message for that, it just quietly produces worse forecasts forever.
 *
 * So the design is deliberately not a queue to be cleared. There is no
 * "approve all", no bulk selection and no default action. Each pair is one
 * question, its evidence is shown before its buttons, and the evidence says
 * plainly that the match is name-only.
 */

interface MergeSuggestion {
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  similarity: number;
  type: string;
  evidence: string[];
}

type RowState = "IDLE" | "MERGING" | "MERGED" | "DISMISSED" | "FAILED";

export default function CounterpartyReview() {
  const [suggestions, setSuggestions] = useState<MergeSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const keyOf = (s: MergeSuggestion) => `${s.sourceId}|${s.targetId}`;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/counterparties/merge");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Could not load duplicate suggestions.");
      }
      const body = await res.json();
      setSuggestions(Array.isArray(body.suggestions) ? body.suggestions : []);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const confirmMerge = async (s: MergeSuggestion) => {
    const key = keyOf(s);
    if (rowState[key] === "MERGING") return;

    setRowState((p) => ({ ...p, [key]: "MERGING" }));
    setRowError((p) => ({ ...p, [key]: "" }));

    try {
      const res = await fetch("/api/counterparties/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: s.sourceId, targetId: s.targetId }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) throw new Error(body.error || "The merge was not applied.");

      setRowState((p) => ({ ...p, [key]: "MERGED" }));
    } catch (err) {
      // The row stays on screen showing why. Removing it would look like the
      // merge succeeded.
      setRowState((p) => ({ ...p, [key]: "FAILED" }));
      setRowError((p) => ({ ...p, [key]: errorMessage(err) }));
    }
  };

  /**
   * Dismiss is local only, and says so.
   *
   * There is no "not a duplicate" record to write — suggestions are derived
   * from the current entity set on every request, so a dismissal cannot
   * persist. Pretending otherwise would be worse than admitting it: the pair
   * reappears next time, and an operator who was told it was dismissed would
   * stop trusting the screen.
   */
  const dismiss = (s: MergeSuggestion) =>
    setRowState((p) => ({ ...p, [keyOf(s)]: "DISMISSED" }));

  const open = suggestions.filter((s) => {
    const st = rowState[keyOf(s)];
    return st !== "MERGED" && st !== "DISMISSED";
  });

  return (
    <main className="flex-1 max-w-4xl mx-auto px-6 py-10 w-full space-y-8">
      <Reveal>
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="label">Entity review</span>
            <h1 className="text-2xl font-semibold text-ink-100 tracking-[-0.03em] mt-1.5">
              Possible duplicate counterparties
            </h1>
            <p className="text-ink-300 text-[13.5px] mt-2 max-w-2xl leading-relaxed">
              These pairs look like the same company recorded twice. Nothing here has
              been merged — CashPilot never merges a near-match on its own, because a
              wrong merge attaches one customer&apos;s payment history to another and
              nothing afterwards would look broken.
            </p>
          </div>
          <Users className="w-5 h-5 text-ink-400 shrink-0 mt-1" aria-hidden />
        </div>
      </Reveal>

      {loading && (
        <div className="space-y-4">
          <Skeleton className="h-28 w-full rounded-2xl" />
          <Skeleton className="h-28 w-full rounded-2xl" />
        </div>
      )}

      {!loading && loadError && (
        <Card tone="risk" padding="md">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-risk-400 shrink-0 mt-0.5" aria-hidden />
            <div>
              <h2 className="text-[14px] font-semibold text-ink-100">
                Could not load suggestions
              </h2>
              <p className="text-[12.5px] text-ink-300 mt-1">{loadError}</p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={load}>
                Try again
              </Button>
            </div>
          </div>
        </Card>
      )}

      {!loading && !loadError && open.length === 0 && (
        <Card padding="lg">
          <div className="text-center py-4">
            <Check className="w-5 h-5 text-safe-400 mx-auto" aria-hidden />
            <h2 className="text-[15px] font-semibold text-ink-100 mt-3">
              No duplicates to review
            </h2>
            <p className="text-[12.5px] text-ink-400 mt-1.5 max-w-md mx-auto leading-relaxed">
              Every counterparty is distinct under name matching. New ones are checked
              as they arrive.
            </p>
          </div>
        </Card>
      )}

      {!loading && !loadError && open.length > 0 && (
        <Stagger className="space-y-4" stagger={0.05}>
          {open.map((s) => {
            const key = keyOf(s);
            const state = rowState[key] ?? "IDLE";

            return (
              <StaggerItem key={key}>
                <Card padding="md" className="space-y-4">
                  <CardHeader
                    label={`${s.type.toLowerCase()} · ${Math.round(s.similarity * 100)}% name overlap`}
                    title="Are these the same company?"
                    trailing={
                      state === "FAILED" ? (
                        <Badge tone="danger">Not merged</Badge>
                      ) : (
                        <Badge tone="warning">Needs your decision</Badge>
                      )
                    }
                  />

                  {/* The two identities, with the survivor named explicitly.
                      "Merge" without saying which one disappears is not a
                      question anyone can answer safely. */}
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="rounded-lg border border-line-soft bg-ground-200 px-3.5 py-2.5 min-w-0">
                      <span className="label block mb-0.5">Would be absorbed</span>
                      <span className="text-[13.5px] text-ink-100 font-medium break-words">
                        {s.sourceName}
                      </span>
                    </div>
                    <ChevronRight className="w-4 h-4 text-ink-400 shrink-0" aria-hidden />
                    <div className="rounded-lg border border-brand-500/25 bg-brand-500/[0.07] px-3.5 py-2.5 min-w-0">
                      <span className="label block mb-0.5">Would survive</span>
                      <span className="text-[13.5px] text-ink-100 font-medium break-words">
                        {s.targetName}
                      </span>
                    </div>
                  </div>

                  <div>
                    <span className="label block mb-1.5">Why this was suggested</span>
                    <ul className="space-y-1">
                      {s.evidence.map((line, i) => (
                        <li key={i} className="text-[12.5px] text-ink-300 leading-relaxed">
                          · {line}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {state === "FAILED" && rowError[key] && (
                    <div
                      role="alert"
                      className="rounded-lg bg-risk-500/10 border border-risk-500/25 px-3.5 py-2.5"
                    >
                      <p className="text-[12.5px] text-risk-400">
                        {rowError[key]} Nothing was changed.
                      </p>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2.5 pt-1">
                    <Button
                      variant="primary"
                      size="sm"
                      loading={state === "MERGING"}
                      disabled={state === "MERGING"}
                      onClick={() => confirmMerge(s)}
                    >
                      {state === "MERGING" ? "Merging" : "Yes — merge them"}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={state === "MERGING"}
                      onClick={() => dismiss(s)}
                    >
                      <X className="w-3.5 h-3.5" aria-hidden />
                      Not the same
                    </Button>
                  </div>

                  <p className="text-[11.5px] text-ink-400 leading-relaxed">
                    Merging is not reversible from this screen. &ldquo;Not the same&rdquo;
                    only hides this pair until you reload — there is nowhere to record
                    that decision yet, so the pair will be suggested again.
                  </p>
                </Card>
              </StaggerItem>
            );
          })}
        </Stagger>
      )}
    </main>
  );
}
