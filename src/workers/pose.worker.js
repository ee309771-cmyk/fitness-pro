import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

let model;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const vision = await FilesetResolver.forVisionTasks(`${data.base}mediapipe/wasm`);
      model = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: `${data.base}mediapipe/pose_landmarker_full.task`, delegate: 'CPU' },
        runningMode: 'IMAGE', numPoses: 1,
        minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5,
        outputSegmentationMasks: false,
      });
      self.postMessage({ id: data.id, ready: true });
      return;
    }
    if (data.type === 'detect') {
      if (!model) throw new Error('姿态模型尚未就绪');
      try {
        const result = model.detect(data.bitmap);
        // Never carry a stale or reconstructed skeleton into an unseen frame.
        self.postMessage({ id: data.id, landmarks: result.landmarks[0] ?? null });
      } finally { data.bitmap.close(); }
    }
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message });
  }
};
