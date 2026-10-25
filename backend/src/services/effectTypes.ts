import { STEP_FRAMES } from './effectEngine.js';
import { applyLayoutDefaults } from './layoutDefaults.js';

// The built-in motion effects: what the editor shows (GET /api/designs/effects/types) and what the
// AI scene creator may pick from. Params carry their type, range and label; defaults are tuned to
// the installed layout by applyLayoutDefaults.

// showIf hides a param in the editor unless another param has the given value
type ParamCommon = { label?: string; showIf?: { param: string; equals: unknown } };

export type EffectParamDef =
  | ({ type: 'number'; default: number; min?: number; max?: number; step?: number; unit?: string } & ParamCommon)
  | ({ type: 'boolean'; default: boolean } & ParamCommon)
  | ({ type: 'string'; default: string; suggestions?: 'audioSources' } & ParamCommon)
  | ({ type: 'select'; default: string; options: { value: string; label: string }[] } & ParamCommon)
  | ({ type: 'range'; default: [number, number]; min?: number; max?: number; step?: number; unit?: string } & ParamCommon);

export interface RGBWColor {
  r: number;
  g: number;
  b: number;
  w: number;
}

export interface EffectTypeInfo {
  type: string;
  name: string;
  description: string;
  defaultColors: RGBWColor[];
  params: Record<string, EffectParamDef>;
  // Per-swatch names (e.g. Head, Tail), or a hint when the colors are a palette
  colorLabels?: string[];
  colorHint?: string;
  // Stepped effects move one light every stepFrames frames at 1x; realTime effects ignore Speed
  stepFrames?: number;
  realTime?: boolean;
  // Speed a new design of this effect starts at (1 when absent)
  defaultSpeed?: number;
}

