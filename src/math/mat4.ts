// Column-major 4x4 matrices (same memory layout WebGL expects).
// Conventions used throughout pooEffects:
//   * Composition space is in pixels, +X right, +Y DOWN, +Z INTO the screen (After Effects convention).
//   * Rotations are expressed in degrees at the API surface; positive Z rotation is clockwise on screen.
//   * Points are column vectors: p' = M * p.

export type Mat4 = Float64Array;

export function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function clone(a: Mat4): Mat4 {
  return new Float64Array(a);
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4], b1 = b[col * 4 + 1], b2 = b[col * 4 + 2], b3 = b[col * 4 + 3];
    out[col * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[col * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[col * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[col * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

/** Multiply a chain of matrices left-to-right: mulAll(A,B,C) = A*B*C. */
export function mulAll(...ms: Mat4[]): Mat4 {
  let r = ms[0];
  for (let i = 1; i < ms.length; i++) r = multiply(r, ms[i]);
  return r;
}

export function translation(x: number, y: number, z = 0): Mat4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function scaling(x: number, y: number, z = 1): Mat4 {
  const m = identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

const D2R = Math.PI / 180;

export function rotationX(deg: number): Mat4 {
  const r = deg * D2R, c = Math.cos(r), s = Math.sin(r);
  const m = identity();
  m[5] = c; m[6] = s;
  m[9] = -s; m[10] = c;
  return m;
}

export function rotationY(deg: number): Mat4 {
  const r = deg * D2R, c = Math.cos(r), s = Math.sin(r);
  const m = identity();
  m[0] = c; m[2] = -s;
  m[8] = s; m[10] = c;
  return m;
}

export function rotationZ(deg: number): Mat4 {
  const r = deg * D2R, c = Math.cos(r), s = Math.sin(r);
  const m = identity();
  m[0] = c; m[1] = s;
  m[4] = -s; m[5] = c;
  return m;
}

/** 2D shear along X by `deg`, applied around an axis rotated by `axisDeg` (AE shape-group skew). */
export function skew(deg: number, axisDeg: number): Mat4 {
  if (!deg) return identity();
  const k = Math.tan(-deg * D2R);
  const sh = identity();
  sh[4] = k;
  return mulAll(rotationZ(axisDeg), sh, rotationZ(-axisDeg));
}

export function invert(a: Mat4): Mat4 | null {
  const out = new Float64Array(16);
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-14) return null;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

/** Transform a point (w = 1). Performs perspective divide when `project` is true. */
export function transformPoint(m: Mat4, p: number[], project = false): [number, number, number] {
  const x = p[0] ?? 0, y = p[1] ?? 0, z = p[2] ?? 0;
  const ox = m[0] * x + m[4] * y + m[8] * z + m[12];
  const oy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const oz = m[2] * x + m[6] * y + m[10] * z + m[14];
  if (!project) return [ox, oy, oz];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  const iw = Math.abs(w) < 1e-12 ? 1e12 : 1 / w;
  return [ox * iw, oy * iw, oz * iw];
}

export function transformVec4(m: Mat4, p: number[]): [number, number, number, number] {
  const x = p[0], y = p[1], z = p[2], w = p[3];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ];
}

/** Transform a direction (w = 0). */
export function transformDir(m: Mat4, d: number[]): [number, number, number] {
  const x = d[0] ?? 0, y = d[1] ?? 0, z = d[2] ?? 0;
  return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
}

/**
 * Orthographic projection mapping composition pixels [0,W]x[0,H] to NDC [-1,1]^2 WITHOUT flipping Y.
 * Render targets therefore store row 0 = top of the composition; the final present pass flips.
 */
export function orthoComp(w: number, h: number, near = -100000, far = 100000): Mat4 {
  const m = identity();
  m[0] = 2 / w;
  m[5] = 2 / h;
  m[10] = 2 / (far - near);
  m[12] = -1;
  m[13] = -1;
  m[14] = -(far + near) / (far - near);
  return m;
}

/**
 * After-Effects style perspective projection. `zoom` is the camera Zoom property in pixels: a layer at
 * camera-space depth z == zoom is displayed at 100% scale. Camera space: +Z forward, +Y down.
 * Produces NDC without Y flip (consistent with orthoComp).
 */
export function perspectiveAE(w: number, h: number, zoom: number, near: number, far: number): Mat4 {
  const m = new Float64Array(16);
  m[0] = (2 * zoom) / w;
  m[5] = (2 * zoom) / h;
  m[10] = (far + near) / (far - near);
  m[11] = 1;
  m[14] = (-2 * far * near) / (far - near);
  return m;
}

/** Orthographic projection for camera space (centered), `scale` = screen pixels per world unit. */
export function orthoCentered(w: number, h: number, scale: number, near: number, far: number): Mat4 {
  const m = identity();
  m[0] = (2 * scale) / w;
  m[5] = (2 * scale) / h;
  m[10] = 2 / (far - near);
  m[14] = -(far + near) / (far - near);
  return m;
}

/**
 * Camera-to-world rotation for a camera at `eye` looking at `target` in AE space (+Y down).
 * Columns are the camera's right (+X), down (+Y) and forward (+Z) axes expressed in world space.
 */
export function lookAtRotation(eye: number[], target: number[]): Mat4 {
  let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
  let fl = Math.hypot(fx, fy, fz);
  if (fl < 1e-9) { fx = 0; fy = 0; fz = 1; fl = 1; }
  fx /= fl; fy /= fl; fz /= fl;
  // world "down" reference
  let dx = 0, dy = 1, dz = 0;
  if (Math.abs(fy) > 0.9999) { dx = 0; dy = 0; dz = fy > 0 ? -1 : 1; }
  // right = down x forward
  let rx = dy * fz - dz * fy, ry = dz * fx - dx * fz, rz = dx * fy - dy * fx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  // down = forward x right
  const ux = fy * rz - fz * ry, uy = fz * rx - fx * rz, uz = fx * ry - fy * rx;
  const m = identity();
  m[0] = rx; m[1] = ry; m[2] = rz;
  m[4] = ux; m[5] = uy; m[6] = uz;
  m[8] = fx; m[9] = fy; m[10] = fz;
  return m;
}

/** Decompose the approximate uniform scale factor of the upper 3x3 (used for raster resolution). */
export function maxScale(m: Mat4): number {
  const sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  return Math.max(sx, sy);
}

export function toFloat32(m: Mat4): Float32Array {
  return new Float32Array(m);
}

/** Extract the translation column. */
export function getTranslation(m: Mat4): [number, number, number] {
  return [m[12], m[13], m[14]];
}
