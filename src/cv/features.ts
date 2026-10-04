// ─────────────────────────────────────────────────────────────────────────────
// Corner detectors: FAST-9 segment test for candidate generation and the
// Shi–Tomasi minimum-eigenvalue response ("good features to track") for
// ranking. The camera tracker combines both: FAST proposes, Shi–Tomasi scores,
// a spatial grid enforces even coverage and a minimum distance between points.
// ─────────────────────────────────────────────────────────────────────────────

import { gradients, type Gray } from './image';

export interface Corner {
  x: number;
  y: number;
  score: number;
}

export interface DetectOptions {
  maxCorners: number;
  /** minimum distance between accepted corners (pixels) */
  minDistance: number;
  /** relative threshold on the best Shi–Tomasi response (0..1) */
  quality?: number;
  /** half-size of the structure-tensor window */
  blockRadius?: number;
  /** keep away from the image border (pixels) */
  border?: number;
  /** accept only points for which this returns true */
  mask?: (x: number, y: number) => boolean;
  /** existing points: new corners must keep `minDistance` from them */
  avoid?: ArrayLike<number>;
  method?: 'shi-tomasi' | 'fast';
  fastThreshold?: number;
}

/** Shi–Tomasi response map: smallest eigenvalue of the windowed structure tensor. */
export function minEigenMap(img: Gray, blockRadius = 2): Float32Array {
  const { w, h } = img;
  const { gx, gy } = gradients(img);
  const xx = new Float32Array(w * h), xy = new Float32Array(w * h), yy = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    xx[i] = gx[i] * gx[i];
    xy[i] = gx[i] * gy[i];
    yy[i] = gy[i] * gy[i];
  }
  const bx = boxFilter(xx, w, h, blockRadius), bxy = boxFilter(xy, w, h, blockRadius), by = boxFilter(yy, w, h, blockRadius);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = bx[i], b = bxy[i], c = by[i];
    const t = (a - c) / 2;
    out[i] = (a + c) / 2 - Math.sqrt(t * t + b * b);
  }
  return out;
}

function boxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// Bresenham circle of radius 3 used by FAST.
const CIRCLE: [number, number][] = [
  [0, -3], [1, -3], [2, -2], [3, -1], [3, 0], [3, 1], [2, 2], [1, 3],
  [0, 3], [-1, 3], [-2, 2], [-3, 1], [-3, 0], [-3, -1], [-2, -2], [-1, -3],
];

/** FAST-9 corner candidates with a sum-of-absolute-differences score (before non-max suppression). */
export function fastCorners(img: Gray, threshold = 18, border = 4): Corner[] {
  const { w, h, data } = img;
  const offs = CIRCLE.map(([dx, dy]) => dy * w + dx);
  const scores = new Float32Array(w * h);
  const b = Math.max(3, border);
  for (let y = b; y < h - b; y++) {
    for (let x = b; x < w - b; x++) {
      const i = y * w + x;
      const p = data[i];
      const hi = p + threshold, lo = p - threshold;
      // quick rejection with the four compass points: a 9-arc needs at least 2 of them
      const c0 = data[i + offs[0]], c4 = data[i + offs[4]], c8 = data[i + offs[8]], c12 = data[i + offs[12]];
      let nb = 0, nd = 0;
      if (c0 > hi) nb++; else if (c0 < lo) nd++;
      if (c4 > hi) nb++; else if (c4 < lo) nd++;
      if (c8 > hi) nb++; else if (c8 < lo) nd++;
      if (c12 > hi) nb++; else if (c12 < lo) nd++;
      if (nb < 2 && nd < 2) continue;
      let best = 0;
      for (const sign of [1, -1]) {
        let run = 0, maxRun = 0;
        for (let k = 0; k < 25; k++) {
          const v = data[i + offs[k & 15]];
          const pass = sign > 0 ? v > hi : v < lo;
          run = pass ? run + 1 : 0;
          if (run > maxRun) maxRun = run;
        }
        if (maxRun >= 9) {
          let s = 0;
          for (let k = 0; k < 16; k++) {
            const d = (data[i + offs[k]] - p) * sign - threshold;
            if (d > 0) s += d;
          }
          best = Math.max(best, s);
        }
      }
      if (best > 0) scores[i] = best;
    }
  }
  const out: Corner[] = [];
  for (let y = b; y < h - b; y++) {
    for (let x = b; x < w - b; x++) {
      const i = y * w + x, s = scores[i];
      if (s <= 0) continue;
      if (s < scores[i - 1] || s < scores[i + 1] || s < scores[i - w] || s < scores[i + w] ||
        s < scores[i - w - 1] || s < scores[i - w + 1] || s < scores[i + w - 1] || s < scores[i + w + 1]) continue;
      out.push({ x, y, score: s });
    }
  }
  return out;
}

