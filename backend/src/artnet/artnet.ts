import dgram from 'dgram';

const ARTNET_PORT = 6454;
const ARTNET_HEADER = Buffer.from([
  0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00, // "Art-Net\0"
  0x00, 0x50, // OpCode: ArtDMX (0x5000) little-endian
  0x00, 0x0e, // Protocol version 14
]);

export const CHANNELS_PER_UNIVERSE = 512;
// Art-Net port-addresses are 15 bits (0..32767)
export const MAX_UNIVERSE = 32767;
// Upper bound on how many consecutive universes one controller will drive.
export const MAX_UNIVERSES = 16;
export const MAX_ABSOLUTE_CHANNEL = CHANNELS_PER_UNIVERSE * MAX_UNIVERSES;
export const MIN_REFRESH_RATE = 1;
export const MAX_REFRESH_RATE = 44;

export interface ArtNetConfig {
  mode: 'multicast' | 'unicast';
  unicastAddress?: string;
  universe: number;
  refreshRate: number; // FPS (1-44)
}

interface UniverseBuffer {
  data: Buffer;
  lastSent: Buffer;
  sequence: number; // 1..255, 0 means "sequence disabled" in Art-Net so never sent
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clampFps(rate: number): number {
  const n = Number(rate);
  if (!Number.isFinite(n)) return 40;
  return Math.max(MIN_REFRESH_RATE, Math.min(MAX_REFRESH_RATE, Math.round(n)));
}

export class ArtNetController {
  private socket: dgram.Socket | null = null;
  private config: ArtNetConfig;
  // Keyed by universe offset (0 = config.universe, 1 = config.universe + 1, ...).
  // Absolute channel N lives in offset floor((N-1)/512).
  private universes: Map<number, UniverseBuffer> = new Map();
  private dirty: boolean = true;
  private framesSinceLastSend: number = 0;
  private sendCount: number = 0;
  private lastSendRate: number = 0;
  private rateIntervalId: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(config: ArtNetConfig) {
    this.config = { ...config, refreshRate: clampFps(config.refreshRate) };
    // Universe 0 offset always exists so status/test have something to show.
    this.getUniverse(0);
  }

  private getUniverse(offset: number): UniverseBuffer {
    let u = this.universes.get(offset);
    if (!u) {
      u = {
        data: Buffer.alloc(CHANNELS_PER_UNIVERSE, 0),
        lastSent: Buffer.alloc(CHANNELS_PER_UNIVERSE, 0),
        sequence: 0,
      };
      this.universes.set(offset, u);
      this.dirty = true;
    }
    return u;
  }

