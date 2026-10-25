// Tests for the AI Scene Creator's plan -> designs + scene conversion, with a canned model reply.
// Runs against a copy of a real database: TEST_DB=/path/to/copy.db npm test
// (the copy is copied again to a temp file, so the given file is never written).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const source = process.env.TEST_DB;
if (!source || !fs.existsSync(source)) throw new Error('Set TEST_DB to a copy of rooftop-lights.db');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-scene-test-'));
const dbPath = path.join(dir, 'test.db');
fs.copyFileSync(source, dbPath);
process.env.DATABASE_PATH = dbPath;

type Mod = typeof import('../src/services/aiSceneCreator.js');
let ai: Mod;
let db: import('better-sqlite3').Database;
let closeDatabase: () => void;

const item = (fields: Record<string, unknown>) => ({
  kind: 'builtin', design_id: null, name: '', effect: null, colors: null, speed: null, scope: null,
  params: null, walls: null, code: null, repeat_mode: 'seconds', repeat_count: 1, duration: 10, transition: 'cut',
  ...fields,
});
const count = (table: string) => (db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n;
const designRow = (id: string) => db.prepare('SELECT * FROM designs WHERE id = ?').get(id) as
  { name: string; type: string; data: string; folder: string | null } | undefined;
const sceneItems = (id: string) => db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position').all(id) as
  { design_id: string; duration: number; repeat_mode: string; repeat_count: number; transition: string }[];

let candyCaneId: string;

before(async () => {
  ai = await import('../src/services/aiSceneCreator.js');
  const database = await import('../src/models/database.js');
  db = database.getDatabase();
  closeDatabase = database.closeDatabase;
  const cc = db.prepare(`SELECT id FROM designs WHERE type = 'motion' AND data LIKE '%"candy_cane"%' LIMIT 1`).get() as { id: string } | undefined;
  assert.ok(cc, 'test database needs a candy cane design');
  candyCaneId = cc.id;
});

after(() => {
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prompt gives the model layout, defects, saved designs and built-in effects; schema has no "ai" effect', async () => {
  let captured: { system: string; schema: any } | null = null;
  const plan = await ai.generateScenePlan('spooky intro', {}, async (req) => {
    captured = { system: req.system, schema: req.schema };
    return { name: 'X', summary: '', items: [] };
  });
  assert.deepEqual(plan, { name: 'X', summary: '', items: [] });
  assert.ok(captured);
  const { system, schema } = captured!;
  assert.match(system, /LIGHT LAYOUT/);
  assert.match(system, /DEFECTIVE CHANNELS/);
  assert.ok(system.includes(candyCaneId), 'saved design ids listed');
  assert.match(system, /- comet \("Comet & Chase"\)/);
  assert.match(system, /tailLength: number 0\.\.20/);
  assert.match(system, /Cycle: none/);
  const effects = schema.properties.items.items.properties.effect.anyOf[0].enum as string[];
  assert.ok(effects.includes('comet') && effects.includes('fireworks'));
  assert.ok(!effects.includes('ai'));
});

test('considerDefective false drops the dead-channel map and says every channel works', () => {
  const on = ai.buildScenePrompt(true);
  const off = ai.buildScenePrompt(false);
  assert.match(on, /DEFECTIVE CHANNELS/);
  assert.match(on, /L\.dead \(a string like "gb"/);
  assert.doesNotMatch(off, /DEFECTIVE CHANNELS/);
  assert.doesNotMatch(off, /y=2: 0:/);
  assert.match(off, /Treat every channel \(R, G, B and W\) on every light as working/);
  assert.match(off, /\.dead — .*you do not need it/);
  assert.match(off, /LIGHT LAYOUT/);
});

test('a plan becomes designs and a scene: clamping, defaults, unknown ids and bad code skipped', () => {
  const designsBefore = count('designs');
  const plan = {
    name: 'Spooky Test',
    summary: 'A spooky test scene.',
    items: [
      item({ kind: 'existing', design_id: candyCaneId, repeat_mode: 'times', repeat_count: 2, transition: 'fade' }),
      item({ kind: 'existing', design_id: 'no-such-design' }),
      item({
        name: 'Ghost comet', effect: 'comet', colors: [{ r: 300, g: -5, b: 10.4, w: 0 }], speed: 9, scope: 'wall',
        params: [{ name: 'tailLength', value: 40 }, { name: 'size', value: '3' }, { name: 'bogus', value: 1 }, { name: 'bounce', value: 'false' }],
        repeat_mode: 'times', repeat_count: 2, transition: 'fade_black',
      }),
      item({ name: 'Sparkle', effect: 'sparkle', repeat_mode: 'times', repeat_count: 3, duration: 12.4 }),
      item({ effect: 'laser' }),
      item({
        kind: 'static', name: 'Orange wash',
        walls: [{ wall: 'West', rows: [[{ r: 999, g: 80, b: 0, w: 0 }], [{ r: 255, g: 80, b: 0, w: 0 }], [{ r: 255, g: 80, b: 0, w: 0 }]] }],
        duration: 5,
      }),
      item({ kind: 'code', name: 'Broken', code: 'return {' }),
      item({ kind: 'code', name: 'Pulse', code: 'var out = {}; for (var i = 0; i < ctx.lights.length; i++) out[ctx.lights[i].id] = ctx.colors[0]; return out;', colors: [], duration: 0 }),
      item({ name: 'Bursts', effect: 'fireworks', params: [{ name: 'burstSize', value: [30, 2] }, { name: 'interval', value: 0.05 }], duration: 8 }),
    ],
  };
  const result = ai.createSceneFromPlan(plan, { description: 'spooky halloween intro' });
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;

  assert.equal(result.name, 'Spooky Test');
  assert.equal(result.folder, 'Spooky Test');
  assert.equal(result.summary, 'A spooky test scene.');
  assert.equal(result.designIds.length, 5);
  assert.equal(count('designs'), designsBefore + 5);
  const w = result.warnings.join('\n');
  assert.match(w, /item 2: design id "no-such-design" does not exist/);
  assert.match(w, /unknown comet param "bogus"/);
  assert.match(w, /"tailLength" clamped to its range \(40 -> 20\)/);
  assert.match(w, /unknown built-in effect "laser"/);
  assert.match(w, /item 7 \("Broken"\): params\.code does not compile/);
  assert.match(w, /"burstSize" clamped/);

  const scene = db.prepare('SELECT * FROM playlists WHERE id = ?').get(result.sceneId) as { kind: string; play_mode: string; folder: string };
  assert.equal(scene.kind, 'scene');
  assert.equal(scene.play_mode, 'sequence');
  assert.equal(scene.folder, 'Spooky Test');

  const items = sceneItems(result.sceneId);
  assert.equal(items.length, 6);
  // Reused design keeps "times" (candy cane has a cycle)
  assert.equal(items[0].design_id, candyCaneId);
  assert.equal(items[0].repeat_mode, 'times');
  assert.equal(items[0].repeat_count, 2);
  assert.equal(items[0].transition, 'fade');
  assert.equal(designRow(candyCaneId)!.folder, null, 'reused designs stay where they are');

  // Comet: colors clamped and padded to 2, speed clamped, params clamped / coerced / defaulted
  const comet = designRow(result.designIds[0])!;
  assert.equal(comet.name, 'Ghost comet');
  assert.equal(comet.folder, 'Spooky Test');
  const cometData = JSON.parse(comet.data);
  assert.equal(cometData.type, 'comet');
  assert.deepEqual(cometData.colors[0], { r: 255, g: 0, b: 10, w: 0 });
  assert.equal(cometData.colors.length, 2);
  assert.equal(cometData.speed, 2);
  assert.equal(cometData.scope, 'wall');
  assert.equal(cometData.params.tailLength, 20);
  assert.equal(cometData.params.size, 3);
  assert.equal(cometData.params.bounce, false);
  assert.equal(cometData.params.tailExit, true, 'unspecified params get their defaults');
  assert.ok(!('bogus' in cometData.params));
  assert.equal(items[1].repeat_mode, 'times');
  assert.equal(items[1].repeat_count, 2);
  assert.equal(items[1].transition, 'fade_black');

  // Sparkle has no cycle: "times" falls back to seconds
  assert.equal(items[2].repeat_mode, 'seconds');
  assert.equal(items[2].duration, 12);

  // Static: every light gets a color; West clamped, other walls black
  const wash = JSON.parse(designRow(result.designIds[2])!.data);
  const lightCount = count('lights');
  assert.equal(Object.keys(wash.colors).length, lightCount);
  const westLight = db.prepare(`SELECT l.light_id FROM lights l JOIN walls w ON l.wall_id = w.id WHERE w.name = 'West' AND l.matrix_x = 5 AND l.matrix_y = 0`).get() as { light_id: number };
  assert.deepEqual(wash.colors[westLight.light_id], { r: 255, g: 80, b: 0, w: 0 });
  const northLight = db.prepare(`SELECT l.light_id FROM lights l JOIN walls w ON l.wall_id = w.id WHERE w.name = 'North' LIMIT 1`).get() as { light_id: number };
  assert.deepEqual(wash.colors[northLight.light_id], { r: 0, g: 0, b: 0, w: 0 });
  assert.equal(wash.prompt, 'spooky halloween intro');
  assert.equal(items[3].duration, 5);

  // Code: compiled, default colors, prompt kept, duration at least 1
  const pulse = JSON.parse(designRow(result.designIds[3])!.data);
  assert.equal(pulse.type, 'ai');
  assert.equal(pulse.colors.length, 2);
  assert.equal(pulse.params.prompt, 'spooky halloween intro');
  assert.equal(items[4].repeat_mode, 'seconds');
  assert.equal(items[4].duration, 1);

  // Range params sorted, snapped to their step and clamped
  const bursts = JSON.parse(designRow(result.designIds[4])!.data);
  assert.deepEqual(bursts.params.burstSize, [2, 20]);
  assert.deepEqual(bursts.params.interval, [0.2, 0.2], 'a single number for a range becomes a clamped pair');
  assert.equal(bursts.speed, 1, 'real-time effects keep speed 1');
});

test('folder rules: requested folder and scene-named folder reuse existing ones case-insensitively', () => {
  const existing = (db.prepare('SELECT folder FROM playlists WHERE folder IS NOT NULL UNION SELECT folder FROM designs WHERE folder IS NOT NULL').all() as { folder: string }[])[0]?.folder ?? 'Spooky Test';
  const one = [item({ effect: 'rainbow' })];

  const requested = ai.createSceneFromPlan({ name: 'Anything', summary: '', items: one }, { description: 'x', folder: existing.toUpperCase() });
  assert.ok(requested.ok);
  if (requested.ok) assert.equal(requested.folder, existing);

  const named = ai.createSceneFromPlan({ name: existing.toLowerCase(), summary: '', items: one }, { description: 'x' });
  assert.ok(named.ok);
  if (named.ok) {
    assert.equal(named.folder, existing);
    assert.equal(designRow(named.designIds[0])!.folder, existing);
  }

  const fresh = ai.createSceneFromPlan({ name: '  Brand New Scene  ', summary: '', items: one }, { description: 'x', folder: '' });
  assert.ok(fresh.ok);
  if (fresh.ok) assert.equal(fresh.folder, 'Brand New Scene');

  const long = ai.createSceneFromPlan({ name: 'L'.repeat(80), summary: '', items: one }, { description: 'x' });
  assert.ok(long.ok);
  if (long.ok) assert.equal(long.folder, 'L'.repeat(60));

  const before = count('designs');
  const bad = ai.createSceneFromPlan({ name: 'Bad', summary: '', items: one }, { description: 'x', folder: 'F'.repeat(61) });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.status, 400);
  assert.equal(count('designs'), before);
});

test('a plan with no usable items saves nothing', () => {
  const before = { designs: count('designs'), playlists: count('playlists') };
  const result = ai.createSceneFromPlan({
    name: 'Nothing', summary: '',
    items: [item({ kind: 'existing', design_id: 'nope' }), item({ kind: 'code', code: 'while(' }), item({ effect: 'ai' })],
  }, { description: 'x' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 422);
    assert.equal(result.warnings.length, 3);
  }
  assert.deepEqual({ designs: count('designs'), playlists: count('playlists') }, before);
  assert.equal(ai.createSceneFromPlan({ nope: 1 }, { description: 'x' }).ok, false);
});

test('undo deletes the scene and only the designs it created that nothing else uses', () => {
  const result = ai.createSceneFromPlan({
    name: 'Undo Me', summary: '',
    items: [item({ kind: 'existing', design_id: candyCaneId }), item({ effect: 'rainbow', name: 'A' }), item({ effect: 'breathe', name: 'B' })],
  }, { description: 'x' });
  assert.ok(result.ok);
  if (!result.ok) return;
  const [a, b] = result.designIds;

  // Design B is also used by another scene, so it must survive
  const otherId = 'other-scene-for-undo-test';
  db.prepare(`INSERT INTO playlists (id, name, play_mode, kind) VALUES (?, 'Other', 'sequence', 'scene')`).run(otherId);
  db.prepare(`INSERT INTO playlist_items (id, playlist_id, design_id, duration, position) VALUES ('other-item', ?, ?, 10, 0)`).run(otherId, b);

  assert.deepEqual(ai.undoGeneratedScene(result.sceneId, 'nope'), { ok: false, status: 400, error: 'designIds must be an array of design ids' });
  assert.equal((ai.undoGeneratedScene('missing', []) as { status: number }).status, 404);

  // The reused candy cane id is passed too (a careless client): it was not created with the scene
  const undo = ai.undoGeneratedScene(result.sceneId, [a, b, candyCaneId, 'unrelated']);
  assert.ok(undo.ok);
  if (!undo.ok) return;
  assert.deepEqual(undo.deletedDesignIds, [a]);
  assert.deepEqual(new Set(undo.keptDesignIds), new Set([b, candyCaneId, 'unrelated']));
  assert.equal(db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(result.sceneId), undefined);
  assert.equal(sceneItems(result.sceneId).length, 0);
  assert.equal(designRow(a), undefined);
  assert.ok(designRow(b));
  assert.ok(designRow(candyCaneId));

  // A playlist (not a scene) can't be undone
  const playlist = db.prepare(`SELECT id FROM playlists WHERE kind = 'playlist' LIMIT 1`).get() as { id: string } | undefined;
  if (playlist) assert.equal((ai.undoGeneratedScene(playlist.id, []) as { status: number }).status, 400);
});
