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
}

export class ArtNetController {
  private socket: dgram.Socket | null = null;
  private config: ArtNetConfig;
  private sequence: number = 0;
  private dmxData: Buffer;
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(config: ArtNetConfig) {
    this.config = config;
    this.dmxData = Buffer.alloc(512, 0);
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

      // Send DMX at ~44Hz (standard DMX refresh rate)
      this.intervalId = setInterval(() => this.sendDMX(), 23);
    });
  }

  stop(): void {
    if (!this.isRunning) return;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.isRunning = false;
    console.log('ArtNet controller stopped');
  }

  updateConfig(config: ArtNetConfig): void {
    this.config = config;
  }

  setChannel(channel: number, value: number): void {
    if (channel >= 1 && channel <= 512) {
      this.dmxData[channel - 1] = Math.max(0, Math.min(255, value));
    }
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
  }

  blackout(): void {
    this.dmxData.fill(0);
  }

  private sendDMX(): void {
    if (!this.socket || !this.isRunning) return;

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
