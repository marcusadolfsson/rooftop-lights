import Anthropic from '@anthropic-ai/sdk';
import { randomUUID as uuidv4 } from 'crypto';
import { getDatabase } from '../models/database.js';
import {
  COLOR_SCHEMA, clampColor, getAICodeContext, getGridLayoutContext, getLayoutBasicsContext, getLayoutData,
  getStaticExampleWalls, maxRows, requestStructuredJSON, wallGridsToColorMap,
} from './aiDesigner.js';
import { MAX_AI_CODE_LENGTH, safeParseJSON, validateDesign } from './designValidation.js';
import { getEffectEngine } from './effectEngine.js';
import { getEffectTypes, isPaletteEffect, type EffectParamDef, type EffectTypeInfo, type RGBWColor } from './effectTypes.js';
import { MAX_FOLDER_LENGTH, matchingFolders, parseFolderField, validateFolderName } from './folders.js';
import { normalizeTransition, type Transition } from './playlistTimeline.js';
import { invalidateSchedule } from '../scheduler/scheduler.js';

/**
 * AI Scene Creator: one Claude request plans a whole scene (an ordered list of designs), then the
 * plan is checked and saved in one transaction: new designs, the scene, and a folder for both.
 *
 * Each planned item either reuses a saved design, or makes a new one from a built-in effect, a
 * static per-wall grid, or (when nothing built in fits) custom "ai" animation code.
 */

const MAX_SCENE_ITEMS = 12;
const MAX_NAME_LENGTH = 200;
const MAX_CONTEXT_DESIGNS = 200;
// Limits for one AI-planned item; the playlist API allows more, but a scene is a short piece
const MAX_ITEM_SECONDS = 3600;
const MAX_ITEM_REPEATS = 100;
const DEFAULT_ITEM_SECONDS = 10;
// The motion editor's Speed slider range
const SPEED_MIN = 0.1;
const SPEED_MAX = 2;
const MAX_PALETTE_COLORS = 16;
const MAX_TEXT_PARAM_LENGTH = 200;

export type PlanItemKind = 'existing' | 'builtin' | 'static' | 'code';

/** One item of the model's plan, as the structured output delivers it. */
export interface ScenePlanItem {
  kind: PlanItemKind;
  design_id: string | null;
  name: string;
  effect: string | null;
  colors: unknown[] | null;
  speed: number | null;
  scope: string | null;
  params: { name: string; value: unknown }[] | null;
  walls: { wall: string; rows: unknown[] }[] | null;
  code: string | null;
  repeat_mode: 'seconds' | 'times';
  repeat_count: number;
  duration: number;
  transition: string;
}

export interface ScenePlan {
  name: string;
  summary: string;
  items: ScenePlanItem[];
}

/** Built-in effects the model may use: everything the editor offers except custom code. */
function builtinEffects(): EffectTypeInfo[] {
  return getEffectTypes().filter(fx => fx.type !== 'ai');
}

/** Structured-output schema for the scene plan (flat items: unused fields are null). */
export function sceneOutputSchema(effectNames: string[] = builtinEffects().map(fx => fx.type)) {
  const item = {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['existing', 'builtin', 'static', 'code'] },
      design_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      name: { type: 'string' },
      effect: { anyOf: [{ type: 'string', enum: effectNames }, { type: 'null' }] },
      colors: { anyOf: [{ type: 'array', items: COLOR_SCHEMA }, { type: 'null' }] },
      speed: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      scope: { anyOf: [{ type: 'string', enum: ['all', 'wall', 'group'] }, { type: 'null' }] },
      params: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { anyOf: [{ type: 'number' }, { type: 'boolean' }, { type: 'string' }, { type: 'array', items: { type: 'number' } }] },
              },
              required: ['name', 'value'],
              additionalProperties: false,
            },
          },
          { type: 'null' },
        ],
      },
      walls: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                wall: { type: 'string' },
                rows: { type: 'array', items: { type: 'array', items: COLOR_SCHEMA } },
              },
              required: ['wall', 'rows'],
              additionalProperties: false,
            },
          },
          { type: 'null' },
        ],
      },
      code: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      repeat_mode: { type: 'string', enum: ['seconds', 'times'] },
      repeat_count: { type: 'integer' },
      duration: { type: 'number' },
      transition: { type: 'string', enum: ['cut', 'fade', 'fade_black'] },
    },
    required: [
      'kind', 'design_id', 'name', 'effect', 'colors', 'speed', 'scope', 'params', 'walls', 'code',
      'repeat_mode', 'repeat_count', 'duration', 'transition',
    ],
    additionalProperties: false,
  };
  return {
    type: 'object',
    properties: {
      name: { type: 'string' },
      summary: { type: 'string' },
      items: { type: 'array', items: item },
    },
    required: ['name', 'summary', 'items'],
    additionalProperties: false,
  };
}

