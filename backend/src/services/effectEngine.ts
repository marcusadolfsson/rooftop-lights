import { getDatabase } from '../models/database.js';
import { AICodeRunner, AILayout } from './aiSandbox.js';

export interface RGBW {
  r: number;
  g: number;
  b: number;
  w: number;
}

export interface Light {
  id: string;
  wall_id: string;
  matrix_x: number;
  matrix_y: number;
  light_id: number;
  light_type: string;
  dmx_start_channel: number;
  defective_channels: string;
}

export interface Wall {
  id: string;
  name: string;
  width: number;
  height: number;
  position: number;
  connects_to_next: number;
  group_id: string | null;
}

export interface MotionEffect {
  type: string;
  speed: number;
  colors: RGBW[];
  scope: 'wall' | 'all' | 'group';
  params?: Record<string, unknown>;
}

export interface StaticDesign {
  colors: Record<number, RGBW>; // light_id -> color
}

const BLACK: RGBW = { r: 0, g: 0, b: 0, w: 0 };
const MAX_TEXT_LENGTH = 500;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toByte(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, n));
}

/** Coerce anything color-like into a valid RGBW (missing/invalid channels -> 0). */
export function toRGBW(c: unknown): RGBW {
  if (!isPlainObject(c)) return { ...BLACK };
  return { r: toByte(c.r), g: toByte(c.g), b: toByte(c.b), w: toByte(c.w) };
}

/** Read a numeric param, falling back to `def` and clamping into [min, max]. */
function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** Read a boolean param; also accepts the strings "true"/"false" so a stringly-typed save isn't misread. */
/**
 * Read a min-max range param ([lo, hi]); a plain number (older designs) means a fixed value.
 * Both ends are clamped into [min, max] and swapped if reversed.
 */
function range(v: unknown, def: [number, number], min: number, max: number): [number, number] {
  if (Array.isArray(v) && v.length === 2) {
    const a = num(v[0], def[0], min, max), b = num(v[1], def[1], min, max);
    return a <= b ? [a, b] : [b, a];
  }
  if (v !== undefined && v !== null && v !== '') {
    const n = num(v, NaN, min, max);
    if (Number.isFinite(n)) return [n, n];
  }
  return def;
}

/** Pick a value inside [lo, hi] with a 0..1 random number. */
function within([lo, hi]: [number, number], r: number): number {
  return lo + (hi - lo) * r;
}

function bool(v: unknown, def: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return def;
}

/**
 * Direction of travel for directional effects. 0° runs along the strip (the original behavior),
 * 90° runs bottom to top, 180° reverses. Returns the unit vector (cos, sin).
 */
function angleVector(effect: MotionEffect): { cos: number; sin: number } {
  const deg = num(effect.params?.angle, 0, -360, 360);
  const rad = (deg * Math.PI) / 180;
  // Snap tiny float noise so 0°/90°/180° give exact integer coordinates
  const snap = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v);
  return { cos: snap(Math.cos(rad)), sin: snap(Math.sin(rad)) };
}

/** Range of the projected coordinate u = x*cos + y*sin over a segment `width` lights wide and `rows` tall. */
function axisRange(width: number, rows: number, v: { cos: number; sin: number }): { min: number; max: number } {
  const xs = [0, (width - 1) * v.cos];
  const ys = [0, (rows - 1) * v.sin];
  return { min: Math.min(...xs) + Math.min(...ys), max: Math.max(...xs) + Math.max(...ys) };
}

const FPS = 30;

/**
 * Optional "pause before looping": params.pause seconds of darkness appended to each cycle.
 * frameNum is already speed-scaled, so the pause is scaled the same way to stay in real seconds.
 * Returns how many `unit`-frame steps the pause lasts (0 when unset).
 */
function pauseSteps(effect: MotionEffect, unit: number): number {
  const seconds = num(effect.params?.pause, 0, 0, 600);
  return Math.round((seconds * FPS * effect.speed) / unit);
}

/**
 * Real (unscaled) frame count for effects whose params are all in real time (seconds, per second,
 * per minute). frameNum is speed-scaled, so dividing the speed back out keeps those labels true at
 * any Speed. Callers that know the unscaled frame pass it to generateMotionFrame instead, which
 * avoids the coarse steps frameNum / speed has at low speeds.
 */
function realFrameOf(effect: MotionEffect, frameNum: number): number {
  return frameNum / effect.speed;
}

/** Position within a cycle of `cycle` steps followed by `pause` dark steps; null while paused. */
function cycleStep(step: number, cycle: number, pause: number): number | null {
  if (cycle <= 0) return null;
  const m = step % (cycle + pause);
  return m < cycle ? m : null;
}

/**
 * Keep a light on the same point of the rainbow as its neighbors, but move the part of the color
 * it can't show (its dead channels) into the white channel, so it reads as a softer, whiter
 * version of the hue instead of going dark. The band stays continuous across the roof.
 */
const DEAD_TO_WHITE = 0.6;
function adjustForDeadChannels(c: { r: number; g: number; b: number }, defective: string): RGBW {
  const dead = new Set(defective.split(','));
  const out: RGBW = { r: c.r, g: c.g, b: c.b, w: 0 };
  let lost = 0;
  for (const ch of ['r', 'g', 'b'] as const) {
    if (dead.has(ch)) { lost += out[ch]; out[ch] = 0; }
  }
  if (!dead.has('w')) out.w = Math.min(255, Math.round(lost * DEAD_TO_WHITE));
  return out;
}

