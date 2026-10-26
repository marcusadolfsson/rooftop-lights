import { getDatabase } from '../models/database.js';
import { AICodeRunner, AILayout } from './aiSandbox.js';
import { getAudioInput, newMeterState, stepMeter, MeterOptions, MeterValue } from './audioInput.js';

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
// Wave crests move 6 lights per second at 1x
const WAVE_LIGHTS_PER_FRAME = 0.2;

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

/**
 * Like cycleStep, but for "Sync walls": the cycle is timed by the longest segment's phases and each
 * moving phase is stretched onto this segment's (shorter) phase, so every wall starts and finishes
 * each phase together. Phases of equal length (holds) map one to one. Null while paused.
 */
function syncedCycleStep(step: number, own: number[], longest: number[], pause: number): number | null {
  const local = cycleStep(step, longest.reduce((a, b) => a + b, 0), pause);
  if (local === null) return null;
  let a = 0;
  let b = 0;
  for (let i = 0; i < longest.length; i++) {
    const A = longest[i];
    const B = own[i] ?? 0;
    if (local < a + A) {
      // An empty phase on this segment: stay on the last step of the previous phase
      if (B <= 0) return Math.max(0, b - 1);
      return b + Math.min(B - 1, Math.floor(((local - a) * B) / A));
    }
    a += A;
    b += B;
  }
  return Math.max(0, b - 1);
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
  expand: 4,
  text: 6,
};

/** How long the Lightning bolt takes to drop one row (frames). */
const STRIKE_ROW_FRAMES = 2;

/** Stepped effects whose last step leads straight into the first (no restart to hide). */
const SEAMLESS_LOOP = new Set(['candy_cane', 'checkerboard']);

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

/** Scroll text exactly as generateText reads it from params. */
function scrollText(effect: MotionEffect): string {
  return (typeof effect.params?.text === 'string' && effect.params.text ? effect.params.text : 'HELLO')
    .slice(0, MAX_TEXT_LENGTH).toUpperCase();
}

/** Width in pixels of renderTextBitmap's output: glyph widths plus a 1-pixel gap between characters. */
function textBitmapWidth(text: string): number {
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    width += (i > 0 ? 1 : 0) + (PIXEL_FONT[text[i]] || PIXEL_FONT[' '])[0].length;
  }
  return width;
}

/** Effects timed in real frames (they ignore Speed); everything else gets a speed-scaled frame. */
const REAL_TIME_EFFECTS = new Set(['twinkle', 'fade', 'lightning', 'fireworks', 'strobe', 'audio']);

/** What the cycle length depends on in the layout: the segment lengths for the scope and the row count. */
export interface CycleLayout {
  segmentLengths: number[];
  rows: number;
}

/**
 * Length of one complete cycle of a motion effect, in real frames at 30 FPS: after this many frames
 * the effect shows its first frame again. Used for "play X times" in playlists. Segments of
 * different lengths loop at different rates, so the longest segment for the scope sets the cycle.
 * Returns null for effects with no natural cycle (random ones, AI code) or an empty layout.
 */