const roundTo = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places;
const colorText = (c: RGBWColor) => `{r:${c.r},g:${c.g},b:${c.b},w:${c.w}}`;

/** Seconds one cycle of a motion design takes on this roof (null: no fixed cycle). */
function cycleSecondsOf(data: unknown): number | null {
  const frames = getEffectEngine().cycleFrames(data);
  return frames === null ? null : roundTo(frames / 30);
}

function paramText(key: string, def: EffectParamDef): string {
  const label = def.label ? ` "${def.label}${'unit' in def && def.unit ? ` (${def.unit.trim()})` : ''}"` : '';
  if (def.type === 'boolean') return `${key}: boolean, default ${def.default}${label}`;
  if (def.type === 'string') return `${key}: text, default "${def.default}"${label}`;
  const range = `${def.min ?? '-'}..${def.max ?? '-'}${def.step ? ` step ${def.step}` : ' (whole numbers)'}`;
  if (def.type === 'range') return `${key}: [low, high] pair within ${range}, default [${def.default.join(', ')}]${label} (a random value in the pair is used each time)`;
  return `${key}: number ${range}, default ${def.default}${label}`;
}

/** The built-in effect catalogue for the prompt: colors, speed behavior, params and cycle length. */
export function getBuiltinEffectsContext(effects: EffectTypeInfo[] = builtinEffects()): string {
  return effects.map(fx => {
    const colors = fx.defaultColors.length === 0
      ? 'Colors: none (the effect makes its own colors; send colors: [])'
      : isPaletteEffect(fx)
        ? `Colors: a palette of 1-${MAX_PALETTE_COLORS} colors (${fx.colorHint}). Default ${fx.defaultColors.map(colorText).join(', ')}`
        : `Colors: exactly ${fx.colorLabels?.length ?? fx.defaultColors.length} in this order: ${(fx.colorLabels ?? []).join(', ')}${fx.colorHint ? ` (${fx.colorHint})` : ''}. Default ${fx.defaultColors.map(colorText).join(', ')}`;
    const speed = fx.realTime
      ? 'Speed: ignored (timing is set in seconds by its params; send speed 1)'
      : fx.stepFrames
        ? `Speed: ${SPEED_MIN}-${SPEED_MAX}, default ${fx.defaultSpeed ?? 1}; at 1x it moves one light every ${fx.stepFrames} frames (30 fps)`
        : `Speed: ${SPEED_MIN}-${SPEED_MAX}, default ${fx.defaultSpeed ?? 1}`;
    const defaults = Object.fromEntries(Object.entries(fx.params).map(([k, d]) => [k, d.default]));
    const cycle = cycleSecondsOf({ type: fx.type, colors: fx.defaultColors, speed: fx.defaultSpeed ?? 1, scope: 'all', params: defaults });
    const cycleText = cycle === null
      ? 'Cycle: none (random/endless) - use repeat_mode "seconds"'
      : `Cycle: ${cycle} s at the defaults with scope "all" (params and speed change it)`;
    const params = Object.entries(fx.params).map(([k, d]) => `      - ${paramText(k, d)}`).join('\n');
    return `  - ${fx.type} ("${fx.name}"): ${fx.description}
      ${colors}
      ${speed}
      ${cycleText}
${params || '      (no params)'}`;
  }).join('\n');
}

interface StoredDesignRow {
  id: string;
  name: string;
  type: string;
  data: string;
  folder: string | null;
}

