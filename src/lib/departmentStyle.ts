import { colors, textA } from '../styles/tokens';

// The schema's `icon` column isn't a rendering-ready asset (no icon library is
// part of the stack per CLAUDE.md §2), so — like the mockup — departments get
// a colored initial badge instead. Colors cycle through the mockup's 3-tone
// palette by position, keyed off `sort_order`, so it keeps working if a 4th
// department is ever added without needing a new color decision each time.
const PALETTE = [
  { bg: 'rgba(222, 122, 34, 0.18)', color: colors.accent },
  { bg: 'rgba(131, 163, 60, 0.18)', color: colors.success },
  { bg: textA(0.12), color: colors.text },
];

export function departmentBadge(index: number) {
  return PALETTE[index % PALETTE.length];
}
