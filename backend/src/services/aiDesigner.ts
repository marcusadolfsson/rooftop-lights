import Anthropic from '@anthropic-ai/sdk';
import { getDatabase } from '../models/database.js';
import { safeParseJSON } from './designValidation.js';

// Created lazily so the server starts (and non-AI routes work) without credentials
let anthropic: Anthropic | null = null;
function client(): Anthropic {
  if (!anthropic) anthropic = new Anthropic();
  return anthropic;
}

// Override with ANTHROPIC_MODEL to use a different Claude model
const DEFAULT_MODEL = 'claude-sonnet-5-5';
function modelId(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
}

// Models that accept the server-side `fallbacks: "default"` parameter (Claude API).
// On a safety-classifier decline the API re-runs the request on Anthropic's
// recommended fallback model instead of returning a refusal.
const SERVER_FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1']);

const COLOR_SCHEMA = {
  type: 'object',
  properties: {
    r: { type: 'integer' },
    g: { type: 'integer' },
    b: { type: 'integer' },
    w: { type: 'integer' },
  },
  required: ['r', 'g', 'b', 'w'],
  additionalProperties: false,
} as const;

// Structured-output schema. One flat object (static fields null for motion and
// vice versa) because wall names are data, not fixed keys, and the schema
// language requires additionalProperties: false on every object.
const DESIGN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['static', 'motion'] },
    name: { type: 'string' },
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
    colors: { anyOf: [{ type: 'array', items: COLOR_SCHEMA }, { type: 'null' }] },
    speed: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    scope: { anyOf: [{ type: 'string', enum: ['all', 'wall', 'group'] }, { type: 'null' }] },
    code: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['type', 'name', 'walls', 'colors', 'speed', 'scope', 'code'],
  additionalProperties: false,
} as const;

/**
 * Parse the model's JSON. Structured outputs guarantee valid JSON, but keep a
 * tolerant fallback (markdown fences, leading prose) for models/configs where
 * output_config.format is not applied.
 */
function parseModelJSON(text: string): Record<string, unknown> {
  const attempts: string[] = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) attempts.push(fenced[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));
  for (const candidate of attempts) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // try next candidate
    }
  }
  throw new Error('Failed to parse AI response as JSON');
}

/** Map the structured-output shape onto the legacy shape the converter below expects. */
function normalizeModelOutput(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  if (Array.isArray(raw.walls)) {
    const grids: Record<string, unknown> = {};
    for (const entry of raw.walls as Array<{ wall?: unknown; rows?: unknown }>) {
      if (entry && typeof entry.wall === 'string') grids[entry.wall] = entry.rows;
    }
    out.walls = grids;
  }
  if (typeof raw.code === 'string') {
    const params = (raw.params && typeof raw.params === 'object' ? raw.params : {}) as Record<string, unknown>;
    out.params = { ...params, code: raw.code };
  }
  delete out.code;
  for (const k of ['colors', 'speed', 'scope', 'walls'] as const) {
    if (out[k] === null) delete out[k];
  }
  return out;
}

interface RGBWColor {
  r: number;
  g: number;
  b: number;
  w: number;
}

interface StaticDesign {
  type: 'static';
  name: string;
  // Keyed by light_id (not an array indexed by light_id-1, which dropped lights
  // whose ids exceed the light count)
  colors: Record<number, RGBWColor>;
}

interface MotionDesign {
  type: 'motion';
  name: string;
  effect: string;
  colors: RGBWColor[];
  speed: number;
  scope: 'all' | 'wall' | 'group';
  params?: Record<string, unknown>;
}

type GeneratedDesign = StaticDesign | MotionDesign;

interface StoredDesign {
  id: string;
  name: string;
  type: 'static' | 'motion';
  data: string;
  created_at: string;
}

// Get the light layout context for the AI
interface WallInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  position: number;
}

interface LightInfo {
  light_id: number;
  wall_id: string;
  wall_name: string;
  matrix_x: number;
  matrix_y: number;
  defective_channels: string;
}

// Get walls and lights from DB (cached per call)
function getLayoutData(): { walls: WallInfo[]; lights: LightInfo[] } {
  const db = getDatabase();
  const walls = db.prepare('SELECT * FROM walls ORDER BY position').all() as WallInfo[];
  const lights = db.prepare(`
    SELECT l.*, w.name as wall_name
    FROM lights l
    JOIN walls w ON l.wall_id = w.id
    ORDER BY w.position, l.matrix_y DESC, l.matrix_x
  `).all() as LightInfo[];
  return { walls, lights };
}

