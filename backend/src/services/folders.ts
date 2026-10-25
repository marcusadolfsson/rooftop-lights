import { getDatabase } from '../models/database.js';

// Folders are labels on designs and playlists/scenes (the nullable `folder` column of both tables).
// A folder exists only while something is in it, and names are shared by every kind, so "Xmas"
// in the Static tab is the same folder as "Xmas" in the Playlist tab.
export const MAX_FOLDER_LENGTH = 60;

/** Every folder name in use, as stored. */
export function folderNamesInUse(): string[] {
  const rows = getDatabase().prepare(`
    SELECT folder FROM designs WHERE folder IS NOT NULL
    UNION SELECT folder FROM playlists WHERE folder IS NOT NULL
  `).all() as { folder: string }[];
  return rows.map(r => r.folder);
}

const sameName = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/** The stored names that match `name` case-insensitively (normally at most one). */
export function matchingFolders(name: string): string[] {
  return folderNamesInUse().filter(f => sameName(f, name));
}

/** Validate a folder name: trimmed, non-empty, at most MAX_FOLDER_LENGTH characters. */
export function validateFolderName(raw: unknown): { name: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'Folder name must be a string' };
  const name = raw.trim();
  if (!name) return { error: 'Folder name is required' };
  if (name.length > MAX_FOLDER_LENGTH) return { error: `Folder name too long (max ${MAX_FOLDER_LENGTH} characters)` };
  return { name };
}

/**
 * The folder to store for a `folder` field sent to POST/PUT: null or '' means unfiled; a name
 * that matches an existing folder case-insensitively takes that folder's spelling.
 */
export function parseFolderField(raw: unknown): { folder: string | null } | { error: string } {
  if (raw === null || (typeof raw === 'string' && !raw.trim())) return { folder: null };
  const parsed = validateFolderName(raw);
  if ('error' in parsed) return { error: `folder: ${parsed.error.replace(/^Folder name/, 'name')}` };
  return { folder: matchingFolders(parsed.name)[0] ?? parsed.name };
}
