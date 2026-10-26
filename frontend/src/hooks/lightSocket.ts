import type { RGBW } from '../types';

export type FrameData = Record<number, RGBW>;

export interface ConnectionStatus {
  connected: boolean;
  dmxRate: number;
}

type Listener = () => void;

// Shared, frozen empty frame so "no data" snapshots are referentially stable
export const EMPTY_FRAME: FrameData = Object.freeze({}) as FrameData;

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

/**
 * One WebSocket per app. Frame data (~10 updates/s) lives here, outside React
 * state, so only components that subscribe via useSyncExternalStore re-render.
 */
export class LightSocketStore {
  private frame: FrameData = EMPTY_FRAME;
  // The latest frame if it is a preview, else empty (the server is showing the scheduled output)
  private previewFrame: FrameData = EMPTY_FRAME;
  private status: ConnectionStatus = { connected: false, dmxRate: 0 };
  private frameListeners = new Set<Listener>();
  private statusListeners = new Set<Listener>();

  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private backoff = INITIAL_BACKOFF_MS;
  private stopped = true;

  // --- subscriptions (stable function identities for useSyncExternalStore) ---
  subscribeFrame = (listener: Listener) => {
    this.frameListeners.add(listener);
    return () => { this.frameListeners.delete(listener); };
  };
  getFrame = () => this.frame;
  getPreviewFrame = () => this.previewFrame;

  subscribeStatus = (listener: Listener) => {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  };
  getStatus = () => this.status;

  private setFrame(frame: FrameData, isPreview = false) {
    this.frame = frame;
    this.previewFrame = isPreview ? frame : EMPTY_FRAME;
    this.frameListeners.forEach((l) => l());
  }

  private setStatus(next: ConnectionStatus) {
    if (next.connected === this.status.connected && next.dmxRate === this.status.dmxRate) return;
    this.status = next;
    this.statusListeners.forEach((l) => l());
  }

  /** Send a message to the server if the socket is open; false when it isn't (caller can fall back). */
  send = (data: string): boolean => {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(data);
    return true;
  };

  // --- connection lifecycle ---
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      // Detach handlers first so close() can't schedule a reconnect
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    }
    this.handleDisconnected();
  }

  private handleDisconnected() {
    this.setStatus({ connected: false, dmxRate: 0 });
    // Show a disconnected state rather than a frozen last frame
    if (this.frame !== EMPTY_FRAME) this.setFrame(EMPTY_FRAME);
  }

  private connect() {
    if (this.stopped) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.backoff = INITIAL_BACKOFF_MS;
      this.setStatus({ connected: true, dmxRate: this.status.dmxRate });
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      try {
        const message = JSON.parse(event.data) as { type: string; data: unknown; preview?: boolean; dmxRate?: number };
        if (message.type === 'frame') {
          this.setFrame((message.data as FrameData) || EMPTY_FRAME, message.preview === true);
          if (typeof message.dmxRate === 'number') {
            this.setStatus({ connected: true, dmxRate: message.dmxRate });
          }
        }
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };

    ws.onerror = () => {
      // onclose follows and handles reconnecting
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handleDisconnected();
      if (this.stopped) return;
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    };
  }
}
