/**
 * Frame extraction and hashing utilities for video analysis.
 *
 * Two extraction methods (tried in order):
 * 1. extractFramesWebCodecs — WebCodecs VideoDecoder with web-demuxer.
 *    Decodes video frames directly via hardware decoder, bypassing <video> + canvas.
 *    Sequential, deterministic, handles rotation metadata. Safari 16.4+, Chrome 94+.
 * 2. extractFramesRVFC — requestVideoFrameCallback with accelerated playback (fallback).
 *    Plays video at 2-4x speed and captures frames via rVFC. Chrome 83+, Safari 15.4+.
 *
 * No seek path. If both fail, extraction refuses with a reason.
 * All methods stream one frame at a time via callback, keeping memory constant.
 */

import { canvasPixels, isFrozenRead, pixelsFingerprint, repeatCounter } from './frozenRead';

/**
 * Whether a frame must be rotated by hand: the container says it is turned (90, 180 or 270°) and the decoded frame
 * does not carry that rotation itself (WebKit). 180° was left out before (only 90 and 270 swap the sides), so an
 * iPhone filming landscape the other way up gave the pose model an upside-down person (second audit, 3 October).
 */
export function manualRotationNeeded(containerRotation, frameRotation) {
  if (!containerRotation) return false;
  return !(typeof frameRotation === 'number' && frameRotation !== 0);
}

/** How long the feeding waits, with the main loop waiting too and nothing decoded, before it feeds on (see below). */
const FEED_STALL_MS = 2000;

/**
 * How long a read may go without a frame before it ends, on both paths: the playback path's watchdog (since the last
 * frame callback) and the WebCodecs path's (since the decoder's last frame, see extractFramesWebCodecs). Neither counts
 * the time a sample spends in the analysis. Source: convention, UNSOURCED (the playback path's value since it began).
 */
const STALL_MS = 20000;

const IS_IOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);