export function effectCycleFrames(rawEffect: unknown, layout: CycleLayout): number | null {
  let effect = normalizeMotionEffect(rawEffect);
  if (effect.type === 'chase') effect = chaseAsComet(effect);
  const p = effect.params ?? {};
  const len = Math.max(0, ...layout.segmentLengths);
  const rows = Math.max(1, layout.rows);

  // Cycle in the frame units the effect is driven by (speed-scaled, or real for real-time effects)
  let frames: number | null;
  switch (effect.type) {
    case 'comet': {
      if (len === 0) return null;
      const tailLength = Math.round(num(p.tailLength, 8, 0, 200));
      const bounce = bool(p.bounce, true);
      const tailExit = bool(p.tailExit, true);
      const size = Math.round(num(p.size, 1, 1, 100));
      const pause = pauseSteps(effect, 4);
      const range = axisRange(len, rows, angleVector(effect));
      const totalWidth = Math.round(range.max - range.min) + 1;
      // Same pass arithmetic as generateComet
      const span = totalWidth + (tailExit ? tailLength + size - 1 : 0);
      const fwdStart = tailExit || pause > 0 ? 0 : Math.min(size - 1, totalWidth - 1);
      const out = tailExit ? span - 1 : totalWidth - fwdStart;
      const backStart = tailExit ? totalWidth - 1 : totalWidth - 1 - size;
      const backEnd = tailExit ? totalWidth - span + 1 : pause > 0 ? 0 : 1;
      const back = Math.max(0, backStart - backEnd + 1);
      frames = 4 * ((bounce ? Math.max(1, out + back) : span) + pause);
      break;
    }
    case 'converge': {
      if (len === 0) return null;
      const bounce = bool(p.bounce, false);
      const hold = Math.round(num(p.hold, 0, 0, 600) * FPS * effect.speed / 4);
      const pause = pauseSteps(effect, 4);
      const travel = Math.max(2, Math.ceil(len / 2));
      const outward = bounce ? Math.max(0, pause > 0 ? travel - 1 : travel - 2) : 0;
      frames = 4 * (travel + hold + outward + pause);
      break;
    }
    case 'expand': {
      if (len === 0) return null;
      const center = (num(p.origin, 50, 0, 100) / 100) * (len - 1);
      const shrink = bool(p.shrink, false);
      const hold = Math.round((num(p.hold, 1, 0, 600) * FPS * effect.speed) / 4);
      const pause = pauseSteps(effect, 4);
      const reach = Math.ceil(Math.max(center, len - 1 - center)) + 1;
      frames = 4 * (reach + hold + (shrink ? reach : 0) + pause);
      break;
    }
    case 'text': {
      if (len === 0) return null;
      const width = textBitmapWidth(scrollText(effect));
      frames = width === 0 ? null : 6 * (width + len + pauseSteps(effect, 6));
      break;
    }
    case 'candy_cane':
      frames = 15 * (Math.round(num(p.width1, 4, 1, 100)) + Math.round(num(p.width2, 4, 1, 100)));
      break;
    case 'checkerboard':
      frames = 2 * 15;
      break;
    case 'rainbow':
      // Hue advances one degree per frame
      frames = 360;
      break;
    case 'wave': {
      const wavelength = num(p.wavelength, 8, 2, 1000);
      if (bool(p.bounce, false)) {
        if (len === 0) return null;
        // The offset slides out and back over 2 * extent lights
        const range = axisRange(len, rows, angleVector(effect));
        frames = (2 * (range.max - range.min + 1)) / WAVE_LIGHTS_PER_FRAME;
      } else {
        frames = wavelength / WAVE_LIGHTS_PER_FRAME;
      }
      break;
    }
    case 'ripple':
      // Rings move outward 1/6 light per frame and repeat every `spacing` lights
      frames = num(p.spacing, 8, 2, 64) * 6;
      break;
    case 'breathe': {
      const rate = num(p.speed, 0.05, 0.001, 10);
      const pause = pauseSteps(effect, 1);
      frames = pause > 0 ? Math.round((2 * Math.PI) / rate) + pause : (2 * Math.PI) / rate;
      break;
    }
    case 'fade': {
      const colors = effect.colors.length > 0 ? effect.colors.length : 2;
      const hold = Math.round(num(p.holdTime, 3, 0, 600) * FPS);
      const fade = Math.max(1, Math.round(num(p.fadeTime, 2, 0.1, 600) * FPS));
      frames = colors * (hold + fade);
      break;
    }
    case 'strobe': {
      const colors = Math.max(1, effect.colors.length);
      frames = colors * Math.max(2, Math.round(FPS / num(p.rate, 4, 0.5, 15)));
      break;
    }
    default:
      // sparkle, twinkle, lightning, fireworks, fire, ai: random or arbitrary, no cycle to count
      frames = null;
  }
  if (frames === null || !Number.isFinite(frames) || frames <= 0) return null;
  const real = REAL_TIME_EFFECTS.has(effect.type) ? frames : frames / effect.speed;
  return Math.max(1, Math.round(real));
}

/** Where the Audio Level meter fills from. */
export const AUDIO_ROTATIONS = ['left_right', 'right_left', 'center_out', 'bottom_top'] as const;
export type AudioRotation = typeof AUDIO_ROTATIONS[number];

