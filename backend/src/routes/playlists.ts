import { Router, Request, Response } from 'express';
import { getDatabase } from '../models/database.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

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
  const { name, play_mode = 'sequence', items = [] } = req.body;
  const id = uuidv4();

  db.prepare(`
    INSERT INTO playlists (id, name, play_mode, created_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
  `).run(id, name, play_mode);

  // Insert items
  const insertItem = db.prepare(`
    INSERT INTO playlist_items (id, playlist_id, design_id, duration, position)
    VALUES (?, ?, ?, ?, ?)
  `);

  items.forEach((item: any, index: number) => {
    insertItem.run(uuidv4(), id, item.design_id, item.duration, index);
  });

  res.json({ id, name, play_mode, items });
});

// Update a playlist
router.put('/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;
  const { name, play_mode, items } = req.body;

  db.prepare(`
    UPDATE playlists SET name = ?, play_mode = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(name, play_mode, id);

  // Update items if provided
  if (items) {
    // Delete existing items
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(id);

    // Insert new items
    const insertItem = db.prepare(`
      INSERT INTO playlist_items (id, playlist_id, design_id, duration, position)
      VALUES (?, ?, ?, ?, ?)
    `);

    items.forEach((item: any, index: number) => {
      insertItem.run(uuidv4(), id, item.design_id, item.duration, index);
    });
  }

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

  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(id);
  db.prepare('DELETE FROM playlists WHERE id = ?').run(id);

  res.json({ success: true });
});

// Add item to playlist
router.post('/:id/items', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;
  const { design_id, duration, position } = req.body;
  const itemId = uuidv4();

  // Get max position if not provided
  let pos = position;
  if (pos === undefined) {
    const maxPos = db.prepare(
      'SELECT MAX(position) as max FROM playlist_items WHERE playlist_id = ?'
    ).get(id) as { max: number | null };
    pos = (maxPos.max || -1) + 1;
  }

  db.prepare(`
    INSERT INTO playlist_items (id, playlist_id, design_id, duration, position)
    VALUES (?, ?, ?, ?, ?)
  `).run(itemId, id, design_id, duration, pos);

  db.prepare(`UPDATE playlists SET updated_at = datetime('now') WHERE id = ?`).run(id);

  res.json({ id: itemId, playlist_id: id, design_id, duration, position: pos });
});

// Update playlist item
router.put('/:id/items/:itemId', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id, itemId } = req.params;
  const { duration, position } = req.body;

  db.prepare(`
    UPDATE playlist_items SET duration = ?, position = ?
    WHERE id = ? AND playlist_id = ?
  `).run(duration, position, itemId, id);

  db.prepare(`UPDATE playlists SET updated_at = datetime('now') WHERE id = ?`).run(id);

  res.json({ success: true });
});

// Remove item from playlist
router.delete('/:id/items/:itemId', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id, itemId } = req.params;

  db.prepare('DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?').run(itemId, id);
  db.prepare(`UPDATE playlists SET updated_at = datetime('now') WHERE id = ?`).run(id);

  res.json({ success: true });
});

// Reorder playlist items
router.post('/:id/reorder', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id } = req.params;
  const { itemIds } = req.body; // Array of item IDs in new order

  const updatePos = db.prepare(
    'UPDATE playlist_items SET position = ? WHERE id = ? AND playlist_id = ?'
  );

  itemIds.forEach((itemId: string, index: number) => {
    updatePos.run(index, itemId, id);
  });

  db.prepare(`UPDATE playlists SET updated_at = datetime('now') WHERE id = ?`).run(id);

  res.json({ success: true });
});

export default router;
