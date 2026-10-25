// Live audio levels for the Audio Level effect. Senders (an ESP32 with a microphone, a laptop
// script, ...) send one small JSON reading per datagram to a UDP port, or POST the same JSON to
// /api/audio/level:
//
//   {"id":"mic-1","level":42.5,"peak":71,"seq":1234}
//
// level (0-100) is required; peak (0-100), id (default "default") and seq (to drop late packets)
// are optional. This module keeps the latest raw reading per source; smoothing (attack/release),
// peak hold and auto-gain are applied per effect in meterLevel(), so two designs with different
// settings can follow the same microphone.

import dgram from 'dgram';
import { logRateLimited } from '../utils/rateLimitedLog.js';

export const DEFAULT_AUDIO_UDP_PORT = 7000;
export const DEFAULT_SOURCE_ID = 'default';
export const MAX_PACKET_BYTES = 512;
const MAX_SOURCES = 32;
const MAX_ID_LENGTH = 64;
const MAX_HTTP_READINGS = 64;

// No packet for this long: the level fades to 0 over FADE_MS
export const STALE_MS = 1000;
export const FADE_MS = 500;
// Sources not heard from for this long are dropped from the list
export const FORGET_MS = 10 * 60 * 1000;
// A seq this far below the last one means the sender restarted (or its counter wrapped); real
// reordering on a LAN is a packet or two. So does a run of this many "late" packets in a row
const SEQ_RESTART_GAP = 50;
const SEQ_RESTART_RUN = 5;
// After this long without a packet any seq is accepted (sender rebooted and counts from 0)
const SEQ_RESET_MS = 5000;
// Auto-gain tracks a slow max with this time constant, and never boosts more than 100 / floor
const AUTO_GAIN_TAU_S = 10;
export const AUTO_GAIN_FLOOR = 25;
// Peak hold marker falls at this many level units per second once its hold time is over
const PEAK_FALL_PER_S = 60;
// Per-effect meter state not touched for this long is forgotten
const METER_IDLE_MS = 60_000;

export interface AudioReading {
  id: string;
  level: number;
  peak: number | null;
  seq: number | null;
}

export interface AudioSourceInfo {
  id: string;
  level: number; // what the meter sees right now (with the stale fade applied)
  raw: number; // last level received
  peak: number | null; // last peak received
  lastSeen: string; // ISO time
  ageMs: number;
  packetsPerSecond: number;
  address: string | null;
  transport: 'udp' | 'http' | 'ws';
}

interface SourceState {
  id: string;
  raw: number;
  peak: number | null;
  seq: number | null;
  lateRun: number; // consecutive packets dropped as late
  lastSeen: number;
  address: string | null;
  transport: 'udp' | 'http' | 'ws';
  arrivals: number[]; // receive times in the last 2 s, for packets per second
  slowMax: number; // auto-gain reference: decaying max of raw levels
  slowMaxAt: number;
}

/** Options for one meter (one effect's settings). Times in seconds. */
export interface MeterOptions {
  attack: number;
  release: number;
  gain: number;
  autoGain: boolean;
  peakHold: boolean;
  peakHoldTime: number;
}

/** Smoothed level and peak marker, both 0..1. */
export interface MeterValue {
  level: number;
  peak: number;
}

export interface MeterState {
  value: number; // smoothed level, 0..100 (after gain)
  peak: number; // peak marker, 0..100
  holdLeft: number; // seconds the peak marker stays before falling
}

export const newMeterState = (): MeterState => ({ value: 0, peak: 0, holdLeft: 0 });

/**
 * Advance a meter by dt seconds toward `input` (0..100, gain already applied): exponential attack
 * when rising and release when falling, and a peak marker that holds, then falls. Mutates `state`.
 */
export function stepMeter(state: MeterState, input: number, dt: number, opts: MeterOptions): void {
  const target = Math.max(0, Math.min(100, Number.isFinite(input) ? input : 0));
  const step = Math.max(0, Math.min(10, Number.isFinite(dt) ? dt : 0));
  const tau = target > state.value ? opts.attack : opts.release;
  // A time constant of 0 jumps straight to the target
  const k = tau <= 0 ? 1 : 1 - Math.exp(-step / tau);
  state.value += (target - state.value) * k;
  if (!opts.peakHold) {
    state.peak = 0;
    state.holdLeft = 0;
    return;
  }
  if (state.value >= state.peak) {
    state.peak = state.value;
    state.holdLeft = opts.peakHoldTime;
  } else if (state.holdLeft > 0) {
    state.holdLeft = Math.max(0, state.holdLeft - step);
  } else {
    state.peak = Math.max(state.value, state.peak - PEAK_FALL_PER_S * step);
  }
}

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const clamp100 = (v: number) => Math.max(0, Math.min(100, v));

