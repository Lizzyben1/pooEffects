// Non-destructive path operators (AE "shape operators"): Trim Paths, Zig Zag, Round Corners,
// Offset Paths, Pucker & Bloat, Twist and Wiggle Paths. All operate on arrays of Bézier paths.

import type { BezierPath, Vec2 } from '../core/types';
import {
  clonePath, getSegment, isLinearSeg, pathFromSegs, pathLength, pointOnSeg, segLength, segParamAtLength,
  segmentCount, segments, subSeg, tangentOnSeg, trimPath, type Seg,
} from './path';
import { noise1 } from '../math/noise';

// ── Trim Paths ──────────────────────────────────────────────────────────────

/** Normalise AE trim parameters into a [a, b) range in path-length fractions (b may exceed 1). */
export function trimRange(startPct: number, endPct: number, offsetDeg: number): [number, number] | null {
  let s = startPct / 100, e = endPct / 100;
  if (s > e) [s, e] = [e, s];
  s = Math.max(0, Math.min(1, s));
  e = Math.max(0, Math.min(1, e));
  if (e - s <= 1e-6) return null;
  const off = offsetDeg / 360;
  return [s + off, e + off];
}

export function trimSimultaneous(paths: BezierPath[], range: [number, number] | null): BezierPath[] {
  if (!range) return [];
  const out: BezierPath[] = [];
  for (const p of paths) out.push(...trimPath(p, range[0], range[1]));
  return out;
}

/** Trim treating all paths as one continuous sequence ("Individually" in AE). */
export function trimIndividually(groups: BezierPath[][], range: [number, number] | null): BezierPath[][] {
  if (!range) return groups.map(() => []);
  const lens = groups.map((g) => g.map((p) => pathLength(p)));
  const total = lens.flat().reduce((a, b) => a + b, 0);
  if (total <= 1e-9) return groups.map(() => []);
  let a = range[0] - Math.floor(range[0]);
  let b = a + (range[1] - range[0]);
  // two windows when wrapping past the end
  const windows: [number, number][] = b <= 1 ? [[a * total, b * total]] : [[a * total, total], [0, (b - 1) * total]];
  let acc = 0;
  return groups.map((g, gi) =>
    g.flatMap((p, pi) => {
      const L = lens[gi][pi];
      const s0 = acc;
      acc += L;
      if (L <= 1e-9) return [];
      const res: BezierPath[] = [];
      for (const [w0, w1] of windows) {
        const lo = Math.max(w0, s0), hi = Math.min(w1, s0 + L);
        if (hi - lo <= 1e-6) continue;
        if (hi - lo >= L - 1e-6) res.push(clonePath(p));
        else res.push(...trimPathOpen(p, (lo - s0) / L, (hi - s0) / L));
      }
      return res;
    }),
  );
}

function trimPathOpen(p: BezierPath, a: number, b: number): BezierPath[] {
  // closed paths cut at the start vertex when trimmed sequentially
  return trimPath({ ...p, closed: p.closed }, a, b).map((x) => ({ ...x, closed: false }));
}

// ── Zig Zag ─────────────────────────────────────────────────────────────────

