// A patient's attempt compared with a physiotherapist's reference video (Olivier's exercises, 15 October 2026).
// The reference is a sequence of positions with holds, not a set of repetitions: the counter does not apply. Both
// videos become joint-angle curves; the attempt is aligned in time to the reference (dynamic time warping, so the
// patient need not move at the reference's speed, and may start and stop filming whenever); then each joint is
// compared at every moment of the reference.
//
// R8: a joint the attempt does not show well enough gives no verdict (refused), never a guess.
// R9: every tolerance below is experimental and UNSOURCED until measured on patients' attempts; the clinical tolerance
// is the physiotherapist's to set (15 October 2026), not ours.

// Joints read, by MediaPipe Pose index (11/12 shoulders, 13/14 elbows, 15/16 wrists, 23/24 hips): the angle at the
// middle point. Shoulder: hip-shoulder-elbow (flexion or abduction of the arm against the trunk). Elbow:
// shoulder-elbow-wrist (straight = 180 degrees).
export const JOINTS = Object.freeze({
  leftShoulder: [23, 11, 13],
  rightShoulder: [24, 12, 14],
  leftElbow: [11, 13, 15],
  rightElbow: [12, 14, 16],
});

// A landmark is seen at the counting core's floor (core.ts VIS_THRESHOLD). Source: the core's rule. Status: convention.
export const SEEN_VISIBILITY = 0.5;
// The curves are compared at 10 samples a second: holds and slow raises (the reference's fastest move takes about
// 1 s) keep their shape, and the alignment table stays small (a 60 s reference against a 90 s attempt: 600 x 900).
// Source: the four reference videos' pace. Status: convention.
export const SAMPLE_HZ = 10;
// A reference joint is used only if seen on this share of the reference: below, its curve is the pose model's
// guess (the far arm of video 1 jumps from 17 to 133 degrees in one second). Status: experimental, UNSOURCED.
export const REFERENCE_SEEN_SHARE = 0.8;
// The attempt must show each used joint on this share of its samples, or no verdict. Status: experimental, UNSOURCED
// (the core's own refusal floor is one half). Lowered from 0.7 on 17 October 2026: a patient filmed on the floor, phone
// behind the head, shows the arm on 55 % of the video, lost where both arms lie together; the moments the attempt does
// not show are no longer judged on a filled line (ATTEMPT_JUDGED_SHARE), so the floor no longer needs to carry that.
export const ATTEMPT_SEEN_SHARE = 0.5;
// And the moments judged (shown by both videos) must cover this share of the reference, or no verdict. Status:
// experimental, UNSOURCED.
export const ATTEMPT_JUDGED_SHARE = 0.5;
// A joint that moves through at least this range in the reference is "moving"; under it, "held" (an elbow kept
// straight). Status: experimental, UNSOURCED.
export const MOVING_RANGE_DEG = 20;
// Verdict tolerances: 90 % of the moments within this many degrees of the reference, and the moving range reached
// to this share. Status: experimental, UNSOURCED; to be set with the physiotherapist.
export const TOLERANCE_DEG = 15;
export const TOLERANCE_SHARE = 0.9;
export const MIN_RANGE_SHARE = 0.85;

