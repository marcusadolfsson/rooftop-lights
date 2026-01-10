import { Router, Request, Response } from 'express';
import { getDatabase } from '../models/database.js';
import { v4 as uuidv4 } from 'uuid';
import { generateDesignFromDescription } from '../services/aiDesigner.js';

const router = Router();

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

  // Parse data JSON for each design
  const parsedDesigns = designs.map((d: any) => ({
    ...d,
    data: JSON.parse(d.data),
  }));

  res.json(parsedDesigns);
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

  res.json({
    ...design,
    data: JSON.parse(design.data),
  });
});

// Create a new design
router.post('/', (req: Request, res: Response) => {
  const db = getDatabase();
  const { name, type, data } = req.body;
  const id = uuidv4();

  db.prepare(`
    INSERT INTO designs (id, name, type, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(id, name, type, JSON.stringify(data));

  res.json({ id, name, type, data });
});

// Update a design
router.put('/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;
  const { name, data } = req.body;

  db.prepare(`
    UPDATE designs SET name = ?, data = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(name, JSON.stringify(data), id);

  res.json({ success: true });
});

// Save as new design (copy)
router.post('/:id/copy', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;
  const { name } = req.body;

  const original = db.prepare('SELECT * FROM designs WHERE id = ?').get(id) as any;

  if (!original) {
    res.status(404).json({ error: 'Design not found' });
    return;
  }

  const newId = uuidv4();

  db.prepare(`
    INSERT INTO designs (id, name, type, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(newId, name || `${original.name} (copy)`, original.type, original.data);

  res.json({
    id: newId,
    name: name || `${original.name} (copy)`,
    type: original.type,
    data: JSON.parse(original.data),
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

  res.json({ success: true });
});

// Generate design using AI
router.post('/ai/generate', async (req: Request, res: Response) => {
  const { description } = req.body;

  if (!description || typeof description !== 'string') {
    res.status(400).json({ error: 'Description is required' });
    return;
  }

  if (description.length > 1000) {
    res.status(400).json({ error: 'Description too long (max 1000 characters)' });
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
    const result = await generateDesignFromDescription(description);

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
  const effectTypes = [
    {
      type: 'candy_cane',
      name: 'Candy Cane',
      description: 'Red and white diagonal stripes scrolling like a barber pole',
      defaultColors: [
        { r: 255, g: 0, b: 0, w: 0 },
        { r: 0, g: 0, b: 0, w: 255 },
      ],
      params: {},
    },
    {
      type: 'checkerboard',
      name: 'Checkerboard',
      description: 'Alternating squares that shift position',
      defaultColors: [
        { r: 0, g: 0, b: 0, w: 255 },
        { r: 0, g: 0, b: 0, w: 0 },
      ],
      params: {},
    },
    {
      type: 'comet',
      name: 'Comet Wave',
      description: 'A bright comet head with fading tail sweeping back and forth',
      defaultColors: [{ r: 0, g: 0, b: 0, w: 255 }],
      params: {
        tailLength: { type: 'number', default: 8, min: 2, max: 20 },
        reverse: { type: 'boolean', default: false },
      },
    },
    {
      type: 'sparkle',
      name: 'Sparkles',
      description: 'Random lights twinkling like stars',
      defaultColors: [{ r: 0, g: 0, b: 0, w: 255 }],
      params: {
        density: { type: 'number', default: 0.15, min: 0.05, max: 0.5, step: 0.05 },
        fadeSpeed: { type: 'number', default: 0.3, min: 0.1, max: 1, step: 0.1 },
      },
    },
    {
      type: 'rainbow',
      name: 'Rainbow',
      description: 'Smooth rainbow colors flowing across the display',
      defaultColors: [],
      params: {},
    },
    {
      type: 'wave',
      name: 'Wave',
      description: 'Sinusoidal brightness wave',
      defaultColors: [{ r: 0, g: 0, b: 0, w: 255 }],
      params: {
        wavelength: { type: 'number', default: 10, min: 3, max: 32 },
      },
    },
    {
      type: 'chase',
      name: 'Chase',
      description: 'A group of lights chasing around the perimeter',
      defaultColors: [{ r: 0, g: 0, b: 0, w: 255 }],
      params: {
        groupSize: { type: 'number', default: 3, min: 1, max: 10 },
      },
    },
    {
      type: 'breathe',
      name: 'Breathe',
      description: 'All lights pulsing together like breathing',
      defaultColors: [{ r: 0, g: 0, b: 0, w: 255 }],
      params: {
        speed: { type: 'number', default: 0.05, min: 0.01, max: 0.2, step: 0.01 },
      },
    },
  ];

  res.json(effectTypes);
});

export default router;
