// Bézier path geometry for shape layers and masks.
// Paths use the Lottie/AE representation: vertices with tangents relative to their vertex.

import type { BezierPath, Vec2 } from '../core/types';

/** 2D affine matrix [a, b, c, d, e, f]: x' = a·x + c·y + e,  y' = b·x + d·y + f (canvas convention). */
export type Mat2d = [number, number, number, number, number, number];

export const IDENTITY_2D: Mat2d = [1, 0, 0, 1, 0, 0];

export function mul2d(m: Mat2d, n: Mat2d): Mat2d {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function translate2d(x: number, y: number): Mat2d {
  return [1, 0, 0, 1, x, y];
}

export function scale2d(sx: number, sy: number): Mat2d {
  return [sx, 0, 0, sy, 0, 0];
}

export function rotate2d(deg: number): Mat2d {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

export function skew2d(deg: number, axisDeg: number): Mat2d {
  if (!deg) return IDENTITY_2D;
  const k = Math.tan((-deg * Math.PI) / 180);
  return mul2d(mul2d(rotate2d(axisDeg), [1, 0, k, 1, 0, 0]), rotate2d(-axisDeg));
}

export function invert2d(m: Mat2d): Mat2d | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  return [m[3] * id, -m[1] * id, -m[2] * id, m[0] * id, (m[2] * m[5] - m[3] * m[4]) * id, (m[1] * m[4] - m[0] * m[5]) * id];
}

export const apply2d = (m: Mat2d, p: number[]): Vec2 => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
export const applyVec2d = (m: Mat2d, p: number[]): Vec2 => [m[0] * p[0] + m[2] * p[1], m[1] * p[0] + m[3] * p[1]];

/** Uniform-equivalent scale (geometric mean of axis scales) — used to scale stroke widths. */
export const scaleOf2d = (m: Mat2d): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

export function transformPath(p: BezierPath, m: Mat2d): BezierPath {
  return {
    closed: p.closed,
    v: p.v.map((v) => apply2d(m, v)),
    i: p.i.map((t) => applyVec2d(m, t)),
    o: p.o.map((t) => applyVec2d(m, t)),
  };
}

export function clonePath(p: BezierPath): BezierPath {
  return { closed: p.closed, v: p.v.map((x) => [x[0], x[1]]), i: p.i.map((x) => [x[0], x[1]]), o: p.o.map((x) => [x[0], x[1]]) };
}

export function reversePath(p: BezierPath): BezierPath {
  const n = p.v.length;
  if (n < 2) return clonePath(p);
  const v: Vec2[] = [], i: Vec2[] = [], o: Vec2[] = [];
  if (p.closed) {
    // keep the first vertex as start, walk backwards
    for (let k = 0; k < n; k++) {
      const idx = (n - k) % n;
      v.push([p.v[idx][0], p.v[idx][1]]);
      i.push([p.o[idx][0], p.o[idx][1]]);
      o.push([p.i[idx][0], p.i[idx][1]]);
    }
  } else {
    for (let k = n - 1; k >= 0; k--) {
      v.push([p.v[k][0], p.v[k][1]]);
      i.push([p.o[k][0], p.o[k][1]]);
      o.push([p.i[k][0], p.i[k][1]]);
    }
  }
  return { closed: p.closed, v, i, o };
}

// ── segments ────────────────────────────────────────────────────────────────

/** Absolute cubic segment control points. */
export type Seg = [Vec2, Vec2, Vec2, Vec2];

export function segmentCount(p: BezierPath): number {
  const n = p.v.length;
  if (n < 2) return 0;
  return p.closed ? n : n - 1;
}

export function getSegment(p: BezierPath, k: number): Seg {
  const n = p.v.length;
  const a = p.v[k], b = p.v[(k + 1) % n];
  const o = p.o[k], i = p.i[(k + 1) % n];
  return [a, [a[0] + o[0], a[1] + o[1]], [b[0] + i[0], b[1] + i[1]], b];
}

export function segments(p: BezierPath): Seg[] {
  const out: Seg[] = [];
  const c = segmentCount(p);
  for (let k = 0; k < c; k++) out.push(getSegment(p, k));
  return out;
}

export function isLinearSeg(s: Seg): boolean {
  const eps = 1e-9;
  return Math.abs(s[1][0] - s[0][0]) < eps && Math.abs(s[1][1] - s[0][1]) < eps && Math.abs(s[2][0] - s[3][0]) < eps && Math.abs(s[2][1] - s[3][1]) < eps;
}

// Straight segments (control points coincident with their endpoints) use a UNIFORM parameter so that
// t is proportional to arc length; curved segments use the cubic parameter.

export function pointOnSeg(s: Seg, t: number): Vec2 {
  if (isLinearSeg(s)) return [s[0][0] + (s[3][0] - s[0][0]) * t, s[0][1] + (s[3][1] - s[0][1]) * t];
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * s[0][0] + b * s[1][0] + c * s[2][0] + d * s[3][0], a * s[0][1] + b * s[1][1] + c * s[2][1] + d * s[3][1]];
}

