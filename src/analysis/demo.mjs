// Synthetic schematic, used to inspect the interface and deterministic logic.
// It is NOT a real video, a validated reference or evidence of camera accuracy.
export function createDemo({ reps = 4, depth = 85, aspect = 16 / 9 } = {}) {
  const samples = [], cycle = 3.6, fps = 12;
  const total = reps * cycle + 1;
  for (let i = 0; i <= total * fps; i++) {
    const time = i / fps;
    const t = (time - 0.5) % cycle;
    let angle = 174;
    if (time >= 0.5 && time < total - 0.5) {
      if (t < 1.6) angle = 174 - (174 - depth) * (1 - Math.cos(Math.PI * t / 1.6)) / 2;
      else if (t < 1.95) angle = depth;
      else if (t < 3) angle = depth + (174 - depth) * (1 - Math.cos(Math.PI * (t - 1.95) / 1.05)) / 2;
    }
    const phi = (180 - angle) * Math.PI / 180;
    const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }));
    const point = (x, y, visibility = 0.99) => ({ x, y, z: 0, visibility });
    landmarks[11] = point(0.37, 0.56);
    landmarks[13] = point(0.37 + 0.2 * Math.sin(phi) / aspect, 0.56 - 0.2 * Math.cos(phi));
    landmarks[15] = point(landmarks[13].x, landmarks[13].y - 0.23);
    landmarks[23] = point(0.66, 0.6);
    landmarks[25] = point(0.76, 0.77);
    landmarks[27] = point(0.71, 0.91);
    landmarks[0] = point(0.3, 0.54);
    for (const [a, b] of [[11,12],[13,14],[15,16],[23,24],[25,26],[27,28]]) landmarks[b] = point(landmarks[a].x + 0.02, landmarks[a].y + 0.02, 0.35);
    samples.push({ time, landmarks });
  }
  return { samples, metadata: { name: '合成演示 · 非实拍视频', width: 1280, height: 1280 / aspect, duration: samples.at(-1).time, source: 'synthetic' } };
}
