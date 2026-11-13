/**
 * Interactive charts for Reports: hover for exact numbers, click to drill in,
 * click legend items to hide or show a series. Plain SVG, sized to the container.
 *
 * Conventions: one y-axis per chart; values and labels in text colours (series
 * colour only on the mark and its key); thin marks with a 2px surface gap.
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { money } from '../format.ts';

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    setW(ref.current.clientWidth);
    const ro = new ResizeObserver((e) => setW(Math.round(e[0].contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Round, readable axis ticks covering [min, max]. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? 10 * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v));
  return out;
}

const axisMoney = (v: number) => money(v, { compact: true });

export interface Series { key: string; label: string; colour: string; values: number[] }

export function Legend({ items, hidden, onToggle, line }: {
  items: { key: string; label: string; colour: string; dashed?: boolean }[]; hidden?: Set<string>; onToggle?: (key: string) => void; line?: boolean;
}) {
  return (
    <div className="viz-legend" role={onToggle ? 'group' : undefined} aria-label="Series">
      {items.map((s) => {
        const off = hidden?.has(s.key);
        const key = line ? <i className={`lk-line ${s.dashed ? 'dashed' : ''}`} style={{ borderColor: s.colour }} /> : <i className="lk-box" style={{ background: s.colour }} />;
        return onToggle
          ? <button key={s.key} type="button" className={`viz-key ${off ? 'off' : ''}`} aria-pressed={!off} onClick={() => onToggle(s.key)} title={off ? 'Show' : 'Hide'}>{key}{s.label}</button>
          : <span key={s.key} className="viz-key">{key}{s.label}</span>;
      })}
    </div>
  );
}

/** Toggle helper for legends. */
export function useHidden(initial: string[] = []) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(initial));
  const toggle = (k: string) => setHidden((h) => { const n = new Set(h); n.has(k) ? n.delete(k) : n.add(k); return n; });
  return [hidden, toggle, setHidden] as const;
}

interface TipRow { colour: string; label: string; value: string; strong?: boolean; dashed?: boolean; line?: boolean }
function Tooltip({ x, y, width, title, rows, foot }: { x: number; y: number; width: number; title: string; rows: TipRow[]; foot?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(x + 12);
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth ?? 180;
    setLeft(x + 14 + w > width ? Math.max(0, x - 14 - w) : x + 14);
  }, [x, width, rows.length]);
  return (
    <div ref={ref} className="viz-tip" style={{ left, top: Math.max(0, y) }} role="status">
      <div className="viz-tip-title">{title}</div>
      {rows.map((r, i) => (
        <div key={i} className={`viz-tip-row ${r.strong ? 'strong' : ''}`}>
          {r.colour ? <i className={r.line ? `lk-line ${r.dashed ? 'dashed' : ''}` : 'lk-stroke'} style={r.line ? { borderColor: r.colour } : { background: r.colour }} /> : <i className="lk-none" />}
          <span className="v">{r.value}</span><span className="l">{r.label}</span>
        </div>
      ))}
      {foot && <div className="viz-tip-foot">{foot}</div>}
    </div>
  );
}

