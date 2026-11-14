import React from 'react';

/** Small stroke icon set (Lucide-style, 24×24). */
const PATHS: Record<string, string> = {
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  fingerprint: 'M12 11v4M8.6 7.6A5 5 0 0 1 17 11v2M7 11a5 5 0 0 1 .3-1.7M7 14v-3M16.7 16.5a12 12 0 0 1-.7 3M12 18v3M9.7 20.5A11 11 0 0 1 8.5 16M5 15.5a11 11 0 0 1-.6-4A7.6 7.6 0 0 1 17 6M19.6 9.5c.3.7.4 1.5.4 2.5v1',
  backspace: 'M21 5H8l-6 7 6 7h13zM17 9l-6 6M11 9l6 6',
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  wallet: 'M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v3h-4a2 2 0 0 0 0 4h4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5',
  tag: 'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  'eye-off': 'M10.7 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.2 3.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M2 2l20 20M9.9 9.9a3 3 0 0 0 4.2 4.2',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  'chevron-left': 'M15 18l-6-6 6-6',
  'chevron-right': 'M9 18l6-6-6-6',
  'chevron-up': 'M6 15l6-6 6 6',
  grip: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
  'chevron-down': 'M6 9l6 6 6-6',
  transfer: 'M7 10h14l-4-4M17 14H3l4 4',
  trash: 'M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  undo: 'M3 7v6h6M21 17a9 9 0 0 0-15-6.7L3 13',
  archive: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  // Category icons
  'shopping-cart': 'M9 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM20 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6',
  'tools-kitchen-2': 'M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7',
  bus: 'M8 6v6M15 6v6M2 12h19.6M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM9 18h5M16 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  'shopping-bag': 'M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0',
  'device-tv': 'M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM17 2l-5 5-5-5',
  repeat: 'M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
  bolt: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
  home: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10',
  heartbeat: 'M22 12h-4l-3 9L9 3l-3 9H2',
  plane: 'M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z',
  sparkles: 'M12 3l1.9 5.8L20 10.7l-5.8 1.9L12 18.5l-1.9-5.9L4.2 10.7l5.9-1.9zM5 3v4M3 5h4M19 17v4M17 19h4',
  school: 'M22 10 12 5 2 10l10 5 10-5zM6 12v5c3 3 9 3 12 0v-5',
  percentage: 'M19 5 5 19M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  dots: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  briefcase: 'M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  gift: 'M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z',
  heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z',
  'chart-pie': 'M10 3.2A9 9 0 1 0 20.8 14a1 1 0 0 0-1-1H13a2 2 0 0 1-2-2V4a.9.9 0 0 0-1-.8M15 3.5A9 9 0 0 1 20.5 9H16a1 1 0 0 1-1-1V3.5',
  'trending-up': 'M23 6l-9.5 9.5-5-5L1 18M17 6h6v6',
  cash: 'M2 6h20v12H2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 12h.01M18 12h.01',
  coffee: 'M18 8h1a4 4 0 0 1 0 8h-1M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4zM6 1v3M10 1v3M14 1v3',
  car: 'M14 16H9m10 0h3v-3.2a2 2 0 0 0-.6-1.4L18 8H6l-3.4 3.4a2 2 0 0 0-.6 1.4V16h3M6.5 18.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM16.5 18.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 8l2-4h8l2 4',
  'piggy-bank': 'M19 5c-1.5 0-2.8 1.4-3 2-3.5-1.5-11-.3-11 5 0 1.8 0 3 2 4.5V20h4v-2h3v2h4v-4c1-.5 1.7-1 2-2h2v-4h-2c0-1-.5-1.5-1-2V5zM2 9v1c0 1.1.9 2 2 2h1',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15zM20 17v5H6.5a2.5 2.5 0 0 1 0-5',
  paw: 'M11 5a2 2 0 1 0 0-.01M18 9a2 2 0 1 0 0-.01M4 9a2 2 0 1 0 0-.01M12 12c-2.5 0-5 2.5-5 5.5S9 21 12 21s5-1 5-3.5-2.5-5.5-5-5.5z',
  baby: 'M9 12h.01M15 12h.01M10 16c.5.3 1.2.5 2 .5s1.5-.2 2-.5M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 3c1.7 0 3 1 3 2.5',
  phone: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 18h.01',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  package: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM12 12l8-4.5M12 12v9M12 12L4 7.5M8 5.3l8 4.5',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
  dumbbell: 'M6 7v10M3 9v6M18 7v10M21 9v6M6 12h12',
  pill: 'M10.5 20.5a5 5 0 0 1-7-7l6-6a5 5 0 0 1 7 7l-6 6zM7.5 10.5l6 6',
  game: 'M6 9h12a4 4 0 0 1 0 8c-1.5 0-2.3-.8-3-2h-6c-.7 1.2-1.5 2-3 2a4 4 0 0 1 0-8zM8 11v3M6.5 12.5h3M16 12h.01M17.5 14h.01',
  music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
};