  start(): void {
    if (this.isRunning) return;

    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('error', (err) => {
      console.error('ArtNet socket error:', err);
    });

    this.socket.bind(() => {
      this.applyBroadcastFlag();
      this.isRunning = true;
      console.log('ArtNet controller started');

      // Send DMX at configured refresh rate
      this.startInterval();

      // Track send rate every second
      this.rateIntervalId = setInterval(() => {
        this.lastSendRate = this.sendCount;
        this.sendCount = 0;
      }, 1000);
    });
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.rateIntervalId) {
      clearInterval(this.rateIntervalId);
      this.rateIntervalId = null;
    }

    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // already closed
      }
      this.socket = null;
    }

    if (this.isRunning) console.log('ArtNet controller stopped');
    this.isRunning = false;
  }

  private applyBroadcastFlag(): void {
    if (!this.socket) return;
    try {
      this.socket.setBroadcast(this.config.mode === 'multicast');
    } catch (err) {
      // setBroadcast throws if the socket is not bound yet; start() re-applies after bind
      if (this.isRunning) console.error('ArtNet setBroadcast failed:', err);
    }
  }

  updateConfig(config: ArtNetConfig): void {
    const next = { ...config, refreshRate: clampFps(config.refreshRate) };
    const refreshRateChanged = this.config.refreshRate !== next.refreshRate;
    this.config = next;

    // Switching to multicast needs SO_BROADCAST, switching back clears it
    if (this.isRunning) this.applyBroadcastFlag();

    // Restart interval if refresh rate changed
    if (refreshRateChanged && this.isRunning) {
      this.startInterval();
    }
    // Re-send everything promptly with the new destination/universe
    this.dirty = true;
  }

  getConfig(): ArtNetConfig {
    return { ...this.config };
  }

  private startInterval(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    const fps = clampFps(this.config.refreshRate);
    const intervalMs = Math.round(1000 / fps);

    console.log(`ArtNet refresh rate: ${fps} FPS (${intervalMs}ms interval)`);
    this.intervalId = setInterval(() => this.sendDMX(), intervalMs);
  }

  /**
   * Set an absolute DMX channel (1-based). Channels above 512 spill into the
   * following universes: channel N -> universe config.universe + floor((N-1)/512).
   */
  setChannel(channel: number, value: number): void {
    if (!Number.isInteger(channel) || channel < 1 || channel > MAX_ABSOLUTE_CHANNEL) return;
    const offset = Math.floor((channel - 1) / CHANNELS_PER_UNIVERSE);
    if (this.config.universe + offset > MAX_UNIVERSE) return;
    const u = this.getUniverse(offset);
    u.data[(channel - 1) % CHANNELS_PER_UNIVERSE] = clampByte(value);
  }

  // Call after writing a frame that should always be sent (motion effects)
  markDirty(): void {
    this.dirty = true;
  }

  setRGBW(startChannel: number, r: number, g: number, b: number, w: number): void {
    this.setChannel(startChannel, r);
    this.setChannel(startChannel + 1, g);
    this.setChannel(startChannel + 2, b);
    this.setChannel(startChannel + 3, w);
  }

  setRGB(startChannel: number, r: number, g: number, b: number): void {
    this.setChannel(startChannel, r);
    this.setChannel(startChannel + 1, g);
    this.setChannel(startChannel + 2, b);
  }

  /** Overwrite channels starting at absolute channel 1. */
  setAllChannels(data: number[]): void {
    const n = Math.min(data.length, MAX_ABSOLUTE_CHANNEL);
    for (let i = 0; i < n; i++) {
      this.setChannel(i + 1, data[i]);
    }
    this.dirty = true;
  }

  /** Fill every channel of every universe currently in use. */
  fillAll(value: number): void {
    const v = clampByte(value);
    for (const u of this.universes.values()) u.data.fill(v);
    this.dirty = true;
  }

  blackout(): void {
    this.fillAll(0);
  }

  private hasChanges(): boolean {
    for (const u of this.universes.values()) {
      if (!u.data.equals(u.lastSent)) return true;
    }
    return false;
  }

  private sendDMX(): void {
    if (!this.socket || !this.isRunning) return;

    this.framesSinceLastSend++;

    // Keepalive ~once per second even if nothing changed
    const keepaliveFrames = clampFps(this.config.refreshRate);

    if (!this.dirty && !this.hasChanges() && this.framesSinceLastSend < keepaliveFrames) return;

    this.dirty = false;
    this.framesSinceLastSend = 0;
    this.sendCount++;

    const address = this.config.mode === 'multicast'
      ? '255.255.255.255'
      : this.config.unicastAddress || '127.0.0.1';

    const offsets = [...this.universes.keys()].sort((a, b) => a - b);
    for (const offset of offsets) {
      const u = this.universes.get(offset)!;
      const universe = this.config.universe + offset;
      if (universe > MAX_UNIVERSE) continue;

      u.data.copy(u.lastSent);
      // Sequence cycles 1..255; 0 would tell receivers sequencing is disabled
      u.sequence = (u.sequence % 255) + 1;

      const packet = Buffer.alloc(18 + CHANNELS_PER_UNIVERSE);
      ARTNET_HEADER.copy(packet, 0);
      packet[12] = u.sequence;
      packet[13] = 0; // Physical port
      packet[14] = universe & 0xff; // SubUni (little-endian port-address)
      packet[15] = (universe >> 8) & 0x7f; // Net
      packet[16] = (CHANNELS_PER_UNIVERSE >> 8) & 0xff; // Length hi
      packet[17] = CHANNELS_PER_UNIVERSE & 0xff; // Length lo
      u.data.copy(packet, 18);

      this.socket.send(packet, 0, packet.length, ARTNET_PORT, address, (err) => {
        if (err) {
          console.error('Error sending ArtNet packet:', err);
        }
      });
    }
  }

  /** DMX data of the base universe (backwards compatible with the old single-universe API). */
  getDMXData(): Buffer {
    return Buffer.from(this.getUniverse(0).data);
  }

  /** All universes in use, keyed by actual universe number. */
  getAllDMXData(): Record<number, number[]> {
    const out: Record<number, number[]> = {};
    for (const [offset, u] of this.universes) {
      out[this.config.universe + offset] = Array.from(u.data);
    }
    return out;
  }

  getSendRate(): number {
    return this.lastSendRate;
  }
}

// Singleton instance
let artnetInstance: ArtNetController | null = null;

export function getArtNetController(): ArtNetController | null {
  return artnetInstance;
}

export function initArtNet(config: ArtNetConfig): ArtNetController {
  if (artnetInstance) {
    artnetInstance.stop();
  }
  artnetInstance = new ArtNetController(config);
  artnetInstance.start();
  return artnetInstance;
}

export function stopArtNet(): void {
  if (artnetInstance) {
    artnetInstance.stop();
    artnetInstance = null;
  }
}
