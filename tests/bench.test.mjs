import test from 'node:test';
import assert from 'node:assert/strict';
import { angle2D, analyzeBench, measureFrames, repFromBounds } from '../src/analysis/bench.mjs';
import { createDemo } from '../src/analysis/demo.mjs';

test('side-view cycle detection counts four complete synthetic bench reps', () => {
  const { samples, metadata } = createDemo();
  const report = analyzeBench(samples, metadata);
  assert.equal(report.reps.length, 4);
  assert.equal(report.side, 'left');
  assert.equal(report.coverage, 1);
  assert.ok(report.reps.every(r => r.valid && r.range > 60 && r.pause > 0));
  assert.ok(report.reps.every(r => r.duration < 3.3), 'lockout rest must not inflate the next rep duration');
});
test('a long landmark loss does not join two half reps into a full rep', () => {
  const { samples, metadata } = createDemo({ reps: 1 });
  for (const f of samples) if (f.time > 1.3 && f.time < 2.8) f.landmarks = null;
  const report = analyzeBench(samples, metadata);
  assert.equal(report.reps.length, 0);
  assert.equal(report.status, 'limited');
});
test('a video starting at the bottom needs a top anchor before counting', () => {
  const { samples, metadata } = createDemo({ reps: 1 });
  const clipped = samples.filter(s => s.time >= 2).map(s => ({ ...s, time: s.time - 2 }));
  assert.equal(analyzeBench(clipped, metadata).reps.length, 0);
});
test('stationary frames, jitter and missing joints never receive a confident rep', () => {
  const { samples, metadata } = createDemo();
  const still = samples.map((s, i) => ({ time: s.time, landmarks: samples[0].landmarks.map(p => ({ ...p, x: p.x + Math.sin(i) * 0.0002 })) }));
  assert.equal(analyzeBench(still, metadata).reps.length, 0);
  for (const s of samples) s.landmarks[15].visibility = 0.2;
  const missing = analyzeBench(samples, metadata, 'left');
  assert.equal(missing.coverage, 0);
  assert.ok(missing.frames.every(f => f.angle == null && f.alignment == null));
});
test('picture angles respect the pixel aspect ratio, reject invalid points', () => {
  const p = (x, y) => ({ x, y, visibility: 1 });
  assert.ok(Math.abs(angle2D(p(0.2,0.3), p(0.4,0.5), p(0.6,0.3), 1) - 90) < 0.01);
  assert.ok(angle2D(p(0.2,0.3), p(0.4,0.5), p(0.6,0.3), 2) > 120);
  assert.equal(angle2D(p(NaN,0.3), p(0.4,0.5), p(0.6,0.3)), null);
});
test('manual segments validate bounds, preserve provenance and refuse invisible metrics', () => {
  const { samples, metadata } = createDemo();
  const { frames } = measureFrames(samples, metadata);
  const rep = repFromBounds(frames, 0.5, 2.2, 3.5, 'manual');
  assert.equal(rep.source, 'manual');
  assert.equal(rep.valid, true);
  assert.throws(() => repFromBounds(frames, 3, 2, 4), /开始/);
  assert.throws(() => repFromBounds(frames, 1, 2, 100), /范围/);
});
test('unsorted timestamps cannot generate misleading speeds', () => {
  const { samples, metadata } = createDemo();
  samples[2].time = samples[1].time;
  assert.throws(() => analyzeBench(samples, metadata), /递增/);
});