// Convert wall-grid format from AI to light_id color map
function wallGridToColorMap(
  wallGrids: Record<string, RGBWColor[][]>,
  walls: WallInfo[],
  lights: LightInfo[]
): Record<number, RGBWColor> {
  const colorMap: Record<number, RGBWColor> = {};
  const black: RGBWColor = { r: 0, g: 0, b: 0, w: 0 };

  for (const light of lights) {
    const grid = wallGrids[light.wall_name];
    if (grid && grid[light.matrix_y] && grid[light.matrix_y][light.matrix_x]) {
      colorMap[light.light_id] = grid[light.matrix_y][light.matrix_x];
    } else {
      colorMap[light.light_id] = black;
    }
  }
  return colorMap;
}

function getLightLayoutContext(): string {
  const { walls, lights } = getLayoutData();

  const totalLights = lights.length;

  const wallDescriptions = walls.map(w =>
    `  - ${w.name}: ${w.width} columns x ${w.height} rows (${w.width * w.height} lights)`
  ).join('\n');

  return `
LIGHT LAYOUT:
- ${totalLights} RGBW LED fixtures on a building roofline
- Each light: RGBW channels, values 0-255
- 4 walls forming a rectangle (viewed from outside):
${wallDescriptions}
- Rows: y=0 is bottom, y=2 is top
- Columns: x=0 is left (viewed from outside)
- West and East are the long walls (13 wide), North and South are short (3 wide)

MOTION DESIGN FORMAT:
All motion designs use effect: "ai" with custom JavaScript animation code.
You write the animation logic — you can create ANYTHING: comets, waves, games, physics, text, patterns, etc.

Structure:
- "effect": always "ai"
- "colors": array of RGBW color objects the user can edit after generation
- "speed": number (0.1-5) controlling animation speed (applied before your code runs)
- "scope": "all" | "wall" | "group" — how the animation should tile (see SCOPE below)
- "params": { "code": "...javascript function body..." }

The code is the BODY of a function receiving a single argument \`ctx\`. It must RETURN an object mapping light IDs (numbers) to {r,g,b,w} color objects (values 0-255).

CONTEXT OBJECT (ctx):
- ctx.frame: number — current frame counter (~30fps, already speed-adjusted)
- ctx.colors: array of {r,g,b,w} — the editable color palette from "colors" field
- ctx.scope: "all" | "wall" | "group" — the user-selected scope
- ctx.lights: array of light objects, each with:
    .id — light ID (use as key in return object)
    .x — column within its wall (0-based)
    .y — row (0 = bottom, 1 = middle, 2 = top)
    .wallIndex — which wall (0-3)
    .cx — continuous x across all walls (0 to width-1)
- ctx.walls: array of {name, width, height, groupId} — wall info (groupId groups walls together)
- ctx.width: total columns across all walls (e.g. 32)
- ctx.height: max rows (e.g. 3)

SCOPE — Your code MUST respect ctx.scope to control how the animation tiles:
- "all": treat all walls as one continuous strip. Use L.cx for horizontal position (0 to ctx.width-1).
- "wall": each wall runs its own independent copy of the animation. Use L.x for position (0 to wall width-1), and reset animation per L.wallIndex.
- "group": walls sharing the same groupId animate together as one strip, ungrouped walls animate independently. Use L.wallIndex and ctx.walls[L.wallIndex].groupId to determine grouping.
To implement scope, compute the horizontal position and segment width based on scope:
  - scope "all": pos = L.cx, segWidth = ctx.width
  - scope "wall": pos = L.x, segWidth = ctx.walls[L.wallIndex].width
  - scope "group": compute per-group cx offset and width from ctx.walls

RULES:
1. RETURN an object: { [lightId]: {r, g, b, w} }. Lights not in the object stay off (black).
2. Reference ctx.colors[0], ctx.colors[1] etc so the user can edit colors after generation.
3. Use ctx.frame for all animation timing. Do NOT use Date.now() or Math.random() (use deterministic pseudo-random based on frame + light id instead).
4. Available: Math.sin, Math.cos, Math.floor, Math.ceil, Math.round, Math.abs, Math.min, Math.max, Math.PI, Math.sqrt, Math.pow, parseInt, parseFloat.
5. No imports, fetch, setTimeout, setInterval, eval, or async. Pure computation only. ctx and everything in it is read-only (frozen) - build a new output object. Each frame must finish within a few milliseconds; code that runs too long or throws is disabled for a few seconds.
6. Keep code concise. Use \\n for newlines in the JSON string.

EXAMPLE — Scope-aware bouncing comet (works with all/wall/group):
"code": "var out = {};\\nvar base = ctx.colors[0] || {r:255,g:0,b:0,w:0};\\nvar head = ctx.colors[1] || {r:0,g:0,b:0,w:255};\\n// Compute per-light segment position and width based on scope\\nfunction getSegment(L) {\\n  if (ctx.scope === 'wall') return { pos: L.x, width: ctx.walls[L.wallIndex].width };\\n  return { pos: L.cx, width: ctx.width };\\n}\\nvar step = Math.floor(ctx.frame / 4);\\nfor (var i = 0; i < ctx.lights.length; i++) {\\n  var L = ctx.lights[i];\\n  var seg = getSegment(L);\\n  var cycle = seg.width * 2;\\n  var raw = step % cycle;\\n  var headPos = raw >= seg.width ? cycle - raw - 1 : raw;\\n  var dist = Math.abs(seg.pos - headPos);\\n  if (dist < 6) {\\n    var b = 1 - dist / 6;\\n    out[L.id] = {r: Math.round(head.r*b), g: Math.round(head.g*b), b: Math.round(head.b*b), w: Math.round(head.w*b)};\\n  } else {\\n    out[L.id] = base;\\n  }\\n}\\nreturn out;"

EXAMPLE — Snake game (green snake on black):
"code": "var out = {};\\nvar snakeColor = ctx.colors[0] || {r:0,g:255,b:0,w:0};\\nvar foodColor = ctx.colors[1] || {r:255,g:0,b:0,w:0};\\nvar len = ctx.width;\\nvar snakeLen = 6;\\nvar step = Math.floor(ctx.frame / 5);\\nvar pos = step % (len * 2);\\nvar headX = pos < len ? pos : len * 2 - pos - 1;\\nvar headY = pos < len ? 0 : (Math.floor(step / (len*2)) % 3);\\nvar foodX = (step * 7 + 13) % len;\\nvar foodY = (step * 3 + 7) % 3;\\nfor (var i = 0; i < ctx.lights.length; i++) {\\n  var L = ctx.lights[i];\\n  var trail = headX - L.cx;\\n  if (pos >= len) trail = L.cx - headX;\\n  if (L.y === headY && trail >= 0 && trail < snakeLen) {\\n    var bright = 1 - trail / snakeLen * 0.6;\\n    out[L.id] = {r: Math.round(snakeColor.r*bright), g: Math.round(snakeColor.g*bright), b: Math.round(snakeColor.b*bright), w: 0};\\n  } else if (L.cx === foodX && L.y === foodY) {\\n    out[L.id] = foodColor;\\n  }\\n}\\nreturn out;"
`;
}