// Angles in the picture plane (image landmarks, x scaled by the picture's width over its height), not in MediaPipe's
// 3D world space: for a person lying down its depth is unreliable (video 4's arms overhead read 155 degrees in 3D,
// about 178 in the picture, which shows them flat on the table). The patient films from the reference's angle, so
// the two pictures' angles compare. Source: the four reference videos, read frame by frame on 15 October 2026.
// Status: experimental. Without an aspect, world landmarks and 3D angles (for callers that hold only those).
function angleAt(a, b, c, aspect) {
  const z = aspect ? 0 : 1, k = aspect ?? 1;
  const v1 = [(a.x - b.x) * k, a.y - b.y, (a.z - b.z) * z];
  const v2 = [(c.x - b.x) * k, c.y - b.y, (c.z - b.z) * z];
  const n = Math.hypot(...v1) * Math.hypot(...v2);
  if (!n) return null;
  const cos = (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / n;
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

// Segment directions: where a body segment points in the picture, for movements that a joint angle does not show
// (16 October 2026, Olivier's videos 2 and 3, each read twice by the pose model, normally and replayed 1.2 times slower;
// 90th percentile of the gap between the two readings):
// - video 3, filmed from the head end: the hip is hidden behind the body and the head covers the shoulders, so the
//   shoulder angle (hip-shoulder-elbow) differs by 34 degrees between readings; the arm's direction (shoulder to
//   wrist), without the moments when the two wrists overlap, by 6.5;
// - video 2: the forearm's rotation barely changes the elbow angle (29 degrees between readings) but sweeps the
//   forearm (elbow to wrist) through about 55 degrees in the picture, read to 2.6.
// The direction is measured against the body's own line (left shoulder to right shoulder, its median over the whole
// video), so that a phone propped a little askew reads the same; the patient films from the reference's side.
// Status: experimental (measured on two readings of each reference video; no patient attempt yet).
// `apartFrom`: a landmark the segment's end must stay apart from, by this share of the picture's height, or the
// sample is dropped (video 3: the lowered arm lies on the other arm, and the model swaps the two wrists).
// Status: experimental, UNSOURCED.
export const APART_SHARE = 0.08;
// A segment read at under this share of its usual length in the video is not read: its two ends are too close for its
// direction to mean anything (a patient filmed on the floor: the wrist the pose model loses between both arms is put
// beside the shoulder, at the visibility floor, 17 October 2026). Status: experimental, UNSOURCED.
export const SHORT_SEGMENT_SHARE = 0.5;
// The window the largest gap is held over before it is named (compareCurves, worst). Status: convention, UNSOURCED
// (presentation only: the verdict does not read it).
export const WORST_WINDOW_SEC = 1;
// A direction sample further than this from the median of the second around it is a jump of the pose model, dropped.
// Status: experimental, UNSOURCED (the reference's fastest move, about 90 degrees a second, stays well under it).
export const JUMP_DEG = 20;

const wrap = d => ((((d + 180) % 360) + 360) % 360) - 180;

function directionOf(a, b, k) {
  return (Math.atan2(-(b.y - a.y), (b.x - a.x) * k) * 180) / Math.PI;
}

/** The video's body line: median direction of left shoulder to right shoulder over the samples that show both. */
export function bodyLine(landmarks, aspect = 1) {
  return circularMedian(landmarks.map(lm => (lm && (lm[11]?.visibility ?? 0) >= SEEN_VISIBILITY && (lm[12]?.visibility ?? 0) >= SEEN_VISIBILITY
    ? directionOf(lm[11], lm[12], aspect) : null)));
}

/** Raw angle of each joint and direction of each segment per sample, null where a point is unseen; `aspect` = width / height of the picture. */
export function jointAngles(landmarks, { joints = JOINTS, directions = {}, aspect } = {}) {
  const out = {};
  if (Object.keys(directions).length) {
    const k = aspect ?? 1, line = bodyLine(landmarks, k);
    for (const [name, { from, to, apartFrom }] of Object.entries(directions)) {
      const seen = lm => lm && [from, to].every(i => (lm[i]?.visibility ?? 0) >= SEEN_VISIBILITY)
        && !(apartFrom != null && lm[apartFrom] && Math.hypot((lm[to].x - lm[apartFrom].x) * k, lm[to].y - lm[apartFrom].y) < APART_SHARE);
      const length = lm => Math.hypot((lm[to].x - lm[from].x) * k, lm[to].y - lm[from].y);
      // The segment's usual length in this video; a sample where it is under SHORT_SEGMENT_SHARE of it is not read.
      const lengths = landmarks.filter(seen).map(length).sort((a, b) => a - b);
      const usual = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;
      out[name] = landmarks.map(lm => {
        if (!seen(lm)) return null;
        if (length(lm) < SHORT_SEGMENT_SHARE * usual) return null;
        return wrap(directionOf(lm[from], lm[to], k) - line);
      });
    }
  }
  for (const [name, [a, b, c]] of Object.entries(joints)) {
    out[name] = landmarks.map(lm => {
      if (!lm || [a, b, c].some(i => (lm[i]?.visibility ?? 0) < SEEN_VISIBILITY)) return null;
      return angleAt(lm[a], lm[b], lm[c], aspect);
    });
  }
  return out;
}

/** Values at SAMPLE_HZ from (time, value|null) samples; a gap over 0.5 s stays null. */
export function resample(timestamps, values, hz = SAMPLE_HZ) {
  if (!timestamps.length) return [];
  const t0 = timestamps[0];
  const n = Math.floor((timestamps.at(-1) - t0) * hz) + 1;
  const out = new Array(n).fill(null);
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + k / hz;
    while (j < timestamps.length - 2 && timestamps[j + 1] <= t) j++;
    const ta = timestamps[j], tb = timestamps[j + 1] ?? ta;
    const va = values[j], vb = values[j + 1] ?? va;
    if (va == null || vb == null || tb - ta > 0.5) out[k] = va ?? vb ?? null;
    else out[k] = tb === ta ? va : va + ((vb - va) * (t - ta)) / (tb - ta);
  }
  return out;
}

/** Median of 5 over seen values (removes one-sample jumps of the pose model). */
export function median5(values) {
  return values.map((v, i) => {
    if (v == null) return null;
    const w = values.slice(Math.max(0, i - 2), i + 3).filter(x => x != null).sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  });
}

const seenShare = values => (values.length ? values.filter(v => v != null).length / values.length : 0);

/** Unseen samples filled by a straight line between the seen ones around them (the ends repeat the nearest seen). */
export function fillGaps(values) {
  const seen = [];
  values.forEach((v, i) => { if (v != null) seen.push(i); });
  if (!seen.length) return values.slice();
  return values.map((v, i) => {
    if (v != null) return v;
    const after = seen.findIndex(s => s > i);
    if (after === -1) return values[seen.at(-1)];
    if (after === 0) return values[seen[0]];
    const a = seen[after - 1], b = seen[after];
    return values[a] + ((values[b] - values[a]) * (i - a)) / (b - a);
  });
}

function percentile(values, p) {
  const s = values.filter(v => v != null).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

const range = values => percentile(values, 0.95) - percentile(values, 0.05);

/** A direction's samples kept on one side of the circle: each within 180 degrees of their circular median. */
export function unwrapAround(values, centre = circularMedian(values)) {
  return values.map(v => (v == null ? null : centre + wrap(v - centre)));
}

function circularMedian(values) {
  const seen = values.filter(v => v != null);
  if (!seen.length) return 0;
  const r = Math.PI / 180;
  const mean = Math.atan2(seen.reduce((s, d) => s + Math.sin(d * r), 0), seen.reduce((s, d) => s + Math.cos(d * r), 0)) / r;
  const around = seen.map(d => mean + wrap(d - mean)).sort((x, y) => x - y);
  return around[Math.floor(around.length / 2)];
}

/**
 * Samples further than JUMP_DEG from the median of the second around them, dropped. The window is kept symmetric (as
 * many seen samples on each side), so that a steady move next to a gap or an end is not taken for a jump.
 */
export function dropJumps(values, half = Math.round(SAMPLE_HZ / 2)) {
  return values.map((v, i) => {
    if (v == null) return null;
    const before = values.slice(Math.max(0, i - half), i).filter(x => x != null);
    const after = values.slice(i + 1, i + half + 1).filter(x => x != null);
    const n = Math.min(before.length, after.length);
    if (!n) return v;
    const w = [...before.slice(before.length - n), v, ...after.slice(0, n)].sort((a, b) => a - b);
    return Math.abs(v - w[n]) > JUMP_DEG ? null : v;
  });
}

/** Smoothed curves at SAMPLE_HZ of every joint and direction, from a video's landmarks (see jointAngles for the options). */
export function curves(landmarks, timestamps, options = {}) {
  const raw = jointAngles(landmarks, options);
  const out = {};
  for (const [name, values] of Object.entries(raw)) {
    out[name] = options.directions?.[name]
      ? median5(dropJumps(resample(timestamps, unwrapAround(values))))
      : median5(resample(timestamps, values));
  }
  return out;
}

/**
 * The reference model: the joints the reference shows well enough, each "moving" or "held", with its curve.
 * Returns { joints: [{ name, kind, range, curve }], duration, unused: [{ name, seenShare }] }.
 */
export function buildReference(landmarks, timestamps, options = {}) {
  return referenceFromCurves(curves(landmarks, timestamps, options), Object.keys(options.directions ?? {}));
}

export function referenceFromCurves(curveByJoint, directionNames = []) {
  const used = [], unused = [];
  let length = 0;
  for (const [name, curve] of Object.entries(curveByJoint)) {
    length = Math.max(length, curve.length);
    const share = seenShare(curve);
    if (share < REFERENCE_SEEN_SHARE) { unused.push({ name, seenShare: share }); continue; }
    const r = range(curve);
    const joint = { name, kind: r >= MOVING_RANGE_DEG ? 'moving' : 'held', range: r, curve: fillGaps(curve), seen: curve.map(v => v != null) };
    if (directionNames.includes(name)) joint.direction = true;
    used.push(joint);
  }
  return { joints: used, duration: length / SAMPLE_HZ, unused };
}

/**
 * Subsequence dynamic time warping: the whole reference against any stretch of the attempt (the attempt may hold
 * extra footage before and after). Cost: mean absolute angle difference over the joints. Returns the path as
 * [refIndex, attemptIndex] pairs.
 */
// Fitness Pro adaptation: optional closed endpoints for a pre-segmented rep.
// Default subsequence behavior remains unchanged for upstream callers.
export function align(refCurves, attCurves, closed = false) {
  const n = refCurves[0].length, m = attCurves[0].length, J = refCurves.length;
  const cost = (i, j) => {
    let s = 0;
    for (let k = 0; k < J; k++) s += Math.abs(refCurves[k][i] - attCurves[k][j]);
    return s / J;
  };
  const D = Array.from({ length: n }, () => new Float64Array(m));
  const B = Array.from({ length: n }, () => new Uint8Array(m)); // 0 diagonal, 1 from above, 2 from left
  for (let j = 0; j < m; j++) { D[0][j] = cost(0, j) + (closed && j > 0 ? D[0][j - 1] : 0); B[0][j] = 2; }
  for (let i = 1; i < n; i++) {
    D[i][0] = D[i - 1][0] + cost(i, 0); B[i][0] = 1;
    for (let j = 1; j < m; j++) {
      const d = D[i - 1][j - 1], u = D[i - 1][j], l = D[i][j - 1];
      if (d <= u && d <= l) { D[i][j] = d + cost(i, j); B[i][j] = 0; }
      else if (u <= l) { D[i][j] = u + cost(i, j); B[i][j] = 1; }
      else { D[i][j] = l + cost(i, j); B[i][j] = 2; }
    }
  }
  let j = closed ? m - 1 : 0;
  if (!closed) for (let k = 1; k < m; k++) if (D[n - 1][k] < D[n - 1][j]) j = k;
  const path = [];
  let i = n - 1;
  while (i >= 0) {
    path.push([i, j]);
    if (i === 0) { if (closed) while (j > 0) path.push([0, --j]); break; }
    const b = B[i][j];
    if (b === 0) { i--; j--; } else if (b === 1) i--; else j--;
  }
  return path.reverse();
}

/**
 * Compares an attempt's curves with the reference model.
 * Returns { verdict: 'match' | 'revise' | 'refused', reasons, joints, start, end, tempo } where joints holds, per
 * joint, the share of moments within tolerance, the 90th percentile gap, the range reached, and the moment of the
 * reference where the gap is largest.
 */
export function compareCurves(reference, attemptCurves) {
  const reasons = [];
  if (!reference.joints.length) return { verdict: 'refused', reasons: ['reference-unseen'], joints: [] };
  for (const j of reference.joints) {
    if (!attemptCurves[j.name] || seenShare(attemptCurves[j.name]) < ATTEMPT_SEEN_SHARE) reasons.push(`unseen:${j.name}`);
  }
  if (reasons.length) return { verdict: 'refused', reasons, joints: [] };
  const ref = reference.joints.map(j => j.curve);
  // Where the attempt shows each measure: its gaps are filled below for the alignment only, never judged (R8).
  const attSeen = reference.joints.map(j => attemptCurves[j.name].map(v => v != null));
  // A direction's samples set on the reference's side of the circle.
  const att = reference.joints.map((j, k) => fillGaps(j.direction ? unwrapAround(attemptCurves[j.name], circularMedian(ref[k])) : attemptCurves[j.name]));
  const path = align(ref, att);
  const start = path[0][1], end = path.at(-1)[1];
  // The attempt's value at each moment of the reference: the mean of the seen attempt samples matched to it, null
  // where none is seen.
  const matchedByJoint = ref.map((curve, k) => {
    const sums = new Float64Array(curve.length), counts = new Uint16Array(curve.length);
    for (const [ri, ai] of path) if (attSeen[k][ai]) { sums[ri] += att[k][ai]; counts[ri]++; }
    return Array.from(sums, (s, i) => (counts[i] ? s / counts[i] : null));
  });
  // Judged only at the moments both videos show: where the reference's pose was lost, its curve is a filled line, not
  // Olivier's movement (video 2: the forearm crossing the face below the horizontal); where the attempt's was lost
  // (a patient filmed on the floor, both arms lying together), the same. R8.
  const joints = reference.joints.map((j, k) => {
    const matched = matchedByJoint[k];
    const shown = i => (j.seen?.[i] ?? true) && matched[i] != null;
    const gaps = matched.map((v, i) => (shown(i) ? Math.abs(v - ref[k][i]) : null));
    const judged = gaps.filter(g => g != null);
    const within = judged.filter(g => g <= TOLERANCE_DEG).length / judged.length;
    // The largest gap held for about a second: the median gap over WORST_WINDOW_SEC around each judged moment, at its
    // largest. A single sample the pose model misread is not named the attempt's largest gap (17 October 2026: a
    // wrist taken for the other one gave "12 degrees instead of 55" on a frame where the arm is plainly level).
    const half = Math.round((WORST_WINDOW_SEC * SAMPLE_HZ) / 2);
    let worst = gaps.findIndex(g => g != null), worstGap = -1;
    for (let i = 0; i < gaps.length; i++) {
      if (gaps[i] == null) continue;
      const w = gaps.slice(Math.max(0, i - half), i + half + 1).filter(g => g != null).sort((a, b) => a - b);
      const g = w[Math.floor(w.length / 2)];
      if (g > worstGap) { worstGap = g; worst = i; }
    }
    const rangeShare = j.kind === 'moving' ? range(matched.map((v, i) => (shown(i) ? v : null))) / j.range : null;
    return {
      name: j.name, kind: j.kind, direction: !!j.direction, within, gapP90: percentile(gaps, 0.9), rangeShare, shown: judged.length / gaps.length,
      // The share of the moments the reference shows that the attempt shows too: what the patient's video lost.
      attShown: judged.length / Math.max(1, j.seen ? j.seen.filter(Boolean).length : gaps.length),
      worst: { atSec: worst / SAMPLE_HZ, reference: ref[k][worst], attempt: matched[worst] },
    };
  });
  // Too few moments judged: no verdict, as for an attempt that does not show the measure at all.
  for (const j of joints) if (j.attShown < ATTEMPT_JUDGED_SHARE) reasons.push(`unseen:${j.name}`);
  if (reasons.length) return { verdict: 'refused', reasons, joints: [] };
  for (const j of joints) {
    if (j.within < TOLERANCE_SHARE) reasons.push(`off:${j.name}`);
    if (j.kind === 'moving' && j.rangeShare < MIN_RANGE_SHARE) reasons.push(`range:${j.name}`);
  }
  return {
    verdict: reasons.length ? 'revise' : 'match', reasons, joints,
    cost: path.reduce((sum, [i, x]) => sum + ref.reduce((t, curve, k) => t + Math.abs(curve[i] - att[k][x]), 0), 0) / path.length / ref.length,
    start: start / SAMPLE_HZ, end: end / SAMPLE_HZ,
    tempo: (end - start + 1) / ref[0].length,
    path,
    reference: reference.joints.map(j => j.curve),
    // Per measure, whether both videos show each moment of the reference; the screens judge and label only those (R8).
    seen: reference.joints.map((j, k) => (j.seen ?? j.curve.map(() => true)).map((s, i) => s && matchedByJoint[k][i] != null)),
    matched: matchedByJoint,
    // The attempt's own samples per measure (filled across what it does not show) and where it shows them: a still
    // frame of the report shows a sample the attempt shows, with its own value (attempt-export.js reportMoments).
    attempt: att,
    attSeen,
    holds: holds(reference, att, path, attSeen),
  };
}

// A hold: the reference's main joint (its largest range) moving under this speed for at least this long. Source: the
// four reference videos (their holds last 2 to 5 s, their raises 1 to 3 s). Status: experimental, UNSOURCED.
export const HOLD_SPEED_DEG_S = 10;
export const HOLD_MIN_SEC = 1;
// A hold is kept when the attempt's angle is within TOLERANCE_DEG of the reference's and it lasts this share of the
// reference's time. Status: experimental, UNSOURCED; to be set with the physiotherapist.
export const HOLD_TIME_SHARE = 0.8;
// A reference hold is judged only if its pose is seen on this share of it. Status: experimental, UNSOURCED.
export const HOLD_SHOWN_SHARE = 0.8;

/**
 * The positions the reference holds, each with what the attempt did at the same moment: the reference's angle and
 * time held, the attempt's mean angle and the time its matched samples span.
 */
export function holds(reference, attCurves, path, attSeen = null) {
  const moving = reference.joints.map((j, k) => [j, k]).filter(([j]) => j.kind === 'moving');
  if (!moving.length) return [];
  const [main, k] = moving.reduce((a, b) => (b[0].range > a[0].range ? b : a));
  const c = main.curve, a = attCurves[k];
  // Speed over 0.6 s, centred: one-sample jitter of the pose model is not movement.
  const h = 3;
  const stillOf = curve => curve.map((_, i) => {
    const x = curve[Math.max(0, i - h)], y = curve[Math.min(curve.length - 1, i + h)];
    return (Math.abs(y - x) * SAMPLE_HZ) / (2 * h) < HOLD_SPEED_DEG_S;
  });
  // The attempt is still only where it is seen: a filled line is flat, not held (R8).
  const still = stillOf(c), attStill = stillOf(a).map((v, x) => v && (!attSeen || attSeen[k][x]));
  const out = [];
  for (let i = 0; i < c.length;) {
    if (!still[i]) { i++; continue; }
    let e = i;
    while (e + 1 < c.length && still[e + 1]) e++;
    // A hold the reference does not show (its curve filled across a lost pose) is not one to judge (R8).
    const shownShare = main.seen ? main.seen.slice(i, e + 1).filter(Boolean).length / (e - i + 1) : 1;
    if ((e - i + 1) / SAMPLE_HZ >= HOLD_MIN_SEC && shownShare >= HOLD_SHOWN_SHARE) {
      const ai = path.filter(([ri]) => ri >= i && ri <= e).map(([, x]) => x).sort((x, y) => x - y);
      // A hold the attempt does not show is not judged either: its filled line would read as held (R8).
      if (attSeen && ai.filter(x => attSeen[k][x]).length < HOLD_SHOWN_SHARE * ai.length) { i = e + 1; continue; }
      const attAngle = ai.reduce((sum, x) => sum + a[x], 0) / ai.length;
      // The attempt's own hold: from the middle of its matched samples, as far as it stays still. The alignment
      // gives a long hold's extra samples to the reference's moments around it, so its span alone would hide them.
      // From the still sample nearest the middle of the matched ones, looked for up to half a second beyond them: the
      // alignment can give a whole hold to the last sample of the move into it (video 3, re-read slower, 16 October 2026).
      const mid = ai[Math.floor(ai.length / 2)], reach = Math.round(SAMPLE_HZ / 2);
      const near = [];
      for (let x = Math.max(0, ai[0] - reach); x <= Math.min(a.length - 1, ai.at(-1) + reach); x++) if (attStill[x]) near.push(x);
      const still = near.sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid));
      let lo = still[0] ?? mid, hi = lo;
      if (attStill[lo]) {
        while (lo > 0 && attStill[lo - 1]) lo--;
        while (hi + 1 < a.length && attStill[hi + 1]) hi++;
      }
      // A hold whose end the attempt does not show cannot be timed: not judged (R8).
      if (attSeen && attStill[lo] && ((lo > 0 && !attSeen[k][lo - 1]) || (hi + 1 < a.length && !attSeen[k][hi + 1]))) { i = e + 1; continue; }
      out.push({
        joint: main.name,
        direction: !!main.direction,
        startSec: i / SAMPLE_HZ,
        refSec: (e - i + 1) / SAMPLE_HZ,
        refAngle: c.slice(i, e + 1).reduce((sum, v) => sum + v, 0) / (e - i + 1),
        attSec: attStill[lo] ? (hi - lo + 1) / SAMPLE_HZ : 0,
        attAngle,
      });
      const hold = out.at(-1);
      hold.status = Math.abs(hold.attAngle - hold.refAngle) > TOLERANCE_DEG ? 'angle'
        : hold.attSec < hold.refSec * HOLD_TIME_SHARE ? 'short' : 'held';
    }
    i = e + 1;
  }
  return out;
}

