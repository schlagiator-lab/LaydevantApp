// Design tokens ported from design/maquettes.html. Keep in sync with that
// file if the mockups change — there is no build-time link between them.

export const colors = {
  bg: '#1E3A6B',
  bgDark: '#0e1a30',
  card: '#24457D',
  text: '#F2E9A8',
  accent: '#DE7A22',
  success: '#83A33C',
} as const;

/** Text color (`#F2E9A8`) at a given opacity — the mockup's main hierarchy tool. */
export function textA(opacity: number): string {
  return `rgba(242, 233, 168, ${opacity})`;
}

/** Accent color (`#DE7A22`) at a given opacity — banners, badges. */
export function accentA(opacity: number): string {
  return `rgba(222, 122, 34, ${opacity})`;
}

/** Success color (`#83A33C`) at a given opacity — "disponible hors ligne" states. */
export function successA(opacity: number): string {
  return `rgba(131, 163, 60, ${opacity})`;
}

export const fonts = {
  sans: "'IBM Plex Sans', system-ui, sans-serif",
  mono: "'JetBrains Mono', monospace",
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 12,
  xl: 14,
  xxl: 16,
  pill: 100,
} as const;
