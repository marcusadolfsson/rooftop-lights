import { Router, Request, Response } from 'express';
import { getDatabase } from '../models/database.js';
import { randomUUID as uuidv4 } from 'crypto';
import { generateDesignFromDescription } from '../services/aiDesigner.js';
import { validateDesign, safeParseJSON } from '../services/designValidation.js';
import { invalidateSchedule } from '../scheduler/scheduler.js';
import { getEffectEngine } from '../services/effectEngine.js';
import { getEffectTypes } from '../services/effectTypes.js';
import { parseFolderField } from '../services/folders.js';

const router = Router();

const MAX_NAME_LENGTH = 200;

function validateName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'Design "name" is required';
  if (name.length > MAX_NAME_LENGTH) return `Design name too long (max ${MAX_NAME_LENGTH} characters)`;
  return null;
}

// Parse a row's JSON data; a corrupt row is returned with data: null and
// dataError set instead of failing the whole request. Motion designs also get cycleSeconds:
// how long one complete cycle of the effect takes (null when it has none), which is what a
// playlist's "play X times" counts.
function parseRow(d: any) {
  const data = safeParseJSON(d.data);
  if (data === null) {
    return { ...d, data: null, dataError: 'Stored design data is not valid JSON' };
  }
  if (d.type !== 'motion') return { ...d, data };
  const frames = getEffectEngine().cycleFrames(data);
  return { ...d, data, cycleSeconds: frames === null ? null : Math.round((frames / 30) * 100) / 100 };
}

// Get all designs
router.get('/', (req: Request, res: Response) => {
  const db = getDatabase();
  const { type } = req.query;

  let designs;
  if (type) {
    designs = db.prepare('SELECT * FROM designs WHERE type = ? ORDER BY name').all(type);
  } else {
    designs = db.prepare('SELECT * FROM designs ORDER BY name').all();
  }

  // Parse data JSON for each design (corrupt rows are flagged, not fatal)
  res.json(designs.map(parseRow));
});

// Get a single design
router.get('/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;

  const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(id) as any;

  if (!design) {
    res.status(404).json({ error: 'Design not found' });
    return;
  }

  res.json(parseRow(design));
});