export function tangentOnSeg(s: Seg, t: number): Vec2 {
  if (isLinearSeg(s)) return [s[3][0] - s[0][0], s[3][1] - s[0][1]];
  const u = 1 - t;
  const a = 3 * u * u, b = 6 * u * t, c = 3 * t * t;
  let x = a * (s[1][0] - s[0][0]) + b * (s[2][0] - s[1][0]) + c * (s[3][0] - s[2][0]);
  let y = a * (s[1][1] - s[0][1]) + b * (s[2][1] - s[1][1]) + c * (s[3][1] - s[2][1]);
  if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) {
    x = s[3][0] - s[0][0];
    y = s[3][1] - s[0][1];
  }
  return [x, y];
}

// 8-point Gauss–Legendre quadrature for cubic arc length
const GL_T = [-0.9602898564975363, -0.7966664774136267, -0.5255324099163290, -0.1834346424956498, 0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363];
const GL_W = [0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.3626837833783620, 0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];

export function segLength(s: Seg, t1 = 1): number {
  if (isLinearSeg(s)) return Math.hypot(s[3][0] - s[0][0], s[3][1] - s[0][1]) * t1;
  const half = t1 / 2;
  let sum = 0;
  for (let k = 0; k < 8; k++) {
    const t = half * GL_T[k] + half;
    const d = tangentOnSeg(s, t);
    sum += GL_W[k] * Math.hypot(d[0], d[1]);
  }
  return sum * half;
}

/** Parameter t at which the arc length from 0 equals `len` (Newton + bisection). */
export function segParamAtLength(s: Seg, len: number, total = segLength(s)): number {
  if (len <= 0) return 0;
  if (len >= total) return 1;
  if (isLinearSeg(s)) return len / total;
  let t = len / total, lo = 0, hi = 1;
  for (let it = 0; it < 12; it++) {
    const L = segLength(s, t) - len;
    if (Math.abs(L) < 1e-4) return t;
    if (L > 0) hi = t; else lo = t;
    const d = tangentOnSeg(s, t);
    const sp = Math.hypot(d[0], d[1]);
    let nt = sp > 1e-9 ? t - L / sp : (lo + hi) / 2;
    if (nt <= lo || nt >= hi) nt = (lo + hi) / 2;
    t = nt;
  }
  return t;
}

export function splitSeg(s: Seg, t: number): [Seg, Seg] {
  if (isLinearSeg(s)) {
    const m = pointOnSeg(s, t);
    return [[s[0], s[0], m, m], [m, m, s[3], s[3]]];
  }
  const l = (a: Vec2, b: Vec2): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const a = l(s[0], s[1]), b = l(s[1], s[2]), c = l(s[2], s[3]);
  const d = l(a, b), e = l(b, c);
  const f = l(d, e);
  return [[s[0], a, d, f], [f, e, c, s[3]]];
}

export function subSeg(s: Seg, t0: number, t1: number): Seg {
  if (t0 <= 0 && t1 >= 1) return s;
  if (isLinearSeg(s)) {
    const a = pointOnSeg(s, Math.max(0, t0)), b = pointOnSeg(s, Math.min(1, t1));
    return [a, a, b, b];
  }
  let r = s;
  if (t1 < 1) r = splitSeg(r, t1)[0];
  if (t0 > 0) r = splitSeg(r, t1 > 0 ? t0 / t1 : 0)[1];
  return r;
}

