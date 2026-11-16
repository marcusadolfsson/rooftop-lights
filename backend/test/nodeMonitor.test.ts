// ArtNet node monitor: ArtPollReply parsing and online/offline status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'dgram';
import { buildArtPoll, parseArtPollReply, ArtNetNodeMonitor } from '../src/artnet/nodeMonitor.js';

// An ArtPollReply as a 4-port DMXking node sends it, one per bind index
function reply(ip: number[], bindIndex: number, opts: { outputting?: boolean; swOut?: number } = {}): Buffer {
  const b = Buffer.alloc(239);
  b.write('Art-Net\0', 0, 'latin1');
  b.writeUInt16LE(0x2100, 8);
  ip.forEach((v, i) => { b[10 + i] = v; });
  b.writeUInt16LE(6454, 14);
  b[16] = 4; b[17] = 10;                     // firmware 4.10
  b.write('eDMX4 MAX TEST', 26, 'latin1');
  b.write('DMXking.com eDMX4 MAX DIN S/N TEST', 44, 'latin1');
  b.write('#0001 [0032] DMX:40,00,00,00 Async SHOW:000 Idle', 108, 'latin1');
  b[173] = 1;                                // one port per reply
  b[174] = 0x80;                             // can output DMX
  b[182] = opts.outputting ? 0x80 : 0;
  b[190] = opts.swOut ?? bindIndex - 1;
  Buffer.from([0x00, 0x1a, 0x19, 0x00, 0x00, 0x01]).copy(b, 201);
  b[211] = bindIndex;
  return b;
}

test('ArtPoll matches what the DMXking utility sends', () => {
  assert.equal(buildArtPoll().toString('hex'), '4172742d4e6574000020000e0e00');
});

test('parses an ArtPollReply', () => {
  const r = parseArtPollReply(reply([10, 0, 0, 50], 1, { outputting: true }))!;
  assert.equal(r.ip, '10.0.0.50');
  assert.equal(r.firmware, '4.10');
  assert.equal(r.shortName, 'eDMX4 MAX TEST');
  assert.match(r.report, /^#0001 \[0032\] DMX:40/);
  assert.equal(r.mac, '00:1a:19:00:00:01');
  assert.deepEqual(r.ports, [{ port: 1, bindIndex: 1, universe: 0, outputting: true }]);
  assert.equal(parseArtPollReply(buildArtPoll()), null);
  assert.equal(parseArtPollReply(Buffer.from('hello')), null);
});

test('merges bind indexes into one node and tracks online/offline', () => {
  const m = new ArtNetNodeMonitor();
  m.setTarget('10.0.0.50');
  // Not polling: unknown
  assert.equal(m.getStatus().targetOnline, null);
  const t = 1_000_000;
  m.handle(reply([10, 0, 0, 50], 1, { outputting: true }), t);
  m.handle(reply([10, 0, 0, 50], 2), t);
  m.handle(reply([10, 0, 0, 50], 3), t);
  m.handle(reply([10, 0, 0, 50], 4), t);
  const node = m.getStatus(t + 1000).nodes[0];
  assert.equal(node.online, true);
  assert.deepEqual(node.ports.map(p => [p.port, p.universe, p.outputting]),
    [[1, 0, true], [2, 1, false], [3, 2, false], [4, 3, false]]);
  // A repeated reply replaces that bind index, it doesn't duplicate it
  m.handle(reply([10, 0, 0, 50], 1, { outputting: false }), t + 2000);
  assert.equal(m.getStatus(t + 2000).nodes[0].ports.length, 4);
  assert.equal(m.getStatus(t + 2000).nodes[0].ports[0].outputting, false);
  assert.equal(m.getStatus(t + 60_000).nodes[0].online, false);
});

test('polls over UDP and reports the node online', async () => {
  // A fake node on localhost answers each ArtPoll with a reply to the monitor's port
  const node = dgram.createSocket('udp4');
  await new Promise<void>(r => node.bind(0, '127.0.0.1', r));
  const listen = 20000 + Math.floor(Math.random() * 20000);
  node.on('message', (msg) => {
    if (msg.readUInt16LE(8) === 0x2000) node.send(reply([127, 0, 0, 1], 1, { outputting: true }), listen, '127.0.0.1');
  });
  const m = new ArtNetNodeMonitor(listen, node.address().port);
  m.start('localhost'); // a hostname target is resolved to match the reply's IP
  try {
    for (let i = 0; i < 50 && !m.getStatus().targetOnline; i++) await new Promise(r => setTimeout(r, 20));
    const s = m.getStatus();
    assert.equal(s.targetOnline, true);
    assert.equal(s.nodes[0].ports[0].outputting, true);
  } finally {
    m.stop();
    node.close();
  }
});