/** The emoji categories were set up with, drawn as line icons instead. Anything not listed keeps its emoji. */
const EMOJI_ICONS: Record<string, string> = {
  '🛒': 'shopping-cart', '🥦': 'shopping-cart', '🍽': 'tools-kitchen-2', '🍔': 'tools-kitchen-2', '🍕': 'tools-kitchen-2', '🍜': 'tools-kitchen-2',
  '☕': 'coffee', '🚌': 'bus', '🚆': 'bus', '🚇': 'bus', '🚗': 'car', '⛽': 'car', '🛍': 'shopping-bag', '👕': 'shopping-bag',
  '📺': 'device-tv', '🎬': 'device-tv', '🔁': 'repeat', '🔄': 'repeat', '⚡': 'bolt', '💡': 'bolt', '🏠': 'home', '🏡': 'home',
  '💪': 'dumbbell', '🏋': 'dumbbell', '💊': 'pill', '🩺': 'heartbeat', '❤': 'heart', '✈': 'plane', '🧳': 'plane', '💅': 'sparkles',
  '✨': 'sparkles', '🎓': 'school', '📚': 'book', '📖': 'book', '💸': 'percentage', '🏦': 'percentage', '📦': 'package', '💼': 'briefcase', '🏛': 'briefcase', '🧾': 'file', '💳': 'wallet', '🛟': 'shield',
  '💻': 'code', '🎁': 'gift', '💝': 'heart', '📈': 'trending-up', '💵': 'cash', '💰': 'cash', '💷': 'cash', '🐷': 'piggy-bank',
  '📱': 'phone', '🛡': 'shield', '🐾': 'paw', '🐶': 'paw', '🐱': 'paw', '👶': 'baby', '🎯': 'target', '🎮': 'game', '🎵': 'music', '🎧': 'music',
};

/** The line icon to draw for a stored category or goal icon: its own name, a mapped emoji, or null to show the emoji. */
export function iconFor(icon: string | null | undefined): string | null {
  if (!icon) return null;
  if (/^[a-z0-9-]+$/.test(icon)) return icon;
  return EMOJI_ICONS[icon.replace(/[\uFE0F\u200D]/g, '')] ?? null;
}

/** A category's icon at text size: the line icon when there is one, otherwise the emoji. */
export function CatGlyph({ icon, size = 15, className = 'cat-glyph' }: { icon: string | null | undefined; size?: number; className?: string }) {
  if (!icon) return null;
  const name = iconFor(icon);
  return name ? <Icon name={name} size={size} className={className} /> : <span className={className}>{icon}</span>;
}

export const CATEGORY_ICONS = [
  'shopping-cart', 'tools-kitchen-2', 'coffee', 'bus', 'car', 'shopping-bag', 'device-tv', 'repeat', 'bolt', 'home', 'heartbeat',
  'plane', 'sparkles', 'school', 'book', 'percentage', 'briefcase', 'code', 'gift', 'heart', 'trending-up', 'cash', 'piggy-bank',
  'phone', 'shield', 'paw', 'baby', 'package', 'target', 'dumbbell', 'pill', 'game', 'music', 'dots',
];

export function Icon({ name, size = 18, className, strokeWidth = 1.8 }: { name: string; size?: number; className?: string; strokeWidth?: number }) {
  const d = PATHS[name] ?? PATHS.dots;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
