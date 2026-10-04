// ─────────────────────────────────────────────────────────────────────────────
// Planar (perspective corner-pin) tracker.
//
// A cloud of Shi–Tomasi features inside the user's quad is tracked frame to
// frame with pyramidal KLT (forward–backward checked). Each feature remembers
// its position in the REFERENCE frame, so the homography is always estimated
// reference → current (RANSAC + normalised DLT + Gauss–Newton) instead of
// chaining frame-to-frame matrices: drift is bounded by the averaged feature
// drift, not compounded. Lost features are replenished inside the current
// quad and back-projected to the reference through H⁻¹.
// ─────────────────────────────────────────────────────────────────────────────

import { detectCorners } from './features';
import { applyH, dltHomography, homographyRansac, invertH, mulH, pointInPolygon, refineHomography } from './homography';
import { trackFlow } from './klt';
import { sample, type Gray, type Pyramid } from './image';
import type { Mat } from './linalg';

export interface PlanarOptions {
  maxFeatures?: number;
  /** RANSAC inlier threshold (pixels) */
  threshold?: number;
}

export interface PlanarStep {
  /** UL, UR, LR, LL corners (xy × 4) in the current frame */
  quad: number[];
  /** reference → current homography */
  H: Mat;
  /** 0..1 */
  confidence: number;
  inliers: number;
  /** current positions of the inlier features (xy pairs) for display */
  features: number[];
}

export class PlanarTracker {
  private ref: number[] = [];
  private cur: number[] = [];
  private refQuad: number[];
  private prev: Pyramid;
  private refImg: Gray;
  private H: Mat = Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
  private Hprev: Mat | null = null;
  private target: number;
  private o: Required<PlanarOptions>;

  constructor(refFrame: Pyramid, quad: number[], o: PlanarOptions = {}) {
    this.o = { maxFeatures: o.maxFeatures ?? 220, threshold: o.threshold ?? 2.5 };
    this.refQuad = quad.slice(0, 8);
    this.prev = refFrame;
    this.refImg = refFrame.levels[0];
    this.addFeatures(refFrame, this.refQuad, this.o.maxFeatures);
    this.target = this.ref.length / 2;
  }

  get featureCount(): number {
    return this.ref.length / 2;
  }

  private addFeatures(frame: Pyramid, quad: number[], count: number): void {
    const img = frame.levels[0];
    // inset the quad slightly so windows don't straddle the plane's border
    const cx = (quad[0] + quad[2] + quad[4] + quad[6]) / 4, cy = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    const inset = quad.map((v, i) => (i % 2 ? cy + (v - cy) * 0.94 : cx + (v - cx) * 0.94));
    const area = Math.abs(polyArea(quad));
    const minDist = Math.max(4, Math.sqrt(area / Math.max(1, count)) * 0.6);
    const corners = detectCorners(img, {
      maxCorners: count, minDistance: minDist, quality: 0.005, border: 6,
      mask: (x, y) => pointInPolygon(x, y, inset), avoid: this.cur,
    });
    const inv = invertH(this.H);
    if (!inv) return;
    for (const c of corners) {
      const r = applyH(inv, c.x, c.y);
      this.cur.push(c.x, c.y);
      this.ref.push(r[0], r[1]);
    }
  }

  /** Advance to the next frame (forward or backward in time — the tracker doesn't care). */
  step(next: Pyramid): PlanarStep | null {
    if (this.cur.length < 8) return null;
    // constant-velocity prediction of where features land
    let guess: Float32Array | undefined;
    if (this.Hprev) {
      const invPrev = invertH(this.Hprev);
      if (invPrev) {
        const vel = mulH(this.H, invPrev);
        guess = new Float32Array(this.cur.length);
        for (let i = 0; i < this.cur.length; i += 2) {
          const p = applyH(vel, this.cur[i], this.cur[i + 1]);
          guess[i] = p[0];
          guess[i + 1] = p[1];
        }
      }
    }
    const flow = trackFlow(this.prev, next, this.cur, { radius: 8, fbThreshold: 0.8, maxResidual: 30 }, guess);
    const src: number[] = [], dst: number[] = [], keep: number[] = [];
    for (let i = 0; i < flow.status.length; i++) {
      if (!flow.status[i]) continue;
      src.push(this.ref[i * 2], this.ref[i * 2 + 1]);
      dst.push(flow.pts[i * 2], flow.pts[i * 2 + 1]);
      keep.push(i);
    }
    if (src.length < 8) return null;
    const res = homographyRansac(src, dst, { threshold: this.o.threshold, maxIter: 600 });
    if (!res || res.count < 6) return null;
    let ref: number[] = [], cur: number[] = [];
    for (let k = 0; k < keep.length; k++) {
      if (!res.inliers[k]) continue;
      ref.push(src[k * 2], src[k * 2 + 1]);
      cur.push(dst[k * 2], dst[k * 2 + 1]);
    }
    // drift removal: align every inlier against its reference patch warped by the current estimate
    let Hcur = res.H;
    const aligned = this.alignToReference(next.levels[0], Hcur, ref, cur);
    if (aligned.ref.length >= 16) {
      const idx = Array.from({ length: aligned.ref.length / 2 }, (_, i) => i);
      const H2 = dltHomography(aligned.ref, aligned.cur, idx);
      if (H2) {
        Hcur = refineHomography(H2, aligned.ref, aligned.cur, idx, 6);
        ref = aligned.ref;
        cur = aligned.cur;
      }
    }
    const features = cur.slice();
    this.ref = ref;
    this.cur = cur;
    this.Hprev = this.H;
    this.H = Hcur;
    this.prev = next;
    const quad: number[] = [];
    for (let i = 0; i < 8; i += 2) quad.push(...applyH(Hcur, this.refQuad[i], this.refQuad[i + 1]));
    // replenish when the cloud thins out
    if (this.cur.length < this.target * 0.6 && Math.abs(polyArea(quad)) > 64) {
      this.addFeatures(next, quad, Math.round(this.target - this.cur.length));
    }
    const ratio = res.count / Math.max(1, keep.length);
    const confidence = Math.max(0, Math.min(1, ratio * (1 - Math.min(1, res.rms / (this.o.threshold * 1.5))) * Math.min(1, res.count / 20)));
    return { quad, H: Hcur, confidence, inliers: res.count, features };
  }

