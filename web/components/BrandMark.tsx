import React from 'react';
import { BODY, HEAD, HEAD_TRANSFORM, EYE, POUND } from './brand-paths.ts';

/** The Coil mark: a mamba coiled round a £. Gold tile in light mode, navy in dark (colours in styles.css). */
export function BrandMark({ size = 32, className = 'brand-mark' }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <rect x="0.75" y="0.75" width="98.5" height="98.5" rx="22" fill="var(--brand-tile)" stroke="var(--brand-edge)" strokeWidth="1.5" />
      <path d={BODY} fill="var(--brand-snake)" />
      <path d={HEAD} transform={HEAD_TRANSFORM} fill="var(--brand-snake)" />
      <circle cx={EYE.cx} cy={EYE.cy} r="1.5" fill="var(--brand-tile)" />
      <path d={POUND} fill="var(--brand-pound)" />
    </svg>
  );
}
