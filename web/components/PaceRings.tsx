import React from 'react';

export type PaceTone = 'good' | 'warn' | 'bad';

/** Money is "ahead" when it runs more than 10 points ahead of time; over when the plan is already overspent. */
export function paceTone(time: number, money: number, over: boolean): PaceTone {
  if (over || money >= 1) return 'bad';
  return money > time + 0.1 ? 'warn' : 'good';
}

/**
 * Coil's pace rings. Outer: how far through the pay cycle you are. Inner: how much of this month's
 * spending money has gone, with the snake's head at its tip. Inner behind outer means you're fine.
 */
export function PaceRings({ time, money, tone, size = 92, drawIn = false }: { time: number; money: number; tone: PaceTone; size?: number; drawIn?: boolean }) {
  const c = size / 2;
  const sw = size * 0.075;
  const rOut = c - sw / 2 - 1;
  const rIn = rOut - sw - size * 0.05;
  const arc = (r: number, v: number) => {
    const len = 2 * Math.PI * r;
    return { strokeDasharray: `${len} ${len}`, strokeDashoffset: len * (1 - Math.min(1, Math.max(0, v))), '--len': `${len}` } as React.CSSProperties;
  };
  const m = Math.min(1, Math.max(0, money));
  const a = m * 2 * Math.PI - Math.PI / 2;
  const hx = c + rIn * Math.cos(a), hy = c + rIn * Math.sin(a);
  const pct = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 100);
  const label = `${pct(time)}% of the way to payday, ${pct(money)}% of spending money used`;
  return (
    <svg className={`pace-rings tone-${tone} ${drawIn ? 'draw' : ''}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
      <title>{label}</title>
      <circle cx={c} cy={c} r={rOut} className="pr-track" strokeWidth={sw} fill="none" />
      <circle cx={c} cy={c} r={rIn} className="pr-track" strokeWidth={sw} fill="none" />
      <circle cx={c} cy={c} r={rOut} className="pr-time" strokeWidth={sw} fill="none" strokeLinecap="round"
        transform={`rotate(-90 ${c} ${c})`} style={arc(rOut, time)} />
      <circle cx={c} cy={c} r={rIn} className="pr-money" strokeWidth={sw} fill="none" strokeLinecap="round"
        transform={`rotate(-90 ${c} ${c})`} style={arc(rIn, m)} />
      {m > 0.02 && <g className="pr-head" style={{ '--from': `${-m * 360}deg` } as React.CSSProperties}>
        <circle cx={hx} cy={hy} r={sw * 0.82} />
        <circle cx={hx + Math.cos(a + Math.PI / 2) * sw * 0.3} cy={hy + Math.sin(a + Math.PI / 2) * sw * 0.3} r={sw * 0.16} className="pr-eye" />
      </g>}
    </svg>
  );
}

/** The two-row key that sits beside the rings. */
export function PaceKey({ time, money }: { time: number; money: number }) {
  const pct = (v: number) => `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`;
  return (
    <div className="pace-key" aria-hidden="true">
      <span><i className="pk-time" />Time <strong>{pct(time)}</strong></span>
      <span><i className="pk-money" />Money <strong>{pct(money)}</strong></span>
    </div>
  );
}

let drawnThisLaunch = false;
/** True only the first time it's asked after Coil opens, so the rings draw themselves once, not on every visit. */
export function useDrawOnce(): boolean {
  const [draw] = React.useState(() => { const d = !drawnThisLaunch; drawnThisLaunch = true; return d; });
  return draw;
}
