// ─────────────────────────────────────────────────────────────────────────────
// Pyramidal Lucas–Kanade optical flow (Bouguet's formulation) and the
// template tracker behind the After Effects-style point tracker.
//
//  * trackFlow()    — sparse KLT for many small windows at once (camera
//                     tracker, planar tracker, roto propagation), with a
//                     forward–backward consistency check.
//  * trackFeature() — one user-defined feature region searched inside a
//                     search region: coarse-to-fine normalised cross
//                     correlation (exhaustive at the coarsest level, local
//                     refinement on the way down) followed by sub-pixel
//                     Lucas–Kanade alignment with gain/bias compensation.
//                     The final NCC score becomes the tracker's confidence.
// ─────────────────────────────────────────────────────────────────────────────

import { boxStats, integral, sample, samplePlane, type Gray, type Integral, type Pyramid } from './image';

export interface FlowOptions {
  /** half window size (window = 2r+1) */
  radius?: number;
  maxIter?: number;
  /** stop when the update is smaller than this (pixels) */
  epsilon?: number;
  /** minimum normalised min-eigenvalue of the gradient matrix */
  minEigen?: number;
  /** maximum forward–backward error (pixels at level 0); 0 disables the check */
  fbThreshold?: number;
  /** maximum mean absolute intensity residual */
  maxResidual?: number;
}

export interface FlowResult {
  /** xy pairs */
  pts: Float32Array;
  /** 1 = tracked */
  status: Uint8Array;
  /** mean absolute residual of the final window */
  err: Float32Array;
}

/**
 * Track points from `prev` to `next`. `guess` (optional) gives initial positions in `next`
 * (e.g. predicted by a homography); points marked 0 in `status` are lost.
 */
export function trackFlow(prev: Pyramid, next: Pyramid, pts: ArrayLike<number>, o: FlowOptions = {}, guess?: ArrayLike<number>): FlowResult {
  const res = lkPass(prev, next, pts, o, guess);
  const fb = o.fbThreshold ?? 1;
  if (fb > 0) {
    const back = lkPass(next, prev, res.pts, o, pts);
    const fb2 = fb * fb;
    for (let i = 0; i < res.status.length; i++) {
      if (!res.status[i]) continue;
      if (!back.status[i]) { res.status[i] = 0; continue; }
      const dx = back.pts[i * 2] - pts[i * 2], dy = back.pts[i * 2 + 1] - pts[i * 2 + 1];
      if (dx * dx + dy * dy > fb2) res.status[i] = 0;
    }
  }
  return res;
}

