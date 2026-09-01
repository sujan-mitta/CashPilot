"use client";

import React from "react";
import { CheckCircle2, AlertTriangle, ExternalLink, Clock } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";
import { formatINR, formatINRCompact } from "@/lib/format";
import clsx from "clsx";

/**
 * What has landed, whether it was enough, and what is left.
 *
 * An operator part-way through a recovery is asking three questions at once,
 * and the pages previously answered none of them: they knew only whether THIS
 * browser session had started an execution. A payment could settle, move the
 * cash and write the ledger event while the screen still said "Awaiting
 * Execution".
 *
 * Shared by the dashboard and the execution page. The dashboard matters more —
 * it is the first screen anyone opens, and it showed a gap to the safe minimum
 * without ever saying whether anything had been done about it.
 *
 * The arithmetic lives in `describeSafetyProgress`, tested, because it is easy
 * to get subtly wrong and invisible if buried in a component.
 */

export interface StandingData {
  currentCash: number;
  totalReceived: number;
  outstandingCount: number;
  received: Array<{ id: string; amount: number; description: string; settledAt: string }>;
  outstanding: Array<{
    id: string;
    amount: number;
    description: string;
    shortUrl: string | null;
    paymentLinkId: string | null;
  }>;
  progress: {
    status: "SAFE" | "SHORTFALL";
    projectedLow: number;
    safeFloor: number;
    recovered: number;
    outstanding: number;
    shortfall: number;
    outstandingCoversShortfall: boolean;
    stillNeededBeyondOutstanding: number;
    headline: string;
    detail: string;
  };
}

/**
 * Money that arrived AFTER the plan on screen was built.
 *
 * Exact, not a guess: a settlement timestamp later than the plan's creation
 * means the figures the plan was reasoned from no longer hold. Told this way
 * an operator can see the cause, rather than being handed a vague warning that
 * something is out of date.
 */
export function settlementsSincePlan(
  received: StandingData["received"],
  planCreatedAt: string | Date | null | undefined
): StandingData["received"] {
  if (!planCreatedAt) return [];
  const planTime = new Date(planCreatedAt).getTime();
  if (Number.isNaN(planTime)) return [];
  return received.filter((r) => {
    const t = new Date(r.settledAt).getTime();
    return !Number.isNaN(t) && t > planTime;
  });
}