/** Saved designs the model may reuse: id, name, type, folder, effect and cycle length. */
export function getReusableDesignsContext(): string {
  const rows = getDatabase()
    .prepare('SELECT id, name, type, data, folder FROM designs ORDER BY name LIMIT ?')
    .all(MAX_CONTEXT_DESIGNS) as StoredDesignRow[];
  if (rows.length === 0) return '  (none saved yet)';
  return rows.map(d => {
    const data = safeParseJSON(d.data) as Record<string, unknown> | null;
    const folder = d.folder ? `, folder "${d.folder}"` : '';
    if (!data || typeof data !== 'object') return `  - id ${d.id}: "${d.name}" [${d.type}${folder}] (data unreadable - do not use)`;
    if (d.type !== 'motion') {
      const colors = data.colors && typeof data.colors === 'object' ? Object.values(data.colors as object) : [];
      const sample = [...new Set(colors.slice(0, 96).map(c => colorText(clampColor(c))))].slice(0, 4).join(', ');
      return `  - id ${d.id}: "${d.name}" [static${folder}] colors include ${sample || 'none'}; no cycle (seconds only)`;
    }
    const cycle = cycleSecondsOf(data);
    const prompt = data.params && typeof (data.params as Record<string, unknown>).prompt === 'string'
      ? `; made from the prompt "${String((data.params as Record<string, unknown>).prompt).slice(0, 120)}"` : '';
    return `  - id ${d.id}: "${d.name}" [motion: ${String(data.type)}${folder}]${cycle === null ? '; no cycle (seconds only)' : `; cycle ${cycle} s`}${prompt}`;
  }).join('\n');
}

/** The system prompt for a scene plan; considerDefective false treats every channel as working. */
export function buildScenePrompt(considerDefective = true): string {
  const { walls, lights } = getLayoutData();
  const rows = maxRows(walls);
  return `You plan light SCENES for an architectural RGBW LED installation on a building roof.
A scene is an ordered list of designs. It plays them in sequence, then starts again from the top.

${getLayoutBasicsContext(walls, lights, considerDefective)}

WHAT A SCENE ITEM CAN BE (field "kind"):
1. "existing": reuse a saved design. Set design_id to an id from SAVED DESIGNS below. Use this when a saved design clearly fits the request (or the user names it).
2. "builtin": a new design using one of the BUILT-IN EFFECTS below. Set effect, colors, speed, scope and params. This is the preferred way to make motion.
3. "static": a new still design. Set walls (per-wall grids, format below). Use it for held looks, flags, color washes and backdrops.
4. "code": a new design with custom JavaScript animation (format below). Only when no built-in effect can express what is needed. Set code, colors, speed, scope.
For every new design also give it a short descriptive "name". Unused fields are null.

SAVED DESIGNS:
${getReusableDesignsContext()}

BUILT-IN EFFECTS (effect name, what it does, colors, speed, cycle, params):
${getBuiltinEffectsContext()}
Params: list only the ones you want to change from the defaults, as {"name": ..., "value": ...}; keep values inside their ranges.
Scope for built-in effects: "all" = one continuous strip around the roof, "wall" = each wall runs its own copy, "group" = grouped walls run together.

STATIC FORMAT ("walls"): one entry per wall, rows[y][x] = color, rows from y=0 (bottom) to y=${rows - 1} (top), x from 0 (left, viewed from outside).
${getGridLayoutContext(walls)}
Example:
[
${getStaticExampleWalls(walls)}
]

CUSTOM CODE FORMAT ("code", only for kind "code"):${getAICodeContext(walls, considerDefective)}

TIMING (every item sets repeat_mode, repeat_count and duration):
- repeat_mode "times": play repeat_count complete cycles of the effect (only for designs that have a cycle; length = cycle x repeat_count). Set duration to roughly that many seconds as a fallback.
- repeat_mode "seconds": play for duration seconds (whole number >= 1). Required for static designs, effects without a cycle and custom code. Set repeat_count to 1.
- Unless the user asks for another length, keep the whole scene about 20-90 seconds, usually 2-6 items.
- transition is how the item hands over to the NEXT one (the last item hands over to the first when the scene loops): "cut", "fade" (1 s crossfade) or "fade_black" (fade out to black, then in).

COLORS: colors are {"r","g","b","w"} integers 0-255. W is a separate white LED; for white use {"r":0,"g":0,"b":0,"w":255}, not r=g=b=255.${considerDefective ? ' Choose colors that read well on the working channels (see DEFECTIVE CHANNELS) unless the user says to ignore defects.' : ''}

OUTPUT: "name" is a short scene name (2-5 words). "summary" tells the user in 1-3 plain sentences what the scene does, item by item, and roughly how long it runs. "items" are in play order (at most ${MAX_SCENE_ITEMS}).`;
}

