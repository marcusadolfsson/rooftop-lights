import dgram from 'dgram';
import dns from 'dns';
import net from 'net';

// Polls the ArtNet node(s) with ArtPoll and keeps what their ArtPollReplies say,
// so the UI can tell "node offline" apart from "show frozen" (nodes on Hold Last
// keep showing the last frame when the stream or the node drops).
// Replies always go to UDP 6454 on the poller, so this socket binds 6454.

const ARTNET_PORT = 6454;
const OP_POLL_REPLY = 0x2100;
const POLL_INTERVAL_MS = 5000;
// A node that missed this many polls in a row is offline (single replies get lost)
const OFFLINE_AFTER_MS = 20000;

export interface NodePort {
  port: number;        // 1-based physical port (1 = port A)
  bindIndex: number;   // which ArtPollReply describes it
  universe: number;    // Art-Net port-address of the output
  outputting: boolean; // GoodOutput bit 7: data is being output
}

export interface ArtNetNode {
  ip: string;
  shortName: string;
  longName: string;
  report: string;      // free-text NodeReport, e.g. "#0001 [0032] DMX:40,00,00,00 ..."
  firmware: string;    // "4.10"
  mac: string;
  ports: NodePort[];
  lastSeen: number;    // epoch ms
}

export interface NodeStatus {
  target: string | null;   // where polls go
  targetIp: string | null; // target resolved, when it is a hostname
  polling: boolean;
  lastPoll: number | null;
  nodes: (ArtNetNode & { online: boolean })[];
  // Summary for the configured unicast target: online/offline, or null if unknown
  targetOnline: boolean | null;
}

function cString(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('latin1').trim();
}

export function buildArtPoll(): Buffer {
  const p = Buffer.alloc(14);
  p.write('Art-Net\0', 0, 'latin1');
  p.writeUInt16LE(0x2000, 8); // OpPoll
  p.writeUInt16BE(14, 10);    // protocol version
  p[12] = 0x0e;               // flags: reply on change + diagnostics, unicast (as DMXking's utility sends)
  p[13] = 0;                  // diag priority
  return p;
}

/** One ArtPollReply describes up to 4 ports (one bind index). Returns null for anything else. */
export function parseArtPollReply(msg: Buffer) {
  if (msg.length < 207 || msg.toString('latin1', 0, 8) !== 'Art-Net\0') return null;
  if (msg.readUInt16LE(8) !== OP_POLL_REPLY) return null;
  const ip = `${msg[10]}.${msg[11]}.${msg[12]}.${msg[13]}`;
  const net = msg[18] & 0x7f, sub = msg[19] & 0x0f;
  const numPorts = Math.min(4, msg[173]);
  const bindIndex = msg.length > 211 ? Math.max(1, msg[211]) : 1;
  const ports: NodePort[] = [];
  for (let i = 0; i < numPorts; i++) {
    // Port types bit 7: can output DMX
    if (!(msg[174 + i] & 0x80)) continue;
    ports.push({
      // DMXking sends one reply per port (bind index 1..4); others put 4 ports in one
      port: (bindIndex - 1) * numPorts + i + 1,
      bindIndex,
      universe: (net << 8) | (sub << 4) | (msg[190 + i] & 0x0f),
      outputting: (msg[182 + i] & 0x80) !== 0,
    });
  }
  return {
    ip,
    bindIndex,
    shortName: cString(msg, 26, 18),
    longName: cString(msg, 44, 64),
    report: cString(msg, 108, 64),
    firmware: `${msg[16]}.${String(msg[17]).padStart(2, '0')}`,
    mac: [...msg.subarray(201, 207)].map(b => b.toString(16).padStart(2, '0')).join(':'),
    ports,
  };
}

export class ArtNetNodeMonitor {
  private socket: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private target: string | null = null;
  private targetIp: string | null = null;
  private lastPoll: number | null = null;
  private nodes = new Map<string, ArtNetNode>();
  private wasOnline: boolean | null = null;
  private pollingSince: number | null = null;

  constructor(private listenPort = ARTNET_PORT, private pollPort = ARTNET_PORT) {}

