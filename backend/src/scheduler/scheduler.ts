import type Database from 'better-sqlite3';
import type { WebSocket } from 'ws';
import { getDatabase } from '../models/database.js';
import { getArtNetController, ArtNetController } from '../artnet/artnet.js';
import { getEffectEngine, normalizeMotionEffect, MotionEffect, RGBW, Light } from '../services/effectEngine.js';
import { findActiveSchedule, ScheduleRow } from './activeSchedule.js';
import { logRateLimited } from '../utils/rateLimitedLog.js';
import {
  buildPlaylistTimeline, locate, nodeFrames, shuffleNode, timelineStartIndex,
  PlaylistTimeline, TimelineItemRow, TimelineNode, TimelineSource,
  locateBoundary,
  TRANSITION_FRAMES,
} from '../services/playlistTimeline.js';

function maskDefectiveChannels(light: Light, color: RGBW): RGBW {
  if (!light.defective_channels) return color;
  const channels = light.defective_channels.split(',');
  const masked = { ...color };
  for (const ch of channels) {
    if (ch === 'r') masked.r = 0;
    else if (ch === 'g') masked.g = 0;
    else if (ch === 'b') masked.b = 0;
    else if (ch === 'w') masked.w = 0;
  }
  return masked;
}

interface DesignRow {
  id: string;
  type: string;
  data: string;
  updated_at: string | null;
}

interface PlaylistRow {
  id: string;
  play_mode: 'sequence' | 'random';
}


export interface PlaylistPosition {
  itemIndex: number;
  itemFrame: number;
  itemFrames: number;
  designId: string;
  designFrame: number;
}

export interface PreviewDesign {
  type: string;
  data: unknown;
}

/**
 * Data of a 'playlist' preview: a saved playlist (playlistId), or the editor's unsaved contents
 * (items + playMode; playlistId then names the playlist being edited, if it is saved, so nested
 * items can't loop back into it). startAt is the item index playback starts from.
 */
export interface PlaylistPreviewData {
  playlistId?: string;
  items?: TimelineItemRow[];
  playMode?: 'sequence' | 'random';
  startAt?: number;
}

const UNSAVED_PLAYLIST_ID = '(unsaved)';

// Re-evaluate the active schedule / playlist rows at most this often (ms).
// Routes that change data call invalidate() so edits show up immediately.
const SCHEDULE_TTL_MS = 1000;
const FRAME_INTERVAL_MS = 33; // ~30 FPS
// Skip WS clients whose send buffer is this full (slow/stalled connections)
const WS_MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_FLASH_MS = 500;

const BLANK: Map<number, RGBW> = new Map();

/**
 * Plays a playlist timeline: steps through the top-level items (in order, or picking at random),
 * counting real frames into the current one. A nested playlist item plays its whole sequence
 * through before the next top-level item; each design restarts its effect at frame 0, so
 * "X times" lines up with complete cycles.
 */
/** What a playlist shows this frame; during a fade, `blend` is the next design and how far in. */
interface PlaylistStep {
  designId: string;
  frame: number;
  blend?: { designId: string; frame: number; t: number; mode: 'fade' | 'fade_black' };
}

class PlaylistPlayer {
  private signature = '';
  private index = 0;
  private current: TimelineNode | null = null;
  private frame = 0;
  private last: { designId: string; frame: number } | null = null;
  private sourceIndexes: number[] = [];
  // Random mode: the next item, picked early when a fade into it starts
  private pendingIndex: number | null = null;

  reset(): void {
    this.signature = '';
    this.last = null;
  }

