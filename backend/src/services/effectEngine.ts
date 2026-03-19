import { getDatabase } from '../models/database.js';

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
  private aiCodeCache: Map<string, Function> = new Map();
  private aiLightContext: any[] | null = null;

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
    this.aiLightContext = null;
    this.aiCodeCache.clear();
  }

  // Get all lights in a continuous row (considering wall connections)
  getContinuousRow(y: number): Light[] {
    const row: Light[] = [];
    for (const wall of this.walls) {
      const matrix = this.lightMatrix.get(wall.id);
      if (matrix && matrix[y]) {
        row.push(...matrix[y]);
      }
    }
    return row;
  }

  // Get light segments based on scope: one continuous row, per-wall rows, or per-group rows
  getSegments(y: number, scope: 'wall' | 'all' | 'group'): Light[][] {
    if (scope === 'wall') {
      return this.walls.map(wall => {
        const matrix = this.lightMatrix.get(wall.id);
        return matrix && matrix[y] ? [...matrix[y]] : [];
      }).filter(row => row.length > 0);
    }
    if (scope === 'group') {
      // Walls sharing a group_id form one continuous segment; ungrouped walls get their own segment
      const segments: Light[][] = [];
      const groupMap = new Map<string, Light[]>();
      for (const wall of this.walls) {
        const matrix = this.lightMatrix.get(wall.id);
        const row = matrix && matrix[y] ? [...matrix[y]] : [];
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
    return [this.getContinuousRow(y)];
  }

  // Generate frame for static design
  generateStaticFrame(design: StaticDesign): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    for (const light of this.lights) {
      const color = design.colors[light.light_id] || { r: 0, g: 0, b: 0, w: 0 };
      frame.set(light.light_id, color);
    }
    return frame;
  }

  // Generate frame for motion effect
  generateMotionFrame(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
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
    const width1 = (effect.params?.width1 as number) || 4;
    const width2 = (effect.params?.width2 as number) || 4;
    const period = width1 + width2;
    const step = Math.floor(frameNum / 15);

    for (let y = 0; y < 3; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        for (let j = 0; j < row.length; j++) {
          const light = row[j];
          const pos = ((j - y * 2 + step) % period + period) % period;
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
    const tailLength = (effect.params?.tailLength as number) || 8;
    const reverse = (effect.params?.reverse as boolean) || false;
    const bounce = effect.params?.bounce !== undefined ? (effect.params.bounce as boolean) : true;
    const step = Math.floor(frameNum / 4);

    // Initialize all to off
    for (const light of this.lights) {
      frame.set(light.light_id, { r: 0, g: 0, b: 0, w: 0 });
    }

    for (let y = 0; y < 3; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        const totalWidth = row.length;

        let pos: number;
        let movingForward: boolean;

        if (bounce) {
          const cycleLength = totalWidth * 2;
          const raw = step % cycleLength;
          if (raw >= totalWidth) {
            pos = cycleLength - raw - 1;
            movingForward = false;
          } else {
            pos = raw;
            movingForward = true;
          }
        } else {
          pos = step % totalWidth;
          movingForward = true;
        }

        if (reverse) {
          pos = totalWidth - 1 - pos;
          movingForward = !movingForward;
        }

        for (let t = 0; t < tailLength; t++) {
          const tailPos = movingForward ? pos - t : pos + t;
          if (tailPos >= 0 && tailPos < row.length) {
            const brightness = 1 - (t / tailLength);
            const colorRatio = t / tailLength;
            const light = row[tailPos];
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
    const density = (effect.params?.density as number) || 0.15;
    const fadeSpeed = (effect.params?.fadeSpeed as number) || 0.3;

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

    for (let y = 0; y < 3; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        for (let j = 0; j < row.length; j++) {
          const light = row[j];
          const hue = ((j / row.length) * 360 + frameNum * 1) % 360;
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
    const wavelength = (effect.params?.wavelength as number) || 10;
    const bounce = (effect.params?.bounce as boolean) || false;
    const waveHeight = (effect.params?.waveHeight as number) ?? 1.0;

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
          const phase = (j / wavelength + timeFactor) * Math.PI * 2;
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
    const groupSize = (effect.params?.groupSize as number) || 3;
    const step = Math.floor(frameNum / 4);

    // Initialize all to off
    for (const light of this.lights) {
      frame.set(light.light_id, { r: 0, g: 0, b: 0, w: 0 });
    }

    for (let y = 0; y < 3; y++) {
      for (const row of this.getSegments(y, effect.scope)) {
        const pos = step % row.length;

        for (let g = 0; g < groupSize; g++) {
          const idx = (pos + g) % row.length;
          frame.set(row[idx].light_id, chaseColor);
        }
      }
    }

    return frame;
  }

  // Breathe - all lights pulsing together
  private generateBreathe(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const breatheColor: RGBW = effect.colors[0] || { r: 0, g: 0, b: 0, w: 255 };
    const speed = (effect.params?.speed as number) || 0.05;

    const brightness = Math.sin(frameNum * speed) * 0.5 + 0.5;

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
    const text = ((effect.params?.text as string) || 'HELLO').toUpperCase();
    const step = Math.floor(frameNum / 6);

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
        for (let j = 0; j < row.length; j++) {
          const light = row[j];
          const bx = ((j + step) % (bitmapWidth + row.length) - row.length);
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

  // AI - executes custom JavaScript animation code generated by AI
  private generateAI(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const code = effect.params?.code as string;

    // Fallback: no code, fill with first color
    if (!code) {
      const color = effect.colors[0] || { r: 0, g: 0, b: 0, w: 0 };
      for (const light of this.lights) {
        frame.set(light.light_id, { ...color });
      }
      return frame;
    }

    // Compile function (cached by code string)
    let fn = this.aiCodeCache.get(code);
    if (!fn) {
      try {
        fn = new Function('ctx', code);
        this.aiCodeCache.set(code, fn);
      } catch {
        for (const light of this.lights) {
          frame.set(light.light_id, { r: 0, g: 0, b: 0, w: 0 });
        }
        return frame;
      }
    }

    // Build context for the AI code
    const ctx = {
      frame: frameNum,
      colors: effect.colors,
      lights: this.getAILightContext(),
      walls: this.walls.map(w => ({ name: w.name, width: w.width, height: w.height })),
      width: this.walls.reduce((s, w) => s + w.width, 0),
      height: Math.max(...this.walls.map(w => w.height)),
    };

    try {
      const result = fn(ctx) as Record<number, RGBW>;
      if (result && typeof result === 'object') {
        for (const [id, color] of Object.entries(result)) {
          const lightId = parseInt(id);
          if (!isNaN(lightId) && color) {
            frame.set(lightId, {
              r: Math.max(0, Math.min(255, Math.round(color.r || 0))),
              g: Math.max(0, Math.min(255, Math.round(color.g || 0))),
              b: Math.max(0, Math.min(255, Math.round(color.b || 0))),
              w: Math.max(0, Math.min(255, Math.round(color.w || 0))),
            });
          }
        }
      }
    } catch {
      // Runtime error — blank frame
      for (const light of this.lights) {
        frame.set(light.light_id, { r: 0, g: 0, b: 0, w: 0 });
      }
    }

    return frame;
  }

  // Precomputed light context for AI code (cached, invalidated on layout reload)
  private getAILightContext(): any[] {
    if (this.aiLightContext) return this.aiLightContext;

    const result: any[] = [];
    let cx = 0;
    for (let wallIdx = 0; wallIdx < this.walls.length; wallIdx++) {
      const wall = this.walls[wallIdx];
      const matrix = this.lightMatrix.get(wall.id);
      if (!matrix) { cx += wall.width; continue; }
      for (let y = 0; y < wall.height; y++) {
        for (let x = 0; x < wall.width; x++) {
          const light = matrix[y]?.[x];
          if (light) {
            result.push({
              id: light.light_id,
              x,
              y,
              wallIndex: wallIdx,
              cx: cx + x,
            });
          }
        }
      }
      cx += wall.width;
    }
    this.aiLightContext = result;
    return result;
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