/** Audio Level settings read from params (shared by live and simulated input). */
function audioMeterOptions(effect: MotionEffect): MeterOptions {
  const p = effect.params ?? {};
  return {
    attack: num(p.attack, 0.03, 0, 5),
    release: num(p.release, 0.15, 0, 10),
    gain: num(p.gain, 1, 0, 10),
    autoGain: bool(p.autoGain, false),
    peakHold: bool(p.peakHold, true),
    peakHoldTime: num(p.peakHoldTime, 1, 0, 10),
  };
}

/**
 * Music-like level (0..100) for the Audio Level effect's simulated input, a pure function of the
 * real frame: a kick on every beat that decays quickly, a softer off-beat, a little noise, and
 * 8-bar sections that get louder or quieter (with the odd quiet breakdown).
 */
export function simulatedAudioLevel(frame: number, bpm: number): number {
  const f = Math.floor(frame);
  const beatFrames = (FPS * 60) / Math.max(30, Math.min(300, bpm));
  const beat = Math.floor(f / beatFrames);
  const sinceBeat = (f - beat * beatFrames) / FPS;
  // Kick on every beat, off-beat hat, and a low floor between them so the meter swings widely
  // Each kick holds briefly at full strength so the meter's attack can reach the top
  const kick = (0.8 + 0.2 * rand(beat, 11)) * (sinceBeat < 0.08 ? 1 : Math.exp(-(sinceBeat - 0.08) / 0.1));
  const half = beatFrames / 2;
  const sinceHalf = sinceBeat * FPS >= half ? (sinceBeat * FPS - half) / FPS : Infinity;
  const hat = rand(beat, 12) < 0.8 ? 0.35 * Math.exp(-sinceHalf / 0.06) : 0;
  // 8-bar sections: mostly full, sometimes a quiet break, and a 4-bar build-up into each section
  const section = Math.floor(beat / 32);
  const inSection = (beat % 32) / 32;
  const base = rand(section, 13) < 0.15 ? 0.4 : 0.88 + 0.12 * rand(section, 14);
  const loudness = inSection >= 0.5 ? base * (0.6 + 0.4 * ((inSection - 0.5) / 0.5)) : base;
  const level = loudness * (100 * kick + 35 * hat) + 3 * rand(f, 15);
  return Math.max(0, Math.min(100, level));
}

/**
 * Simulated input run through the meter (gain, attack/release, peak hold). Replays the frames
 * leading up to `frame` from silence, enough for the smoothing to settle, so any frame renders the
 * same whenever it is asked for.
 */
