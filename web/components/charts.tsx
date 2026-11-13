import React, { useState } from 'react';
import { money, monthLabel } from '../format.ts';

/** Donut chart of category totals (pence). */
export function Donut({ items, size = 180, thickness = 22, centre }: {
  items: { label: string; value: number; colour: string }[]; size?: number; thickness?: number; centre?: React.ReactNode;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const positive = items.filter((i) => i.value > 0);
  const total = positive.reduce((s, i) => s + i.value, 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const gap = positive.length > 1 ? 2 : 0;
  return (
    <div className="donut" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Spending by category">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--track)" strokeWidth={thickness} />
        {positive.map((item, i) => {
          const len = total ? (item.value / total) * c : 0;
          const el = (
            <circle key={item.label} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={item.colour}
              strokeWidth={hover === i ? thickness + 4 : thickness}
              strokeDasharray={`${Math.max(len - gap, 0.01)} ${c}`} strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              style={{ transition: 'stroke-width 120ms' }}>
              <title>{`${item.label}: ${money(item.value)}`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
      </svg>
      <div className="donut-centre">
        {hover !== null ? (
          <>
            <span className="donut-label">{positive[hover].label}</span>
            <span className="donut-value">{money(positive[hover].value)}</span>
            <span className="donut-label">{total ? Math.round((positive[hover].value / total) * 100) : 0}%</span>
          </>
        ) : centre}
      </div>
    </div>
  );
}

/** Paired bars: income vs spending per month. */
export function IncomeSpendBars({ data, height = 200 }: { data: { month: string; income: number; spending: number; saved?: number }[]; height?: number }) {
  const withSaved = data.some((d) => d.saved !== undefined);
  const max = Math.max(1, ...data.flatMap((d) => [d.income, d.spending, d.saved ?? 0]));
  const nice = niceMax(max);
  const ticks = [0, nice / 2, nice];
  const w = 100 / data.length;
  return (
    <div className="bars" style={{ height }}>
      <div className="bars-grid">
        {ticks.slice().reverse().map((t) => (
          <div key={t} className="bars-tick"><span>{money(t, { compact: true })}</span></div>
        ))}
      </div>
      <svg className="bars-svg" viewBox={`0 0 100 100`} preserveAspectRatio="none" role="img" aria-label="Income versus spending by month">
        {data.map((d, i) => {
          const x = i * w + (withSaved ? w * 0.14 : w * 0.2);
          const bw = withSaved ? w * 0.22 : w * 0.28;
          const gap = w * 0.03;
          const hi = (d.income / nice) * 100;
          const hs = (d.spending / nice) * 100;
          const hv = (Math.max(0, d.saved ?? 0) / nice) * 100;
          return (
            <g key={d.month}>
              <rect x={x} y={100 - hi} width={bw} height={hi} rx={0.8} className="bar-income"><title>{`${monthLabel(d.month)} income: ${money(d.income)}`}</title></rect>
              <rect x={x + bw + gap} y={100 - hs} width={bw} height={hs} rx={0.8} className="bar-spend"><title>{`${monthLabel(d.month)} spending: ${money(d.spending)}`}</title></rect>
              {withSaved && <rect x={x + 2 * (bw + gap)} y={100 - hv} width={bw} height={hv} rx={0.8} className="bar-saved"><title>{`${monthLabel(d.month)} saved: ${money(d.saved ?? 0)}`}</title></rect>}
            </g>
          );
        })}
      </svg>
      <div className="bars-labels">
        {data.map((d) => <span key={d.month} style={{ width: `${w}%` }}>{monthLabel(d.month, true)}</span>)}
      </div>
    </div>
  );
}

/** Cumulative spending through the month as a small area sparkline. */
export function Cumulative({ daily, month, height = 64 }: { daily: { date: string; amount: number }[]; month: string; height?: number }) {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const byDay = new Map(daily.map((d) => [Number(d.date.slice(8, 10)), d.amount]));
  let run = 0;
  const pts: [number, number][] = [];
  for (let d = 1; d <= days; d++) {
    run += byDay.get(d) ?? 0;
    pts.push([d, run]);
  }
  const max = Math.max(1, run);
  const path = pts.map(([d, v], i) => `${i ? 'L' : 'M'}${((d - 1) / (days - 1)) * 100},${100 - (v / max) * 92}`).join(' ');
  return (
    <svg className="spark" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ height }} aria-hidden="true">
      <path d={`${path} L100,100 L0,100 Z`} className="spark-fill" />
      <path d={path} className="spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function niceMax(v: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}

/** Value vs money paid in, over time (investments). */
export function ValueLine({ points, height = 180 }: { points: { date: string; value: number; contributed: number }[]; height?: number }) {
  if (points.length < 2) return null;
  const t = (d: string) => new Date(d + 'T00:00:00Z').getTime();
  const t0 = t(points[0].date);
  const t1 = t(points[points.length - 1].date);
  const max = Math.max(...points.flatMap((p) => [p.value, p.contributed])) * 1.05;
  const min = Math.min(...points.flatMap((p) => [p.value, p.contributed])) * 0.95;
  const x = (d: string) => ((t(d) - t0) / Math.max(1, t1 - t0)) * 100;
  const y = (v: number) => 100 - ((v - min) / Math.max(1, max - min)) * 100;
  const path = (k: 'value' | 'contributed') => points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date)},${y(p[k])}`).join(' ');
  return (
    <div className="value-line">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ height }} role="img" aria-label="Value and contributions over time">
        <path d={`${path('value')} L100,100 L0,100 Z`} className="vl-fill" />
        <path d={path('contributed')} className="vl-contrib" vectorEffect="non-scaling-stroke" />
        <path d={path('value')} className="vl-value" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="bars-labels">
        <span style={{ width: '50%', textAlign: 'left' }}>{points[0].date.slice(0, 7)}</span>
        <span style={{ width: '50%', textAlign: 'right' }}>{points[points.length - 1].date.slice(0, 7)}</span>
      </div>
    </div>
  );
}