export function zigzag(paths: BezierPath[], size: number, ridges: number, smooth: boolean): BezierPath[] {
  const r = Math.max(0, Math.round(ridges));
  if (Math.abs(size) < 1e-6) return paths.map(clonePath);
  return paths.map((p) => {
    const segs = segments(p);
    if (!segs.length) return clonePath(p);
    const pts: { p: Vec2; n: Vec2; t: Vec2; spacing: number }[] = [];
    segs.forEach((s, k) => {
      const L = segLength(s);
      const count = r + 1;
      for (let j = 0; j < count; j++) {
        const t = segParamAtLength(s, (L * j) / count, L);
        const pt = pointOnSeg(s, t);
        const tan = tangentOnSeg(s, t);
        const tl = Math.hypot(tan[0], tan[1]) || 1;
        pts.push({ p: pt, n: [tan[1] / tl, -tan[0] / tl], t: [tan[0] / tl, tan[1] / tl], spacing: L / count });
      }
      if (!p.closed && k === segs.length - 1) {
        const tan = tangentOnSeg(s, 1);
        const tl = Math.hypot(tan[0], tan[1]) || 1;
        pts.push({ p: [s[3][0], s[3][1]], n: [tan[1] / tl, -tan[0] / tl], t: [tan[0] / tl, tan[1] / tl], spacing: L / (r + 1) });
      }
    });
    const v: Vec2[] = [], ii: Vec2[] = [], oo: Vec2[] = [];
    pts.forEach((q, k) => {
      const dir = k % 2 === 0 ? 1 : -1;
      v.push([q.p[0] + q.n[0] * size * dir, q.p[1] + q.n[1] * size * dir]);
      if (smooth) {
        const h = q.spacing * 0.5;
        ii.push([-q.t[0] * h, -q.t[1] * h]);
        oo.push([q.t[0] * h, q.t[1] * h]);
      } else {
        ii.push([0, 0]);
        oo.push([0, 0]);
      }
    });
    return { closed: p.closed, v, i: ii, o: oo };
  });
}

// ── Round Corners ───────────────────────────────────────────────────────────

const ROUND_K = 0.5519;

export function roundCorners(paths: BezierPath[], radius: number): BezierPath[] {
  if (radius <= 0) return paths.map(clonePath);
  return paths.map((p) => {
    const n = p.v.length;
    if (n < 2) return clonePath(p);
    const v: Vec2[] = [], ii: Vec2[] = [], oo: Vec2[] = [];
    for (let k = 0; k < n; k++) {
      const cur = p.v[k];
      const isCorner = Math.hypot(p.i[k][0], p.i[k][1]) < 1e-6 && Math.hypot(p.o[k][0], p.o[k][1]) < 1e-6;
      const hasPrev = p.closed || k > 0;
      const hasNext = p.closed || k < n - 1;
      if (!isCorner || !hasPrev || !hasNext) {
        v.push([cur[0], cur[1]]);
        ii.push([p.i[k][0], p.i[k][1]]);
        oo.push([p.o[k][0], p.o[k][1]]);
        continue;
      }
      const prev = p.v[(k - 1 + n) % n];
      const next = p.v[(k + 1) % n];
      const dPrev = Math.hypot(prev[0] - cur[0], prev[1] - cur[1]);
      const dNext = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
      const rp = dPrev > 0 ? Math.min(radius, dPrev / 2) / dPrev : 0;
      const rn = dNext > 0 ? Math.min(radius, dNext / 2) / dNext : 0;
      const a: Vec2 = [cur[0] + (prev[0] - cur[0]) * rp, cur[1] + (prev[1] - cur[1]) * rp];
      const b: Vec2 = [cur[0] + (next[0] - cur[0]) * rn, cur[1] + (next[1] - cur[1]) * rn];
      v.push(a);
      ii.push([0, 0]);
      oo.push([(cur[0] - a[0]) * ROUND_K, (cur[1] - a[1]) * ROUND_K]);
      v.push(b);
      ii.push([(cur[0] - b[0]) * ROUND_K, (cur[1] - b[1]) * ROUND_K]);
      oo.push([0, 0]);
    }
    // preserve incoming tangent of first vertex for open paths
    return { closed: p.closed, v, i: ii, o: oo };
  });
}

// ── Offset Paths ────────────────────────────────────────────────────────────

function signedArea(p: BezierPath): number {
  let a = 0;
  const n = p.v.length;
  for (let k = 0; k < n; k++) {
    const q = p.v[k], r = p.v[(k + 1) % n];
    a += q[0] * r[1] - r[0] * q[1];
  }
  return a / 2;
}

