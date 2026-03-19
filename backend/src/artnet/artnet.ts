import dgram from 'dgram';

const ARTNET_PORT = 6454;
const ARTNET_HEADER = Buffer.from([
  0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00, // "Art-Net\0"
  0x00, 0x50, // OpCode: ArtDMX (0x5000) little-endian
  0x00, 0x0e, // Protocol version 14
]);

export interface ArtNetConfig {
  mode: 'multicast' | 'unicast';
  unicastAddress?: string;
  universe: number;
  refreshRate: number; // FPS (1-44)
}

export class ArtNetController {
  private socket: dgram.Socket | null = null;
  private config: ArtNetConfig;
  private sequence: number = 0;
  private dmxData: Buffer;
  private lastSentData: Buffer;
  private dirty: boolean = true;
  private framesSinceLastSend: number = 0;
  private sendCount: number = 0;
  private lastSendRate: number = 0;
  private rateIntervalId: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(config: ArtNetConfig) {
    this.config = config;
    this.dmxData = Buffer.alloc(512, 0);
    this.lastSentData = Buffer.alloc(512, 0);
  }

  start(): void {
    if (this.isRunning) return;

    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('error', (err) => {
      console.error('ArtNet socket error:', err);
    });

    this.socket.bind(() => {
      if (this.config.mode === 'multicast') {
        this.socket?.setBroadcast(true);
      }
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
    if (!this.isRunning) return;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.rateIntervalId) {
      clearInterval(this.rateIntervalId);
      this.rateIntervalId = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.isRunning = false;
    console.log('ArtNet controller stopped');
  }

  updateConfig(config: ArtNetConfig): void {
    const refreshRateChanged = this.config.refreshRate !== config.refreshRate;
    this.config = config;

    // Restart interval if refresh rate changed
    if (refreshRateChanged && this.isRunning) {
      this.startInterval();
    }
  }

  private startInterval(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    // Clamp refresh rate between 1 and 44 FPS
    const fps = Math.max(1, Math.min(44, this.config.refreshRate || 40));
    const intervalMs = Math.round(1000 / fps);

    console.log(`ArtNet refresh rate: ${fps} FPS (${intervalMs}ms interval)`);
    this.intervalId = setInterval(() => this.sendDMX(), intervalMs);
  }

  setChannel(channel: number, value: number): void {
    if (channel >= 1 && channel <= 512) {
      this.dmxData[channel - 1] = Math.max(0, Math.min(255, value));
    }
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

  setAllChannels(data: number[]): void {
    for (let i = 0; i < Math.min(data.length, 512); i++) {
      this.dmxData[i] = Math.max(0, Math.min(255, data[i]));
    }
    this.dirty = true;
  }

  blackout(): void {
    this.dmxData.fill(0);
    this.dirty = true;
  }

  private sendDMX(): void {
    if (!this.socket || !this.isRunning) return;

    this.framesSinceLastSend++;

    // Calculate keepalive interval (~1 second worth of frames)
    const fps = Math.max(1, Math.min(44, this.config.refreshRate || 40));
    const keepaliveFrames = fps;

    // Skip if data hasn't changed and we're not due for a keepalive
    if (!this.dirty && this.framesSinceLastSend < keepaliveFrames) return;

    this.dirty = false;
    this.framesSinceLastSend = 0;
    this.sendCount++;
    this.dmxData.copy(this.lastSentData);

    this.sequence = (this.sequence + 1) % 256;

    const packet = Buffer.alloc(18 + 512);

    // Copy header
    ARTNET_HEADER.copy(packet, 0);

    // Sequence number
    packet[12] = this.sequence;

    // Physical port (usually 0)
    packet[13] = 0;

    // Universe (little-endian)
    packet[14] = this.config.universe & 0xff;
    packet[15] = (this.config.universe >> 8) & 0xff;

    // Length (big-endian)
    packet[16] = 0x02;
    packet[17] = 0x00;

    // DMX data
    this.dmxData.copy(packet, 18);

    const address = this.config.mode === 'multicast'
      ? '255.255.255.255'
      : this.config.unicastAddress || '127.0.0.1';

    this.socket.send(packet, 0, packet.length, ARTNET_PORT, address, (err) => {
      if (err) {
        console.error('Error sending ArtNet packet:', err);
      }
    });
  }

  getDMXData(): Buffer {
    return Buffer.from(this.dmxData);
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