// MediaPipe Pose's 33 points, each with its other-side twin (0 the nose has none).
export const MIRROR = Object.freeze([0, 4, 5, 6, 1, 2, 3, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15, 18, 17, 20, 19, 22, 21, 24, 23, 26, 25, 28, 27, 30, 29, 32, 31]);

/** Landmarks of the picture seen in a mirror: x turned over, left and right points exchanged. */
export function mirrorLandmarks(landmarks) {
  return landmarks.map(lm => lm && lm.map((_, i) => { const p = lm[MIRROR[i]]; return p && { ...p, x: 1 - p.x }; }));
}

// How much clearer the mirror reading must see the measured points to be kept over a plain reading that has a verdict.
// Status: experimental, UNSOURCED (video 4: near arm seen at 0.9 and more, far arm at 0.72 on average).
export const NEARER_MARGIN = 0.1;

/** Mean visibility, over the attempt, of the points the reference's measures are read from. */
function seenScore(reference, landmarks, { joints = JOINTS, directions = {} } = {}) {
  const points = [...new Set(reference.joints.flatMap(j => (directions[j.name] ? [directions[j.name].from, directions[j.name].to] : joints[j.name] ?? [])))];
  let sum = 0, n = 0;
  for (const lm of landmarks) {
    if (!lm) continue;
    for (const i of points) { sum += lm[i]?.visibility ?? 0; n++; }
  }
  return n ? sum / n : 0;
}