function lkPass(prev: Pyramid, next: Pyramid, pts: ArrayLike<number>, o: FlowOptions, guess?: ArrayLike<number>): FlowResult {
  const r = o.radius ?? 7;
  const maxIter = o.maxIter ?? 24;
  const eps = o.epsilon ?? 0.01;
  const minEig = o.minEigen ?? 1e-3;
  const maxRes = o.maxResidual ?? 40;
  const n = pts.length >> 1;
  const L = Math.min(prev.levels.length, next.levels.length);
  const out = new Float32Array(n * 2), status = new Uint8Array(n), err = new Float32Array(n);
  const win = 2 * r + 1, N = win * win;
  const Iv = new Float32Array(N), Ix = new Float32Array(N), Iy = new Float32Array(N);
  for (let i = 0; i < n; i++) {
    const px = pts[i * 2], py = pts[i * 2 + 1];
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    // displacement guess expressed at the top level
    let gx = 0, gy = 0;
    if (guess && Number.isFinite(guess[i * 2])) {
      const s = 1 / (1 << (L - 1));
      gx = (guess[i * 2] - px) * s;
      gy = (guess[i * 2 + 1] - py) * s;
    }
    let ok = true;
    let lastRes = 0;
    for (let l = L - 1; l >= 0; l--) {
      const I = prev.levels[l], J = next.levels[l];
      const gxP = prev.gx[l], gyP = prev.gy[l];
      const s = 1 / (1 << l);
      const ux = px * s, uy = py * s;
      if (ux < -r || uy < -r || ux > I.w + r || uy > I.h + r) { ok = false; break; }
      // template window and gradient matrix
      let a = 0, b = 0, c = 0, k = 0;
      for (let wy = -r; wy <= r; wy++) {
        for (let wx = -r; wx <= r; wx++, k++) {
          const x = ux + wx, y = uy + wy;
          Iv[k] = sample(I, x, y);
          const dx = samplePlane(gxP, I.w, I.h, x, y), dy = samplePlane(gyP, I.w, I.h, x, y);
          Ix[k] = dx;
          Iy[k] = dy;
          a += dx * dx;
          b += dx * dy;
          c += dy * dy;
        }
      }
      const det = a * c - b * b;
      const t = (a - c) / 2;
      const mEig = ((a + c) / 2 - Math.sqrt(t * t + b * b)) / N;
      if (mEig < minEig || det < 1e-12) {
        if (l === 0) { ok = false; break; }
        gx *= 2; gy *= 2;
        continue;
      }
      let vx = 0, vy = 0;
      for (let it = 0; it < maxIter; it++) {
        let bx = 0, by = 0;
        k = 0;
        const ox = ux + gx + vx, oy = uy + gy + vy;
        if (ox < -r || oy < -r || ox > J.w + r || oy > J.h + r) { ok = false; break; }
        for (let wy = -r; wy <= r; wy++) {
          for (let wx = -r; wx <= r; wx++, k++) {
            const diff = Iv[k] - sample(J, ox + wx, oy + wy);
            bx += diff * Ix[k];
            by += diff * Iy[k];
          }
        }
        const ex = (c * bx - b * by) / det, ey = (a * by - b * bx) / det;
        vx += ex;
        vy += ey;
        if (ex * ex + ey * ey < eps * eps) break;
      }
      if (!ok) break;
      if (l > 0) {
        gx = 2 * (gx + vx);
        gy = 2 * (gy + vy);
      } else {
        gx += vx;
        gy += vy;
        // final residual
        let e = 0;
        k = 0;
        for (let wy = -r; wy <= r; wy++)
          for (let wx = -r; wx <= r; wx++, k++) e += Math.abs(Iv[k] - sample(J, px + gx + wx, py + gy + wy));
        lastRes = e / N;
      }
    }
    const nx = px + gx, ny = py + gy;
    const W0 = next.levels[0].w, H0 = next.levels[0].h;
    if (!ok || !Number.isFinite(nx) || nx < 0 || ny < 0 || nx > W0 - 1 || ny > H0 - 1 || lastRes > maxRes) {
      out[i * 2] = NaN;
      out[i * 2 + 1] = NaN;
      continue;
    }
    out[i * 2] = nx;
    out[i * 2 + 1] = ny;
    status[i] = 1;
    err[i] = lastRes;
  }
  return { pts: out, status, err };
}

// ── feature-region tracker ──────────────────────────────────────────────────

export interface FeatureTemplate {
  /** half extents of the feature region at level 0 (pixels) */
  hw: number;
  hh: number;
  /** per pyramid level: zero-mean patch, its norm, and gradients for sub-pixel refinement */
  levels: { w: number; h: number; z: Float32Array; norm: number; mean: number; std: number; gx: Float32Array; gy: Float32Array }[];
}

