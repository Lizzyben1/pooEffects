// ─────────────────────────────────────────────────────────────────────────────
// Keyframe interpolation engine
//
// Temporal model (identical to After Effects):
//   Each keyframe carries an outgoing and incoming ease {speed, influence}.
//   A segment k0 → k1 is a cubic Bézier in (time, value) space with control points
//       P0 = (t0, v0)
//       P1 = (t0 + infOut·Δt, v0 + speedOut·infOut·Δt)
//       P2 = (t1 − infIn·Δt,  v1 − speedIn·infIn·Δt)
//       P3 = (t1, v1)
//   so the derivative at each keyframe equals the specified speed. We solve
//   x(s) = t for s, then return y(s).
//
// Spatial model (position-like properties):
//   The path between keyframes is an N-D cubic Bézier using the spatial
//   tangents. Temporal easing drives DISTANCE along that path (a single speed
//   graph in px/sec), which is mapped back to the Bézier parameter through an
//   arc-length lookup table. Auto-Bézier tangents are derived from neighbours.
// ─────────────────────────────────────────────────────────────────────────────

import type { AnimProp, BezierPath, Ease, GradientStop, Keyframe, PropValue } from '../core/types';
import { buildArcTable, bezierPoint, cubic, paramAtLength, solveCubicForX, type ArcTable } from '../math/bezier';

export const LINEAR_INFLUENCE = 1 / 6;
export const AUTO_INFLUENCE = 1 / 6;
export const EASY_EASE_INFLUENCE = 1 / 3;

// ── value classification ────────────────────────────────────────────────────

export function isBezierPath(v: unknown): v is BezierPath {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as BezierPath).v) && Array.isArray((v as BezierPath).i);
}

export function isGradient(v: unknown): v is GradientStop[] {
  return Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null && 'p' in (v[0] as object);
}

export function isNumArray(v: unknown): v is number[] {
  return Array.isArray(v) && (v.length === 0 || typeof v[0] === 'number');
}

/** Number of easing dimensions for a value (1 for spatial or scalar values). */
export function easeDims(v: PropValue, spatial: boolean): number {
  if (spatial) return 1;
  if (typeof v === 'number') return 1;
  if (isNumArray(v)) return v.length;
  return 1;
}

// ── 1D temporal segment ─────────────────────────────────────────────────────

function easeAt(eases: Ease[], d: number): Ease {
  return eases[d] ?? eases[0] ?? { speed: 0, influence: EASY_EASE_INFLUENCE };
}

/**
 * Speed (units/sec) an auto-Bézier keyframe would have for dimension `d`.
 * Interior keyframes use the neighbour slope unless they are a local extremum (speed 0).
 */
export function autoSpeed(kfs: Keyframe[], i: number, d: number, scalarOf: (k: Keyframe, d: number) => number): number {
  const k = kfs[i];
  const prev = kfs[i - 1];
  const next = kfs[i + 1];
  const v = scalarOf(k, d);
  if (prev && next) {
    const vp = scalarOf(prev, d), vn = scalarOf(next, d);
    if ((v - vp) * (vn - v) <= 0) return 0; // extremum → flat
    const dt = next.t - prev.t;
    return dt > 0 ? (vn - vp) / dt : 0;
  }
  if (next) {
    const dt = next.t - k.t;
    return dt > 0 ? (scalarOf(next, d) - v) / dt : 0;
  }
  if (prev) {
    const dt = k.t - prev.t;
    return dt > 0 ? (v - scalarOf(prev, d)) / dt : 0;
  }
  return 0;
}

/** Control points (normalised x in [0,1]) for a temporal segment. */
export function segmentControls(
  kfs: Keyframe[], i: number, d: number, v0: number, v1: number,
  scalarOf: (k: Keyframe, d: number) => number,
): { x1: number; y1: number; x2: number; y2: number } {
  const k0 = kfs[i], k1 = kfs[i + 1];
  const dt = k1.t - k0.t;
  const slope = dt > 0 ? (v1 - v0) / dt : 0;
  let sOut: number, iOut: number, sIn: number, iIn: number;
  switch (k0.outType) {
    case 'linear': sOut = slope; iOut = LINEAR_INFLUENCE; break;
    case 'auto': sOut = autoSpeed(kfs, i, d, scalarOf); iOut = AUTO_INFLUENCE; break;
    default: { const e = easeAt(k0.easeOut, d); sOut = e.speed; iOut = e.influence; }
  }
  switch (k1.inType) {
    case 'linear': sIn = slope; iIn = LINEAR_INFLUENCE; break;
    case 'auto': sIn = autoSpeed(kfs, i + 1, d, scalarOf); iIn = AUTO_INFLUENCE; break;
    case 'hold': sIn = slope; iIn = LINEAR_INFLUENCE; break;
    default: { const e = easeAt(k1.easeIn, d); sIn = e.speed; iIn = e.influence; }
  }
  iOut = Math.min(1, Math.max(0.001, iOut));
  iIn = Math.min(1, Math.max(0.001, iIn));
  return { x1: iOut, y1: v0 + sOut * iOut * dt, x2: 1 - iIn, y2: v1 - sIn * iIn * dt };
}