export function WhereYouStand({
  data,
  planCreatedAt,
}: {
  data: StandingData | null;
  /** When the plan on screen was built, if this page is showing one. */
  planCreatedAt?: string | Date | null;
}) {
  if (!data?.progress) return null;

  const { progress, received, outstanding } = data;
  const safe = progress.status === "SAFE";
  const stalePayments = settlementsSincePlan(received, planCreatedAt);
  const staleTotal = stalePayments.reduce((sum, r) => sum + r.amount, 0);

  return (
    <div className="space-y-5">
      {/* THE PLAN IS OUT OF DATE.
          First, because it changes what everything below it means, and because
          approving a plan built on superseded figures is a real mistake rather
          than a cosmetic one. */}
      {stalePayments.length > 0 && (
        <Reveal>
          <div className="rounded-md border border-warn-500/30 bg-warn-500/[0.07] p-4 flex items-start gap-3">
            <Clock className="w-4 h-4 text-warn-400 shrink-0 mt-0.5" aria-hidden />
            <p className="text-[12.5px] text-warn-400 leading-relaxed">
              <strong className="font-semibold">This plan is out of date.</strong>{" "}
              <span title={formatINR(staleTotal)}>{formatINRCompact(staleTotal)}</span> arrived
              after it was built, so the figures behind it no longer hold. Start again from the
              dashboard for a plan based on what you actually have.
            </p>
          </div>
        </Reveal>
      )}

      {/* WHAT HAS ALREADY ARRIVED.
          Only when something has, so a business that has done nothing yet is
          not shown an empty "you have received nothing" box. */}
      {received.length > 0 && (
        <Reveal>
          <div className="rounded-md border border-safe-500/30 bg-safe-500/[0.07] p-5">
            <div className="flex items-start gap-3.5">
              <CheckCircle2 className="w-5 h-5 text-safe-400 shrink-0 mt-0.5" aria-hidden />
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-semibold text-ink-100">
                  {received.length === 1 ? "Payment received" : `${received.length} payments received`}
                </h2>
                <p className="text-ink-300 text-[13px] mt-1 leading-relaxed">
                  <strong className="text-safe-400 font-semibold" title={formatINR(data.totalReceived)}>
                    {formatINR(data.totalReceived)}
                  </strong>{" "}
                  has arrived and is already counted in your balance. You have{" "}
                  <strong className="text-ink-100 font-semibold">{formatINR(data.currentCash)}</strong>{" "}
                  in the bank now.
                </p>

                <ul className="mt-3.5 space-y-2">
                  {received.map((r) => (
                    <li
                      key={r.id}
                      className="flex items-center justify-between gap-4 text-[12.5px] border-t border-line-faint pt-2"
                    >
                      <span className="text-ink-300 truncate">{r.description}</span>
                      <span className="text-safe-400 font-semibold shrink-0">
                        + {formatINR(r.amount)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </Reveal>
      )}

      {/* WHERE THAT LEAVES YOU. */}
      <Reveal>
        <div
          className={clsx(
            "rounded-md border p-5",
            safe ? "border-safe-500/30 bg-safe-500/[0.07]" : "border-warn-500/30 bg-warn-500/[0.07]"
          )}
        >
          <div className="flex items-start gap-3.5">
            {safe ? (
              <CheckCircle2 className="w-5 h-5 text-safe-400 shrink-0 mt-0.5" aria-hidden />
            ) : (
              <AlertTriangle className="w-5 h-5 text-warn-400 shrink-0 mt-0.5" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <h2 className="text-[15px] font-semibold text-ink-100">{progress.headline}</h2>
              <p className="text-ink-300 text-[13px] mt-1 leading-relaxed">{progress.detail}</p>

              {/* The three figures the judgement rests on, so it can be checked
                  rather than taken on trust. Rounded for scanning — two amounts
                  a lakh apart are nearly identical at seven digits — with the
                  exact value on hover, because these are summaries and not
                  something anyone acts on directly. */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4 pt-4 border-t border-line-faint">
                <div>
                  <span className="text-ink-400 block text-[11px]">Lowest it will get</span>
                  <span
                    title={formatINR(progress.projectedLow)}
                    className={clsx(
                      "font-semibold text-sm",
                      progress.projectedLow < 0 ? "text-risk-400" : "text-ink-100"
                    )}
                  >
                    {formatINRCompact(progress.projectedLow)}
                  </span>
                </div>
                <div>
                  <span className="text-ink-400 block text-[11px]">Safe minimum to hold</span>
                  <span
                    title={formatINR(progress.safeFloor)}
                    className="font-semibold text-sm text-ink-100"
                  >
                    {formatINRCompact(progress.safeFloor)}
                  </span>
                </div>
                <div>
                  <span className="text-ink-400 block text-[11px]">
                    {safe ? "Clear by" : "Still short by"}
                  </span>
                  <span
                    title={formatINR(
                      safe ? progress.projectedLow - progress.safeFloor : progress.shortfall
                    )}
                    className={clsx(
                      "font-semibold text-sm",
                      safe ? "text-safe-400" : "text-warn-400"
                    )}
                  >
                    {formatINRCompact(
                      safe ? progress.projectedLow - progress.safeFloor : progress.shortfall
                    )}
                  </span>
                </div>
              </div>

              {/* WHAT IS STILL AVAILABLE.
                  Options, never instructions: which link to chase is a
                  judgement about the operator's own customer relationships, and
                  this product has no standing to make it for them. A business
                  already above its floor is shown none of this. */}
              {!safe && outstanding.length > 0 && (
                <div className="mt-4 pt-4 border-t border-line-faint">
                  <p className="text-[12px] font-semibold text-ink-200">Still waiting to be paid</p>
                  <ul className="mt-2.5 space-y-2">
                    {outstanding.map((o) => (
                      <li key={o.id} className="flex items-center justify-between gap-4 text-[12.5px]">
                        <span className="text-ink-300 truncate">{o.description}</span>
                        <span className="flex items-center gap-3 shrink-0">
                          <span className="text-ink-100 font-semibold">{formatINR(o.amount)}</span>
                          {o.shortUrl && (
                            <a
                              href={o.shortUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-brand-300 hover:text-brand-400 font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ground-050 rounded"
                            >
                              Open link <ExternalLink className="w-3 h-3" aria-hidden />
                            </a>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {!safe && progress.stillNeededBeyondOutstanding > 0 && (
                <p className="text-ink-400 text-[11.5px] mt-3.5 leading-relaxed">
                  Even if every link above is paid you would still be{" "}
                  <strong
                    className="text-warn-400 font-semibold"
                    title={formatINR(progress.stillNeededBeyondOutstanding)}
                  >
                    {formatINRCompact(progress.stillNeededBeyondOutstanding)}
                  </strong>{" "}
                  short. Start again from the dashboard to build a plan from your current figures
                  and see the other options.
                </p>
              )}
            </div>
          </div>
        </div>
      </Reveal>
    </div>
  );
}
