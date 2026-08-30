"use client";

import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Scale } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { Reveal, Stagger, StaggerItem } from "@/components/ui/Reveal";
import { formatINR } from "@/lib/format";
import { errorMessage } from "@/lib/errors";

/**
 * Cross-source conflict review (spec §7).
 *
 * `brain:sync` could say "N source conflicts need a human decision" and nothing
 * more. This is what makes N inspectable.
 *
 * The screen has no resolve button, and that absence is the design. Resolving a
 * conflict means declaring one source authoritative over another about real
 * money, which §14 and §41 both place with a human — and there is nowhere yet to
 * record who decided, when, and why. A button that silently picked a side would
 * be worse than no button. So this shows the disagreement, shows what each
 * source actually said, and sends the operator to the underlying record.
 */

interface Observation {
  sourceType: string;
  sourceRecordId: string;
  amount: number | null;
  claimType: string;
  observedAt: string;
}

interface Contradiction {
  type: string;
  detail: string;
  sources: string[];
}

interface OpenConflict {
  subjectType: string;
  subjectId: string;
  state: string;
  question: string;
  amountDelta: number | null;
  agreedAmount: number | null;
  reason: string;
  contradictions: Contradiction[];
  observations: Observation[];
}

const STATE_TONE: Record<string, "danger" | "warning" | "unknown" | "neutral"> = {
  CONFLICT: "danger",
  MISSING: "warning",
  EXPIRED: "unknown",
  DUPLICATE: "neutral",
};

const STATE_MEANING: Record<string, string> = {
  CONFLICT: "Two sources disagree about an amount.",
  MISSING: "Something was expected and no authoritative source ever observed it.",
  EXPIRED: "A missed expectation that has aged past its policy.",
  DUPLICATE: "The same source record was presented more than once.",
};

export default function ConflictReview() {
  const [conflicts, setConflicts] = useState<OpenConflict[]>([]);
  const [byState, setByState] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Bumped to retry. Every setState below happens AFTER an await, so none runs
  // synchronously inside the effect — and the cancelled flag stops a response
  // that arrives after unmount from writing into a dead component.
  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/conflicts");
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Could not load conflicts.");
        }
        const body = await res.json();
        if (cancelled) return;
        setConflicts(Array.isArray(body.conflicts) ? body.conflicts : []);
        setByState(body.byState ?? {});
        setLoadError(null);
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <main className="flex-1 max-w-4xl mx-auto px-6 py-10 w-full space-y-8">
      <Reveal>
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="label">Source review</span>
            <h1 className="text-2xl font-semibold text-ink-100 tracking-[-0.03em] mt-1.5">
              Where your sources disagree
            </h1>
            <p className="text-ink-300 text-[13.5px] mt-2 max-w-2xl leading-relaxed">
              Nothing here has been resolved. CashPilot never picks a side between two
              sources that disagree about an amount — deciding which one is right means
              declaring a source authoritative, and that is a judgement about your own
              records, not one a forecast should make for you.
            </p>
          </div>
          <Scale className="w-5 h-5 text-ink-400 shrink-0 mt-1" aria-hidden />
        </div>
      </Reveal>

      {!loading && !loadError && Object.keys(byState).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(byState).map(([state, n]) => (
            <Badge key={state} tone={STATE_TONE[state] ?? "neutral"}>
              {n} {state.toLowerCase()}
            </Badge>
          ))}
        </div>
      )}

      {loading && (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full rounded-2xl" />
          <Skeleton className="h-32 w-full rounded-2xl" />
        </div>
      )}

      {!loading && loadError && (
        <Card tone="risk" padding="md">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-risk-400 shrink-0 mt-0.5" aria-hidden />
            <div>
              <h2 className="text-[14px] font-semibold text-ink-100">Could not load conflicts</h2>
              <p className="text-[12.5px] text-ink-300 mt-1">{loadError}</p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={load}>
                Try again
              </Button>
            </div>
          </div>
        </Card>
      )}

      {!loading && !loadError && conflicts.length === 0 && (
        <Card padding="lg">
          <div className="text-center py-4">
            <Check className="w-5 h-5 text-safe-400 mx-auto" aria-hidden />
            <h2 className="text-[15px] font-semibold text-ink-100 mt-3">
              No open disagreements
            </h2>
            <p className="text-[12.5px] text-ink-400 mt-1.5 max-w-md mx-auto leading-relaxed">
              Every subject your sources have both spoken about agrees, or has only one
              source to go on. This does not mean the figures are right — only that
              nothing contradicts them.
            </p>
          </div>
        </Card>
      )}

      {!loading && !loadError && conflicts.length > 0 && (
        <Stagger className="space-y-4" stagger={0.05}>
          {conflicts.map((c) => (
            <StaggerItem key={`${c.subjectType}:${c.subjectId}`}>
              <Card padding="md" className="space-y-4">
                <CardHeader
                  label={`${c.subjectType.toLowerCase()} · ${c.subjectId}`}
                  title={STATE_MEANING[c.state] ?? c.state}
                  trailing={<Badge tone={STATE_TONE[c.state] ?? "neutral"}>{c.state}</Badge>}
                />

                <p className="text-[12.5px] text-ink-300 leading-relaxed">{c.reason}</p>

                {/* What each source actually said. A verdict without the
                    underlying statements is just another opinion to trust. */}
                <div>
                  <span className="label block mb-2">What each source says</span>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[12.5px]">
                      <thead>
                        <tr className="text-ink-400">
                          <th className="text-left font-medium pb-1.5 pr-4">Source</th>
                          <th className="text-right font-medium pb-1.5 pr-4">Amount</th>
                          <th className="text-left font-medium pb-1.5 pr-4">Kind</th>
                          <th className="text-left font-medium pb-1.5">Observed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.observations.map((o) => (
                          <tr key={`${o.sourceType}:${o.sourceRecordId}`} className="text-ink-200">
                            <td className="py-1.5 pr-4 font-medium">{o.sourceType}</td>
                            <td className="py-1.5 pr-4 text-right numeric">
                              {o.amount === null ? (
                                <span className="text-ink-400">no amount</span>
                              ) : (
                                formatINR(o.amount)
                              )}
                            </td>
                            <td className="py-1.5 pr-4 text-ink-300">{o.claimType}</td>
                            <td className="py-1.5 text-ink-400">
                              {new Date(o.observedAt).toLocaleDateString("en-IN")}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {c.amountDelta !== null && c.amountDelta > 0 && (
                  <div className="rounded-lg bg-risk-500/10 border border-risk-500/25 px-3.5 py-2.5">
                    <span className="label block mb-0.5">Gap between sources</span>
                    <span className="numeric text-[15px] font-semibold text-risk-400">
                      {formatINR(c.amountDelta)}
                    </span>
                  </div>
                )}

                {c.contradictions.length > 0 && (
                  <div>
                    <span className="label block mb-1.5">Detail</span>
                    <ul className="space-y-1">
                      {c.contradictions.map((x, i) => (
                        <li key={i} className="text-[12.5px] text-ink-300 leading-relaxed">
                          · {x.detail}
                          {x.sources.length > 0 && (
                            <span className="text-ink-400"> ({x.sources.join(" vs ")})</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <p className="text-[11.5px] text-ink-400 leading-relaxed">
                  To settle this, correct the record at the source that is wrong. CashPilot
                  will pick the change up on its next sync — it will not overwrite one
                  source with another on your behalf.
                </p>
              </Card>
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </main>
  );
}