/** Evaluate scalar temporal segment at local time t. */
export function evalTemporal(
  kfs: Keyframe[], i: number, d: number, t: number, v0: number, v1: number,
  scalarOf: (k: Keyframe, d: number) => number,
): number {
  const k0 = kfs[i], k1 = kfs[i + 1];
  const dt = k1.t - k0.t;
  if (dt <= 0) return v1;
  const x = (t - k0.t) / dt;
  if (k0.outType === 'linear' && (k1.inType === 'linear' || k1.inType === 'hold')) return v0 + (v1 - v0) * x;
  const c = segmentControls(kfs, i, d, v0, v1, scalarOf);
  const s = solveCubicForX(0, c.x1, c.x2, 1, x);
  return cubic(v0, c.y1, c.y2, v1, s);
}

// ── spatial ─────────────────────────────────────────────────────────────────

/** Resolved spatial tangents of keyframe i: [inTangent, outTangent] relative vectors. */
export function spatialTangents(kfs: Keyframe[], i: number): [number[], number[]] {
  const k = kfs[i];
  const v = k.v as number[];
  const zero = v.map(() => 0);
  const type = k.spatial ?? 'auto';
  if (type === 'linear') return [zero, zero];
  if (type === 'auto') {
    const prev = kfs[i - 1]?.v as number[] | undefined;
    const next = kfs[i + 1]?.v as number[] | undefined;
    if (!prev || !next) return [zero, zero];
    const dir = next.map((n, j) => n - prev[j]);
    const dl = Math.hypot(...dir);
    if (dl < 1e-9) return [zero, zero];
    const dIn = Math.hypot(...v.map((x, j) => x - prev[j]));
    const dOut = Math.hypot(...next.map((x, j) => x - v[j]));
    const ti = dir.map((c) => (-c / dl) * (dIn / 3));
    const to = dir.map((c) => (c / dl) * (dOut / 3));
    return [ti, to];
  }
  return [k.ti ?? zero, k.to ?? zero];
}

interface SpatialSegCache {
  k1: Keyframe;
  kp?: Keyframe;
  kn?: Keyframe;
  p: number[][];
  table: ArcTable;
  straight: boolean;
}

const spatialCache = new WeakMap<Keyframe, SpatialSegCache>();

export function spatialSegment(kfs: Keyframe[], i: number): SpatialSegCache {
  const k0 = kfs[i], k1 = kfs[i + 1];
  const kp = kfs[i - 1], kn = kfs[i + 2];
  const cached = spatialCache.get(k0);
  if (cached && cached.k1 === k1 && cached.kp === kp && cached.kn === kn) return cached;
  const p0 = k0.v as number[];
  const p3 = k1.v as number[];
  const [, to] = spatialTangents(kfs, i);
  const [ti] = spatialTangents(kfs, i + 1);
  const p1 = p0.map((x, j) => x + (to[j] ?? 0));
  const p2 = p3.map((x, j) => x + (ti[j] ?? 0));
  const straight = to.every((x) => Math.abs(x) < 1e-9) && ti.every((x) => Math.abs(x) < 1e-9);
  const table = buildArcTable(p0, p1, p2, p3, straight ? 1 : 64);
  const entry: SpatialSegCache = { k1, kp, kn, p: [p0, p1, p2, p3], table, straight };
  spatialCache.set(k0, entry);
  return entry;
}

function evalSpatial(kfs: Keyframe[], i: number, t: number): number[] {
  const seg = spatialSegment(kfs, i);
  const L = seg.table.total;
  if (L < 1e-9) return (kfs[i].v as number[]).slice();
  // Distance along the path is driven by the temporal ease on a 0 → L scalar. Auto-Bézier speeds
  // only look at immediate neighbours, so relative distances for keyframes i-1 … i+2 suffice.
  const rel = new Map<Keyframe, number>();
  rel.set(kfs[i], 0);
  rel.set(kfs[i + 1], L);
  if (i > 0) rel.set(kfs[i - 1], -spatialSegment(kfs, i - 1).table.total);
  if (i + 2 < kfs.length) rel.set(kfs[i + 2], L + spatialSegment(kfs, i + 1).table.total);
  const scalarOf = (k: Keyframe) => rel.get(k) ?? 0;
  const dist = evalTemporal(kfs, i, 0, t, 0, L, scalarOf);
  const u = seg.straight ? Math.min(1, Math.max(0, dist / L)) : paramAtLength(seg.table, dist);
  if (seg.straight) {
    const [p0, , , p3] = seg.p;
    return p0.map((x, j) => x + (p3[j] - x) * u);
  }
  // allow overshoot (ease speeds can push dist beyond [0, L]); extrapolate along end tangents
  if (dist < 0 || dist > L) {
    const [p0, p1, p2, p3] = seg.p;
    const end = dist < 0 ? p0 : p3;
    const ctl = dist < 0 ? p1 : p2;
    let dir = end.map((x, j) => (dist < 0 ? ctl[j] - x : x - ctl[j]));
    let dl = Math.hypot(...dir);
    if (dl < 1e-9) {
      dir = p3.map((x, j) => x - p0[j]);
      dl = Math.hypot(...dir) || 1;
    }
    const over = dist < 0 ? dist : dist - L;
    return end.map((x, j) => x + (dir[j] / dl) * over);
  }
  return bezierPoint(seg.p[0], seg.p[1], seg.p[2], seg.p[3], u);
}