// Create a new design
router.post('/', (req: Request, res: Response) => {
  const db = getDatabase();
  const { name, type, data, folder: rawFolder = null } = req.body ?? {};

  const nameError = validateName(name);
  if (nameError) {
    res.status(400).json({ error: nameError });
    return;
  }
  const check = validateDesign(type, data);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }
  const folder = parseFolderField(rawFolder);
  if ('error' in folder) {
    res.status(400).json({ error: folder.error });
    return;
  }

  const id = uuidv4();

  db.prepare(`
    INSERT INTO designs (id, name, type, data, folder, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(id, name, type, JSON.stringify(data), folder.folder);

  invalidateSchedule();
  // Same shape as GET (cycleSeconds included), so a new design can go straight into a scene
  res.json(parseRow({ id, name, type, data: JSON.stringify(data), folder: folder.folder }));
});

// Update a design
router.put('/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;
  const body = req.body ?? {};
  const { name, data } = body;

  const existing = db.prepare('SELECT type FROM designs WHERE id = ?').get(id) as { type: string } | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Design not found' });
    return;
  }

  // folder is optional: not sent keeps the current one. Sent on its own ({ folder }) it only moves
  // the design, so the list's "Move to folder" works even for a design whose data is corrupt.
  const folder = body.folder === undefined ? null : parseFolderField(body.folder);
  if (folder && 'error' in folder) {
    res.status(400).json({ error: folder.error });
    return;
  }
  if (folder && Object.keys(body).every((key) => key === 'folder')) {
    db.prepare('UPDATE designs SET folder = ? WHERE id = ?').run(folder.folder, id);
    invalidateSchedule();
    res.json({ success: true, folder: folder.folder });
    return;
  }

  const nameError = validateName(name);
  if (nameError) {
    res.status(400).json({ error: nameError });
    return;
  }
  const check = validateDesign(existing.type, data);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }

  db.prepare(`
    UPDATE designs SET name = ?, data = ?, folder = CASE WHEN ? THEN ? ELSE folder END, updated_at = datetime('now')
    WHERE id = ?
  `).run(name, JSON.stringify(data), folder ? 1 : 0, folder ? folder.folder : null, id);

  invalidateSchedule();
  res.json({ success: true });
});

// Save as new design (copy)
router.post('/:id/copy', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;
  const { name, folder: rawFolder } = req.body ?? {};

  const original = db.prepare('SELECT * FROM designs WHERE id = ?').get(id) as any;

  if (!original) {
    res.status(404).json({ error: 'Design not found' });
    return;
  }
  // The copy lands in the original's folder unless another (or null for unfiled) is sent
  const folder = rawFolder === undefined ? { folder: original.folder ?? null } : parseFolderField(rawFolder);
  if ('error' in folder) {
    res.status(400).json({ error: folder.error });
    return;
  }

  const newId = uuidv4();
  const copyName = typeof name === 'string' && name.trim() ? name.slice(0, MAX_NAME_LENGTH) : `${original.name} (copy)`;

  db.prepare(`
    INSERT INTO designs (id, name, type, data, folder, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(newId, copyName, original.type, original.data, folder.folder);

  invalidateSchedule();
  res.json({
    ...parseRow({ id: newId, name: copyName, type: original.type, data: original.data, folder: folder.folder }),
  });
});

// Delete a design
router.delete('/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;

  // Check if design is used in playlists
  const playlistUsage = db.prepare(
    'SELECT COUNT(*) as count FROM playlist_items WHERE design_id = ?'
  ).get(id) as { count: number };

  if (playlistUsage.count > 0) {
    res.status(400).json({
      error: 'Design is used in playlists. Remove from playlists first.',
    });
    return;
  }

  // Check if design is used in schedules
  const scheduleUsage = db.prepare(
    'SELECT COUNT(*) as count FROM schedules WHERE design_id = ?'
  ).get(id) as { count: number };

  if (scheduleUsage.count > 0) {
    res.status(400).json({
      error: 'Design is used in schedules. Remove from schedules first.',
    });
    return;
  }

  db.prepare('DELETE FROM designs WHERE id = ?').run(id);

  invalidateSchedule();
  res.json({ success: true });
});

// Generate design using AI
router.post('/ai/generate', async (req: Request, res: Response) => {
  const { description, baseDesignId, mode, currentDesignData, considerDefective = true } = req.body ?? {};

  if (!description || typeof description !== 'string') {
    res.status(400).json({ error: 'Description is required' });
    return;
  }

  if (description.length > 1000) {
    res.status(400).json({ error: 'Description too long (max 1000 characters)' });
    return;
  }

  // Validate mode if provided
  if (mode && !['create', 'modify', 'derivative'].includes(mode)) {
    res.status(400).json({ error: 'Invalid mode. Must be: create, modify, or derivative' });
    return;
  }

  if (typeof considerDefective !== 'boolean') {
    res.status(400).json({ error: 'considerDefective must be true or false' });
    return;
  }

  // Check if API key is configured
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({
      error: 'AI features not available. ANTHROPIC_API_KEY not configured.',
      aiEnabled: false
    });
    return;
  }

  try {
    const result = await generateDesignFromDescription({
      description,
      baseDesignId,
      mode: mode || 'create',
      currentDesignData,
      considerDefective,
    });

    if (result.success) {
      res.json({
        success: true,
        design: result.design,
        designId: result.designId,
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error,
      });
    }
  } catch (error) {
    console.error('AI generation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate design',
    });
  }
});

// Check if AI features are available
router.get('/ai/status', (req: Request, res: Response) => {
  res.json({
    enabled: !!process.env.ANTHROPIC_API_KEY,
  });
});

// Get available motion effect types
router.get('/effects/types', (req: Request, res: Response) => {
  res.json(getEffectTypes());
});

export default router;
