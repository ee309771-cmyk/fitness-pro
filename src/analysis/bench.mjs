import { median5 } from '../vendor/workoutvision/compare.js';

// Engineering thresholds, experimental: not clinical or universal technique limits.
export const BENCH_CONFIG = Object.freeze({ visibility: 0.6, minCoverage: 0.7, minExcursion: 20, minRepSeconds: 0.7, maxGapSeconds: 0.35 });
const POINTS = { left: [11, 13, 15], right: [12, 14, 16] };
export const percentile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.round((sorted.length - 1) * fraction)] : null;
};
export const median = values => percentile(values, 0.5);

export function isVisible(point) {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
    && Number.isFinite(point.visibility) && point.visibility >= BENCH_CONFIG.visibility;
}

// Picture-plane angle, corrected for width / height. Adapted from WorkoutVision
// reference/compare.js (MIT). z is deliberately excluded: it is inferred depth.
export function angle2D(a, b, c, aspect = 1) {
  if (![a, b, c].every(isVisible) || !Number.isFinite(aspect) || aspect <= 0) return null;
  const u = [(a.x - b.x) * aspect, a.y - b.y];
  const v = [(c.x - b.x) * aspect, c.y - b.y];
  const norm = Math.hypot(...u) * Math.hypot(...v);
  return norm > 1e-8 ? Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / norm))) * 180 / Math.PI : null;
}

export function selectSide(samples, requested = 'auto') {
  if (requested !== 'auto') {
    if (!POINTS[requested]) throw new Error('未知的拍摄侧面');
    return requested;
  }
  const quality = side => samples.reduce((sum, sample) => sum + (POINTS[side].every(i => isVisible(sample.landmarks?.[i])) ? 1 : 0), 0);
  return quality('right') > quality('left') ? 'right' : 'left';
}

export function measureFrames(samples, metadata, requestedSide = 'auto') {
  const aspect = metadata.width / metadata.height;
  if (!Number.isFinite(aspect) || aspect <= 0) throw new Error('视频尺寸无效');
  if (samples.some((s, i) => !Number.isFinite(s.time) || s.time < 0 || (i > 0 && s.time <= samples[i - 1].time))) throw new Error('视频时间戳必须递增');
  const side = selectSide(samples, requestedSide);
  const ids = POINTS[side];
  const frames = samples.map(sample => {
    const [shoulder, elbow, wrist] = ids.map(i => sample.landmarks?.[i]);
    const angle = angle2D(shoulder, elbow, wrist, aspect);
    const length = angle == null ? 0 : Math.hypot((wrist.x - elbow.x) * aspect, wrist.y - elbow.y);
    return {
      time: sample.time, landmarks: sample.landmarks, angle,
      // Horizontal wrist/elbow displacement relative to visible forearm length.
      // Descriptive picture-plane proxy, not wrist extension or a barbell path.
      alignment: length > 1e-8 ? Math.abs((wrist.x - elbow.x) * aspect) / length * 100 : null,
      visible: angle != null,
    };
  });
  const smooth = median5(frames.map(f => f.angle));
  frames.forEach((f, i) => { f.smooth = f.visible ? smooth[i] : null; });
  return { frames, side, coverage: frames.length ? frames.filter(f => f.visible).length / frames.length : 0 };
}