// ── generic interpolation ───────────────────────────────────────────────────

function lerpPath(a: BezierPath, b: BezierPath, f: number): BezierPath {
  if (a.v.length !== b.v.length) return f < 1 ? a : b;
  const L = (x: number[], y: number[]): [number, number] => [x[0] + (y[0] - x[0]) * f, x[1] + (y[1] - x[1]) * f];
  return {
    closed: a.closed,
    v: a.v.map((p, k) => L(p, b.v[k])),
    i: a.i.map((p, k) => L(p, b.i[k])),
    o: a.o.map((p, k) => L(p, b.o[k])),
  };
}

function lerpGradient(a: GradientStop[], b: GradientStop[], f: number): GradientStop[] {
  if (a.length !== b.length) return f < 1 ? a : b;
  return a.map((s, k) => ({
    p: s.p + (b[k].p - s.p) * f,
    c: [0, 1, 2, 3].map((j) => s.c[j] + (b[k].c[j] - s.c[j]) * f) as [number, number, number, number],
  }));
}

const scalarNum = (k: Keyframe) => k.v as number;
const scalarDim = (k: Keyframe, d: number) => (k.v as number[])[d] ?? 0;
const scalarUnit = (k: Keyframe, _d: number, kfs?: Keyframe[]) => (kfs ? kfs.indexOf(k) : 0);

export function findSegment(kfs: Keyframe[], t: number): number {
  let lo = 0, hi = kfs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid].t <= t) lo = mid; else hi = mid;
  }
  return lo;
}

/** Keyframed value at layer time `t` (ignores expressions). */
export function keyframedValue<V extends PropValue>(prop: AnimProp<V>, t: number, spatial = false): V {
  const kfs = prop.keyframes as Keyframe[];
  if (!kfs || kfs.length === 0) return prop.value;
  if (kfs.length === 1 || t <= kfs[0].t) return kfs[0].v as V;
  const last = kfs[kfs.length - 1];
  if (t >= last.t) return last.v as V;
  const i = findSegment(kfs, t);
  return interpolateSegment(kfs, i, t, spatial) as V;
}

export function interpolateSegment(kfs: Keyframe[], i: number, t: number, spatial: boolean): PropValue {
  const k0 = kfs[i], k1 = kfs[i + 1];
  if (k0.outType === 'hold') return k0.v;
  const v0 = k0.v, v1 = k1.v;
  if (typeof v0 === 'number' && typeof v1 === 'number') {
    return evalTemporal(kfs, i, 0, t, v0, v1, scalarNum);
  }
  if (isNumArray(v0) && isNumArray(v1)) {
    if (spatial && v0.length === v1.length) return evalSpatial(kfs, i, t);
    return v0.map((a, d) => evalTemporal(kfs, i, d, t, a, v1[d] ?? a, scalarDim));
  }
  // Non-numeric values interpolate a normalised 0..1 progress using dimension-0 ease.
  if (isBezierPath(v0) && isBezierPath(v1)) {
    const f = progress(kfs, i, t);
    return lerpPath(v0, v1, f);
  }
  if (isGradient(v0) && isGradient(v1)) {
    const f = progress(kfs, i, t);
    return lerpGradient(v0, v1, f);
  }
  return v0; // strings, booleans, curves etc. are hold-only
}

function progress(kfs: Keyframe[], i: number, t: number): number {
  return evalTemporal(kfs, i, 0, t, i, i + 1, (k) => scalarUnit(k, 0, kfs)) - i;
}

/** Numerical velocity (units/sec) at layer time t. */
export function velocityAt(prop: AnimProp, t: number, spatial = false, h = 1 / 240): number[] {
  const a = keyframedValue(prop, t - h, spatial);
  const b = keyframedValue(prop, t + h, spatial);
  if (typeof a === 'number' && typeof b === 'number') return [(b - a) / (2 * h)];
  if (isNumArray(a) && isNumArray(b)) return a.map((x, j) => ((b[j] ?? x) - x) / (2 * h));
  return [0];
}

/** Scalar speed for the speed graph: |velocity| for spatial, per-dim derivative otherwise. */
export function speedAt(prop: AnimProp, t: number, spatial: boolean): number[] {
  const v = velocityAt(prop, t, spatial);
  if (spatial) return [Math.hypot(...v)];
  return v;
}

// ── keyframe construction helpers ───────────────────────────────────────────

export function defaultEases(v: PropValue, spatial: boolean, influence = EASY_EASE_INFLUENCE): Ease[] {
  const n = easeDims(v, spatial);
  return Array.from({ length: n }, () => ({ speed: 0, influence }));
}
