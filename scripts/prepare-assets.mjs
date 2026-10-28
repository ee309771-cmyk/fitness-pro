import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'public/mediapipe');
await mkdir(target, { recursive: true });
const licenseDirectory = resolve(root, 'public/licenses');
await mkdir(licenseDirectory, { recursive: true });
const notices = [await readFile(resolve(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'), await readFile(resolve(root, 'src/vendor/workoutvision/LICENSE'), 'utf8')];
for (const dependency of ['react', 'react-dom', 'web-demuxer']) {
  const license = await readFile(resolve(root, 'node_modules', dependency, 'LICENSE'), 'utf8');
  notices.push(`\n## ${dependency}\n\n${license}`);
}
notices.push(`\n## MediaPipe (Apache-2.0)\n\n${await readFile(resolve(root, 'src/vendor/mediapipe/LICENSE'), 'utf8')}`);
await writeFile(resolve(licenseDirectory, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n'));
const vision = dirname(require.resolve('@mediapipe/tasks-vision'));
await cp(resolve(vision, 'wasm'), resolve(target, 'wasm'), { recursive: true });
await cp(resolve(root, 'node_modules/web-demuxer/dist/wasm-files/web-demuxer.wasm'), resolve(root, 'public/web-demuxer.wasm'));
const modelPath = resolve(target, 'pose_landmarker_full.task');
const url = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
try { await access(modelPath); } catch {
  console.log('Downloading official MediaPipe Pose Full model…');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Model download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1_000_000) throw new Error('Model download is incomplete');
  await writeFile(modelPath, bytes);
}
const bytes = await readFile(modelPath);
const hash = createHash('sha256').update(bytes).digest('hex');
if (hash !== '5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1') throw new Error(`Pose model SHA256 mismatch: ${hash}`);
console.log(`Pose model ready (${bytes.length} bytes, SHA256 ${hash}).`);
// MediaPipe 0.10.35 loads its WASM factory with importScripts. It needs a
// classic worker; a module worker can fail with "ModuleFactory not set".
await build({
  configFile: false, publicDir: false, logLevel: 'warn',
  build: {
    lib: { entry: resolve(root, 'src/workers/pose.worker.js'), formats: ['iife'], name: 'FitnessPoseWorker', fileName: () => 'pose-worker.js' },
    outDir: resolve(root, 'public/worker'), emptyOutDir: true, copyPublicDir: false,
  },
});
console.log('Classic pose worker ready.');
