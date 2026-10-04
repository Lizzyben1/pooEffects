// ─────────────────────────────────────────────────────────────────────────────
// 3D camera solve (incremental structure-from-motion) from 2D feature tracks.
//
//  1. keyframe selection by median feature displacement / track survival
//  2. angle-of-view estimation: a sweep of candidate focal lengths, each
//     scored by a quick reconstruction's reprojection error (skipped when the
//     user specifies the horizontal angle of view)
//  3. initial pair: max-parallax keyframe pair where an essential matrix
//     explains the motion clearly better than a homography; E → (R, t) with
//     cheirality, linear triangulation, two-view bundle adjustment
//  4. incremental registration of the remaining keyframes (PnP + RANSAC,
//     motion-only refinement), triangulation of new points, periodic global
//     bundle adjustment with Huber loss and outlier pruning
//  5. final bundle adjustment (optionally refining the focal length), then
//     every in-between frame is resected against the fixed point cloud
//  Tripod shots (no parallax) are solved as rotation-only cameras with the
//  points living on a sphere around the nodal point.
// ─────────────────────────────────────────────────────────────────────────────

import { bundleAdjust, type BAObservation } from './bundle';
import {
  bearing, cameraCenter, essentialRansac, parallaxAngle, pnpRansac, project, recoverPose, refinePose, rotationRansac, triangulate,
  type Intrinsics, type Pose,
} from './geometry3d';
import { homographyRansac } from './homography';
import { mat3Mul, mat3T, mat3Vec, matToQuat, median, quatToMat, slerp, type Mat, type V3 } from './linalg';

export interface Track2D {
  id: number;
  /** xy per frame (index = frame − frame0); NaN where the feature is not tracked */
  xy: Float32Array;
  color: [number, number, number];
}

export type ShotType = 'auto' | 'free' | 'tripod';

export interface SolveOptions {
  width: number;
  height: number;
  frameCount: number;
  shotType: ShotType;
  /** horizontal angle of view in degrees, when known */
  fovDeg?: number | null;
  refineFocal?: boolean;
  onProgress?: (stage: string, fraction: number) => void;
  cancelled?: () => boolean;
}

export interface SolvedCamera {
  frame: number;
  R: number[];
  t: V3;
  error: number;
  solved: boolean;
}

export interface SolvedPoint {
  id: number;
  X: V3;
  error: number;
  first: number;
  last: number;
  color: [number, number, number];
}

export interface SolveResult {
  mode: 'free' | 'tripod';
  f: number;
  cameras: SolvedCamera[];
  points: SolvedPoint[];
  keyframes: number[];
  rms: number;
}

class Cancelled extends Error {}

interface Recon {
  poses: Map<number, Pose>;
  /** track index → 3D point */
  pts: Map<number, V3>;
  /** obsKey(track, frame) of observations rejected as outliers */
  bad: Set<number>;
  f: number;
}

const obsKey = (t: number, f: number) => t * 100000 + f;