  /**
   * Inverse-compositional translation alignment of each feature window against the reference
   * image resampled through H⁻¹ (an exact projective template, so rotation, scale and
   * foreshortening don't bias the match). Features that fail to converge are dropped.
   */
  private alignToReference(img: Gray, H: Mat, ref: number[], cur: number[]): { ref: number[]; cur: number[] } {
    const Hinv = invertH(H);
    if (!Hinv) return { ref, cur };
    const r = 6, win = 2 * r + 1, N = win * win;
    const T = new Float32Array(N), Tx = new Float32Array(N), Ty = new Float32Array(N);
    const outRef: number[] = [], outCur: number[] = [];
    for (let k = 0; k < cur.length; k += 2) {
      const px = cur[k], py = cur[k + 1];
      if (px < r + 1 || py < r + 1 || px > img.w - r - 2 || py > img.h - r - 2) continue;
      // projective template centred on the current estimate (one extra ring for gradients)
      const W2 = win + 2;
      const big = new Float32Array(W2 * W2);
      for (let v = -r - 1, q = 0; v <= r + 1; v++)
        for (let u = -r - 1; u <= r + 1; u++, q++) {
          const s = applyH(Hinv, px + u, py + v);
          big[q] = sample(this.refImg, s[0], s[1]);
        }
      let mean = 0;
      for (let v = 0, q = 0; v < win; v++)
        for (let u = 0; u < win; u++, q++) {
          const c = (v + 1) * W2 + (u + 1);
          T[q] = big[c];
          Tx[q] = (big[c + 1] - big[c - 1]) / 2;
          Ty[q] = (big[c + W2] - big[c - W2]) / 2;
          mean += big[c];
        }
      mean /= N;
      let a = 0, b = 0, c = 0, ss = 0;
      for (let q = 0; q < N; q++) {
        a += Tx[q] * Tx[q]; b += Tx[q] * Ty[q]; c += Ty[q] * Ty[q];
        ss += (T[q] - mean) ** 2;
      }
      const det = a * c - b * b;
      const tstd = Math.sqrt(ss / N);
      if (det < 1e-6 * N * N || tstd < 1.5) continue;
      let x = px, y = py, ok = true;
      for (let it = 0; it < 10; it++) {
        let jm = 0, jq = 0;
        const J = new Float32Array(N);
        for (let v = -r, q = 0; v <= r; v++)
          for (let u = -r; u <= r; u++, q++) {
            const val = sample(img, x + u, y + v);
            J[q] = val;
            jm += val;
            jq += val * val;
          }
        jm /= N;
        const jstd = Math.sqrt(Math.max(1e-9, jq / N - jm * jm));
        const gain = jstd / tstd;
        let bx = 0, by = 0;
        for (let q = 0; q < N; q++) {
          const e = (J[q] - jm) / gain - (T[q] - mean);
          bx += e * Tx[q];
          by += e * Ty[q];
        }
        const dx = (c * bx - b * by) / det, dy = (a * by - b * bx) / det;
        x -= dx;
        y -= dy;
        if (Math.hypot(x - px, y - py) > 3) { ok = false; break; }
        if (dx * dx + dy * dy < 1e-4) break;
      }
      if (!ok) continue;
      outRef.push(ref[k], ref[k + 1]);
      outCur.push(x, y);
    }
    return { ref: outRef, cur: outCur };
  }
}

export function polyArea(q: ArrayLike<number>): number {
  let a = 0;
  const n = q.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) a += q[j * 2] * q[i * 2 + 1] - q[i * 2] * q[j * 2 + 1];
  return a / 2;
}
