// ─────────────────────────────────────────────────────────────────────────────
// Planar homographies: Hartley-normalised Direct Linear Transformation,
// RANSAC outlier rejection with adaptive iteration count, and Gauss–Newton
// refinement of the 8 free parameters on the inlier set.
// Homographies are row-major 3×3 Float64Arrays mapping src → dst.
// ─────────────────────────────────────────────────────────────────────────────

import { mat3Inv, mat3Mul, nullVector, rng, ransacIterations, sampleIndices, luSolve, type Mat } from './linalg';

export function applyH(H: ArrayLike<number>, x: number, y: number): [number, number] {
  const w = H[6] * x + H[7] * y + H[8];
  const iw = Math.abs(w) < 1e-12 ? 1e12 : 1 / w;
  return [(H[0] * x + H[1] * y + H[2]) * iw, (H[3] * x + H[4] * y + H[5]) * iw];
}

export const mulH = mat3Mul;
export const invertH = (H: ArrayLike<number>): Mat | null => {
  const inv = mat3Inv(H);
  return inv ? scaleH(inv) : null;
};

/** Normalise so H[8] = 1 (when possible). */
export function scaleH(H: Mat): Mat {
  const s = Math.abs(H[8]) > 1e-12 ? H[8] : Math.hypot(...H);
  for (let i = 0; i < 9; i++) H[i] /= s;
  return H;
}

/** Similarity transform moving the centroid to the origin and the mean distance to √2. */
export function normalizer(pts: ArrayLike<number>, idx: ArrayLike<number>): Mat {
  let cx = 0, cy = 0;
  const n = idx.length;
  for (let k = 0; k < n; k++) {
    cx += pts[idx[k] * 2];
    cy += pts[idx[k] * 2 + 1];
  }
  cx /= n;
  cy /= n;
  let d = 0;
  for (let k = 0; k < n; k++) d += Math.hypot(pts[idx[k] * 2] - cx, pts[idx[k] * 2 + 1] - cy);
  d /= n;
  const s = d > 1e-12 ? Math.SQRT2 / d : 1;
  return Float64Array.of(s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1);
}

/** DLT homography from ≥ 4 correspondences (indices into the xy arrays). */
export function dltHomography(src: ArrayLike<number>, dst: ArrayLike<number>, idx: ArrayLike<number>): Mat | null {
  const n = idx.length;
  if (n < 4) return null;
  const Ts = normalizer(src, idx), Td = normalizer(dst, idx);
  const A = new Float64Array(2 * n * 9);
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    const x = Ts[0] * src[i * 2] + Ts[2], y = Ts[4] * src[i * 2 + 1] + Ts[5];
    const u = Td[0] * dst[i * 2] + Td[2], v = Td[4] * dst[i * 2 + 1] + Td[5];
    const r0 = 2 * k * 9, r1 = r0 + 9;
    A[r0] = -x; A[r0 + 1] = -y; A[r0 + 2] = -1;
    A[r0 + 6] = u * x; A[r0 + 7] = u * y; A[r0 + 8] = u;
    A[r1 + 3] = -x; A[r1 + 4] = -y; A[r1 + 5] = -1;
    A[r1 + 6] = v * x; A[r1 + 7] = v * y; A[r1 + 8] = v;
  }
  const h = nullVector(A, 2 * n, 9);
  const Tdi = mat3Inv(Td);
  if (!Tdi) return null;
  const H = mat3Mul(mat3Mul(Tdi, h), Ts);
  if (!H.every(Number.isFinite) || Math.abs(H[8]) < 1e-14) return null;
  return scaleH(H);
}

/** Squared forward transfer error of correspondence i. */
export function transferError2(H: ArrayLike<number>, src: ArrayLike<number>, dst: ArrayLike<number>, i: number): number {
  const [x, y] = applyH(H, src[i * 2], src[i * 2 + 1]);
  const dx = x - dst[i * 2], dy = y - dst[i * 2 + 1];
  return dx * dx + dy * dy;
}

function collinear(pts: ArrayLike<number>, a: number, b: number, c: number): boolean {
  const ax = pts[a * 2], ay = pts[a * 2 + 1];
  const area = (pts[b * 2] - ax) * (pts[c * 2 + 1] - ay) - (pts[b * 2 + 1] - ay) * (pts[c * 2] - ax);
  const scale = Math.hypot(pts[b * 2] - ax, pts[b * 2 + 1] - ay) * Math.hypot(pts[c * 2] - ax, pts[c * 2 + 1] - ay);
  return Math.abs(area) < 1e-3 * (scale + 1e-9);
}

