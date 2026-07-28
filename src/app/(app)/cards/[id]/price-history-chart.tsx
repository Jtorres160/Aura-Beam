"use client";

// ─── Price history — recorded snapshots, and nothing else ───────────────────
// Every point on this chart is a row in price_history, written by the price
// refresh job when a real quote came back. There is no interpolation across
// gaps (missing stretches break the line rather than being drawn through), no
// synthesized starting value, and no trend line. A card with fewer than two
// recorded prices gets an explicit "not enough history yet" state — a flat line
// through one point would look like a measurement of stability we never made.
//
// Snapshots whose stored price is 0 are treated as no-data, per the disclosed
// convention in lib/cards/market-price.ts: those rows predate the null fix and
// recorded a silence, not a $0.00 valuation.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { displayMarketPrice, formatMarketPrice } from "@/lib/cards/market-price";

export interface PriceHistoryPoint {
  marketPrice: number | null;
  recordedAt: string;
}

interface Plotted {
  x: number;
  y: number;
  value: number;
  at: Date;
}

const HEIGHT = 200;
const PAD = { top: 16, right: 16, bottom: 24, left: 16 };

const shortDate = (d: Date) =>
  d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function PriceHistoryChart({ points }: { points: PriceHistoryPoint[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  // The plot needs real pixel geometry (a scaled viewBox would distort the
  // stroke and make hover coordinates lie), so measure the container.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  // Only snapshots that actually recorded a price are plottable.
  const recorded = useMemo(
    () =>
      points
        .map((p) => ({ value: displayMarketPrice(p.marketPrice), at: new Date(p.recordedAt) }))
        .filter((p) => p.value !== null && !Number.isNaN(p.at.getTime())),
    [points],
  );

  const geometry = useMemo(() => {
    if (width <= 0 || recorded.length < 2) return null;

    const values = recorded.map((p) => p.value as number);
    const times = recorded.map((p) => p.at.getTime());
    const minV = Math.min(...values);
    const maxV = Math.max(...values);
    const minT = Math.min(...times);
    const maxT = Math.max(...times);
    // A perfectly flat series still needs a band to draw in; centre it.
    const spanV = maxV - minV || Math.max(maxV * 0.1, 1);
    const spanT = maxT - minT || 1;
    const plotW = Math.max(width - PAD.left - PAD.right, 1);
    const plotH = HEIGHT - PAD.top - PAD.bottom;

    const all: Plotted[] = recorded.map((p) => ({
      x: PAD.left + ((p.at.getTime() - minT) / spanT) * plotW,
      y:
        PAD.top +
        plotH -
        (((p.value as number) - (maxV === minV ? minV - spanV / 2 : minV)) / spanV) * plotH,
      value: p.value as number,
      at: p.at,
    }));

    // Break the line wherever the recording gap is far larger than the typical
    // one — an unbroken stroke across a two-week silence would assert prices we
    // never observed. "Far larger" = 3× the median interval.
    const gaps = all.slice(1).map((p, i) => p.at.getTime() - all[i].at.getTime());
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 1;
    const segments: Plotted[][] = [[all[0]]];
    all.slice(1).forEach((p, i) => {
      if (gaps[i] > median * 3) segments.push([p]);
      else segments[segments.length - 1].push(p);
    });

    return { all, segments, minV, maxV, plotW };
  }, [recorded, width]);

  const onPointer = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!geometry) return;
      const box = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - box.left;
      let nearest = 0;
      for (let i = 1; i < geometry.all.length; i++) {
        if (Math.abs(geometry.all[i].x - x) < Math.abs(geometry.all[nearest].x - x)) nearest = i;
      }
      setHover(nearest);
    },
    [geometry],
  );

  // ── Not enough recorded history to plot ──────────────────────────────────
  if (recorded.length < 2) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card/40 p-6 text-center">
        <p className="font-serif text-base text-foreground">Not enough price history yet</p>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {recorded.length === 0
            ? "Aura has not recorded a price for this card yet."
            : "Aura has recorded one price for this card so far."}{" "}
          A snapshot is stored each time the price refresh returns a real quote — the
          chart appears once there are at least two.
        </p>
      </div>
    );
  }

  const active = hover !== null && geometry ? geometry.all[hover] : null;
  const first = recorded[0];
  const last = recorded[recorded.length - 1];
  const change = (last.value as number) - (first.value as number);
  const changePct = ((change / (first.value as number)) * 100).toFixed(1);

  return (
    <div>
      {/* Change is computed from two real recorded snapshots and states which
          ones — it is a measured difference, not a projection or a trend. */}
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          {recorded.length} recorded snapshots · {shortDate(first.at)} – {shortDate(last.at)}
        </p>
        <p className="font-mono text-xs text-muted-foreground">
          <span className="text-foreground">
            {change >= 0 ? "+" : "−"}
            {formatMarketPrice(Math.abs(change)) ?? "$0.00"}
          </span>{" "}
          ({change >= 0 ? "+" : "−"}
          {Math.abs(Number(changePct))}%) since first snapshot
        </p>
      </div>

      <div ref={wrapRef} className="relative w-full">
        {geometry && (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`Recorded market price from ${shortDate(first.at)} to ${shortDate(last.at)}, ${formatMarketPrice(first.value)} to ${formatMarketPrice(last.value)}`}
            className="touch-none select-none overflow-visible"
            onPointerMove={onPointer}
            onPointerLeave={() => setHover(null)}
          >
            {/* Recessive baseline rails at the observed extremes */}
            {[geometry.minV, geometry.maxV].map((v, i) => {
              const y = i === 0 ? HEIGHT - PAD.bottom : PAD.top;
              return (
                <g key={v}>
                  <line
                    x1={PAD.left}
                    x2={width - PAD.right}
                    y1={y}
                    y2={y}
                    stroke="var(--border)"
                    strokeWidth={1}
                  />
                  <text
                    x={PAD.left}
                    y={i === 0 ? y + 15 : y - 6}
                    className="fill-muted-foreground font-mono"
                    fontSize={10}
                  >
                    {formatMarketPrice(v)}
                  </text>
                </g>
              );
            })}

            {geometry.segments.map((seg, i) =>
              seg.length === 1 ? (
                // An isolated snapshot is a dot, not a line — one observation
                // does not describe a movement.
                <circle key={i} cx={seg[0].x} cy={seg[0].y} r={2.5} fill="var(--chart-1)" />
              ) : (
                <polyline
                  key={i}
                  points={seg.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke="var(--chart-1)"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ),
            )}

            {/* Direct label on the latest point only — never a number per point */}
            <circle
              cx={geometry.all[geometry.all.length - 1].x}
              cy={geometry.all[geometry.all.length - 1].y}
              r={4}
              fill="var(--chart-1)"
              stroke="var(--card)"
              strokeWidth={2}
            />

            {active && (
              <g>
                <line
                  x1={active.x}
                  x2={active.x}
                  y1={PAD.top}
                  y2={HEIGHT - PAD.bottom}
                  stroke="var(--border)"
                  strokeWidth={1}
                />
                <circle
                  cx={active.x}
                  cy={active.y}
                  r={5}
                  fill="var(--chart-1)"
                  stroke="var(--card)"
                  strokeWidth={2}
                />
              </g>
            )}
          </svg>
        )}

        {active && (
          <div
            className="pointer-events-none absolute -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 shadow-lg"
            style={{
              left: Math.min(Math.max(active.x, 56), Math.max(width - 56, 56)),
              top: Math.max(active.y - 52, 0),
            }}
          >
            <p className="font-mono text-sm text-popover-foreground">
              {formatMarketPrice(active.value)}
            </p>
            <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {shortDate(active.at)}
            </p>
          </div>
        )}
      </div>

      {/* Identity is never color-alone: the same series is readable as a table. */}
      <details className="mt-3">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground">
          View recorded values
        </summary>
        <table className="mt-2 w-full font-mono text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th scope="col" className="py-1 text-left font-normal">Recorded</th>
              <th scope="col" className="py-1 text-right font-normal">Market</th>
            </tr>
          </thead>
          <tbody>
            {[...recorded].reverse().map((p) => (
              <tr key={p.at.toISOString()} className="border-t border-border">
                <td className="py-1">{p.at.toLocaleDateString()}</td>
                <td className="py-1 text-right">{formatMarketPrice(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
