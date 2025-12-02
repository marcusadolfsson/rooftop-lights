import { Router, Request, Response } from 'express';
import { getDatabase } from '../models/database.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// Get all schedules
router.get('/', (req: Request, res: Response) => {
  const db = getDatabase();

  const schedules = db.prepare(`
    SELECT s.*,
           d.name as design_name,
           p.name as playlist_name
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
           p.name as playlist_name
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
  const { design_id, playlist_id, design_type } = req.body;

  // Remove existing default
  db.prepare('DELETE FROM schedules WHERE is_default = 1').run();

  // Create new default
  const id = uuidv4();

  db.prepare(`
    INSERT INTO schedules (id, design_id, playlist_id, design_type, is_default, created_at)
    VALUES (?, ?, ?, ?, 1, datetime('now'))
  `).run(id, design_id || null, playlist_id || null, design_type);

  res.json({ id, design_id, playlist_id, design_type, is_default: 1 });
});

// Get active schedule (what's currently playing)
router.get('/active', (req: Request, res: Response) => {
  const db = getDatabase();
  const now = new Date().toISOString().split('T')[0];

  // Check for date-specific schedule
  let schedule = db.prepare(`
    SELECT s.*,
           d.name as design_name,
           p.name as playlist_name
    FROM schedules s
    LEFT JOIN designs d ON s.design_id = d.id
    LEFT JOIN playlists p ON s.playlist_id = p.id
    WHERE s.is_default = 0
      AND s.start_date <= ?
      AND s.end_date >= ?
    ORDER BY s.priority DESC
    LIMIT 1
  `).get(now, now);

  if (!schedule) {
    // Fall back to default
    schedule = db.prepare(`
      SELECT s.*,
             d.name as design_name,
             p.name as playlist_name
      FROM schedules s
      LEFT JOIN designs d ON s.design_id = d.id
      LEFT JOIN playlists p ON s.playlist_id = p.id
      WHERE s.is_default = 1
      LIMIT 1
    `).get();
  }

  res.json(schedule || null);
});

// Create a date-specific schedule
router.post('/', (req: Request, res: Response) => {
  const db = getDatabase();
  const { design_id, playlist_id, design_type, start_date, end_date, priority = 0 } = req.body;
  const id = uuidv4();

  db.prepare(`
    INSERT INTO schedules (id, design_id, playlist_id, design_type, is_default, start_date, end_date, priority, created_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, datetime('now'))
  `).run(id, design_id || null, playlist_id || null, design_type, start_date, end_date, priority);

  res.json({ id, design_id, playlist_id, design_type, is_default: 0, start_date, end_date, priority });
});

// Update a schedule
router.put('/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;
  const { design_id, playlist_id, design_type, start_date, end_date, priority } = req.body;

  db.prepare(`
    UPDATE schedules
    SET design_id = ?, playlist_id = ?, design_type = ?, start_date = ?, end_date = ?, priority = ?
    WHERE id = ?
  `).run(design_id || null, playlist_id || null, design_type, start_date, end_date, priority, id);

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

  res.json({ success: true });
});

export default router;
