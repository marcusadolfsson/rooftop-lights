// This computer's microphone as an audio input for the Audio Level effect. Measures the level with
// Web Audio (RMS, -60..0 dBFS mapped to 0..100, the same scale as the ESP32 example) and sends
// {id, level, peak, seq} about 30 times a second over the app's WebSocket, falling back to
// POST /api/audio/level while the socket is down. One stream per tab, shared by every control.

export type MicStatus = 'idle' | 'starting' | 'streaming' | 'error';

export interface MicState {
  status: MicStatus;
  error: string | null;
  level: number; // 0..100
  peak: number; // 0..100
  sourceId: string;
}

type Sender = (data: string) => boolean;

const SEND_INTERVAL_MS = 33;
// Peak marker falls this many level units per second
const PEAK_FALL_PER_S = 60;
// Hidden this long (another tab, minimized): stop, so a forgotten tab doesn't keep the mic open
const HIDDEN_STOP_MS = 30_000;
const ID_KEY = 'rooftop.browserMicId';
const MAX_ID_LENGTH = 64;

/** "browser-chrome-mac", from the user agent. */
export function defaultMicId(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'edge' : /Firefox\//.test(ua) ? 'firefox' : /Chrome\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'web';
  const os = /iPhone|iPad/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : /Mac/.test(ua) ? 'mac' : /Win/.test(ua) ? 'windows' : /Linux/.test(ua) ? 'linux' : '';
  return ['browser', browser, os].filter(Boolean).join('-');
}

function loadId(): string {
  try {
    const saved = window.localStorage.getItem(ID_KEY);
    if (saved && saved.trim()) return saved.trim().slice(0, MAX_ID_LENGTH);
  } catch { /* storage blocked */ }
  return defaultMicId();
}

function saveId(id: string): void {
  try { window.localStorage.setItem(ID_KEY, id); } catch { /* storage blocked */ }
}

/** RMS of a block of samples (-1..1) on the 0..100 scale (-60 dBFS = 0, 0 dBFS = 100). */
export function rmsToLevel(samples: Float32Array): number {
  let acc = 0;
  for (let i = 0; i < samples.length; i++) acc += samples[i] * samples[i];
  const rms = Math.sqrt(acc / Math.max(1, samples.length));
  const db = 20 * Math.log10(rms + 1e-9);
  return Math.max(0, Math.min(100, ((db + 60) * 100) / 60));
}

function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone permission was denied. Allow it in the browser (the icon in the address bar) and try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone found on this computer.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is in use by another app or could not be opened.';
    default:
      return `Could not start the microphone${err instanceof Error && err.message ? `: ${err.message}` : ''}`;
  }
}

class BrowserMic {
  private state: MicState = { status: 'idle', error: null, level: 0, peak: 0, sourceId: loadId() };
  private listeners = new Set<() => void>();
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private timer = 0;
  private hiddenTimer = 0;
  private seq = 0;
  private lastTick = 0;
  private sender: Sender | null = null;
  private posting = false;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getState = () => this.state;

  private set(patch: Partial<MicState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  setSender(sender: Sender | null) {
    this.sender = sender;
  }

  /** Change the source id (applies to the next readings). */
  setSourceId(id: string) {
    const clean = id.slice(0, MAX_ID_LENGTH);
    saveId(clean.trim() || defaultMicId());
    this.set({ sourceId: clean });
  }

  /** The id readings go out under (a blank field falls back to the default). */
  effectiveId(): string {
    return this.state.sourceId.trim() || defaultMicId();
  }

  async start(): Promise<void> {
    if (this.state.status === 'streaming' || this.state.status === 'starting') return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.set({ status: 'error', error: 'The microphone needs a secure page: open this site over https:// (or on localhost).' });
      return;
    }
    this.set({ status: 'starting', error: null });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      // Stopped while the permission prompt was open
      if ((this.state.status as MicStatus) !== 'starting') {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const context = new AudioContext();
      if (context.state === 'suspended') await context.resume().catch(() => undefined);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      this.stream = stream;
      this.context = context;
      this.analyser = analyser;
      this.buffer = new Float32Array(analyser.fftSize);
      this.seq = 0;
      this.lastTick = performance.now();
      // The device going away (unplugged, permission revoked) ends the stream
      stream.getAudioTracks().forEach((track) => { track.onended = () => this.stop('The microphone was disconnected.'); });
      this.timer = window.setInterval(this.tick, SEND_INTERVAL_MS);
      document.addEventListener('visibilitychange', this.onVisibility);
      window.addEventListener('pagehide', this.onPageHide);
      this.set({ status: 'streaming', error: null, level: 0, peak: 0 });
    } catch (err) {
      this.cleanup();
      this.set({ status: 'error', error: micErrorMessage(err) });
    }
  }

  stop(error: string | null = null) {
    this.cleanup();
    this.set({ status: error ? 'error' : 'idle', error, level: 0, peak: 0 });
  }

  private cleanup() {
    window.clearInterval(this.timer);
    window.clearTimeout(this.hiddenTimer);
    this.timer = 0;
    this.hiddenTimer = 0;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    this.stream?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    this.context?.close().catch(() => undefined);
    this.stream = null;
    this.context = null;
    this.analyser = null;
    this.buffer = null;
  }

  private onVisibility = () => {
    window.clearTimeout(this.hiddenTimer);
    if (document.visibilityState === 'hidden') {
      this.hiddenTimer = window.setTimeout(() => this.stop('Stopped because the tab was hidden for a while.'), HIDDEN_STOP_MS);
    }
  };

  private onPageHide = () => this.stop();

  private tick = () => {
    const analyser = this.analyser;
    const buffer = this.buffer;
    if (!analyser || !buffer) return;
    const now = performance.now();
    const dt = Math.min(1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    analyser.getFloatTimeDomainData(buffer);
    const level = Math.round(rmsToLevel(buffer) * 10) / 10;
    const peak = Math.max(level, this.state.peak - PEAK_FALL_PER_S * dt);
    this.set({ level, peak });
    this.send({ id: this.effectiveId(), level, peak: Math.round(peak), seq: this.seq++ });
  };

  private send(reading: { id: string; level: number; peak: number; seq: number }) {
    if (this.sender?.(JSON.stringify({ type: 'audio', ...reading }))) return;
    // WebSocket down: HTTP, one request at a time (readings in between are skipped)
    if (this.posting) return;
    this.posting = true;
    fetch('/api/audio/level', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reading) })
      .catch(() => undefined)
      .finally(() => { this.posting = false; });
  }
}

export const browserMic = new BrowserMic();
