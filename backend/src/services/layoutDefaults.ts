import { getDatabase } from '../models/database.js';
import type { RGBW } from './effectEngine.js';

/**
 * Effect defaults tuned to the installed layout: sizes picked from the wall widths, and default
 * colors swapped for ones the fixtures can actually show when a channel is dead on most lights.
 * Applied to the effect type list, so they only affect new designs; saved designs keep their values.
 */

interface LayoutStats {
  totalWidth: number; // lights around the whole strip (one row)
  maxWall: number; // widest wall
  rows: number; // tallest wall
  // Share of lights on which each channel works (1 = all, 0 = none)
  health: Record<'r' | 'g' | 'b' | 'w', number>;
}

function layoutStats(): LayoutStats | null {
  const db = getDatabase();
  const walls = db.prepare('SELECT width, height FROM walls').all() as { width: number; height: number }[];
  const lights = db.prepare('SELECT defective_channels FROM lights').all() as { defective_channels: string | null }[];
  if (walls.length === 0 || lights.length === 0) return null;
  const dead = { r: 0, g: 0, b: 0, w: 0 };
  for (const l of lights) {
    for (const ch of (l.defective_channels || '').split(',')) {
      if (ch === 'r' || ch === 'g' || ch === 'b' || ch === 'w') dead[ch]++;
    }
  }
  const n = lights.length;
  return {
    totalWidth: walls.reduce((s, w) => s + w.width, 0),
    maxWall: Math.max(...walls.map(w => w.width)),
    rows: Math.max(...walls.map(w => w.height)),
    health: { r: 1 - dead.r / n, g: 1 - dead.g / n, b: 1 - dead.b / n, w: 1 - dead.w / n },
  };
}

/** The divisor of `total` in [lo, hi] closest to `target`, so patterns repeat seamlessly around the strip. */
function nearestDivisor(total: number, target: number, lo: number, hi: number): number {
  let best = target;
  let bestDist = Infinity;
  for (let d = lo; d <= hi; d++) {
    if (total % d === 0 && Math.abs(d - target) < bestDist) {
      best = d;
      bestDist = Math.abs(d - target);
    }
  }
  return best;
}

const usable = (h: number) => h >= 0.5;

/** How much of a color survives on a typical light with today's dead channels (0..1). */
function survives(c: RGBW, s: LayoutStats): number {
  const total = c.r + c.g + c.b + c.w;
  if (total === 0) return 1;
  return (c.r * s.health.r + c.g * s.health.g + c.b * s.health.b + c.w * s.health.w) / total;
}

/** Replace a color that would mostly go dark with a warm or white one of similar brightness. */
function adaptColor(c: RGBW, s: LayoutStats): RGBW {
  if (survives(c, s) >= 0.6) return c;
  const level = Math.min(255, Math.max(c.r, c.g, c.b, c.w));
  if (usable(s.health.r)) return { r: level, g: 0, b: 0, w: 0 };
  if (usable(s.health.w)) return { r: 0, g: 0, b: 0, w: level };
  return c;
}

/** Palettes keep only colors that survive; topped up with red and white so there are at least two. */
function adaptPalette(colors: RGBW[], s: LayoutStats): RGBW[] {
  const kept = colors.filter(c => survives(c, s) >= 0.6);
  const extras: RGBW[] = [];
  if (usable(s.health.r)) extras.push({ r: 255, g: 0, b: 0, w: 0 });
  if (usable(s.health.w)) extras.push({ r: 0, g: 0, b: 0, w: 255 });
  for (const e of extras) {
    if (kept.length >= 2) break;
    if (!kept.some(k => k.r === e.r && k.g === e.g && k.b === e.b && k.w === e.w)) kept.push(e);
  }
  return kept.length > 0 ? kept : colors;
}

const PALETTE_EFFECTS = new Set(['twinkle', 'fade', 'fireworks', 'strobe']);

type ParamDef = { default: unknown; min?: number; max?: number };
type EffectTypeDef = {
  type: string;
  defaultColors: RGBW[];
  params: Record<string, ParamDef>;
  defaultSpeed?: number;
};

/** Return the effect types with layout-aware defaults applied. */
export function applyLayoutDefaults<T extends EffectTypeDef>(types: T[]): T[] {
  const s = layoutStats();
  if (!s) return types;

  // Per-effect parameter defaults from the wall sizes
  const sized: Record<string, Record<string, unknown>> = {
    // ~8 lights per wave, picked so a whole number of waves fits around the strip
    wave: { wavelength: nearestDivisor(s.totalWidth, 8, 6, 12), depth: 0.5 },
    // Curve runs from the bottom row to the top row
    sine: { wavelength: nearestDivisor(s.totalWidth, 8, 6, 12), span: s.rows },
    // Stripes whose pair repeats evenly around the strip
    candy_cane: (() => {
      const w = nearestDivisor(s.totalWidth, 8, 4, 12) / 2;
      return { width1: Math.max(1, Math.round(w)), width2: Math.max(1, Math.round(w)) };
    })(),
    // A tail about half the widest wall
    comet: { tailLength: Math.max(2, Math.min(12, Math.round(s.maxWall / 2))) },
    converge: { groupSize: Math.max(1, Math.round(s.maxWall / 6)) },
    ripple: { spacing: nearestDivisor(s.totalWidth, 8, 4, 12) },
    fireworks: { burstSize: [s.rows + 1, Math.max(s.rows + 2, Math.round(s.maxWall / 2))] },
  };
  const speeds: Record<string, number> = { wave: 0.75 };

  return types.map(fx => {
    const params = { ...fx.params };
    for (const [key, value] of Object.entries(sized[fx.type] ?? {})) {
      if (params[key]) params[key] = { ...params[key], default: value };
    }
    let defaultColors = PALETTE_EFFECTS.has(fx.type)
      ? adaptPalette(fx.defaultColors, s)
      : fx.defaultColors.map(c => adaptColor(c, s));
    if (fx.type === 'wave') {
      // Trough in a color the lights can show (deep blue if blue works, else a dimmer red), white crest
      const trough = usable(s.health.b) ? { r: 0, g: 40, b: 200, w: 0 } : { r: 180, g: 0, b: 0, w: 0 };
      const crest = usable(s.health.w) ? { r: 0, g: 0, b: 0, w: 255 } : { r: 255, g: 0, b: 0, w: 0 };
      defaultColors = [trough, crest];
    }
    return { ...fx, params, defaultColors, ...(speeds[fx.type] ? { defaultSpeed: speeds[fx.type] } : {}) };
  });
}
