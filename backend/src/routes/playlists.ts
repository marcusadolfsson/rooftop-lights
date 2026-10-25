import { Router, Request, Response } from 'express';
import { getDatabase } from '../models/database.js';
import { randomUUID as uuidv4 } from 'crypto';
import { invalidateSchedule } from '../scheduler/scheduler.js';
import { getEffectEngine } from '../services/effectEngine.js';
import { safeParseJSON } from '../services/designValidation.js';
import {
  buildPlaylistTimeline, buildTimelineItem, nodeFrames, timelineFrames, wouldCreateCycle,
  TIMELINE_FPS, TimelineItemRow, TimelineSource,
} from '../services/playlistTimeline.js';

const router = Router();

const PLAY_MODES = ['sequence', 'random'];
const REPEAT_MODES = ['seconds', 'times'];
const MAX_DURATION_SECONDS = 7 * 24 * 3600;
const MAX_REPEAT_COUNT = 1000;
// Duration stored for a "times" item that didn't send one (used if the design loses its cycle)
const DEFAULT_DURATION_SECONDS = 10;

function validateDuration(duration: unknown, where: string): string | null {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 1) {
    return `${where}: duration must be a number of seconds >= 1`;
  }
  if (duration > MAX_DURATION_SECONDS) return `${where}: duration must be at most ${MAX_DURATION_SECONDS} seconds`;
  return null;
}

/** A playlist item as stored: exactly one of design_id / child_playlist_id is set. */
interface ItemFields {
  design_id: string | null;
  child_playlist_id: string | null;
  duration: number;
  repeat_mode: 'seconds' | 'times';
  repeat_count: number;
  transition: string;
}

function childPlaylistIds(id: string): string[] {
  const rows = getDatabase()
    .prepare('SELECT child_playlist_id FROM playlist_items WHERE playlist_id = ? AND child_playlist_id IS NOT NULL')
    .all(id) as { child_playlist_id: string }[];
  return rows.map(r => r.child_playlist_id);
}

/**
 * Validate one item and fill in defaults. Older clients send only design_id + duration, which
 * still means "this design for duration seconds". `parentId` is the playlist the item goes into
 * (null for a playlist being created, which nothing can contain yet).
 */
function parseItem(raw: unknown, where: string, parentId: string | null): { item: ItemFields } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${where} must be an object` };
  const item = raw as Record<string, unknown>;
  const db = getDatabase();

  const designId = item.design_id ?? null;
  const childId = item.child_playlist_id ?? null;
  if ((designId === null) === (childId === null)) {
    return { error: `${where}: set exactly one of design_id or child_playlist_id` };
  }
  if (designId !== null && (typeof designId !== 'string' || !db.prepare('SELECT 1 FROM designs WHERE id = ?').get(designId))) {
    return { error: `${where}: design_id does not refer to an existing design` };
  }
  if (childId !== null) {
    if (typeof childId !== 'string' || !db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(childId)) {
      return { error: `${where}: child_playlist_id does not refer to an existing playlist` };
    }
    if (parentId !== null && wouldCreateCycle(parentId, childId, childPlaylistIds)) {
      return {
        error: childId === parentId
          ? `${where}: a playlist can't contain itself`
          : `${where}: that playlist already contains this one, so adding it would loop forever`,
      };
    }
  }

  const repeatMode = item.repeat_mode ?? 'seconds';
  if (typeof repeatMode !== 'string' || !REPEAT_MODES.includes(repeatMode)) {
    return { error: `${where}: repeat_mode must be "seconds" or "times"` };
  }
  const repeatCount = item.repeat_count ?? 1;
  if (!Number.isInteger(repeatCount) || (repeatCount as number) < 1 || (repeatCount as number) > MAX_REPEAT_COUNT) {
    return { error: `${where}: repeat_count must be a whole number from 1 to ${MAX_REPEAT_COUNT}` };
  }
  // Duration is what a "seconds" item plays for; a "times" item keeps one as its fallback
  const duration = repeatMode === 'times' && item.duration === undefined ? DEFAULT_DURATION_SECONDS : item.duration;
  const durErr = validateDuration(duration, where);
  if (durErr) return { error: durErr };

  return {
    item: {
      design_id: designId as string | null,
      child_playlist_id: childId as string | null,
      duration: duration as number,
      repeat_mode: repeatMode as 'seconds' | 'times',
      repeat_count: repeatCount as number,
      transition: typeof item.transition === 'string' && item.transition ? item.transition : 'cut',
    },
  };
}