// Route the demuxer's FFmpeg log lines to console.info so they don't
// appear as errors. The web-demuxer WASM prints container metadata
// (Duration, Stream, bitrate, codec lines) to stderr, which the browser
// delivers as console.error. These are informational, not failures.
const _originalError = console.error.bind(console);
const _ffmpegLineRe = /^\[?(mov|mp4|m4a|3gp|3g2|mj2|matroska|webm|avi|flv|ogg|hls|mpegts|aac|h264|hevc|vp9|av1)[, @]|^(Input #|Duration:|Stream #|Avi:|frame=|bitrate:)/i;
console.error = (...args) => {
  if (args.length === 1 && typeof args[0] === 'string' && _ffmpegLineRe.test(args[0])) {
    console.info('[demuxer]', args[0]);
  } else {
    _originalError(...args);
  }
};

/**
 * Hash a file for cache keying. Returns first 16 hex chars of SHA-256.
 *
 * On iOS, the photo library transcodes video files (HEVC → H.264) on every
 * file pick, producing slightly different binary content each time. A pure
 * content hash therefore misses the cache on every run, defeating determinism.
 *
 * Strategy: hash file metadata (name + lastModified + size rounded to nearest
 * MB) on iOS. On other platforms, hash the first 2MB of binary content.
 * The metadata hash has a negligible collision risk for a personal video library.
 */
export async function hashFile(file) {
  // Metadata-based hash on all platforms: no file reads, instant.
  // Round size to nearest MB to absorb iOS photo library transcoding variance (~0.1%).
  const sizeMB = Math.round(file.size / (1024 * 1024));
  const metaString = `${file.name}|${file.lastModified}|${sizeMB}MB`;
  const buffer = new TextEncoder().encode(metaString);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * Hash an array of landmark objects for determinism verification.
 * Converts landmarks to a string and hashes with SHA-256.
 * Returns first 16 hex chars.
 */
export async function hashLandmarks(landmarks) {
  // Extract just the x,y,z values (truncated to 6 decimals for stability)
  const data = landmarks.map(frame => {
    if (!frame) return '';
    return frame.map(lm => {
      if (!lm) return '0,0,0';
      return `${(lm.x || 0).toFixed(6)},${(lm.y || 0).toFixed(6)},${(lm.z || 0).toFixed(6)}`;
    }).join(';');
  }).join('|');

  const encoder = new TextEncoder();
  const buffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * RVFC-based frame extractor (primary path).
 *
 * Plays the video at an accelerated playback rate and uses
 * requestVideoFrameCallback to capture frames at the target FPS interval.
 * Much faster than seeking because:
 * - No per-frame seek overhead (continuous decode pipeline)
 * - GPU-accelerated video decode
 * - Frame-accurate timing from the callback metadata
 *
 * @param {File} file - Video file
 * @param {number} targetFps - Target frames per second
 * @param {number} maxFrames - Maximum frames to extract
 * @param {number} maxWidth - Maximum frame width
 * @param {function} onFrame - Called with (canvas, frameIndex, timestamp)
 * @param {function} onProgress - Progress callback (0-100)
 * @param {Object} [options] - Additional options
 * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
 * @param {number} [options.startFrame] - Frame index to start from (for resume)
 * @returns {Promise<{width, height, fps, duration, frameCount}>}
 */
export async function extractFramesRVFC(file, targetFps, maxFrames, maxWidth, onFrame, onProgress, options = {}) {
  const { signal, startFrame = 0 } = options;
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  try {
    // Check for early abort
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // Wait for decoder readiness
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Video load timeout (30s)')), 30000);

      const onAbort = () => {
        clearTimeout(timeout);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      video.onloadeddata = () => {
        clearTimeout(timeout);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timeout);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(new Error('Failed to load video'));
      };
      video.src = url;
      video.load();
    });

    const duration = video.duration;
    const nativeWidth = video.videoWidth;
    const nativeHeight = video.videoHeight;

    // Scale by long side, not just width
    let frameWidth = nativeWidth;
    let frameHeight = nativeHeight;
    const longSide = Math.max(frameWidth, frameHeight);
    if (longSide > maxWidth) {
      const scale = maxWidth / longSide;
      frameWidth = Math.round(frameWidth * scale);
      frameHeight = Math.round(frameHeight * scale);
      frameWidth -= frameWidth % 2;
      frameHeight -= frameHeight % 2;
    }

    const canvas = document.createElement('canvas');
    canvas.width = frameWidth;
    canvas.height = frameHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const interval = 1 / targetFps;
    const totalPossibleFrames = Math.floor(duration * targetFps);
    const frameCount = Math.min(totalPossibleFrames, maxFrames);

    // If resuming, seek to the start position
    const startTime = startFrame * interval;
    if (startFrame > 0 && startTime < duration) {
      video.currentTime = startTime;
      await new Promise((resolve) => {
        const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
        video.addEventListener('seeked', onSeeked);
        setTimeout(resolve, 3000); // timeout fallback
      });
    }

    // Play at accelerated rate for faster extraction.
    // iOS HEVC hardware decoder can't sustain 3x on large files -- frames drop
    // and rVFC callbacks fire without new decoded frames, causing stalls.
    // 1.5x is the safe ceiling on iOS; 3x works on desktop Chrome/Firefox.
    // Since 29 September the video also waits while each frame is analysed, and plays at 1x: faster,
    // it can run more than one sampling interval between two frame callbacks and lose samples
    // (test/real-phone/decoder/02-after.txt: every sample read at 1x). Status: unvalidated starting
    // value (RULES L16): measured on a synthetic video in desktop Chromium only, not yet on an iPhone.
    video.playbackRate = 1;

    let extractedCount = startFrame;
    let nextCaptureTime = startTime;
    let lastCapturedTime = -1;

    return await new Promise((resolve, reject) => {
      let resolved = false;

      const cleanup = () => {
        video.pause();
        clearTimeout(stallTimeout);
      };

      // Safety timeout: if no frames arrive within 20 seconds of play(),
      // the video is likely stalled (common on iOS with large files)
      let stallTimeout;
      const resetStallTimeout = () => {
        clearTimeout(stallTimeout);
        stallTimeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            cleanup();
            if (signal) signal.removeEventListener('abort', onAbort);
            if (extractedCount > 0) {
              resolve({
                width: frameWidth, height: frameHeight,
                fps: targetFps, duration, frameCount: extractedCount,
              });
            } else {
              reject(new Error('Video playback stalled — no frames received'));
            }
          }
        }, STALL_MS);
      };

      const onAbort = () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new DOMException('Aborted', 'AbortError'));
        }
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      const onVideoFrame = async (now, metadata) => {
        if (resolved) return;
        resetStallTimeout();

        // Check abort
        if (signal?.aborted) {
          onAbort();
          return;
        }

        const mediaTime = metadata.mediaTime;

        // Check if we've reached the end or frame limit
        if (mediaTime >= duration || extractedCount >= frameCount) {
          if (!resolved) {
            resolved = true;
            cleanup();
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve({
              width: frameWidth,
              height: frameHeight,
              fps: targetFps,
              duration,
              frameCount: extractedCount,
            });
          }
          return;
        }

        // Capture frame if we've passed the next capture time threshold
        if (mediaTime >= nextCaptureTime - 0.001) {
          // Skip duplicate frames (same media time as last capture)
          if (Math.abs(mediaTime - lastCapturedTime) >= 0.01) {
            // The video waits while the frame is analysed, so a slow phone reads every sample
            // instead of letting the video run past them (test/real-phone/decoder: 11 of 90 read before
            // with 150 ms of analysis a frame, 89 of 89 after). Measured in desktop Chromium only.
            // The frame is drawn first, while it is the one this callback presents, and the video is paused after.
            // Paused first, the draw read a paused video, which WebKit may answer with a stale frame: at a demo on
            // David's iPhone on 3 October, possibly in Low Power Mode, a machine lateral raise counted 0 twice while the
            // same video read through WebCodecs gave 460 distinct samples and 8 of 9 (frozen-read incident, 3 October).
            let drawn = false;
            try {
              ctx.drawImage(video, 0, 0, frameWidth, frameHeight);
              video.pause();

              // On the first frame, validate the canvas isn't blank (HEVC canvas taint
              // on some iOS versions produces all-black frames silently)
              if (extractedCount === 0) {
                try {
                  const sample = ctx.getImageData(
                    Math.floor(frameWidth / 4), Math.floor(frameHeight / 4),
                    Math.min(32, frameWidth), Math.min(32, frameHeight)
                  );
                  let nonZero = 0;
                  for (let p = 0; p < sample.data.length; p += 4) {
                    if (sample.data[p] > 0 || sample.data[p + 1] > 0 || sample.data[p + 2] > 0) {
                      nonZero++;
                      if (nonZero >= 3) break; // enough to confirm non-blank
                    }
                  }
                  if (nonZero < 3) {
                    // HEVC canvas taint: drawImage renders black pixels.
                    // Stop immediately — processing hundreds of blank frames is pointless.
                    if (!resolved) {
                      resolved = true;
                      cleanup();
                      if (signal) signal.removeEventListener('abort', onAbort);
                      reject(new Error('BLANK_FRAMES: Video frames are blank (canvas cannot render this codec)'));
                    }
                    return;
                  }
                } catch (e) {
                  // getImageData threw — canvas IS tainted (CORS or codec security)
                  console.error('[frameExtractor] Canvas tainted:', e.message);
                  if (!resolved) {
                    resolved = true;
                    cleanup();
                    if (signal) signal.removeEventListener('abort', onAbort);
                    reject(new Error(`Canvas tainted by video codec (${e.message}). Try converting the video to H.264 MP4.`));
                  }
                  return;
                }
              }

              drawn = true;
            } catch {
              // canvas draw failure, skip frame
            }
            if (drawn) {
              // The watchdog waits for the analysis too: a slow phone is not a stalled video (review 01).
              clearTimeout(stallTimeout);
              // A sample the caller could not analyse (the pose worker failed or timed out) ends the
              // extraction, as on the WebCodecs path: swallowed, it was taken again from a later frame,
              // or, with a dead worker, each frame waited 60 s and the screen hung (third audit, C06).
              try {
                await onFrame(canvas, extractedCount, mediaTime);
              } catch (err) {
                if (!resolved) {
                  resolved = true;
                  cleanup();
                  if (signal) signal.removeEventListener('abort', onAbort);
                  reject(err);
                }
                return;
              }
              if (!resolved) resetStallTimeout();
              extractedCount++;
              lastCapturedTime = mediaTime;

              if (onProgress) {
                onProgress(Math.round((extractedCount / frameCount) * 100));
              }
            }
          }

          // Advance to next capture point
          nextCaptureTime = (extractedCount) * interval;
        }

        // Register next callback, then let the video run again if it waited.
        video.requestVideoFrameCallback(onVideoFrame);
        if (!resolved && video.paused && !video.ended) {
          video.play().catch((err) => {
            // A pause() of the next sample interrupts this play() with an AbortError: not a failure,
            // the next sample plays again (review 01). A cancel comes through the signal.
            if (err?.name === 'AbortError' && !signal?.aborted) return;
            if (!resolved) {
              resolved = true;
              cleanup();
              if (signal) signal.removeEventListener('abort', onAbort);
              reject(err);
            }
          });
        }
      };

      // Handle video ending
      video.onended = () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve({
            width: frameWidth,
            height: frameHeight,
            fps: targetFps,
            duration,
            frameCount: extractedCount,
          });
        }
      };

      video.onerror = () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(new Error('Video playback error during extraction'));
        }
      };

      // Start frame capture loop and play
      video.requestVideoFrameCallback(onVideoFrame);
      resetStallTimeout(); // Start the stall watchdog
      video.play().catch((err) => {
        if (err?.name === 'AbortError' && !signal?.aborted) return; // interrupted by the first sample's pause
        if (!resolved) {
          resolved = true;
          cleanup();
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      });
    });
  } finally {
    URL.revokeObjectURL(url);
    video.pause();
    video.src = '';
    video.load();
  }
}

