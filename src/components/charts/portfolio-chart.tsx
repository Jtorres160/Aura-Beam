"use client";

import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

interface PortfolioChartProps {
  data: { date: string; value: number }[];
  /** "building" until at least two real daily snapshots exist. */
  status?: "building" | "ready";
}

export function PortfolioChart({ data, status = "ready" }: PortfolioChartProps) {
  // A trend line needs at least two real recorded points. Rather than invent a
  // curve, we tell the user exactly what Aura is doing and when the chart fills.
  if (status === "building" || !data || data.length < 2) {
    return (
      <div className="h-[280px] w-full mt-2 flex flex-col items-center justify-center gap-2 text-center px-6">
        <p className="font-serif text-base text-foreground">Building your value history</p>
        <p className="text-sm text-muted-foreground max-w-xs">
          Aura records your collection&rsquo;s total value once a day. Your trend
          line appears here after a couple of days of tracking.
        </p>
      </div>
    );
  }

  return (
    <div className="h-[280px] w-full mt-2">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="auraGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.3} />
              <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="date"
            axisLine={false}
            tickLine={false}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
            dy={10}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
            tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`}
          />
          <Tooltip
            contentStyle={{
              background: "hsl(var(--card))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "12px",
              padding: "10px 14px",
              boxShadow: "0 8px 30px -6px rgba(0,0,0,0.3)",
            }}
            labelStyle={{ color: "hsl(var(--foreground))", fontWeight: 600, marginBottom: 4 }}
            itemStyle={{ color: "hsl(var(--muted-foreground))", fontSize: 13 }}
            formatter={(value) => [`$${Number(value).toLocaleString()}`, "Portfolio Value"]}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="var(--color-chart-1)"
            strokeWidth={2.5}
            fill="url(#auraGradient)"
            dot={false}
            activeDot={{ r: 5, fill: "var(--color-chart-1)", stroke: "hsl(var(--card))", strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
