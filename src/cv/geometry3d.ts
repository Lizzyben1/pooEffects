// ─────────────────────────────────────────────────────────────────────────────
// Multi-view geometry for the 3D camera tracker.
//
// Conventions: a camera pose (R, t) maps WORLD → CAMERA, Xc = R·X + t, with
// +X right, +Y down, +Z forward (identical to After Effects camera space).
// "Normalised" image coordinates are (u − cx)/f, (v − cy)/f.
//
//  * essentialRansac  — Hartley-normalised 8-point essential matrix + RANSAC
//                        on the Sampson distance
//  * recoverPose      — 4-fold (R, t) decomposition + cheirality test
//  * triangulate      — linear multi-view DLT triangulation
//  * pnpRansac        — DLT perspective-n-point + RANSAC + robust refinement
//  * refinePose       — Levenberg–Marquardt motion-only bundle adjustment
//  * rotationRansac   — pure-rotation (tripod) estimation from bearing vectors
// ─────────────────────────────────────────────────────────────────────────────

import {
  choleskySolve, cross3, mat3Det, mat3Mul, mat3T, mat3Vec, nullVector, orthonormalize, rodrigues, rng,
  ransacIterations, sampleIndices, svd, type Mat, type V3,
} from './linalg';
import { normalizer } from './homography';

export interface Pose {
  R: Mat;
  t: V3;
}

export interface Intrinsics {
  f: number;
  cx: number;
  cy: number;
}

export const identityPose = (): Pose => ({ R: Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1), t: [0, 0, 0] });

export function transform(p: Pose, X: ArrayLike<number>): V3 {
  const c = mat3Vec(p.R, X);
  return [c[0] + p.t[0], c[1] + p.t[1], c[2] + p.t[2]];
}

/** Camera centre in world space: C = −Rᵀt. */
export function cameraCenter(p: Pose): V3 {
  const c = mat3Vec(mat3T(p.R), p.t);
  return [-c[0], -c[1], -c[2]];
}

export function project(p: Pose, K: Intrinsics, X: ArrayLike<number>): [number, number, number] {
  const c = transform(p, X);
  return [K.cx + (K.f * c[0]) / c[2], K.cy + (K.f * c[1]) / c[2], c[2]];
}

// ── essential matrix ────────────────────────────────────────────────────────

/** Sampson distance (squared, normalised units) of a correspondence under E. */
export function sampson(E: ArrayLike<number>, x1: number, y1: number, x2: number, y2: number): number {
  const Ex0 = E[0] * x1 + E[1] * y1 + E[2], Ex1 = E[3] * x1 + E[4] * y1 + E[5], Ex2 = E[6] * x1 + E[7] * y1 + E[8];
  const Etx0 = E[0] * x2 + E[3] * y2 + E[6], Etx1 = E[1] * x2 + E[4] * y2 + E[7];
  const num = x2 * Ex0 + y2 * Ex1 + Ex2;
  const den = Ex0 * Ex0 + Ex1 * Ex1 + Etx0 * Etx0 + Etx1 * Etx1;
  return den > 1e-300 ? (num * num) / den : Infinity;
}

/** 8-point algorithm on normalised coordinates; projects onto the essential manifold. */
export function eightPointE(p1: ArrayLike<number>, p2: ArrayLike<number>, idx: ArrayLike<number>): Mat | null {
  const n = idx.length;
  if (n < 8) return null;
  const T1 = normalizer(p1, idx), T2 = normalizer(p2, idx);
  const A = new Float64Array(n * 9);
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    const x1 = T1[0] * p1[i * 2] + T1[2], y1 = T1[4] * p1[i * 2 + 1] + T1[5];
    const x2 = T2[0] * p2[i * 2] + T2[2], y2 = T2[4] * p2[i * 2 + 1] + T2[5];
    A.set([x2 * x1, x2 * y1, x2, y2 * x1, y2 * y1, y2, x1, y1, 1], k * 9);
  }
  const e = nullVector(A, n, 9);
  const En = mat3Mul(mat3Mul(mat3T(T2), e), T1);
  const { U, S, V } = svd(En, 3, 3);
  const s = (S[0] + S[1]) / 2;
  if (!(s > 0)) return null;
  const D = Float64Array.of(s, 0, 0, 0, s, 0, 0, 0, 0);
  const E = mat3Mul(mat3Mul(U, D), mat3T(V));
  const nrm = Math.hypot(...E);
  for (let i = 0; i < 9; i++) E[i] /= nrm;
  return E;
}