/** A homography that flips orientation between the sample points is never a valid planar motion. */
function preservesOrientation(H: ArrayLike<number>, src: ArrayLike<number>, idx: number[]): boolean {
  let sign = 0;
  for (const i of idx) {
    const w = H[6] * src[i * 2] + H[7] * src[i * 2 + 1] + H[8];
    const s = Math.sign(w);
    if (!sign) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export interface RansacResult {
  H: Mat;
  inliers: Uint8Array;
  count: number;
  /** RMS transfer error on the inliers (pixels) */
  rms: number;
}

export interface HomographyRansacOptions {
  threshold?: number;
  maxIter?: number;
  confidence?: number;
  seed?: number;
  refine?: boolean;
}

/** Robust homography with RANSAC; returns null when fewer than 4 consistent points exist. */
export function homographyRansac(src: ArrayLike<number>, dst: ArrayLike<number>, o: HomographyRansacOptions = {}): RansacResult | null {
  const n = Math.min(src.length, dst.length) >> 1;
  const valid: number[] = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(src[i * 2]) && Number.isFinite(dst[i * 2])) valid.push(i);
  if (valid.length < 4) return null;
  const thr2 = (o.threshold ?? 2) ** 2;
  const rand = rng(o.seed ?? 1234567);
  let best: Mat | null = null, bestCount = -1, bestScore = Infinity;
  let maxIter = o.maxIter ?? 1000;
  for (let it = 0; it < maxIter; it++) {
    const s = sampleIndices(valid.length, 4, rand).map((k) => valid[k]);
    if (collinear(src, s[0], s[1], s[2]) || collinear(src, s[0], s[1], s[3]) || collinear(src, s[0], s[2], s[3]) || collinear(src, s[1], s[2], s[3])) continue;
    const H = dltHomography(src, dst, s);
    if (!H || !preservesOrientation(H, src, s)) continue;
    // MSAC score: truncated quadratic loss
    let count = 0, score = 0;
    for (const i of valid) {
      const e = transferError2(H, src, dst, i);
      if (e < thr2) { count++; score += e; } else score += thr2;
    }
    if (score < bestScore) {
      bestScore = score;
      bestCount = count;
      best = H;
      maxIter = Math.min(maxIter, ransacIterations(count / valid.length, 4, o.confidence ?? 0.995, o.maxIter ?? 1000));
    }
  }
  if (!best || bestCount < 4) return null;
  let inliers = new Uint8Array(n);
  let idx: number[] = [];
  for (const i of valid) if (transferError2(best, src, dst, i) < thr2) { inliers[i] = 1; idx.push(i); }
  // re-estimate on all inliers, then refine non-linearly
  let H = dltHomography(src, dst, idx) ?? best;
  if (o.refine !== false) H = refineHomography(H, src, dst, idx);
  inliers = new Uint8Array(n);
  idx = [];
  let ss = 0;
  for (const i of valid) {
    const e = transferError2(H, src, dst, i);
    if (e < thr2) { inliers[i] = 1; idx.push(i); ss += e; }
  }
  if (idx.length < 4) return null;
  return { H, inliers, count: idx.length, rms: Math.sqrt(ss / idx.length) };
}

/** Gauss–Newton (Levenberg-damped) refinement of h11..h32 minimising the forward transfer error. */
export function refineHomography(H0: ArrayLike<number>, src: ArrayLike<number>, dst: ArrayLike<number>, idx: number[], iterations = 10): Mat {
  const H = scaleH(Float64Array.from(H0));
  const cost = (h: ArrayLike<number>) => {
    let c = 0;
    for (const i of idx) c += transferError2(h, src, dst, i);
    return c;
  };
  let c0 = cost(H);
  let lambda = 1e-3;
  for (let it = 0; it < iterations; it++) {
    const JtJ = new Float64Array(64), Jtr = new Float64Array(8);
    for (const i of idx) {
      const x = src[i * 2], y = src[i * 2 + 1];
      const w = H[6] * x + H[7] * y + 1;
      const px = (H[0] * x + H[1] * y + H[2]) / w, py = (H[3] * x + H[4] * y + H[5]) / w;
      const rx = px - dst[i * 2], ry = py - dst[i * 2 + 1];
      const jx = [x / w, y / w, 1 / w, 0, 0, 0, (-px * x) / w, (-px * y) / w];
      const jy = [0, 0, 0, x / w, y / w, 1 / w, (-py * x) / w, (-py * y) / w];
      for (let a = 0; a < 8; a++) {
        Jtr[a] += jx[a] * rx + jy[a] * ry;
        for (let b = 0; b < 8; b++) JtJ[a * 8 + b] += jx[a] * jx[b] + jy[a] * jy[b];
      }
    }
    let improved = false;
    for (let tries = 0; tries < 6 && !improved; tries++) {
      const A = Float64Array.from(JtJ);
      for (let a = 0; a < 8; a++) A[a * 8 + a] *= 1 + lambda;
      const d = luSolve(A, Jtr.map((v) => -v), 8);
      if (!d) break;
      const Hn = Float64Array.from(H);
      for (let a = 0; a < 8; a++) Hn[a] += d[a];
      const c1 = cost(Hn);
      if (c1 < c0) {
        H.set(Hn);
        lambda = Math.max(1e-7, lambda / 4);
        improved = c0 - c1 > 1e-10 * c0;
        c0 = c1;
        if (!improved) return H;
      } else lambda *= 8;
    }
    if (!improved) break;
  }
  return H;
}

/** Homography mapping the 4 corners of `from` (xy×4) exactly onto `to`. */
export function homographyFromQuads(from: ArrayLike<number>, to: ArrayLike<number>): Mat | null {
  return dltHomography(from, to, [0, 1, 2, 3]);
}

/** Point-in-convex-or-concave-polygon test (even–odd rule). */
export function pointInPolygon(x: number, y: number, poly: ArrayLike<number>): boolean {
  let inside = false;
  const n = poly.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-300) + xi) inside = !inside;
  }
  return inside;
}