const EFFECT_TYPES: Omit<EffectTypeInfo, 'colorLabels' | 'colorHint' | 'stepFrames' | 'realTime' | 'defaultSpeed'>[] = [
  {
    type: 'ai',
    name: 'AI',
    description: 'AI-generated composite effect with base color and animated pattern overlay',
    defaultColors: [
      { r: 255, g: 0, b: 0, w: 0 },
      { r: 0, g: 0, b: 0, w: 255 },
    ],
    params: {},
  },
  {
    type: 'candy_cane',
    name: 'Candy Cane',
    description: 'Red and white diagonal stripes scrolling like a barber pole',
    defaultColors: [
      { r: 255, g: 0, b: 0, w: 0 },
      { r: 0, g: 0, b: 0, w: 255 },
    ],
    params: {
      smooth: { type: 'boolean', default: false, label: 'Sub-pixel blending' },
      width1: { type: 'number', default: 4, min: 1, max: 16, label: 'Stripe 1 width' },
      width2: { type: 'number', default: 4, min: 1, max: 16, label: 'Stripe 2 width' },
      angle: { type: 'number', default: -63, min: -75, max: 75, step: 1, label: 'Stripe angle', unit: '°' },
    },
  },
  {
    type: 'checkerboard',
    name: 'Checkerboard',
    description: 'Alternating squares that shift position',
    defaultColors: [
      { r: 0, g: 0, b: 0, w: 255 },
      { r: 0, g: 0, b: 0, w: 0 },
    ],
    params: {
      smooth: { type: 'boolean', default: false, label: 'Sub-pixel blending' },
    },
  },
  {
    type: 'comet',
    name: 'Comet & Chase',
    description: 'A bright head with a fading tail; set Tail length to 0 for a plain chase',
    defaultColors: [
      { r: 0, g: 0, b: 0, w: 255 },
      { r: 0, g: 0, b: 200, w: 0 },
    ],
    params: {
      syncWalls: { type: 'boolean', default: false, label: 'Sync walls (short walls keep pace with the longest)' },
      smooth: { type: 'boolean', default: false, label: 'Sub-pixel blending' },
      size: { type: 'number', default: 1, min: 1, max: 10, label: 'Size' },
      tailLength: { type: 'number', default: 8, min: 0, max: 20, label: 'Tail length' },
      reverse: { type: 'boolean', default: false },
      bounce: { type: 'boolean', default: true },
      tailExit: { type: 'boolean', default: true, label: 'Tail leaves frame before looping' },
      angle: { type: 'number', default: 0, min: -180, max: 180, step: 15, label: 'Angle', unit: '°' },
      pause: { type: 'number', default: 0, min: 0, max: 30, step: 0.5, label: 'Pause before looping', unit: ' s' },
    },
  },
  {
    type: 'sparkle',
    name: 'Sparkles',
    description: 'Random lights twinkling like stars',
    defaultColors: [{ r: 0, g: 0, b: 0, w: 255 }],
    params: {
      density: { type: 'number', default: 0.15, min: 0.05, max: 0.5, step: 0.05, label: 'Density' },
      fadeSpeed: { type: 'number', default: 0.3, min: 0.1, max: 1, step: 0.1, label: 'Shimmer speed' },
    },
  },
  {
    type: 'rainbow',
    name: 'Rainbow',
    description: 'Smooth rainbow colors flowing across the display',
    defaultColors: [],
    params: {
      adjustDefective: { type: 'boolean', default: false, label: 'Adjust for defective lights' },
      angle: { type: 'number', default: 0, min: -180, max: 180, step: 15, label: 'Angle', unit: '°' },
    },
  },
  {
    type: 'wave',
    name: 'Wave',
    description: 'Smooth waves rolling along the walls, blending from the trough color to the crest color',
    defaultColors: [
      { r: 0, g: 40, b: 200, w: 0 },
      { r: 0, g: 0, b: 0, w: 255 },
    ],
    params: {
      wavelength: { type: 'number', default: 8, min: 2, max: 32, label: 'Wavelength', unit: ' lights' },
      depth: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.05, label: 'Trough dimming' },
      bounce: { type: 'boolean', default: false, label: 'Back and forth' },
      angle: { type: 'number', default: 0, min: -180, max: 180, step: 15, label: 'Angle', unit: '°' },
    },
  },
  {
    type: 'sine',
    name: 'Sine Wave',
    description: 'A sine curve drawn across the rows, rolling along the walls',
    defaultColors: [
      { r: 0, g: 0, b: 0, w: 255 },
      { r: 0, g: 0, b: 0, w: 0 },
    ],
    params: {
      wavelength: { type: 'number', default: 8, min: 2, max: 32, label: 'Wavelength', unit: ' lights' },
      span: { type: 'number', default: 3, min: 1, max: 5, step: 0.5, label: 'Height (top to bottom)', unit: ' panels' },
      thickness: { type: 'number', default: 0.7, min: 0.2, max: 2, step: 0.1, label: 'Line thickness', unit: ' rows' },
      reverse: { type: 'boolean', default: false },
    },
  },
  {
    type: 'converge',
    name: 'Meet in the Middle',
    description: 'Two groups start at opposite ends and meet in the middle (colors: left, right, color when they meet)',
    defaultColors: [
      { r: 0, g: 0, b: 0, w: 255 },
      { r: 0, g: 0, b: 0, w: 255 },
      { r: 0, g: 0, b: 0, w: 255 },
    ],
    params: {
      syncWalls: { type: 'boolean', default: false, label: 'Sync walls (short walls keep pace with the longest)' },
      smooth: { type: 'boolean', default: false, label: 'Sub-pixel blending' },
      groupSize: { type: 'number', default: 3, min: 1, max: 10, label: 'Size' },
      tail: { type: 'number', default: 0, min: 0, max: 10, label: 'Comet tail' },
      bounce: { type: 'boolean', default: false, label: 'Move back out after meeting' },
      hold: { type: 'number', default: 0, min: 0, max: 10, step: 0.5, label: 'Hold when they meet', unit: ' s' },
      pause: { type: 'number', default: 0, min: 0, max: 30, step: 0.5, label: 'Pause before looping', unit: ' s' },
    },
  },
  {
    type: 'expand',
    name: 'Expand',
    description: 'Fills outward from the middle until the wall or strip is full, then starts again',
    defaultColors: [
      { r: 0, g: 0, b: 0, w: 255 },
      { r: 0, g: 0, b: 0, w: 0 },
    ],
    params: {
      syncWalls: { type: 'boolean', default: false, label: 'Sync walls (short walls keep pace with the longest)' },
      smooth: { type: 'boolean', default: false, label: 'Sub-pixel blending' },
      origin: { type: 'number', default: 50, min: 0, max: 100, step: 5, label: 'Start point', unit: '%' },
      hold: { type: 'number', default: 1, min: 0, max: 30, step: 0.5, label: 'Hold when full', unit: ' s' },
      shrink: { type: 'boolean', default: false, label: 'Shrink back after filling' },
      pause: { type: 'number', default: 0, min: 0, max: 30, step: 0.5, label: 'Pause before looping', unit: ' s' },
    },
  },
  {
    type: 'breathe',
    name: 'Breathe',
    description: 'All lights pulsing together like breathing',
    defaultColors: [{ r: 0, g: 0, b: 0, w: 255 }],
    params: {
      // Key stays `speed` for saved designs; labelled so it isn't confused with the design Speed
      speed: { type: 'number', default: 0.05, min: 0.01, max: 0.2, step: 0.01, label: 'Breath rate' },
      pause: { type: 'number', default: 0, min: 0, max: 30, step: 0.5, label: 'Pause before looping', unit: ' s' },
    },
  },
  {
    type: 'text',
    name: 'Text Scroll',
    description: 'Scrolling text rendered with a pixel font',
    defaultColors: [{ r: 0, g: 0, b: 0, w: 255 }],
    params: {
      smooth: { type: 'boolean', default: false, label: 'Sub-pixel blending' },
      text: { type: 'string', default: 'HELLO' },
      pause: { type: 'number', default: 0, min: 0, max: 30, step: 0.5, label: 'Pause before looping', unit: ' s' },
    },
  },
  {
    type: 'twinkle',
    name: 'Twinkle',
    description: 'Lights slowly fade in and out at random, in the palette colors',
    defaultColors: [{ r: 0, g: 0, b: 0, w: 255 }],
    params: {
      density: { type: 'number', default: 0.3, min: 0.05, max: 1, step: 0.05, label: 'Density' },
      fadeTime: { type: 'number', default: 1.5, min: 0.2, max: 6, step: 0.1, label: 'Fade time', unit: ' s' },
    },
  },
  {
    type: 'fade',
    name: 'Color Fade',
    description: 'The whole roof crossfades through the palette colors',
    defaultColors: [{ r: 255, g: 0, b: 0, w: 0 }, { r: 0, g: 0, b: 0, w: 255 }, { r: 0, g: 0, b: 255, w: 0 }],
    params: {
      holdTime: { type: 'number', default: 3, min: 0, max: 60, step: 0.5, label: 'Hold each color', unit: ' s' },
      fadeTime: { type: 'number', default: 2, min: 0.1, max: 30, step: 0.1, label: 'Fade time', unit: ' s' },
    },
  },
  {
    type: 'lightning',
    name: 'Lightning',
    description: 'Random strikes of quick flickers (colors: flash, background)',
    defaultColors: [{ r: 0, g: 0, b: 0, w: 255 }, { r: 0, g: 0, b: 0, w: 0 }],
    params: {
      frequency: { type: 'number', default: 12, min: 1, max: 60, label: 'Strikes per minute' },
      coverage: { type: 'number', default: 0.5, min: 0.1, max: 1, step: 0.05, label: 'Coverage' },
    },
  },
  {
    type: 'fireworks',
    name: 'Fireworks',
    description: 'Bursts that expand from a random point and fade, in the palette colors',
    defaultColors: [{ r: 255, g: 0, b: 0, w: 0 }, { r: 0, g: 0, b: 0, w: 255 }, { r: 0, g: 255, b: 0, w: 0 }, { r: 0, g: 0, b: 255, w: 0 }],
    params: {
      interval: { type: 'range', default: [1, 2], min: 0.2, max: 10, step: 0.1, label: 'Time between launches', unit: ' s' },
      count: { type: 'range', default: [1, 1], min: 1, max: 6, label: 'Bursts per launch' },
      burstTime: { type: 'range', default: [1, 2], min: 0.3, max: 5, step: 0.1, label: 'Burst length', unit: ' s' },
      burstSize: { type: 'range', default: [4, 8], min: 1, max: 20, label: 'Burst size' },
    },
  },
  {
    type: 'fire',
    name: 'Fire',
    description: 'Flickering flames, hotter along the bottom row',
    defaultColors: [],
    params: {
      intensity: { type: 'number', default: 0.7, min: 0.1, max: 1, step: 0.05, label: 'Intensity' },
      flicker: { type: 'number', default: 1, min: 0.25, max: 4, step: 0.25, label: 'Flicker speed' },
    },
  },
  {
    type: 'strobe',
    name: 'Strobe',
    description: 'Fast on/off flashing, cycling through the palette',
    defaultColors: [{ r: 0, g: 0, b: 0, w: 255 }],
    params: {
      rate: { type: 'number', default: 4, min: 0.5, max: 15, step: 0.5, label: 'Flashes per second' },
      duty: { type: 'number', default: 0.3, min: 0.05, max: 0.9, step: 0.05, label: 'On time' },
    },
  },
  {
    type: 'ripple',
    name: 'Ripple',
    description: 'Rings spreading outward from a point (colors: ring, background)',
    defaultColors: [{ r: 0, g: 0, b: 0, w: 255 }, { r: 0, g: 0, b: 0, w: 0 }],
    params: {
      origin: { type: 'number', default: 50, min: 0, max: 100, step: 5, label: 'Origin', unit: '%' },
      spacing: { type: 'number', default: 8, min: 2, max: 32, label: 'Ring spacing' },
      width: { type: 'number', default: 1.5, min: 0.5, max: 6, step: 0.5, label: 'Ring width' },
    },
  },
  {
    type: 'audio',
    name: 'Audio Level',
    description: 'A level meter driven by live audio (UDP or HTTP input, see the Light Layout page) or simulated music',
    defaultColors: [
      { r: 0, g: 255, b: 0, w: 0 },
      { r: 255, g: 180, b: 0, w: 0 },
      { r: 255, g: 0, b: 0, w: 0 },
      { r: 0, g: 0, b: 0, w: 0 },
    ],
    params: {
      input: {
        type: 'select', default: 'random', label: 'Input',
        options: [{ value: 'random', label: 'Simulated music' }, { value: 'api', label: 'Live audio input' }],
      },
      // Blank follows whichever source sent most recently; the editor suggests known source ids
      source: { type: 'string', default: '', label: 'Source id (blank = most recent)', suggestions: 'audioSources', showIf: { param: 'input', equals: 'api' } },
      bpm: { type: 'number', default: 120, min: 60, max: 180, step: 1, label: 'Simulated tempo', unit: ' bpm', showIf: { param: 'input', equals: 'random' } },
      rotation: {
        type: 'select', default: 'left_right', label: 'Direction',
        options: [
          { value: 'left_right', label: 'Left → right' },
          { value: 'right_left', label: 'Right → left' },
          { value: 'center_out', label: 'Center out' },
          { value: 'bottom_top', label: 'Bottom → top' },
        ],
      },
      gain: { type: 'number', default: 1, min: 0.25, max: 4, step: 0.05, label: 'Gain', unit: '×' },
      autoGain: { type: 'boolean', default: false, label: 'Auto gain (loudest of the last ~10 s fills the meter)' },
      attack: { type: 'number', default: 0.03, min: 0, max: 1, step: 0.01, label: 'Attack', unit: ' s' },
      release: { type: 'number', default: 0.15, min: 0, max: 3, step: 0.05, label: 'Release', unit: ' s' },
      peakHold: { type: 'boolean', default: true, label: 'Peak hold' },
      peakHoldTime: { type: 'number', default: 1, min: 0, max: 5, step: 0.1, label: 'Peak hold time', unit: ' s', showIf: { param: 'peakHold', equals: true } },
      smooth: { type: 'boolean', default: true, label: 'Sub-pixel blending' },
    },
  },
];

