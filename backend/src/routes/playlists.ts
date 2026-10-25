import { Router, Request, Response } from 'express';
import { getDatabase } from '../models/database.js';
import { randomUUID as uuidv4 } from 'crypto';
import { invalidateSchedule } from '../scheduler/scheduler.js';

const router = Router();

const PLAY_MODES = ['sequence', 'random'];
const MAX_DURATION_SECONDS = 7 * 24 * 3600;

function validateDuration(duration: unknown, where: string): string | null {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 1) {
    return `${where}: duration must be a number of seconds >= 1`;
  }
  if (duration > MAX_DURATION_SECONDS) return `${where}: duration must be at most ${MAX_DURATION_SECONDS} seconds`;
  return null;
}

/** Validate an items array for create/replace. Returns an error message or null. */
function validateItems(items: unknown): string | null {
  if (!Array.isArray(items)) return 'items must be an array';
  const db = getDatabase();
  const designExists = db.prepare('SELECT 1 FROM designs WHERE id = ?');
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object') return `items[${i}] must be an object`;
    if (typeof item.design_id !== 'string' || !designExists.get(item.design_id)) {
      return `items[${i}]: design_id does not refer to an existing design`;
    }
    const durErr = validateDuration(item.duration, `items[${i}]`);
    if (durErr) return durErr;
  }
  return null;
}

// Get all playlists
router.get('/', (req: Request, res: Response) => {
  const db = getDatabase();

  const playlists = db.prepare('SELECT * FROM playlists ORDER BY name').all();

  // Get items for each playlist
  const playlistsWithItems = playlists.map((playlist: any) => {
    const items = db.prepare(`
      SELECT pi.*, d.name as design_name, d.type as design_type
      FROM playlist_items pi
      JOIN designs d ON pi.design_id = d.id
      WHERE pi.playlist_id = ?
      ORDER BY pi.position
    `).all(playlist.id);

    return {
      ...playlist,
      items,
    };
  });

  res.json(playlistsWithItems);
});

// Get a single playlist
router.get('/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;

  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id) as any;

  if (!playlist) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }

  const items = db.prepare(`
    SELECT pi.*, d.name as design_name, d.type as design_type
    FROM playlist_items pi
    JOIN designs d ON pi.design_id = d.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.position
  `).all(id);

  res.json({
    ...playlist,
    items,
  });
});