// Get existing designs for context
function getExistingDesignsContext(): string {
  const db = getDatabase();
  const designs = db.prepare('SELECT id, name, type, data FROM designs ORDER BY name').all() as StoredDesign[];

  if (designs.length === 0) {
    return '\nEXISTING DESIGNS: None yet.\n';
  }

  const designSummaries = designs.map(d => {
    const data = safeParseJSON(d.data) as Record<string, any> | null;
    if (!data || typeof data !== 'object') {
      // One corrupt row must not break generation for everything else
      return `  - "${d.name}" (id: ${d.id}) [${d.type}] - (data unreadable)`;
    }
    if (d.type === 'static') {
      // Summarize static design - show a sample of colors
      const colors = data.colors as Record<number, RGBWColor> | RGBWColor[] | undefined;
      const colorArray = Array.isArray(colors) ? colors : (colors && typeof colors === 'object' ? Object.values(colors) : []);
      const sample = colorArray.slice(0, 3).filter(Boolean).map((c: RGBWColor) =>
        `rgba(${c.r},${c.g},${c.b},${c.w})`
      ).join(', ');
      return `  - "${d.name}" (id: ${d.id}) [static] - Sample colors: ${sample}...`;
    } else {
      // Summarize motion design
      const effect = data.effect || data.type;
      return `  - "${d.name}" (id: ${d.id}) [motion: ${effect}]`;
    }
  });

  return `
EXISTING DESIGNS (you can reference these by name or ID when user wants modifications):
${designSummaries.join('\n')}
`;
}