/** Validate one reading object; returns null when it isn't a usable reading. */
export function parseReading(obj: unknown): AudioReading | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const level = finiteNumber(o.level);
  if (level === null) return null;
  let id = DEFAULT_SOURCE_ID;
  if (o.id !== undefined && o.id !== null) {
    if (typeof o.id !== 'string') return null;
    const trimmed = o.id.trim();
    if (trimmed.length > MAX_ID_LENGTH) return null;
    if (trimmed) id = trimmed;
  }
  const peakRaw = o.peak === undefined || o.peak === null ? null : finiteNumber(o.peak);
  if (o.peak !== undefined && o.peak !== null && peakRaw === null) return null;
  const seqRaw = o.seq === undefined || o.seq === null ? null : finiteNumber(o.seq);
  if (o.seq !== undefined && o.seq !== null && (seqRaw === null || seqRaw < 0 || !Number.isInteger(seqRaw))) return null;
  return { id, level: clamp100(level), peak: peakRaw === null ? null : clamp100(peakRaw), seq: seqRaw };
}

/** Parse a datagram (one JSON object). Returns null for anything malformed or oversized. */
export function parsePacket(buf: Buffer | string): AudioReading | null {
  const size = typeof buf === 'string' ? Buffer.byteLength(buf) : buf.length;
  if (size === 0 || size > MAX_PACKET_BYTES) return null;
  try {
    return parseReading(JSON.parse(typeof buf === 'string' ? buf : buf.toString('utf8')));
  } catch {
    return null;
  }
}

export class AudioInput {
  private sources = new Map<string, SourceState>();
  private meters = new Map<string, { state: MeterState; lastT: number }>();
  private socket: dgram.Socket | null = null;
  private port: number | null = null;
  private listening = false;
  private error: string | null = null;

  constructor(private now: () => number = Date.now) {}

  /**
   * Store a reading. Returns false when it was dropped: an older or repeated seq from the same
   * source, or a new source while the list is full.
   */
  ingest(reading: AudioReading, rawAddress: string | null, transport: 'udp' | 'http' | 'ws'): boolean {
    const t = this.now();
    // IPv4 senders on a dual-stack socket show up as ::ffff:a.b.c.d
    const address = rawAddress ? rawAddress.replace(/^::ffff:/, '') : null;
    this.prune(t);
    let s = this.sources.get(reading.id);
    if (s && reading.seq !== null && s.seq !== null && t - s.lastSeen < SEQ_RESET_MS) {
      // Late or duplicate packet; a big jump back is a restart (or a wrapped counter), so take it
      if (reading.seq <= s.seq && s.seq - reading.seq < SEQ_RESTART_GAP && s.lateRun + 1 < SEQ_RESTART_RUN) {
        s.lateRun++;
        return false;
      }
    }
    if (!s) {
      if (this.sources.size >= MAX_SOURCES) return false;
      s = {
        id: reading.id, raw: 0, peak: null, seq: null, lateRun: 0, lastSeen: t, address, transport,
        arrivals: [], slowMax: 0, slowMaxAt: t,
      };
      this.sources.set(reading.id, s);
    }
    s.slowMax = Math.max(reading.level, this.decayedSlowMax(s, t));
    s.slowMaxAt = t;
    s.raw = reading.level;
    s.peak = reading.peak;
    s.seq = reading.seq;
    s.lateRun = 0;
    s.lastSeen = t;
    s.address = address;
    s.transport = transport;
    s.arrivals.push(t);
    while (s.arrivals.length > 0 && t - s.arrivals[0] > 2000) s.arrivals.shift();
    if (s.arrivals.length > 400) s.arrivals.splice(0, s.arrivals.length - 400);
    return true;
  }

  /** Parse and store a datagram; false when it was malformed or dropped. */
  handlePacket(buf: Buffer | string, address: string | null): boolean {
    const reading = parsePacket(buf);
    if (!reading) {
      logRateLimited(`Audio input: ignored malformed packet${address ? ` from ${address}` : ''}`);
      return false;
    }
    return this.ingest(reading, address, 'udp');
  }

  /** Store a reading sent over the app's WebSocket (the browser microphone). */
  handleWebSocket(message: unknown, address: string | null): boolean {
    const reading = parseReading(message);
    if (!reading) {
      logRateLimited('Audio input: ignored malformed WebSocket reading');
      return false;
    }
    return this.ingest(reading, address, 'ws');
  }

  /** Store readings from the HTTP endpoint (one object or an array). */
  handleHttp(body: unknown, address: string | null): { accepted: number; rejected: number } | { error: string } {
    const list = Array.isArray(body) ? body : [body];
    if (list.length === 0) return { error: 'Send a reading like {"id":"mic-1","level":42.5} (or an array of them)' };
    if (list.length > MAX_HTTP_READINGS) return { error: `At most ${MAX_HTTP_READINGS} readings per request` };
    let accepted = 0;
    let malformed = 0;
    for (const item of list) {
      const reading = parseReading(item);
      if (!reading) malformed++;
      else if (this.ingest(reading, address, 'http')) accepted++;
    }
    const rejected = list.length - accepted;
    if (malformed === list.length) {
      return { error: '"level" must be a number from 0 to 100; optional "id" (string), "peak" (0-100), "seq" (whole number)' };
    }
    return { accepted, rejected };
  }

  private decayedSlowMax(s: SourceState, t: number): number {
    return s.slowMax * Math.exp(-Math.max(0, t - s.slowMaxAt) / 1000 / AUTO_GAIN_TAU_S);
  }

