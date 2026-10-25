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

export interface TimelineItemRow {
  id: string;
  design_id: string | null;
  child_playlist_id: string | null;
  duration: number;
  repeat_mode: string;
  repeat_count: number;
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
}

export type TimelineNode = TimelineLeaf | TimelineGroup;

export interface PlaylistTimeline {
  playMode: 'sequence' | 'random';
  // One node per top-level item (items that resolve to nothing are left out)
  items: TimelineNode[];
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
    return { kind: 'leaf', designId: item.design_id, frames, key };
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
  };
}

function buildItems(items: TimelineItemRow[], src: TimelineSource, stack: string[], keyPrefix: string): TimelineNode[] {
  const out: TimelineNode[] = [];
  for (const item of items) {
    const node = buildTimelineItem(item, src, stack, keyPrefix);
    if (node) out.push(node);
  }
  return out;
}

function signatureOf(node: TimelineNode): string {
  if (node.kind === 'leaf') return `${node.key}=${node.designId}:${node.frames}`;
  return `${node.key}[${node.repeat}:${node.limit ?? ''}:${node.shuffle ? 'r' : 's'}|${node.children.map(signatureOf).join(',')}]`;
}

export function buildPlaylistTimeline(playlistId: string, src: TimelineSource): PlaylistTimeline | null {
  const playlist = src.playlist(playlistId);
  if (!playlist) return null;
  const items = buildItems(playlist.items, src, [playlistId], '');
  const playMode = playlist.play_mode === 'random' ? 'random' : 'sequence';
  return { playMode, items, signature: `${playMode}|${items.map(signatureOf).join(',')}` };
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