const otherSide = name => (name.startsWith('left') ? `right${name.slice(4)}` : name.startsWith('right') ? `left${name.slice(5)}` : name);

/**
 * Attempt landmarks against a reference model (the same kind of landmarks and options as the reference's). The attempt
 * is read as in a mirror when the physiotherapist set the reference's other side (`mirror`), when the plain reading
 * gives no verdict, or when the mirror reading sees the measured points clearly better: a patient filmed from the
 * other side, or lying the other way round, shows the reference's arm on the other side of the body. Never because a
 * reading fits better: on a side-on video the mirror reading is the far arm, which the reference itself leaves out as
 * the pose model's guess, and keeping the closer of two readings would let a wrong movement of one arm pass on the
 * other (R8). The mirrored result names the
 * patient's side (`measure` keeps the reference's name) and says `mirrored`.
 */
export function compareAttempt(reference, landmarks, timestamps, options = {}) {
  // `mirror`: the patient is known to work the reference's other side (set by the physiotherapist): only the mirrored
  // reading is made.
  const flipped = mirrorLandmarks(landmarks);
  const plain = options.mirror ? null : compareCurves(reference, curves(landmarks, timestamps, options));
  if (plain?.reasons.includes('reference-unseen')) return { ...plain, mirrored: false };
  // The reference judges the arm nearest its camera (the one it sees); so does the attempt: the mirror reading is
  // kept when it sees the measured points clearly better (a patient filmed from the other side), never because it
  // fits the reference better.
  const nearer = plain && plain.verdict !== 'refused'
    && seenScore(reference, flipped, options) > seenScore(reference, landmarks, options) + NEARER_MARGIN;
  if (plain && plain.verdict !== 'refused' && !nearer) return { ...plain, mirrored: false };
  const m = compareCurves(reference, curves(flipped, timestamps, options));
  if (plain && m.verdict === 'refused') return { ...plain, mirrored: false };
  return {
    ...m,
    mirrored: true,
    joints: m.joints.map(j => ({ ...j, name: otherSide(j.name), measure: j.name })),
    reasons: m.reasons.map(r => { const [kind, name] = r.split(':'); return name ? `${kind}:${otherSide(name)}` : r; }),
    holds: (m.holds ?? []).map(h => ({ ...h, joint: otherSide(h.joint) })),
  };
}

/** An angle as the screens show it: a direction, measured against the body line, as its angle to that line (0 to 180). */
export const shownAngle = (value, direction) => (direction ? Math.abs(wrap(value)) : value);