// Create a new playlist
router.post('/', (req: Request, res: Response) => {
  const db = getDatabase();
  const { name, play_mode = 'sequence', items = [] } = req.body ?? {};

  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'Playlist "name" is required' });
    return;
  }
  if (!PLAY_MODES.includes(play_mode)) {
    res.status(400).json({ error: 'play_mode must be "sequence" or "random"' });
    return;
  }
  const itemsError = validateItems(items);
  if (itemsError) {
    res.status(400).json({ error: itemsError });
    return;
  }

  const id = uuidv4();

  const insertPlaylist = db.prepare(`
    INSERT INTO playlists (id, name, play_mode, created_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
  `);
  const insertItem = db.prepare(`
    INSERT INTO playlist_items (id, playlist_id, design_id, duration, position, transition)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    insertPlaylist.run(id, name, play_mode);
    items.forEach((item: any, index: number) => {
      insertItem.run(uuidv4(), id, item.design_id, item.duration, index, item.transition || 'cut');
    });
  })();

  invalidateSchedule();
  res.json({ id, name, play_mode, items });
});

// Update a playlist
router.put('/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;
  const { name, play_mode, items } = req.body ?? {};

  const existing = db.prepare('SELECT id FROM playlists WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'Playlist "name" is required' });
    return;
  }
  if (!PLAY_MODES.includes(play_mode)) {
    res.status(400).json({ error: 'play_mode must be "sequence" or "random"' });
    return;
  }
  if (items) {
    const itemsError = validateItems(items);
    if (itemsError) {
      res.status(400).json({ error: itemsError });
      return;
    }
  }

  const updatePlaylist = db.prepare(`
    UPDATE playlists SET name = ?, play_mode = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
  const deleteItems = db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?');
  const insertItem = db.prepare(`
    INSERT INTO playlist_items (id, playlist_id, design_id, duration, position, transition)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // All-or-nothing: a failure part-way must not leave the playlist half-replaced
  db.transaction(() => {
    updatePlaylist.run(name, play_mode, id);
    if (items) {
      deleteItems.run(id);
      items.forEach((item: any, index: number) => {
        insertItem.run(uuidv4(), id, item.design_id, item.duration, index, item.transition || 'cut');
      });
    }
  })();

  invalidateSchedule();
  res.json({ success: true });
});

// Delete a playlist
router.delete('/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;

  // Check if playlist is used in schedules
  const scheduleUsage = db.prepare(
    'SELECT COUNT(*) as count FROM schedules WHERE playlist_id = ?'
  ).get(id) as { count: number };

  if (scheduleUsage.count > 0) {
    res.status(400).json({
      error: 'Playlist is used in schedules. Remove from schedules first.',
    });
    return;
  }

  db.transaction(() => {
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(id);
    db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
  })();

  invalidateSchedule();
  res.json({ success: true });
});

// Add item to playlist
router.post('/:id/items', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;
  const { design_id, duration, position, transition } = req.body ?? {};
  const itemId = uuidv4();

  if (!db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(id)) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }
  if (typeof design_id !== 'string' || !db.prepare('SELECT 1 FROM designs WHERE id = ?').get(design_id)) {
    res.status(400).json({ error: 'design_id does not refer to an existing design' });
    return;
  }
  const durErr = validateDuration(duration, 'item');
  if (durErr) {
    res.status(400).json({ error: durErr });
    return;
  }
  if (position !== undefined && (!Number.isInteger(position) || position < 0)) {
    res.status(400).json({ error: 'position must be a non-negative integer' });
    return;
  }

  // Get max position if not provided
  let pos = position;
  if (pos === undefined) {
    const maxPos = db.prepare(
      'SELECT MAX(position) as max FROM playlist_items WHERE playlist_id = ?'
    ).get(id) as { max: number | null };
    pos = (maxPos.max ?? -1) + 1;
  }

  db.transaction(() => {
    db.prepare(`
      INSERT INTO playlist_items (id, playlist_id, design_id, duration, position, transition)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(itemId, id, design_id, duration, pos, transition || 'cut');
    db.prepare(`UPDATE playlists SET updated_at = datetime('now') WHERE id = ?`).run(id);
  })();

  invalidateSchedule();

  res.json({ id: itemId, playlist_id: id, design_id, duration, position: pos, transition: transition || 'cut' });
});

// Update playlist item
router.put('/:id/items/:itemId', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id, itemId } = req.params;
  const { duration, position } = req.body ?? {};

  const durErr = validateDuration(duration, 'item');
  if (durErr) {
    res.status(400).json({ error: durErr });
    return;
  }
  if (!Number.isInteger(position) || position < 0) {
    res.status(400).json({ error: 'position must be a non-negative integer' });
    return;
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE playlist_items SET duration = ?, position = ?
      WHERE id = ? AND playlist_id = ?
    `).run(duration, position, itemId, id);
    db.prepare(`UPDATE playlists SET updated_at = datetime('now') WHERE id = ?`).run(id);
  })();

  invalidateSchedule();

  res.json({ success: true });
});

// Remove item from playlist
router.delete('/:id/items/:itemId', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id, itemId } = req.params;

  db.transaction(() => {
    db.prepare('DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?').run(itemId, id);
    db.prepare(`UPDATE playlists SET updated_at = datetime('now') WHERE id = ?`).run(id);
  })();

  invalidateSchedule();

  res.json({ success: true });
});

// Reorder playlist items
router.post('/:id/reorder', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;
  const { itemIds } = req.body ?? {}; // Array of item IDs in new order

  if (!Array.isArray(itemIds) || !itemIds.every((x: unknown) => typeof x === 'string')) {
    res.status(400).json({ error: 'itemIds must be an array of playlist item ids' });
    return;
  }

  const updatePos = db.prepare(
    'UPDATE playlist_items SET position = ? WHERE id = ? AND playlist_id = ?'
  );

  db.transaction(() => {
    itemIds.forEach((itemId: string, index: number) => {
      updatePos.run(index, itemId, id);
    });
    db.prepare(`UPDATE playlists SET updated_at = datetime('now') WHERE id = ?`).run(id);
  })();

  invalidateSchedule();

  res.json({ success: true });
});

export default router;
