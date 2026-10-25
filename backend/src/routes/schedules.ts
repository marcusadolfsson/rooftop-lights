import { Router, Request, Response } from 'express';
import { getDatabase } from '../models/database.js';
import { randomUUID as uuidv4 } from 'crypto';
import { findActiveSchedule } from '../scheduler/activeSchedule.js';
import { invalidateSchedule } from '../scheduler/scheduler.js';

const router = Router();

const DESIGN_TYPES = ['static', 'motion', 'playlist'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Validate the design/playlist reference of a schedule (a scene is a playlist id). Returns an error message or null. */
function validateTarget(design_type: unknown, design_id: unknown, playlist_id: unknown): string | null {
  const db = getDatabase();
  if (typeof design_type !== 'string' || !DESIGN_TYPES.includes(design_type)) {
    return 'design_type must be "static", "motion" or "playlist"';
  }
  if (design_type === 'playlist') {
    if (typeof playlist_id !== 'string' || !db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(playlist_id)) {
      return 'playlist_id does not refer to an existing playlist or scene';
    }
  } else if (typeof design_id !== 'string' || !db.prepare('SELECT 1 FROM designs WHERE id = ?').get(design_id)) {
    return 'design_id does not refer to an existing design';
  }
  return null;
}

function validateWindow(start_date: unknown, end_date: unknown, start_time: unknown, end_time: unknown): string | null {
  if (typeof start_date !== 'string' || !DATE_RE.test(start_date)) return 'start_date must be YYYY-MM-DD';
  if (typeof end_date !== 'string' || !DATE_RE.test(end_date)) return 'end_date must be YYYY-MM-DD';
  if (typeof start_time !== 'string' || !TIME_RE.test(start_time)) return 'start_time must be HH:MM (24h)';
  if (typeof end_time !== 'string' || !TIME_RE.test(end_time)) return 'end_time must be HH:MM (24h)';
  return null;
}

// Get all schedules
router.get('/', (req: Request, res: Response) => {
  const db = getDatabase();

  const schedules = db.prepare(`
    SELECT s.*,
           d.name as design_name,
           p.name as playlist_name,
           p.kind as playlist_kind
    FROM schedules s
    LEFT JOIN designs d ON s.design_id = d.id
    LEFT JOIN playlists p ON s.playlist_id = p.id
    ORDER BY s.is_default DESC, s.priority DESC, s.start_date
  `).all();

  res.json(schedules);
});

// Get the default schedule
router.get('/default', (req: Request, res: Response) => {
  const db = getDatabase();

  const schedule = db.prepare(`
    SELECT s.*,
           d.name as design_name,
           p.name as playlist_name,
           p.kind as playlist_kind
    FROM schedules s
    LEFT JOIN designs d ON s.design_id = d.id
    LEFT JOIN playlists p ON s.playlist_id = p.id
    WHERE s.is_default = 1
    LIMIT 1
  `).get();

  res.json(schedule || null);
});

// Set the default schedule
router.post('/default', (req: Request, res: Response) => {
  const db = getDatabase();
  const { design_id, playlist_id, design_type } = req.body ?? {};

  const targetError = validateTarget(design_type, design_id, playlist_id);
  if (targetError) {
    res.status(400).json({ error: targetError });
    return;
  }

  const id = uuidv4();

  // Replace the default atomically so there is never a moment with no default
  db.transaction(() => {
    db.prepare('DELETE FROM schedules WHERE is_default = 1').run();
    db.prepare(`
      INSERT INTO schedules (id, design_id, playlist_id, design_type, is_default, created_at)
      VALUES (?, ?, ?, ?, 1, datetime('now'))
    `).run(id, design_id || null, playlist_id || null, design_type);
  })();

  invalidateSchedule();

  res.json({ id, design_id, playlist_id, design_type, is_default: 1 });
});

// Get active schedule (what's currently playing) — same logic as the render loop
router.get('/active', (req: Request, res: Response) => {
  res.json(findActiveSchedule() || null);
});

// Create a date-specific schedule
router.post('/', (req: Request, res: Response) => {
  const db = getDatabase();
  const { design_id, playlist_id, design_type, start_date, end_date, start_time = '16:00', end_time = '16:00', priority = 0 } = req.body ?? {};

  const error = validateTarget(design_type, design_id, playlist_id)
    ?? validateWindow(start_date, end_date, start_time, end_time)
    ?? (Number.isInteger(priority) ? null : 'priority must be an integer');
  if (error) {
    res.status(400).json({ error });
    return;
  }

  const id = uuidv4();

  db.prepare(`
    INSERT INTO schedules (id, design_id, playlist_id, design_type, is_default, start_date, end_date, start_time, end_time, priority, created_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, datetime('now'))
  `).run(id, design_id || null, playlist_id || null, design_type, start_date, end_date, start_time, end_time, priority);

  invalidateSchedule();
  res.json({ id, design_id, playlist_id, design_type, is_default: 0, start_date, end_date, start_time, end_time, priority });
});

// Update a schedule
router.put('/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;
  const { design_id, playlist_id, design_type, start_date, end_date, start_time, end_time, priority = 0 } = req.body ?? {};

  const existing = db.prepare('SELECT is_default FROM schedules WHERE id = ?').get(id) as { is_default: number } | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Schedule not found' });
    return;
  }
  const error = validateTarget(design_type, design_id, playlist_id)
    ?? (existing.is_default ? null : validateWindow(start_date, end_date, start_time || '16:00', end_time || '16:00'))
    ?? (Number.isInteger(priority) ? null : 'priority must be an integer');
  if (error) {
    res.status(400).json({ error });
    return;
  }

  db.prepare(`
    UPDATE schedules
    SET design_id = ?, playlist_id = ?, design_type = ?, start_date = ?, end_date = ?, start_time = ?, end_time = ?, priority = ?
    WHERE id = ?
  `).run(design_id || null, playlist_id || null, design_type, start_date ?? null, end_date ?? null, start_time || '16:00', end_time || '16:00', priority, id);

  invalidateSchedule();
  res.json({ success: true });
});

// Delete a schedule
router.delete('/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;

  // Don't allow deleting the default if it's the only one
  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as any;

  if (schedule && schedule.is_default === 1) {
    res.status(400).json({ error: 'Cannot delete the default schedule. Set a new default first.' });
    return;
  }

  db.prepare('DELETE FROM schedules WHERE id = ?').run(id);

  invalidateSchedule();
  res.json({ success: true });
});

export default router;
