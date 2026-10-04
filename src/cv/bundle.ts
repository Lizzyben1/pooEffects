// ─────────────────────────────────────────────────────────────────────────────
// Sparse bundle adjustment.
//
// Levenberg–Marquardt over camera poses (6 DOF each, rotation updated on the
// left by exp(δω)), an optional shared focal length, and 3D points. The point
// blocks are eliminated with the Schur complement, so each iteration solves a
// dense (6·C + 1)² reduced camera system by Cholesky — cheap for the keyframe
// sets the camera tracker optimises (tens of cameras, hundreds of points).
// Residuals are Huber-weighted pixel reprojection errors (IRLS).
// ─────────────────────────────────────────────────────────────────────────────

import { choleskySolve, mat3Mul, mat3Vec, orthonormalize, rodrigues, type Mat, type V3 } from './linalg';
import type { Pose } from './geometry3d';

export interface BAObservation {
  cam: number;
  pt: number;
  u: number;
  v: number;
}

export interface BAProblem {
  poses: Pose[];
  /** cameras whose pose is held constant (gauge) */
  fixed: Set<number>;
  /** xyz × N */
  points: Float64Array;
  obs: BAObservation[];
  f: number;
  cx: number;
  cy: number;
  refineFocal: boolean;
  /** tripod solve: cameras only rotate (translations stay fixed) */
  rotationOnly?: boolean;
}

export interface BAOptions {
  iterations?: number;
  /** Huber threshold in pixels */
  huber?: number;
  /** stop when the relative cost decrease is below this */
  tolerance?: number;
  /** abort check, polled between iterations */
  cancelled?: () => boolean;
}

export interface BAResult {
  initialRms: number;
  finalRms: number;
  iterations: number;
}

function projectObs(p: Pose, f: number, cx: number, cy: number, X: ArrayLike<number>): [number, number, number] {
  const RX = mat3Vec(p.R, X);
  const z = RX[2] + p.t[2];
  return [cx + (f * (RX[0] + p.t[0])) / z, cy + (f * (RX[1] + p.t[1])) / z, z];
}

function robustCost(prob: BAProblem, poses: Pose[], pts: Float64Array, f: number, huber: number): { cost: number; rms: number } {
  let c = 0, ss = 0;
  for (const o of prob.obs) {
    const pr = projectObs(poses[o.cam], f, prob.cx, prob.cy, pts.subarray(o.pt * 3, o.pt * 3 + 3));
    if (pr[2] <= 1e-9) {
      c += 2 * huber * 50;
      ss += 2500;
      continue;
    }
    const r = Math.hypot(pr[0] - o.u, pr[1] - o.v);
    ss += r * r;
    c += r <= huber ? r * r : 2 * huber * r - huber * huber;
  }
  return { cost: c, rms: Math.sqrt(ss / Math.max(1, prob.obs.length)) };
}