export function offsetPaths(paths: BezierPath[], amount: number, miterLimit: number): BezierPath[] {
  if (Math.abs(amount) < 1e-6) return paths.map(clonePath);
  return paths.map((p) => {
    const n = p.v.length;
    if (n < 2) return clonePath(p);
    // In y-down space a positive shoelace area means clockwise winding on screen.
    const sign = p.closed ? (signedArea(p) >= 0 ? 1 : -1) : 1;
    const cx = p.v.reduce((s, q) => s + q[0], 0) / n;
    const cy = p.v.reduce((s, q) => s + q[1], 0) / n;
    const v: Vec2[] = [], ii: Vec2[] = [], oo: Vec2[] = [];
    for (let k = 0; k < n; k++) {
      const cur = p.v[k];
      const hasPrev = p.closed || k > 0, hasNext = p.closed || k < n - 1;
      const inDir = Math.hypot(p.i[k][0], p.i[k][1]) > 1e-6 ? [-p.i[k][0], -p.i[k][1]] : hasPrev ? [cur[0] - p.v[(k - 1 + n) % n][0], cur[1] - p.v[(k - 1 + n) % n][1]] : null;
      const outDir = Math.hypot(p.o[k][0], p.o[k][1]) > 1e-6 ? [p.o[k][0], p.o[k][1]] : hasNext ? [p.v[(k + 1) % n][0] - cur[0], p.v[(k + 1) % n][1] - cur[1]] : null;
      // outward normal of a direction: (dy, -dx) for clockwise-on-screen paths, flipped otherwise
      const nrm = (d: number[] | null): Vec2 => {
        if (!d) return [0, 0];
        const l = Math.hypot(d[0], d[1]) || 1;
        return [(d[1] / l) * sign, (-d[0] / l) * sign];
      };
      const n1 = nrm(inDir ?? outDir), n2 = nrm(outDir ?? inDir);
      let nx = n1[0] + n2[0], ny = n1[1] + n2[1];
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl; ny /= nl;
      const cosHalf = Math.max(1e-3, nx * n1[0] + ny * n1[1]);
      const miter = Math.min(1 / cosHalf, Math.max(1, miterLimit));
      const d = amount * miter;
      const nv: Vec2 = [cur[0] + nx * d, cur[1] + ny * d];
      const R = Math.hypot(cur[0] - cx, cur[1] - cy);
      const s = R > 1e-6 ? Math.max(0, (R + amount) / R) : 1;
      v.push(nv);
      ii.push([p.i[k][0] * s, p.i[k][1] * s]);
      oo.push([p.o[k][0] * s, p.o[k][1] * s]);
    }
    return { closed: p.closed, v, i: ii, o: oo };
  });
}

// ── Pucker & Bloat ──────────────────────────────────────────────────────────

export function puckerBloat(paths: BezierPath[], amount: number): BezierPath[] {
  if (Math.abs(amount) < 1e-6) return paths.map(clonePath);
  const pct = amount / 100;
  return paths.map((p) => {
    const n = p.v.length;
    if (!n) return clonePath(p);
    const cx = p.v.reduce((s, q) => s + q[0], 0) / n;
    const cy = p.v.reduce((s, q) => s + q[1], 0) / n;
    const v: Vec2[] = [], ii: Vec2[] = [], oo: Vec2[] = [];
    for (let k = 0; k < n; k++) {
      const q = p.v[k];
      const nv: Vec2 = [q[0] + (cx - q[0]) * pct, q[1] + (cy - q[1]) * pct];
      const oa = [q[0] + p.o[k][0], q[1] + p.o[k][1]];
      const ia = [q[0] + p.i[k][0], q[1] + p.i[k][1]];
      const no: Vec2 = [oa[0] + (cx - oa[0]) * -pct, oa[1] + (cy - oa[1]) * -pct];
      const ni: Vec2 = [ia[0] + (cx - ia[0]) * -pct, ia[1] + (cy - ia[1]) * -pct];
      v.push(nv);
      oo.push([no[0] - nv[0], no[1] - nv[1]]);
      ii.push([ni[0] - nv[0], ni[1] - nv[1]]);
    }
    return { closed: p.closed, v, i: ii, o: oo };
  });
}

// ── subdivision helper ──────────────────────────────────────────────────────