/**
 * WebCodecs-based frame extractor.
 *
 * Decodes video frames directly via the browser's hardware VideoDecoder,
 * completely bypassing the <video> element and canvas.drawImage() pipeline.
 * This eliminates HEVC canvas taint on iOS Safari — the root cause of
 * all-black frames when drawing HEVC video to canvas.
 *
 * Pipeline: File → web-demuxer (WASM) → VideoDecoder (hardware) → VideoFrame → canvas
 *
 * Requires: Safari 16.4+ or Chrome 94+ (VideoDecoder API)
 * WASM: web-demuxer-mini.wasm (~500KB, supports MOV/MP4/MKV/WebM)
 */
export async function extractFramesWebCodecs(file, targetFps, maxFrames, maxWidth, onFrame, onProgress, options = {}) {
  const { signal, startFrame = 0 } = options;
  const { WebDemuxer, AVLogLevel } = await import('web-demuxer');

  const wasmUrl = new URL('web-demuxer.wasm', new URL(import.meta.env.BASE_URL || '/', location.origin)).href;
  const demuxer = new WebDemuxer({ wasmFilePath: wasmUrl });
  // Set once the decoder exists: releases it on every exit, an error or a cancel as much as the end (audit
  // FINDING-006: only the normal path closed the decoder and the queued frames).
  let release = () => {};
  // The extraction canvas, emptied when the pass ends (its backing store is otherwise held until collected).
  let canvas = null;

  try {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    await demuxer.load(file);
    if (AVLogLevel?.AV_LOG_ERROR !== undefined) {
      await demuxer.setLogLevel(AVLogLevel.AV_LOG_ERROR);
    }
    const mediaInfo = await demuxer.getMediaInfo();
    const videoStream = mediaInfo.streams.find(s => s.codec_type_string === 'video');
    if (!videoStream) throw new Error('No video track found in file');

    const duration = mediaInfo.duration;
    const rotation = videoStream.rotation || 0;
    let srcWidth = videoStream.width;
    let srcHeight = videoStream.height;
    // Apply rotation to get display dimensions
    const swapDims = (Math.abs(rotation) === 90 || Math.abs(rotation) === 270);
    let displayWidth = swapDims ? srcHeight : srcWidth;
    let displayHeight = swapDims ? srcWidth : srcHeight;

    // Scale by long side, not just width
    let frameWidth = displayWidth;
    let frameHeight = displayHeight;
    const longSide = Math.max(frameWidth, frameHeight);
    if (longSide > maxWidth) {
      const scale = maxWidth / longSide;
      frameWidth = Math.round(frameWidth * scale);
      frameHeight = Math.round(frameHeight * scale);
      frameWidth -= frameWidth % 2;
      frameHeight -= frameHeight % 2;
    }

    canvas = document.createElement('canvas');
    canvas.width = frameWidth;
    canvas.height = frameHeight;
    const ctx = canvas.getContext('2d');

    // Get decoder config from demuxer
    const decoderConfig = await demuxer.getDecoderConfig('video');
    // The source as demuxed, for the crash log (options.onSource): which codec, picture size and rotation was read,
    // before WebCodecs says whether it can decode it (a codec it refuses goes on to the playback path).
    options.onSource?.({ codec: decoderConfig.codec || null, width: srcWidth, height: srcHeight, rotation, duration });
    const support = await VideoDecoder.isConfigSupported(decoderConfig);
    if (!support.supported) {
      throw new Error(`Codec not supported by WebCodecs: ${decoderConfig.codec}`);
    }

    const interval = 1 / targetFps;
    const totalPossibleFrames = Math.floor(duration * targetFps);
    const frameCount = Math.min(totalPossibleFrames, maxFrames);
    let extractedCount = startFrame;
    // The grid starts at the video's first frame, not at 0 s: a trimmed or edited file whose first frame comes later
    // otherwise gave every frame until the grid caught up, and the samples ran out before the video's end
    // (second audit, 3 October). Set at the first frame sampled when sampling starts at the beginning.
    let origin = startFrame === 0 ? null : (options.origin ?? 0);
    // A restart (withRestarts) goes on from the grid's origin plus the samples already read: from startFrame / 15 s it
    // went back in time on a video whose first frame is not at 0 s (review of 10 October 2026).
    let nextCaptureTime = (origin ?? 0) + startFrame * interval;
    // The time of the last sample handed on before a restart (the error's `resume.after`): a frame at or before it is
    // never handed on again. On a video under 15 pictures a second, or with a hole, the samples run ahead of the grid,
    // so origin + startFrame / 15 s can lie before the last sample, and the restart went back in time (re-review of
    // 10 October 2026: 10 a second, samples ..., 1.8, 1.9, 1.4, 1.5).
    const after = startFrame === 0 ? null : (options.after ?? null);
    let lastHanded = after;
    const handedAlready = t => after !== null && t <= after + 1e-6;

    // Frame queue: decoder output pushes, main loop pulls.
    // Every decoded VideoFrame is a full-size picture held by the decoder's pool (a 4K HDR 10-bit frame is about
    // 25 MB): an iPhone that holds a dozen at once can be killed for memory while it reads a gallery video (crash at
    // the demo of 7 October; 10 to 12 frames open at once were measured in Chromium). So a frame that will never be
    // sampled is closed the moment it arrives, the next sample time is known before the pose model runs, and the
    // feeding pauses while one frame waits. Measured: 12 -> 5 frames open at most (360p30) and 10-11 -> 5 (4K60),
    // the same samples and landmarks, the same time. Source: crash investigation of 7 October. Status: validated
    // (Chromium, synthetic VP8 clips; not yet on an iPhone).
    const frameQueue = [];
    let decodeComplete = false;
    let decodeError = null;
    let wakeMain = null;
    let peakOpenFrames = 0;
    // Bumped on every decoded frame and every sample handed on: the feeding's watch for a decoder that needs more
    // input before it gives a frame (an HEVC stream that reorders its frames), see the feeding below.
    let progress = 0;
    let feedStalls = 0;
    // Stall watchdog, as on the playback path (11 October 2026): a decoder that takes chunks and then gives neither a
    // frame nor an error left the main loop waiting for a frame until the user cancelled. While the main loop waits
    // for a frame that is still owed, STALL_MS with no decoded frame ends the pass as a decoder failure ends it (the
    // error with `resume`, which withRestarts restarts and after which the playback path takes over; release() frees
    // the frames and the decoder). Counted from the latest of: the decoder's last frame, the last chunk fed while the
    // decoder's queue was empty, the start of the main loop's wait; never from the start of the read, and never
    // during a sample's analysis (onFrame), so a slow phone is not a stalled decoder.
    // Budget and rule: convention, mirrors the playback watchdog (STALL_MS). Safari's VideoDecoder going silent without
    // calling its error callback: UNSOURCED (never seen on our clips; the WebCodecs spec sets no timeout on a decoder
    // that stops giving output; a research note relayed on 11 October 2026 cites w3c/webcodecs discussion #680 and
    // issue #698, not checked by us).
    let stallTimer = null;
    const watchStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stallTimer = null;
        if (!wakeMain || decodeError || decodeComplete) return;
        decodeError = new Error(`decoder stalled, no frame for ${STALL_MS / 1000} s`);
        wakeMain(); wakeMain = null;
      }, STALL_MS);
    };

    const decoder = new VideoDecoder({
      output: (frame) => {
        progress++;
        watchStall();
        const timestamp = frame.timestamp / 1_000_000;
        // Once the sampling grid has started, a frame before the next capture time is never sampled: closed at once.
        // Before the grid starts (origin null), the first frame sets it and is kept.
        if ((origin !== null && timestamp < nextCaptureTime - 0.001) || handedAlready(timestamp)) {
          frame.close();
          return;
        }
        frameQueue.push(frame);
        if (frameQueue.length > peakOpenFrames) peakOpenFrames = frameQueue.length;
        if (wakeMain) { wakeMain(); wakeMain = null; }
      },
      error: (e) => {
        decodeError = e;
        if (wakeMain) { wakeMain(); wakeMain = null; }
      },
    });
    decoder.configure(decoderConfig);
    // A cancel wakes the main loop at once, which then throws its AbortError (a wait for a frame had no way out).
    const onAbort = () => { if (wakeMain) { wakeMain(); wakeMain = null; } };
    signal?.addEventListener('abort', onAbort, { once: true });
    release = () => {
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(stallTimer);
      while (frameQueue.length > 0) frameQueue.shift().close();
      try { decoder.close(); } catch {}
    };

    // Feed encoded chunks from demuxer stream (runs concurrently)
    const feedPromise = (async () => {
      const stream = demuxer.read('video', (origin ?? 0) + startFrame * interval);
      const reader = stream.getReader();
      // Back-pressure: feeding pauses while more than one frame waits or the decoder holds more than two chunks.
      // A decoder that reorders frames (HEVC with B-frames) may need more chunks before it gives the frame the main
      // loop waits for: if the main loop has been waiting with nothing decoded for FEED_STALL_MS, feeding goes on
      // under the earlier, looser limits for the rest of the pass, and the stall is recorded (feedStalls).
      // Limits 1 and 2: measured (crash investigation, 7 October: 5 frames open at most, same speed; 0 and 0 gave 2
      // frames but 10 % slower). 2 s and the looser limits 2 and 8 (the earlier code): convention, UNSOURCED.
      let maxQueued = 1, maxDecoding = 2;
      try {
        while (true) {
          if (signal?.aborted || extractedCount >= frameCount) break;
          const { done, value } = await reader.read();
          if (done) break;
          const idle = decoder.decodeQueueSize === 0;
          decoder.decode(value);
          if (idle) watchStall();
          let seen = progress, since = performance.now();
          while ((frameQueue.length > maxQueued || decoder.decodeQueueSize > maxDecoding) && !signal?.aborted) {
            if (progress !== seen) { seen = progress; since = performance.now(); }
            else if (wakeMain && performance.now() - since > FEED_STALL_MS) { feedStalls++; maxQueued = 2; maxDecoding = 8; break; }
            await new Promise(r => setTimeout(r, 0));
          }
        }
        await decoder.flush();
      } catch (e) {
        if (!decodeError) decodeError = e;
      } finally {
        decodeComplete = true;
        if (wakeMain) { wakeMain(); wakeMain = null; }
        try { reader.releaseLock(); } catch {}
      }
    })();

    // Process decoded frames in main loop
    const waitForFrame = () => new Promise(r => { wakeMain = r; watchStall(); });

    // Drawing helper with runtime rotation detection.
    // Chromium's drawImage auto-applies VideoFrame rotation; WebKit does not.
    // We detect on the first frame: draw at coded aspect, check if the result
    // matches display aspect ratio (auto-rotated) or coded aspect (needs manual).
    let needsManualRotation = null;
    let rotationDecision = '';

    function probeAutoRotation(frame) {
      // The VideoFrame carries its own rotation metadata when the browser's
      // VideoDecoder processes the container's rotation. Chrome sets
      // frame.rotation (e.g. 90) and swaps display dimensions to portrait;
      // its drawImage auto-applies the rotation. WebKit ignores container
      // rotation: frame.rotation is absent, display dimensions stay at
      // coded (landscape), and drawImage draws coded pixels as-is.
      //
      // Decision: if frame.rotation is a non-zero number, the decoder
      // embedded the rotation and drawImage will handle it. Otherwise,
      // we rotate by hand using the container rotation from web-demuxer.
      const frameRotation = frame.rotation;
      const frameCarriesRotation = !manualRotationNeeded(rotation, frameRotation);
      rotationDecision = frameCarriesRotation
        ? `frame carries rotation=${frameRotation}, drawImage handles it`
        : `frame has no rotation (rotation=${frameRotation}), manual rotation=${rotation}° from container`;
      console.log(`[frameExtractor] Rotation decision: ${rotationDecision}`);
      return !frameCarriesRotation;
    }

    const drawFrame = (frame) => {
      if (rotation === 0) {
        ctx.drawImage(frame, 0, 0, frameWidth, frameHeight);
        return;
      }
      if (needsManualRotation === null) {
        needsManualRotation = probeAutoRotation(frame);
        console.log(`[frameExtractor] Rotation ${rotation}°, manual rotation: ${needsManualRotation}`);
      }
      if (!needsManualRotation) {
        ctx.drawImage(frame, 0, 0, frameWidth, frameHeight);
      } else {
        ctx.save();
        ctx.translate(frameWidth / 2, frameHeight / 2);
        ctx.rotate((rotation * Math.PI) / 180);
        const dw = swapDims ? frameHeight : frameWidth;
        const dh = swapDims ? frameWidth : frameHeight;
        ctx.drawImage(frame, -dw / 2, -dh / 2, dw, dh);
        ctx.restore();
      }
    };

    while (extractedCount < frameCount) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const failed = () => {
        const e = new Error(`Video decode failed: ${decodeError.message}`);
        e.resume = { startFrame: extractedCount, origin, after: lastHanded };
        return e;
      };
      if (decodeError) throw failed();

      // Wait for frames if queue is empty
      while (frameQueue.length === 0 && !decodeComplete && !decodeError && !signal?.aborted) {
        await waitForFrame();
      }
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      // A decoder that failed while this loop waited ends the pass as a failure to restart from here, never as a read
      // that simply stopped early (re-review of 10 October 2026: Safari reports the failure through the error callback
      // after decode() returns, so the wait ended with nothing queued and the read resolved with 10 of 45 samples).
      if (frameQueue.length === 0) { if (decodeError) throw failed(); break; }

      // Drain queued frames
      while (frameQueue.length > 0 && extractedCount < frameCount) {
        const frame = frameQueue.shift();
        const timestamp = frame.timestamp / 1_000_000; // microseconds → seconds

        if (origin === null) { origin = timestamp; nextCaptureTime = origin; }
        if (timestamp >= nextCaptureTime - 0.001 && !handedAlready(timestamp)) {
          try { drawFrame(frame); } finally { frame.close(); }
          lastHanded = timestamp;
          // The next sample time is set before the pose model runs, so the frames decoded meanwhile that will
          // never be sampled are closed as they arrive rather than queued.
          nextCaptureTime = origin + (extractedCount + 1) * interval;
          progress++;
          await onFrame(canvas, extractedCount, timestamp);
          extractedCount++;
          if (onProgress) onProgress(Math.round((extractedCount / frameCount) * 100));
        } else {
          frame.close();
        }
      }
    }

    // Discard any remaining queued frames, close the decoder, and let the feeding end.
    release();
    await feedPromise;

    return { width: frameWidth, height: frameHeight, fps: targetFps, duration, frameCount: extractedCount, peakOpenFrames, feedStalls, rotationDecision };
  } finally {
    release();
    demuxer.destroy();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

/** A decoding path that handed on the same picture again and again (isFrozenRead): never counted. */
export class FrozenReadError extends Error {
  constructor({ samples, repeats }, decoder) {
    super(`frozen read: ${repeats} of ${samples} samples repeat the one before`);
    this.name = 'FrozenReadError'; this.samples = samples; this.repeats = repeats; this.decoder = decoder;
  }
}

/**
 * Inspect a video file to determine its codec without decoding.
 * Reads container metadata via web-demuxer (fast, no frame decode).
 * Returns null if inspection fails (non-video file, unsupported container).
 */
async function inspectVideo(file) {
  try {
    const { WebDemuxer, AVLogLevel } = await import('web-demuxer');
    const wasmUrl = new URL('web-demuxer.wasm', new URL(import.meta.env.BASE_URL || '/', location.origin)).href;
    const demuxer = new WebDemuxer({ wasmFilePath: wasmUrl });
    try {
      await demuxer.load(file);
      if (AVLogLevel?.AV_LOG_ERROR !== undefined) {
        await demuxer.setLogLevel(AVLogLevel.AV_LOG_ERROR);
      }
      const info = await demuxer.getMediaInfo();
      const video = info.streams.find(s => s.codec_type_string === 'video');
      if (!video) return null;
      return {
        codec: video.codec_name,
        codecString: video.codec_string,
        width: video.width,
        height: video.height,
        rotation: video.rotation || 0,
        duration: info.duration,
      };
    } finally {
      demuxer.destroy();
    }
  } catch (e) {
    console.error('[frameExtractor] inspectVideo failed:', e?.message || String(e));
    return null;
  }
}

/**
 * Is this codec HEVC? (multiple naming conventions)
 */
function isHEVC(codec) {
  if (!codec) return false;
  const c = codec.toLowerCase();
  return c === 'hevc' || c === 'h265' || c === 'hev1' || c === 'hvc1' || c.startsWith('hev1.') || c.startsWith('hvc1.');
}

/**
 * A decoder that fails part-way (Safari's "Decoder failure", David's iPhone, 4 October: after 10 samples) is replaced
 * by a fresh one that goes on from the sample where it stopped (the error's `resume`: next sample, grid origin), up to
 * `max` times, before the caller turns to the playback path, which read only 56 % of that video. Samples already
 * handed on are kept. A restart that makes no progress, a cancel, or an error of the caller's own analysis ends it.
 * max: convention (no source for a number of retries).
 */
export async function withRestarts(run, options = {}, max = 3) {
  let pass = { ...options }, restarts = 0;
  for (;;) {
    try {
      return { result: await run(pass), restarts };
    } catch (err) {
      const at = err?.resume;
      const stuck = restarts > 0 && at && at.startFrame <= (pass.startFrame ?? 0);
      if (!at || err.name === 'AbortError' || err.fromOnFrame || restarts >= max || stuck) throw err;
      restarts++;
      console.warn(`[frameExtractor] WebCodecs failed at sample ${at.startFrame} (${err.message}); restart ${restarts}`);
      pass = { ...options, startFrame: at.startFrame, origin: at.origin, after: at.after ?? null };
    }
  }
}

/**
 * Streaming frame extractor — inspect first, then use the right decoder.
 *
 * Approach: read the file's codec from container metadata, then route
 * to the correct extraction method. No cascading try/catch fallbacks.
 *
 * - HEVC (iPhone default) → WebCodecs VideoDecoder (hardware-accelerated,
 *   bypasses <video> element, no canvas taint)
 * - H.264 / other → RVFC playback (fastest) or seek (legacy fallback)
 *
 * @param {File} file - Video file
 * @param {number} targetFps - Target frames per second
 * @param {number} maxFrames - Maximum frames to extract
 * @param {number} maxWidth - Maximum frame width
 * @param {function} onFrame - Called with (canvas, frameIndex, timestamp, pixels): pixels is the canvas's ImageData,
 *   read once for the frozen-read fingerprint, or null when it could not be read; the callback may transfer its buffer
 * @param {function} onProgress - Progress callback (0-100)
 * @param {Object} [options] - Additional options
 * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
 * @param {number} [options.startFrame] - Frame index to start from (for resume)
 * @param {boolean} [options.deterministic] - Hint for logging; does not change decoder selection
 * @param {'frozen'} [options.inject] - The check page's test hook only: a synthetic frozen stream on the playback path
 * @returns {Promise<{width, height, fps, duration, frameCount, method: string, peakOpenFrames?: number, repeats: {samples: number, repeats: number}, fallback: string | null}>}
 */
export async function extractFramesStreaming(file, targetFps, maxFrames, maxWidth, onFrame, onProgress, options = {}) {
  const errors = [];

  // How many samples each path handed on: a path that fails part-way leaves its samples behind, and
  // the method then names both (review 01 of the decoder fix).
  let handed = 0;
  // An error of the caller's own analysis (onFrame) is not a decoder failure: it ends the extraction
  // instead of starting the video again on the next decoder with the same failing worker (third audit, C06).
  // Each path's samples are fingerprinted as they are handed on, and a frozen read is a decoder failure: the
  // other path is tried, and if none reads a moving video, nothing is counted (frozen-read incident, 3 October).
  let repeats = repeatCounter();
  const frozenCheck = (name) => {
    if (isFrozenRead(repeats.read)) throw new FrozenReadError(repeats.read, name);
  };
  // The sample's pixels are read once (a GPU readback of the whole picture on a phone) and handed on with the canvas:
  // the fingerprint and the caller's pose model use the same copy (crash investigation, 7 October, cause 2: two
  // readbacks per sample). The caller may transfer the buffer away, so the fingerprint is taken first. Null when the
  // canvas cannot be read; the caller then reads it itself, as before.
  const counted = async (canvas, index, timestamp) => {
    handed++;
    const pixels = canvasPixels(canvas);
    repeats.add(pixelsFingerprint(pixels));
    try {
      return await onFrame(canvas, index, timestamp, pixels);
    } catch (err) {
      if (err && typeof err === 'object') err.fromOnFrame = true;
      throw err;
    }
  };
  let before = '';
  // Why the playback path ran, when it did (the check page shows it per row, WP0.2): the first entry of `errors`.
  // The last frozen read seen, if any, is carried on the final error, so a page can tell a frozen refusal apart.
  let frozen = null;

  // Step 1: Try WebCodecs (sequential, deterministic, handles rotation). The check page can skip it
  // (options.path === 'rvfc') to test the playback path on a phone where WebCodecs works.
  if (options.path === 'rvfc') {
    errors.push('WebCodecs: skipped, playback path forced');
  } else if (typeof VideoDecoder !== 'undefined') {
    // The path about to read, for the crash log (options.onPath; the read itself is unchanged).
    options.onPath?.('webcodecs');
    try {
      const { result, restarts } = await withRestarts(pass => extractFramesWebCodecs(file, targetFps, maxFrames, maxWidth, counted, onProgress, pass), options);
      frozenCheck('webcodecs');
      return { ...result, method: restarts ? `webcodecs, restarted ${restarts}\u00D7` : 'webcodecs', repeats: { ...repeats.read }, fallback: null };
    } catch (err) {
      if (err.name === 'AbortError' || err.fromOnFrame) throw err;
      if (err.name === 'FrozenReadError') frozen = { samples: err.samples, repeats: err.repeats, decoder: err.decoder };
      console.error('[frameExtractor] WebCodecs failed:', err?.message || String(err));
      errors.push(`WebCodecs: ${err?.message || String(err)}`);
      before = `webcodecs failed after ${handed} samples (${err?.message || String(err)}), then `;
    }
  } else {
    errors.push('WebCodecs: VideoDecoder API not available');
  }

  // Step 2: Try RVFC (playback-based, works on older browsers)
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    repeats = repeatCounter();
    options.onPath?.('rvfc');
    try {
      // The check page's test hook only (check.html?inject=frozen, WP0.2 of docs/SPEC-production.md): every sample
      // of the playback path after the first is handed on as the first, as a decoder stuck on one picture would, so
      // the frozen-read guard is seen firing on the phone. The app itself never passes `inject`.
      const onFrame = options.inject === 'frozen' ? frozenStream(counted) : counted;
      const result = await extractFramesRVFC(file, targetFps, maxFrames, maxWidth, onFrame, onProgress, options);
      frozenCheck('rvfc');
      return { ...result, method: `${before}rvfc`, repeats: { ...repeats.read }, fallback: errors[0] ?? null };
    } catch (err) {
      if (err.name === 'AbortError' || err.fromOnFrame) throw err;
      if (err.name === 'FrozenReadError') frozen = { samples: err.samples, repeats: err.repeats, decoder: err.decoder };
      console.error('[frameExtractor] RVFC failed:', err?.message || String(err));
      errors.push(`RVFC: ${err?.message || String(err)}`);
    }
  } else {
    errors.push('RVFC: requestVideoFrameCallback not available');
  }

  // No fallback to seek. Fail with reasons.
  const failure = new Error(
    `Video extraction failed. No decoder could process this file.\n` +
    errors.map(e => `  - ${e}`).join('\n')
  );
  if (frozen) failure.frozen = frozen;
  throw failure;
}

/**
 * A synthetic frozen stream (check page test hook only): the first sample is kept, and every later one is handed on
 * as that same picture. A new pass (sample 0 again) keeps its own first sample.
 */
export function frozenStream(onFrame, makeCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h })) {
  let held = null;
  return (canvas, index, timestamp) => {
    if (!held || index === 0) {
      held = makeCanvas(canvas.width, canvas.height);
      held.getContext('2d').drawImage(canvas, 0, 0);
    }
    return onFrame(held, index, timestamp);
  };
}