export interface EssentialResult {
  E: Mat;
  inliers: Uint8Array;
  count: number;
}

/** Robust essential matrix; `threshold` is in normalised units (pixels / focal). */
export function essentialRansac(p1: ArrayLike<number>, p2: ArrayLike<number>, threshold: number, maxIter = 600, seed = 99): EssentialResult | null {
  const n = Math.min(p1.length, p2.length) >> 1;
  const valid: number[] = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(p1[i * 2]) && Number.isFinite(p2[i * 2])) valid.push(i);
  if (valid.length < 8) return null;
  const thr2 = threshold * threshold;
  const rand = rng(seed);
  let best: Mat | null = null, bestScore = Infinity, bestCount = 0;
  let iters = maxIter;
  for (let it = 0; it < iters; it++) {
    const s = sampleIndices(valid.length, 8, rand).map((k) => valid[k]);
    const E = eightPointE(p1, p2, s);
    if (!E) continue;
    let score = 0, count = 0;
    for (const i of valid) {
      const d = sampson(E, p1[i * 2], p1[i * 2 + 1], p2[i * 2], p2[i * 2 + 1]);
      if (d < thr2) { count++; score += d; } else score += thr2;
    }
    if (score < bestScore) {
      bestScore = score;
      bestCount = count;
      best = E;
      iters = Math.min(iters, ransacIterations(count / valid.length, 8, 0.995, maxIter));
    }
  }
  if (!best || bestCount < 8) return null;
  const idx: number[] = [];
  for (const i of valid) if (sampson(best, p1[i * 2], p1[i * 2 + 1], p2[i * 2], p2[i * 2 + 1]) < thr2) idx.push(i);
  const E = eightPointE(p1, p2, idx) ?? best;
  const inliers = new Uint8Array(n);
  let count = 0;
  for (const i of valid) if (sampson(E, p1[i * 2], p1[i * 2 + 1], p2[i * 2], p2[i * 2 + 1]) < thr2) { inliers[i] = 1; count++; }
  return { E, inliers, count };
}

/** The four (R, t) pairs consistent with an essential matrix (|t| = 1). */
export function decomposeE(E: ArrayLike<number>): Pose[] {
  const { U, V } = svd(E, 3, 3);
  const Uf = Float64Array.from(U), Vf = Float64Array.from(V);
  if (mat3Det(Uf) < 0) for (let i = 0; i < 3; i++) Uf[i * 3 + 2] *= -1;
  if (mat3Det(Vf) < 0) for (let i = 0; i < 3; i++) Vf[i * 3 + 2] *= -1;
  const W = Float64Array.of(0, -1, 0, 1, 0, 0, 0, 0, 1);
  const R1 = mat3Mul(mat3Mul(Uf, W), mat3T(Vf));
  const R2 = mat3Mul(mat3Mul(Uf, mat3T(W)), mat3T(Vf));
  const t: V3 = [Uf[2], Uf[5], Uf[8]];
  const nt: V3 = [-t[0], -t[1], -t[2]];
  return [{ R: R1, t }, { R: R1, t: nt }, { R: R2, t }, { R: R2, t: nt }];
}

/** Linear triangulation of one point from ≥ 2 views (normalised observations). */
export function triangulate(poses: Pose[], obs: ArrayLike<number>): V3 | null {
  const k = poses.length;
  const A = new Float64Array(2 * k * 4);
  for (let i = 0; i < k; i++) {
    const { R, t } = poses[i];
    const x = obs[i * 2], y = obs[i * 2 + 1];
    const P0 = [R[0], R[1], R[2], t[0]], P1 = [R[3], R[4], R[5], t[1]], P2 = [R[6], R[7], R[8], t[2]];
    for (let c = 0; c < 4; c++) {
      A[(2 * i) * 4 + c] = x * P2[c] - P0[c];
      A[(2 * i + 1) * 4 + c] = y * P2[c] - P1[c];
    }
  }
  const X = nullVector(A, 2 * k, 4);
  if (Math.abs(X[3]) < 1e-12) return null;
  return [X[0] / X[3], X[1] / X[3], X[2] / X[3]];
}