export function solveCamera(tracks: Track2D[], o: SolveOptions): SolveResult {
  const W = o.width, H = o.height, F = o.frameCount;
  const cx = W / 2, cy = H / 2;
  const progress = (s: string, x: number) => o.onProgress?.(s, Math.max(0, Math.min(1, x)));
  const check = () => {
    if (o.cancelled?.()) throw new Cancelled('cancelled');
  };
  const at = (ti: number, f: number): [number, number] | null => {
    const x = tracks[ti].xy[f * 2];
    return Number.isFinite(x) ? [x, tracks[ti].xy[f * 2 + 1]] : null;
  };
  const tracksAt: number[][] = Array.from({ length: F }, () => []);
  tracks.forEach((tr, ti) => {
    for (let f = 0; f < F; f++) if (Number.isFinite(tr.xy[f * 2])) tracksAt[f].push(ti);
  });

  // ── 1. keyframes ──
  const keyframes = selectKeyframes(tracks, tracksAt, F, W);
  progress('Selecting keyframes', 1);
  check();

  // ── 2. focal ──
  const fromFov = (deg: number) => W / 2 / Math.tan((deg * Math.PI) / 360);
  let mode: 'free' | 'tripod' = o.shotType === 'tripod' ? 'tripod' : 'free';
  let initPair = mode === 'free' ? chooseInitialPair(tracks, keyframes, at, W, fromFov(55), cx, cy) : null;
  if (!initPair && o.shotType === 'auto') mode = 'tripod';
  if (!initPair && o.shotType === 'free') initPair = fallbackPair(keyframes);
  let f: number;
  if (o.fovDeg && o.fovDeg > 1 && o.fovDeg < 179) {
    f = fromFov(o.fovDeg);
  } else {
    const fovs = [22, 30, 38, 46, 54, 63, 72, 84, 98];
    const sub = keyframes.length > 22 ? subsample(keyframes, 22) : keyframes;
    let bestF = fromFov(50), bestErr = Infinity;
    fovs.forEach((deg, i) => {
      check();
      progress('Estimating angle of view', i / fovs.length);
      const fc = fromFov(deg);
      try {
        const err = mode === 'tripod'
          ? tripodRecon(tracks, sub, at, { f: fc, cx, cy }, false, check).rms
          : (() => {
            const pair = chooseInitialPair(tracks, sub, at, W, fc, cx, cy) ?? fallbackPair(sub);
            const r = incrementalRecon(tracks, sub, pair, at, { f: fc, cx, cy }, false, check, () => {}, true);
            const coverage = r.recon.poses.size / sub.length;
            return r.rms / Math.max(0.2, coverage);
          })();
        if (err < bestErr) {
          bestErr = err;
          bestF = fc;
        }
      } catch (e) {
        if (e instanceof Cancelled) throw e;
      }
    });
    // golden-section polish of the best candidate
    let lo = bestF * 0.82, hi = bestF * 1.22;
    const score = (fc: number) => {
      try {
        if (mode === 'tripod') return tripodRecon(tracks, sub, at, { f: fc, cx, cy }, false, check).rms;
        const pair = chooseInitialPair(tracks, sub, at, W, fc, cx, cy) ?? fallbackPair(sub);
        const r = incrementalRecon(tracks, sub, pair, at, { f: fc, cx, cy }, false, check, () => {}, true);
        return r.rms / Math.max(0.2, r.recon.poses.size / sub.length);
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        return Infinity;
      }
    };
    const g = 0.618;
    let a = hi - g * (hi - lo), b = lo + g * (hi - lo);
    let fa = score(a), fb = score(b);
    for (let k = 0; k < 5; k++) {
      check();
      if (fa < fb) { hi = b; b = a; fb = fa; a = hi - g * (hi - lo); fa = score(a); }
      else { lo = a; a = b; fa = fb; b = lo + g * (hi - lo); fb = score(b); }
    }
    f = Math.min(fa, fb) < bestErr ? (fa < fb ? a : b) : bestF;
  }
  check();

  // ── 3–5. full reconstruction ──
  const K: Intrinsics = { f, cx, cy };
  let recon: Recon;
  if (mode === 'tripod') {
    recon = tripodRecon(tracks, keyframes, at, K, o.refineFocal !== false && !o.fovDeg, check, (x) => progress('Solving camera', x)).recon;
  } else {
    const pair = initPair ? chooseInitialPair(tracks, keyframes, at, W, f, cx, cy) ?? initPair : fallbackPair(keyframes);
    recon = incrementalRecon(tracks, keyframes, pair, at, K, o.refineFocal !== false && !o.fovDeg, check, (x) => progress('Solving camera', x), false).recon;
  }
  K.f = recon.f;
  if (recon.poses.size < 2) throw new Error('Not enough trackable detail to solve the camera');

  // resect every frame against the keyframe reconstruction
  progress('Resolving all frames', 0);
  const solvedKf = keyframes.filter((k) => recon.poses.has(k));
  const poses: Pose[] = new Array(F);
  const resect = (fr: number, init: Pose): Pose => {
    const idx: number[] = [];
    const X: number[] = [], uv: number[] = [];
    for (const ti of tracksAt[fr]) {
      const P = recon.pts.get(ti);
      if (!P || recon.bad.has(obsKey(ti, fr))) continue;
      const p = at(ti, fr)!;
      idx.push(idx.length);
      X.push(P[0], P[1], P[2]);
      uv.push(p[0], p[1]);
    }
    if (mode === 'tripod') return idx.length >= 4 ? resectRotation(init, K, X, uv) : init;
    if (idx.length >= 8) {
      const r = refinePose(init, K, X, uv, idx, 15, 2, 5);
      return r.count >= 6 ? r.pose : init;
    }
    return init;
  };
  for (let fr = 0; fr < F; fr++) {
    if (fr % 8 === 0) {
      check();
      progress('Resolving all frames', fr / F);
    }
    const kp = recon.poses.get(fr);
    if (kp) {
      poses[fr] = kp;
      continue;
    }
    const prev = [...solvedKf].reverse().find((k) => k < fr), next = solvedKf.find((k) => k > fr);
    const init = prev !== undefined && next !== undefined
      ? interpolatePose(recon.poses.get(prev)!, recon.poses.get(next)!, (fr - prev) / (next - prev))
      : recon.poses.get(prev ?? next ?? solvedKf[0])!;
    poses[fr] = resect(fr, init);
  }
  // final bundle adjustment over (a stride of) every frame: end frames and the focal length use all observations
  check();
  progress('Refining solve', 0.2);
  const stride = Math.max(1, Math.ceil(F / 240));
  const all: Recon = { poses: new Map(), pts: recon.pts, bad: recon.bad, f: K.f };
  for (let fr = 0; fr < F; fr++) if (fr % stride === 0 || recon.poses.has(fr) || fr === F - 1) all.poses.set(fr, poses[fr]);
  const gauge = solvedKf[0];
  const refineF = o.refineFocal !== false && !o.fovDeg;
  runBA(all, tracks, at, K, gauge, false, 8, true, mode === 'tripod');
  check();
  progress('Refining solve', 0.6);
  const fin = runBA(all, tracks, at, K, gauge, refineF, 15, true, mode === 'tripod');
  K.f = fin.f;
  if (mode === 'tripod') {
    for (const [ti, X] of recon.pts) {
      const l = Math.hypot(X[0], X[1], X[2]) || 1;
      recon.pts.set(ti, [X[0] / l, X[1] / l, X[2] / l]);
    }
  }
  for (const [fr, p] of all.poses) poses[fr] = p;
  for (let fr = 0; fr < F; fr++) if (!all.poses.has(fr)) poses[fr] = resect(fr, poses[fr]);
  const cameras: SolvedCamera[] = poses.map((pose, fr) => ({ frame: fr, R: Array.from(pose.R), t: [...pose.t] as V3, error: 0, solved: true }));
  // per-frame and per-point errors
  const ptErr = new Map<number, number[]>();
  let ss = 0, n = 0;
  for (const cam of cameras) {
    const pose: Pose = { R: Float64Array.from(cam.R), t: cam.t };
    let s = 0, c = 0;
    for (const ti of tracksAt[cam.frame]) {
      const P = recon.pts.get(ti);
      if (!P) continue;
      const p = at(ti, cam.frame)!;
      const pr = project(pose, K, P);
      if (pr[2] <= 0) continue;
      const e = Math.hypot(pr[0] - p[0], pr[1] - p[1]);
      if (e > 25 || recon.bad.has(obsKey(ti, cam.frame))) continue;
      s += e * e;
      c++;
      let l = ptErr.get(ti);
      if (!l) ptErr.set(ti, (l = []));
      l.push(e);
    }
    cam.error = c ? Math.sqrt(s / c) : -1;
    cam.solved = c >= 4;
    ss += s;
    n += c;
  }
  const points: SolvedPoint[] = [];
  for (const [ti, X] of recon.pts) {
    const errs = ptErr.get(ti);
    if (!errs || errs.length < 2) continue;
    const e = median(errs);
    if (e > 3) continue;
    let first = -1, last = -1;
    for (let fr = 0; fr < F; fr++) if (Number.isFinite(tracks[ti].xy[fr * 2])) { if (first < 0) first = fr; last = fr; }
    points.push({ id: tracks[ti].id, X: [...X] as V3, error: e, first, last, color: tracks[ti].color });
  }
  progress('Done', 1);
  return { mode, f: K.f, cameras, points, keyframes: solvedKf, rms: n ? Math.sqrt(ss / n) : 0 };
}