  start(target: string | null): void {
    this.setTarget(target);
    if (this.socket) return;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('error', (err) => {
      console.error('ArtNet node monitor error:', err.message);
      this.stop();
    });
    socket.on('message', (msg) => this.handle(msg));
    socket.bind(this.listenPort, () => {
      try { socket.setBroadcast(true); } catch { /* closed already */ }
      this.poll();
      this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = null;
  }

  /** Poll this address (the unicast target, or the broadcast address in multicast mode). */
  setTarget(target: string | null): void {
    if (target === this.target) return;
    this.target = target;
    this.targetIp = target && net.isIPv4(target) ? target : null;
    this.nodes.clear();
    this.wasOnline = null;
    this.pollingSince = null;
  }

  private poll(): void {
    if (!this.socket || !this.target) return;
    this.lastPoll = Date.now();
    this.pollingSince ??= this.lastPoll;
    if (!net.isIPv4(this.target)) {
      const target = this.target;
      dns.lookup(target, 4, (err, address) => { if (!err && this.target === target) this.targetIp = address; });
    }
    this.socket.send(buildArtPoll(), this.pollPort, this.target, () => { /* unreachable target: it just shows as offline */ });
    this.logTransitions();
  }

  handle(msg: Buffer, now = Date.now()): void {
    const r = parseArtPollReply(msg);
    if (!r) return;
    const prev = this.nodes.get(r.ip);
    // Keep ports from the node's other bind indexes, replace this one's
    const ports = (prev?.ports ?? [])
      .filter(p => p.bindIndex !== r.bindIndex)
      .concat(r.ports)
      .sort((a, b) => a.port - b.port);
    this.nodes.set(r.ip, {
      ip: r.ip, shortName: r.shortName, longName: r.longName, report: r.report,
      firmware: r.firmware, mac: r.mac, ports, lastSeen: now,
    });
    this.logTransitions(now);
  }

  getStatus(now = Date.now()): NodeStatus {
    const nodes = [...this.nodes.values()]
      .map(n => ({ ...n, online: now - n.lastSeen < OFFLINE_AFTER_MS }))
      .sort((a, b) => a.ip.localeCompare(b.ip));
    return {
      target: this.target,
      targetIp: this.targetIp,
      polling: this.socket !== null,
      lastPoll: this.lastPoll,
      nodes,
      targetOnline: this.targetOnline(now),
    };
  }

  /** Small summary sent with every WebSocket frame for the header. */
  getSummary(now = Date.now()): { online: boolean | null; name: string | null } {
    const online = this.targetOnline(now);
    const node = (this.targetIp ? this.nodes.get(this.targetIp) : undefined)
      ?? [...this.nodes.values()].find(n => now - n.lastSeen < OFFLINE_AFTER_MS);
    return { online, name: node?.shortName || this.target };
  }

  private targetOnline(now: number): boolean | null {
    if (!this.socket || !this.target || this.pollingSince === null) return null;
    const node = this.targetIp ? this.nodes.get(this.targetIp) : undefined;
    if (node) return now - node.lastSeen < OFFLINE_AFTER_MS;
    // Broadcast target: any node counts. Unicast: not heard from it yet.
    if (this.target === '255.255.255.255') {
      return [...this.nodes.values()].some(n => now - n.lastSeen < OFFLINE_AFTER_MS);
    }
    // Give the first polls time before calling it offline
    return now - (this.pollingSince ?? now) < OFFLINE_AFTER_MS ? null : false;
  }

  private logTransitions(now = Date.now()): void {
    const online = this.targetOnline(now);
    if (online === null || online === this.wasOnline) return;
    if (this.wasOnline !== null || !online) {
      console.log(`ArtNet node ${this.target} is ${online ? 'online again' : 'not answering ArtPoll'}`);
    }
    this.wasOnline = online;
  }
}

let monitor: ArtNetNodeMonitor | null = null;

export function getNodeMonitor(): ArtNetNodeMonitor {
  if (!monitor) monitor = new ArtNetNodeMonitor();
  return monitor;
}

/** Where to poll for a given ArtNet config. */
export function pollTargetFor(config: { mode: string; unicastAddress?: string }): string | null {
  if (config.mode === 'multicast') return '255.255.255.255';
  return config.unicastAddress?.trim() || null;
}