/** Angle (radians) between the viewing rays of a point from two camera centres. */
export function parallaxAngle(X: ArrayLike<number>, c1: ArrayLike<number>, c2: ArrayLike<number>): number {
  const a = [X[0] - c1[0], X[1] - c1[1], X[2] - c1[2]], b = [X[0] - c2[0], X[1] - c2[1], X[2] - c2[2]];
  const la = Math.hypot(a[0], a[1], a[2]), lb = Math.hypot(b[0], b[1], b[2]);
  if (la < 1e-12 || lb < 1e-12) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb))));
}

export interface TwoViewResult {
  pose: Pose;
  /** triangulated points (NaN when rejected), indexed like the input correspondences */
  points: Float64Array;
  good: Uint8Array;
  goodCount: number;
  medianParallax: number;
}

/** Choose the E decomposition that puts the most inliers in front of both cameras. */
export function recoverPose(E: ArrayLike<number>, p1: ArrayLike<number>, p2: ArrayLike<number>, inliers: Uint8Array, maxReproj: number): TwoViewResult | null {
  const n = inliers.length;
  let best: TwoViewResult | null = null;
  const P0 = identityPose();
  for (const cand of decomposeE(E)) {
    const points = new Float64Array(n * 3).fill(NaN);
    const good = new Uint8Array(n);
    let count = 0;
    const c2 = cameraCenter(cand);
    const par: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!inliers[i]) continue;
      const X = triangulate([P0, cand], [p1[i * 2], p1[i * 2 + 1], p2[i * 2], p2[i * 2 + 1]]);
      if (!X) continue;
      const z1 = X[2], x2 = transform(cand, X);
      if (z1 <= 0 || x2[2] <= 0) continue;
      const e1 = Math.hypot(X[0] / z1 - p1[i * 2], X[1] / z1 - p1[i * 2 + 1]);
      const e2 = Math.hypot(x2[0] / x2[2] - p2[i * 2], x2[1] / x2[2] - p2[i * 2 + 1]);
      if (e1 > maxReproj || e2 > maxReproj) continue;
      points.set(X, i * 3);
      good[i] = 1;
      count++;
      par.push(parallaxAngle(X, [0, 0, 0], c2));
    }
    if (!best || count > best.goodCount) {
      par.sort((a, b) => a - b);
      best = { pose: cand, points, good, goodCount: count, medianParallax: par.length ? par[par.length >> 1] : 0 };
    }
  }
  return best;
}

// ── perspective-n-point ─────────────────────────────────────────────────────

/** DLT pose from ≥ 6 3D–2D correspondences (normalised image coordinates). */
export function pnpDLT(X: ArrayLike<number>, x: ArrayLike<number>, idx: ArrayLike<number>): Pose | null {
  const n = idx.length;
  if (n < 6) return null;
  // normalise the 3D points for conditioning
  let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < n; k++) { const i = idx[k]; cx += X[i * 3]; cy += X[i * 3 + 1]; cz += X[i * 3 + 2]; }
  cx /= n; cy /= n; cz /= n;
  let d = 0;
  for (let k = 0; k < n; k++) { const i = idx[k]; d += Math.hypot(X[i * 3] - cx, X[i * 3 + 1] - cy, X[i * 3 + 2] - cz); }
  d /= n;
  const s = d > 1e-12 ? Math.sqrt(3) / d : 1;
  const A = new Float64Array(2 * n * 12);
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    const P = [(X[i * 3] - cx) * s, (X[i * 3 + 1] - cy) * s, (X[i * 3 + 2] - cz) * s, 1];
    const u = x[i * 2], v = x[i * 2 + 1];
    const r0 = 2 * k * 12, r1 = r0 + 12;
    for (let c = 0; c < 4; c++) {
      A[r0 + c] = P[c];
      A[r0 + 8 + c] = -u * P[c];
      A[r1 + 4 + c] = P[c];
      A[r1 + 8 + c] = -v * P[c];
    }
  }
  const p = nullVector(A, 2 * n, 12);
  // undo the normalisation: P = P' · [sI  −s·c; 0 1]
  const M = Float64Array.of(p[0] * s, p[1] * s, p[2] * s, p[4] * s, p[5] * s, p[6] * s, p[8] * s, p[9] * s, p[10] * s);
  const p4: V3 = [
    p[3] - s * (p[0] * cx + p[1] * cy + p[2] * cz),
    p[7] - s * (p[4] * cx + p[5] * cy + p[6] * cz),
    p[11] - s * (p[8] * cx + p[9] * cy + p[10] * cz),
  ];
  const sign = mat3Det(M) < 0 ? -1 : 1;
  for (let i = 0; i < 9; i++) M[i] *= sign;
  const { S } = svd(M, 3, 3);
  const lambda = (S[0] + S[1] + S[2]) / 3;
  if (!(lambda > 1e-12)) return null;
  const R = orthonormalize(M);
  const t: V3 = [(sign * p4[0]) / lambda, (sign * p4[1]) / lambda, (sign * p4[2]) / lambda];
  // cheirality: most points must be in front
  let front = 0;
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    if (transform({ R, t }, [X[i * 3], X[i * 3 + 1], X[i * 3 + 2]])[2] > 0) front++;
  }
  return front >= n / 2 ? { R, t } : null;
}