/** Validate an items array for create/replace. Returns the parsed items or an error message. */
function parseItems(items: unknown, parentId: string | null): { items: ItemFields[] } | { error: string } {
  if (!Array.isArray(items)) return { error: 'items must be an array' };
  const out: ItemFields[] = [];
  for (let i = 0; i < items.length; i++) {
    const parsed = parseItem(items[i], `items[${i}]`, parentId);
    if ('error' in parsed) return parsed;
    out.push(parsed.item);
  }
  return { items: out };
}

const INSERT_ITEM_SQL = `
  INSERT INTO playlist_items (id, playlist_id, design_id, child_playlist_id, duration, position, transition, repeat_mode, repeat_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function insertItemArgs(itemId: string, playlistId: string, item: ItemFields, position: number) {
  return [itemId, playlistId, item.design_id, item.child_playlist_id, item.duration, position, item.transition, item.repeat_mode, item.repeat_count];
}

/** Timeline data straight from the database (the scheduler uses its own cached copy). */
function dbTimelineSource(): TimelineSource {
  const db = getDatabase();
  const playlistStmt = db.prepare('SELECT play_mode FROM playlists WHERE id = ?');
  const itemsStmt = db.prepare(`
    SELECT id, design_id, child_playlist_id, duration, repeat_mode, repeat_count
    FROM playlist_items WHERE playlist_id = ? ORDER BY position
  `);
  const designStmt = db.prepare('SELECT type, data FROM designs WHERE id = ?');
  const cycles = new Map<string, number | null | undefined>();
  return {
    playlist: (id) => {
      const p = playlistStmt.get(id) as { play_mode: string } | undefined;
      return p ? { play_mode: p.play_mode, items: itemsStmt.all(id) as TimelineItemRow[] } : undefined;
    },
    designCycle: (designId) => {
      if (cycles.has(designId)) return cycles.get(designId);
      const d = designStmt.get(designId) as { type: string; data: string } | undefined;
      const data = d ? safeParseJSON(d.data) : null;
      const cycle = !d ? undefined : d.type === 'motion' && data ? getEffectEngine().cycleFrames(data) : null;
      cycles.set(designId, cycle);
      return cycle;
    },
  };
}

const seconds = (frames: number) => Math.round((frames / TIMELINE_FPS) * 100) / 100;

/**
 * A playlist row with its items, each with what it plays (design or nested playlist and its name)
 * and how long it lasts. totalSeconds is one pass in order (sequence) or one round of every item
 * (random).
 */
function withItems(playlist: any, src: TimelineSource) {
  const items = getDatabase().prepare(`
    SELECT pi.*, d.name as design_name, d.type as design_type, cp.name as child_playlist_name
    FROM playlist_items pi
    LEFT JOIN designs d ON pi.design_id = d.id
    LEFT JOIN playlists cp ON pi.child_playlist_id = cp.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.position
  `).all(playlist.id) as any[];
  const timeline = buildPlaylistTimeline(playlist.id, src);
  return {
    ...playlist,
    items: items.map((item) => {
      const node = buildTimelineItem(item, src, [playlist.id]);
      return { ...item, is_playlist: item.child_playlist_id !== null, seconds: node ? seconds(nodeFrames(node)) : 0 };
    }),
    totalSeconds: timeline ? seconds(timelineFrames(timeline)) : 0,
  };
}

// Get all playlists
router.get('/', (req: Request, res: Response) => {
  const db = getDatabase();

  const playlists = db.prepare('SELECT * FROM playlists ORDER BY name').all();
  const src = dbTimelineSource();
  res.json(playlists.map((playlist) => withItems(playlist, src)));
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

  res.json(withItems(playlist, dbTimelineSource()));
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
  const parsed = parseItems(items, null);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const id = uuidv4();

  const insertPlaylist = db.prepare(`
    INSERT INTO playlists (id, name, play_mode, created_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
  `);
  const insertItem = db.prepare(INSERT_ITEM_SQL);

  db.transaction(() => {
    insertPlaylist.run(id, name, play_mode);
    parsed.items.forEach((item, index) => {
      insertItem.run(...insertItemArgs(uuidv4(), id, item, index));
    });
  })();

  invalidateSchedule();
  res.json({ id, name, play_mode, items: parsed.items });
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
  let parsedItems: ItemFields[] | null = null;
  if (items) {
    const parsed = parseItems(items, id);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    parsedItems = parsed.items;
  }

  const updatePlaylist = db.prepare(`
    UPDATE playlists SET name = ?, play_mode = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
  const deleteItems = db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?');
  const insertItem = db.prepare(INSERT_ITEM_SQL);

  // All-or-nothing: a failure part-way must not leave the playlist half-replaced
  db.transaction(() => {
    updatePlaylist.run(name, play_mode, id);
    if (parsedItems) {
      deleteItems.run(id);
      parsedItems.forEach((item, index) => {
        insertItem.run(...insertItemArgs(uuidv4(), id, item, index));
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

  // Same rule as designs: don't silently drop it from playlists that play it
  const parents = db.prepare(`
    SELECT DISTINCT p.name FROM playlist_items pi JOIN playlists p ON pi.playlist_id = p.id
    WHERE pi.child_playlist_id = ? AND pi.playlist_id <> ?
  `).all(id, id) as { name: string }[];
  if (parents.length > 0) {
    res.status(400).json({
      error: `Playlist is used in other playlists (${parents.map(p => p.name).join(', ')}). Remove it from them first.`,
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
  const { position } = req.body ?? {};
  const itemId = uuidv4();

  if (!db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(id)) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }
  const parsed = parseItem(req.body ?? {}, 'item', id);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const item = parsed.item;
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
    db.prepare(INSERT_ITEM_SQL).run(...insertItemArgs(itemId, id, item, pos));
    db.prepare(`UPDATE playlists SET updated_at = datetime('now') WHERE id = ?`).run(id);
  })();

  invalidateSchedule();

  res.json({ id: itemId, playlist_id: id, ...item, position: pos });
});

// Update playlist item
router.put('/:id/items/:itemId', (req: Request, res: Response) => {
  const db = getDatabase();
  const { id, itemId } = req.params;
  const { duration, position, repeat_mode, repeat_count } = req.body ?? {};

  const existing = db.prepare('SELECT * FROM playlist_items WHERE id = ? AND playlist_id = ?').get(itemId, id) as
    (ItemFields & { position: number }) | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Playlist item not found' });
    return;
  }
  // Only the timing fields and position change here; anything not sent keeps its value
  const parsed = parseItem({
    ...existing,
    duration: duration ?? existing.duration,
    repeat_mode: repeat_mode ?? existing.repeat_mode,
    repeat_count: repeat_count ?? existing.repeat_count,
  }, 'item', null);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const pos = position ?? existing.position;
  if (!Number.isInteger(pos) || pos < 0) {
    res.status(400).json({ error: 'position must be a non-negative integer' });
    return;
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE playlist_items SET duration = ?, position = ?, repeat_mode = ?, repeat_count = ?
      WHERE id = ? AND playlist_id = ?
    `).run(parsed.item.duration, pos, parsed.item.repeat_mode, parsed.item.repeat_count, itemId, id);
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
