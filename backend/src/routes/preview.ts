import { Router, Request, Response } from 'express';
import { getScheduler } from '../scheduler/scheduler.js';
import { getDatabase } from '../models/database.js';
import { validateDesign, validateMotionData, safeParseJSON } from '../services/designValidation.js';

const router = Router();

// Get preview status
router.get('/status', (req: Request, res: Response) => {
  const scheduler = getScheduler();

  res.json({
    isLivePreview: scheduler.isInLivePreview(),
    hasPreview: scheduler.hasPreviewDesign(),
    livePreviewInfo: scheduler.getLivePreviewInfo(),
  });
});

// Start preview of a design (live=true sends to ArtNet, live=false is WebSocket only)
router.post('/start', (req: Request, res: Response) => {
  const db = getDatabase();
  const scheduler = getScheduler();
  const { designId, designType, designData, live = true } = req.body ?? {};

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
    data = safeParseJSON(design.data);
    if (data === null) {
      res.status(422).json({ error: 'Stored design data is corrupt (invalid JSON) and cannot be previewed' });
      return;
    }
  } else {
    res.status(400).json({ error: 'Either designId or designData is required' });
    return;
  }

  const check = validateDesign(type, data);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }

  const design = { type, data };

  if (live) {
    scheduler.setLivePreview(true, design);
  } else {
    scheduler.setPreviewDesign(design);
  }

  res.json({ success: true, message: live ? 'Live preview started' : 'Preview started' });
});

// Start live preview of a playlist
router.post('/playlist', (req: Request, res: Response) => {
  const db = getDatabase();
  const scheduler = getScheduler();
  const { playlistId } = req.body ?? {};

  if (typeof playlistId !== 'string' || !playlistId) {
    res.status(400).json({ error: 'playlistId is required' });
    return;
  }

  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as any;

  if (!playlist) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }

  // Rendered by the scheduler's playlist player (renderDesign 'playlist' branch)
  scheduler.setLivePreview(true, {
    type: 'playlist',
    data: { playlistId },
  });

  res.json({ success: true, message: 'Playlist preview started' });
});

// Stop live preview (return to scheduled)
router.post('/stop', (req: Request, res: Response) => {
  const scheduler = getScheduler();


  scheduler.clearPreview();

  res.json({ success: true, message: 'Live preview stopped, returning to schedule' });
});

// Clear WS-only preview (keeps live preview if active, lets schedule show on WS otherwise)
router.post('/clear-soft', (req: Request, res: Response) => {
  const scheduler = getScheduler();

  scheduler.clearSoftPreview();
  res.json({ success: true });
});

// Preview a static color on specific lights
router.post('/lights', (req: Request, res: Response) => {
  const scheduler = getScheduler();
  const { lights } = req.body ?? {}; // Array of { light_id, r, g, b, w }

  if (!lights || !Array.isArray(lights)) {
    res.status(400).json({ error: 'lights array is required' });
    return;
  }

  // Create a static design from the lights data
  const colors: Record<number, { r: number; g: number; b: number; w: number }> = {};
  for (const light of lights) {
    if (!light || typeof light !== 'object' || !Number.isInteger(light.light_id) || light.light_id < 0) {
      res.status(400).json({ error: 'Each light needs an integer light_id' });
      return;
    }
    colors[light.light_id] = {
      r: light.r || 0,
      g: light.g || 0,
      b: light.b || 0,
      w: light.w || 0,
    };
  }

  const check = validateDesign('static', { colors });
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }

  const live = req.body.live !== undefined ? req.body.live : true;
  const design = { type: 'static', data: { colors } };
  if (live) {
    scheduler.setLivePreview(true, design);
  } else {
    scheduler.setPreviewDesign(design);
  }

  res.json({ success: true, message: 'Light preview active' });
});

// Preview a motion effect (live=true sends to ArtNet, live=false is WebSocket only)
router.post('/effect', (req: Request, res: Response) => {
  const scheduler = getScheduler();
  const { effectType, colors, params, speed, scope, live = true } = req.body ?? {};

  if (!effectType) {
    res.status(400).json({ error: 'effectType is required' });
    return;
  }

  const design = {
    type: 'motion',
    data: {
      type: effectType,
      colors: colors || [],
      params: params || {},
      speed: speed || 1,
      scope: scope || 'all',
    },
  };

  const check = validateMotionData(design.data);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }

  if (live) {
    scheduler.setLivePreview(true, design);
  } else {
    scheduler.setPreviewDesign(design);
  }

  res.json({ success: true, message: live ? 'Effect preview active (live)' : 'Effect preview active' });
});

export default router;
