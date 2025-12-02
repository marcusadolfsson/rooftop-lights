import { Router, Request, Response } from 'express';
import { getDatabase } from '../models/database.js';
import { getEffectEngine } from '../services/effectEngine.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

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

// Update a wall
router.put('/walls/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;
  const { name, width, height, connects_to_next } = req.body;

  db.prepare(`
    UPDATE walls SET name = ?, width = ?, height = ?, connects_to_next = ?
    WHERE id = ?
  `).run(name, width, height, connects_to_next ? 1 : 0, id);

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

  db.prepare('DELETE FROM lights WHERE wall_id = ?').run(id);
  db.prepare('DELETE FROM walls WHERE id = ?').run(id);

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
  const { light_id, light_type, dmx_start_channel } = req.body;

  db.prepare(`
    UPDATE lights SET light_id = ?, light_type = ?, dmx_start_channel = ?
    WHERE id = ?
  `).run(light_id, light_type, dmx_start_channel, id);

  getEffectEngine().loadLayout();

  res.json({ success: true });
});

// Create a light
router.post('/lights', (req: Request, res: Response) => {
  const db = getDatabase();
  const { wall_id, matrix_x, matrix_y, light_id, light_type, dmx_start_channel } = req.body;
  const id = uuidv4();

  db.prepare(`
    INSERT INTO lights (id, wall_id, matrix_x, matrix_y, light_id, light_type, dmx_start_channel)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, wall_id, matrix_x, matrix_y, light_id, light_type, dmx_start_channel);

  getEffectEngine().loadLayout();

  res.json({ id, wall_id, matrix_x, matrix_y, light_id, light_type, dmx_start_channel });
});

// Delete a light
router.delete('/lights/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;

  db.prepare('DELETE FROM lights WHERE id = ?').run(id);

  getEffectEngine().loadLayout();

  res.json({ success: true });
});

// Get complete layout for visualization
router.get('/layout', (req: Request, res: Response) => {
  const engine = getEffectEngine();
  const walls = engine.getWalls();
  const lights = engine.getLights();
  const matrix = engine.getLightMatrix();

  const layoutData = walls.map(wall => {
    const wallMatrix = matrix.get(wall.id) || [];
    return {
      ...wall,
      matrix: wallMatrix.map(row => row.map(light => ({
        id: light.id,
        light_id: light.light_id,
        light_type: light.light_type,
        dmx_start_channel: light.dmx_start_channel,
      }))),
    };
  });

  res.json({
    walls: layoutData,
    totalLights: lights.length,
    totalDMXChannels: lights.reduce((max, l) =>
      Math.max(max, l.dmx_start_channel + (l.light_type === 'RGBW' ? 3 : 2)), 0
    ),
  });
});

export default router;