/** Optimise poses, points (and focal) in place. */
export function bundleAdjust(prob: BAProblem, o: BAOptions = {}): BAResult {
  const huber = o.huber ?? 2;
  const maxIt = o.iterations ?? 20;
  const tol = o.tolerance ?? 1e-6;
  const nC = prob.poses.length, nP = prob.points.length / 3;
  // camera-side parameter indexing
  const camIndex = new Int32Array(nC).fill(-1);
  let D = 0;
  const block = prob.rotationOnly ? 3 : 6;
  for (let c = 0; c < nC; c++) if (!prob.fixed.has(c)) { camIndex[c] = D; D += block; }
  const fIndex = prob.refineFocal ? D++ : -1;
  // observations per point
  const byPoint: number[][] = Array.from({ length: nP }, () => []);
  prob.obs.forEach((ob, k) => byPoint[ob.pt].push(k));

  let { cost, rms } = robustCost(prob, prob.poses, prob.points, prob.f, huber);
  const initialRms = rms;
  let lambda = 1e-3;
  let it = 0;
  // per-observation Jacobian storage
  const nO = prob.obs.length;
  const Jc = new Float64Array(nO * 14); // 2 rows × 7 (6 pose + focal)
  const Jp = new Float64Array(nO * 6); // 2 rows × 3
  const res = new Float64Array(nO * 2);
  const wts = new Float64Array(nO);
  for (; it < maxIt; it++) {
    if (o.cancelled?.()) break;
    // ── linearise ──
    for (let k = 0; k < nO; k++) {
      const ob = prob.obs[k];
      const P = prob.poses[ob.cam];
      const X = prob.points.subarray(ob.pt * 3, ob.pt * 3 + 3);
      const RX = mat3Vec(P.R, X);
      const xc = [RX[0] + P.t[0], RX[1] + P.t[1], RX[2] + P.t[2]];
      if (xc[2] <= 1e-9) {
        wts[k] = 0;
        continue;
      }
      const iz = 1 / xc[2];
      const f = prob.f;
      const rx = prob.cx + f * xc[0] * iz - ob.u, ry = prob.cy + f * xc[1] * iz - ob.v;
      res[k * 2] = rx;
      res[k * 2 + 1] = ry;
      const r = Math.hypot(rx, ry);
      wts[k] = r <= huber ? 1 : huber / r;
      const a0 = f * iz, a2 = -f * xc[0] * iz * iz, b1 = f * iz, b2 = -f * xc[1] * iz * iz;
      // d xc / d ω = −[RX]×
      const S0 = [0, RX[2], -RX[1]], S1 = [-RX[2], 0, RX[0]], S2 = [RX[1], -RX[0], 0];
      const jx = Jc.subarray(k * 14, k * 14 + 7), jy = Jc.subarray(k * 14 + 7, k * 14 + 14);
      for (let q = 0; q < 3; q++) {
        jx[q] = a0 * S0[q] + a2 * S2[q];
        jy[q] = b1 * S1[q] + b2 * S2[q];
      }
      jx[3] = a0; jx[4] = 0; jx[5] = a2;
      jy[3] = 0; jy[4] = b1; jy[5] = b2;
      jx[6] = xc[0] * iz;
      jy[6] = xc[1] * iz;
      // d proj / d X = dproj/dxc · R
      const R = P.R;
      for (let q = 0; q < 3; q++) {
        Jp[k * 6 + q] = a0 * R[q] + a2 * R[6 + q];
        Jp[k * 6 + 3 + q] = b1 * R[3 + q] + b2 * R[6 + q];
      }
    }
    // ── normal equations: camera block A (D×D), point blocks V (3×3), coupling W ──
    const A = new Float64Array(D * D), gC = new Float64Array(D);
    const V = new Float64Array(nP * 9), gP = new Float64Array(nP * 3);
    // camera-side index list per observation
    const idxOf = (ob: BAObservation): number[] => {
      const out: number[] = [];
      const ci = camIndex[ob.cam];
      for (let q = 0; q < 6; q++) out.push(ci >= 0 && q < block ? ci + q : -1);
      out.push(fIndex);
      return out;
    };
    const obsIdx = prob.obs.map(idxOf);
    for (let k = 0; k < nO; k++) {
      const w = wts[k];
      if (!w) continue;
      const ob = prob.obs[k];
      const ids = obsIdx[k];
      const rx = res[k * 2], ry = res[k * 2 + 1];
      const jx = Jc.subarray(k * 14, k * 14 + 7), jy = Jc.subarray(k * 14 + 7, k * 14 + 14);
      for (let a = 0; a < 7; a++) {
        const ia = ids[a];
        if (ia < 0) continue;
        gC[ia] -= w * (jx[a] * rx + jy[a] * ry);
        for (let b = 0; b < 7; b++) {
          const ib = ids[b];
          if (ib < 0) continue;
          A[ia * D + ib] += w * (jx[a] * jx[b] + jy[a] * jy[b]);
        }
      }
      const px = Jp.subarray(k * 6, k * 6 + 3), py = Jp.subarray(k * 6 + 3, k * 6 + 6);
      const vb = ob.pt * 9;
      for (let a = 0; a < 3; a++) {
        gP[ob.pt * 3 + a] -= w * (px[a] * rx + py[a] * ry);
        for (let b = 0; b < 3; b++) V[vb + a * 3 + b] += w * (px[a] * px[b] + py[a] * py[b]);
      }
    }
    // ── LM loop with Schur complement ──
    let accepted = false;
    for (let tries = 0; tries < 10 && !accepted; tries++) {
      const S = new Float64Array(D * D);
      for (let i = 0; i < D * D; i++) S[i] = A[i];
      for (let i = 0; i < D; i++) S[i * D + i] += lambda * (A[i * D + i] + 1e-6);
      const b = Float64Array.from(gC);
      const Vinv = new Float64Array(nP * 9);
      const valid = new Uint8Array(nP);
      for (let p = 0; p < nP; p++) {
        const m = V.subarray(p * 9, p * 9 + 9);
        const a = [m[0] * (1 + lambda) + 1e-9, m[1], m[2], m[3], m[4] * (1 + lambda) + 1e-9, m[5], m[6], m[7], m[8] * (1 + lambda) + 1e-9];
        const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
        if (!(Math.abs(det) > 1e-30) || byPoint[p].length < 2) continue;
        const id = 1 / det;
        Vinv.set([
          (a[4] * a[8] - a[5] * a[7]) * id, (a[2] * a[7] - a[1] * a[8]) * id, (a[1] * a[5] - a[2] * a[4]) * id,
          (a[5] * a[6] - a[3] * a[8]) * id, (a[0] * a[8] - a[2] * a[6]) * id, (a[2] * a[3] - a[0] * a[5]) * id,
          (a[3] * a[7] - a[4] * a[6]) * id, (a[1] * a[6] - a[0] * a[7]) * id, (a[0] * a[4] - a[1] * a[3]) * id,
        ], p * 9);
        valid[p] = 1;
      }
      // W_k = w · Jcᵀ Jp (7×3) per observation
      const Wk = new Float64Array(nO * 21);
      for (let k = 0; k < nO; k++) {
        const w = wts[k];
        if (!w || !valid[prob.obs[k].pt]) continue;
        const jx = Jc.subarray(k * 14, k * 14 + 7), jy = Jc.subarray(k * 14 + 7, k * 14 + 14);
        const px = Jp.subarray(k * 6, k * 6 + 3), py = Jp.subarray(k * 6 + 3, k * 6 + 6);
        for (let a = 0; a < 7; a++) for (let q = 0; q < 3; q++) Wk[k * 21 + a * 3 + q] = w * (jx[a] * px[q] + jy[a] * py[q]);
      }
      // S −= Σ_p W V⁻¹ Wᵀ ;  b −= Σ_p W V⁻¹ gP
      const WV = new Float64Array(21);
      for (let p = 0; p < nP; p++) {
        if (!valid[p]) continue;
        const vi = Vinv.subarray(p * 9, p * 9 + 9);
        const gp = gP.subarray(p * 3, p * 3 + 3);
        const vg = [vi[0] * gp[0] + vi[1] * gp[1] + vi[2] * gp[2], vi[3] * gp[0] + vi[4] * gp[1] + vi[5] * gp[2], vi[6] * gp[0] + vi[7] * gp[1] + vi[8] * gp[2]];
        const list = byPoint[p];
        for (const k1 of list) {
          if (!wts[k1]) continue;
          const W1 = Wk.subarray(k1 * 21, k1 * 21 + 21);
          const ids1 = obsIdx[k1];
          for (let a = 0; a < 7; a++) {
            for (let q = 0; q < 3; q++) WV[a * 3 + q] = W1[a * 3] * vi[q] + W1[a * 3 + 1] * vi[3 + q] + W1[a * 3 + 2] * vi[6 + q];
            const ia = ids1[a];
            if (ia >= 0) b[ia] -= W1[a * 3] * vg[0] + W1[a * 3 + 1] * vg[1] + W1[a * 3 + 2] * vg[2];
          }
          for (const k2 of list) {
            if (!wts[k2]) continue;
            const W2 = Wk.subarray(k2 * 21, k2 * 21 + 21);
            const ids2 = obsIdx[k2];
            for (let a = 0; a < 7; a++) {
              const ia = ids1[a];
              if (ia < 0) continue;
              const r0 = WV[a * 3], r1 = WV[a * 3 + 1], r2 = WV[a * 3 + 2];
              for (let c = 0; c < 7; c++) {
                const ic = ids2[c];
                if (ic < 0) continue;
                S[ia * D + ic] -= r0 * W2[c * 3] + r1 * W2[c * 3 + 1] + r2 * W2[c * 3 + 2];
              }
            }
          }
        }
      }
      const dc = D ? choleskySolve(S, b, D) : new Float64Array(0);
      if (!dc) {
        lambda *= 10;
        continue;
      }
      // back-substitute points: δp = V⁻¹ (gP − Σ Wᵀ δc)
      const newPts = Float64Array.from(prob.points);
      for (let p = 0; p < nP; p++) {
        if (!valid[p]) continue;
        const r = [gP[p * 3], gP[p * 3 + 1], gP[p * 3 + 2]];
        for (const k of byPoint[p]) {
          if (!wts[k]) continue;
          const W = Wk.subarray(k * 21, k * 21 + 21);
          const ids = obsIdx[k];
          for (let a = 0; a < 7; a++) {
            const ia = ids[a];
            if (ia < 0) continue;
            r[0] -= W[a * 3] * dc[ia];
            r[1] -= W[a * 3 + 1] * dc[ia];
            r[2] -= W[a * 3 + 2] * dc[ia];
          }
        }
        const vi = Vinv.subarray(p * 9, p * 9 + 9);
        newPts[p * 3] += vi[0] * r[0] + vi[1] * r[1] + vi[2] * r[2];
        newPts[p * 3 + 1] += vi[3] * r[0] + vi[4] * r[1] + vi[5] * r[2];
        newPts[p * 3 + 2] += vi[6] * r[0] + vi[7] * r[1] + vi[8] * r[2];
      }
      const newPoses: Pose[] = prob.poses.map((P, c) => {
        const ci = camIndex[c];
        if (ci < 0) return P;
        const R: Mat = mat3Mul(rodrigues([dc[ci], dc[ci + 1], dc[ci + 2]]), P.R);
        const t: V3 = block === 6 ? [P.t[0] + dc[ci + 3], P.t[1] + dc[ci + 4], P.t[2] + dc[ci + 5]] : P.t;
        return { R, t };
      });
      const newF = fIndex >= 0 ? Math.max(prob.f * 0.2, prob.f + dc[fIndex]) : prob.f;
      const nc = robustCost(prob, newPoses, newPts, newF, huber);
      if (nc.cost < cost) {
        const rel = (cost - nc.cost) / Math.max(1e-12, cost);
        prob.points.set(newPts);
        prob.poses.forEach((_, c) => {
          if (camIndex[c] >= 0) prob.poses[c] = { R: orthonormalize(newPoses[c].R), t: newPoses[c].t };
        });
        prob.f = newF;
        cost = nc.cost;
        rms = nc.rms;
        lambda = Math.max(1e-9, lambda / 4);
        accepted = true;
        if (rel < tol) {
          it = maxIt;
        }
      } else {
        lambda *= 6;
      }
    }
    if (!accepted) break;
  }
  return { initialRms, finalRms: rms, iterations: it };
}
