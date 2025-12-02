import { getDatabase } from '../models/database.js';
import { getArtNetController, ArtNetController } from '../artnet/artnet.js';
import { getEffectEngine, MotionEffect, StaticDesign, RGBW } from '../services/effectEngine.js';

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
  priority: number;
}

export class Scheduler {
  private isRunning: boolean = false;
  private isLivePreview: boolean = false;
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

  setLivePreview(enabled: boolean, design?: { type: string; data: unknown }): void {
    this.isLivePreview = enabled;
    this.livePreviewDesign = enabled && design ? design : null;
    this.currentFrame = 0;
  }

  isInLivePreview(): boolean {
    return this.isLivePreview;
  }

  private tick(): void {
    const artnet = getArtNetController();
    if (!artnet) return;

    let frameData: Map<number, RGBW>;

    if (this.isLivePreview && this.livePreviewDesign) {
      // Live preview mode
      frameData = this.renderDesign(this.livePreviewDesign.type, this.livePreviewDesign.data);
    } else {
      // Normal scheduler mode
      const activeSchedule = this.getActiveSchedule();
      if (activeSchedule) {
        frameData = this.renderSchedule(activeSchedule);
      } else {
        // No active schedule, blackout
        frameData = new Map();
      }
    }

    // Apply frame to ArtNet
    this.applyFrame(artnet, frameData);

    // Broadcast to WebSocket clients for preview
    this.broadcastFrame(frameData);

    this.currentFrame++;
  }

  private getActiveSchedule(): Schedule | null {
    const db = getDatabase();
    const now = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // First check for date-specific schedules
    const dateSchedule = db.prepare(`
      SELECT * FROM schedules
      WHERE is_default = 0
        AND start_date <= ?
        AND end_date >= ?
      ORDER BY priority DESC
      LIMIT 1
    `).get(now, now) as Schedule | undefined;

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
      return engine.generateMotionFrame(motionData, this.currentFrame);
    }

    return new Map();
  }

  private applyFrame(artnet: ArtNetController, frameData: Map<number, RGBW>): void {
    const engine = getEffectEngine();
    const lights = engine.getLights();

    for (const light of lights) {
      const color = frameData.get(light.light_id) || { r: 0, g: 0, b: 0, w: 0 };
      if (light.light_type === 'RGBW') {
        artnet.setRGBW(light.dmx_start_channel, color.r, color.g, color.b, color.w);
      } else {
        artnet.setRGB(light.dmx_start_channel, color.r, color.g, color.b);
      }
    }
  }

  private broadcastFrame(frameData: Map<number, RGBW>): void {
    if (this.wsClients.size === 0) return;

    // Only send every 3rd frame to reduce bandwidth
    if (this.currentFrame % 3 !== 0) return;

    const frameObj: Record<number, RGBW> = {};
    frameData.forEach((color, lightId) => {
      frameObj[lightId] = color;
    });

    const message = JSON.stringify({
      type: 'frame',
      data: frameObj,
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
