/** The place behind a bank description: drops store numbers and references. "TESCO STORES 3297" → "Tesco Stores". */
export function merchantKey(raw: string): string {
  const cleaned = raw.replace(/\b\S*\d\S*\b/g, ' ').replace(/[*#|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const base = cleaned || raw.trim();
  return base.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}
