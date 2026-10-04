// Deterministic noise + random utilities. Everything here must be reproducible across the main thread,
// the render worker and export so that previews and final renders are bit-identical.

/** Fast 32-bit integer hash (lowbias32). */
export function hash32(x: number): number {
  x |= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return hash32(h);
}

/** mulberry32 seeded PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

function grad1(h: number, x: number): number {
  const g = (h & 15) / 7.5 - 1; // [-1, 1]
  return g * x;
}

/** 1D gradient noise in roughly [-1, 1]. */
export function noise1(x: number, seed = 0): number {
  const i0 = Math.floor(x);
  const f = x - i0;
  const g0 = grad1(hash32(i0 * 374761393 + seed * 668265263), f);
  const g1 = grad1(hash32((i0 + 1) * 374761393 + seed * 668265263), f - 1);
  return (g0 + (g1 - g0) * fade(f)) * 1.9;
}

function grad2(h: number, x: number, y: number): number {
  const a = ((h & 255) / 256) * Math.PI * 2;
  return Math.cos(a) * x + Math.sin(a) * y;
}

/** 2D gradient noise in roughly [-1, 1]. */
export function noise2(x: number, y: number, seed = 0): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const h = (i: number, j: number) => hash32(i * 374761393 + j * 668265263 + seed * 2147483647);
  const n00 = grad2(h(ix, iy), fx, fy);
  const n10 = grad2(h(ix + 1, iy), fx - 1, fy);
  const n01 = grad2(h(ix, iy + 1), fx, fy - 1);
  const n11 = grad2(h(ix + 1, iy + 1), fx - 1, fy - 1);
  const u = fade(fx), v = fade(fy);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * v) * 1.414;
}

/** Fractal (fBm) 1D noise used by wiggle() and wiggly selectors. */
export function fbm1(x: number, seed: number, octaves = 1, ampMult = 0.5): number {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  const oct = Math.max(1, Math.min(10, Math.floor(octaves)));
  for (let o = 0; o < oct; o++) {
    sum += noise1(x * freq, seed + o * 131) * amp;
    norm += amp;
    amp *= ampMult;
    freq *= 2;
  }
  return sum / (norm || 1);
}

/**
 * AE-style wiggle: returns a per-dimension offset in [-amp, amp].
 * `dim` decorrelates the dimensions.
 */
export function wiggleValue(seed: number, time: number, freq: number, amp: number, octaves = 1, ampMult = 0.5, dim = 0): number {
  return fbm1(time * freq, seed + dim * 7919, octaves, ampMult) * amp;
}
