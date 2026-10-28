// Frozen reads: a decoding path that hands on the same picture again and again (frozen-read incident, 3 October).
// Shared by the extractor (frameExtractor.js, on the pictures) and the count (coreAnalysis.js, on the skeletons).

/**
 * A fingerprint of one drawn sample: a 32-bit FNV-1a hash of the colour of every seventh pixel of its RGBA data.
 * Every seventh, not a small grid, so each 16x16 block of a compressed frame holds dozens of the pixels read: a block
 * the encoder left unchanged in a still moment cannot make two different frames look alike (frozen-read incident,
 * 3 October). Two equal fingerprints mean the same picture, to one chance in four billion.
 */
export function frameFingerprint(data, step = 7) {
  let h = 0x811c9dc5;
  for (let i = 0; i + 2 < data.length; i += 4 * step) {
    h = Math.imul(h ^ data[i], 0x01000193);
    h = Math.imul(h ^ data[i + 1], 0x01000193);
    h = Math.imul(h ^ data[i + 2], 0x01000193);
  }
  return h >>> 0;
}

/** The pixels a canvas holds (ImageData), or null when it cannot be read. */
export function canvasPixels(canvas) {
  try {
    return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
}

/** The fingerprint of pixels read by canvasPixels, or null for none (a null is never taken for a repeat). */
export const pixelsFingerprint = image => (image ? frameFingerprint(image.data) : null);

/** The fingerprint of what a canvas holds, or null when it cannot be read (a null is never taken for a repeat). */
export function canvasFingerprint(canvas) {
  return pixelsFingerprint(canvasPixels(canvas));
}

// A frozen read: the decoder handed the same picture again and again, so the pose stood still and the count was a
// confident 0 (David's iPhone, demo of 3 October, machine lateral raise, twice). A filmed video practically never
// repeats a frame exactly: the healthy read of that same video through WebCodecs gave 0 identical skeletons in 460
// samples, David's 14 real-phone sets 0 each, and the 894 public build sets (Countix, YouTube) at most 8 of 150 (5 %).
// Synthetic renders do repeat, since a rendered body at rest is pixel-still: 17 to 27 % of the skeletons of the 96
// synthetic sets (test/real-phone/synth/sets), and 8, 11 and 20 % of the decoded pictures of the three synthetic videos
// the CI journey runs through the app (lateral raise, curl, chair stand; ffmpeg framemd5 at 15 samples a second). So
// the share is above all of these: more than half the samples repeating the one before. A first guess of 10 % would
// have refused the curl and chair-stand journeys. A read frozen on less than half its samples is not caught.
// Source: this incident, the healthy read and the measures above. Status: experimental. The share and the minimum
// number of samples are UNSOURCED.
export const FROZEN_SHARE = 0.5;
export const FROZEN_MIN_SAMPLES = 30;

/**
 * Whether a read is frozen: at least FROZEN_MIN_SAMPLES samples, of which more than FROZEN_SHARE repeat the sample
 * before them exactly. `repeats` counts samples equal to the previous one, so at most samples - 1.
 */
export function isFrozenRead({ samples, repeats }) {
  return samples >= FROZEN_MIN_SAMPLES && repeats / (samples - 1) > FROZEN_SHARE;
}

/** Counts, sample by sample, those that repeat the one before (fingerprints from canvasFingerprint). */
export function repeatCounter() {
  let last = null;
  const read = { samples: 0, repeats: 0 };
  return {
    read,
    add(print) {
      if (print !== null && print === last) read.repeats++;
      last = print;
      read.samples++;
    },
  };
}