export function isCancelled(e: unknown): boolean {
  return e instanceof Cancelled;
}

// ── keyframes & initial pair ────────────────────────────────────────────────

function selectKeyframes(tracks: Track2D[], tracksAt: number[][], F: number, W: number): number[] {
  const build = (dispThr: number) => {
    const kfs = [0];
    let k = 0;
    for (let f = 1; f < F; f++) {
      const base = new Set(tracksAt[k]);
      const common = tracksAt[f].filter((t) => base.has(t));
      const d = common.map((t) => Math.hypot(tracks[t].xy[f * 2] - tracks[t].xy[k * 2], tracks[t].xy[f * 2 + 1] - tracks[t].xy[k * 2 + 1]));
      const md = median(d);
      if (md > dispThr || common.length < Math.max(30, base.size * 0.55)) {
        const pick = f - 1 > k && common.length < 30 ? f - 1 : f;
        kfs.push(pick);
        k = pick;
      }
    }
    if (kfs[kfs.length - 1] !== F - 1) kfs.push(F - 1);
    return kfs;
  };
  let thr = W * 0.03;
  let kfs = build(thr);
  while (kfs.length > 70) {
    thr *= 1.4;
    kfs = build(thr);
  }
  return kfs;
}

type At = (ti: number, f: number) => [number, number] | null;

