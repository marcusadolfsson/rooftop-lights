import type { RGBW } from '../types';

/** CSS color for an RGBW value, with W folded into RGB for display. */
export function rgbwToCss(color: RGBW | undefined, fallback = '#222'): string {
  if (!color) return fallback;
  const r = Math.min(255, color.r + color.w);
  const g = Math.min(255, color.g + color.w);
  const b = Math.min(255, color.b + color.w);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Simulated output of a light with defective channels zeroed out, or null if the
 * color doesn't use any defective channel (so it renders normally).
 */
export function simulateDefective(color: RGBW | undefined, defectiveChannels: string): string | null {
  if (!defectiveChannels || !color) return null;
  const channels = defectiveChannels.split(',');
  const hasConflict = channels.some(ch =>
    (ch === 'r' && color.r > 0) || (ch === 'g' && color.g > 0) ||
    (ch === 'b' && color.b > 0) || (ch === 'w' && color.w > 0)
  );
  if (!hasConflict) return null;
  let { r, g, b, w } = color;
  for (const ch of channels) {
    if (ch === 'r') r = 0;
    if (ch === 'g') g = 0;
    if (ch === 'b') b = 0;
    if (ch === 'w') w = 0;
  }
  return `rgb(${Math.min(255, r + w)}, ${Math.min(255, g + w)}, ${Math.min(255, b + w)})`;
}