/**
 * Detect well-distributed trackable corners. With method 'fast', FAST-9 proposes candidates that
 * are then re-scored by the Shi–Tomasi response; otherwise every local maximum of the response is
 * a candidate. Corners are accepted strongest-first subject to `minDistance`.
 */
export function detectCorners(img: Gray, o: DetectOptions): Corner[] {
  const { w, h } = img;
  const border = o.border ?? 8;
  const resp = minEigenMap(img, o.blockRadius ?? 2);
  let cands: Corner[] = [];
  let maxR = 0;
  for (let i = 0; i < resp.length; i++) if (resp[i] > maxR) maxR = resp[i];
  if (maxR <= 0) return [];
  const thr = maxR * (o.quality ?? 0.01);
  if (o.method === 'fast') {
    for (const c of fastCorners(img, o.fastThreshold ?? 16, border)) {
      const r = resp[c.y * w + c.x];
      if (r >= thr) cands.push({ x: c.x, y: c.y, score: r });
    }
    // low-contrast footage: fall back to pure Shi–Tomasi candidates
    if (cands.length < o.maxCorners / 4) cands = [];
  }
  if (!cands.length) {
    for (let y = border; y < h - border; y++) {
      for (let x = border; x < w - border; x++) {
        const i = y * w + x, r = resp[i];
        if (r < thr) continue;
        if (r < resp[i - 1] || r < resp[i + 1] || r < resp[i - w] || r < resp[i + w] ||
          r < resp[i - w - 1] || r < resp[i - w + 1] || r < resp[i + w - 1] || r < resp[i + w + 1]) continue;
        cands.push({ x, y, score: r });
      }
    }
  }
  if (o.mask) cands = cands.filter((c) => o.mask!(c.x, c.y));
  cands.sort((a, b) => b.score - a.score);
  // grid-accelerated minimum-distance selection
  const md = Math.max(1, o.minDistance);
  const cell = md;
  const gw = Math.ceil(w / cell) + 1, gh = Math.ceil(h / cell) + 1;
  const grid: number[][] = Array.from({ length: gw * gh }, () => []);
  const pts: number[] = [];
  const md2 = md * md;
  const occupied = (x: number, y: number): boolean => {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let yy = Math.max(0, gy - 1); yy <= Math.min(gh - 1, gy + 1); yy++) {
      for (let xx = Math.max(0, gx - 1); xx <= Math.min(gw - 1, gx + 1); xx++) {
        for (const k of grid[yy * gw + xx]) {
          const dx = pts[k * 2] - x, dy = pts[k * 2 + 1] - y;
          if (dx * dx + dy * dy < md2) return true;
        }
      }
    }
    return false;
  };
  const insert = (x: number, y: number) => {
    const k = pts.length / 2;
    pts.push(x, y);
    grid[Math.floor(y / cell) * gw + Math.floor(x / cell)].push(k);
  };
  if (o.avoid) for (let i = 0; i + 1 < o.avoid.length; i += 2) {
    const x = o.avoid[i], y = o.avoid[i + 1];
    if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < w && y < h) insert(x, y);
  }
  const out: Corner[] = [];
  for (const c of cands) {
    if (out.length >= o.maxCorners) break;
    if (occupied(c.x, c.y)) continue;
    insert(c.x, c.y);
    out.push(c);
  }
  return out;
}