  /** Source by id; a blank id picks the most recently heard source. */
  private find(id: string): SourceState | undefined {
    if (id) return this.sources.get(id);
    let latest: SourceState | undefined;
    for (const s of this.sources.values()) if (!latest || s.lastSeen > latest.lastSeen) latest = s;
    return latest;
  }

  /** Raw level of a source right now (0..100), faded out when it has gone quiet; 0 if unknown. */
  level(id: string): number {
    const s = this.find(id);
    if (!s) return 0;
    return this.fadedLevel(s, this.now());
  }

  private fadedLevel(s: SourceState, t: number): number {
    const age = t - s.lastSeen;
    if (age <= STALE_MS) return s.raw;
    return s.raw * Math.max(0, 1 - (age - STALE_MS) / FADE_MS);
  }

  /** Auto-gain factor for a source: scales its slow max to 100, at most 100 / AUTO_GAIN_FLOOR. */
  autoGainFactor(id: string): number {
    const s = this.find(id);
    if (!s) return 1;
    return 100 / Math.max(AUTO_GAIN_FLOOR, this.decayedSlowMax(s, this.now()));
  }

  /**
   * The level an effect shows for a source, smoothed with its attack/release and peak hold. State
   * is kept per source and settings, advanced by wall-clock time, so rendering the same design
   * twice in a tick (ArtNet and the browser preview) doesn't speed it up.
   */
  meterLevel(id: string, opts: MeterOptions): MeterValue {
    const t = this.now();
    const s = this.find(id);
    const key = `${id}|${opts.attack}|${opts.release}|${opts.gain}|${opts.autoGain}|${opts.peakHold}|${opts.peakHoldTime}`;
    let m = this.meters.get(key);
    if (!m) {
      m = { state: newMeterState(), lastT: t };
      this.meters.set(key, m);
      if (this.meters.size > 200) this.pruneMeters(t);
    }
    const raw = s ? this.fadedLevel(s, t) : 0;
    const gain = opts.gain * (opts.autoGain && s ? 100 / Math.max(AUTO_GAIN_FLOOR, this.decayedSlowMax(s, t)) : 1);
    stepMeter(m.state, raw * gain, (t - m.lastT) / 1000, opts);
    m.lastT = t;
    return { level: m.state.value / 100, peak: m.state.peak / 100 };
  }

  private pruneMeters(t: number): void {
    for (const [key, m] of this.meters) if (t - m.lastT > METER_IDLE_MS) this.meters.delete(key);
  }

  private prune(t: number): void {
    for (const [id, s] of this.sources) if (t - s.lastSeen > FORGET_MS) this.sources.delete(id);
  }

  /** Known sources, most recently heard first. */
  list(): AudioSourceInfo[] {
    const t = this.now();
    this.prune(t);
    return [...this.sources.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map(s => {
        const recent = s.arrivals.filter(a => t - a <= 2000).length;
        return {
          id: s.id,
          level: Math.round(this.fadedLevel(s, t) * 10) / 10,
          raw: s.raw,
          peak: s.peak,
          lastSeen: new Date(s.lastSeen).toISOString(),
          ageMs: t - s.lastSeen,
          packetsPerSecond: Math.round((recent / 2) * 10) / 10,
          address: s.address,
          transport: s.transport,
        };
      });
  }

  status(): { udpPort: number | null; listening: boolean; error: string | null; maxPacketBytes: number } {
    return { udpPort: this.port, listening: this.listening, error: this.error, maxPacketBytes: MAX_PACKET_BYTES };
  }

  /** Listen for readings on a UDP port (0 disables). Bind errors are logged, never thrown. */
  start(port: number): void {
    this.stop();
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      this.port = null;
      return;
    }
    this.port = port;
    this.error = null;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('message', (msg, rinfo) => {
      try {
        this.handlePacket(msg, rinfo.address);
      } catch (err) {
        logRateLimited('Audio input: failed to handle packet', err);
      }
    });
    socket.on('error', (err) => {
      this.error = err.message;
      this.listening = false;
      console.error(`Audio input UDP error on port ${port}:`, err.message);
      try { socket.close(); } catch { /* already closed */ }
      if (this.socket === socket) this.socket = null;
    });
    socket.on('listening', () => {
      this.listening = true;
      console.log(`Audio input listening on UDP port ${port}`);
    });
    socket.bind(port);
  }

  stop(): void {
    if (this.socket) {
      try { this.socket.close(); } catch { /* already closed */ }
      this.socket = null;
    }
    this.listening = false;
  }
}

let instance: AudioInput | null = null;

export function getAudioInput(): AudioInput {
  if (!instance) instance = new AudioInput();
  return instance;
}

/** UDP port from AUDIO_UDP_PORT (default 7000; 0 or "off" disables the listener). */
export function audioUdpPortFromEnv(): number {
  const v = (process.env.AUDIO_UDP_PORT ?? '').trim().toLowerCase();
  if (v === '') return DEFAULT_AUDIO_UDP_PORT;
  if (v === 'off' || v === 'false') return 0;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : DEFAULT_AUDIO_UDP_PORT;
}