const huberWeight = (r: number, delta: number): number => (r <= delta ? 1 : delta / r);

export interface PoseRefineResult {
  pose: Pose;
  inliers: Uint8Array;
  count: number;
  rms: number;
}

/**
 * Motion-only bundle adjustment: LM over (rotation-vector update, translation) minimising the
 * Huber-weighted pixel reprojection error with fixed 3D points and intrinsics.
 */
export function refinePose(pose0: Pose, K: Intrinsics, X: ArrayLike<number>, uv: ArrayLike<number>, idx: ArrayLike<number>, iterations = 12, huber = 2, inlierThreshold = 4): PoseRefineResult {
  let R: Mat = Float64Array.from(pose0.R);
  let t: V3 = [...pose0.t];
  const cost = (Rc: Mat, tc: V3) => {
    let c = 0;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const xc = transform({ R: Rc, t: tc }, [X[i * 3], X[i * 3 + 1], X[i * 3 + 2]]);
      if (xc[2] <= 1e-9) { c += huber * huber * 4; continue; }
      const r = Math.hypot(K.cx + (K.f * xc[0]) / xc[2] - uv[i * 2], K.cy + (K.f * xc[1]) / xc[2] - uv[i * 2 + 1]);
      c += r <= huber ? r * r : 2 * huber * r - huber * huber;
    }
    return c;
  };
  let c0 = cost(R, t);
  let lambda = 1e-3;
  for (let it = 0; it < iterations; it++) {
    const H = new Float64Array(36), g = new Float64Array(6);
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const Xw = [X[i * 3], X[i * 3 + 1], X[i * 3 + 2]];
      const RX = mat3Vec(R, Xw);
      const xc = [RX[0] + t[0], RX[1] + t[1], RX[2] + t[2]];
      if (xc[2] <= 1e-9) continue;
      const iz = 1 / xc[2];
      const rx = K.cx + K.f * xc[0] * iz - uv[i * 2], ry = K.cy + K.f * xc[1] * iz - uv[i * 2 + 1];
      const w = huberWeight(Math.hypot(rx, ry), huber);
      // d(proj)/d(xc)
      const a0 = K.f * iz, a2 = -K.f * xc[0] * iz * iz, b1 = K.f * iz, b2 = -K.f * xc[1] * iz * iz;
      // d(xc)/d(dw) = −[RX]×  ;  d(xc)/dt = I
      const S = [0, RX[2], -RX[1], -RX[2], 0, RX[0], RX[1], -RX[0], 0];
      const jx = [a0 * S[0] + a2 * S[6], a0 * S[1] + a2 * S[7], a0 * S[2] + a2 * S[8], a0, 0, a2];
      const jy = [b1 * S[3] + b2 * S[6], b1 * S[4] + b2 * S[7], b1 * S[5] + b2 * S[8], 0, b1, b2];
      for (let a = 0; a < 6; a++) {
        g[a] -= w * (jx[a] * rx + jy[a] * ry);
        for (let b = 0; b < 6; b++) H[a * 6 + b] += w * (jx[a] * jx[b] + jy[a] * jy[b]);
      }
    }
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const A = Float64Array.from(H);
      for (let a = 0; a < 6; a++) A[a * 6 + a] += lambda * (H[a * 6 + a] + 1e-9);
      const d = choleskySolve(A, g, 6);
      if (!d) { lambda *= 10; continue; }
      const Rn = mat3Mul(rodrigues([d[0], d[1], d[2]]), R);
      const tn: V3 = [t[0] + d[3], t[1] + d[4], t[2] + d[5]];
      const c1 = cost(Rn, tn);
      if (c1 < c0) {
        improved = c0 - c1 > 1e-9 * c0;
        R = orthonormalize(Rn);
        t = tn;
        c0 = c1;
        lambda = Math.max(1e-8, lambda / 5);
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  const inliers = new Uint8Array(uv.length >> 1);
  let count = 0, ss = 0;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const pr = project({ R, t }, K, [X[i * 3], X[i * 3 + 1], X[i * 3 + 2]]);
    if (pr[2] <= 0) continue;
    const e = Math.hypot(pr[0] - uv[i * 2], pr[1] - uv[i * 2 + 1]);
    if (e < inlierThreshold) { inliers[i] = 1; count++; ss += e * e; }
  }
  return { pose: { R, t }, inliers, count, rms: count ? Math.sqrt(ss / count) : Infinity };
}