/** Build a path from a chain of segments (each segment's start equals the previous end). */
export function pathFromSegs(segs: Seg[], closed: boolean): BezierPath {
  const v: Vec2[] = [], i: Vec2[] = [], o: Vec2[] = [];
  if (!segs.length) return { closed: false, v, i, o };
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    if (k === 0) {
      v.push([s[0][0], s[0][1]]);
      i.push([0, 0]);
    }
    o[o.length] = [s[1][0] - s[0][0], s[1][1] - s[0][1]];
    if (closed && k === segs.length - 1) {
      i[0] = [s[2][0] - s[3][0], s[2][1] - s[3][1]];
    } else {
      v.push([s[3][0], s[3][1]]);
      i.push([s[2][0] - s[3][0], s[2][1] - s[3][1]]);
    }
  }
  while (o.length < v.length) o.push([0, 0]);
  return { closed, v, i, o };
}

export function pathLength(p: BezierPath): number {
  let L = 0;
  const c = segmentCount(p);
  for (let k = 0; k < c; k++) L += segLength(getSegment(p, k));
  return L;
}

/**
 * Extract the portion of a path between normalised positions a < b (fractions of total length).
 * For closed paths a/b may exceed [0,1]; wrap-around produces one continuous open path.
 */
export function trimPath(p: BezierPath, a: number, b: number): BezierPath[] {
  const segs = segments(p);
  if (!segs.length) return [];
  const lens = segs.map((s) => segLength(s));
  const total = lens.reduce((x, y) => x + y, 0);
  if (total <= 1e-9) return [];
  if (b - a >= 1 - 1e-9) return [clonePath(p)];
  if (b - a <= 1e-9) return [];
  const extract = (from: number, to: number): Seg[] => {
    // from/to in [0, total]
    const out: Seg[] = [];
    let acc = 0;
    for (let k = 0; k < segs.length; k++) {
      const L = lens[k];
      const s0 = acc, s1 = acc + L;
      acc = s1;
      if (s1 <= from + 1e-9 || s0 >= to - 1e-9) continue;
      const t0 = from > s0 ? segParamAtLength(segs[k], from - s0, L) : 0;
      const t1 = to < s1 ? segParamAtLength(segs[k], to - s0, L) : 1;
      out.push(subSeg(segs[k], t0, t1));
    }
    return out;
  };
  if (p.closed) {
    let s = a - Math.floor(a);
    let e = s + (b - a);
    if (e <= 1 + 1e-9) return [pathFromSegs(extract(s * total, Math.min(e, 1) * total), false)];
    const first = extract(s * total, total);
    const second = extract(0, (e - 1) * total);
    return [pathFromSegs([...first, ...second], false)];
  }
  // open path: clamp and possibly split into two pieces when wrapping
  const res: BezierPath[] = [];
  const s = a - Math.floor(a);
  const e = s + (b - a);
  if (e <= 1) res.push(pathFromSegs(extract(s * total, e * total), false));
  else {
    res.push(pathFromSegs(extract(s * total, total), false));
    res.push(pathFromSegs(extract(0, (e - 1) * total), false));
  }
  return res.filter((x) => x.v.length > 1);
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Conservative bounds (convex hull of control points). */
export function pathBounds(paths: BezierPath[]): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) {
    for (let k = 0; k < p.v.length; k++) {
      const v = p.v[k];
      const pts = [v, [v[0] + p.i[k][0], v[1] + p.i[k][1]], [v[0] + p.o[k][0], v[1] + p.o[k][1]]];
      for (const q of pts) {
        if (q[0] < minX) minX = q[0];
        if (q[1] < minY) minY = q[1];
        if (q[0] > maxX) maxX = q[0];
        if (q[1] > maxY) maxY = q[1];
      }
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function unionBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function expandBounds(b: Bounds, pad: number): Bounds {
  return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
}

/** Append a path to a canvas path (CanvasRenderingContext2D, OffscreenCanvasRenderingContext2D or Path2D). */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number): void;
  closePath(): void;
}

export function tracePath(sink: PathSink, p: BezierPath, m?: Mat2d): void {
  const n = p.v.length;
  if (n === 0) return;
  const P = (q: number[]) => (m ? apply2d(m, q) : q);
  const v0 = P(p.v[0]);
  sink.moveTo(v0[0], v0[1]);
  const c = segmentCount(p);
  for (let k = 0; k < c; k++) {
    const s = getSegment(p, k);
    if (isLinearSeg(s)) {
      const e = P(s[3]);
      sink.lineTo(e[0], e[1]);
    } else {
      const a = P(s[1]), b = P(s[2]), e = P(s[3]);
      sink.bezierCurveTo(a[0], a[1], b[0], b[1], e[0], e[1]);
    }
  }
  if (p.closed) sink.closePath();
}

