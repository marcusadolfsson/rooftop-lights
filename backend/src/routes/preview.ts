import { Router, Request, Response } from 'express';
import { getScheduler } from '../scheduler/scheduler.js';
import { getDatabase } from '../models/database.js';

const router = Router();

// Get preview status
router.get('/status', (req: Request, res: Response) => {
  const scheduler = getScheduler();

  res.json({
    isLivePreview: scheduler.isInLivePreview(),
  });
});

// Start live preview of a design
router.post('/start', (req: Request, res: Response) => {
  const db = getDatabase();
  const scheduler = getScheduler();
  const { designId, designType, designData } = req.body;

  let type: string;
  let data: unknown;

  if (designData) {
    // Direct data provided (for unsaved designs)
    type = designType;
    data = designData;
  } else if (designId) {
    // Load from database
    const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(designId) as any;

    if (!design) {
      res.status(404).json({ error: 'Design not found' });
      return;
    }

    type = design.type;
    data = JSON.parse(design.data);
  } else {
    res.status(400).json({ error: 'Either designId or designData is required' });
    return;
  }

  scheduler.setLivePreview(true, { type, data });

  res.json({ success: true, message: 'Live preview started' });
});

// Start live preview of a playlist
router.post('/playlist', (req: Request, res: Response) => {
  const db = getDatabase();
  const scheduler = getScheduler();
  const { playlistId } = req.body;

  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as any;

  if (!playlist) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }

  // For playlist preview, we use the scheduler's playlist rendering
  // This is a bit of a hack - we temporarily set it as the active schedule
  scheduler.setLivePreview(true, {
    type: 'playlist',
    data: { playlistId },
  });

  res.json({ success: true, message: 'Playlist preview started' });
});

// Stop live preview (return to scheduled)
router.post('/stop', (req: Request, res: Response) => {
  const scheduler = getScheduler();

  scheduler.setLivePreview(false);

  res.json({ success: true, message: 'Live preview stopped, returning to schedule' });
});

// Preview a static color on specific lights
router.post('/lights', (req: Request, res: Response) => {
  const scheduler = getScheduler();
  const { lights } = req.body; // Array of { light_id, r, g, b, w }

  if (!lights || !Array.isArray(lights)) {
    res.status(400).json({ error: 'lights array is required' });
    return;
  }

  // Create a static design from the lights data
  const colors: Record<number, { r: number; g: number; b: number; w: number }> = {};
  for (const light of lights) {
    colors[light.light_id] = {
      r: light.r || 0,
      g: light.g || 0,
      b: light.b || 0,
      w: light.w || 0,
    };
  }

  scheduler.setLivePreview(true, {
    type: 'static',
    data: { colors },
  });

  res.json({ success: true, message: 'Light preview active' });
});

// Preview a motion effect
router.post('/effect', (req: Request, res: Response) => {
  const scheduler = getScheduler();
  const { effectType, colors, params, speed, scope } = req.body;

  if (!effectType) {
    res.status(400).json({ error: 'effectType is required' });
    return;
  }

  scheduler.setLivePreview(true, {
    type: 'motion',
    data: {
      type: effectType,
      colors: colors || [],
      params: params || {},
      speed: speed || 1,
      scope: scope || 'all',
    },
  });

  res.json({ success: true, message: 'Effect preview active' });
});

export default router;
