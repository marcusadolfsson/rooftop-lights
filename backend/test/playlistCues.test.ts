// Timed events: when cues go off, and how the player interrupts the loop and resumes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlaylistTimeline, checkCue, cueFires, type TimelineItemRow, type TimelineSource } from '../src/services/playlistTimeline.js';
import { PlaylistPlayer } from '../src/scheduler/scheduler.js';

const at = (h: number, m: number) => h * 60 + m;
const item = (id: string, design: string, seconds: number, cue: unknown = null): TimelineItemRow =>
  ({ id, design_id: design, child_playlist_id: null, duration: seconds, repeat_mode: 'seconds', repeat_count: 1, transition: 'cut', cue: cue as never });
const source = (items: TimelineItemRow[]): TimelineSource => ({
  playlist: (id) => (id === 'p' ? { play_mode: 'sequence', items } : undefined),
  designCycle: () => null,
});

test('cue validation normalises times and rejects bad ones', () => {
  assert.deepEqual(checkCue({ type: 'at', time: '9:05' }), { cue: { type: 'at', time: '09:05' } });
  assert.deepEqual(checkCue('{"type":"every","minutes":30,"from":"19:00","until":"23:00"}'),
    { cue: { type: 'every', minutes: 30, from: '19:00', until: '23:00' } });
  assert.deepEqual(checkCue(null), { cue: null });
  assert.ok('error' in checkCue({ type: 'at', time: '25:00' }));
  assert.ok('error' in checkCue({ type: 'every', minutes: 0 }));
  assert.ok('error' in checkCue({ type: 'every', minutes: 15, from: 'soon' }));
});

test('cues fire at their times', () => {
  assert.ok(cueFires({ type: 'at', time: '21:00' }, at(21, 0)));
  assert.ok(!cueFires({ type: 'at', time: '21:00' }, at(21, 1)));
  const hourly = { type: 'every' as const, minutes: 60, from: null, until: null };
  assert.ok(cueFires(hourly, at(3, 0)) && !cueFires(hourly, at(3, 30)));
  const evening = { type: 'every' as const, minutes: 30, from: '19:00', until: '23:00' };
  assert.deepEqual([at(18, 30), at(19, 0), at(19, 30), at(22, 30), at(23, 0)].map(m => cueFires(evening, m)), [false, true, true, true, false]);
  // A window over midnight
  const night = { type: 'every' as const, minutes: 60, from: '22:00', until: '02:00' };
  assert.deepEqual([at(21, 0), at(22, 0), at(0, 0), at(1, 0), at(2, 0)].map(m => cueFires(night, m)), [false, true, true, true, false]);
});

test('timed events are left out of the loop', () => {
  const t = buildPlaylistTimeline('p', source([item('a', 'A', 10), item('e', 'E', 5, { type: 'at', time: '21:00' }), item('b', 'B', 10)]))!;
  assert.deepEqual(t.items.map(n => n.kind === 'leaf' && n.designId), ['A', 'B']);
  assert.equal(t.cues.length, 1);
  assert.equal(t.cues[0].sourceIndex, 1);
});

test('an event interrupts the loop, plays its length, then the loop resumes where it was', () => {
  const t = buildPlaylistTimeline('p', source([item('a', 'A', 60), item('e', 'E', 2, { type: 'at', time: '21:00' })]))!;
  const p = new PlaylistPlayer();
  const start = new Date(2026, 9, 25, 20, 59, 58).getTime();
  const shown: string[] = [];
  let paused = -1;
  for (let f = 0; f < 200; f++) {
    const now = start + f * 33;
    const s = p.step('p', t, undefined, now)!;
    shown.push(s.designId);
    if (s.designId === 'E' && paused < 0) paused = shown.lastIndexOf('A');
  }
  const firstE = shown.indexOf('E');
  assert.ok(firstE > 0, 'event played');
  assert.equal(shown.filter(d => d === 'E').length, 60, 'event plays 2 s');
  assert.equal(shown[firstE + 60], 'A', 'loop resumes');
  // The loop's frame count continues from the pause instead of restarting
  const p2 = new PlaylistPlayer();
  let lastFrame = -1;
  for (let f = 0; f < 200; f++) {
    const s = p2.step('p', t, undefined, start + f * 33)!;
    if (s.designId === 'A') { if (lastFrame >= 0) assert.equal(s.frame, lastFrame + 1); lastFrame = s.frame; }
  }
});

test('starting at an event plays it first', () => {
  const t = buildPlaylistTimeline('p', source([item('a', 'A', 60), item('e', 'E', 2, { type: 'every', minutes: 15 })]))!;
  const p = new PlaylistPlayer();
  const now = new Date(2026, 9, 25, 20, 7, 0).getTime();
  assert.equal(p.step('p', t, 1, now)!.designId, 'E');
  assert.equal(p.position()!.itemIndex, 1);
});

test('a playlist of only events is dark between them', () => {
  const t = buildPlaylistTimeline('p', source([item('e', 'E', 2, { type: 'at', time: '21:00' })]))!;
  const p = new PlaylistPlayer();
  const start = new Date(2026, 9, 25, 20, 59, 59).getTime();
  assert.equal(p.step('p', t, undefined, start), null);
  assert.equal(p.step('p', t, undefined, start + 1500)!.designId, 'E');
});