/** Deterministic pseudo-random in [0, 1) from integers, so playback is repeatable. */
function rand(...n: number[]): number {
  let h = 2166136261;
  for (const v of n) {
    h ^= v | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return (h >>> 0) / 4294967296;
}

function scaleColor(c: RGBW, k: number): RGBW {
  const f = Math.max(0, Math.min(1, k));
  return { r: Math.round(c.r * f), g: Math.round(c.g * f), b: Math.round(c.b * f), w: Math.round(c.w * f) };
}

function mixColor(a: RGBW, b: RGBW, t: number): RGBW {
  const f = Math.max(0, Math.min(1, t));
  return {
    r: Math.round(a.r + (b.r - a.r) * f),
    g: Math.round(a.g + (b.g - a.g) * f),
    b: Math.round(a.b + (b.b - a.b) * f),
    w: Math.round(a.w + (b.w - a.w) * f),
  };
}

/** Brighter of two colors per channel (for overlapping bursts). */
function maxColor(a: RGBW, b: RGBW): RGBW {
  return { r: Math.max(a.r, b.r), g: Math.max(a.g, b.g), b: Math.max(a.b, b.b), w: Math.max(a.w, b.w) };
}

/** Legacy Chase params mapped onto Comet: same group size, no tail, one-way laps. */
function chaseAsComet(effect: MotionEffect): MotionEffect {
  const p = effect.params ?? {};
  return {
    ...effect,
    type: 'comet',
    params: { size: p.groupSize ?? 3, tailLength: 0, bounce: false, tailExit: true, pause: p.pause ?? 0, wallIds: p.wallIds },
  };
}

/**
 * Stepped effects move one light every this many (speed-scaled) frames. Used for optional sub-pixel
 * blending, and reported to the editor so it can say how smooth a speed looks.
 */
export const STEP_FRAMES: Record<string, number> = {
  candy_cane: 15,
  checkerboard: 15,
  comet: 4,
  converge: 4,
  text: 6,
};

/** Wall ids a Per Wall effect is limited to (empty = all walls). */
function selectedWallIds(effect: MotionEffect): string[] {
  const ids = effect.params?.wallIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/** Make a motion effect safe to render: colors array of RGBW, params object, valid scope. */
export function normalizeMotionEffect(effect: unknown): MotionEffect {
  const e = isPlainObject(effect) ? effect : {};
  const colors = Array.isArray(e.colors) ? e.colors.filter(isPlainObject).map(toRGBW) : [];
  const scope = e.scope === 'wall' || e.scope === 'group' ? e.scope : 'all';
  return {
    type: typeof e.type === 'string' ? e.type : '',
    speed: num(e.speed, 1, 0.01, 100),
    colors,
    scope,
    params: isPlainObject(e.params) ? e.params : {},
  };
}

// 3-row pixel font: each character is an array of 3 rows, each row is an array of 0/1
const PIXEL_FONT: Record<string, number[][]> = {
  'A': [[0,1,0],[1,0,1],[1,1,1]],
  'B': [[1,1,0],[1,1,1],[1,1,0]],
  'C': [[1,1,1],[1,0,0],[1,1,1]],
  'D': [[1,1,0],[1,0,1],[1,1,0]],
  'E': [[1,1,1],[1,1,0],[1,1,1]],
  'F': [[1,1,1],[1,1,0],[1,0,0]],
  'G': [[1,1,1],[1,0,1],[1,1,1]],
  'H': [[1,0,1],[1,1,1],[1,0,1]],
  'I': [[1,1,1],[0,1,0],[1,1,1]],
  'J': [[0,0,1],[1,0,1],[1,1,1]],
  'K': [[1,0,1],[1,1,0],[1,0,1]],
  'L': [[1,0,0],[1,0,0],[1,1,1]],
  'M': [[1,0,1],[1,1,1],[1,0,1]],
  'N': [[1,1,0],[1,0,1],[1,0,1]],
  'O': [[1,1,1],[1,0,1],[1,1,1]],
  'P': [[1,1,1],[1,1,1],[1,0,0]],
  'Q': [[1,1,1],[1,0,1],[1,1,0]],
  'R': [[1,1,0],[1,1,1],[1,0,1]],
  'S': [[0,1,1],[0,1,0],[1,1,0]],
  'T': [[1,1,1],[0,1,0],[0,1,0]],
  'U': [[1,0,1],[1,0,1],[1,1,1]],
  'V': [[1,0,1],[1,0,1],[0,1,0]],
  'W': [[1,0,1],[1,1,1],[1,0,1]],
  'X': [[1,0,1],[0,1,0],[1,0,1]],
  'Y': [[1,0,1],[0,1,0],[0,1,0]],
  'Z': [[1,1,0],[0,1,0],[0,1,1]],
  '0': [[1,1,1],[1,0,1],[1,1,1]],
  '1': [[0,1,0],[1,1,0],[0,1,0]],
  '2': [[1,1,0],[0,1,0],[0,1,1]],
  '3': [[1,1,0],[0,1,0],[1,1,0]],
  '4': [[1,0,1],[1,1,1],[0,0,1]],
  '5': [[0,1,1],[0,1,0],[1,1,0]],
  '6': [[1,0,0],[1,1,1],[1,1,1]],
  '7': [[1,1,1],[0,0,1],[0,0,1]],
  '8': [[1,1,1],[1,1,1],[1,1,1]],
  '9': [[1,1,1],[1,1,1],[0,0,1]],
  ' ': [[0,0],[0,0],[0,0]],
  '!': [[0,1,0],[0,1,0],[0,0,0]],
  '.': [[0,0,0],[0,0,0],[0,1,0]],
  ',': [[0,0,0],[0,0,0],[0,1,0]],
  '-': [[0,0,0],[1,1,1],[0,0,0]],
  '?': [[1,1,0],[0,1,0],[0,0,0]],
  ':': [[0,1,0],[0,0,0],[0,1,0]],
  '\'': [[0,1,0],[0,0,0],[0,0,0]],
  '<': [[0,0,1],[0,1,0],[0,0,1]],
  '>': [[1,0,0],[0,1,0],[1,0,0]],
  '/': [[0,0,1],[0,1,0],[1,0,0]],
  '#': [[1,0,1],[1,1,1],[1,0,1]],
};

export class EffectEngine {
  private walls: Wall[] = [];
  private rows = 3; // tallest wall's height: how many rows the row-based effects iterate
  private lights: Light[] = [];
  private lightMatrix: Map<string, Light[][]> = new Map(); // wall_id -> 2D array
  private aiRunner = new AICodeRunner();

  constructor() {
    this.loadLayout();
  }

  loadLayout(): void {
    const db = getDatabase();
    this.walls = db.prepare('SELECT id, name, width, height, position, connects_to_next, group_id FROM walls ORDER BY position').all() as Wall[];
    this.lights = db.prepare('SELECT * FROM lights').all() as Light[];

    // Build matrix for each wall
    this.lightMatrix.clear();
    for (const wall of this.walls) {
      const matrix: Light[][] = [];
      for (let y = 0; y < wall.height; y++) {
        matrix[y] = [];
        for (let x = 0; x < wall.width; x++) {
          const light = this.lights.find(
            l => l.wall_id === wall.id && l.matrix_x === x && l.matrix_y === y
          );
          if (light) {
            matrix[y][x] = light;
          }
        }
      }
      this.lightMatrix.set(wall.id, matrix);
    }
    this.rows = Math.max(1, ...this.walls.map(w => w.height));
    this.aiRunner.setLayout(this.buildAILayout());
  }

  // Get all lights in a continuous row (considering wall connections)
  getContinuousRow(y: number): Light[] {
    const row: Light[] = [];
    for (const wall of this.walls) {
      const matrix = this.lightMatrix.get(wall.id);
      if (matrix && matrix[y]) {
        // Skip holes (matrix positions with no light configured)
        for (const light of matrix[y]) if (light) row.push(light);
      }
    }
    return row;
  }

  // Get light segments based on scope: one continuous row, per-wall rows, or per-group rows
  getSegments(y: number, scope: 'wall' | 'all' | 'group'): Light[][] {
    if (scope === 'wall') {
      return this.walls.map(wall => {
        const matrix = this.lightMatrix.get(wall.id);
        return matrix && matrix[y] ? matrix[y].filter(Boolean) : [];
      }).filter(row => row.length > 0);
    }
    if (scope === 'group') {
      // Walls sharing a group_id form one continuous segment; ungrouped walls get their own segment
      const segments: Light[][] = [];
      const groupMap = new Map<string, Light[]>();
      for (const wall of this.walls) {
        const matrix = this.lightMatrix.get(wall.id);
        const row = matrix && matrix[y] ? matrix[y].filter(Boolean) : [];
        if (row.length === 0) continue;
        if (wall.group_id) {
          const existing = groupMap.get(wall.group_id);
          if (existing) {
            existing.push(...row);
          } else {
            const segment: Light[] = [...row];
            groupMap.set(wall.group_id, segment);
            segments.push(segment);
          }
        } else {
          segments.push(row);
        }
      }
      return segments;
    }
    const row = this.getContinuousRow(y);
    return row.length > 0 ? [row] : [];
  }

  // Generate frame for static design
  generateStaticFrame(design: StaticDesign): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const colors = isPlainObject(design?.colors) ? design.colors : {};
    for (const light of this.lights) {
      const color = colors[light.light_id];
      frame.set(light.light_id, color ? toRGBW(color) : { ...BLACK });
    }
    return frame;
  }

  // Generate frame for motion effect. frameNum is speed-scaled; realFrame is the unscaled frame
  // (used by effects timed in seconds) and defaults to frameNum / speed.
  generateMotionFrame(rawEffect: MotionEffect, frameNum: number, realFrame?: number): Map<number, RGBW> {
    const effect = normalizeMotionEffect(rawEffect);
    const real = typeof realFrame === 'number' && Number.isFinite(realFrame) ? realFrame : realFrameOf(effect, frameNum);
    const stepFrames = STEP_FRAMES[effect.type];
    let frame: Map<number, RGBW>;
    if (stepFrames && bool(effect.params?.smooth, false)) {
      // Sub-pixel blending: render the step before and after this moment and crossfade between
      // them, so a moving edge glides across two lights instead of jumping a whole light
      const a = Math.floor(frameNum / stepFrames) * stepFrames;
      const t = (frameNum - a) / stepFrames;
      const from = this.renderMotion(effect, a, real);
      const to = this.renderMotion(effect, a + stepFrames, real);
      frame = new Map();
      for (const [id, c] of from) frame.set(id, mixColor(c, to.get(id) ?? BLACK, t));
    } else {
      frame = this.renderMotion(effect, Math.floor(frameNum), real);
    }

    // Per Wall can be limited to chosen walls; everything else stays dark
    // Ignore ids of walls that no longer exist, so a deleted wall can't black out the whole roof
    const wallIds = effect.scope === 'wall'
      ? selectedWallIds(effect).filter(id => this.walls.some(w => w.id === id))
      : [];
    if (wallIds.length > 0) {
      const keep = new Set(wallIds);
      for (const light of this.lights) {
        if (!keep.has(light.wall_id)) frame.set(light.light_id, { ...BLACK });
      }
    }
    return frame;
  }

  private renderMotion(effect: MotionEffect, frameNum: number, realFrame: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();

    switch (effect.type) {
      case 'candy_cane':
        return this.generateCandyCane(effect, frameNum);
      case 'checkerboard':
        return this.generateCheckerboard(effect, frameNum);
      case 'comet':
        return this.generateComet(effect, frameNum);
      case 'sparkle':
        return this.generateSparkle(effect, frameNum);
      case 'rainbow':
        return this.generateRainbow(effect, frameNum);
      case 'wave':
        return this.generateWave(effect, frameNum);
      case 'chase':
        // Chase was merged into Comet (a chase is a comet with no tail); older designs still render
        return this.generateComet(chaseAsComet(effect), frameNum);
      case 'converge':
        return this.generateConverge(effect, frameNum);
      case 'twinkle':
        return this.generateTwinkle(effect, realFrame);
      case 'fade':
        return this.generateFade(effect, realFrame);
      case 'lightning':
        return this.generateLightning(effect, realFrame);
      case 'fireworks':
        return this.generateFireworks(effect, realFrame);
      case 'fire':
        return this.generateFire(effect, frameNum);
      case 'strobe':
        return this.generateStrobe(effect, realFrame);
      case 'ripple':
        return this.generateRipple(effect, frameNum);
      case 'breathe':
        return this.generateBreathe(effect, frameNum);
      case 'text':
        return this.generateText(effect, frameNum);
      case 'ai':
        return this.generateAI(effect, frameNum);
      default:
        // Return all off
        for (const light of this.lights) {
          frame.set(light.light_id, { r: 0, g: 0, b: 0, w: 0 });
        }
        return frame;
    }
  }

  // Candy Cane - Diagonal candy stripes at an angle
  private generateCandyCane(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const color1: RGBW = effect.colors[0] || { r: 255, g: 0, b: 0, w: 0 };
    const color2: RGBW = effect.colors[1] || { r: 0, g: 0, b: 0, w: 255 };
    const width1 = Math.round(num(effect.params?.width1, 4, 1, 100));
    const width2 = Math.round(num(effect.params?.width2, 4, 1, 100));
    const period = width1 + width2;
    const step = Math.floor(frameNum / 15);
    // Stripe tilt from vertical; the original look is a slope of 2 lights per row (≈ -63.4°)
    const tilt = num(effect.params?.angle, -Math.atan(2) * 180 / Math.PI, -80, 80);
    const slope = Math.tan((tilt * Math.PI) / 180);

    for (let y = 0; y < this.rows; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        for (let j = 0; j < row.length; j++) {
          const light = row[j];
          const pos = ((Math.floor(j + y * slope + 1e-9) + step) % period + period) % period;
          frame.set(light.light_id, pos < width1 ? color1 : color2);
        }
      }
    }

    return frame;
  }

  // Checkerboard - alternating pattern that shifts
  private generateCheckerboard(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const color1: RGBW = effect.colors[0] || { r: 0, g: 0, b: 0, w: 255 };
    const color2: RGBW = effect.colors[1] || { r: 0, g: 0, b: 0, w: 0 };
    const step = Math.floor(frameNum / 15);

    for (let y = 0; y < this.rows; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        for (let j = 0; j < row.length; j++) {
          const light = row[j];
          const phase = (j + y + step) % 2;
          frame.set(light.light_id, phase === 0 ? color1 : color2);
        }
      }
    }

    return frame;
  }

  // Comet - bright head with fading tail
  private generateComet(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const headColor: RGBW = effect.colors[0] || { r: 0, g: 0, b: 0, w: 255 };
    const tailColor: RGBW = effect.colors[1] || headColor;
    const tailLength = Math.round(num(effect.params?.tailLength, 8, 0, 200));
    const reverse = bool(effect.params?.reverse, false);
    const bounce = bool(effect.params?.bounce, true);
    // Let the head travel past the edge until the whole tail has left the frame before looping/turning
    const tailExit = bool(effect.params?.tailExit, true);
    // Leading edge: this many lights at full head color in front of the fading tail
    const size = Math.round(num(effect.params?.size, 1, 1, 100));
    const step = Math.floor(frameNum / 4);
    const pause = pauseSteps(effect, 4);

    // Initialize all to off
    for (const light of this.lights) {
      frame.set(light.light_id, { r: 0, g: 0, b: 0, w: 0 });
    }

    const dir = angleVector(effect);

    for (let y = 0; y < this.rows; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        // Positions are measured along the angle axis; at 0° that's simply the index along the row
        const range = axisRange(row.length, this.rows, dir);
        const totalWidth = Math.round(range.max - range.min) + 1;
        // Head steps per pass; with tailExit the head runs tailLength past the edge so the tail fully clears
        const span = totalWidth + (tailExit ? tailLength + size - 1 : 0);
        // Bounce turns around without repeating a step. With tailExit each pass stops on the last
        // frame the tail is still visible and the next re-enters at the far edge (the turn happens
        // off-screen). Without it the leading edge reverses in place: out until it fills the far end,
        // back until one step short of the near end (all the way, when a pause follows), so neither
        // end is shown twice. With a 1-light head that's 0..W-1 out, W-2..1 back.
        const fwdStart = tailExit || pause > 0 ? 0 : Math.min(size - 1, totalWidth - 1);
        const out = tailExit ? span - 1 : totalWidth - fwdStart;
        const backStart = tailExit ? totalWidth - 1 : totalWidth - 1 - size;
        const backEnd = tailExit ? totalWidth - span + 1 : pause > 0 ? 0 : 1;
        const back = Math.max(0, backStart - backEnd + 1);

        let pos: number;
        let movingForward: boolean;

        const local = cycleStep(step, bounce ? Math.max(1, out + back) : span, pause);
        if (local === null) continue; // pausing before the next loop

        if (bounce) {
          const raw = local;
          if (raw >= out) {
            // Coming back: re-enter at the far edge and run past the near edge by the same margin
            pos = backStart - (raw - out);
            movingForward = false;
          } else {
            pos = fwdStart + raw;
            movingForward = true;
          }
        } else {
          pos = local;
          movingForward = true;
        }

        if (reverse) {
          pos = totalWidth - 1 - pos;
          movingForward = !movingForward;
        }

        const headU = range.min + pos;
        for (let j = 0; j < row.length; j++) {
          const u = j * dir.cos + y * dir.sin;
          const d = Math.round(movingForward ? headU - u : u - headU);
          // Inside the leading edge everything is full head color; the tail fades behind it
          const t = d < size ? 0 : d - (size - 1);
          // Tail length 0 is a plain chase: just the head block
          if (d >= 0 && (d < size || t < tailLength)) {
            const brightness = tailLength > 0 ? 1 - (t / tailLength) : 1;
            const colorRatio = tailLength > 0 ? t / tailLength : 0;
            const light = row[j];
            frame.set(light.light_id, {
              r: Math.round((headColor.r * (1 - colorRatio) + tailColor.r * colorRatio) * brightness),
              g: Math.round((headColor.g * (1 - colorRatio) + tailColor.g * colorRatio) * brightness),
              b: Math.round((headColor.b * (1 - colorRatio) + tailColor.b * colorRatio) * brightness),
              w: Math.round((headColor.w * (1 - colorRatio) + tailColor.w * colorRatio) * brightness),
            });
          }
        }
      }
    }

    return frame;
  }

  // Sparkle - random lights twinkling
  private generateSparkle(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const sparkleColor: RGBW = effect.colors[0] || { r: 0, g: 0, b: 0, w: 255 };
    const density = num(effect.params?.density, 0.15, 0, 1);
    const fadeSpeed = num(effect.params?.fadeSpeed, 0.3, 0.001, 10);

    // Use deterministic random based on frame for consistent playback
    const seed = frameNum * 12345;

    for (const light of this.lights) {
      // Create pseudo-random sparkle
      const hash = (light.light_id * 31 + seed) % 1000;
      const random = hash / 1000;

      if (random < density) {
        // Sparkle with varying brightness
        const brightness = Math.sin((frameNum + light.light_id) * fadeSpeed) * 0.5 + 0.5;
        frame.set(light.light_id, {
          r: Math.round(sparkleColor.r * brightness),
          g: Math.round(sparkleColor.g * brightness),
          b: Math.round(sparkleColor.b * brightness),
          w: Math.round(sparkleColor.w * brightness),
        });
      } else {
        frame.set(light.light_id, { r: 0, g: 0, b: 0, w: 0 });
      }
    }

    return frame;
  }

  // Rainbow - smooth color transition across the matrix
  private generateRainbow(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const dir = angleVector(effect);
    const adjust = bool(effect.params?.adjustDefective, false);

    for (let y = 0; y < this.rows; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        const range = axisRange(row.length, this.rows, dir);
        // One full rainbow across the segment along the angle (at 0° exactly j / row.length)
        const extent = range.max - range.min + 1;
        for (let j = 0; j < row.length; j++) {
          const light = row[j];
          const u = j * dir.cos + y * dir.sin - range.min;
          const hue = (((u / extent) * 360 + frameNum * 1) % 360 + 360) % 360;
          if (adjust && light.defective_channels) {
            frame.set(light.light_id, adjustForDeadChannels(this.hslToRgb(hue, 100, 50), light.defective_channels));
          } else {
            const rgb = this.hslToRgb(hue, 100, 50);
            frame.set(light.light_id, { ...rgb, w: 0 });
          }
        }
      }
    }

    return frame;
  }

  // Wave - sinusoidal brightness wave with multiple colors
  private generateWave(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const colors = effect.colors.length > 0 ? effect.colors : [{ r: 0, g: 0, b: 0, w: 255 }];
    const wavelength = num(effect.params?.wavelength, 10, 0.5, 1000);
    const bounce = bool(effect.params?.bounce, false);
    // Above 1 the troughs would go below zero brightness
    const waveHeight = num(effect.params?.waveHeight, 1.0, 0, 1);
    const dir = angleVector(effect);

    for (let y = 0; y < this.rows; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        const totalWidth = row.length;

        let timeFactor: number;
        if (bounce) {
          const cycleFrames = totalWidth * 10;
          const fullCycle = cycleFrames * 2;
          const pos = frameNum % fullCycle;
          timeFactor = pos < cycleFrames
            ? (pos / cycleFrames) * totalWidth / wavelength
            : ((fullCycle - pos) / cycleFrames) * totalWidth / wavelength;
        } else {
          timeFactor = frameNum * 0.05;
        }

        for (let j = 0; j < row.length; j++) {
          const light = row[j];
          const u = j * dir.cos + y * dir.sin;
          const phase = (u / wavelength + timeFactor) * Math.PI * 2;
          const sinVal = Math.sin(phase);
          const brightness = sinVal * (waveHeight / 2) + (1 - waveHeight / 2);

          // Interpolate between colors based on phase position
          let color: RGBW;
          if (colors.length === 1) {
            color = colors[0];
          } else {
            // Map the wave height (trough 0 .. peak 1) onto colors[0] .. colors[N-1], no wrap-around,
            // so troughs show the first color and peaks the last
            const normalizedPhase = (sinVal * 0.5 + 0.5); // 0..1
            const colorPos = normalizedPhase * (colors.length - 1);
            const idx = Math.min(Math.floor(colorPos), colors.length - 2);
            const nextIdx = idx + 1;
            const frac = colorPos - idx;
            const c1 = colors[idx];
            const c2 = colors[nextIdx];
            color = {
              r: c1.r * (1 - frac) + c2.r * frac,
              g: c1.g * (1 - frac) + c2.g * frac,
              b: c1.b * (1 - frac) + c2.b * frac,
              w: c1.w * (1 - frac) + c2.w * frac,
            };
          }

          frame.set(light.light_id, {
            r: Math.round(color.r * brightness),
            g: Math.round(color.g * brightness),
            b: Math.round(color.b * brightness),
            w: Math.round(color.w * brightness),
          });
        }
      }
    }

    return frame;
  }

  // Meet in the Middle - two groups start at opposite ends of each row and meet in the middle
  private generateConverge(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const leftColor: RGBW = effect.colors[0] || { r: 0, g: 0, b: 0, w: 255 };
    const rightColor: RGBW = effect.colors[1] || leftColor;
    const meetColor: RGBW | undefined = effect.colors[2];
    const groupSize = Math.round(num(effect.params?.groupSize, 3, 1, 1000));
    const tail = Math.round(num(effect.params?.tail, 0, 0, 100));
    const bounce = bool(effect.params?.bounce, false);
    const hold = Math.round(num(effect.params?.hold, 0, 0, 600) * FPS * effect.speed / 4);
    const step = Math.floor(frameNum / 4);
    const pause = pauseSteps(effect, 4);

    for (const light of this.lights) {
      frame.set(light.light_id, { ...BLACK });
    }

    for (let y = 0; y < this.rows; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        const len = row.length;
        // Furthest the heads get: the middle (they overlap on odd lengths)
        const maxHead = Math.ceil(len / 2) - 1;
        // Steps until the two heads reach the middle. On 1-2 light segments the ends already touch,
        // so spend one step apart before the meeting step instead of being "met" forever
        const travel = Math.max(2, maxHead + 1);
        // With bounce the outward pass stops one short of the ends when looping straight back in,
        // so the end position isn't shown twice (with a pause it runs all the way out first)
        const outward = bounce ? Math.max(0, pause > 0 ? travel - 1 : travel - 2) : 0;
        // Inward pass, optional hold while together, then (with bounce) the outward pass
        const cycle = travel + hold + outward;
        const local = cycleStep(step, cycle, pause);
        if (local === null) continue; // pausing before the next loop

        let head: number;
        if (local < travel) head = local;
        else if (local < travel + hold) head = travel - 1;
        else head = travel - 2 - (local - travel - hold);
        head = Math.min(head, maxHead);
        const met = local >= travel - 1 && local < travel + hold;
        const inward = local < travel + hold;

        // Comet tail behind each group: toward the ends on the way in, toward the middle on the way out
        const size = Math.min(groupSize, len);
        for (let k = 0; k < tail; k++) {
          const i = inward ? head - size - k : head + 1 + k;
          if (i < 0 || i >= len) continue;
          const fade = 1 - (k + 1) / (tail + 1);
          const dim = (c: RGBW): RGBW => ({ r: Math.round(c.r * fade), g: Math.round(c.g * fade), b: Math.round(c.b * fade), w: Math.round(c.w * fade) });
          if (row[i]) frame.set(row[i].light_id, dim(leftColor));
          if (row[len - 1 - i]) frame.set(row[len - 1 - i].light_id, dim(rightColor));
        }

        for (let g = 0; g < size; g++) {
          const i = head - g;
          if (i < 0) break;
          const fromLeft = row[i];
          const fromRight = row[len - 1 - i];
          if (fromLeft) frame.set(fromLeft.light_id, met && meetColor ? meetColor : leftColor);
          if (fromRight) frame.set(fromRight.light_id, met && meetColor ? meetColor : rightColor);
        }
      }
    }

    return frame;
  }

  // Twinkle - each light slowly fades in and out at random, gentler than Sparkle.
  // Timed in real frames so "Fade time" stays in seconds whatever the Speed
  private generateTwinkle(effect: MotionEffect, realFrame: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const palette = effect.colors.length > 0 ? effect.colors : [{ r: 0, g: 0, b: 0, w: 255 }];
    const density = num(effect.params?.density, 0.3, 0.02, 1);
    const fade = Math.max(2, Math.round(num(effect.params?.fadeTime, 1.5, 0.1, 10) * FPS));
    // Each light twinkles once per cycle; a longer cycle means fewer lights lit at once
    const cycle = Math.round((2 * fade) / density);

    for (const light of this.lights) {
      const offset = Math.floor(rand(light.light_id, 7) * cycle);
      const t = realFrame + offset;
      const n = Math.floor(t / cycle);
      const local = t - n * cycle;
      if (local < 2 * fade) {
        const color = palette[Math.floor(rand(light.light_id, n) * palette.length)];
        frame.set(light.light_id, scaleColor(color, Math.sin((Math.PI * local) / (2 * fade))));
      } else {
        frame.set(light.light_id, { ...BLACK });
      }
    }
    return frame;
  }

  // Color Fade - the whole roof crossfades through the palette (real frames: hold/fade are seconds)
  private generateFade(effect: MotionEffect, realFrame: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const palette = effect.colors.length > 0 ? effect.colors : [{ r: 255, g: 0, b: 0, w: 0 }, { r: 0, g: 0, b: 0, w: 255 }];
    const hold = Math.round(num(effect.params?.holdTime, 3, 0, 600) * FPS);
    const fade = Math.max(1, Math.round(num(effect.params?.fadeTime, 2, 0.1, 600) * FPS));
    const step = hold + fade;
    const n = Math.floor(realFrame / step);
    const local = realFrame - n * step;
    const from = palette[n % palette.length];
    const to = palette[(n + 1) % palette.length];
    const color = local < hold ? from : mixColor(from, to, (local - hold) / fade);
    for (const light of this.lights) frame.set(light.light_id, { ...color });
    return frame;
  }

  // Lightning - random strikes of a few quick flickers over a base color.
  // Real frames, so strikes per minute and the flicker timing hold at any Speed
  private generateLightning(effect: MotionEffect, realFrame: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const flash: RGBW = effect.colors[0] || { r: 0, g: 0, b: 0, w: 255 };
    const base: RGBW = effect.colors[1] || BLACK;
    const perMinute = num(effect.params?.frequency, 12, 1, 120);
    const coverage = num(effect.params?.coverage, 0.5, 0.1, 1);
    const slot = Math.max(10, Math.round((60 / perMinute) * FPS));
    const n = Math.floor(realFrame / slot);

    for (const light of this.lights) frame.set(light.light_id, { ...base });

    // Check this slot and the previous one so strikes near a boundary finish cleanly
    for (const k of [n - 1, n]) {
      const start = k * slot + Math.floor(rand(k, 1) * slot * 0.6);
      const t = realFrame - start;
      const flickers = 2 + Math.floor(rand(k, 2) * 3);
      if (t < 0 || t >= flickers * 5) continue;
      const f = Math.floor(t / 5);
      // Each flicker: bright flash that decays; later flickers are dimmer
      const level = (1 - (t % 5) / 5) * (0.5 + 0.5 * rand(k, 3, f)) * (f === 0 ? 1 : 0.8);
      const center = rand(k, 4);
      for (let y = 0; y < this.rows; y++) {
        for (const row of this.getSegments(y, effect.scope)) {
          const len = row.length;
          const width = Math.max(1, Math.round(len * coverage));
          const startX = Math.round(center * (len - width));
          for (let j = startX; j < startX + width && j < len; j++) {
            frame.set(row[j].light_id, maxColor(frame.get(row[j].light_id) || base, mixColor(base, flash, level)));
          }
        }
      }
    }
    return frame;
  }

  // Fireworks - bursts that expand from a random point and fade out (real frames: times are seconds)
  private generateFireworks(effect: MotionEffect, realFrame: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const palette = effect.colors.length > 0 ? effect.colors : [{ r: 255, g: 0, b: 0, w: 0 }, { r: 0, g: 0, b: 0, w: 255 }];
    // Each setting is a min-max range; every launch/burst picks its own value inside it
    const interval = range(effect.params?.interval, [1, 2], 0.2, 30).map(v => v * FPS) as [number, number];
    const life = range(effect.params?.burstTime, [1, 2], 0.2, 10).map(v => Math.max(6, v * FPS)) as [number, number];
    const size = range(effect.params?.burstSize, [4, 8], 1, 40);
    const count = range(effect.params?.count, [1, 1], 1, 10).map(Math.round) as [number, number];

    for (const light of this.lights) frame.set(light.light_id, { ...BLACK });

    // Launch slots are as long as the shortest interval; each slot launches with a probability that
    // makes the average gap the middle of the range (and never closer than the shortest gap)
    const slot = Math.max(6, Math.round(interval[0]));
    const chance = slot / Math.max(slot, (interval[0] + interval[1]) / 2);
    const n = Math.floor(realFrame / slot);
    const lookback = Math.ceil((life[1] + FPS * 0.4) / slot);

    type Burst = { x: number; y: number; color: RGBW; t: number; life: number; size: number };
    const bursts: Burst[] = [];
    for (let k = n - lookback; k <= n; k++) {
      if (k < 0 || rand(k, 9) >= chance) continue;
      const launch = k * slot + Math.floor(rand(k, 1) * slot * 0.5);
      const many = Math.round(within(count, rand(k, 8)));
      for (let m = 0; m < many; m++) {
        // Extra bursts in one launch go off a little after the first, up to 0.4 s apart
        const t = realFrame - launch - (m === 0 ? 0 : Math.floor(rand(k, m, 10) * FPS * 0.4));
        const burstLife = within(life, rand(k, m, 6));
        if (t < 0 || t >= burstLife) continue;
        bursts.push({
          x: rand(k, m, 2),
          y: rand(k, m, 3),
          color: palette[Math.floor(rand(k, m, 4) * palette.length)],
          t,
          life: burstLife,
          size: within(size, rand(k, m, 5)),
        });
      }
    }
    if (bursts.length === 0) return frame;

    for (let y = 0; y < this.rows; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        const len = row.length;
        for (const b of bursts) {
          const x0 = b.x * (len - 1);
          const y0 = b.y * (this.rows - 1);
          const p = b.t / b.life;
          const radius = b.size * Math.sqrt(p);
          const fadeOut = 1 - p;
          for (let j = 0; j < len; j++) {
            const d = Math.hypot(j - x0, (y - y0) * 1.5);
            // Bright ring at the burst edge, with a brief glow inside it just after the burst
            const ring = Math.max(0, 1 - Math.abs(d - radius));
            const glow = p < 0.25 && d < radius ? 0.3 * (1 - p / 0.25) : 0;
            const k2 = Math.max(ring, glow) * fadeOut;
            if (k2 > 0) frame.set(row[j].light_id, maxColor(frame.get(row[j].light_id)!, scaleColor(b.color, k2)));
          }
        }
      }
    }
    return frame;
  }

  // Fire - flickering heat, hotter at the bottom row; red -> orange -> yellow -> white
  private generateFire(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const intensity = num(effect.params?.intensity, 0.7, 0.1, 1);
    const flicker = Math.max(1, Math.round(4 / Math.max(0.25, num(effect.params?.flicker, 1, 0.25, 4))));
    const step = Math.floor(frameNum / flicker);
    const frac = (frameNum % flicker) / flicker;
    for (const light of this.lights) {
      // Smoothly interpolated noise per light
      const a = rand(light.light_id, step), b = rand(light.light_id, step + 1);
      const noise = a + (b - a) * frac;
      // Bottom row full heat, fading to half at the top row (1, 0.75, 0.5 on a 3-row roof)
      const rowHeat = this.rows > 1 ? 1 - 0.5 * Math.min(1, light.matrix_y / (this.rows - 1)) : 1;
      const heat = Math.max(0, Math.min(1, rowHeat * intensity * (0.55 + 0.6 * noise)));
      let c: RGBW;
      if (heat < 0.4) c = { r: Math.round(255 * (heat / 0.4)), g: 0, b: 0, w: 0 };
      else if (heat < 0.8) c = { r: 255, g: Math.round(160 * ((heat - 0.4) / 0.4)), b: 0, w: 0 };
      else c = { r: 255, g: 160 + Math.round(60 * ((heat - 0.8) / 0.2)), b: 0, w: Math.round(80 * ((heat - 0.8) / 0.2)) };
      frame.set(light.light_id, c);
    }
    return frame;
  }

  // Strobe - fast on/off flashing. Real frames, so the rate is flashes per real second at any Speed
  private generateStrobe(effect: MotionEffect, realFrame: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const palette = effect.colors.length > 0 ? effect.colors : [{ r: 0, g: 0, b: 0, w: 255 }];
    // 15/s is the most 30 FPS can show (one frame on, one off)
    const rate = num(effect.params?.rate, 4, 0.5, 15);
    const duty = num(effect.params?.duty, 0.3, 0.05, 0.95);
    const period = Math.max(2, Math.round(FPS / rate));
    // At least one frame on and one frame off per flash, or a high rate/duty never goes dark
    const onFrames = Math.min(period - 1, Math.max(1, Math.round(period * duty)));
    const f = Math.floor(realFrame);
    const n = Math.floor(f / period);
    const on = f - n * period < onFrames;
    // Cycle through the palette, one color per flash
    const color = palette[n % palette.length];
    for (const light of this.lights) frame.set(light.light_id, on ? { ...color } : { ...BLACK });
    return frame;
  }

  // Ripple - rings spreading outward from a point along each row
  private generateRipple(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const ringColor: RGBW = effect.colors[0] || { r: 0, g: 0, b: 0, w: 255 };
    const base: RGBW = effect.colors[1] || BLACK;
    const origin = num(effect.params?.origin, 50, 0, 100) / 100;
    const spacing = num(effect.params?.spacing, 8, 2, 64);
    // Wider than half the spacing and neighbouring rings merge into a solid band
    const width = Math.min(num(effect.params?.width, 1.5, 0.5, 10), spacing / 2);
    const travel = frameNum / 6; // lights per step outward
    const midRow = (this.rows - 1) / 2;
    for (let y = 0; y < this.rows; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        const x0 = origin * (row.length - 1);
        for (let j = 0; j < row.length; j++) {
          const d = Math.hypot(j - x0, (y - midRow) * 0.8);
          // Distance from the nearest ring (rings sit every `spacing` lights, moving outward)
          const phase = (((d - travel) % spacing) + spacing) % spacing;
          const dist = Math.min(phase, spacing - phase);
          const k = Math.max(0, 1 - dist / width);
          frame.set(row[j].light_id, mixColor(base, ringColor, k));
        }
      }
    }
    return frame;
  }

  // Breathe - all lights pulsing together
  private generateBreathe(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const breatheColor: RGBW = effect.colors[0] || { r: 0, g: 0, b: 0, w: 255 };
    // params.speed is the breath rate (radians per frame), separate from the design's Speed
    const speed = num(effect.params?.speed, 0.05, 0.001, 10);

    let brightness: number;
    const pause = pauseSteps(effect, 1);
    if (pause > 0) {
      // Each breath starts and ends dark, then holds dark for the pause
      const period = Math.round((2 * Math.PI) / speed);
      const t = cycleStep(Math.floor(frameNum), period, pause);
      brightness = t === null ? 0 : 0.5 - 0.5 * Math.cos(t * speed);
    } else {
      brightness = Math.sin(frameNum * speed) * 0.5 + 0.5;
    }

    for (const light of this.lights) {
      frame.set(light.light_id, {
        r: Math.round(breatheColor.r * brightness),
        g: Math.round(breatheColor.g * brightness),
        b: Math.round(breatheColor.b * brightness),
        w: Math.round(breatheColor.w * brightness),
      });
    }

    return frame;
  }

  // Text Scroll - scrolling text rendered with 3-row pixel font
  private generateText(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const textColor: RGBW = effect.colors[0] || { r: 0, g: 0, b: 0, w: 255 };
    const text = (typeof effect.params?.text === 'string' && effect.params.text ? effect.params.text : 'HELLO')
      .slice(0, MAX_TEXT_LENGTH).toUpperCase();
    const step = Math.floor(frameNum / 6);
    const pause = pauseSteps(effect, 6);

    // Initialize all to off
    for (const light of this.lights) {
      frame.set(light.light_id, { r: 0, g: 0, b: 0, w: 0 });
    }

    // Render text to bitmap
    const bitmap = this.renderTextBitmap(text);
    const bitmapWidth = bitmap[0]?.length || 0;
    if (bitmapWidth === 0) return frame;

    for (let y = 0; y < this.rows; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        const local = cycleStep(step, bitmapWidth + row.length, pause);
        if (local === null) continue; // pausing after the text has scrolled off
        for (let j = 0; j < row.length; j++) {
          const light = row[j];
          const bx = ((j + local) % (bitmapWidth + row.length) - row.length);
          if (bx >= 0 && bx < bitmapWidth && bitmap[2 - y]?.[bx]) {
            frame.set(light.light_id, textColor);
          }
        }
      }
    }

    return frame;
  }

  // Render text string into a 3-row bitmap
  private renderTextBitmap(text: string): boolean[][] {
    const rows: boolean[][] = [[], [], []];
    for (let i = 0; i < text.length; i++) {
      if (i > 0) {
        // 1-pixel gap between characters
        rows[0].push(false);
        rows[1].push(false);
        rows[2].push(false);
      }
      const glyph = PIXEL_FONT[text[i]] || PIXEL_FONT[' '];
      for (let y = 0; y < glyph.length; y++) {
        for (let x = 0; x < glyph[y].length; x++) {
          rows[y].push(glyph[y][x] === 1);
        }
      }
    }
    return rows;
  }

  // AI - executes custom JavaScript animation code generated by AI, inside a
  // node:vm sandbox with a per-frame timeout (see aiSandbox.ts)
  private generateAI(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const code = typeof effect.params?.code === 'string' ? effect.params.code : '';

    // Fallback: no code, fill with first color
    if (!code.trim()) {
      const color = effect.colors[0] || BLACK;
      for (const light of this.lights) {
        frame.set(light.light_id, { ...color });
      }
      return frame;
    }

    const result = this.aiRunner.run(code, frameNum, effect.colors, effect.scope || 'all');
    if (!result) {
      // Compile/runtime error, timeout, or temporarily disabled — blank frame
      for (const light of this.lights) frame.set(light.light_id, { ...BLACK });
      return frame;
    }

    for (const [id, color] of Object.entries(result)) {
      const lightId = parseInt(id, 10);
      if (!isNaN(lightId) && color) {
        const c = toRGBW(color);
        frame.set(lightId, { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b), w: Math.round(c.w) });
      }
    }

    return frame;
  }

  // Light/wall context handed to AI code (rebuilt on layout reload)
  private buildAILayout(): AILayout {
    const lights: AILayout['lights'] = [];
    let cx = 0;
    for (let wallIdx = 0; wallIdx < this.walls.length; wallIdx++) {
      const wall = this.walls[wallIdx];
      const matrix = this.lightMatrix.get(wall.id);
      if (!matrix) { cx += wall.width; continue; }
      for (let y = 0; y < wall.height; y++) {
        for (let x = 0; x < wall.width; x++) {
          const light = matrix[y]?.[x];
          if (light) {
            lights.push({ id: light.light_id, x, y, wallIndex: wallIdx, cx: cx + x, dead: (light.defective_channels || '').replace(/,/g, '') });
          }
        }
      }
      cx += wall.width;
    }
    return {
      lights,
      walls: this.walls.map(w => ({ name: w.name, width: w.width, height: w.height, groupId: w.group_id })),
      width: this.walls.reduce((s, w) => s + w.width, 0),
      height: this.walls.reduce((m, w) => Math.max(m, w.height), 0),
    };
  }

  // Helper: Convert HSL to RGB
  private hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
    s /= 100;
    l /= 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return {
      r: Math.round(255 * f(0)),
      g: Math.round(255 * f(8)),
      b: Math.round(255 * f(4)),
    };
  }

  getWalls(): Wall[] {
    return this.walls;
  }

  getLights(): Light[] {
    return this.lights;
  }

  getLightMatrix(): Map<string, Light[][]> {
    return this.lightMatrix;
  }
}

// Singleton
let effectEngine: EffectEngine | null = null;

export function getEffectEngine(): EffectEngine {
  if (!effectEngine) {
    effectEngine = new EffectEngine();
  }
  return effectEngine;
}