function correspondences(tracks: Track2D[], at: At, a: number, b: number): { ids: number[]; p1: Float64Array; p2: Float64Array } {
  const ids: number[] = [];
  const p1: number[] = [], p2: number[] = [];
  for (let ti = 0; ti < tracks.length; ti++) {
    const x = at(ti, a), y = at(ti, b);
    if (!x || !y) continue;
    ids.push(ti);
    p1.push(x[0], x[1]);
    p2.push(y[0], y[1]);
  }
  return { ids, p1: Float64Array.from(p1), p2: Float64Array.from(p2) };
}

function chooseInitialPair(tracks: Track2D[], kfs: number[], at: At, W: number, f: number, cx: number, cy: number): [number, number] | null {
  let best: [number, number] | null = null, bestScore = 0;
  const maxI = Math.min(kfs.length - 1, 8);
  for (let i = 0; i < maxI; i++) {
    for (let j = i + 1; j < Math.min(kfs.length, i + 7); j++) {
      const { p1, p2, ids } = correspondences(tracks, at, kfs[i], kfs[j]);
      if (ids.length < 30) continue;
      const Hres = homographyRansac(p1, p2, { threshold: Math.max(1, W * 0.0015), maxIter: 300, refine: false });
      const hRatio = Hres ? Hres.count / ids.length : 0;
      if (hRatio > 0.9) continue;
      const n1 = p1.map((v, k) => (k % 2 ? (v - cy) / f : (v - cx) / f)), n2 = p2.map((v, k) => (k % 2 ? (v - cy) / f : (v - cx) / f));
      const E = essentialRansac(n1, n2, 1.5 / f, 300);
      if (!E || E.count < 25) continue;
      const rp = recoverPose(E.E, n1, n2, E.inliers, 4 / f);
      if (!rp || rp.goodCount < 25 || rp.medianParallax < (1.2 * Math.PI) / 180) continue;
      const score = rp.goodCount * Math.min(1, rp.medianParallax / ((4 * Math.PI) / 180)) * (1 - hRatio);
      if (score > bestScore) {
        bestScore = score;
        best = [kfs[i], kfs[j]];
      }
    }
  }
  return best;
}

function fallbackPair(kfs: number[]): [number, number] {
  return [kfs[0], kfs[Math.min(kfs.length - 1, 2)]];
}