/** Split every segment into `parts` sub-segments (preserves the exact curve). */
export function subdivide(p: BezierPath, parts: number): BezierPath {
  const c = segmentCount(p);
  if (c === 0 || parts <= 1) return clonePath(p);
  const segsOut: Seg[] = [];
  for (let k = 0; k < c; k++) {
    const s = getSegment(p, k);
    if (isLinearSeg(s)) {
      for (let j = 0; j < parts; j++) {
        const a = pointOnSeg(s, j / parts), b = pointOnSeg(s, (j + 1) / parts);
        segsOut.push([a, a, b, b]);
      }
    } else {
      for (let j = 0; j < parts; j++) segsOut.push(subSeg(s, j / parts, (j + 1) / parts));
    }
  }
  return pathFromSegs(segsOut, p.closed);
}

// ── Twist ───────────────────────────────────────────────────────────────────

export function twist(paths: BezierPath[], angleDeg: number, center: number[]): BezierPath[] {
  if (Math.abs(angleDeg) < 1e-6) return paths.map(clonePath);
  let maxD = 0;
  for (const p of paths) for (const v of p.v) maxD = Math.max(maxD, Math.hypot(v[0] - center[0], v[1] - center[1]));
  if (maxD <= 1e-6) return paths.map(clonePath);
  const rot = (q: number[]): Vec2 => {
    const dx = q[0] - center[0], dy = q[1] - center[1];
    const d = Math.hypot(dx, dy);
    const a = ((angleDeg * Math.PI) / 180) * (1 - Math.min(1, d / maxD));
    const c = Math.cos(a), s = Math.sin(a);
    return [center[0] + dx * c - dy * s, center[1] + dx * s + dy * c];
  };
  return paths.map((p0) => {
    const p = subdivide(p0, 6);
    const v: Vec2[] = [], ii: Vec2[] = [], oo: Vec2[] = [];
    for (let k = 0; k < p.v.length; k++) {
      const q = p.v[k];
      const nv = rot(q);
      const no = rot([q[0] + p.o[k][0], q[1] + p.o[k][1]]);
      const ni = rot([q[0] + p.i[k][0], q[1] + p.i[k][1]]);
      v.push(nv);
      oo.push([no[0] - nv[0], no[1] - nv[1]]);
      ii.push([ni[0] - nv[0], ni[1] - nv[1]]);
    }
    return { closed: p.closed, v, i: ii, o: oo };
  });
}

// ── Wiggle Paths ────────────────────────────────────────────────────────────

export function wigglePaths(
  paths: BezierPath[], size: number, detail: number, wigglesPerSec: number, correlation: number,
  temporalPhaseDeg: number, spatialPhaseDeg: number, seed: number, time: number, smooth: boolean,
): BezierPath[] {
  if (Math.abs(size) < 1e-6) return paths.map(clonePath);
  const parts = Math.max(1, Math.round(detail) + 1);
  const tPhase = temporalPhaseDeg / 360;
  const sPhase = spatialPhaseDeg / 360;
  const corr = Math.max(0, Math.min(100, correlation)) / 100;
  const spatialFreq = 0.15 + (1 - corr) * 1.85;
  let idx = 0;
  return paths.map((p0, pi) => {
    const p = subdivide(p0, parts);
    const v: Vec2[] = [], ii: Vec2[] = [], oo: Vec2[] = [];
    for (let k = 0; k < p.v.length; k++, idx++) {
      const sx = idx * spatialFreq + sPhase * 10;
      const tt = time * wigglesPerSec + tPhase;
      const dx = noise1(sx + tt * 1.7, seed + pi * 31) * size;
      const dy = noise1(sx * 1.3 + tt * 1.9 + 97.3, seed + 17 + pi * 31) * size;
      const q = p.v[k];
      v.push([q[0] + dx, q[1] + dy]);
      if (smooth) {
        ii.push([p.i[k][0], p.i[k][1]]);
        oo.push([p.o[k][0], p.o[k][1]]);
      } else {
        ii.push([0, 0]);
        oo.push([0, 0]);
      }
    }
    return { closed: p.closed, v, i: ii, o: oo };
  });
}

