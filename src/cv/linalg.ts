// ─────────────────────────────────────────────────────────────────────────────
// Dense linear algebra for the computer-vision solvers.
//
// Everything here works on small, row-major Float64Array matrices (DLT systems,
// 3×3 rotations, bundle-adjustment blocks). The routines are deliberately
// dependency-free so they run identically in Web Workers and in node tests:
//   * one-sided Jacobi SVD (Hestenes) — accurate for the rank-deficient DLT
//     systems used by homography / essential-matrix / PnP estimation
//   * cyclic Jacobi eigen-decomposition for symmetric matrices
//   * Cholesky and partial-pivot LU solvers
//   * rotation helpers (Rodrigues, quaternions, AE Euler order)
// ─────────────────────────────────────────────────────────────────────────────

export type Mat = Float64Array;
export type V3 = [number, number, number];

export interface SVD {
  /** m×n, columns are left singular vectors (thin) */
  U: Mat;
  /** n singular values, descending */
  S: Float64Array;
  /** n×n, columns are right singular vectors */
  V: Mat;
}

/**
 * Singular value decomposition A = U·diag(S)·Vᵀ of an m×n row-major matrix by one-sided Jacobi
 * rotations. Works for any m, n (for m < n the trailing singular values are zero and their right
 * singular vectors span the null space, which is exactly what the DLT estimators need).
 */
export function svd(A: ArrayLike<number>, m: number, n: number): SVD {
  const W = new Float64Array(m * n);
  for (let i = 0; i < m * n; i++) W[i] = A[i];
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  const eps = 1e-15;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        let alpha = 0, beta = 0, gamma = 0;
        for (let i = 0; i < m; i++) {
          const wp = W[i * n + p], wq = W[i * n + q];
          alpha += wp * wp;
          beta += wq * wq;
          gamma += wp * wq;
        }
        if (Math.abs(gamma) <= eps * Math.sqrt(alpha * beta) || gamma === 0) continue;
        off = Math.max(off, Math.abs(gamma) / Math.sqrt(alpha * beta));
        const zeta = (beta - alpha) / (2 * gamma);
        const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t), s = c * t;
        for (let i = 0; i < m; i++) {
          const wp = W[i * n + p], wq = W[i * n + q];
          W[i * n + p] = c * wp - s * wq;
          W[i * n + q] = s * wp + c * wq;
        }
        for (let i = 0; i < n; i++) {
          const vp = V[i * n + p], vq = V[i * n + q];
          V[i * n + p] = c * vp - s * vq;
          V[i * n + q] = s * vp + c * vq;
        }
      }
    }
    if (off < 1e-14) break;
  }
  const S = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let i = 0; i < m; i++) s += W[i * n + j] * W[i * n + j];
    S[j] = Math.sqrt(s);
  }
  // sort descending
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => S[b] - S[a]);
  const U = new Float64Array(m * n), V2 = new Float64Array(n * n), S2 = new Float64Array(n);
  order.forEach((src, dst) => {
    S2[dst] = S[src];
    const inv = S[src] > 1e-300 ? 1 / S[src] : 0;
    for (let i = 0; i < m; i++) U[i * n + dst] = W[i * n + src] * inv;
    for (let i = 0; i < n; i++) V2[i * n + dst] = V[i * n + src];
  });
  return { U, S: S2, V: V2 };
}

/** Unit vector x minimising |A·x| (right singular vector of the smallest singular value). */
export function nullVector(A: ArrayLike<number>, m: number, n: number): Float64Array {
  const { V } = svd(A, m, n);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = V[i * n + n - 1];
  return x;
}

/**
 * Eigen-decomposition of a symmetric n×n matrix by cyclic Jacobi rotations.
 * Returns eigenvalues ascending; eigenvector k is column k of `vectors`.
 */
