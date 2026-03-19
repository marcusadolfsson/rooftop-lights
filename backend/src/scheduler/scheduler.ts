import { getDatabase } from '../models/database.js';
import { getArtNetController, ArtNetController } from '../artnet/artnet.js';
import { getEffectEngine, MotionEffect, StaticDesign, RGBW, Light } from '../services/effectEngine.js';

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

interface Design {
  id: string;
  name: string;
  type: 'static' | 'motion';
  data: string;
}

interface Playlist {
  id: string;
  name: string;
  play_mode: 'sequence' | 'random';
}

interface PlaylistItem {
  id: string;
  playlist_id: string;
  design_id: string;
  duration: number;
  position: number;
}

interface Schedule {
  id: string;
  design_id: string | null;
  playlist_id: string | null;
  design_type: 'static' | 'motion' | 'playlist';
  is_default: number;
  start_date: string | null;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  priority: number;
}

export class Scheduler {
  private isRunning: boolean = false;
  private isLivePreview: boolean = false;
  private previewDesign: { type: string; data: unknown } | null = null;
  private livePreviewDesign: { type: string; data: unknown } | null = null;
  private currentFrame: number = 0;
  private frameInterval: NodeJS.Timeout | null = null;
  private currentPlaylistIndex: number = 0;
  private playlistStartTime: number = 0;
  private wsClients: Set<WebSocket> = new Set();

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Run at ~30 FPS for effects
    this.frameInterval = setInterval(() => this.tick(), 33);
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

  addWSClient(ws: WebSocket): void {
    this.wsClients.add(ws);
  }

  removeWSClient(ws: WebSocket): void {
    this.wsClients.delete(ws);
  }

  // Set a preview design for WebSocket broadcast only (no ArtNet)
  setPreviewDesign(design: { type: string; data: unknown } | null): void {
    this.previewDesign = design;
    this.currentFrame = 0;
  }

  // Enable/disable live ArtNet output of the preview design
  setLivePreview(enabled: boolean, design?: { type: string; data: unknown }): void {
    this.isLivePreview = enabled;
    if (design) {
      this.previewDesign = design;
      this.livePreviewDesign = design;
    }
    if (!enabled) {
      this.livePreviewDesign = null;
    }
    this.currentFrame = 0;
  }

