import { useEffect, useState } from 'react';

/** Tiny hash router: #/transactions?accountId=2 */
export function useRoute(): { path: string; params: URLSearchParams } {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const raw = hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { path, params: new URLSearchParams(query) };
}

export function navigate(to: string) {
  window.location.hash = to;
}

export function setParams(path: string, params: Record<string, string | number | null | undefined | boolean>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, v === true ? '1' : String(v));
  const q = p.toString();
  const next = `#${path}${q ? `?${q}` : ''}`;
  if (window.location.hash !== next) window.history.replaceState(null, '', next), window.dispatchEvent(new HashChangeEvent('hashchange'));
}
