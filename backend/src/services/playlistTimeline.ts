// Playlist timing: turns a playlist's items (designs or nested playlists, each played for X
// seconds or X times through) into a tree of leaf designs with lengths in real frames (30 FPS).
// Pure — the data comes in through a TimelineSource — so the scheduler, the routes (lengths shown
// in the editor) and the tests all share it.

export const TIMELINE_FPS = 30;
// Deepest nesting the player follows; anything below is skipped
export const MAX_PLAYLIST_DEPTH = 8;
// Shortest an item plays, so a zero/NaN duration can't spin through items every frame
const MIN_ITEM_FRAMES = TIMELINE_FPS;

export type RepeatMode = 'seconds' | 'times';
// How an item hands over to the next one: hard cut, crossfade, or fade out to black then in
export type Transition = 'cut' | 'fade' | 'fade_black';
// Length of a fade transition (shortened on items too short for it)
export const TRANSITION_FRAMES = TIMELINE_FPS;

export function normalizeTransition(v: unknown): Transition {
  return v === 'fade' || v === 'fade_black' ? v : 'cut';
}

export interface TimelineItemRow {
  id: string;
  design_id: string | null;
  child_playlist_id: string | null;
  duration: number;
  repeat_mode: string;
  repeat_count: number;
  transition?: string | null;
  // Set on a timed event: JSON of a Cue (as stored) or the Cue itself. Events are left out of the loop.
  cue?: string | Cue | null;
}

/**
 * When a timed event plays, in local time: once a day at `time`, or every `minutes` counted from
 * `from` (midnight when null), only before `until` when set (a window past midnight wraps).
 * Times are "HH:MM".
 */
export type Cue =
  | { type: 'at'; time: string }
  | { type: 'every'; minutes: number; from: string | null; until: string | null };

const MAX_CUE_MINUTES = 24 * 60;

/** Minutes since midnight of an "HH:MM" time, or null when it isn't one. */
export function parseClock(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Validate a cue from the API or the database: the normalised cue, null for none, or an error message. */
export function checkCue(raw: unknown): { cue: Cue | null } | { error: string } {
  if (raw === null || raw === undefined || raw === '') return { cue: null };
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return { error: 'cue must be an object' }; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'cue must be an object' };
  const c = v as Record<string, unknown>;
  if (c.type === 'at') {
    const time = parseClock(c.time);
    if (time === null) return { error: 'cue.time must be a time like "21:00"' };
    return { cue: { type: 'at', time: clock(time) } };
  }
  if (c.type === 'every') {
    const minutes = Number(c.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_CUE_MINUTES) {
      return { error: `cue.minutes must be a whole number from 1 to ${MAX_CUE_MINUTES}` };
    }
    const from = c.from === null || c.from === undefined || c.from === '' ? null : parseClock(c.from);
    if (from === null && c.from !== null && c.from !== undefined && c.from !== '') return { error: 'cue.from must be a time like "19:00"' };
    const until = c.until === null || c.until === undefined || c.until === '' ? null : parseClock(c.until);
    if (until === null && c.until !== null && c.until !== undefined && c.until !== '') return { error: 'cue.until must be a time like "23:00"' };
    return { cue: { type: 'every', minutes, from: from === null ? null : clock(from), until: until === null ? null : clock(until) } };
  }
  return { error: 'cue.type must be "at" or "every"' };
}

/** The cue of an item, or null when it is a normal (looping) item or its cue is unreadable. */
export function itemCue(item: { cue?: string | Cue | null }): Cue | null {
  const checked = checkCue(item.cue);
  return 'cue' in checked ? checked.cue : null;
}

/** Does `cue` go off at `minuteOfDay` (0..1439, local time)? */
export function cueFires(cue: Cue, minuteOfDay: number): boolean {
  if (cue.type === 'at') return parseClock(cue.time) === minuteOfDay;
  const from = parseClock(cue.from) ?? 0;
  const until = parseClock(cue.until);
  if (until !== null && until !== from) {
    const inside = from < until ? minuteOfDay >= from && minuteOfDay < until : minuteOfDay >= from || minuteOfDay < until;
    if (!inside) return false;
  }
  return ((minuteOfDay - from + 1440) % 1440) % cue.minutes === 0;
}

export interface TimelinePlaylist {
  play_mode: string;
  items: TimelineItemRow[];
}

export interface TimelineSource {
  playlist(id: string): TimelinePlaylist | undefined;
  /** Natural cycle of a design in real frames; null when it has none, undefined when the design is missing. */
  designCycle(designId: string): number | null | undefined;
}