/** Ask Claude for a scene plan. `request` is replaceable so tests can return a canned plan. */
export async function generateScenePlan(
  description: string,
  options: { considerDefective?: boolean } = {},
  request: typeof requestStructuredJSON = requestStructuredJSON,
): Promise<ScenePlan> {
  const raw = await request({
    system: buildScenePrompt(options.considerDefective ?? true),
    user: `Create a scene for: "${description}"`,
    schema: sceneOutputSchema(),
    subject: 'scene',
    maxTokens: 48000,
  });
  return raw as unknown as ScenePlan;
}

// --- plan -> designs + scene ---

interface NewDesign {
  id: string;
  name: string;
  type: 'static' | 'motion';
  data: Record<string, unknown>;
}

interface SceneItemRow {
  design_id: string;
  duration: number;
  repeat_mode: 'seconds' | 'times';
  repeat_count: number;
  transition: Transition;
}

export type CreateSceneResult =
  | { ok: true; sceneId: string; name: string; folder: string | null; designIds: string[]; summary: string; warnings: string[] }
  | { ok: false; status: number; error: string; warnings: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function snap(v: number, def: { min?: number; max?: number; step?: number }): number {
  let out = v;
  if (def.min !== undefined) out = Math.max(def.min, out);
  if (def.max !== undefined) out = Math.min(def.max, out);
  out = def.step ? roundTo(Math.round(out / def.step) * def.step, 4) : Math.round(out);
  // Rounding to the step can step past a bound that isn't a multiple of it
  if (def.min !== undefined && out < def.min) out = def.min;
  if (def.max !== undefined && out > def.max) out = def.max;
  return out;
}

const outOfRange = (n: number, def: { min?: number; max?: number }) =>
  (def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max);

/** One param value checked against its definition; null when the value can't be used. */
function coerceParam(value: unknown, def: EffectParamDef): { value: unknown; note?: string } | null {
  switch (def.type) {
    case 'boolean':
      if (typeof value === 'boolean') return { value };
      if (value === 'true' || value === 'false') return { value: value === 'true' };
      return null;
    case 'string':
      if (typeof value !== 'string' && typeof value !== 'number') return null;
      return { value: String(value).slice(0, MAX_TEXT_PARAM_LENGTH) };
    case 'number': {
      const n = typeof value === 'string' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) return null;
      const out = snap(n, def);
      return { value: out, note: outOfRange(n, def) ? `${n} -> ${out}` : undefined };
    }
    case 'range': {
      const nums = (Array.isArray(value) ? value : [value]).slice(0, 2).map(Number);
      if (nums.length === 0 || !nums.every(Number.isFinite)) return null;
      if (nums.length === 1) nums.push(nums[0]);
      const out = nums.map(n => snap(n, def)).sort((a, b) => a - b);
      return { value: out, note: nums.some(n => outOfRange(n, def)) ? `[${nums.join(', ')}] -> [${out.join(', ')}]` : undefined };
    }
  }
}

function clampSpeed(speed: unknown, fallback: number): number {
  if (typeof speed !== 'number' || !Number.isFinite(speed)) return fallback;
  return roundTo(Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed)));
}

const scopeOf = (scope: unknown) => (scope === 'wall' || scope === 'group' ? scope : 'all');

/** Colors for a built-in effect, as the motion editor would hold them. */
function effectColors(fx: EffectTypeInfo, raw: unknown[] | null): RGBWColor[] {
  if (fx.defaultColors.length === 0) return [];
  const given = Array.isArray(raw) ? raw.filter(isObject).map(clampColor) : [];
  if (isPaletteEffect(fx)) return given.length > 0 ? given.slice(0, MAX_PALETTE_COLORS) : [...fx.defaultColors];
  const count = Math.max(fx.colorLabels?.length ?? 0, fx.defaultColors.length);
  return [...given.slice(0, count), ...fx.defaultColors.slice(given.length, count)];
}

/** A built-in effect item as motion design data, params filled with defaults and clamped to their ranges. */
export function builtinDesignData(item: ScenePlanItem, fx: EffectTypeInfo, where: string, warnings: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = Object.fromEntries(Object.entries(fx.params).map(([k, d]) => [k, d.default]));
  for (const p of Array.isArray(item.params) ? item.params : []) {
    if (!p || typeof p.name !== 'string') continue;
    const def = fx.params[p.name];
    if (!def) {
      warnings.push(`${where}: ignored unknown ${fx.type} param "${p.name}"`);
      continue;
    }
    const coerced = coerceParam(p.value, def);
    if (!coerced) {
      warnings.push(`${where}: ${fx.type} param "${p.name}" had an unusable value, kept the default`);
      continue;
    }
    if (coerced.note) warnings.push(`${where}: ${fx.type} param "${p.name}" clamped to its range (${coerced.note})`);
    params[p.name] = coerced.value;
  }
  return {
    type: fx.type,
    colors: effectColors(fx, item.colors),
    speed: fx.realTime ? 1 : clampSpeed(item.speed, fx.defaultSpeed ?? 1),
    scope: scopeOf(item.scope),
    params,
  };
}

