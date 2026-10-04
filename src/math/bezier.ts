// Cubic Bézier utilities shared by temporal easing, spatial motion paths and vector shapes.

export function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

export function cubicDeriv(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return 3 * u * u * (p1 - p0) + 6 * u * t * (p2 - p1) + 3 * t * t * (p3 - p2);
}

/**
 * Solve x(s) = x for s in [0,1] where x(s) is a cubic with control values x0..x3 that is monotonic
 * non-decreasing (guaranteed when x1,x2 lie within [x0,x3], which AE-style influence clamping ensures).
 * Newton iterations with bisection fallback for robustness.
 */
export function solveCubicForX(x0: number, x1: number, x2: number, x3: number, x: number): number {
  if (x <= x0) return 0;
  if (x >= x3) return 1;
  let lo = 0, hi = 1;
  // initial guess: linear
  let s = (x - x0) / (x3 - x0 || 1);
  for (let i = 0; i < 8; i++) {
    const fx = cubic(x0, x1, x2, x3, s) - x;
    if (Math.abs(fx) < 1e-9) return s;
    if (fx > 0) hi = s; else lo = s;
    const d = cubicDeriv(x0, x1, x2, x3, s);
    if (Math.abs(d) < 1e-9) break;
    const ns = s - fx / d;
    if (ns <= lo || ns >= hi) break;
    s = ns;
  }
  for (let i = 0; i < 60; i++) {
    s = (lo + hi) * 0.5;
    const fx = cubic(x0, x1, x2, x3, s) - x;
    if (Math.abs(fx) < 1e-9) return s;
    if (fx > 0) hi = s; else lo = s;
  }
  return (lo + hi) * 0.5;
}

/** Evaluate an N-dimensional cubic Bézier. */
export function bezierPoint(p0: number[], p1: number[], p2: number[], p3: number[], t: number): number[] {
  const n = p0.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = cubic(p0[i], p1[i], p2[i], p3[i], t);
  return out;
}

export interface ArcTable {
  /** cumulative arc length at sample k (k = 0..N) */
  lengths: Float64Array;
  total: number;
}

const ARC_SAMPLES = 64;

export function buildArcTable(p0: number[], p1: number[], p2: number[], p3: number[], samples = ARC_SAMPLES): ArcTable {
  const lengths = new Float64Array(samples + 1);
  let prev = p0;
  let acc = 0;
  for (let k = 1; k <= samples; k++) {
    const pt = bezierPoint(p0, p1, p2, p3, k / samples);
    let d = 0;
    for (let i = 0; i < pt.length; i++) {
      const e = pt[i] - prev[i];
      d += e * e;
    }
    acc += Math.sqrt(d);
    lengths[k] = acc;
    prev = pt;
  }
  return { lengths, total: acc };
}

/** Map an arc length distance to the curve parameter using the lookup table (linear inverse interpolation). */
export function paramAtLength(table: ArcTable, d: number): number {
  const { lengths, total } = table;
  const n = lengths.length - 1;
  if (total <= 0) return d <= 0 ? 0 : 1;
  if (d <= 0) return 0;
  if (d >= total) return 1;
  let lo = 0, hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lengths[mid] < d) lo = mid; else hi = mid;
  }
  const seg = lengths[hi] - lengths[lo];
  const f = seg > 0 ? (d - lengths[lo]) / seg : 0;
  return (lo + f) / n;
}

/** CSS-style cubic-bezier(x1,y1,x2,y2) easing evaluator (used for presets and UI). */
export function cssEase(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const s = solveCubicForX(0, x1, x2, 1, x);
  return cubic(0, y1, y2, 1, s);
}
