// Validation for design payloads coming from the API (create/update/preview).
// Rendering is also defensive, but rejecting bad input up front gives the user a
// clear 400 instead of a silently blank rooftop.

import { compileAICode } from './aiSandbox.js';

export const MOTION_EFFECT_TYPES = [
  'ai', 'candy_cane', 'checkerboard', 'comet', 'sparkle',
  'rainbow', 'wave', 'chase', 'converge', 'breathe', 'text',
] as const;

export const MAX_AI_CODE_LENGTH = 100_000;
const MAX_COLORS = 4096;

export type ValidationResult = { ok: true } | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkColor(c: unknown, where: string): string | null {
  if (!isPlainObject(c)) return `${where} must be an object like {r,g,b,w}`;
  for (const ch of ['r', 'g', 'b', 'w']) {
    const v = c[ch];
    if (v === undefined) continue; // missing channel renders as 0
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return `${where}.${ch} must be a number between 0 and 255`;
    }
    if (v < 0 || v > 255) return `${where}.${ch} must be between 0 and 255`;
  }
  return null;
}

export function validateStaticData(data: unknown): ValidationResult {
  if (!isPlainObject(data)) return { ok: false, error: 'Static design data must be an object with a "colors" field' };
  const colors = data.colors;
  if (Array.isArray(colors)) {
    if (colors.length > MAX_COLORS) return { ok: false, error: `Too many colors (max ${MAX_COLORS})` };
    for (let i = 0; i < colors.length; i++) {
      if (colors[i] == null) continue; // sparse entry = off
      const err = checkColor(colors[i], `colors[${i}]`);
      if (err) return { ok: false, error: err };
    }
    return { ok: true };
  }
  if (isPlainObject(colors)) {
    const keys = Object.keys(colors);
    if (keys.length > MAX_COLORS) return { ok: false, error: `Too many colors (max ${MAX_COLORS})` };
    for (const key of keys) {
      if (!/^\d+$/.test(key)) return { ok: false, error: `colors key "${key}" must be a light id (non-negative integer)` };
      if (colors[key] == null) continue;
      const err = checkColor(colors[key], `colors[${key}]`);
      if (err) return { ok: false, error: err };
    }
    return { ok: true };
  }
  return { ok: false, error: 'Static design "colors" must be an array or an object keyed by light id' };
}

export function validateMotionData(data: unknown): ValidationResult {
  if (!isPlainObject(data)) return { ok: false, error: 'Motion design data must be an object' };
  const { type, colors, speed, scope, params } = data;

  if (typeof type !== 'string' || !type) return { ok: false, error: 'Motion design "type" (effect type) is required' };
  if (!(MOTION_EFFECT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: `Unknown effect type "${type}". Allowed: ${MOTION_EFFECT_TYPES.join(', ')}` };
  }

  if (!Array.isArray(colors)) return { ok: false, error: 'Motion design "colors" must be an array of {r,g,b,w} (may be empty)' };
  if (colors.length > 64) return { ok: false, error: 'Too many colors (max 64)' };
  for (let i = 0; i < colors.length; i++) {
    const err = checkColor(colors[i], `colors[${i}]`);
    if (err) return { ok: false, error: err };
  }

  if (speed !== undefined && speed !== null) {
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0 || speed > 100) {
      return { ok: false, error: '"speed" must be a number greater than 0 and at most 100' };
    }
  }

  if (scope !== undefined && scope !== null && scope !== 'all' && scope !== 'wall' && scope !== 'group') {
    return { ok: false, error: '"scope" must be one of: all, wall, group' };
  }

  if (params !== undefined && params !== null && !isPlainObject(params)) {
    return { ok: false, error: '"params" must be an object' };
  }

  if (isPlainObject(params) && params.wallIds !== undefined && params.wallIds !== null) {
    if (!Array.isArray(params.wallIds) || params.wallIds.length > 64 || !params.wallIds.every((id) => typeof id === 'string')) {
      return { ok: false, error: 'params.wallIds must be an array of wall ids' };
    }
  }

  if (isPlainObject(params) && params.angle !== undefined && params.angle !== null) {
    if (typeof params.angle !== 'number' || !Number.isFinite(params.angle)) {
      return { ok: false, error: 'params.angle must be a number of degrees' };
    }
  }

  if (type === 'ai' && isPlainObject(params) && params.code !== undefined && params.code !== null) {
    if (typeof params.code !== 'string') return { ok: false, error: 'params.code must be a string' };
    if (params.code.length > MAX_AI_CODE_LENGTH) {
      return { ok: false, error: `params.code too long (max ${MAX_AI_CODE_LENGTH} characters)` };
    }
    if (params.code.trim()) {
      const compiled = compileAICode(params.code);
      if (!compiled.ok) return { ok: false, error: `params.code does not compile: ${compiled.error}` };
    }
  }

  if (type === 'text' && isPlainObject(params) && params.text !== undefined && typeof params.text !== 'string') {
    return { ok: false, error: 'params.text must be a string' };
  }

  return { ok: true };
}

/** Validate a stored design (static or motion). */
export function validateDesign(type: unknown, data: unknown): ValidationResult {
  if (type === 'static') return validateStaticData(data);
  if (type === 'motion') return validateMotionData(data);
  return { ok: false, error: 'Design "type" must be "static" or "motion"' };
}

/** Parse a designs.data column; returns null when it is not valid JSON. */
export function safeParseJSON(text: unknown): unknown | null {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