/** Turn one planned item into a design to create (or reuse); null when it is skipped. */
function resolveItem(
  item: ScenePlanItem,
  index: number,
  ctx: { description: string; sceneName: string; effects: Map<string, EffectTypeInfo>; warnings: string[] },
): { existing: StoredDesignRow } | { created: NewDesign } | null {
  const where = `item ${index + 1}`;
  const { warnings } = ctx;
  if (!isObject(item)) {
    warnings.push(`${where}: not an object, skipped`);
    return null;
  }
  const name = (typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `${ctx.sceneName} ${index + 1}`).slice(0, MAX_NAME_LENGTH);

  let created: NewDesign;
  switch (item.kind) {
    case 'existing': {
      const row = typeof item.design_id === 'string'
        ? getDatabase().prepare('SELECT id, name, type, data, folder FROM designs WHERE id = ?').get(item.design_id) as StoredDesignRow | undefined
        : undefined;
      if (!row) {
        warnings.push(`${where}: design id ${JSON.stringify(item.design_id)} does not exist, skipped`);
        return null;
      }
      return { existing: row };
    }
    case 'builtin': {
      const fx = typeof item.effect === 'string' ? ctx.effects.get(item.effect) : undefined;
      if (!fx) {
        warnings.push(`${where}: unknown built-in effect ${JSON.stringify(item.effect)}, skipped`);
        return null;
      }
      created = { id: uuidv4(), name, type: 'motion', data: builtinDesignData(item, fx, where, warnings) };
      break;
    }
    case 'static': {
      const grids: Record<string, unknown> = {};
      for (const entry of Array.isArray(item.walls) ? item.walls : []) {
        if (isObject(entry) && typeof entry.wall === 'string') grids[entry.wall] = entry.rows;
      }
      if (Object.keys(grids).length === 0) {
        warnings.push(`${where}: static design without wall grids, skipped`);
        return null;
      }
      const { walls, lights } = getLayoutData();
      created = { id: uuidv4(), name, type: 'static', data: { colors: wallGridsToColorMap(grids, walls, lights), prompt: ctx.description } };
      break;
    }
    case 'code': {
      if (typeof item.code !== 'string' || !item.code.trim()) {
        warnings.push(`${where}: custom code design without code, skipped`);
        return null;
      }
      if (item.code.length > MAX_AI_CODE_LENGTH) {
        warnings.push(`${where}: custom code too long, skipped`);
        return null;
      }
      const colors = Array.isArray(item.colors) ? item.colors.filter(isObject).map(clampColor).slice(0, MAX_PALETTE_COLORS) : [];
      created = {
        id: uuidv4(),
        name,
        type: 'motion',
        data: {
          type: 'ai',
          colors: colors.length > 0 ? colors : [{ r: 255, g: 0, b: 0, w: 0 }, { r: 0, g: 0, b: 0, w: 255 }],
          speed: clampSpeed(item.speed, 1),
          scope: scopeOf(item.scope),
          params: { code: item.code, prompt: ctx.description },
        },
      };
      break;
    }
    default:
      warnings.push(`${where}: unknown kind ${JSON.stringify((item as { kind?: unknown }).kind)}, skipped`);
      return null;
  }

  // Same checks as POST /api/designs (custom code must compile)
  const check = validateDesign(created.type, created.data);
  if (!check.ok) {
    warnings.push(`${where} ("${name}"): ${check.error}; skipped`);
    return null;
  }
  return { created };
}

