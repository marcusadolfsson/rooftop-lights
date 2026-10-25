import { Router, Request, Response } from 'express';
import { getDatabase } from '../models/database.js';
import { getEffectEngine } from '../services/effectEngine.js';
import { randomUUID as uuidv4 } from 'crypto';
import { MAX_ABSOLUTE_CHANNEL, CHANNELS_PER_UNIVERSE, MAX_UNIVERSES } from '../artnet/artnet.js';

const router = Router();

const LIGHT_TYPES = ['RGB', 'RGBW'];

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

/** Normalise "r,g" style defective channel lists. Returns { value } or { error }. */
function parseDefective(defective_channels: unknown): { value: string } | { error: string } {
  if (Array.isArray(defective_channels)) defective_channels = defective_channels.join(',');
  if (typeof defective_channels !== 'string') {
    return { error: 'defective_channels must be a comma-separated string of r, g, b, w' };
  }
  const allowed = ['r', 'g', 'b', 'w'];
  const channels = defective_channels.split(',').map(c => c.trim().toLowerCase()).filter(c => c !== '');
  const invalid = channels.filter(c => !allowed.includes(c));
  if (invalid.length > 0) {
    return { error: `Invalid defective channels: ${invalid.join(', ')}. Allowed: r, g, b, w` };
  }
  return { value: [...new Set(channels)].join(',') };
}

/** Validate light_id / light_type / dmx_start_channel. Returns an error message or null. */
function validateLightFields(light_id: unknown, light_type: unknown, dmx_start_channel: unknown): string | null {
  if (!isPositiveInt(light_id)) return 'light_id must be a positive integer';
  if (typeof light_type !== 'string' || !LIGHT_TYPES.includes(light_type)) return 'light_type must be "RGB" or "RGBW"';
  if (!isPositiveInt(dmx_start_channel)) return 'dmx_start_channel must be an integer >= 1';
  const width = light_type === 'RGBW' ? 4 : 3;
  const last = dmx_start_channel + width - 1;
  if (last > MAX_ABSOLUTE_CHANNEL) {
    return `dmx_start_channel ${dmx_start_channel} + ${width} channels exceeds ${MAX_ABSOLUTE_CHANNEL} (${MAX_UNIVERSES} universes x ${CHANNELS_PER_UNIVERSE})`;
  }
  // A fixture's channels must not straddle a universe boundary
  if (Math.floor((dmx_start_channel - 1) / CHANNELS_PER_UNIVERSE) !== Math.floor((last - 1) / CHANNELS_PER_UNIVERSE)) {
    return `Light channels ${dmx_start_channel}-${last} cross a ${CHANNELS_PER_UNIVERSE}-channel universe boundary`;
  }
  return null;
}

// Get all walls with their lights
router.get('/walls', (req: Request, res: Response) => {
  const db = getDatabase();

  const walls = db.prepare('SELECT * FROM walls ORDER BY position').all();
  const lights = db.prepare('SELECT * FROM lights ORDER BY wall_id, matrix_y, matrix_x').all();

  // Group lights by wall
  const wallsWithLights = walls.map((wall: any) => ({
    ...wall,
    lights: lights.filter((light: any) => light.wall_id === wall.id),
  }));

  res.json(wallsWithLights);
});

// Reorder walls
router.post('/walls/reorder', (req: Request, res: Response) => {
  const db = getDatabase();
  const { wallIds } = req.body;

  if (!Array.isArray(wallIds)) {
    res.status(400).json({ error: 'wallIds must be an array' });
    return;
  }

  const stmt = db.prepare('UPDATE walls SET position = ? WHERE id = ?');
  const updateAll = db.transaction((ids: string[]) => {
    ids.forEach((id, index) => stmt.run(index, id));
  });
  updateAll(wallIds);

  getEffectEngine().loadLayout();
  res.json({ success: true });
});

// Update a wall
router.put('/walls/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;
  const { name, width, height, connects_to_next, group_id } = req.body;

  db.prepare(`
    UPDATE walls SET name = ?, width = ?, height = ?, connects_to_next = ?, group_id = ?
    WHERE id = ?
  `).run(name, width, height, connects_to_next ? 1 : 0, group_id !== undefined ? group_id : null, id);

  // Reload effect engine layout
  getEffectEngine().loadLayout();

  res.json({ success: true });
});

