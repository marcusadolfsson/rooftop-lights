import { useCallback, useState } from 'react';

// Folders are labels on designs, scenes and playlists (their `folder` field). A folder exists only
// while something is in it, and names are shared by all four tabs. Matching ignores case; the
// backend keeps the spelling of the folder that already exists.

export const MAX_FOLDER_LENGTH = 60;
export const UNFILED_LABEL = 'Unfiled';

type Foldered = { folder?: string | null };

export const sameFolder = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
const compareNames = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

/** Trimmed folder name, or null for unfiled. */
export function normalizeFolder(name: string | null | undefined): string | null {
  const trimmed = (name ?? '').trim();
  return trimmed ? trimmed : null;
}

/** Every folder name in use across the given lists, one spelling each, sorted. */
export function folderNames(...lists: Foldered[][]): string[] {
  const names: string[] = [];
  for (const list of lists) {
    for (const item of list) {
      const name = normalizeFolder(item.folder);
      if (name && !names.some((n) => sameFolder(n, name))) names.push(name);
    }
  }
  return names.sort(compareNames);
}

/** The existing spelling of `name`, or `name` itself when it is a new folder. */
export function canonicalFolder(name: string, existing: string[]): string {
  return existing.find((n) => sameFolder(n, name)) ?? name;
}

export interface FolderGroup<T> {
  // null: the Unfiled group
  folder: string | null;
  items: T[];
}

/** Items grouped by folder: Unfiled first, then folders alphabetically; items keep their order. */
export function groupByFolder<T extends Foldered>(items: T[]): FolderGroup<T>[] {
  const unfiled: T[] = [];
  const groups: FolderGroup<T>[] = [];
  for (const item of items) {
    const name = normalizeFolder(item.folder);
    if (!name) {
      unfiled.push(item);
      continue;
    }
    const group = groups.find((g) => sameFolder(g.folder!, name));
    if (group) group.items.push(item);
    else groups.push({ folder: name, items: [item] });
  }
  groups.sort((a, b) => compareNames(a.folder!, b.folder!));
  return unfiled.length > 0 ? [{ folder: null, items: unfiled }, ...groups] : groups;
}

/** True when any item is in a folder (lists without folders are shown flat, with no headers). */
export const hasFolders = (items: Foldered[]) => items.some((i) => normalizeFolder(i.folder) !== null);

// ---------------------------------------------------------------------------
// Collapsed groups, remembered per browser (localStorage) and per list ("scope")
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = 'folders.collapsed.';
// Separates a folder from a sub-group (e.g. a type inside a folder) in a group key
const SUB_SEPARATOR = '\u001f';

/** Storage key of a folder group (case-insensitive; '' is Unfiled), optionally of a sub-group in it. */
export const groupKey = (folder: string | null, sub?: string) =>
  `${(folder ?? '').toLocaleLowerCase()}${sub === undefined ? '' : `${SUB_SEPARATOR}${sub}`}`;

function readCollapsed(scope: string): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + scope);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(scope: string, keys: Set<string>): void {
  try {
    if (keys.size === 0) localStorage.removeItem(STORAGE_PREFIX + scope);
    else localStorage.setItem(STORAGE_PREFIX + scope, JSON.stringify([...keys]));
  } catch {
    /* storage unavailable: collapse state just isn't remembered */
  }
}

/** Collapsed folder groups of one list (e.g. 'static', 'picker-scene'). */
export function useCollapsedGroups(scope: string) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(scope));
  const isCollapsed = useCallback((key: string) => collapsed.has(key), [collapsed]);
  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeCollapsed(scope, next);
      return next;
    });
  }, [scope]);
  return { isCollapsed, toggle };
}

/**
 * After a folder rename, carry its collapse state (and its sub-groups') over to the new name in
 * every list. Lists already on screen pick it up the next time they mount.
 */
export function renameCollapsedFolder(from: string, to: string): void {
  try {
    const oldKey = groupKey(from);
    const newKey = groupKey(to);
    // Collected first: writing can remove keys, which shifts localStorage's indexes
    const storageKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (storageKey?.startsWith(STORAGE_PREFIX)) storageKeys.push(storageKey);
    }
    for (const storageKey of storageKeys) {
      const scope = storageKey.slice(STORAGE_PREFIX.length);
      const keys = readCollapsed(scope);
      const next = new Set<string>();
      for (const key of keys) {
        if (key === oldKey) next.add(newKey);
        else if (key.startsWith(oldKey + SUB_SEPARATOR)) next.add(newKey + key.slice(oldKey.length));
        else next.add(key);
      }
      writeCollapsed(scope, next);
    }
  } catch {
    /* storage unavailable */
  }
}