/** Sample a feature template (centre cx, cy; size fw × fh) from a reference pyramid. */
export function makeTemplate(ref: Pyramid, cx: number, cy: number, fw: number, fh: number, maxLevel = 4): FeatureTemplate {
  const hw = Math.max(2, fw / 2), hh = Math.max(2, fh / 2);
  const levels: FeatureTemplate['levels'] = [];
  for (let l = 0; l < ref.levels.length && l <= maxLevel; l++) {
    const s = 1 / (1 << l);
    const w = Math.max(3, Math.round(hw * 2 * s) | 1), h = Math.max(3, Math.round(hh * 2 * s) | 1);
    if (l > 0 && Math.min(w, h) < 6) break;
    const img = ref.levels[l];
    const z = new Float32Array(w * h), gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    const x0 = cx * s - (w - 1) / 2, y0 = cy * s - (h - 1) / 2;
    let sum = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = sample(img, x0 + x, y0 + y);
        z[y * w + x] = v;
        sum += v;
        gx[y * w + x] = samplePlane(ref.gx[l], img.w, img.h, x0 + x, y0 + y);
        gy[y * w + x] = samplePlane(ref.gy[l], img.w, img.h, x0 + x, y0 + y);
      }
    const mean = sum / (w * h);
    let ss = 0;
    for (let i = 0; i < w * h; i++) {
      z[i] -= mean;
      ss += z[i] * z[i];
    }
    levels.push({ w, h, z, norm: Math.sqrt(ss), mean, std: Math.sqrt(ss / (w * h)), gx, gy });
  }
  return { hw, hh, levels };
}

export interface FeatureSearch {
  /** predicted feature centre in the target frame */
  cx: number;
  cy: number;
  /** search region relative to the predicted centre: offset and full size */
  offX: number;
  offY: number;
  searchW: number;
  searchH: number;
  /** skip sub-pixel refinement (faster, integer precision at level 0) */
  noSubpixel?: boolean;
}

export interface FeatureMatch {
  x: number;
  y: number;
  /** normalised cross correlation of the final match, −1..1 */
  ncc: number;
}

/** Locate a feature template inside the search region of `target`. */
export function trackFeature(tpl: FeatureTemplate, target: Pyramid, s: FeatureSearch, cache?: Map<number, Integral>): FeatureMatch {
  const top = Math.min(tpl.levels.length, target.levels.length) - 1;
  const integ = (l: number) => {
    let ii = cache?.get(l);
    if (!ii) {
      ii = integral(target.levels[l]);
      cache?.set(l, ii);
    }
    return ii;
  };
  // exhaustive search at the coarsest level
  const sc = 1 / (1 << top);
  const T = tpl.levels[top];
  const img = target.levels[top];
  const scx = (s.cx + s.offX) * sc, scy = (s.cy + s.offY) * sc;
  // feature centres allowed: search region shrunk by the feature size
  const rx = Math.max(1, (s.searchW / 2) * sc - (T.w - 1) / 2), ry = Math.max(1, (s.searchH / 2) * sc - (T.h - 1) / 2);
  let best = { x: s.cx * sc, y: s.cy * sc, ncc: -2 };
  const ii = integ(top);
  for (let y = Math.floor(scy - ry); y <= Math.ceil(scy + ry); y++) {
    for (let x = Math.floor(scx - rx); x <= Math.ceil(scx + rx); x++) {
      const v = nccAt(T, img, ii, x, y);
      if (v > best.ncc) best = { x, y, ncc: v };
    }
  }
  // refine down the pyramid
  for (let l = top - 1; l >= 0; l--) {
    const Tl = tpl.levels[l];
    const im = target.levels[l];
    const iil = integ(l);
    const bx = Math.round(best.x * 2), by = Math.round(best.y * 2);
    let nb = { x: bx, y: by, ncc: -2 };
    for (let y = by - 2; y <= by + 2; y++)
      for (let x = bx - 2; x <= bx + 2; x++) {
        const v = nccAt(Tl, im, iil, x, y);
        if (v > nb.ncc) nb = { x, y, ncc: v };
      }
    best = nb;
  }
  if (best.ncc < -1.5) return { x: s.cx, y: s.cy, ncc: -1 };
  if (s.noSubpixel) return best;
  return refineSubpixel(tpl.levels[0], target, best.x, best.y);
}

