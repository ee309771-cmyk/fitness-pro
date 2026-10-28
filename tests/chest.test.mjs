import test from 'node:test';
import assert from 'node:assert/strict';
import {EXERCISES,getExercise} from '../src/analysis/exercises.mjs';
import {analyzeChest}from '../src/analysis/chest.mjs';
import {createChestDemo}from '../src/analysis/chest-demo.mjs';
import {compareRep}from '../src/analysis/compare.mjs';

for(const profile of EXERCISES)test(`${profile.name}: schematic cycles retain the selected exercise and units`,()=>{
  const d=createChestDemo(profile.id);const r=analyzeChest(d.samples,d.metadata,{exerciseId:profile.id});
  assert.equal(r.exercise,profile.id);assert.equal(r.reps.length,4);assert.equal(r.coverage,1);
  assert.ok(r.reps.every(rep=>rep.valid&&rep.range>60));
  assert.ok(r.reps.every(rep=>Math.abs(rep.alignment)<.01),'alignment axis follows the exercise, rather than always vertical');
  if(profile.variant==='pushup')assert.ok(r.reps.every(rep=>rep.bodyLine>179));
});
test('a flat barbell reference cannot silently assess an incline dumbbell press',()=>{
  const d=createChestDemo('incline_dumbbell_press'),f=createChestDemo('bench_press');
  const a=analyzeChest(d.samples,d.metadata,{exerciseId:'incline_dumbbell_press'}),b=analyzeChest(f.samples,f.metadata);
  assert.match(compareRep(a,a.reps[0],b,b.reps[0]).reason,/类型不同/);
});
test('unsupported lower-body exercises are outside the selected chest scope',()=>{
  assert.throws(()=>getExercise('deadlift'),/六类胸部/);
  assert.throws(()=>getExercise('squat'),/六类胸部/);
});
test('push-up torso-line measurement is withheld when hip/ankle visibility is mostly missing',()=>{
  const d=createChestDemo('push_up');
  d.samples.forEach((s,i)=>{if(i!==20){s.landmarks[23].visibility=.1;s.landmarks[27].visibility=.1;}});
  const r=analyzeChest(d.samples,d.metadata,{exerciseId:'push_up'});
  assert.equal(r.reps.length,4);assert.ok(r.reps.every(rep=>rep.bodyLine===null));
});