/** A design shown for `frames` real frames, restarting its effect at frame 0. */
export interface TimelineLeaf {
  kind: 'leaf';
  designId: string;
  frames: number;
  // Item ids from the top playlist down, unique per position in the tree
  key: string;
  // How this item hands over to whatever plays next
  transition: Transition;
}

/** Children played in order `repeat` times, or (when `limit` is set) looped until `limit` frames. */
export interface TimelineGroup {
  kind: 'group';
  children: TimelineNode[];
  // One pass through the children
  passFrames: number;
  repeat: number;
  limit: number | null;
  // Child playlist in random mode: children are shuffled each time it starts
  shuffle: boolean;
  key: string;
  // How this item hands over to whatever plays next, once it has finished
  transition: Transition;
}

export type TimelineNode = TimelineLeaf | TimelineGroup;

/** A timed event: interrupts the loop when its cue goes off, plays `node` once, then the loop resumes. */
export interface TimelineCue {
  cue: Cue;
  node: TimelineNode;
  // Position in the playlist's own item list
  sourceIndex: number;
}

export interface PlaylistTimeline {
  playMode: 'sequence' | 'random';
  // Timed events of the top playlist (nested playlists' events don't play), in list order
  cues: TimelineCue[];
  // One node per top-level item (items that resolve to nothing are left out)
  items: TimelineNode[];
  // Position in the playlist's own item list of each entry of `items`
  sourceIndexes: number[];
  // Changes whenever anything that affects playback changes
  signature: string;
}

export function nodeFrames(node: TimelineNode): number {
  if (node.kind === 'leaf') return node.frames;
  // Deep nesting with big repeat counts can multiply past exact integers; that's millions of years
  return Math.min(Number.MAX_SAFE_INTEGER, node.limit ?? node.passFrames * node.repeat);
}

/** Real frames an item plays for in seconds mode (at least 1 s). */
export function secondsFrames(duration: unknown): number {
  const n = Number(duration);
  return Number.isFinite(n) ? Math.max(MIN_ITEM_FRAMES, Math.round(n * TIMELINE_FPS)) : MIN_ITEM_FRAMES;
}