// What each color swatch does, shown under the swatches in the editor. Effects whose colors are
// a palette (any number, used in turn or at random) get a hint instead of per-swatch labels.
const colorInfo: Record<string, { colorLabels?: string[]; colorHint?: string }> = {
  ai: { colorLabels: ['Base', 'Pattern'] },
  candy_cane: { colorLabels: ['Stripe 1', 'Stripe 2'] },
  checkerboard: { colorLabels: ['Square A', 'Square B'] },
  comet: { colorLabels: ['Head', 'Tail'], colorHint: 'The tail fades from the head color toward the tail color' },
  sparkle: { colorLabels: ['Sparkle'] },
  wave: { colorLabels: ['Trough', 'Crest'], colorHint: 'The wave blends from the trough color to the crest color; Trough dimming darkens the troughs' },
  expand: { colorLabels: ['Fill', 'Background'] },
  sine: { colorLabels: ['Line', 'Background'] },
  converge: { colorLabels: ['Left', 'Right', 'Meet'], colorHint: 'Meet is shown while the two groups are together in the middle' },
  breathe: { colorLabels: ['Glow'] },
  text: { colorLabels: ['Text'] },
  twinkle: { colorHint: 'Palette: each twinkle picks one of these colors at random' },
  fade: { colorHint: 'Palette: the roof fades through these colors in order, then loops' },
  lightning: { colorLabels: ['Flash', 'Background'] },
  fireworks: { colorHint: 'Palette: each burst picks one of these colors at random' },
  strobe: { colorHint: 'Palette: each flash uses the next color in order' },
  ripple: { colorLabels: ['Rings', 'Background'] },
  audio: { colorLabels: ['Low', 'Mid', 'High', 'Background'], colorHint: 'The meter blends from Low through Mid to High as it fills' },
};

// How Speed relates to motion. Stepped effects move one light every `stepFrames` frames at 1x
// (the render loop runs at 30 FPS); real-time effects set their timing in seconds and ignore Speed.
const motionInfo: Record<string, { stepFrames?: number; realTime?: boolean }> = {
  ...Object.fromEntries(Object.entries(STEP_FRAMES).map(([type, stepFrames]) => [type, { stepFrames }])),
  twinkle: { realTime: true },
  fade: { realTime: true },
  lightning: { realTime: true },
  fireworks: { realTime: true },
  strobe: { realTime: true },
  audio: { realTime: true },
};

/** Every motion effect type with layout-aware defaults, color labels and speed info. */
export function getEffectTypes(): EffectTypeInfo[] {
  return applyLayoutDefaults(EFFECT_TYPES).map(fx => ({ ...fx, ...colorInfo[fx.type], ...motionInfo[fx.type] }) as EffectTypeInfo);
}

/** Effects whose colors are a palette (any number, used in turn or at random) rather than fixed swatches. */
export function isPaletteEffect(fx: Pick<EffectTypeInfo, 'colorLabels' | 'colorHint'>): boolean {
  return !fx.colorLabels && !!fx.colorHint;
}
