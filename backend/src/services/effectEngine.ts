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
  wallIds?: string[];
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

function bool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}

const ROWS = 3;

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

/** Range of the projected coordinate u = x*cos + y*sin over a segment `width` lights wide and ROWS tall. */
function axisRange(width: number, v: { cos: number; sin: number }): { min: number; max: number } {
  const xs = [0, (width - 1) * v.cos];
  const ys = [0, (ROWS - 1) * v.sin];
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

/** Position within a cycle of `cycle` steps followed by `pause` dark steps; null while paused. */
function cycleStep(step: number, cycle: number, pause: number): number | null {
  if (cycle <= 0) return null;
  const m = step % (cycle + pause);
  return m < cycle ? m : null;
}

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
    wallIds: Array.isArray(e.wallIds) ? e.wallIds as string[] : undefined,
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
  private currentFrame: number = 0;
  private walls: Wall[] = [];
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

  // Generate frame for motion effect
  generateMotionFrame(rawEffect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const effect = normalizeMotionEffect(rawEffect);
    const frame = this.renderMotion(effect, frameNum);

    // Per Wall can be limited to chosen walls; everything else stays dark
    const wallIds = effect.scope === 'wall' ? selectedWallIds(effect) : [];
    if (wallIds.length > 0) {
      const keep = new Set(wallIds);
      for (const light of this.lights) {
        if (!keep.has(light.wall_id)) frame.set(light.light_id, { ...BLACK });
      }
    }
    return frame;
  }

  private renderMotion(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    this.currentFrame = frameNum;
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
        return this.generateChase(effect, frameNum);
      case 'converge':
        return this.generateConverge(effect, frameNum);
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
    const width1 = Math.round(num(effect.params?.width1 || 4, 4, 1, 100));
    const width2 = Math.round(num(effect.params?.width2 || 4, 4, 1, 100));
    const period = width1 + width2;
    const step = Math.floor(frameNum / 15);
    // Stripe tilt from vertical; the original look is a slope of 2 lights per row (≈ -63.4°)
    const tilt = num(effect.params?.angle, -Math.atan(2) * 180 / Math.PI, -80, 80);
    const slope = Math.tan((tilt * Math.PI) / 180);

    for (let y = 0; y < 3; y++) {
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

    for (let y = 0; y < 3; y++) {
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
    const tailLength = Math.round(num(effect.params?.tailLength || 8, 8, 1, 200));
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

    for (let y = 0; y < 3; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        // Positions are measured along the angle axis; at 0° that's simply the index along the row
        const range = axisRange(row.length, dir);
        const totalWidth = Math.round(range.max - range.min) + 1;
        // Head steps per pass; with tailExit the head runs tailLength past the edge so the tail fully clears
        const span = totalWidth + (tailExit ? tailLength + size - 1 : 0);

        let pos: number;
        let movingForward: boolean;

        const local = cycleStep(step, bounce ? span * 2 : span, pause);
        if (local === null) continue; // pausing before the next loop

        if (bounce) {
          const raw = local;
          if (raw >= span) {
            // Coming back: re-enter at the far edge and run past the near edge by the same margin
            pos = totalWidth - 1 - (raw - span);
            movingForward = false;
          } else {
            pos = raw;
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
          if (d >= 0 && t < tailLength) {
            const brightness = 1 - (t / tailLength);
            const colorRatio = t / tailLength;
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
    const density = num(effect.params?.density || 0.15, 0.15, 0, 1);
    const fadeSpeed = num(effect.params?.fadeSpeed || 0.3, 0.3, 0.001, 10);

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

    for (let y = 0; y < 3; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        const range = axisRange(row.length, dir);
        // One full rainbow across the segment along the angle (at 0° exactly j / row.length)
        const extent = range.max - range.min + 1;
        for (let j = 0; j < row.length; j++) {
          const light = row[j];
          const u = j * dir.cos + y * dir.sin - range.min;
          const hue = (((u / extent) * 360 + frameNum * 1) % 360 + 360) % 360;
          const rgb = this.hslToRgb(hue, 100, 50);
          frame.set(light.light_id, { ...rgb, w: 0 });
        }
      }
    }

    return frame;
  }

  // Wave - sinusoidal brightness wave with multiple colors
  private generateWave(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const colors = effect.colors.length > 0 ? effect.colors : [{ r: 0, g: 0, b: 0, w: 255 }];
    const wavelength = num(effect.params?.wavelength || 10, 10, 0.5, 1000);
    const bounce = bool(effect.params?.bounce, false);
    const waveHeight = num(effect.params?.waveHeight, 1.0, 0, 2);
    const dir = angleVector(effect);

    for (let y = 0; y < 3; y++) {
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
            // Map sin phase [0, 2*PI] to color position [0, N]
            const normalizedPhase = (sinVal * 0.5 + 0.5); // 0..1
            const colorPos = normalizedPhase * colors.length;
            const idx = Math.floor(colorPos) % colors.length;
            const nextIdx = (idx + 1) % colors.length;
            const frac = colorPos - Math.floor(colorPos);
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

  // Chase - single light or group chasing around
  private generateChase(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const chaseColor: RGBW = effect.colors[0] || { r: 0, g: 0, b: 0, w: 255 };
    const groupSize = Math.round(num(effect.params?.groupSize || 3, 3, 1, 1000));
    const step = Math.floor(frameNum / 4);
    const pause = pauseSteps(effect, 4);

    // Initialize all to off
    for (const light of this.lights) {
      frame.set(light.light_id, { r: 0, g: 0, b: 0, w: 0 });
    }

    for (let y = 0; y < 3; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        const size = Math.min(groupSize, row.length);
        if (pause === 0) {
          // Continuous lap: the group wraps from the end straight back to the start
          const pos = step % row.length;
          for (let g = 0; g < size; g++) {
            frame.set(row[(pos + g) % row.length].light_id, chaseColor);
          }
          continue;
        }
        // With a pause the group slides in from the start and fully off the end (no wrap-around),
        // so nothing is lit at the beginning while the lap finishes
        const local = cycleStep(step, row.length + size - 1, pause);
        if (local === null) continue; // pausing after a full lap
        const pos = local - (size - 1);
        for (let g = 0; g < size; g++) {
          const idx = pos + g;
          if (idx >= 0 && idx < row.length) frame.set(row[idx].light_id, chaseColor);
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
    const groupSize = Math.round(num(effect.params?.groupSize || 3, 3, 1, 1000));
    const tail = Math.round(num(effect.params?.tail, 0, 0, 100));
    const bounce = bool(effect.params?.bounce, false);
    const hold = Math.round(num(effect.params?.hold, 0, 0, 600) * FPS * effect.speed / 4);
    const step = Math.floor(frameNum / 4);
    const pause = pauseSteps(effect, 4);

    for (const light of this.lights) {
      frame.set(light.light_id, { ...BLACK });
    }

    for (let y = 0; y < 3; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        const len = row.length;
        // Steps until the two heads reach the middle (they overlap on odd lengths)
        const travel = Math.ceil(len / 2);
        // Inward pass, optional hold while together, then (with bounce) the outward pass
        const cycle = travel + hold + (bounce ? travel - 1 : 0);
        const local = cycleStep(step, cycle, pause);
        if (local === null) continue; // pausing before the next loop

        let head: number;
        if (local < travel) head = local;
        else if (local < travel + hold) head = travel - 1;
        else head = travel - 2 - (local - travel - hold);
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

  // Breathe - all lights pulsing together
  private generateBreathe(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const breatheColor: RGBW = effect.colors[0] || { r: 0, g: 0, b: 0, w: 255 };
    const speed = num(effect.params?.speed || 0.05, 0.05, 0.0001, 10);

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

    for (let y = 0; y < 3; y++) {
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
      for (let y = 0; y < 3; y++) {
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
