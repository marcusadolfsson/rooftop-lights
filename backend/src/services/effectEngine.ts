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
}

export interface Wall {
  id: string;
  name: string;
  width: number;
  height: number;
  position: number;
  connects_to_next: number;
}

export interface MotionEffect {
  type: string;
  speed: number;
  colors: RGBW[];
  scope: 'wall' | 'all';
  wallIds?: string[];
  params?: Record<string, unknown>;
}

export interface StaticDesign {
  colors: Record<number, RGBW>; // light_id -> color
}

export class EffectEngine {
  private currentFrame: number = 0;
  private walls: Wall[] = [];
  private lights: Light[] = [];
  private lightMatrix: Map<string, Light[][]> = new Map(); // wall_id -> 2D array

  constructor() {
    this.loadLayout();
  }

  loadLayout(): void {
    const db = getDatabase();
    this.walls = db.prepare('SELECT * FROM walls ORDER BY position').all() as Wall[];
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
      default:
        // Return all off
        for (const light of this.lights) {
          frame.set(light.light_id, { r: 0, g: 0, b: 0, w: 0 });
        }
        return frame;
    }
  }

  // Candy Cane - Red and white diagonal stripes
  private generateCandyCane(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const red: RGBW = effect.colors[0] || { r: 255, g: 0, b: 0, w: 0 };
    const white: RGBW = effect.colors[1] || { r: 0, g: 0, b: 0, w: 255 };

    for (let y = 0; y < 3; y++) {
      const row = this.getContinuousRow(y);
      for (let j = 0; j < row.length; j++) {
        const light = row[j];
        // Create diagonal barber pole effect
        const phase = (j + y + frameNum) % 2;
        frame.set(light.light_id, phase === 0 ? red : white);
      }
    }

    return frame;
  }

  // Checkerboard - alternating pattern that shifts
  private generateCheckerboard(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const color1: RGBW = effect.colors[0] || { r: 0, g: 0, b: 0, w: 255 };
    const color2: RGBW = effect.colors[1] || { r: 0, g: 0, b: 0, w: 0 };

    for (let y = 0; y < 3; y++) {
      const row = this.getContinuousRow(y);
      for (let j = 0; j < row.length; j++) {
        const light = row[j];
        const phase = (j + y + frameNum) % 2;
        frame.set(light.light_id, phase === 0 ? color1 : color2);
      }
    }

    return frame;
  }

  // Comet - bright head with fading tail
  private generateComet(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const cometColor: RGBW = effect.colors[0] || { r: 0, g: 0, b: 0, w: 255 };
    const tailLength = (effect.params?.tailLength as number) || 8;
    const reverse = (effect.params?.reverse as boolean) || false;

    // Initialize all to off
    for (const light of this.lights) {
      frame.set(light.light_id, { r: 0, g: 0, b: 0, w: 0 });
    }

    for (let y = 0; y < 3; y++) {
      const row = this.getContinuousRow(y);
      const totalWidth = row.length;

      // Comet position (bounces back and forth)
      const cycleLength = totalWidth * 2;
      let pos = frameNum % cycleLength;

      if (pos >= totalWidth) {
        pos = cycleLength - pos - 1;
      }

      if (reverse) {
        pos = totalWidth - 1 - pos;
      }

      // Draw comet head and tail
      for (let t = 0; t < tailLength; t++) {
        const tailPos = reverse ? pos + t : pos - t;
        if (tailPos >= 0 && tailPos < row.length) {
          const brightness = 1 - (t / tailLength);
          const light = row[tailPos];
          frame.set(light.light_id, {
            r: Math.round(cometColor.r * brightness),
            g: Math.round(cometColor.g * brightness),
            b: Math.round(cometColor.b * brightness),
            w: Math.round(cometColor.w * brightness),
          });
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
      const row = this.getContinuousRow(y);
      for (let j = 0; j < row.length; j++) {
        const light = row[j];
        // Calculate hue based on position and frame
        const hue = ((j / row.length) * 360 + frameNum * 5) % 360;
        const rgb = this.hslToRgb(hue, 100, 50);
        frame.set(light.light_id, { ...rgb, w: 0 });
      }
    }

    return frame;
  }

  // Wave - sinusoidal brightness wave
  private generateWave(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const waveColor: RGBW = effect.colors[0] || { r: 0, g: 0, b: 0, w: 255 };
    const wavelength = (effect.params?.wavelength as number) || 10;

    for (let y = 0; y < 3; y++) {
      const row = this.getContinuousRow(y);
      for (let j = 0; j < row.length; j++) {
        const light = row[j];
        const phase = (j / wavelength + frameNum * 0.1) * Math.PI * 2;
        const brightness = Math.sin(phase) * 0.5 + 0.5;
        frame.set(light.light_id, {
          r: Math.round(waveColor.r * brightness),
          g: Math.round(waveColor.g * brightness),
          b: Math.round(waveColor.b * brightness),
          w: Math.round(waveColor.w * brightness),
        });
      }
    }

    return frame;
  }

  // Chase - single light or group chasing around
  private generateChase(effect: MotionEffect, frameNum: number): Map<number, RGBW> {
    const frame = new Map<number, RGBW>();
    const chaseColor: RGBW = effect.colors[0] || { r: 0, g: 0, b: 0, w: 255 };
    const groupSize = (effect.params?.groupSize as number) || 3;

    // Initialize all to off
    for (const light of this.lights) {
      frame.set(light.light_id, { r: 0, g: 0, b: 0, w: 0 });
    }

    for (let y = 0; y < 3; y++) {
      const row = this.getContinuousRow(y);
      const pos = frameNum % row.length;

      for (let g = 0; g < groupSize; g++) {
        const idx = (pos + g) % row.length;
        frame.set(row[idx].light_id, chaseColor);
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