  /**
   * Returns the design to show and the frame number within it. `startAt` (an index into the
   * playlist's own items, used by the editor's per-item Play) is where playback starts; after
   * that it continues and loops as usual.
   */
  step(playlistId: string, timeline: PlaylistTimeline, startAt?: number): PlaylistStep | null {
    const items = timeline.items;
    if (items.length === 0) {
      this.reset();
      return null;
    }

    // Any change to the playlist identity or anything it plays restarts playback
    const signature = `${playlistId}|${timeline.signature}`;
    if (signature !== this.signature) {
      this.signature = signature;
      this.sourceIndexes = timeline.sourceIndexes;
      this.index = startAt !== undefined
        ? timelineStartIndex(timeline, startAt)
        : timeline.playMode === 'random' ? Math.floor(Math.random() * items.length) : 0;
      this.startItem(items);
    }

    if (!this.current || this.frame >= nodeFrames(this.current)) {
      if (timeline.playMode === 'random') {
        if (this.pendingIndex !== null) {
          // Already picked while fading into it
          this.index = this.pendingIndex % items.length;
        } else if (items.length > 1) {
          // Pick a different item than the one that just finished
          const next = Math.floor(Math.random() * (items.length - 1));
          this.index = next >= this.index ? next + 1 : next;
        }
      } else {
        this.index = (this.index + 1) % items.length;
      }
      this.startItem(items);
    }

    const frame = this.frame++;
    const at = this.current ? locateBoundary(this.current, frame) : null;
    this.last = at ? { designId: at.leaf.designId, frame: at.frame } : null;
    if (!at || !this.current || at.transition === 'cut') return this.last;

    // Fade transitions run over the last TRANSITION_FRAMES of the item (at most half of it) into
    // whatever plays next: the next leaf inside this item, or the next item (the first one again
    // when the playlist loops). The next design is shown at its first frame during the fade.
    const fade = Math.max(1, Math.min(TRANSITION_FRAMES, Math.floor(at.leaf.frames / 2)));
    if (at.remaining > fade) return this.last;
    let next: { designId: string; frame: number } | null = null;
    if (!at.endsNode) {
      const n = locate(this.current, frame + at.remaining);
      next = n ? { designId: n.leaf.designId, frame: 0 } : null;
    } else {
      const n = locate(items[this.peekNextIndex(items.length, timeline.playMode)], 0);
      next = n ? { designId: n.leaf.designId, frame: 0 } : null;
    }
    if (!next) return this.last;
    // 0 at the start of the fade, 1 on its last frame
    const t = (fade - at.remaining + 1) / fade;
    return { ...this.last!, blend: { ...next, t, mode: at.transition } };
  }

  /** Index of the item that will play after the current one (chosen now in random mode, then kept). */
  private peekNextIndex(count: number, playMode: 'sequence' | 'random'): number {
    if (playMode !== 'random') return (this.index + 1) % count;
    if (this.pendingIndex === null) {
      const next = Math.floor(Math.random() * Math.max(1, count - 1));
      this.pendingIndex = count > 1 && next >= this.index ? next + 1 : next;
    }
    return this.pendingIndex;
  }

  /** Where playback is: top-level item index, frames into it, and the design showing. */
  position(): PlaylistPosition | null {
    if (!this.signature || !this.current || !this.last) return null;
    return {
      itemIndex: this.sourceIndexes[this.index] ?? this.index,
      itemFrame: this.frame,
      itemFrames: nodeFrames(this.current),
      designId: this.last.designId,
      designFrame: this.last.frame,
    };
  }

  private startItem(items: TimelineNode[]): void {
    this.pendingIndex = null;
    // A random child playlist gets a fresh order each time its item starts
    this.current = shuffleNode(items[this.index % items.length]);
    this.frame = 0;
  }
}

/** One output stream (ArtNet, or WS-only preview) with its own frame counter and playlist state. */
class RenderSource {
  frame = 0;
  identity = '';
  readonly playlist = new PlaylistPlayer();

  /** Restart animation when what we are rendering changes. */
  setIdentity(identity: string): void {
    if (identity !== this.identity) {
      this.identity = identity;
      this.frame = 0;
      this.playlist.reset();
    }
  }
}

