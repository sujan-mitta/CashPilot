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
      <div className="h-[280px] skeleton rounded-2xl border border-line-faint flex items-center justify-center text-ink-400 text-xs font-semibold">
        Constructing runway timeline comparison...
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
      <AreaChart data={formattedData} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="#eef0f5" strokeDasharray="4 4" />
        <XAxis
          dataKey="dateStr"
          tick={{ fill: "#94a3b8", fontSize: 11, fontWeight: 600 }}
          axisLine={false}
          tickLine={false}
          tickMargin={10}
        />
        <YAxis
          tickFormatter={(v) => `₹${(v / 100000).toFixed(1)}L`}
          tick={{ fill: "#94a3b8", fontSize: 11, fontWeight: 600 }}
          axisLine={false}
          tickLine={false}
          width={56}
        />
        <Tooltip
          formatter={(v, name) => [
            `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`,
            name === "balance" ? "Selected Strategy" : "Baseline (Do Nothing)"
          ]}
          labelStyle={{ fontWeight: 700, color: "#0f172a", marginBottom: 4 }}
          contentStyle={{
            borderRadius: 14,
            border: "1px solid #e2e8f0",
            boxShadow: "0 12px 24px -8px rgb(15 23 42 / 0.16)",
            fontSize: 12,
            fontWeight: 600,
            padding: "10px 14px",
          }}
          cursor={{ stroke: "#c7d2fe", strokeWidth: 1.5, strokeDasharray: "3 3" }}
        />
        {/* Deficit reference line */}
        <ReferenceLine
          y={0}
          stroke="#f87171"
          strokeDasharray="4 4"
          label={{ value: "Deficit Line", fill: "#ef4444", fontSize: 10, fontWeight: 700, position: "top" }}
        />
        {/* Safety threshold reference line. Drawn from this business's own
            adaptive buffer; a fixed ₹2.5L line was previously drawn for every
            business regardless of their actual requirement. */}
        {typeof safetyThreshold === "number" && (
          <ReferenceLine
            y={safetyThreshold / 100}
            stroke="#a5b4fc"
            strokeDasharray="3 3"
            label={{
              value: `Safety (${formatLakhs(safetyThreshold)})`,
              fill: "#818cf8",
              fontSize: 10,
              fontWeight: 700,
              position: "insideTopRight",
            }}
          />
        )}

        {/* Baseline curve (Rendered behind) */}
        {baselineData && (
          <Area
            type="monotone"
            dataKey="baseline"
            stroke="#f87171"
            strokeWidth={1.5}
            strokeDasharray="5 5"
            fill="url(#colorBaseline)"
            name="baseline"
            animationDuration={900}
            animationEasing="ease-out"
          />
        )}

        {/* Selected Strategy curve */}
        <Area
          type="monotone"
          dataKey="balance"
          stroke="#4f46e5"
          strokeWidth={2.5}
          fill="url(#colorBalance)"
          name="balance"
          animationDuration={900}
          animationEasing="ease-out"
          dot={{ r: 0 }}
          activeDot={{ r: 5, fill: "#4f46e5", stroke: "#fff", strokeWidth: 2 }}
        />

        <defs>
          <linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.28} />
            <stop offset="95%" stopColor="#4f46e5" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="colorBaseline" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#ef4444" stopOpacity={0.06} />
            <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
          </linearGradient>
        </defs>
      </AreaChart>
    </ResponsiveContainer>
  );
}