/** NCC of a zero-mean template against the window centred on integer pixel (cx, cy). */
function nccAt(T: FeatureTemplate['levels'][number], img: Gray, ii: Integral, cx: number, cy: number): number {
  const x0 = cx - ((T.w - 1) >> 1), y0 = cy - ((T.h - 1) >> 1);
  if (x0 < 0 || y0 < 0 || x0 + T.w > img.w || y0 + T.h > img.h) {
    return nccClamped(T, img, x0, y0);
  }
  const N = T.w * T.h;
  const [s, sq] = boxStats(ii, x0, y0, x0 + T.w, y0 + T.h);
  const varI = sq - (s * s) / N;
  if (varI <= 1e-6 || T.norm <= 1e-6) return 0;
  let cross = 0;
  const d = img.data, W = img.w;
  for (let y = 0; y < T.h; y++) {
    const row = (y0 + y) * W + x0, trow = y * T.w;
    for (let x = 0; x < T.w; x++) cross += T.z[trow + x] * d[row + x];
  }
  return cross / (T.norm * Math.sqrt(varI));
}

function nccClamped(T: FeatureTemplate['levels'][number], img: Gray, x0: number, y0: number): number {
  const N = T.w * T.h;
  let s = 0, sq = 0, cross = 0;
  for (let y = 0; y < T.h; y++)
    for (let x = 0; x < T.w; x++) {
      const xx = Math.min(img.w - 1, Math.max(0, x0 + x)), yy = Math.min(img.h - 1, Math.max(0, y0 + y));
      const v = img.data[yy * img.w + xx];
      s += v;
      sq += v * v;
      cross += T.z[y * T.w + x] * v;
    }
  const varI = sq - (s * s) / N;
  if (varI <= 1e-6 || T.norm <= 1e-6) return 0;
  // penalise matches hanging off the frame edge
  return (cross / (T.norm * Math.sqrt(varI))) * 0.92;
}

/**
 * Sub-pixel translation by inverse-compositional Lucas–Kanade with gain/bias normalisation, then
 * the NCC at the converged position.
 */
function refineSubpixel(T: FeatureTemplate['levels'][number], target: Pyramid, ix: number, iy: number): FeatureMatch {
  const img = target.levels[0];
  const w = T.w, h = T.h, N = w * h;
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < N; i++) {
    a += T.gx[i] * T.gx[i];
    b += T.gx[i] * T.gy[i];
    c += T.gy[i] * T.gy[i];
  }
  const det = a * c - b * b;
  let x = ix, y = iy;
  const hx = (w - 1) / 2, hy = (h - 1) / 2;
  const J = new Float32Array(N);
  if (det > 1e-9 && T.std > 1e-3) {
    for (let it = 0; it < 20; it++) {
      let sum = 0, sq = 0;
      for (let yy = 0; yy < h; yy++)
        for (let xx = 0; xx < w; xx++) {
          const v = sample(img, x - hx + xx, y - hy + yy);
          J[yy * w + xx] = v;
          sum += v;
          sq += v * v;
        }
      const mean = sum / N;
      const std = Math.sqrt(Math.max(1e-9, sq / N - mean * mean));
      const gain = std / T.std;
      // residual in the template's photometric frame: J normalised to the template's gain
      let bx = 0, by = 0;
      for (let i = 0; i < N; i++) {
        const e = (J[i] - mean) / gain - T.z[i];
        bx += e * T.gx[i];
        by += e * T.gy[i];
      }
      const dx = (c * bx - b * by) / det, dy = (a * by - b * bx) / det;
      // inverse compositional: the template moved by +d, so the image position moves by −d
      x -= dx;
      y -= dy;
      if (Math.abs(x - ix) > 2 || Math.abs(y - iy) > 2) {
        x = ix;
        y = iy;
        break;
      }
      if (dx * dx + dy * dy < 1e-4) break;
    }
  }
  // NCC at the final position
  let sum = 0, sq = 0, cross = 0;
  for (let yy = 0; yy < h; yy++)
    for (let xx = 0; xx < w; xx++) {
      const v = sample(img, x - hx + xx, y - hy + yy);
      sum += v;
      sq += v * v;
      cross += T.z[yy * w + xx] * v;
    }
  const varI = sq - (sum * sum) / N;
  const ncc = varI > 1e-6 && T.norm > 1e-6 ? cross / (T.norm * Math.sqrt(varI)) : 0;
  return { x, y, ncc };
}
