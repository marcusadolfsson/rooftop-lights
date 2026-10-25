import { Router, Request, Response } from 'express';
import { getScheduler, PlaylistPreviewData } from '../scheduler/scheduler.js';
import type { TimelineItemRow } from '../services/playlistTimeline.js';
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
    // What the preview shows (live or WebSocket-only), with the playlist position for playlists
    previewInfo: scheduler.getPreviewInfo(),
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

const MAX_PREVIEW_ITEMS = 500;
const MAX_DURATION_SECONDS = 7 * 24 * 3600;
const MAX_REPEAT_COUNT = 1000;

/** Validate the editor's unsaved items (same shape as playlist items; ids aren't needed). */
function parsePreviewItems(raw: unknown): { items: TimelineItemRow[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'items must be an array' };
  if (raw.length > MAX_PREVIEW_ITEMS) return { error: `items: at most ${MAX_PREVIEW_ITEMS} items` };
  const items: TimelineItemRow[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown> | null;
    const where = `items[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: `${where} must be an object` };
    const designId = item.design_id ?? null;
    const childId = item.child_playlist_id ?? null;
    if ((designId === null) === (childId === null)) return { error: `${where}: set exactly one of design_id or child_playlist_id` };
    if ((designId !== null && typeof designId !== 'string') || (childId !== null && typeof childId !== 'string')) {
      return { error: `${where}: design_id / child_playlist_id must be a string` };
    }
    const repeatMode = item.repeat_mode ?? 'seconds';
    if (repeatMode !== 'seconds' && repeatMode !== 'times') return { error: `${where}: repeat_mode must be "seconds" or "times"` };
    const repeatCount = item.repeat_count ?? 1;
    if (!Number.isInteger(repeatCount) || (repeatCount as number) < 1 || (repeatCount as number) > MAX_REPEAT_COUNT) {
      return { error: `${where}: repeat_count must be a whole number from 1 to ${MAX_REPEAT_COUNT}` };
    }
    const duration = item.duration ?? 10;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 1 || duration > MAX_DURATION_SECONDS) {
      return { error: `${where}: duration must be a number of seconds from 1 to ${MAX_DURATION_SECONDS}` };
    }
    const transition = item.transition ?? 'cut';
    if (transition !== 'cut' && transition !== 'fade' && transition !== 'fade_black') {
      return { error: `${where}: transition must be "cut", "fade" or "fade_black"` };
    }
    items.push({
      id: `item${i}`,
      design_id: designId as string | null,
      child_playlist_id: childId as string | null,
      duration,
      repeat_mode: repeatMode,
      repeat_count: repeatCount as number,
      transition,
    });
  }
  return { items };
}

// Preview a playlist or scene: a saved one ({ playlistId }), or the editor's current, possibly
// unsaved contents ({ items, play_mode, playlistId? }). startIndex starts playback at that item
// (then it continues and loops as usual). live=true (the default, for older clients) also sends
// it to ArtNet; live=false is WebSocket only.
router.post('/playlist', (req: Request, res: Response) => {
  const db = getDatabase();
  const scheduler = getScheduler();
  const { playlistId, items, play_mode: playMode = 'sequence', startIndex, live = true } = req.body ?? {};

  if (playlistId !== undefined && (typeof playlistId !== 'string' || !playlistId)) {
    res.status(400).json({ error: 'playlistId must be a playlist id' });
    return;
  }
  if (startIndex !== undefined && (!Number.isInteger(startIndex) || startIndex < 0)) {
    res.status(400).json({ error: 'startIndex must be a non-negative integer' });
    return;
  }
  if (typeof live !== 'boolean') {
    res.status(400).json({ error: 'live must be true or false' });
    return;
  }

  const data: PlaylistPreviewData = { startAt: startIndex };
  if (items !== undefined) {
    const parsed = parsePreviewItems(items);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    if (playMode !== 'sequence' && playMode !== 'random') {
      res.status(400).json({ error: 'play_mode must be "sequence" or "random"' });
      return;
    }
    data.items = parsed.items;
    data.playMode = playMode;
    // The playlist being edited, if saved (nested items can't loop back into it)
    if (playlistId) data.playlistId = playlistId;
  } else {
    if (!playlistId) {
      res.status(400).json({ error: 'playlistId or items is required' });
      return;
    }
    if (!db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(playlistId)) {
      res.status(404).json({ error: 'Playlist not found' });
      return;
    }
    data.playlistId = playlistId;
  }

  // Rendered by the scheduler's playlist player (renderDesign 'playlist' branch)
  const design = { type: 'playlist', data };
  if (live) {
    scheduler.setLivePreview(true, design);
  } else {
    scheduler.setPreviewDesign(design);
  }

  res.json({ success: true, message: live ? 'Playlist preview started (live)' : 'Playlist preview started' });
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