/** Rect with only its outer end rounded (top for positive, bottom for negative). */
function barPath(x: number, y: number, w: number, h: number, r: number, up: boolean) {
  r = Math.max(0, Math.min(r, h, w / 2));
  if (up) return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  return `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
}

/**
 * Stacked bars (one bar per x), positive values up and negative down from zero,
 * with an optional line on the same axis and a dashed reference value.
 */
export function StackedBars({ labels, titles, series, line, reference, height = 240, hidden, onToggle, onBarClick, onSegmentClick, selected, legend = true, formatTotal, grouped }: {
  labels: string[]; titles?: string[]; series: Series[]; line?: { label: string; colour: string; values: number[] };
  reference?: { value: number; label: string }; height?: number; hidden?: Set<string>; onToggle?: (key: string) => void;
  onBarClick?: (i: number) => void; onSegmentClick?: (key: string, i: number) => void; selected?: number | null; legend?: boolean;
  formatTotal?: (n: number) => string; grouped?: boolean;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; key: string | null; y: number } | null>(null);
  const shown = series.filter((s) => !hidden?.has(s.key));
  const n = labels.length;
  const padL = 52, padR = 10, padT = 10, padB = 26;
  const plotW = Math.max(10, W - padL - padR), plotH = height - padT - padB;
  const stacks = labels.map((_, i) => {
    let up = 0, down = 0;
    for (const s of shown) { const v = s.values[i] ?? 0; if (v >= 0) up += v; else down += v; }
    return { up, down };
  });
  const maxSingle = grouped ? Math.max(0, ...shown.flatMap((s) => s.values)) : 0;
  const hi = Math.max(1, grouped ? maxSingle : Math.max(...stacks.map((s) => s.up)), ...(line ? line.values : []), reference?.value ?? 0);
  const lo = Math.min(0, grouped ? Math.min(0, ...shown.flatMap((s) => s.values)) : Math.min(...stacks.map((s) => s.down)), ...(line ? line.values : []));
  // A few pounds of refunds shouldn't add a whole step below zero.
  const ticks = niceTicks(lo > -hi * 0.04 ? 0 : lo, hi);
  const t0 = ticks[0], t1 = ticks[ticks.length - 1];
  const y = (v: number) => padT + plotH - ((Math.max(v, t0) - t0) / (t1 - t0)) * plotH;
  const band = plotW / Math.max(1, n);
  const barW = Math.max(4, Math.min(56, band * (grouped ? 0.78 : 0.62)));
  const x0 = (i: number) => padL + i * band + (band - barW) / 2;
  const every = Math.max(1, Math.ceil((n * 46) / Math.max(1, plotW)));

  const tip = hover && (() => {
    const i = hover.i;
    const rows: TipRow[] = shown.map((s) => ({ colour: s.colour, label: s.label, value: money(s.values[i] ?? 0), key: s.key, v: s.values[i] ?? 0 }))
      .filter((r) => r.v !== 0).sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
      .map((r) => ({ colour: r.colour, label: r.label, value: r.value, strong: r.key === hover.key }));
    const total = stacks[i].up + stacks[i].down;
    const head: TipRow[] = !grouped && shown.length > 1 ? [{ colour: '', label: 'Total', value: formatTotal ? formatTotal(total) : money(total), strong: !hover.key }] : [];
    const extra: TipRow[] = line ? [{ colour: line.colour, label: line.label, value: money(line.values[i] ?? 0), line: true }] : [];
    const capped = rows.length > 9 ? [...rows.slice(0, 8), { colour: '', label: `${rows.length - 8} more`, value: '' }] : rows;
    return <Tooltip x={x0(i) + barW / 2} y={hover.y} width={W} title={titles?.[i] ?? labels[i]} rows={[...head, ...capped, ...extra]}
      foot={onSegmentClick && hover.key ? 'Click to look inside' : onBarClick ? 'Click to focus on this' : undefined} />;
  })();

  return (
    <div className="viz" ref={ref}>
      {legend && series.length > 1 && <Legend items={[...series, ...(line ? [{ key: '__line', label: line.label, colour: line.colour }] : [])]} hidden={hidden} onToggle={onToggle} />}
      <div className="viz-plot" style={{ height }} onMouseLeave={() => setHover(null)}>
        {W > 0 && (
          <svg width={W} height={height} role="img" aria-label="Bar chart">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-zero' : 'viz-grid'} />
                <text x={padL - 8} y={y(t)} dy="0.32em" textAnchor="end" className="viz-axis">{axisMoney(t)}</text>
              </g>
            ))}
            {labels.map((l, i) => (i % every === 0 || i === n - 1) && (
              <text key={i} x={padL + i * band + band / 2} y={height - 8} textAnchor="middle" className={`viz-axis ${selected === i ? 'sel' : ''}`}>{l}</text>
            ))}
            {labels.map((_, i) => {
              let up = 0, down = 0;
              const segs: React.ReactNode[] = [];
              const lastUp = [...shown].reverse().find((s) => (s.values[i] ?? 0) > 0)?.key;
              const lastDown = [...shown].reverse().find((s) => (s.values[i] ?? 0) < 0)?.key;
              shown.forEach((s, si) => {
                const v = s.values[i] ?? 0;
                if (!v) return;
                let yTop: number, h: number, isEnd: boolean, positive = v > 0;
                let x = x0(i), w = barW;
                if (grouped) {
                  w = (barW - (shown.length - 1) * 2) / shown.length;
                  x = x0(i) + si * (w + 2);
                  yTop = positive ? y(v) : y(0); h = Math.abs(y(v) - y(0)); isEnd = true;
                } else if (positive) {
                  yTop = y(up + v); h = y(up) - y(up + v); up += v; isEnd = s.key === lastUp;
                } else {
                  yTop = y(down); h = y(down + v) - y(down); down += v; isEnd = s.key === lastDown;
                }
                // 2px surface gap between stacked segments.
                const gap = grouped ? 0 : Math.min(2, h / 3);
                const hh = Math.max(0.5, h - gap);
                const yy = positive ? yTop + gap : yTop;
                const active = hover?.i === i && hover.key === s.key;
                segs.push(
                  <path key={s.key} d={isEnd ? barPath(x, yy, w, hh, 4, positive) : `M${x},${yy}h${w}v${hh}h${-w}Z`} fill={s.colour}
                    className={`viz-seg ${hover && hover.i === i && hover.key && !active ? 'dim' : ''} ${onSegmentClick ? 'clickable' : ''}`}
                    onMouseEnter={() => setHover({ i, key: s.key, y: 4 })}
                    onMouseLeave={() => setHover((h) => (h ? { ...h, key: null } : h))}
                    onClick={(e) => { if (onSegmentClick) { e.stopPropagation(); onSegmentClick(s.key, i); } }} />,
                );
              });
              return (
                <g key={i}>
                  <rect x={padL + i * band} y={padT} width={band} height={plotH} className={`viz-hit ${hover?.i === i ? 'on' : ''} ${selected === i ? 'sel' : ''} ${onBarClick ? 'clickable' : ''}`}
                    tabIndex={0} aria-label={`${titles?.[i] ?? labels[i]}: ${money(stacks[i].up + stacks[i].down)}`}
                    onMouseMove={() => setHover((h) => (h?.i === i ? h : { i, key: null, y: 4 }))}
                    onFocus={() => setHover({ i, key: null, y: 4 })} onBlur={() => setHover(null)}
                    onClick={() => onBarClick?.(i)} onKeyDown={(e) => { if (e.key === 'Enter') onBarClick?.(i); }} />
                  {segs}
                </g>
              );
            })}
            {reference && (
              <g className="viz-ref">
                <line x1={padL} x2={W - padR} y1={y(reference.value)} y2={y(reference.value)} />
                <text x={W - padR} y={y(reference.value) - 5} textAnchor="end">{reference.label}</text>
              </g>
            )}
            {line && (
              <>
                <polyline points={line.values.map((v, i) => `${padL + i * band + band / 2},${y(v)}`).join(' ')} fill="none" stroke={line.colour} strokeWidth={2} strokeLinejoin="round" pointerEvents="none" />
                {line.values.map((v, i) => <circle key={i} cx={padL + i * band + band / 2} cy={y(v)} r={hover?.i === i ? 5 : 3.5} fill={line.colour} stroke="var(--surface)" strokeWidth={2} pointerEvents="none" />)}
              </>
            )}
          </svg>
        )}
        {tip}
      </div>
    </div>
  );
}

/** Lines over a shared x-axis, with a crosshair that snaps to the nearest point and one tooltip for every series. */
export function LineChart({ labels, titles, series, height = 220, hidden, onToggle, reference, format = money, axisFormat = axisMoney, area, markLast, legend = true }: {
  labels: string[]; titles?: string[]; series: { key: string; label: string; colour: string; values: (number | null)[]; dashed?: boolean }[];
  height?: number; hidden?: Set<string>; onToggle?: (key: string) => void; reference?: { value: number; label: string };
  format?: (n: number) => string; axisFormat?: (n: number) => string; area?: string; markLast?: boolean; legend?: boolean;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const shown = series.filter((s) => !hidden?.has(s.key));
  const n = labels.length;
  const padL = 52, padR = 12, padT = 12, padB = 26;
  const plotW = Math.max(10, W - padL - padR), plotH = height - padT - padB;
  const vals = shown.flatMap((s) => s.values.filter((v): v is number => v != null));
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(1, ...vals, reference?.value ?? 0));
  const t0 = ticks[0], t1 = ticks[ticks.length - 1];
  const x = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => padT + plotH - ((v - t0) / (t1 - t0)) * plotH;
  const every = Math.max(1, Math.ceil((n * 44) / Math.max(1, plotW)));
  const path = (vs: (number | null)[]) => {
    let d = '', pen = false;
    vs.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i)},${y(v)}`; pen = true; });
    return d;
  };
  function move(e: React.MouseEvent) {
    const px = e.nativeEvent.offsetX;
    const i = Math.round(((px - padL) / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  }
  const areaSeries = area ? shown.find((s) => s.key === area) : null;
  return (
    <div className="viz" ref={ref}>
      {legend && series.length > 1 && <Legend line items={series} hidden={hidden} onToggle={onToggle} />}
      <div className="viz-plot" style={{ height }} onMouseLeave={() => setHover(null)}>
        {W > 0 && (
          <svg width={W} height={height} onMouseMove={move} role="img" aria-label="Line chart" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? -1) + 1)); if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? n) - 1)); }}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-zero' : 'viz-grid'} />
                <text x={padL - 8} y={y(t)} dy="0.32em" textAnchor="end" className="viz-axis">{axisFormat(t)}</text>
              </g>
            ))}
            {labels.map((l, i) => (i % every === 0 || i === n - 1) && <text key={i} x={x(i)} y={height - 8} textAnchor="middle" className="viz-axis">{l}</text>)}
            {reference && (
              <g className="viz-ref">
                <line x1={padL} x2={W - padR} y1={y(reference.value)} y2={y(reference.value)} />
                <text x={W - padR} y={y(reference.value) - 5} textAnchor="end">{reference.label}</text>
              </g>
            )}
            {areaSeries && <path d={`${path(areaSeries.values)}L${x(areaSeries.values.length - 1 - [...areaSeries.values].reverse().findIndex((v) => v != null))},${y(Math.max(0, t0))}L${x(areaSeries.values.findIndex((v) => v != null))},${y(Math.max(0, t0))}Z`} fill={areaSeries.colour} opacity={0.1} />}
            {shown.map((s) => <path key={s.key} d={path(s.values)} fill="none" stroke={s.colour} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} strokeLinejoin="round" strokeLinecap="round" />)}
            {markLast && shown.map((s) => {
              const i = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v != null);
              const v = s.values[i];
              return v == null || i < 0 ? null : <circle key={s.key} cx={x(i)} cy={y(v)} r={4.5} fill={s.colour} stroke="var(--surface)" strokeWidth={2} />;
            })}
            {hover != null && (
              <g pointerEvents="none">
                <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} className="viz-cross" />
                {shown.map((s) => s.values[hover] != null && <circle key={s.key} cx={x(hover)} cy={y(s.values[hover]!)} r={4.5} fill={s.colour} stroke="var(--surface)" strokeWidth={2} />)}
              </g>
            )}
          </svg>
        )}
        {hover != null && W > 0 && (
          <Tooltip x={x(hover)} y={12} width={W} title={titles?.[hover] ?? labels[hover]}
            rows={shown.filter((s) => s.values[hover] != null).map((s) => ({ colour: s.colour, label: s.label, value: format(s.values[hover]!), line: true, dashed: s.dashed }))} />
        )}
      </div>
    </div>
  );
}