export class Scheduler {
  private isRunning: boolean = false;
  private isLivePreview: boolean = false;
  private previewDesign: PreviewDesign | null = null;
  private livePreviewDesign: PreviewDesign | null = null;
  private frameCounter: number = 0;
  private frameInterval: NodeJS.Timeout | null = null;
  private wsClients: Set<WebSocket> = new Set();

  private artnetSource = new RenderSource();
  private wsSource = new RenderSource();
  private previewSeq = 0;

  // Caches
  private cachedSchedule: { at: number; schedule: ScheduleRow | null } | null = null;
  private playlistCache: Map<string, { at: number; playlist: PlaylistRow | undefined; items: TimelineItemRow[] }> = new Map();
  private timelineCache: Map<string, { at: number; timeline: PlaylistTimeline | null }> = new Map();
  // Timelines of unsaved (inline) playlist previews, by their preview data
  private inlineTimelineCache: WeakMap<object, { at: number; timeline: PlaylistTimeline | null }> = new WeakMap();
  private designCache: Map<string, { updatedAt: string | null; type: string; data: unknown }> = new Map();
  private stmtDb: Database.Database | null = null;
  private stmts: {
    design: Database.Statement;
    playlist: Database.Statement;
    items: Database.Statement;
  } | null = null;

  // Test flash override
  private flashUntil = 0;
  private wasFlashing = false;
  private lastLights: Light[] | null = null;

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.frameInterval = setInterval(() => this.tick(), FRAME_INTERVAL_MS);
    console.log('Scheduler started');
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.frameInterval) {
      clearInterval(this.frameInterval);
      this.frameInterval = null;
    }
    console.log('Scheduler stopped');
  }

  /** Drop cached schedule/playlist/design lookups. Call after any data change. */
  invalidate(): void {
    this.cachedSchedule = null;
    this.playlistCache.clear();
    this.timelineCache.clear();
    this.inlineTimelineCache = new WeakMap();
    this.designCache.clear();
  }

  /** Output full white on every channel for `ms`, then resume normal output. */
  flash(ms: number = DEFAULT_FLASH_MS): void {
    this.flashUntil = Date.now() + Math.max(50, Math.min(10_000, ms));
  }

  addWSClient(ws: WebSocket): void {
    this.wsClients.add(ws);
  }

  removeWSClient(ws: WebSocket): void {
    this.wsClients.delete(ws);
  }

  getWSClients(): Set<WebSocket> {
    return this.wsClients;
  }

  // Set a preview design for WebSocket broadcast only (no ArtNet)
  setPreviewDesign(design: PreviewDesign | null): void {
    this.previewDesign = design;
    this.wsSource.setIdentity(`preview:${++this.previewSeq}`);
  }

  // Enable/disable live ArtNet output of the preview design
  setLivePreview(enabled: boolean, design?: PreviewDesign): void {
    this.isLivePreview = enabled;
    if (design) {
      this.previewDesign = design;
      this.livePreviewDesign = design;
    }
    if (!enabled) {
      this.livePreviewDesign = null;
    }
    const id = `live:${++this.previewSeq}`;
    this.artnetSource.setIdentity(id);
    this.wsSource.setIdentity(id);
  }

  // Clear all preview state
  clearPreview(): void {
    this.isLivePreview = false;
    this.previewDesign = null;
    this.livePreviewDesign = null;
    this.artnetSource.setIdentity(`cleared:${++this.previewSeq}`);
  }

  // Clear only the WS-only preview (leaves live preview untouched)
  clearSoftPreview(): void {
    if (this.isLivePreview) {
      // Don't clear — let the live preview continue showing on WS via artnetFrame
      this.previewDesign = this.livePreviewDesign;
    } else {
      this.previewDesign = null;
    }
  }

  isInLivePreview(): boolean {
    return this.isLivePreview;
  }

  hasPreviewDesign(): boolean {
    return this.previewDesign !== null;
  }

  getLivePreviewInfo(): { type: string; effectType?: string; playlist?: PlaylistPosition | null } | null {
    if (!this.isLivePreview || !this.livePreviewDesign) return null;
    const info: { type: string; effectType?: string; playlist?: PlaylistPosition | null } = {
      type: this.livePreviewDesign.type,
    };
    if (this.livePreviewDesign.type === 'motion') {
      const data = this.livePreviewDesign.data as { type?: string } | null;
      info.effectType = data?.type;
    } else if (this.livePreviewDesign.type === 'playlist') {
      info.playlist = this.artnetSource.playlist.position();
    }
    return info;
  }

  /**
   * What the preview (live or WebSocket-only) is showing, with the playlist position when it is a
   * playlist. null when there is no preview.
   */
  getPreviewInfo(): { type: string; live: boolean; playlist?: PlaylistPosition | null } | null {
    if (!this.previewDesign) return null;
    const live = this.isLivePreview && this.livePreviewDesign === this.previewDesign;
    const info: { type: string; live: boolean; playlist?: PlaylistPosition | null } = { type: this.previewDesign.type, live };
    if (this.previewDesign.type === 'playlist') {
      info.playlist = (live ? this.artnetSource : this.wsSource).playlist.position();
    }
    return info;
  }

  private statements() {
    const db = getDatabase();
    if (!this.stmts || this.stmtDb !== db) {
      this.stmtDb = db;
      this.stmts = {
        design: db.prepare('SELECT id, type, data, updated_at FROM designs WHERE id = ?'),
        playlist: db.prepare('SELECT id, play_mode FROM playlists WHERE id = ?'),
        items: db.prepare(`
          SELECT id, design_id, child_playlist_id, duration, repeat_mode, repeat_count, transition
          FROM playlist_items WHERE playlist_id = ? ORDER BY position
        `),
      };
    }
    return this.stmts;
  }

  private tick(): void {
    const artnet = getArtNetController();
    let wsFrame: Map<number, RGBW> = BLANK;
    // True when the WebSocket frame is a preview rather than the scheduled output
    let wsIsPreview = false;

    try {
      let artnetFrame: Map<number, RGBW>;
      let isAnimated = false;

      // Determine what to show on ArtNet
      if (this.isLivePreview && this.livePreviewDesign) {
        artnetFrame = this.renderDesign(this.livePreviewDesign.type, this.livePreviewDesign.data, this.artnetSource);
        isAnimated = this.livePreviewDesign.type === 'motion' || this.livePreviewDesign.type === 'playlist';
      } else {
        const activeSchedule = this.getActiveSchedule();
        if (activeSchedule) {
          // Restart motion/playlist from frame 0 whenever the active schedule changes
          this.artnetSource.setIdentity(
            `schedule:${activeSchedule.id}:${activeSchedule.design_type}:${activeSchedule.design_id ?? ''}:${activeSchedule.playlist_id ?? ''}`
          );
          artnetFrame = this.renderSchedule(activeSchedule);
          isAnimated = activeSchedule.design_type === 'motion' || activeSchedule.design_type === 'playlist';
        } else {
          this.artnetSource.setIdentity('none');
          artnetFrame = BLANK;
        }
      }
      this.artnetSource.frame++;

      // Determine what to broadcast to WebSocket (preview design takes priority)
      wsIsPreview = !!this.previewDesign || (this.isLivePreview && !!this.livePreviewDesign);
      if (this.previewDesign) {
        // If live preview, reuse the already-rendered frame; otherwise render separately
        if (this.isLivePreview && this.livePreviewDesign === this.previewDesign) {
          wsFrame = artnetFrame;
        } else {
          wsFrame = this.renderDesign(this.previewDesign.type, this.previewDesign.data, this.wsSource);
          this.wsSource.frame++;
        }
      } else {
        wsFrame = artnetFrame;
      }

      if (artnet) {
        this.output(artnet, artnetFrame, isAnimated);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logRateLimited(`Scheduler tick failed, outputting blank frame: ${msg}`, err instanceof Error ? err.stack : undefined);
      wsFrame = BLANK;
      wsIsPreview = false;
      if (artnet) {
        try {
          this.output(artnet, BLANK, false);
        } catch (err2) {
          logRateLimited(`Scheduler failed to output blank frame: ${err2 instanceof Error ? err2.message : String(err2)}`);
        }
      }
    }

    try {
      this.broadcastFrame(wsFrame, wsIsPreview);
    } catch (err) {
      logRateLimited(`WebSocket broadcast failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.frameCounter++;
  }

  private output(artnet: ArtNetController, frame: Map<number, RGBW>, isAnimated: boolean): void {
    const flashing = Date.now() < this.flashUntil;
    if (flashing) {
      artnet.fillAll(255);
      this.wasFlashing = true;
      return;
    }
    if (this.wasFlashing) {
      // Channels not mapped to any light must not stay stuck at 255
      artnet.blackout();
      this.wasFlashing = false;
    }

    this.applyFrame(artnet, frame);

    // Motion/playlist content: always send every frame
    if (isAnimated) {
      artnet.markDirty();
    }
  }

  private getActiveSchedule(): ScheduleRow | null {
    const now = Date.now();
    if (this.cachedSchedule && now - this.cachedSchedule.at < SCHEDULE_TTL_MS) {
      return this.cachedSchedule.schedule;
    }
    const schedule = findActiveSchedule(new Date(now));
    this.cachedSchedule = { at: now, schedule };
    return schedule;
  }

  /** Parsed design data, cached by id + updated_at. Returns null for missing/corrupt designs. */
  private loadDesign(designId: string): { type: string; data: unknown } | null {
    const row = this.statements().design.get(designId) as DesignRow | undefined;
    if (!row) return null;

    const cached = this.designCache.get(row.id);
    if (cached && cached.updatedAt === row.updated_at) {
      return cached.data === null ? null : cached;
    }

    let data: unknown = null;
    try {
      data = JSON.parse(row.data);
    } catch (err) {
      logRateLimited(`Design ${row.id} has corrupt JSON data; rendering it as blank`);
    }
    const entry = { updatedAt: row.updated_at, type: row.type, data };
    this.designCache.set(row.id, entry);
    return data === null ? null : entry;
  }

  private loadPlaylist(playlistId: string): { playlist: PlaylistRow | undefined; items: TimelineItemRow[] } {
    const now = Date.now();
    const cached = this.playlistCache.get(playlistId);
    if (cached && now - cached.at < SCHEDULE_TTL_MS) return cached;

    const s = this.statements();
    const playlist = s.playlist.get(playlistId) as PlaylistRow | undefined;
    const items = playlist ? (s.items.all(playlistId) as TimelineItemRow[]) : [];
    const entry = { at: now, playlist, items };
    this.playlistCache.set(playlistId, entry);
    if (this.playlistCache.size > 50) this.playlistCache.delete(this.playlistCache.keys().next().value as string);
    return entry;
  }

  /** Timeline data from the database (through the caches); `inline` stands in for one playlist. */
  private timelineSource(inline?: { id: string; playlist: { play_mode: string; items: TimelineItemRow[] } }): TimelineSource {
    const engine = getEffectEngine();
    return {
      playlist: (id) => {
        if (inline && id === inline.id) return inline.playlist;
        const { playlist, items } = this.loadPlaylist(id);
        return playlist ? { play_mode: playlist.play_mode, items } : undefined;
      },
      designCycle: (designId) => {
        const design = this.loadDesign(designId);
        if (!design) return undefined;
        return design.type === 'motion' ? engine.cycleFrames(design.data) : null;
      },
    };
  }

  /** Playlist with nested playlists expanded, rebuilt at most every SCHEDULE_TTL_MS (or on invalidate). */
  private loadTimeline(playlistId: string): PlaylistTimeline | null {
    const now = Date.now();
    const cached = this.timelineCache.get(playlistId);
    if (cached && now - cached.at < SCHEDULE_TTL_MS) return cached.timeline;

    const timeline = buildPlaylistTimeline(playlistId, this.timelineSource());
    this.timelineCache.set(playlistId, { at: now, timeline });
    if (this.timelineCache.size > 50) this.timelineCache.delete(this.timelineCache.keys().next().value as string);
    return timeline;
  }

  private renderSchedule(schedule: ScheduleRow): Map<number, RGBW> {
    if (schedule.design_type === 'playlist' && schedule.playlist_id) {
      return this.renderPlaylist(schedule.playlist_id, this.artnetSource);
    } else if (schedule.design_id) {
      const design = this.loadDesign(schedule.design_id);
      if (design) {
        return this.renderDesign(design.type, design.data, this.artnetSource);
      }
    }

    return BLANK;
  }

  /** Timeline of an unsaved playlist preview, rebuilt like saved ones (designs it plays may change). */
  private loadInlineTimeline(data: PlaylistPreviewData & { items: TimelineItemRow[] }): PlaylistTimeline | null {
    const now = Date.now();
    const cached = this.inlineTimelineCache.get(data);
    if (cached && now - cached.at < SCHEDULE_TTL_MS) return cached.timeline;

    const id = data.playlistId ?? UNSAVED_PLAYLIST_ID;
    const src = this.timelineSource({ id, playlist: { play_mode: data.playMode ?? 'sequence', items: data.items } });
    const timeline = buildPlaylistTimeline(id, src);
    this.inlineTimelineCache.set(data, { at: now, timeline });
    return timeline;
  }

  private renderPlaylist(playlistId: string, source: RenderSource, startAt?: number, inline?: PlaylistPreviewData & { items: TimelineItemRow[] }): Map<number, RGBW> {
    const timeline = inline ? this.loadInlineTimeline(inline) : this.loadTimeline(playlistId);
    if (!timeline) return BLANK;

    const current = source.playlist.step(playlistId, timeline, startAt);
    if (!current) return BLANK;

    const design = this.loadDesign(current.designId);
    if (!design || design.type === 'playlist') return BLANK;

    const frame = this.renderDesignAt(design.type, design.data, current.frame);
    const blend = current.blend;
    if (!blend) return frame;
    const nextDesign = this.loadDesign(blend.designId);
    const next = nextDesign && nextDesign.type !== 'playlist' ? this.renderDesignAt(nextDesign.type, nextDesign.data, blend.frame) : BLANK;
    const out = new Map<number, RGBW>();
    const ids = new Set([...frame.keys(), ...next.keys()]);
    for (const id of ids) {
      const a = frame.get(id) ?? { r: 0, g: 0, b: 0, w: 0 };
      const b = next.get(id) ?? { r: 0, g: 0, b: 0, w: 0 };
      // Crossfade, or fade out to black over the first half and the next design in over the second
      const [ka, kb] = blend.mode === 'fade'
        ? [1 - blend.t, blend.t]
        : blend.t < 0.5 ? [1 - blend.t * 2, 0] : [0, blend.t * 2 - 1];
      out.set(id, {
        r: Math.round(a.r * ka + b.r * kb),
        g: Math.round(a.g * ka + b.g * kb),
        b: Math.round(a.b * ka + b.b * kb),
        w: Math.round(a.w * ka + b.w * kb),
      });
    }
    return out;
  }

  private renderDesign(type: string, data: unknown, source: RenderSource): Map<number, RGBW> {
    if (type === 'playlist') {
      const preview = (data ?? {}) as PlaylistPreviewData;
      const startAt = typeof preview.startAt === 'number' ? preview.startAt : undefined;
      if (Array.isArray(preview.items)) {
        return this.renderPlaylist(preview.playlistId ?? UNSAVED_PLAYLIST_ID, source, startAt, preview as PlaylistPreviewData & { items: TimelineItemRow[] });
      }
      return typeof preview.playlistId === 'string' ? this.renderPlaylist(preview.playlistId, source, startAt) : BLANK;
    }
    return this.renderDesignAt(type, data, source.frame);
  }

  private renderDesignAt(type: string, data: unknown, frame: number): Map<number, RGBW> {
    const engine = getEffectEngine();
    if (!data || typeof data !== 'object') return BLANK;

    if (type === 'static') {
      const staticData = data as { colors?: unknown };
      // Convert array to record if needed
      const colors: Record<number, RGBW> = {};
      if (Array.isArray(staticData.colors)) {
        staticData.colors.forEach((color, idx) => {
          colors[idx + 1] = color as RGBW;
        });
      } else if (staticData.colors && typeof staticData.colors === 'object') {
        Object.assign(colors, staticData.colors);
      }
      return engine.generateStaticFrame({ colors });
    } else if (type === 'motion') {
      const motionData = data as MotionEffect;
      // Same normalized/clamped speed the engine renders with, so frame scaling and the engine's
      // seconds-based timing agree (e.g. a stored speed below the 0.01 minimum)
      const speed = normalizeMotionEffect(motionData).speed;
      // Kept fractional so sub-pixel blending can move between steps; the engine floors it otherwise
      const scaledFrame = frame * speed;
      return engine.generateMotionFrame(motionData, scaledFrame, frame);
    }

    return BLANK;
  }

  private applyFrame(artnet: ArtNetController, frameData: Map<number, RGBW>): void {
    const engine = getEffectEngine();
    const lights = engine.getLights();

    // Layout reloaded (new array): clear channels a remapped/deleted light used to own
    if (lights !== this.lastLights) {
      artnet.blackout();
      this.lastLights = lights;
    }

    for (const light of lights) {
      const rawColor = frameData.get(light.light_id) || { r: 0, g: 0, b: 0, w: 0 };
      const color = maskDefectiveChannels(light, rawColor);
      if (light.light_type === 'RGBW') {
        artnet.setRGBW(light.dmx_start_channel, color.r, color.g, color.b, color.w);
      } else {
        // Fold W back into RGB for RGB-only lights
        const r = Math.min(255, color.r + color.w);
        const g = Math.min(255, color.g + color.w);
        const b = Math.min(255, color.b + color.w);
        artnet.setRGB(light.dmx_start_channel, r, g, b);
      }
    }
  }

  private broadcastFrame(frameData: Map<number, RGBW>, isPreview: boolean): void {
    if (this.wsClients.size === 0) return;

    // Only send every 3rd frame to reduce bandwidth
    if (this.frameCounter % 3 !== 0) return;

    const engine = getEffectEngine();
    const lights = engine.getLights();

    // Send raw (unmasked) frame data for ALL lights — default to black for any not set by the effect
    const black: RGBW = { r: 0, g: 0, b: 0, w: 0 };
    const frameObj: Record<number, RGBW> = {};
    for (const light of lights) {
      frameObj[light.light_id] = frameData.get(light.light_id) || black;
    }

    const artnet = getArtNetController();
    const message = JSON.stringify({
      type: 'frame',
      data: frameObj,
      preview: isPreview,
      dmxRate: artnet ? artnet.getSendRate() : 0,
    });

    for (const client of this.wsClients) {
      try {
        if (client.readyState !== 1) continue; // WebSocket.OPEN
        // Backpressure: a slow client just misses frames instead of growing an unbounded buffer
        if (client.bufferedAmount > WS_MAX_BUFFERED_BYTES) continue;
        client.send(message);
      } catch {
        // Client disconnected
        this.wsClients.delete(client);
      }
    }
  }
}

// Singleton
let scheduler: Scheduler | null = null;

export function getScheduler(): Scheduler {
  if (!scheduler) {
    scheduler = new Scheduler();
  }
  return scheduler;
}

/** Convenience for routes: drop scheduler caches after a data change. */
export function invalidateSchedule(): void {
  scheduler?.invalidate();
}
