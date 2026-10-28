import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBench } from '../src/analysis/bench.mjs';
import { createDemo } from '../src/analysis/demo.mjs';
import { compareRep, referenceTimeAt } from '../src/analysis/compare.mjs';
import { align } from '../src/vendor/workoutvision/compare.js';
const report = options => { const d=createDemo(options);return analyzeBench(d.samples,d.metadata); };

test('closed alignment includes both endpoints instead of cherry-picking a subsection',()=>{
  const p=align([[175,130,85,130,175]],[[175,160,130,85,90,130,175]],true);
  assert.deepEqual(p[0],[0,0]);assert.deepEqual(p.at(-1),[4,6]);
});
test('an identical visible reference gives a zero descriptive angle gap',()=>{
  const a=report();const c=compareRep(a,a.reps[0],a,a.reps[0]);
  assert.equal(c.status,'compared');assert.ok(c.p90AngleGap<0.001);assert.equal(c.durationDifference,0);
  assert.equal(referenceTimeAt(c,a.reps[0].bottom),a.reps[0].bottom);
});
test('a shallower synthetic rep produces a range difference, without a form grade',()=>{
  const a=report({depth:110}),b=report({depth:85});const c=compareRep(a,a.reps[0],b,b.reps[0]);
  assert.equal(c.status,'compared');assert.ok(c.rangeDifference<-15);assert.ok(c.bottomAngleDifference>15);assert.equal(c.score,undefined);
});
test('comparison refuses hidden frames rather than judging an interpolated skeleton',()=>{
  const a=report(),b=report();
  for(const f of a.frames)if(f.time>a.reps[0].start+0.3&&f.time<a.reps[0].bottom)f.visible=false;
  assert.equal(compareRep(a,a.reps[0],b,b.reps[0]).status,'unavailable');
});
test('a synthetic illustration is never used to assess real footage',()=>{
  const a=report(),b=report();a.metadata.source='video';
  assert.match(compareRep(a,a.reps[0],b,b.reps[0]).reason,/合成/);
});