/** Timing for an item: "times" only when the design has a cycle and the model asked for it. */
function itemTiming(item: ScenePlanItem, cycleSeconds: number | null): Omit<SceneItemRow, 'design_id'> {
  const transition = normalizeTransition(item?.transition);
  const rawDuration = typeof item?.duration === 'number' && Number.isFinite(item.duration) ? item.duration : DEFAULT_ITEM_SECONDS;
  const duration = Math.min(MAX_ITEM_SECONDS, Math.max(1, Math.round(rawDuration)));
  if (item?.repeat_mode === 'times' && cycleSeconds !== null) {
    const count = typeof item.repeat_count === 'number' && Number.isFinite(item.repeat_count) ? Math.round(item.repeat_count) : 1;
    const repeat_count = Math.min(MAX_ITEM_REPEATS, Math.max(1, count));
    // The stored duration is only a fallback in case the design loses its cycle
    const fallback = Math.min(MAX_ITEM_SECONDS, Math.max(1, Math.ceil(cycleSeconds * repeat_count)));
    return { duration: fallback, repeat_mode: 'times', repeat_count, transition };
  }
  return { duration, repeat_mode: 'seconds', repeat_count: 1, transition };
}

/**
 * The folder for a generated scene: the one asked for, else one named after the scene. Either
 * way an existing folder with the same name (any case) is reused.
 */
export function sceneFolder(requested: unknown, sceneName: string): { folder: string | null } | { error: string } {
  if (requested !== undefined && requested !== null && !(typeof requested === 'string' && !requested.trim())) {
    return parseFolderField(requested);
  }
  const fromName = validateFolderName(sceneName.slice(0, MAX_FOLDER_LENGTH));
  if ('error' in fromName) return { folder: null };
  return { folder: matchingFolders(fromName.name)[0] ?? fromName.name };
}

/**
 * Check a plan and save it: the new designs, then the scene playing them, all in one
 * transaction and in one folder. Items that can't be used are skipped with a warning; a plan
 * with no usable item saves nothing.
 */
export function createSceneFromPlan(plan: unknown, options: { description: string; folder?: unknown }): CreateSceneResult {
  const warnings: string[] = [];
  if (!isObject(plan) || !Array.isArray(plan.items)) {
    return { ok: false, status: 502, error: 'The AI returned an unusable scene plan. Try again.', warnings };
  }
  const sceneName = (typeof plan.name === 'string' && plan.name.trim() ? plan.name.trim() : 'AI Scene').slice(0, MAX_NAME_LENGTH);
  const folder = sceneFolder(options.folder, sceneName);
  if ('error' in folder) return { ok: false, status: 400, error: folder.error, warnings };

  const planItems = plan.items as ScenePlanItem[];
  if (planItems.length > MAX_SCENE_ITEMS) warnings.push(`the plan had ${planItems.length} items; kept the first ${MAX_SCENE_ITEMS}`);
  const effects = new Map(builtinEffects().map(fx => [fx.type, fx]));
  const ctx = { description: options.description, sceneName, effects, warnings };

  const newDesigns: NewDesign[] = [];
  const items: SceneItemRow[] = [];
  planItems.slice(0, MAX_SCENE_ITEMS).forEach((item, index) => {
    const resolved = resolveItem(item, index, ctx);
    if (!resolved) return;
    if ('existing' in resolved) {
      const row = resolved.existing;
      const data = safeParseJSON(row.data);
      const cycle = row.type === 'motion' && data ? cycleSecondsOf(data) : null;
      items.push({ design_id: row.id, ...itemTiming(item, cycle) });
    } else {
      const d = resolved.created;
      newDesigns.push(d);
      items.push({ design_id: d.id, ...itemTiming(item, d.type === 'motion' ? cycleSecondsOf(d.data) : null) });
    }
  });

  if (items.length === 0) {
    return { ok: false, status: 422, error: 'The AI plan had no usable items, so nothing was saved. Try rephrasing the request.', warnings };
  }

  const db = getDatabase();
  const sceneId = uuidv4();
  const insertDesign = db.prepare(`
    INSERT INTO designs (id, name, type, data, folder, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);
  const insertScene = db.prepare(`
    INSERT INTO playlists (id, name, play_mode, kind, folder, created_at, updated_at)
    VALUES (?, ?, 'sequence', 'scene', ?, datetime('now'), datetime('now'))
  `);
  const insertItem = db.prepare(`
    INSERT INTO playlist_items (id, playlist_id, design_id, child_playlist_id, duration, position, transition, repeat_mode, repeat_count)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const d of newDesigns) insertDesign.run(d.id, d.name, d.type, JSON.stringify(d.data), folder.folder);
    insertScene.run(sceneId, sceneName, folder.folder);
    items.forEach((item, position) => {
      insertItem.run(uuidv4(), sceneId, item.design_id, item.duration, position, item.transition, item.repeat_mode, item.repeat_count);
    });
  })();
  invalidateSchedule();

  return {
    ok: true,
    sceneId,
    name: sceneName,
    folder: folder.folder,
    designIds: newDesigns.map(d => d.id),
    summary: typeof plan.summary === 'string' ? plan.summary.trim().slice(0, 2000) : '',
    warnings,
  };
}