// Create a new wall
router.post('/walls', (req: Request, res: Response) => {
  const db = getDatabase();
  const { name, width, height, position, connects_to_next } = req.body;
  const id = uuidv4();

  db.prepare(`
    INSERT INTO walls (id, name, width, height, position, connects_to_next)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, width, height, position, connects_to_next ? 1 : 0);

  getEffectEngine().loadLayout();

  res.json({ id, name, width, height, position, connects_to_next });
});

// Delete a wall
router.delete('/walls/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;

  db.transaction(() => {
    db.prepare('DELETE FROM lights WHERE wall_id = ?').run(id);
    db.prepare('DELETE FROM walls WHERE id = ?').run(id);
  })();

  getEffectEngine().loadLayout();

  res.json({ success: true });
});

// Get lights for a wall
router.get('/walls/:wallId/lights', (req: Request, res: Response) => {
  const db = getDatabase();
  const { wallId } = req.params;

  const lights = db.prepare(
    'SELECT * FROM lights WHERE wall_id = ? ORDER BY matrix_y, matrix_x'
  ).all(wallId);

  res.json(lights);
});

// Update a light
router.put('/lights/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;
  const { light_id, light_type, dmx_start_channel, defective_channels } = req.body ?? {};

  const existing = db.prepare('SELECT id FROM lights WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ error: 'Light not found' });
    return;
  }

  const fieldError = validateLightFields(light_id, light_type, dmx_start_channel);
  if (fieldError) {
    res.status(400).json({ error: fieldError });
    return;
  }

  if (defective_channels != null) {
    const parsed = parseDefective(defective_channels);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    db.prepare(`
      UPDATE lights SET light_id = ?, light_type = ?, dmx_start_channel = ?, defective_channels = ?
      WHERE id = ?
    `).run(light_id, light_type, dmx_start_channel, parsed.value, id);
  } else {
    // defective_channels omitted: leave the stored value untouched
    db.prepare(`
      UPDATE lights SET light_id = ?, light_type = ?, dmx_start_channel = ?
      WHERE id = ?
    `).run(light_id, light_type, dmx_start_channel, id);
  }

  getEffectEngine().loadLayout();

  res.json({ success: true });
});

// Create a light
router.post('/lights', (req: Request, res: Response) => {
  const db = getDatabase();
  const { wall_id, matrix_x, matrix_y, light_id, light_type = 'RGBW', dmx_start_channel, defective_channels } = req.body ?? {};
  const id = uuidv4();

  const wall = typeof wall_id === 'string'
    ? db.prepare('SELECT width, height FROM walls WHERE id = ?').get(wall_id) as { width: number; height: number } | undefined
    : undefined;
  if (!wall) {
    res.status(400).json({ error: 'wall_id does not refer to an existing wall' });
    return;
  }
  if (!Number.isInteger(matrix_x) || matrix_x < 0 || !Number.isInteger(matrix_y) || matrix_y < 0) {
    res.status(400).json({ error: 'matrix_x and matrix_y must be non-negative integers' });
    return;
  }
  const fieldError = validateLightFields(light_id, light_type, dmx_start_channel);
  if (fieldError) {
    res.status(400).json({ error: fieldError });
    return;
  }
  let validDefective = '';
  if (defective_channels != null && defective_channels !== '') {
    const parsed = parseDefective(defective_channels);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    validDefective = parsed.value;
  }

  db.prepare(`
    INSERT INTO lights (id, wall_id, matrix_x, matrix_y, light_id, light_type, dmx_start_channel, defective_channels)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, wall_id, matrix_x, matrix_y, light_id, light_type, dmx_start_channel, validDefective);

  getEffectEngine().loadLayout();

  res.json({ id, wall_id, matrix_x, matrix_y, light_id, light_type, dmx_start_channel, defective_channels: validDefective });
});

// Delete a light
router.delete('/lights/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;

  db.prepare('DELETE FROM lights WHERE id = ?').run(id);

  getEffectEngine().loadLayout();

  res.json({ success: true });
});

// Get all wall groups
router.get('/groups', (req: Request, res: Response) => {
  const db = getDatabase();
  const groups = db.prepare('SELECT * FROM wall_groups ORDER BY position').all();
  res.json(groups);
});

// Create a wall group
router.post('/groups', (req: Request, res: Response) => {
  const db = getDatabase();
  const { name } = req.body;
  const id = uuidv4();

  const maxPos = db.prepare('SELECT MAX(position) as maxPos FROM wall_groups').get() as { maxPos: number | null };
  const position = (maxPos.maxPos ?? -1) + 1;

  db.prepare('INSERT INTO wall_groups (id, name, position) VALUES (?, ?, ?)').run(id, name, position);
  res.json({ id, name, position });
});

// Update a wall group
router.put('/groups/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;
  const { name } = req.body;

  db.prepare('UPDATE wall_groups SET name = ? WHERE id = ?').run(name, id);
  res.json({ success: true });
});

// Delete a wall group
router.delete('/groups/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;

  db.transaction(() => {
    db.prepare('UPDATE walls SET group_id = NULL WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM wall_groups WHERE id = ?').run(id);
  })();

  getEffectEngine().loadLayout();
  res.json({ success: true });
});

// Get complete layout for visualization
router.get('/layout', (req: Request, res: Response) => {
  const db = getDatabase();
  const engine = getEffectEngine();
  const walls = engine.getWalls();
  const lights = engine.getLights();
  const matrix = engine.getLightMatrix();

  const groups = db.prepare('SELECT * FROM wall_groups ORDER BY position').all();
  // Fetch group_id for each wall from DB since effectEngine may not have it
  const wallRows = db.prepare('SELECT id, group_id FROM walls').all() as { id: string; group_id: string | null }[];
  const groupMap = new Map(wallRows.map(w => [w.id, w.group_id]));

  const layoutData = walls.map(wall => {
    const wallMatrix = matrix.get(wall.id) || [];
    return {
      ...wall,
      group_id: groupMap.get(wall.id) || null,
      matrix: wallMatrix.map(row => row.map(light => ({
        id: light.id,
        light_id: light.light_id,
        light_type: light.light_type,
        dmx_start_channel: light.dmx_start_channel,
        defective_channels: light.defective_channels || '',
      }))),
    };
  });

  res.json({
    walls: layoutData,
    groups,
    totalLights: lights.length,
    totalDMXChannels: lights.reduce((max, l) =>
      Math.max(max, l.dmx_start_channel + (l.light_type === 'RGBW' ? 3 : 2)), 0
    ),
  });
});

export default router;