export function repFromBounds(frames, start, bottom, end, source = 'automatic') {
  if (![start, bottom, end].every(Number.isFinite) || !(start < bottom && bottom < end)) throw new Error('动作时间应满足：开始 < 底部 < 结束');
  if (start < frames[0]?.time || end > (frames.at(-1)?.time ?? 0) + 0.01) throw new Error('动作时间超出视频范围');
  const slice = frames.filter(f => f.time >= start - 0.001 && f.time <= end + 0.001);
  const visible = slice.filter(f => f.visible);
  const coverage = slice.length ? visible.length / slice.length : 0;
  const valid = coverage >= BENCH_CONFIG.minCoverage && visible.length >= 4;
  const low = percentile(visible.map(f => f.angle), 0.05);
  const high = percentile(visible.map(f => f.angle), 0.95);
  // Pause band is experimental ±4 degrees around the observed minimum; never
  // a prescription. Only a continuous window around the chosen bottom is used.
  const center = slice.reduce((best, f, i) => Math.abs(f.time - bottom) < Math.abs(slice[best].time - bottom) ? i : best, 0);
  let left = center, right = center;
  if (slice[center]?.visible && slice[center].angle <= low + 4) {
    while (left > 0 && slice[left - 1].visible && slice[left - 1].angle <= low + 4) left--;
    while (right + 1 < slice.length && slice[right + 1].visible && slice[right + 1].angle <= low + 4) right++;
  }
  return {
    start, bottom, end, source, coverage, valid, enabled: true,
    minAngle: valid ? low : null, maxAngle: valid ? high : null,
    range: valid ? high - low : null,
    alignment: valid ? median(visible.filter(f => Math.abs(f.time - bottom) <= 0.3).map(f => f.alignment)) : null,
    eccentric: valid ? Math.max(0, slice[left].time - start) : null,
    pause: valid ? Math.max(0, slice[right].time - slice[left].time) : null,
    concentric: valid ? Math.max(0, end - slice[right].time) : null,
    duration: end - start,
  };
}

export function detectReps(frames) {
  const values = frames.map(f => f.smooth).filter(Number.isFinite);
  if (values.length < 8) return [];
  const high = percentile(values, 0.9), low = percentile(values, 0.1);
  const range = high - low;
  if (range < BENCH_CONFIG.minExcursion) return [];
  // Use recurring working tops, rather than the most extended setup/unrack
  // frames. Experimental: video-wide q90 alone can reject later lockouts when
  // the visible elbow projection changes during the set.
  const topGate = percentile(values, 0.6);
  const excursion = BENCH_CONFIG.minExcursion;
  let anchor = null, active = null, previousTime = null, peak = null;
  const reps = [];
  const finish = () => {
    if (!active || !peak) return;
    const descent = active.start.smooth - active.bottom.smooth;
    const returned = peak.smooth - active.bottom.smooth;
    // Relative return is experimental; a local peak avoids demanding the
    // setup's single largest extension on every subsequent repetition.
    if (descent >= excursion && returned >= descent * 0.65 && peak.time - active.start.time >= BENCH_CONFIG.minRepSeconds) {
      reps.push(repFromBounds(frames, active.start.time, active.bottom.time, peak.time));
    }
  };
  for (const frame of frames) {
    if (!frame.visible) continue;
    if (previousTime != null && frame.time - previousTime > BENCH_CONFIG.maxGapSeconds) { anchor = null; active = null; peak = null; }
    previousTime = frame.time;
    if (!active) {
      if (!anchor && frame.smooth >= topGate) anchor = frame;
      if (anchor && frame.smooth >= anchor.smooth) anchor = frame;
      if (anchor && anchor.smooth - frame.smooth >= excursion) active = { start: anchor, bottom: frame };
      continue;
    }
    if (!peak) {
      if (frame.smooth < active.bottom.smooth) active.bottom = frame;
      if (frame.smooth - active.bottom.smooth >= excursion) peak = frame;
    } else if (frame.smooth > peak.smooth + 0.1) peak = frame;
    else if (peak.smooth - frame.smooth >= excursion) {
      finish();
      active = { start: peak, bottom: frame }; anchor = peak; peak = null;
    }
  }
  finish();
  return reps;
}

export function analyzeBench(samples, metadata, requestedSide = 'auto') {
  const measured = measureFrames(samples, metadata, requestedSide);
  const reps = detectReps(measured.frames);
  return {
    schemaVersion: 1, exercise: 'bench_press', createdAt: new Date().toISOString(), metadata,
    ...measured, reps,
    status: measured.coverage < BENCH_CONFIG.minCoverage ? 'limited' : reps.length ? 'review' : 'no-reps',
    method: 'experimental-side-view-v1',
  };
}
