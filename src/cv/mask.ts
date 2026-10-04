// ─────────────────────────────────────────────────────────────────────────────
// Matte utilities: marching-squares contours with sub-pixel edges, contour
// simplification/resampling and Bézier fitting (for baking roto mattes into
// animated mask paths), exact Euclidean distance transforms (for choosing
// prompt points far from the boundary), homography warps and IoU.
// Mattes are 8-bit alpha planes, row 0 at the top.
// ─────────────────────────────────────────────────────────────────────────────

import type { BezierPath, Vec2 } from '../core/types';
import { applyH, invertH } from './homography';

export type Pt = [number, number];

/** Closed iso-contours of `alpha` at `level` (0..255), longest first. */
export function traceContours(alpha: ArrayLike<number>, w: number, h: number, level = 128): Pt[][] {
  // pad with a zero border so every contour closes
  const W = w + 2, H = h + 2;
  const v = (x: number, y: number): number => (x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1 ? 0 : alpha[(y - 1) * w + (x - 1)]);
  // edge ids: horizontal edge (x,y)-(x+1,y) → 2*(y*W+x); vertical (x,y)-(x,y+1) → 2*(y*W+x)+1
  const next = new Map<number, number>();
  const pos = new Map<number, Pt>();
  const edgePoint = (id: number): Pt => {
    let p = pos.get(id);
    if (p) return p;
    const cell = id >> 1, x = cell % W, y = (cell / W) | 0;
    const a = v(x, y);
    if (id & 1) {
      const b = v(x, y + 1);
      const t = (level - a) / (b - a || 1e-9);
      p = [x - 1, y - 1 + t];
    } else {
      const b = v(x + 1, y);
      const t = (level - a) / (b - a || 1e-9);
      p = [x - 1 + t, y - 1];
    }
    pos.set(id, p);
    return p;
  };
  const top = (x: number, y: number) => 2 * (y * W + x);
  const bottom = (x: number, y: number) => 2 * ((y + 1) * W + x);
  const left = (x: number, y: number) => 2 * (y * W + x) + 1;
  const right = (x: number, y: number) => 2 * (y * W + x + 1) + 1;
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const tl = v(x, y) >= level ? 8 : 0, tr = v(x + 1, y) >= level ? 4 : 0;
      const br = v(x + 1, y + 1) >= level ? 2 : 0, bl = v(x, y + 1) >= level ? 1 : 0;
      const c = tl | tr | br | bl;
      if (c === 0 || c === 15) continue;
      const T = top(x, y), B = bottom(x, y), L = left(x, y), R = right(x, y);
      // segments oriented with the inside on the right-hand side (clockwise outer contours in y-down space)
      const seg = (a: number, b: number) => next.set(a, b);
      switch (c) {
        case 1: seg(B, L); break;
        case 2: seg(R, B); break;
        case 3: seg(R, L); break;
        case 4: seg(T, R); break;
        case 5: {
          const centre = (v(x, y) + v(x + 1, y) + v(x + 1, y + 1) + v(x, y + 1)) / 4;
          if (centre >= level) { seg(T, L); seg(B, R); } else { seg(T, R); seg(B, L); }
          break;
        }
        case 6: seg(T, B); break;
        case 7: seg(T, L); break;
        case 8: seg(L, T); break;
        case 9: seg(B, T); break;
        case 10: {
          const centre = (v(x, y) + v(x + 1, y) + v(x + 1, y + 1) + v(x, y + 1)) / 4;
          if (centre >= level) { seg(L, B); seg(R, T); } else { seg(L, T); seg(R, B); }
          break;
        }
        case 11: seg(R, T); break;
        case 12: seg(L, R); break;
        case 13: seg(B, R); break;
        case 14: seg(L, B); break;
      }
    }
  }
  const out: Pt[][] = [];
  const visited = new Set<number>();
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    const poly: Pt[] = [];
    let cur = start;
    let guard = 0;
    while (!visited.has(cur) && guard++ < 4_000_000) {
      visited.add(cur);
      poly.push(edgePoint(cur));
      const n = next.get(cur);
      if (n === undefined) break;
      cur = n;
    }
    if (poly.length >= 3) out.push(poly);
  }
  out.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
  return out;
}

export function polygonArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1];
  return a / 2;
}

/** Ramer–Douglas–Peucker simplification of a closed polygon. */
export function simplifyClosed(p: Pt[], eps: number): Pt[] {
  if (p.length < 8) return p.slice();
  // split at the two mutually farthest points
  let a = 0, b = 0, best = -1;
  for (let i = 0; i < p.length; i += Math.max(1, (p.length / 64) | 0)) {
    for (let j = 0; j < p.length; j++) {
      const d = (p[i][0] - p[j][0]) ** 2 + (p[i][1] - p[j][1]) ** 2;
      if (d > best) { best = d; a = i; b = j; }
    }
  }
  if (a > b) [a, b] = [b, a];
  const left = rdp(p.slice(a, b + 1), eps), right = rdp([...p.slice(b), ...p.slice(0, a + 1)], eps);
  return [...left.slice(0, -1), ...right.slice(0, -1)];
}

function rdp(p: Pt[], eps: number): Pt[] {
  if (p.length < 3) return p.slice();
  const [x0, y0] = p[0], [x1, y1] = p[p.length - 1];
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1e-9;
  let idx = -1, md = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const d = Math.abs(dy * p[i][0] - dx * p[i][1] + x1 * y0 - y1 * x0) / L;
    if (d > md) { md = d; idx = i; }
  }
  if (md <= eps) return [p[0], p[p.length - 1]];
  const l = rdp(p.slice(0, idx + 1), eps), r = rdp(p.slice(idx), eps);
  return [...l.slice(0, -1), ...r];
}