function simulatedAudioMeter(frame: number, bpm: number, opts: MeterOptions): MeterValue {
  const settle = Math.max(5 * opts.attack, 5 * opts.release, opts.peakHold ? opts.peakHoldTime + 2 : 0);
  const window = Math.max(FPS, Math.min(10 * FPS, Math.ceil(settle * FPS)));
  const end = Math.floor(frame);
  const state = newMeterState();
  for (let f = end - window; f <= end; f++) {
    stepMeter(state, simulatedAudioLevel(f, bpm) * opts.gain, 1 / FPS, opts);
  }
  return { level: state.value / 100, peak: state.peak / 100 };
}

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

  /** effectCycleFrames against the current layout (only the chosen walls count for a limited Per Wall). */
  cycleFrames(rawEffect: unknown): number | null {
    const effect = normalizeMotionEffect(rawEffect);
    const wallIds = effect.scope === 'wall' ? selectedWallIds(effect).filter(id => this.walls.some(w => w.id === id)) : [];
    const keep = wallIds.length > 0 ? new Set(wallIds) : null;
    const segmentLengths: number[] = [];
    for (let y = 0; y < this.rows; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        if (!keep || keep.has(row[0].wall_id)) segmentLengths.push(row.length);
      }
    }
    return effectCycleFrames(effect, { segmentLengths, rows: this.rows });
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
      // Don't blend across the end of a cycle: the next step is the start of a new loop, and fading
      // into it shows the restart early (e.g. a scene item set to play once looks like it repeats)
      // Candy Cane and Checkerboard scroll seamlessly through their loop point, so they keep blending
      const cycle = SEAMLESS_LOOP.has(effect.type) ? null : this.cycleFrames(effect);
      const scaledCycle = cycle ? cycle * effect.speed : 0;
      const wraps = scaledCycle > 0 && Math.abs(((a + stepFrames) % scaledCycle + scaledCycle) % scaledCycle) < 1e-6;
      const t = wraps ? 0 : (frameNum - a) / stepFrames;
      const from = this.renderMotion(effect, a, real);
      const to = wraps ? from : this.renderMotion(effect, a + stepFrames, real);
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
      case 'sine':
        return this.generateSine(effect, frameNum, realFrame);
      case 'chase':
        // Chase was merged into Comet (a chase is a comet with no tail); older designs still render
        return this.generateComet(chaseAsComet(effect), frameNum);
      case 'converge':
        return this.generateConverge(effect, frameNum);
      case 'expand':
        return this.generateExpand(effect, frameNum);
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
      case 'audio':
        return this.generateAudio(effect, realFrame);
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

  /** Length of the longest segment for a scope (used to keep shorter walls in step with it). */
  private longestSegment(scope: MotionEffect['scope']): number {
    let longest = 0;
    for (let y = 0; y < this.rows; y++) {
      for (const row of this.getSegments(y, scope)) longest = Math.max(longest, row.length);
    }
    return longest;
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
    const sync = bool(effect.params?.syncWalls, false) && effect.scope !== 'all';

    // Pass geometry for a segment `len` lights long
    const passes = (len: number) => {
      // Positions are measured along the angle axis; at 0° that's simply the index along the row
      const range = axisRange(len, this.rows, dir);
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
      const phases = bounce ? (out + back > 0 ? [out, back] : [1]) : [span];
      return { range, totalWidth, fwdStart, out, backStart, phases };
    };
    const longest = sync ? passes(this.longestSegment(effect.scope)).phases : [];

    for (let y = 0; y < this.rows; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        const { range, totalWidth, fwdStart, out, backStart, phases } = passes(row.length);

        let pos: number;
        let movingForward: boolean;

        const local = sync
          ? syncedCycleStep(step, phases, longest, pause)
          : cycleStep(step, phases.reduce((a, b) => a + b, 0), pause);
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
    const wavelength = num(effect.params?.wavelength, 8, 2, 1000);
    const bounce = bool(effect.params?.bounce, false);
    // How dark the troughs get: 0 = flat brightness (only the colors move), 1 = troughs fully dark.
    // Older designs stored this as waveHeight.
    const depth = num(effect.params?.depth ?? effect.params?.waveHeight, 0.6, 0, 1);
    const dir = angleVector(effect);
    // The wave travels a fixed number of lights per second at 1x, whatever its wavelength
    const travel = frameNum * WAVE_LIGHTS_PER_FRAME;

    for (let y = 0; y < this.rows; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        const range = axisRange(row.length, this.rows, dir);
        const extent = range.max - range.min + 1;
        // Back and forth: the crests slide along the segment and back instead of rolling on
        const offset = bounce ? extent - Math.abs((travel % (2 * extent)) - extent) : travel;

        for (let j = 0; j < row.length; j++) {
          const light = row[j];
          const u = j * dir.cos + y * dir.sin;
          // 0 at a trough, 1 at a crest, moving toward higher u (left to right at 0°)
          const level = 0.5 + 0.5 * Math.cos(((u - offset) / wavelength) * Math.PI * 2);

          // Crests show the last color and troughs the first; extra colors sit in between
          let color: RGBW;
          if (colors.length === 1) {
            color = colors[0];
          } else {
            const pos = level * (colors.length - 1);
            const idx = Math.min(Math.floor(pos), colors.length - 2);
            color = mixColor(colors[idx], colors[idx + 1], pos - idx);
          }
          frame.set(light.light_id, scaleColor(color, 1 - depth * (1 - level)));
        }
      }
    }

    return frame;
  }

  // Expand - fills outward from a point (the middle by default) until the segment is full,
  // holds, then clears (or shrinks back) and starts again
  private generateExpand(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const fill: RGBW = effect.colors[0] || { r: 0, g: 0, b: 0, w: 255 };
    const background: RGBW = effect.colors[1] || BLACK;
    const origin = num(effect.params?.origin, 50, 0, 100) / 100;
    const shrink = bool(effect.params?.shrink, false);
    const hold = Math.round((num(effect.params?.hold, 1, 0, 600) * FPS * effect.speed) / 4);
    const step = Math.floor(frameNum / 4);
    const pause = pauseSteps(effect, 4);
    const sync = bool(effect.params?.syncWalls, false) && effect.scope !== 'all';
    // Steps until the fill reaches the farther end of a segment `len` lights long
    const reachOf = (len: number) => Math.ceil(Math.max(origin * (len - 1), len - 1 - origin * (len - 1))) + 1;
    const phasesOf = (reach: number) => [reach, hold, shrink ? reach : 0];
    const longest = sync ? phasesOf(reachOf(this.longestSegment(effect.scope))) : [];

    for (let y = 0; y < this.rows; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        const len = row.length;
        const center = origin * (len - 1);
        const reach = reachOf(len);
        const local = sync
          ? syncedCycleStep(step, phasesOf(reach), longest, pause)
          : cycleStep(step, reach + hold + (shrink ? reach : 0), pause);
        // Radius of the filled area (in lights from the center); -1 = nothing lit
        let radius: number;
        if (local === null) radius = -1;
        else if (local < reach) radius = local;
        else if (local < reach + hold) radius = reach - 1;
        else radius = reach - 1 - (local - reach - hold) - 1;
        for (let j = 0; j < len; j++) {
          // Half a light of slack so an even-length row starts with its two middle lights
          const lit = radius >= 0 && Math.abs(j - center) <= radius + 0.5;
          frame.set(row[j].light_id, lit ? { ...fill } : { ...background });
        }
      }
    }
    return frame;
  }

  // Sine Wave - a sine curve drawn across the rows, rolling along the walls. Each light's
  // brightness falls off with its distance from the curve, so the shape reads on a few rows.
  private generateSine(effect: MotionEffect, frameNum: number, realFrame: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const line: RGBW = effect.colors[0] || { r: 0, g: 0, b: 0, w: 255 };
    const background: RGBW = effect.colors[1] || BLACK;
    const wavelength = num(effect.params?.wavelength, 8, 2, 1000);
    const middle = (this.rows - 1) / 2;
    // Height is how many panels the curve covers from its top to its bottom (3 = all rows of a
    // 3-tall wall, 1 = a flat line on the middle row). Older designs stored the swing above/below
    // the middle as `height`, which is (span - 1) / 2.
    const span = effect.params?.span !== undefined
      ? num(effect.params.span, this.rows, 1, this.rows * 2)
      : 2 * num(effect.params?.height, middle, 0, this.rows) + 1;
    // Optional audio drive: the curve's height follows the level (silence = flat line on the middle
    // row, full level = the Height setting), from simulated music or a live audio source
    const audio = effect.params?.audio;
    let drive = 1;
    if (audio === 'random' || audio === 'api') {
      try {
        const meter = this.audioMeter({ ...effect, params: { ...effect.params, input: audio } }, realFrame);
        drive = Number.isFinite(meter.level) ? Math.max(0, Math.min(1, meter.level)) : 0;
      } catch {
        drive = 0;
      }
    }
    const height = ((span - 1) / 2) * drive;
    const thickness = num(effect.params?.thickness, 0.7, 0.2, 3);
    const reverse = bool(effect.params?.reverse, false);
    const travel = frameNum * WAVE_LIGHTS_PER_FRAME * (reverse ? -1 : 1);

    for (let y = 0; y < this.rows; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        for (let j = 0; j < row.length; j++) {
          const curveY = middle + height * Math.sin(((j - travel) / wavelength) * Math.PI * 2);
          const k = Math.max(0, 1 - Math.abs(y - curveY) / thickness);
          frame.set(row[j].light_id, mixColor(background, line, k));
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
    const sync = bool(effect.params?.syncWalls, false) && effect.scope !== 'all';

    for (const light of this.lights) {
      frame.set(light.light_id, { ...BLACK });
    }

    // Steps until the two heads reach the middle. On 1-2 light segments the ends already touch,
    // so spend one step apart before the meeting step instead of being "met" forever
    const travelOf = (len: number) => Math.max(2, Math.ceil(len / 2));
    // Inward pass, optional hold while together, then (with bounce) the outward pass. The outward
    // pass stops one short of the ends when looping straight back in, so the end position isn't
    // shown twice (with a pause it runs all the way out first)
    const phasesOf = (travel: number) => [travel, hold, bounce ? Math.max(0, pause > 0 ? travel - 1 : travel - 2) : 0];
    const longest = sync ? phasesOf(travelOf(this.longestSegment(effect.scope))) : [];

    for (let y = 0; y < this.rows; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        const len = row.length;
        // Furthest the heads get: the middle (they overlap on odd lengths)
        const maxHead = Math.ceil(len / 2) - 1;
        const travel = travelOf(len);
        const phases = phasesOf(travel);
        const local = sync
          ? syncedCycleStep(step, phases, longest, pause)
          : cycleStep(step, phases[0] + phases[1] + phases[2], pause);
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
    // Optional bolt: travels down from the top row, one row every STRIKE_ROW_FRAMES, to the middle of
    // the flash area, then the flickers start (the bolt stays lit through the first one)
    const strike = bool(effect.params?.strike, false);
    const strikeFrames = strike ? this.rows * STRIKE_ROW_FRAMES + 1 : 0;
    const light = (id: number, level: number) =>
      frame.set(id, maxColor(frame.get(id) || base, mixColor(base, flash, level)));

    for (const l of this.lights) frame.set(l.light_id, { ...base });

    // Check this slot and the previous one so strikes near a boundary finish cleanly
    for (const k of [n - 1, n]) {
      const start = k * slot + Math.floor(rand(k, 1) * slot * 0.6);
      const t = realFrame - start;
      const flickers = 2 + Math.floor(rand(k, 2) * 3);
      if (t < 0 || t >= strikeFrames + flickers * 5) continue;
      const center = rand(k, 4);
      const tf = t - strikeFrames; // time into the flickers (negative while the bolt is travelling)
      // The lit area is an irregular blob, not a box: each strike picks its own size around Coverage,
      // and each row of it gets its own width and a shifted middle
      const size = Math.min(1, coverage * (0.6 + 0.8 * rand(k, 8)));
      const rowSpan = (s: number, y: number, len: number) => {
        const w = Math.max(1, len * size);
        const mid = center * (len - w) + w / 2;
        return {
          mid: Math.max(0, Math.min(len - 1e-6, mid + (rand(k, 10, s, y) * 2 - 1) * w * 0.25)),
          half: Math.max(0.5, (w * (0.55 + 0.7 * rand(k, 9, s, y))) / 2),
        };
      };

      if (strike && tf < 5) {
        const head = Math.min(this.rows - 1, Math.floor(t / STRIKE_ROW_FRAMES));
        // Row 0 is the bottom, so the bolt walks down from the top row (d = rows dropped so far)
        for (let d = 0; d <= head; d++) {
          const y = this.rows - 1 - d;
          for (const [s, row] of this.getSegments(y, effect.scope).entries()) {
            const len = row.length;
            // Lands on the middle of the flash on the bottom row
            const target = rowSpan(s, 0, len).mid - 0.5;
            // Starts 10-40% of the wall to one side, so it always comes in at an angle,
            // with a little jitter per row so it isn't a straight line
            const offset = (rand(k, 5, s) < 0.5 ? -1 : 1) * (0.1 + 0.3 * rand(k, 7, s)) * len;
            const along = this.rows > 1 ? d / (this.rows - 1) : 1;
            const jitter = d > 0 && d < this.rows - 1 ? Math.round((rand(k, 6, s, d) * 2 - 1)) : 0;
            const x = Math.round(target + offset * (1 - along)) + jitter;
            if (x < 0 || x >= len) continue;
            // The tip is brightest; the path behind it glows, then fades with the first flicker
            const level = tf >= 0 ? 1 - tf / 5 : d === head ? 1 : 0.6;
            light(row[x].light_id, level);
          }
        }
      }
      if (tf < 0) continue;

      const f = Math.floor(tf / 5);
      // Each flicker: bright flash that decays; later flickers are dimmer
      const level = (1 - (tf % 5) / 5) * (0.5 + 0.5 * rand(k, 3, f)) * (f === 0 ? 1 : 0.8);
      for (let y = 0; y < this.rows; y++) {
        for (const [s, row] of this.getSegments(y, effect.scope).entries()) {
          const { mid, half } = rowSpan(s, y, row.length);
          for (let j = 0; j < row.length; j++) {
            const dist = Math.abs(j + 0.5 - mid);
            if (dist > half && Math.floor(mid) !== j) continue;
            // Soft, ragged edge: the outer part is dimmer and drops in and out between flickers
            if (dist > half * 0.6 && rand(k, 11, s, y * 1000 + j, f) < 0.3) continue;
            light(row[j].light_id, dist > half * 0.6 ? level * 0.55 : level);
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

  /** Audio Level's current level and peak (0..1): live input from a source, or the simulation. */
  private audioMeter(effect: MotionEffect, realFrame: number): MeterValue {
    const opts = audioMeterOptions(effect);
    if (effect.params?.input === 'api') {
      const source = typeof effect.params.source === 'string' ? effect.params.source.trim() : '';
      return getAudioInput().meterLevel(source, opts);
    }
    return simulatedAudioMeter(realFrame, num(effect.params?.bpm, 120, 30, 300), opts);
  }

  // Audio Level - a level meter: lights fill along each segment (or up the rows) with the live
  // audio level, in a gradient from the Low to the High color, with an optional peak-hold marker.
  // Real frames: attack, release and hold are in seconds whatever the Speed
  private generateAudio(effect: MotionEffect, realFrame: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const low: RGBW = effect.colors[0] || { r: 0, g: 255, b: 0, w: 0 };
    const mid: RGBW = effect.colors[1] || { r: 255, g: 180, b: 0, w: 0 };
    const high: RGBW = effect.colors[2] || { r: 255, g: 0, b: 0, w: 0 };
    const background: RGBW = effect.colors[3] || BLACK;
    const rotation: AudioRotation = (AUDIO_ROTATIONS as readonly unknown[]).includes(effect.params?.rotation)
      ? effect.params?.rotation as AudioRotation
      : 'left_right';
    const smooth = bool(effect.params?.smooth, true);
    const peakHold = bool(effect.params?.peakHold, true);

    let meter: MeterValue;
    try {
      meter = this.audioMeter(effect, realFrame);
    } catch {
      meter = { level: 0, peak: 0 };
    }
    const level = Number.isFinite(meter.level) ? Math.max(0, Math.min(1, meter.level)) : 0;
    const peak = Number.isFinite(meter.peak) ? Math.max(0, Math.min(1, meter.peak)) : 0;

    const gradient = (p: number): RGBW => (p < 0.5 ? mixColor(low, mid, p * 2) : mixColor(mid, high, (p - 0.5) * 2));
    // Light `i` of `n` along the meter: lit as far as the level reaches (the boundary light
    // partly when smooth), plus the peak marker above the fill
    const colorAt = (i: number, n: number): RGBW => {
      const fill = level * n;
      const k = smooth ? Math.max(0, Math.min(1, fill - i)) : (i < Math.round(fill) ? 1 : 0);
      const c = gradient(n > 1 ? i / (n - 1) : 1);
      if (peakHold && peak > 0.005 && k < 1 && i === Math.max(0, Math.min(n - 1, Math.ceil(peak * n) - 1))) return c;
      return k > 0 ? mixColor(background, c, k) : { ...background };
    };

    for (const light of this.lights) frame.set(light.light_id, { ...background });

    if (rotation === 'bottom_top') {
      // Fills up the rows: each wall by its own height (Continuous uses the tallest wall)
      const heights = new Map(this.walls.map(w => [w.id, w.height]));
      for (const light of this.lights) {
        const n = effect.scope === 'all' ? this.rows : Math.max(1, heights.get(light.wall_id) ?? this.rows);
        if (light.matrix_y < n) frame.set(light.light_id, colorAt(light.matrix_y, n));
      }
      return frame;
    }

    for (let y = 0; y < this.rows; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        const len = row.length;
        if (rotation === 'center_out') {
          // Both halves fill outward from the middle; odd lengths share the middle light
          const center = (len - 1) / 2;
          const n = Math.ceil(len / 2);
          for (let j = 0; j < len; j++) frame.set(row[j].light_id, colorAt(Math.floor(Math.abs(j - center)), n));
        } else {
          for (let j = 0; j < len; j++) {
            frame.set(row[j].light_id, colorAt(rotation === 'right_left' ? len - 1 - j : j, len));
          }
        }
      }
    }
    return frame;
  }

  // Text Scroll - scrolling text rendered with 3-row pixel font
  private generateText(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const textColor: RGBW = effect.colors[0] || { r: 0, g: 0, b: 0, w: 255 };
    const text = scrollText(effect);
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