function repeatCount(count: unknown): number {
  const n = Math.round(Number(count));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Resolve one item. `stack` holds the playlist ids above it, so a cycle (which the API rejects,
 * but the data could still hold) is cut off instead of recursing forever.
 */
export function buildTimelineItem(item: TimelineItemRow, src: TimelineSource, stack: string[], keyPrefix = ''): TimelineNode | null {
  const key = `${keyPrefix}/${item.id}`;
  const times = item.repeat_mode === 'times';
  if (item.design_id) {
    const cycle = src.designCycle(item.design_id);
    if (cycle === undefined) return null;
    // "times" needs a natural cycle; without one the item falls back to its duration
    const frames = times && cycle !== null ? Math.max(1, cycle) * repeatCount(item.repeat_count) : secondsFrames(item.duration);
    return { kind: 'leaf', designId: item.design_id, frames, key, transition: normalizeTransition(item.transition) };
  }
  const childId = item.child_playlist_id;
  if (!childId || stack.includes(childId) || stack.length >= MAX_PLAYLIST_DEPTH) return null;
  const child = src.playlist(childId);
  if (!child) return null;
  const children = buildItems(child.items, src, [...stack, childId], key);
  const passFrames = children.reduce((sum, c) => sum + nodeFrames(c), 0);
  if (passFrames <= 0) return null;
  return {
    kind: 'group',
    children,
    passFrames,
    repeat: times ? repeatCount(item.repeat_count) : 1,
    limit: times ? null : secondsFrames(item.duration),
    shuffle: child.play_mode === 'random',
    key,
    transition: normalizeTransition(item.transition),
  };
}

function buildItems(items: TimelineItemRow[], src: TimelineSource, stack: string[], keyPrefix: string, sourceIndexes?: number[]): TimelineNode[] {
  const out: TimelineNode[] = [];
  items.forEach((item, index) => {
    // Timed events aren't part of the loop
    if (itemCue(item)) return;
    const node = buildTimelineItem(item, src, stack, keyPrefix);
    if (!node) return;
    out.push(node);
    sourceIndexes?.push(index);
  });
  return out;
}

function signatureOf(node: TimelineNode): string {
  if (node.kind === 'leaf') return `${node.key}=${node.designId}:${node.frames}:${node.transition}`;
  return `${node.key}[${node.repeat}:${node.limit ?? ''}:${node.shuffle ? 'r' : 's'}:${node.transition}|${node.children.map(signatureOf).join(',')}]`;
}

export function buildPlaylistTimeline(playlistId: string, src: TimelineSource): PlaylistTimeline | null {
  const playlist = src.playlist(playlistId);
  if (!playlist) return null;
  const sourceIndexes: number[] = [];
  const items = buildItems(playlist.items, src, [playlistId], '', sourceIndexes);
  const cues: TimelineCue[] = [];
  playlist.items.forEach((item, sourceIndex) => {
    const cue = itemCue(item);
    if (!cue) return;
    const node = buildTimelineItem(item, src, [playlistId], '');
    if (node) cues.push({ cue, node, sourceIndex });
  });
  const playMode = playlist.play_mode === 'random' ? 'random' : 'sequence';
  const cueSignature = cues.map(c => `${JSON.stringify(c.cue)}>${signatureOf(c.node)}`).join(',');
  return { playMode, items, cues, sourceIndexes, signature: `${playMode}|${items.map(signatureOf).join(',')}|${cueSignature}` };
}

/** Timeline index to start at so playback begins with item `itemIndex` of the playlist (or the next one that plays). */
export function timelineStartIndex(timeline: PlaylistTimeline, itemIndex: number): number {
  const at = timeline.sourceIndexes.findIndex(i => i >= itemIndex);
  return at < 0 ? 0 : at;
}

/** Total real frames of one pass (sequence) or one round of every item (random). */
export function timelineFrames(timeline: PlaylistTimeline): number {
  return timeline.items.reduce((sum, n) => sum + nodeFrames(n), 0);
}

/** Copy of a node with shuffled children wherever a random child playlist sits. */
export function shuffleNode(node: TimelineNode, random: () => number = Math.random): TimelineNode {
  if (node.kind === 'leaf') return node;
  const children = node.children.map(c => shuffleNode(c, random));
  if (node.shuffle) {
    for (let i = children.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [children[i], children[j]] = [children[j], children[i]];
    }
  }
  return { ...node, children };
}

/** Leaf playing at `frame` frames into `node`, and the frame within that leaf. */
export function locate(node: TimelineNode, frame: number): { leaf: TimelineLeaf; frame: number } | null {
  if (frame < 0 || frame >= nodeFrames(node)) return null;
  if (node.kind === 'leaf') return { leaf: node, frame };
  let f = frame % node.passFrames;
  for (const child of node.children) {
    const len = nodeFrames(child);
    if (f < len) return locate(child, f);
    f -= len;
  }
  return null;
}

/**
 * Where `frame` falls in `node`: the leaf and frame within it, frames left until that leaf hands
 * over, and the transition used there (the leaf's own, or `node`'s when the leaf is the last thing
 * `node` plays).
 */
export function locateBoundary(node: TimelineNode, frame: number): { leaf: TimelineLeaf; frame: number; remaining: number; transition: Transition; endsNode: boolean } | null {
  const at = locate(node, frame);
  if (!at) return null;
  const toNodeEnd = nodeFrames(node) - frame;
  const toLeafEnd = at.leaf.frames - at.frame;
  const endsNode = toNodeEnd <= toLeafEnd;
  return {
    ...at,
    remaining: Math.min(toLeafEnd, toNodeEnd),
    transition: endsNode ? node.transition : at.leaf.transition,
    endsNode,
  };
}

/** Flat list of the leaves `node` plays, in order (for tests and debugging); stops after `max`. */
export function listLeaves(node: TimelineNode, max = 1000): { designId: string; frames: number; key: string }[] {
  const out: { designId: string; frames: number; key: string }[] = [];
  let frame = 0;
  const total = nodeFrames(node);
  while (frame < total && out.length < max) {
    const at = locate(node, frame);
    if (!at) break;
    const frames = Math.min(at.leaf.frames - at.frame, total - frame);
    out.push({ designId: at.leaf.designId, frames, key: at.leaf.key });
    frame += frames;
  }
  return out;
}

/**
 * Would adding `childId` as an item of `parentId` create a cycle? True when they are the same
 * playlist or `parentId` is reachable from `childId` at any depth.
 */
export function wouldCreateCycle(parentId: string, childId: string, childrenOf: (id: string) => string[]): boolean {
  const seen = new Set<string>();
  const todo = [childId];
  while (todo.length > 0) {
    const id = todo.pop()!;
    if (id === parentId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    todo.push(...childrenOf(id));
  }
  return false;
}
