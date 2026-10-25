import { Router, Request, Response } from 'express';
import { getDatabase } from '../models/database.js';
import { invalidateSchedule } from '../scheduler/scheduler.js';
import { matchingFolders, validateFolderName } from '../services/folders.js';

// Folders group designs, scenes and playlists in the UI. They are only labels (the `folder`
// column), so renaming or deleting one never touches what anything plays.
const router = Router();

type FolderKind = 'static' | 'motion' | 'scene' | 'playlist';
interface FolderSummary {
  name: string;
  counts: Record<FolderKind, number>;
  total: number;
}

// Every folder with how many designs (static / motion), scenes and playlists it holds
router.get('/', (req: Request, res: Response) => {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT folder, type AS kind, COUNT(*) AS count FROM designs WHERE folder IS NOT NULL GROUP BY folder, type
    UNION ALL
    SELECT folder, kind, COUNT(*) AS count FROM playlists WHERE folder IS NOT NULL GROUP BY folder, kind
  `).all() as { folder: string; kind: string; count: number }[];

  // Names are matched case-insensitively everywhere, so differently-cased rows count as one folder
  const byKey = new Map<string, FolderSummary>();
  for (const row of rows) {
    const key = row.folder.toLocaleLowerCase();
    let summary = byKey.get(key);
    if (!summary) {
      summary = { name: row.folder, counts: { static: 0, motion: 0, scene: 0, playlist: 0 }, total: 0 };
      byKey.set(key, summary);
    }
    if (row.kind in summary.counts) summary.counts[row.kind as FolderKind] += row.count;
    summary.total += row.count;
  }
  res.json([...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
});

/** Point every design and playlist in `from` (stored spellings) at `to`; returns rows changed. */
function setFolder(from: string[], to: string | null): number {
  const db = getDatabase();
  const updateDesigns = db.prepare('UPDATE designs SET folder = ? WHERE folder = ?');
  const updatePlaylists = db.prepare('UPDATE playlists SET folder = ? WHERE folder = ?');
  let changed = 0;
  db.transaction(() => {
    for (const name of from) {
      changed += updateDesigns.run(to, name).changes;
      changed += updatePlaylists.run(to, name).changes;
    }
  })();
  return changed;
}

// Rename a folder across all designs, scenes and playlists. Renaming onto another existing folder
// merges the two (under that folder's spelling); a case-only change just respells it.
router.put('/:name', (req: Request, res: Response) => {
  const from = matchingFolders(req.params.name);
  if (from.length === 0) {
    res.status(404).json({ error: 'Folder not found' });
    return;
  }
  const parsed = validateFolderName((req.body ?? {}).name);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const target = matchingFolders(parsed.name).filter(f => !from.includes(f));
  const merged = target.length > 0;
  const name = merged ? target[0] : parsed.name;

  const moved = setFolder(from, name);
  invalidateSchedule();
  res.json({ name, merged, moved });
});

// Delete a folder: everything in it becomes unfiled; nothing else is deleted
router.delete('/:name', (req: Request, res: Response) => {
  const from = matchingFolders(req.params.name);
  if (from.length === 0) {
    res.status(404).json({ error: 'Folder not found' });
    return;
  }
  const moved = setFolder(from, null);
  invalidateSchedule();
  res.json({ success: true, moved });
});

export default router;