/**
 * Discard a generated scene: delete the scene, and of `designIds` the designs it plays that were
 * saved with it and that nothing else uses (other scenes / playlists, schedules). Other designs,
 * including reused ones, are left alone.
 */
export function undoGeneratedScene(sceneId: string, designIds: unknown):
  | { ok: true; deletedDesignIds: string[]; keptDesignIds: string[] }
  | { ok: false; status: number; error: string } {
  if (!Array.isArray(designIds) || designIds.length > 100 || !designIds.every(id => typeof id === 'string')) {
    return { ok: false, status: 400, error: 'designIds must be an array of design ids' };
  }
  const db = getDatabase();
  const scene = db.prepare('SELECT id, kind, created_at FROM playlists WHERE id = ?').get(sceneId) as
    { id: string; kind: string; created_at: string | null } | undefined;
  if (!scene) return { ok: false, status: 404, error: 'Scene not found' };
  if (scene.kind !== 'scene') return { ok: false, status: 400, error: 'Only a scene can be undone' };
  const scheduled = db.prepare('SELECT COUNT(*) as count FROM schedules WHERE playlist_id = ?').get(sceneId) as { count: number };
  if (scheduled.count > 0) return { ok: false, status: 400, error: 'The scene is used in schedules. Remove it from them first.' };
  const parents = db.prepare(`
    SELECT DISTINCT p.name FROM playlist_items pi JOIN playlists p ON pi.playlist_id = p.id
    WHERE pi.child_playlist_id = ? AND pi.playlist_id <> ?
  `).all(sceneId, sceneId) as { name: string }[];
  if (parents.length > 0) {
    return { ok: false, status: 400, error: `The scene is used in other playlists (${parents.map(p => p.name).join(', ')}). Remove it from them first.` };
  }

  const inScene = new Set((db.prepare('SELECT design_id FROM playlist_items WHERE playlist_id = ? AND design_id IS NOT NULL')
    .all(sceneId) as { design_id: string }[]).map(r => r.design_id));
  const usedElsewhere = db.prepare(`
    SELECT (SELECT COUNT(*) FROM playlist_items WHERE design_id = ? AND playlist_id <> ?)
         + (SELECT COUNT(*) FROM schedules WHERE design_id = ?) as count
  `);
  // Designs saved with the scene (same transaction) or after it; older ones were reused, not created
  const createdWithScene = db.prepare('SELECT 1 FROM designs WHERE id = ? AND (? IS NULL OR created_at >= ?)');
  const deleted: string[] = [];
  const kept: string[] = [];
  db.transaction(() => {
    for (const id of new Set(designIds as string[])) {
      const used = (usedElsewhere.get(id, sceneId, id) as { count: number }).count > 0;
      if (inScene.has(id) && !used && createdWithScene.get(id, scene.created_at, scene.created_at)) deleted.push(id);
      else kept.push(id);
    }
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(sceneId);
    db.prepare('DELETE FROM playlists WHERE id = ?').run(sceneId);
    const del = db.prepare('DELETE FROM designs WHERE id = ?');
    for (const id of deleted) del.run(id);
  })();
  invalidateSchedule();
  return { ok: true, deletedDesignIds: deleted, keptDesignIds: kept };
}

/** HTTP status and message for an error thrown while asking the model. */
export function aiErrorResponse(error: unknown): { status: number; error: string } {
  if (error instanceof Anthropic.AuthenticationError) return { status: 503, error: 'AI not configured: the Anthropic API key was rejected.' };
  if (error instanceof Anthropic.RateLimitError) return { status: 429, error: 'The AI service is busy (rate limited). Try again in a minute.' };
  if (error instanceof Anthropic.APIConnectionError) return { status: 502, error: 'Could not reach the AI service. Check the internet connection and try again.' };
  if (error instanceof Anthropic.APIError) return { status: 502, error: `The AI service returned an error${error.status ? ` (${error.status})` : ''}. Try again.` };
  return { status: 502, error: error instanceof Error ? error.message : 'Failed to generate scene' };
}
