import { analyzeBench, angle2D, isVisible, median, BENCH_CONFIG } from './bench.mjs';
import { getExercise } from './exercises.mjs';

export function analyzeChest(samples, metadata, {exerciseId='bench_press',side='auto'}={}) {
  const profile=getExercise(exerciseId);
  // Pressing variants share an elbow flexion/extension cycle. All thresholds
  // remain experimental; an exercise label does not confer a validated model.
  const report=analyzeBench(samples,metadata,side);
  const aspect=metadata.width/metadata.height;
  const ids=report.side==='left'?[11,13,15,23,27]:[12,14,16,24,28];
  for(const frame of report.frames){
    const points=frame.landmarks;
    const e=points?.[ids[1]],w=points?.[ids[2]];
    if([e,w].every(isVisible)){
      const dx=(w.x-e.x)*aspect,dy=w.y-e.y,length=Math.hypot(dx,dy);
      frame.alignment=length>1e-8?Math.abs(profile.axis==='horizontal'?dy:dx)/length*100:null;
    }else frame.alignment=null;
    frame.bodyLine=profile.variant==='pushup'?angle2D(points?.[ids[0]],points?.[ids[3]],points?.[ids[4]],aspect):null;
  }
  for(const rep of report.reps){
    const bottomFrames=report.frames.filter(f=>f.visible&&Math.abs(f.time-rep.bottom)<=0.3);
    rep.alignment=rep.valid?median(bottomFrames.map(f=>f.alignment)):null;
    const segment=report.frames.filter(f=>f.time>=rep.start&&f.time<=rep.end);
    const bodyValues=segment.map(f=>f.bodyLine).filter(Number.isFinite);
    rep.bodyLine=rep.valid&&bodyValues.length/Math.max(1,segment.length)>=BENCH_CONFIG.minCoverage?median(bodyValues):null;
  }
  return {...report,exercise:profile.id,profileVersion:'chest-press-v1',countMode:profile.bilateral?'near-arm-cycles':'visible-elbow-cycles'};
}