function subsample(kfs: number[], n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(kfs[Math.round((i * (kfs.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

// ── incremental reconstruction ──────────────────────────────────────────────

function incrementalRecon(
  tracks: Track2D[], kfs: number[], pair: [number, number], at: At, K0: Intrinsics, refineFocal: boolean,
  check: () => void, progress: (x: number) => void, quick: boolean,
): { recon: Recon; rms: number } {
  const K = { ...K0 };
  const recon: Recon = { poses: new Map(), pts: new Map(), bad: new Set(), f: K.f };
  const [a, b] = pair;
  const { ids, p1, p2 } = correspondences(tracks, at, a, b);
  const norm = (arr: Float64Array) => arr.map((v, k) => (k % 2 ? (v - K.cy) / K.f : (v - K.cx) / K.f));
  const n1 = norm(p1), n2 = norm(p2);
  const E = essentialRansac(n1, n2, 1.5 / K.f, quick ? 200 : 500);
  if (!E) throw new Error('No reliable two-view geometry');
  const rp = recoverPose(E.E, n1, n2, E.inliers, 4 / K.f);
  if (!rp || rp.goodCount < 12) throw new Error('Initial pair has too little parallax');
  recon.poses.set(a, { R: Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1), t: [0, 0, 0] });
  recon.poses.set(b, rp.pose);
  ids.forEach((ti, k) => {
    if (rp.good[k]) recon.pts.set(ti, [rp.points[k * 3], rp.points[k * 3 + 1], rp.points[k * 3 + 2]]);
  });
  runBA(recon, tracks, at, K, a, false, quick ? 8 : 15, false);
  K.f = recon.f;
  // registration order: forward from b, the frames between a and b, then backward from a
  const ia = kfs.indexOf(a), ib = kfs.indexOf(b);
  const order = [...kfs.slice(ib + 1), ...kfs.slice(ia + 1, ib), ...kfs.slice(0, ia).reverse()];
  let added = 0;
  order.forEach((k, step) => {
    check();
    progress((step + 1) / (order.length + 2));
    // 2D–3D correspondences
    const idx: number[] = [];
    const X: number[] = [], uv: number[] = [];
    const tis: number[] = [];
    for (const [ti, P] of recon.pts) {
      const p = at(ti, k);
      if (!p || recon.bad.has(obsKey(ti, k))) continue;
      idx.push(idx.length);
      tis.push(ti);
      X.push(P[0], P[1], P[2]);
      uv.push(p[0], p[1]);
    }
    if (idx.length < 8) return;
    // initial guess from the nearest registered keyframe
    let nearest = -1, nd = Infinity;
    for (const r of recon.poses.keys()) if (Math.abs(r - k) < nd) { nd = Math.abs(r - k); nearest = r; }
    const guess = refinePose(recon.poses.get(nearest)!, K, X, uv, idx, 15, 3, 4);
    const rs = pnpRansac(X, uv, idx, K, 3, quick ? 120 : 300);
    const best = rs && rs.count > guess.count ? rs : guess;
    if (best.count < Math.max(8, idx.length * 0.25)) return;
    recon.poses.set(k, best.pose);
    tis.forEach((ti, q) => {
      if (!best.inliers[q]) recon.bad.add(obsKey(ti, k));
    });
    triangulateNew(recon, tracks, at, K, k);
    added++;
    if (!quick && (added % 3 === 0 || recon.poses.size < 8)) {
      runBA(recon, tracks, at, K, a, false, 10, false);
    }
  });
  const res = runBA(recon, tracks, at, K, a, refineFocal, quick ? 12 : 30, true);
  recon.f = res.f;
  if (!quick && refineFocal) {
    // a second pass with outliers pruned at the refined focal
    const res2 = runBA(recon, tracks, at, { ...K, f: recon.f }, a, true, 20, true);
    recon.f = res2.f;
    return { recon, rms: res2.rms };
  }
  return { recon, rms: res.rms };
}

function triangulateNew(recon: Recon, tracks: Track2D[], at: At, K: Intrinsics, k: number): void {
  const Pk = recon.poses.get(k)!;
  const ck = cameraCenter(Pk);
  const regs = [...recon.poses.keys()];
  for (let ti = 0; ti < tracks.length; ti++) {
    if (recon.pts.has(ti)) continue;
    const pk = at(ti, k);
    if (!pk) continue;
    // all registered views of this track, keeping the widest baseline partner first
    const views: number[] = [];
    for (const r of regs) if (r !== k && at(ti, r) && !recon.bad.has(obsKey(ti, r))) views.push(r);
    if (!views.length) continue;
    views.sort((x, y) => Math.abs(y - k) - Math.abs(x - k));
    const use = [k, ...views.slice(0, 5)];
    const poses = use.map((r) => recon.poses.get(r)!);
    const obs = use.flatMap((r) => {
      const p = at(ti, r)!;
      return [(p[0] - K.cx) / K.f, (p[1] - K.cy) / K.f];
    });
    const X = triangulate(poses, obs);
    if (!X) continue;
    let ok = true;
    for (let q = 0; q < use.length && ok; q++) {
      const pr = project(poses[q], K, X);
      const p = at(ti, use[q])!;
      if (pr[2] <= 0 || Math.hypot(pr[0] - p[0], pr[1] - p[1]) > 3) ok = false;
    }
    if (!ok) continue;
    if (parallaxAngle(X, ck, cameraCenter(poses[1])) < (1 * Math.PI) / 180) continue;
    recon.pts.set(ti, X);
  }
}

/** Global bundle adjustment over the registered keyframes; prunes outlier points/observations. */
function runBA(recon: Recon, tracks: Track2D[], at: At, K: Intrinsics, gaugeFrame: number, refineFocal: boolean, iterations: number, prune: boolean, rotationOnly = false): { rms: number; f: number } {
  const frames = [...recon.poses.keys()].sort((x, y) => x - y);
  const camOf = new Map(frames.map((fr, i) => [fr, i]));
  const ptIds = [...recon.pts.keys()];
  const points = new Float64Array(ptIds.length * 3);
  ptIds.forEach((ti, i) => points.set(recon.pts.get(ti)!, i * 3));
  const obs: BAObservation[] = [];
  ptIds.forEach((ti, pi) => {
    for (const fr of frames) {
      const p = at(ti, fr);
      if (!p || recon.bad.has(obsKey(ti, fr))) continue;
      obs.push({ cam: camOf.get(fr)!, pt: pi, u: p[0], v: p[1] });
    }
  });
  const fixed = new Set<number>([camOf.get(gaugeFrame) ?? 0]);
  const prob = {
    poses: frames.map((fr) => recon.poses.get(fr)!), fixed, points, obs, f: K.f, cx: K.cx, cy: K.cy, refineFocal, rotationOnly,
  };
  const r = bundleAdjust(prob, { iterations, huber: 1.5 });
  frames.forEach((fr, i) => recon.poses.set(fr, prob.poses[i]));
  recon.f = prob.f;
  const Kn = { ...K, f: prob.f };
  ptIds.forEach((ti, i) => recon.pts.set(ti, [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]]));
  let rms = r.finalRms;
  if (prune) {
    // drop observations with large error and points left with < 2 good views; the threshold comes from the
    // median absolute error (robust — an RMS-based threshold is inflated by the very outliers it should remove)
    const errs: number[] = [];
    ptIds.forEach((ti, i) => {
      const X = points.subarray(i * 3, i * 3 + 3);
      for (const fr of frames) {
        const p = at(ti, fr);
        if (!p || recon.bad.has(obsKey(ti, fr))) continue;
        const pr = project(recon.poses.get(fr)!, Kn, X);
        if (pr[2] > 0) errs.push(Math.hypot(pr[0] - p[0], pr[1] - p[1]));
      }
    });
    const thr = Math.max(1.25, 3 * 1.4826 * median(errs));
    let ss = 0, n = 0;
    ptIds.forEach((ti, i) => {
      let good = 0;
      const X = points.subarray(i * 3, i * 3 + 3);
      for (const fr of frames) {
        const p = at(ti, fr);
        if (!p || recon.bad.has(obsKey(ti, fr))) continue;
        const pr = project(recon.poses.get(fr)!, Kn, X);
        const e = pr[2] > 0 ? Math.hypot(pr[0] - p[0], pr[1] - p[1]) : Infinity;
        if (e > thr) recon.bad.add(obsKey(ti, fr));
        else { good++; ss += e * e; n++; }
      }
      if (good < 2) recon.pts.delete(ti);
    });
    rms = n ? Math.sqrt(ss / n) : r.finalRms;
  }
  void tracks;
  return { rms, f: prob.f };
}

function interpolatePose(a: Pose, b: Pose, t: number): Pose {
  const q = slerp(matToQuat(a.R), matToQuat(b.R), t);
  const R = quatToMat(q);
  // interpolate camera centres, not translations
  const ca = cameraCenter(a), cb = cameraCenter(b);
  const c: V3 = [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t];
  const Rc = mat3Vec(R, c);
  return { R, t: [-Rc[0], -Rc[1], -Rc[2]] };
}

// ── tripod (rotation-only) ──────────────────────────────────────────────────

function tripodRecon(tracks: Track2D[], kfs: number[], at: At, K0: Intrinsics, refineFocal: boolean, check: () => void, progress: (x: number) => void = () => {}): { recon: Recon; rms: number } {
  const K = { ...K0 };
  const recon: Recon = { poses: new Map(), pts: new Map(), bad: new Set(), f: K.f };
  const I3 = Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
  recon.poses.set(kfs[0], { R: I3, t: [0, 0, 0] });
  let prevR: Mat = I3;
  for (let i = 1; i < kfs.length; i++) {
    check();
    progress(i / (kfs.length + 1));
    const a = kfs[i - 1], b = kfs[i];
    const { ids, p1, p2 } = correspondences(tracks, at, a, b);
    if (ids.length < 6) continue;
    const A = new Float64Array(ids.length * 3), B = new Float64Array(ids.length * 3);
    for (let k = 0; k < ids.length; k++) {
      A.set(bearing((p1[k * 2] - K.cx) / K.f, (p1[k * 2 + 1] - K.cy) / K.f), k * 3);
      B.set(bearing((p2[k * 2] - K.cx) / K.f, (p2[k * 2 + 1] - K.cy) / K.f), k * 3);
    }
    const r = rotationRansac(A, B, ids.length, 2 / K.f);
    if (!r || r.count < 6) continue;
    // camera rotation: Xc_b = R_rel · Xc_a
    prevR = mat3Mul(r.R, recon.poses.has(a) ? recon.poses.get(a)!.R : prevR);
    recon.poses.set(b, { R: prevR, t: [0, 0, 0] });
  }
  // points on the unit sphere from their first registered observation
  for (let ti = 0; ti < tracks.length; ti++) {
    for (const k of kfs) {
      const p = at(ti, k);
      const P = recon.poses.get(k);
      if (!p || !P) continue;
      const d = bearing((p[0] - K.cx) / K.f, (p[1] - K.cy) / K.f);
      recon.pts.set(ti, mat3Vec(mat3T(P.R), d));
      break;
    }
  }
  // points seen by a single keyframe carry no information
  for (const ti of [...recon.pts.keys()]) {
    let views = 0;
    for (const k of kfs) if (recon.poses.has(k) && at(ti, k)) views++;
    if (views < 2) recon.pts.delete(ti);
  }
  const res = runBA(recon, tracks, at, K, kfs[0], refineFocal, 25, true, true);
  // re-project points onto the unit sphere (their depth is unobservable)
  for (const [ti, X] of recon.pts) {
    const l = Math.hypot(X[0], X[1], X[2]) || 1;
    recon.pts.set(ti, [X[0] / l, X[1] / l, X[2] / l]);
  }
  recon.f = res.f;
  return { recon, rms: res.rms };
}

function resectRotation(init: Pose, K: Intrinsics, X: number[], uv: number[]): Pose {
  const n = X.length / 3;
  const A = new Float64Array(n * 3), B = new Float64Array(n * 3);
  for (let k = 0; k < n; k++) {
    const l = Math.hypot(X[k * 3], X[k * 3 + 1], X[k * 3 + 2]) || 1;
    A.set([X[k * 3] / l, X[k * 3 + 1] / l, X[k * 3 + 2] / l], k * 3);
    B.set(bearing((uv[k * 2] - K.cx) / K.f, (uv[k * 2 + 1] - K.cy) / K.f), k * 3);
  }
  const r = rotationRansac(A, B, n, 3 / K.f);
  return r && r.count >= 4 ? { R: r.R, t: [0, 0, 0] } : init;
}