export function symEig(Ain: ArrayLike<number>, n: number): { values: Float64Array; vectors: Mat } {
  const A = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) A[i] = Ain[i];
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 80; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p * n + q] * A[p * n + q];
    if (off < 1e-26) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (A[q * n + q] - A[p * n + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k * n + p], akq = A[k * n + q];
          A[k * n + p] = c * akp - s * akq;
          A[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p * n + k], aqk = A[q * n + k];
          A[p * n + k] = c * apk - s * aqk;
          A[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p], vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => A[a * n + a] - A[b * n + b]);
  const values = new Float64Array(n), vectors = new Float64Array(n * n);
  order.forEach((src, dst) => {
    values[dst] = A[src * n + src];
    for (let k = 0; k < n; k++) vectors[k * n + dst] = V[k * n + src];
  });
  return { values, vectors };
}

/** Solve A·x = b for symmetric positive-definite A (n×n) in place of a copy. Returns null if not PD. */
export function choleskySolve(A: ArrayLike<number>, b: ArrayLike<number>, n: number): Float64Array | null {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (s <= 0 || !Number.isFinite(s)) return null;
        L[i * n + i] = Math.sqrt(s);
      } else L[i * n + j] = s / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

/** Solve a general square system by LU with partial pivoting. Returns null when singular. */
export function luSolve(Ain: ArrayLike<number>, bin: ArrayLike<number>, n: number): Float64Array | null {
  const A = Float64Array.from(Ain as ArrayLike<number>);
  const b = Float64Array.from(bin as ArrayLike<number>);
  for (let c = 0; c < n; c++) {
    let piv = c, best = Math.abs(A[c * n + c]);
    for (let r = c + 1; r < n; r++) {
      const v = Math.abs(A[r * n + c]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-300) return null;
    if (piv !== c) {
      for (let k = 0; k < n; k++) {
        const t = A[c * n + k]; A[c * n + k] = A[piv * n + k]; A[piv * n + k] = t;
      }
      const t = b[c]; b[c] = b[piv]; b[piv] = t;
    }
    const d = A[c * n + c];
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / d;
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    x[r] = s / A[r * n + r];
  }
  return x;
}

/** Linear least squares min |A·x − b| via normal equations with a tiny ridge for stability. */
export function leastSquares(A: ArrayLike<number>, b: ArrayLike<number>, m: number, n: number, ridge = 1e-12): Float64Array | null {
  const AtA = new Float64Array(n * n), Atb = new Float64Array(n);
  for (let r = 0; r < m; r++) {
    for (let i = 0; i < n; i++) {
      const ai = A[r * n + i];
      if (ai === 0) continue;
      Atb[i] += ai * b[r];
      for (let j = i; j < n; j++) AtA[i * n + j] += ai * A[r * n + j];
    }
  }
  let tr = 0;
  for (let i = 0; i < n; i++) tr += AtA[i * n + i];
  for (let i = 0; i < n; i++) {
    AtA[i * n + i] += ridge * (tr / n + 1e-300);
    for (let j = 0; j < i; j++) AtA[i * n + j] = AtA[j * n + i];
  }
  return choleskySolve(AtA, Atb, n) ?? luSolve(AtA, Atb, n);
}

// ── 3×3 helpers ─────────────────────────────────────────────────────────────

export function mat3Mul(a: ArrayLike<number>, b: ArrayLike<number>): Mat {
  const o = new Float64Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
}

export function mat3T(a: ArrayLike<number>): Mat {
  return Float64Array.of(a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]);
}

export function mat3Det(a: ArrayLike<number>): number {
  return a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
}

export function mat3Inv(a: ArrayLike<number>): Mat | null {
  const det = mat3Det(a);
  if (Math.abs(det) < 1e-300) return null;
  const d = 1 / det;
  return Float64Array.of(
    (a[4] * a[8] - a[5] * a[7]) * d, (a[2] * a[7] - a[1] * a[8]) * d, (a[1] * a[5] - a[2] * a[4]) * d,
    (a[5] * a[6] - a[3] * a[8]) * d, (a[0] * a[8] - a[2] * a[6]) * d, (a[2] * a[3] - a[0] * a[5]) * d,
    (a[3] * a[7] - a[4] * a[6]) * d, (a[1] * a[6] - a[0] * a[7]) * d, (a[0] * a[4] - a[1] * a[3]) * d,
  );
}

