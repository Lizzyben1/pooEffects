// Small, allocation-light vector helpers operating on plain number arrays.
// Used by the animation engine, shape geometry and the viewport overlay.

export type V = number[];
export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export const add = (a: V, b: V): V => a.map((x, i) => x + (b[i] ?? 0));
export const sub = (a: V, b: V): V => a.map((x, i) => x - (b[i] ?? 0));
export const mul = (a: V, s: number): V => a.map((x) => x * s);
export const dot = (a: V, b: V): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * (b[i] ?? 0);
  return s;
};
export const len = (a: V): number => Math.sqrt(dot(a, a));
export const dist = (a: V, b: V): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - (b[i] ?? 0);
    s += d * d;
  }
  return Math.sqrt(s);
};
export const normalize = (a: V): V => {
  const l = len(a);
  return l > 1e-12 ? a.map((x) => x / l) : a.map(() => 0);
};
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
};
export const fract = (x: number): number => x - Math.floor(x);
export const mod = (a: number, n: number): number => ((a % n) + n) % n;