/** Start total, the changes that explain the difference, end total. */
export function Waterfall({ start, end, steps, height = 260, onStepClick }: {
  start: { label: string; value: number }; end: { label: string; value: number };
  steps: { key: string; label: string; value: number }[]; height?: number; onStepClick?: (key: string) => void;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const bars = useMemo(() => {
    const out: { key: string; label: string; from: number; to: number; kind: 'total' | 'up' | 'down'; value: number }[] = [{ key: '__start', label: start.label, from: 0, to: start.value, kind: 'total', value: start.value }];
    let run = start.value;
    for (const s of steps) { out.push({ key: s.key, label: s.label, from: run, to: run + s.value, kind: s.value >= 0 ? 'up' : 'down', value: s.value }); run += s.value; }
    out.push({ key: '__end', label: end.label, from: 0, to: end.value, kind: 'total', value: end.value });
    return out;
  }, [start, end, steps]);
  const padL = 52, padR = 10, padT = 10, padB = 56;
  const plotW = Math.max(10, W - padL - padR), plotH = height - padT - padB;
  const ticks = niceTicks(Math.min(0, ...bars.map((b) => Math.min(b.from, b.to))), Math.max(1, ...bars.map((b) => Math.max(b.from, b.to))));
  const t0 = ticks[0], t1 = ticks[ticks.length - 1];
  const y = (v: number) => padT + plotH - ((v - t0) / (t1 - t0)) * plotH;
  const band = plotW / bars.length;
  const bw = Math.max(6, Math.min(48, band * 0.62));
  const colour = (k: string) => (k === 'total' ? 'var(--text-3)' : k === 'up' ? 'var(--bad)' : 'var(--good)');
  return (
    <div className="viz" ref={ref}>
      <div className="viz-legend"><span className="viz-key"><i className="lk-box" style={{ background: 'var(--bad)' }} />Spent more</span><span className="viz-key"><i className="lk-box" style={{ background: 'var(--good)' }} />Spent less</span></div>
      <div className="viz-plot" style={{ height }} onMouseLeave={() => setHover(null)}>
        {W > 0 && (
          <svg width={W} height={height} role="img" aria-label="What changed between the two periods">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-zero' : 'viz-grid'} />
                <text x={padL - 8} y={y(t)} dy="0.32em" textAnchor="end" className="viz-axis">{axisMoney(t)}</text>
              </g>
            ))}
            {bars.map((b, i) => {
              const x = padL + i * band + (band - bw) / 2;
              const top = y(Math.max(b.from, b.to)), h = Math.max(1, Math.abs(y(b.from) - y(b.to)));
              const next = bars[i + 1];
              return (
                <g key={b.key} className={`${hover != null && hover !== i ? 'dimmed' : ''} ${onStepClick && b.kind !== 'total' ? 'clickable' : ''}`}
                  onMouseEnter={() => setHover(i)} onClick={() => b.kind !== 'total' && onStepClick?.(b.key)}>
                  <rect x={padL + i * band} y={padT} width={band} height={plotH + padB} fill="transparent" />
                  <path d={barPath(x, top, bw, h, 3, true)} fill={colour(b.kind)} />
                  {next && <line x1={x + bw} x2={x + band} y1={y(b.to)} y2={y(b.to)} className="viz-connector" />}
                  <text x={x + bw / 2} y={height - padB + 14} textAnchor="end" transform={`rotate(-32 ${x + bw / 2} ${height - padB + 14})`} className="viz-axis">{b.label.length > 14 ? `${b.label.slice(0, 13)}…` : b.label}</text>
                </g>
              );
            })}
          </svg>
        )}
        {hover != null && W > 0 && (
          <Tooltip x={padL + hover * band + band / 2} y={10} width={W} title={bars[hover].label}
            rows={[{ colour: colour(bars[hover].kind), label: bars[hover].kind === 'total' ? 'total spending' : bars[hover].value >= 0 ? 'more than before' : 'less than before', value: bars[hover].kind === 'total' ? money(bars[hover].value) : money(bars[hover].value, { sign: true }), strong: true }]}
            foot={onStepClick && bars[hover].kind !== 'total' ? 'Click to see it over time' : undefined} />
        )}
      </div>
    </div>
  );
}

/** A tiny trend line for tables. */
export function Spark({ values, colour = 'var(--text-3)', width = 72, height = 22 }: { values: number[]; colour?: string; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values), min = Math.min(0, ...values);
  const x = (i: number) => (i / (values.length - 1)) * (width - 4) + 2;
  const y = (v: number) => height - 2 - ((v - min) / (max - min || 1)) * (height - 4);
  return (
    <svg width={width} height={height} className="spark-mini" aria-hidden="true">
      <polyline points={values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} fill="none" stroke={colour} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={2.5} fill={colour} />
    </svg>
  );
}

/** Keeps the previous render on screen (faded) while new data loads, instead of flashing. */
export function useStale<T>(data: T | null): { data: T | null; stale: boolean } {
  const last = useRef<T | null>(null);
  useEffect(() => { if (data) last.current = data; }, [data]);
  return { data: data ?? last.current, stale: !data && !!last.current };
}