/** Robust PnP: DLT inside RANSAC on pixel reprojection error, then LM refinement. */
export function pnpRansac(X: ArrayLike<number>, uv: ArrayLike<number>, idx: number[], K: Intrinsics, threshold = 3, maxIter = 300, seed = 4242): PoseRefineResult | null {
  if (idx.length < 6) return null;
  const xn = new Float64Array(uv.length);
  for (const i of idx) {
    xn[i * 2] = (uv[i * 2] - K.cx) / K.f;
    xn[i * 2 + 1] = (uv[i * 2 + 1] - K.cy) / K.f;
  }
  const rand = rng(seed);
  const thr2 = threshold * threshold;
  let best: Pose | null = null, bestCount = 0;
  let iters = maxIter;
  for (let it = 0; it < iters; it++) {
    const s = sampleIndices(idx.length, 6, rand).map((k) => idx[k]);
    const P = pnpDLT(X, xn, s);
    if (!P) continue;
    let count = 0;
    for (const i of idx) {
      const pr = project(P, K, [X[i * 3], X[i * 3 + 1], X[i * 3 + 2]]);
      if (pr[2] <= 0) continue;
      const dx = pr[0] - uv[i * 2], dy = pr[1] - uv[i * 2 + 1];
      if (dx * dx + dy * dy < thr2) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = P;
      iters = Math.min(iters, ransacIterations(count / idx.length, 6, 0.995, maxIter));
    }
  }
  if (!best || bestCount < 6) return null;
  const inl: number[] = [];
  for (const i of idx) {
    const pr = project(best, K, [X[i * 3], X[i * 3 + 1], X[i * 3 + 2]]);
    if (pr[2] > 0 && Math.hypot(pr[0] - uv[i * 2], pr[1] - uv[i * 2 + 1]) < threshold) inl.push(i);
  }
  const ref = pnpDLT(X, xn, inl) ?? best;
  return refinePose(ref, K, X, uv, idx, 15, threshold * 0.6, threshold);
}

// ── pure rotation (tripod) ──────────────────────────────────────────────────

/** Rotation R minimising Σ|b − R·a|² over bearing-vector pairs (Kabsch / Wahba). */
export function kabsch(a: ArrayLike<number>, b: ArrayLike<number>, idx: ArrayLike<number>): Mat {
  const Hm = new Float64Array(9);
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) Hm[r * 3 + c] += b[i * 3 + r] * a[i * 3 + c];
  }
  return orthonormalize(Hm);
}

export function bearing(xn: number, yn: number): V3 {
  const l = Math.hypot(xn, yn, 1);
  return [xn / l, yn / l, 1 / l];
}