  // Clear all preview state
  clearPreview(): void {
    this.isLivePreview = false;
    this.previewDesign = null;
    this.livePreviewDesign = null;
    this.currentFrame = 0;
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

  getLivePreviewInfo(): { type: string; effectType?: string } | null {
    if (!this.isLivePreview || !this.livePreviewDesign) return null;
    const info: { type: string; effectType?: string } = {
      type: this.livePreviewDesign.type,
    };
    if (this.livePreviewDesign.type === 'motion') {
      const data = this.livePreviewDesign.data as { type?: string };
      info.effectType = data.type;
    }
    return info;
  }

  private tick(): void {
    const artnet = getArtNetController();
    if (!artnet) return;

    let artnetFrame: Map<number, RGBW>;
    let wsFrame: Map<number, RGBW>;
    let isAnimated = false;

    // Determine what to show on ArtNet
    if (this.isLivePreview && this.livePreviewDesign) {
      artnetFrame = this.renderDesign(this.livePreviewDesign.type, this.livePreviewDesign.data);
      isAnimated = this.livePreviewDesign.type === 'motion';
    } else {
      const activeSchedule = this.getActiveSchedule();
      if (activeSchedule) {
        artnetFrame = this.renderSchedule(activeSchedule);
        isAnimated = activeSchedule.design_type === 'motion' || activeSchedule.design_type === 'playlist';
      } else {
        artnetFrame = new Map();
      }
    }

    // Determine what to broadcast to WebSocket (preview design takes priority)
    if (this.previewDesign) {
      // If live preview, reuse the already-rendered frame; otherwise render separately
      if (this.isLivePreview && this.livePreviewDesign === this.previewDesign) {
        wsFrame = artnetFrame;
      } else {
        wsFrame = this.renderDesign(this.previewDesign.type, this.previewDesign.data);
      }
    } else {
      wsFrame = artnetFrame;
    }

    this.applyFrame(artnet, artnetFrame);

    // Motion/playlist content: always send every frame
    if (isAnimated) {
      artnet.markDirty();
    }

    this.broadcastFrame(wsFrame);

    this.currentFrame++;
  }

  private getActiveSchedule(): Schedule | null {
    const db = getDatabase();
    const now = new Date();
    const localDate = now.toLocaleDateString('en-CA'); // YYYY-MM-DD
    const localTime = now.toTimeString().slice(0, 5); // HH:MM
    const localDateTime = `${localDate} ${localTime}`;

    // First check for date-specific schedules using full datetime comparison
    const dateSchedule = db.prepare(`
      SELECT * FROM schedules
      WHERE is_default = 0
        AND datetime(start_date || ' ' || COALESCE(start_time, '16:00')) <= datetime(?)
        AND datetime(end_date || ' ' || COALESCE(end_time, '16:00')) >= datetime(?)
      ORDER BY priority DESC
      LIMIT 1
    `).get(localDateTime, localDateTime) as Schedule | undefined;

    if (dateSchedule) {
      return dateSchedule;
    }

    // Fall back to default schedule
    const defaultSchedule = db.prepare(`
      SELECT * FROM schedules WHERE is_default = 1 LIMIT 1
    `).get() as Schedule | undefined;

    return defaultSchedule || null;
  }

  private renderSchedule(schedule: Schedule): Map<number, RGBW> {
    const db = getDatabase();

    if (schedule.design_type === 'playlist' && schedule.playlist_id) {
      return this.renderPlaylist(schedule.playlist_id);
    } else if (schedule.design_id) {
      const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(schedule.design_id) as Design | undefined;
      if (design) {
        return this.renderDesign(design.type, JSON.parse(design.data));
      }
    }

    return new Map();
  }

  private renderPlaylist(playlistId: string): Map<number, RGBW> {
    const db = getDatabase();

    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as Playlist | undefined;
    if (!playlist) return new Map();

    const items = db.prepare(
      'SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position'
    ).all(playlistId) as PlaylistItem[];

    if (items.length === 0) return new Map();

    // Calculate current item based on time
    const now = Date.now();
    if (this.playlistStartTime === 0) {
      this.playlistStartTime = now;
    }

    let totalDuration = 0;
    for (const item of items) {
      totalDuration += item.duration * 1000; // Convert to ms
    }

    const elapsed = (now - this.playlistStartTime) % totalDuration;
    let currentDuration = 0;
    let currentItem: PlaylistItem | null = null;

    if (playlist.play_mode === 'random') {
      // Random mode - use pseudo-random based on time
      const idx = Math.floor((now / 10000) % items.length);
      currentItem = items[idx];
    } else {
      // Sequence mode
      for (const item of items) {
        if (elapsed < currentDuration + item.duration * 1000) {
          currentItem = item;
          break;
        }
        currentDuration += item.duration * 1000;
      }
    }

    if (currentItem) {
      const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(currentItem.design_id) as Design | undefined;
      if (design) {
        return this.renderDesign(design.type, JSON.parse(design.data));
      }
    }

    return new Map();
  }

  private renderDesign(type: string, data: unknown): Map<number, RGBW> {
    const engine = getEffectEngine();

    if (type === 'static') {
      const staticData = data as { colors: RGBW[] | Record<number, RGBW> };
      // Convert array to record if needed
      const colors: Record<number, RGBW> = {};
      if (Array.isArray(staticData.colors)) {
        staticData.colors.forEach((color, idx) => {
          colors[idx + 1] = color;
        });
      } else {
        Object.assign(colors, staticData.colors);
      }
      return engine.generateStaticFrame({ colors });
    } else if (type === 'motion') {
      const motionData = data as MotionEffect;
      const scaledFrame = Math.floor(this.currentFrame * (motionData.speed || 1));
      return engine.generateMotionFrame(motionData, scaledFrame);
    }

    return new Map();
  }

  private applyFrame(artnet: ArtNetController, frameData: Map<number, RGBW>): void {
    const engine = getEffectEngine();
    const lights = engine.getLights();

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

  private broadcastFrame(frameData: Map<number, RGBW>): void {
    if (this.wsClients.size === 0) return;

    // Only send every 3rd frame to reduce bandwidth
    if (this.currentFrame % 3 !== 0) return;

    const engine = getEffectEngine();
    const lights = engine.getLights();
    const lightMap = new Map<number, Light>();
    for (const light of lights) {
      lightMap.set(light.light_id, light);
    }

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
      dmxRate: artnet ? artnet.getSendRate() : 0,
    });

    for (const client of this.wsClients) {
      try {
        if ((client as any).readyState === 1) { // WebSocket.OPEN
          client.send(message);
        }
      } catch (e) {
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
