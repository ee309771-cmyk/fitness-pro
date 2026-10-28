import { extractFramesStreaming } from '../vendor/workoutvision/frameExtractor.js';

export async function readVideo(file, { signal, onProgress = () => {} } = {}) {
  if (!file || file.size > 250 * 1024 * 1024) throw new Error('请选择不超过 250 MB 的一组训练视频');
  const base = new URL(import.meta.env.BASE_URL, location.origin).href;
  const worker = new Worker(`${base}worker/pose-worker.js`);
  const waiting = new Map();
  let serial = 0, stopped = false;
  const abortError = () => new DOMException('分析已取消', 'AbortError');
  const stop = () => {
    stopped = true; worker.terminate();
    for (const { reject, timer } of waiting.values()) { clearTimeout(timer); reject(abortError()); }
    waiting.clear();
  };
  const call = (body, transfer = []) => new Promise((resolve, reject) => {
    if (stopped || signal?.aborted) { reject(abortError()); return; }
    const id = ++serial;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('本机分析超时，请尝试更短的视频或关闭其他占用内存的页面'));
    }, 90_000);
    waiting.set(id, { resolve, reject, timer });
    try { worker.postMessage({ ...body, id }, transfer); }
    catch (error) { clearTimeout(timer); waiting.delete(id); reject(error); }
  });
  worker.onmessage = ({ data }) => {
    const request = waiting.get(data.id);
    if (!request) return;
    clearTimeout(request.timer); waiting.delete(data.id);
    if (data.error) request.reject(new Error(data.error)); else request.resolve(data);
  };
  worker.onerror = event => {
    for (const { reject, timer } of waiting.values()) { clearTimeout(timer); reject(new Error(event.message || '本机模型启动失败')); }
    waiting.clear();
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    if (signal?.aborted) throw abortError();
    onProgress({ percent: 0, phase: '正在加载本地姿态模型' });
    await call({ type: 'init', base });
    let samples = [], dimensions = null;
    const result = await extractFramesStreaming(file, 15, 1801, 640, async (canvas, index, time) => {
      if (signal?.aborted) throw abortError();
      // A decoder fallback starts a fresh pass. Discard its abandoned samples.
      if (index === 0) samples = [];
      if (time > 120) throw new Error('首版支持 2 分钟以内的一组动作，请先裁剪视频');
      dimensions = { width: canvas.width, height: canvas.height };
      const bitmap = await createImageBitmap(canvas);
      const detected = await call({ type: 'detect', bitmap }, [bitmap]);
      if (!samples.length || time > samples.at(-1).time) samples.push({ time, landmarks: detected.landmarks });
    }, percent => onProgress({ percent: Math.min(99, percent), phase: '正在读取视频与识别关节' }), { signal });
    if (result.duration > 120) throw new Error('首版支持 2 分钟以内的一组动作，请先裁剪视频');
    if (!samples.length || !dimensions) throw new Error('没有读到有效视频帧，请换用 MP4/H.264 兼容格式');
    onProgress({ percent: 100, phase: '视频识别完成' });
    return { samples, metadata: { ...dimensions, name: file.name, duration: result.duration, source: 'video', decoder: result.method, sampleCount: samples.length } };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener('abort', stop); stop();
  }
}