/** Robust rotation between two views from bearing vectors (2-point RANSAC + Kabsch). */
export function rotationRansac(a: ArrayLike<number>, b: ArrayLike<number>, n: number, angleThreshold: number, maxIter = 200, seed = 77): { R: Mat; inliers: Uint8Array; count: number } | null {
  const valid: number[] = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(a[i * 3]) && Number.isFinite(b[i * 3])) valid.push(i);
  if (valid.length < 3) return null;
  const cosT = Math.cos(angleThreshold);
  const rand = rng(seed);
  let best: Mat | null = null, bestCount = 0;
  const countIn = (R: Mat) => {
    let c = 0;
    for (const i of valid) {
      const ra = mat3Vec(R, [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]]);
      if (ra[0] * b[i * 3] + ra[1] * b[i * 3 + 1] + ra[2] * b[i * 3 + 2] > cosT) c++;
    }
    return c;
  };
  let iters = maxIter;
  for (let it = 0; it < iters; it++) {
    const s = sampleIndices(valid.length, 2, rand).map((k) => valid[k]);
    const c = cross3([a[s[0] * 3], a[s[0] * 3 + 1], a[s[0] * 3 + 2]], [a[s[1] * 3], a[s[1] * 3 + 1], a[s[1] * 3 + 2]]);
    if (Math.hypot(c[0], c[1], c[2]) < 1e-4) continue;
    const R = kabsch(a, b, s);
    const cnt = countIn(R);
    if (cnt > bestCount) {
      bestCount = cnt;
      best = R;
      iters = Math.min(iters, ransacIterations(cnt / valid.length, 2, 0.999, maxIter));
    }
  }
  if (!best) return null;
  const inl: number[] = [];
  const inliers = new Uint8Array(n);
  for (const i of valid) {
    const ra = mat3Vec(best, [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]]);
    if (ra[0] * b[i * 3] + ra[1] * b[i * 3 + 1] + ra[2] * b[i * 3 + 2] > cosT) { inl.push(i); inliers[i] = 1; }
  }
  return { R: inl.length >= 3 ? kabsch(a, b, inl) : best, inliers, count: inl.length };
}

// ── fundamental matrix (uncalibrated pruning of 2D tracks) ──────────────────

/** Normalised 8-point fundamental matrix with rank-2 enforcement (pixel coordinates). */
export function eightPointF(p1: ArrayLike<number>, p2: ArrayLike<number>, idx: ArrayLike<number>): Mat | null {
  const n = idx.length;
  if (n < 8) return null;
  const T1 = normalizer(p1, idx), T2 = normalizer(p2, idx);
  const A = new Float64Array(n * 9);
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    const x1 = T1[0] * p1[i * 2] + T1[2], y1 = T1[4] * p1[i * 2 + 1] + T1[5];
    const x2 = T2[0] * p2[i * 2] + T2[2], y2 = T2[4] * p2[i * 2 + 1] + T2[5];
    A.set([x2 * x1, x2 * y1, x2, y2 * x1, y2 * y1, y2, x1, y1, 1], k * 9);
  }
  const f = nullVector(A, n, 9);
  const { U, S, V } = svd(f, 3, 3);
  const D = Float64Array.of(S[0], 0, 0, 0, S[1], 0, 0, 0, 0);
  const Fn = mat3Mul(mat3Mul(U, D), mat3T(V));
  const F = mat3Mul(mat3Mul(mat3T(T2), Fn), T1);
  const nrm = Math.hypot(...F);
  if (!(nrm > 0)) return null;
  for (let i = 0; i < 9; i++) F[i] /= nrm;
  return F;
}

/**
 * Robust fundamental matrix; returns the inlier mask (Sampson distance in pixels). With fewer than
 * 8 valid correspondences every valid point is reported as an inlier.
 */
export function fundamentalInliers(p1: ArrayLike<number>, p2: ArrayLike<number>, threshold: number, maxIter = 300, seed = 31): Uint8Array {
  const n = Math.min(p1.length, p2.length) >> 1;
  const valid: number[] = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(p1[i * 2]) && Number.isFinite(p2[i * 2])) valid.push(i);
  const out = new Uint8Array(n);
  if (valid.length < 12) {
    for (const i of valid) out[i] = 1;
    return out;
  }
  const thr2 = threshold * threshold;
  const rand = rng(seed);
  let best: Mat | null = null, bestScore = Infinity;
  let iters = maxIter;
  for (let it = 0; it < iters; it++) {
    const s = sampleIndices(valid.length, 8, rand).map((k) => valid[k]);
    const F = eightPointF(p1, p2, s);
    if (!F) continue;
    let score = 0, count = 0;
    for (const i of valid) {
      const d = sampson(F, p1[i * 2], p1[i * 2 + 1], p2[i * 2], p2[i * 2 + 1]);
      if (d < thr2) { score += d; count++; } else score += thr2;
    }
    if (score < bestScore) {
      bestScore = score;
      best = F;
      iters = Math.min(iters, ransacIterations(count / valid.length, 8, 0.99, maxIter));
    }
  }
  if (!best) {
    for (const i of valid) out[i] = 1;
    return out;
  }
  for (const i of valid) if (sampson(best, p1[i * 2], p1[i * 2 + 1], p2[i * 2], p2[i * 2 + 1]) < thr2) out[i] = 1;
  return out;
}