// Get a specific design's full data
function getDesignById(designId: string): { design: StoredDesign; data: unknown } | null {
  const db = getDatabase();
  const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(designId) as StoredDesign | undefined;

  if (!design) return null;

  const data = safeParseJSON(design.data);
  if (data === null) return null;
  return { design, data };
}

export interface GenerateOptions {
  description: string;
  baseDesignId?: string;  // Optional: design to use as a starting point/reference
  mode?: 'create' | 'modify' | 'derivative';  // How to handle the base design
  currentDesignData?: {  // Optional: current in-editor design data (for editing unsaved designs)
    type: string;
    effect?: string;
    colors?: RGBWColor[] | Record<number, RGBWColor>;
    speed?: number;
    scope?: string;
    params?: Record<string, unknown>;
  };
}

export async function generateDesignFromDescription(
  descriptionOrOptions: string | GenerateOptions
): Promise<{
  success: boolean;
  design?: GeneratedDesign;
  designId?: string;
  error?: string;
}> {
  // Handle both old string API and new options API
  const options: GenerateOptions = typeof descriptionOrOptions === 'string'
    ? { description: descriptionOrOptions }
    : descriptionOrOptions;

  const { description, baseDesignId, mode = 'create', currentDesignData } = options;

  const layoutContext = getLightLayoutContext();
  const existingDesignsContext = getExistingDesignsContext();

  // If modifying an existing design, get its full data
  let baseDesignContext = '';
  if (currentDesignData) {
    // Editing the current in-editor design directly
    baseDesignContext = `
CURRENT DESIGN TO EDIT:
Type: ${currentDesignData.type}
Effect: ${currentDesignData.effect || 'N/A'}
Colors: ${JSON.stringify(currentDesignData.colors)}
Speed: ${currentDesignData.speed || 1}
Scope: ${currentDesignData.scope || 'all'}
Params: ${JSON.stringify(currentDesignData.params, null, 2)}

IMPORTANT: You MUST keep this design EXACTLY as it is — same structure, same code logic, same colors — and ONLY apply the specific modifications the user requests. Do NOT rewrite the code from scratch. Make minimal, targeted changes to the existing code to achieve what the user asks for.
If the user asks to change colors, update the colors array. If they ask to change behavior, modify only the relevant parts of the code. Preserve everything else unchanged.
`;
  } else if (baseDesignId) {
    const baseDesign = getDesignById(baseDesignId);
    if (baseDesign) {
      baseDesignContext = `
BASE DESIGN TO ${mode.toUpperCase()}:
Name: "${baseDesign.design.name}"
Type: ${baseDesign.design.type}
Full Data: ${JSON.stringify(baseDesign.data, null, 2)}

The user wants to ${mode === 'modify' ? 'modify this design' : 'create a derivative based on this design'}.
Use this as your starting point and apply the requested changes.
`;
    }
  }

  const systemPrompt = `You are a precise lighting designer for architectural RGBW LED installations.
You create ACCURATE, LITERAL light designs based on user descriptions.

${layoutContext}

${existingDesignsContext}

${baseDesignContext}

CRITICAL DESIGN RULES:
1. Be LITERAL. If the user says "Swedish flag", produce the EXACT Swedish flag: blue background (#006AA7) with a yellow cross (#FECC00). Not an interpretation — the real thing.
2. If the user says "American flag", produce the actual American flag pattern: blue canton top-left, red and white stripes. Map it to the grid as faithfully as possible given the 3-row constraint.
3. For any named flag, pattern, or real-world reference: research the actual design and reproduce it precisely with correct colors.
4. Only be "creative" when the user asks for something abstract (mood, theme, vibe). For concrete requests, be exact.
INSTRUCTIONS:
1. Analyze the user's description — is it a concrete/literal request or an abstract/mood request?
2. If referencing an existing design, use it as context for modifications or inspiration
3. Decide if this should be a STATIC design (fixed colors) or MOTION design (animated effect)
4. Generate the appropriate JSON response

For STATIC designs, specify colors PER WALL as a 2D grid: one entry per wall in "walls", where rows[y][x] = color.
Each wall grid is an array of rows (y=0 first, y=2 last). Each row is an array of colors (x=0 to x=width-1).

GRID LAYOUT (critical — get this right):
- All walls are 3 rows tall: y=0 (bottom), y=1 (middle), y=2 (top)
- West wall: 13 columns (x=0 left to x=12 right, viewed from outside)
- North wall: 3 columns (x=0 left to x=2 right, viewed from outside)
- East wall: 13 columns (x=0 left to x=12 right, viewed from outside)
- South wall: 3 columns (x=0 left to x=2 right, viewed from outside)

FLAG EXAMPLES (follow this level of precision):
- Swedish flag: ALL lights blue {"r":0,"g":106,"b":167,"w":0}, EXCEPT y=1 (middle row, ALL columns) = yellow {"r":254,"g":204,"b":0,"w":0}, AND x=2 for North/South or x=4 for West/East (cross vertical bar) = yellow across ALL rows
- American flag: top row blue in left columns + white/red, middle row red/white stripes, bottom row white/red stripes. Use actual flag colors: red {"r":178,"g":34,"b":52,"w":0}, white {"r":0,"g":0,"b":0,"w":255}, blue {"r":60,"g":59,"b":110,"w":0}
- French flag: left 1/3 blue, middle 1/3 white, right 1/3 red (vertical stripes, same on every row)
- Rainbow: row-by-row or column-by-column spectrum with actual rainbow colors

PATTERN PRINCIPLES:
- Horizontal stripes: same color for entire row across all walls
- Vertical stripes: vary color by column (x) position
- Gradients: smoothly interpolate colors across columns or rows
- Per-wall themes: different colors/patterns for different walls
- For flags with complex designs: simplify to fit 3 rows but keep proportions and colors accurate

For MOTION designs, select the most appropriate effect and configure its parameters.
Think about:
- Which effect best matches the description
- Appropriate colors that match the mood/theme
- Speed and intensity settings

RESPONSE FORMAT (a single JSON object; every field is present, unused ones are null):
For static:
{
  "type": "static",
  "name": "Descriptive Name",
  "walls": [
    { "wall": "West", "rows": [
      [color_y0_x0, color_y0_x1, ...],  // row y=0 (bottom), 13 colors
      [color_y1_x0, color_y1_x1, ...],  // row y=1 (middle), 13 colors
      [color_y2_x0, color_y2_x1, ...]   // row y=2 (top), 13 colors
    ] },
    { "wall": "North", "rows": [ [3 colors], [3 colors], [3 colors] ] },
    { "wall": "East",  "rows": [ [13 colors], [13 colors], [13 colors] ] },
    { "wall": "South", "rows": [ [3 colors], [3 colors], [3 colors] ] }
  ],
  "colors": null, "speed": null, "scope": null, "code": null
}
Each color is {"r":0,"g":0,"b":0,"w":0} with integer values 0-255. Rows go from y=0 (bottom) to y=2 (top).

For motion (always the "ai" effect; "code" is the function body described above):
{
  "type": "motion",
  "name": "Descriptive Name",
  "walls": null,
  "colors": [
    {"r":255,"g":0,"b":0,"w":0},
    {"r":0,"g":0,"b":0,"w":255}
  ],
  "speed": 1.0,
  "scope": "all",
  "code": "var out = {};\\nvar c = ctx.colors[0] || {r:255,g:0,b:0,w:0};\\n...\\nreturn out;"
}

For concrete requests (flags, named patterns): prioritize ACCURACY over creativity. Get the colors and positions RIGHT.
For abstract requests (moods, themes): be creative and artistic with color choices and patterns.
${baseDesignId ? `Remember: You are ${mode === 'modify' ? 'modifying' : 'creating a derivative of'} an existing design. Keep what works and change what the user requests.` : ''}`;

  try {
    const userMessage = baseDesignId
      ? `${mode === 'modify' ? 'Modify' : 'Create a variation of'} the design "${baseDesignId}": ${description}`
      : `Create a light design for: "${description}"`;

    const model = modelId();
    const useFallbacks = SERVER_FALLBACK_MODELS.has(model);

    // Streaming + finalMessage(): generous max_tokens without HTTP timeouts.
    // output_config.format constrains the reply to DESIGN_OUTPUT_SCHEMA.
    const response = await client().beta.messages.stream({
      model,
      max_tokens: 32000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      output_config: {
        format: { type: 'json_schema', schema: DESIGN_OUTPUT_SCHEMA as unknown as Record<string, unknown> },
      },
      ...(useFallbacks
        ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
        : {}),
    }).finalMessage();

    if (response.stop_reason === 'refusal') {
      throw new Error('The AI declined to generate this design. Try rephrasing the request.');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new Error('AI response was cut off (too long). Try a simpler request.');
    }

    // Extract text content from response
    const text = response.content
      .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
      .map(c => c.text)
      .join('');
    if (!text.trim()) {
      throw new Error('No text response from AI');
    }

    const rawData = normalizeModelOutput(parseModelJSON(text));

    let designData: GeneratedDesign;
    const { walls, lights } = getLayoutData();

    // Validate the design
    if (rawData.type === 'static') {
      // Convert wall-grid format to flat color array
      const wallGrids = rawData.walls as Record<string, RGBWColor[][]> | undefined;
      if (!wallGrids || typeof wallGrids !== 'object') {
        throw new Error('Static design must have a "walls" object with per-wall color grids');
      }

      // Clamp helper
      const clamp = (c: RGBWColor): RGBWColor => ({
        r: Math.max(0, Math.min(255, Math.round(c.r || 0))),
        g: Math.max(0, Math.min(255, Math.round(c.g || 0))),
        b: Math.max(0, Math.min(255, Math.round(c.b || 0))),
        w: Math.max(0, Math.min(255, Math.round(c.w || 0))),
      });

      // Validate and clamp wall grids
      for (const wall of walls) {
        const grid = wallGrids[wall.name];
        if (!grid || !Array.isArray(grid)) {
          // Fill missing wall with black
          wallGrids[wall.name] = Array.from({ length: wall.height }, () =>
            Array.from({ length: wall.width }, () => ({ r: 0, g: 0, b: 0, w: 0 }))
          );
          continue;
        }
        for (let y = 0; y < wall.height; y++) {
          if (!Array.isArray(grid[y])) {
            grid[y] = Array.from({ length: wall.width }, () => ({ r: 0, g: 0, b: 0, w: 0 }));
          }
          // Pad/trim row to correct width
          while (grid[y].length < wall.width) {
            grid[y].push(grid[y][grid[y].length - 1] || { r: 0, g: 0, b: 0, w: 0 });
          }
          grid[y] = grid[y].slice(0, wall.width).map(clamp);
        }
      }

      // Convert to a color map keyed by light_id (covers every configured light,
      // whatever its id)
      const colorMap = wallGridToColorMap(wallGrids, walls, lights);

      designData = {
        type: 'static',
        name: (rawData.name as string) || 'AI Design',
        colors: colorMap,
      };
    } else if (rawData.type === 'motion') {
      designData = rawData as unknown as MotionDesign;

      // Ensure effect is 'ai'
      if (designData.effect !== 'ai') {
        designData.effect = 'ai';
      }

      // Ensure code exists
      if (!designData.params) {
        designData.params = {};
      }
      if (typeof designData.params.code !== 'string') {
        designData.params.code = '';
      }

      // Add prompt from description
      designData.params.prompt = description;

      if (!Array.isArray(designData.colors)) {
        designData.colors = [];
      }
      if (typeof designData.speed !== 'number') {
        designData.speed = 1.0;
      }
      if (designData.scope !== 'all' && designData.scope !== 'wall' && designData.scope !== 'group') {
        designData.scope = 'all';
      }
    } else {
      throw new Error('Design must be either static or motion type');
    }

    return {
      success: true,
      design: designData,
    };

  } catch (error) {
    console.error('AI design generation error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

// Get list of existing designs for frontend display
export function getDesignsForAI(): Array<{ id: string; name: string; type: string }> {
  const db = getDatabase();
  return db.prepare('SELECT id, name, type FROM designs ORDER BY name').all() as Array<{
    id: string;
    name: string;
    type: string;
  }>;
}