/** Resample a closed polygon to `n` points equally spaced along its perimeter. */
export function resampleClosed(p: Pt[], n: number): Pt[] {
  const m = p.length;
  const cum = [0];
  for (let i = 0; i < m; i++) {
    const a = p[i], b = p[(i + 1) % m];
    cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[m];
  const out: Pt[] = [];
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const d = (k / n) * total;
    while (seg < m - 1 && cum[seg + 1] < d) seg++;
    const a = p[seg], b = p[(seg + 1) % m];
    const L = cum[seg + 1] - cum[seg] || 1e-9;
    const t = (d - cum[seg]) / L;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/**
 * Rotate the vertex order of `cur` (same length as `prev`) so vertices correspond to the previous
 * frame's — keeps baked mask paths from "swimming" when interpolated.
 */
export function alignToPrevious(prev: Pt[], cur: Pt[]): Pt[] {
  const n = cur.length;
  if (prev.length !== n) return cur;
  let best = 0, bestD = Infinity;
  for (let s = 0; s < n; s++) {
    let d = 0;
    for (let i = 0; i < n; i += 2) {
      const a = prev[i], b = cur[(i + s) % n];
      d += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
    }
    if (d < bestD) { bestD = d; best = s; }
  }
  return cur.map((_, i) => cur[(i + best) % n]);
}

/** Closed Bézier path through the points with Catmull–Rom tangents (AE mask/shape format). */
export function pointsToBezier(p: Pt[], tension = 1 / 6): BezierPath {
  const n = p.length;
  const v: Vec2[] = [], i: Vec2[] = [], o: Vec2[] = [];
  for (let k = 0; k < n; k++) {
    const a = p[(k - 1 + n) % n], b = p[(k + 1) % n];
    const tx = (b[0] - a[0]) * tension, ty = (b[1] - a[1]) * tension;
    v.push([p[k][0], p[k][1]]);
    i.push([-tx, -ty]);
    o.push([tx, ty]);
  }
  return { closed: true, v, i, o };
}

/** Exact squared Euclidean distance to the nearest pixel where `inside` is false (Felzenszwalb). */
export function distanceTransform(inside: ArrayLike<number>, w: number, h: number, level = 128): Float32Array {
  const INF = 1e20;
  const f = new Float64Array(Math.max(w, h));
  const d = new Float64Array(Math.max(w, h));
  const vv = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = inside[i] >= level ? INF : 0;
  const edt1d = (n: number) => {
    let k = 0;
    vv[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[vv[k]] + vv[k] * vv[k])) / (2 * q - 2 * vv[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[vv[k]] + vv[k] * vv[k])) / (2 * q - 2 * vv[k]);
      }
      k++;
      vv[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - vv[k]) * (q - vv[k]) + f[vv[k]];
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(w);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x];
  }
  return out;
}

export function maskBounds(alpha: ArrayLike<number>, w: number, h: number, level = 128): [number, number, number, number] | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (alpha[y * w + x] < level) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

export function maskArea(alpha: ArrayLike<number>, level = 128): number {
  let n = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] >= level) n++;
  return n;
}

export function iou(a: ArrayLike<number>, b: ArrayLike<number>, level = 128): number {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] >= level, q = b[i] >= level;
    if (p && q) inter++;
    if (p || q) uni++;
  }
  return uni ? inter / uni : 0;
}

/** Warp a matte by a homography (src → dst coordinates), bilinear sampling. */
export function warpMask(alpha: ArrayLike<number>, w: number, h: number, H: ArrayLike<number>): Uint8Array {
  const inv = invertH(H);
  const out = new Uint8Array(w * h);
  if (!inv) return out;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [sx, sy] = applyH(inv, x, y);
      if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) continue;
      const x0 = sx | 0, y0 = sy | 0, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;
      const a = alpha[y0 * w + x0], b = alpha[y0 * w + x1], c = alpha[y1 * w + x0], d = alpha[y1 * w + x1];
      out[y * w + x] = Math.round(a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy);
    }
  }
  return out;
}

/** Keep only the connected component(s) touching the given seed points (4-connectivity). */
export function keepComponents(alpha: Uint8Array, w: number, h: number, seeds: Pt[], level = 128): Uint8Array {
  const label = new Uint8Array(w * h);
  const stack: number[] = [];
  for (const [sx, sy] of seeds) {
    const x = Math.round(sx), y = Math.round(sy);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = y * w + x;
    if (alpha[i] < level || label[i]) continue;
    label[i] = 1;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const jx = j % w, jy = (j / w) | 0;
      const nb = [jx > 0 ? j - 1 : -1, jx < w - 1 ? j + 1 : -1, jy > 0 ? j - w : -1, jy < h - 1 ? j + w : -1];
      for (const k of nb) if (k >= 0 && !label[k] && alpha[k] >= level) { label[k] = 1; stack.push(k); }
    }
  }
  // keep soft edges adjacent to kept pixels
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (label[i]) { out[i] = alpha[i]; continue; }
    if (alpha[i] === 0) continue;
    const x = i % w, y = (i / w) | 0;
    if ((x > 0 && label[i - 1]) || (x < w - 1 && label[i + 1]) || (y > 0 && label[i - w]) || (y < h - 1 && label[i + w])) out[i] = alpha[i];
  }
  return out;
}

/** Applying a point list through a homography (helper for propagated prompts). */
export function warpPoints(pts: Pt[], H: ArrayLike<number>): Pt[] {
  return pts.map(([x, y]) => applyH(H, x, y));
}
