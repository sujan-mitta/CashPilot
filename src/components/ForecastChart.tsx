"use client";

import React, { useSyncExternalStore } from "react";
import { formatLakhs } from "@/lib/format";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer, CartesianGrid } from "recharts";

/** Hydration never changes after it happens, so there is nothing to subscribe to. */
const subscribeToNothing = () => () => {};

/** One point on the runway line. Balances are in paise, as everywhere else. */
export interface ForecastPoint {
  date: string | Date;
  projectedBalance?: number;
  closingBalance?: number;
}

/**
 * Colours come from CSS custom properties rather than literals.
 *
 * recharts takes colours as props, not classes, so this file was missed when
 * every screen was converted to the dark palette — it kept drawing a white
 * tooltip with near-black text and a #eef0f5 grid on a near-black page.
 * `var()` resolves inside SVG paint attributes and inline styles alike, so the
 * chart now follows the active theme with no JavaScript theme awareness.
 */
const C = {
  grid: "var(--chart-grid)",
  axis: "var(--chart-axis)",
  line: "var(--chart-line)",
  lineFill: "var(--chart-line-fill)",
  baseline: "var(--chart-baseline)",
  cursor: "var(--chart-cursor)",
  dotRing: "var(--chart-dot-ring)",
  risk: "var(--risk-400)",
  brand: "var(--brand-400)",
} as const;

export function ForecastChart({
  data,
  baselineData,
  safetyThreshold,
}: {
  data: ForecastPoint[];
  baselineData?: ForecastPoint[];
  /** Adaptive safety buffer in paise for THIS business. */
  safetyThreshold?: number;
}) {
  // recharts measures the DOM, so the chart cannot be rendered on the server.
  // This reports false through hydration and true afterwards, which is the same
  // guard the mounted flag provided without the setState-in-effect cascade.
  const mounted = useSyncExternalStore(subscribeToNothing, () => true, () => false);

  if (!mounted) {
    return (
      <div className="h-[280px] skeleton rounded-md border border-line-faint flex items-center justify-center text-ink-400 text-xs font-medium">
        Drawing your cash timeline…
      </div>
    );
  }

  // Map data to coordinate date indices
  const formattedData = data.map((d, idx) => {
    const basePoint = baselineData?.[idx];
    const baseVal =
      basePoint?.projectedBalance !== undefined ? basePoint.projectedBalance / 100 : null;

    // Support both schema parameters (projectedBalance or closingBalance). A
    // point carrying neither previously produced `undefined / 100` -> NaN.
    // recharts already breaks the line at a NaN, so the chart LOOKED right;
    // the defect was the NaN sitting in the data, which anything else reading
    // it (tooltip, export, aggregation) would have had to cope with.
    const rawStrategy = d.projectedBalance ?? d.closingBalance;
    const strategyVal = rawStrategy !== undefined ? rawStrategy / 100 : null;

    return {
      dateStr: new Date(d.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
      balance: strategyVal,
      baseline: baseVal,
    };
  });

  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={formattedData} margin={{ top: 14, right: 10, left: 10, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={C.grid} strokeDasharray="4 4" />
        <XAxis
          dataKey="dateStr"
          tick={{ fill: C.axis, fontSize: 11, fontWeight: 500 }}
          axisLine={false}
          tickLine={false}
          tickMargin={10}
        />
        <YAxis
          tickFormatter={(v) => `₹${(v / 100000).toFixed(1)}L`}
          tick={{ fill: C.axis, fontSize: 11, fontWeight: 500 }}
          axisLine={false}
          tickLine={false}
          width={56}
        />
        <Tooltip
          formatter={(v, name) => [
            `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`,
            // Plain language: "baseline" is jargon for "if you do nothing".
            name === "balance" ? "With this plan" : "If you do nothing",
          ]}
          labelStyle={{
            fontWeight: 600,
            color: "var(--chart-tooltip-ink)",
            marginBottom: 4,
          }}
          itemStyle={{ color: "var(--ink-200)" }}
          contentStyle={{
            background: "var(--chart-tooltip-bg)",
            borderRadius: 14,
            border: "1px solid var(--chart-tooltip-line)",
            boxShadow: "var(--lift-3)",
            fontSize: 12,
            fontWeight: 500,
            padding: "10px 14px",
          }}
          cursor={{ stroke: C.cursor, strokeWidth: 1.5, strokeDasharray: "3 3" }}
        />
        {/* Deficit reference line — the point where the account runs dry. */}
        <ReferenceLine
          y={0}
          stroke={C.baseline}
          strokeDasharray="4 4"
          label={{
            value: "Out of cash",
            fill: C.risk,
            fontSize: 10,
            fontWeight: 600,
            position: "insideBottomRight",
          }}
        />
        {/* Safety threshold reference line. Drawn from this business's own
            adaptive buffer; a fixed ₹2.5L line was previously drawn for every
            business regardless of their actual requirement. */}
        {typeof safetyThreshold === "number" && (
          <ReferenceLine
            y={safetyThreshold / 100}
            stroke={C.brand}
            strokeDasharray="3 3"
            label={{
              value: `Safe minimum (${formatLakhs(safetyThreshold)})`,
              fill: C.brand,
              fontSize: 10,
              fontWeight: 600,
              // Anchored to the LEFT, while "Out of cash" is anchored to the
              // right. When the safety threshold sits close to the zero line the
              // two labels would otherwise stack on the same corner and overlap;
              // opposite corners keep them legible at any data range.
              position: "insideTopLeft",
            }}
          />
        )}

        {/* Baseline curve (Rendered behind) */}
        {baselineData && (
          <Area
            type="monotone"
            dataKey="baseline"
            stroke={C.baseline}
            strokeWidth={1.5}
            strokeDasharray="5 5"
            fill="url(#colorBaseline)"
            name="baseline"
            animationDuration={320}
            animationEasing="ease-out"
          />
        )}

        {/* Selected Strategy curve */}
        <Area
          type="monotone"
          dataKey="balance"
          stroke={C.line}
          strokeWidth={2.5}
          fill="url(#colorBalance)"
          name="balance"
          animationDuration={320}
          animationEasing="ease-out"
          dot={{ r: 0 }}
          activeDot={{ r: 5, fill: C.line, stroke: C.dotRing, strokeWidth: 2 }}
        />

        <defs>
          <linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={C.lineFill} stopOpacity={0.28} />
            <stop offset="95%" stopColor={C.lineFill} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="colorBaseline" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={C.baseline} stopOpacity={0.08} />
            <stop offset="95%" stopColor={C.baseline} stopOpacity={0} />
          </linearGradient>
        </defs>
      </AreaChart>
    </ResponsiveContainer>
  );
}