export function mat3Vec(a: ArrayLike<number>, v: ArrayLike<number>): V3 {
  return [
    a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
    a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
    a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
  ];
}

export function skew3(v: ArrayLike<number>): Mat {
  return Float64Array.of(0, -v[2], v[1], v[2], 0, -v[0], -v[1], v[0], 0);
}

export const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
export const norm3 = (a: ArrayLike<number>): number => Math.hypot(a[0], a[1], a[2]);
export const sub3 = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add3 = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale3 = (a: ArrayLike<number>, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export function normalize3(a: ArrayLike<number>): V3 {
  const l = norm3(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Closest rotation matrix (in the Frobenius sense) to a 3×3 matrix. */
export function orthonormalize(M: ArrayLike<number>): Mat {
  const { U, V } = svd(M, 3, 3);
  let R = mat3Mul(U, mat3T(V));
  if (mat3Det(R) < 0) {
    const U2 = Float64Array.from(U);
    for (let i = 0; i < 3; i++) U2[i * 3 + 2] = -U2[i * 3 + 2];
    R = mat3Mul(U2, mat3T(V));
  }
  return R;
}

// ── rotations ───────────────────────────────────────────────────────────────

/** Axis-angle vector → rotation matrix (Rodrigues). */
export function rodrigues(w: ArrayLike<number>): Mat {
  const th = Math.hypot(w[0], w[1], w[2]);
  if (th < 1e-12) return Float64Array.of(1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1);
  const kx = w[0] / th, ky = w[1] / th, kz = w[2] / th;
  const c = Math.cos(th), s = Math.sin(th), v = 1 - c;
  return Float64Array.of(
    c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s,
    ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s,
    kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v,
  );
}

/** Rotation matrix → axis-angle vector. */
export function rotationLog(R: ArrayLike<number>): V3 {
  const q = matToQuat(R);
  const s = Math.hypot(q[1], q[2], q[3]);
  if (s < 1e-12) return [2 * q[1], 2 * q[2], 2 * q[3]];
  const th = 2 * Math.atan2(s, q[0]);
  return [(q[1] / s) * th, (q[2] / s) * th, (q[3] / s) * th];
}

/** Rotation matrix → unit quaternion [w, x, y, z] (w ≥ 0). */
export function matToQuat(R: ArrayLike<number>): [number, number, number, number] {
  const tr = R[0] + R[4] + R[8];
  let w: number, x: number, y: number, z: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (R[7] - R[5]) / s; y = (R[2] - R[6]) / s; z = (R[3] - R[1]) / s;
  } else if (R[0] > R[4] && R[0] > R[8]) {
    const s = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2;
    w = (R[7] - R[5]) / s; x = 0.25 * s; y = (R[1] + R[3]) / s; z = (R[2] + R[6]) / s;
  } else if (R[4] > R[8]) {
    const s = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2;
    w = (R[2] - R[6]) / s; x = (R[1] + R[3]) / s; y = 0.25 * s; z = (R[5] + R[7]) / s;
  } else {
    const s = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2;
    w = (R[3] - R[1]) / s; x = (R[2] + R[6]) / s; y = (R[5] + R[7]) / s; z = 0.25 * s;
  }
  const l = Math.hypot(w, x, y, z) || 1;
  const sg = w < 0 ? -1 : 1;
  return [(sg * w) / l, (sg * x) / l, (sg * y) / l, (sg * z) / l];
}

export function quatToMat(q: ArrayLike<number>): Mat {
  const [w, x, y, z] = [q[0], q[1], q[2], q[3]];
  return Float64Array.of(
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  );
}

export function slerp(a: ArrayLike<number>, b: ArrayLike<number>, t: number): [number, number, number, number] {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bs = d < 0 ? -1 : 1;
  d = Math.abs(d);
  let wa: number, wb: number;
  if (d > 0.9995) {
    wa = 1 - t; wb = t;
  } else {
    const th = Math.acos(d), s = Math.sin(th);
    wa = Math.sin((1 - t) * th) / s;
    wb = Math.sin(t * th) / s;
  }
  const q: [number, number, number, number] = [
    wa * a[0] + wb * bs * b[0], wa * a[1] + wb * bs * b[1], wa * a[2] + wb * bs * b[2], wa * a[3] + wb * bs * b[3],
  ];
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

/** Rotation matrix for After Effects' orientation order: M = Rx(a)·Ry(b)·Rz(c), degrees. */
export function eulerXYZToMat(a: number, b: number, c: number): Mat {
  const ca = Math.cos(a * D2R), sa = Math.sin(a * D2R);
  const cb = Math.cos(b * D2R), sb = Math.sin(b * D2R);
  const cc = Math.cos(c * D2R), sc = Math.sin(c * D2R);
  return Float64Array.of(
    cb * cc, -cb * sc, sb,
    sa * sb * cc + ca * sc, -sa * sb * sc + ca * cc, -sa * cb,
    -ca * sb * cc + sa * sc, ca * sb * sc + sa * cc, ca * cb,
  );
}

/**
 * Inverse of eulerXYZToMat. `near` (degrees) picks the 360°-equivalent solution closest to a previous
 * frame so animated orientations never flip.
 */
export function matToEulerXYZ(M: ArrayLike<number>, near?: V3): V3 {
  const sb = Math.max(-1, Math.min(1, M[2]));
  let a: number, b: number, c: number;
  if (Math.abs(sb) < 0.999999) {
    b = Math.asin(sb);
    a = Math.atan2(-M[5], M[8]);
    c = Math.atan2(-M[1], M[0]);
  } else {
    // gimbal lock: fold X into Z
    b = (Math.PI / 2) * Math.sign(sb);
    a = Math.atan2(M[7], M[4]);
    c = 0;
  }
  const sol: V3 = [a * R2D, b * R2D, c * R2D];
  if (!near) return sol;
  // the alternative decomposition (a+180, 180-b, c+180) describes the same rotation
  const alt: V3 = [sol[0] + 180, 180 - sol[1], sol[2] + 180];
  const wrap = (v: V3): V3 => v.map((x, i) => x + 360 * Math.round((near[i] - x) / 360)) as V3;
  const s1 = wrap(sol), s2 = wrap(alt);
  const d1 = Math.abs(s1[0] - near[0]) + Math.abs(s1[1] - near[1]) + Math.abs(s1[2] - near[2]);
  const d2 = Math.abs(s2[0] - near[0]) + Math.abs(s2[1] - near[1]) + Math.abs(s2[2] - near[2]);
  return d1 <= d2 ? s1 : s2;
}

// ── robust statistics ───────────────────────────────────────────────────────

export function median(values: ArrayLike<number>): number {
  const a = Array.from(values).filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const h = a.length >> 1;
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
}

/** Deterministic PRNG (mulberry32) so RANSAC results are reproducible run to run. */
export function rng(seed = 0x9e3779b9): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k distinct random indices in [0, n). */
export function sampleIndices(n: number, k: number, rand: () => number): number[] {
  const out: number[] = [];
  while (out.length < k) {
    const i = Math.floor(rand() * n);
    if (!out.includes(i)) out.push(i);
  }
  return out;
}

/** RANSAC iteration count for a target confidence given the current inlier ratio. */
export function ransacIterations(inlierRatio: number, sampleSize: number, confidence = 0.995, maxIter = 2000): number {
  const w = Math.min(0.999999, Math.max(1e-6, inlierRatio));
  const denom = Math.log(1 - Math.pow(w, sampleSize));
  if (!Number.isFinite(denom) || denom >= 0) return maxIter;
  return Math.min(maxIter, Math.ceil(Math.log(1 - confidence) / denom));
}
