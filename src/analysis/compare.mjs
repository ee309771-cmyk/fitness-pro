import { align } from '../vendor/workoutvision/compare.js';
import { median, percentile } from './bench.mjs';

function phasePoints(report, start, end) {
  const frames = report.frames.filter(f => f.time >= start && f.time <= end);
  // This is an engineering gate, experimental. Missing frames are never filled
  // to produce a form verdict. Comparison is descriptive, without a pass score.
  if (frames.length < 3 || frames.filter(f => f.visible).length / frames.length < 0.8) return null;
  const visible = frames.filter(f => f.visible);
  if (visible.some((f,i)=> i>0 && f.time-visible[i-1].time>0.3)) return null;
  return visible;
}

export function compareRep(report, rep, reference, referenceRep) {
  if (reference.metadata.source === 'synthetic' && report.metadata.source !== 'synthetic') return { status:'unavailable', reason:'合成示意不能作为实拍对比参考，请导入真实示范' };
  if (!rep?.valid || !referenceRep?.valid) return { status: 'unavailable', reason: '这次动作的关键关节不够清晰' };
  const mapping = [], differences = [];
  for (const phase of ['down', 'up']) {
    const attempt = phasePoints(report, phase === 'down' ? rep.start : rep.bottom, phase === 'down' ? rep.bottom : rep.end);
    const target = phasePoints(reference, phase === 'down' ? referenceRep.start : referenceRep.bottom, phase === 'down' ? referenceRep.bottom : referenceRep.end);
    if (!attempt || !target) return { status: 'unavailable', reason: '有一段动作被遮挡，暂不对比' };
    // Bound CPU and memory to 80 points per phase, preserving the endpoints.
    const compact = values => values.length <= 80 ? values : Array.from({length:80},(_,i)=>values[Math.round(i*(values.length-1)/79)]);
    const a = compact(attempt), b = compact(target);
    const path = align([b.map(f=>f.angle)], [a.map(f=>f.angle)], true);
    for (const [ri,ai] of path) {
      const gap = Math.abs(b[ri].angle-a[ai].angle);
      mapping.push({ attemptTime:a[ai].time, referenceTime:b[ri].time });
      differences.push({ time:a[ai].time, referenceTime:b[ri].time, gap, phase });
    }
  }
  const worst = differences.reduce((best,p)=>p.gap>best.gap?p:best,differences[0]);
  return {
    status:'compared', mapping,
    medianAngleGap:median(differences.map(x=>x.gap)), p90AngleGap:percentile(differences.map(x=>x.gap),0.9),
    bottomAngleDifference:rep.minAngle-referenceRep.minAngle,
    rangeDifference:rep.range-referenceRep.range,
    alignmentDifference:rep.alignment-referenceRep.alignment,
    durationDifference:rep.duration-referenceRep.duration,
    worst,
    // DTW removes timing only for shape comparison; actual durations above are
    // retained and never taken from the warped time scale.
  };
}

export function referenceTimeAt(comparison, attemptTime) {
  if (comparison?.status !== 'compared' || !comparison.mapping.length) return null;
  return comparison.mapping.reduce((best,p)=>Math.abs(p.attemptTime-attemptTime)<Math.abs(best.attemptTime-attemptTime)?p:best).referenceTime;
}

export function summarizeDifferences(comparisons) {
  return comparisons.filter(c=>c.result.status==='compared')
    .sort((a,b)=>b.result.p90AngleGap-a.result.p90AngleGap).slice(0,3)
    .map(({index,result})=>({
      title:`第 ${index+1} 次 · 肘角轨迹与参考差异`,
      body:`90% 的对齐帧差异不超过 ${result.p90AngleGap.toFixed(1)}°；底部肘角相差 ${Math.abs(result.bottomAngleDifference).toFixed(1)}°。请回看对应画面与机位，差异本身不代表动作错误。`,
      time:result.worst.time,
    }));
}
