// Synthetic imagery for the computer-vision tests: a continuous procedural texture that can be
// sampled at any sub-pixel position, so ground-truth motion is exact.
import type { Gray } from '../src/cv/image';
import { rng } from '../src/cv/linalg';

export type Field = (x: number, y: number) => number;

export function texture(seed = 7): Field {
  const r = rng(seed);
  const B = 48;
  const buckets = new Map<number, { x: number; y: number; s: number; a: number; sq: boolean }[]>();
  const key = (bx: number, by: number) => (bx + 1000) * 4096 + (by + 1000);
  for (let i = 0; i < 9000; i++) {
    const it = { x: r() * 2400 - 600, y: r() * 1800 - 500, s: 2.5 + r() * 9, a: (r() - 0.5) * 200, sq: r() < 0.35 };
    const ext = it.s * 3;
    for (let by = Math.floor((it.y - ext) / B); by <= Math.floor((it.y + ext) / B); by++)
      for (let bx = Math.floor((it.x - ext) / B); bx <= Math.floor((it.x + ext) / B); bx++) {
        const k = key(bx, by);
        let l = buckets.get(k);
        if (!l) buckets.set(k, (l = []));
        l.push(it);
      }
  }
  const waves = Array.from({ length: 6 }, () => ({ fx: (r() - 0.5) * 0.12, fy: (r() - 0.5) * 0.12, p: r() * 6.28, a: 6 + r() * 14 }));
  return (x, y) => {
    let v = 128;
    for (const w of waves) v += w.a * Math.sin(w.fx * x + w.fy * y + w.p);
    const l = buckets.get(key(Math.floor(x / B), Math.floor(y / B)));
    if (l) for (const b of l) {
      const dx = x - b.x, dy = y - b.y;
      if (b.sq) {
        // soft-edged square (1px ramp) — gives FAST real corners
        const e = Math.min(b.s - Math.abs(dx), b.s - Math.abs(dy));
        if (e > -1) v += b.a * Math.min(1, e + 1) * 0.6;
      } else {
        const d2 = dx * dx + dy * dy;
        if (d2 < 9 * b.s * b.s) v += b.a * Math.exp(-d2 / (2 * b.s * b.s));
      }
    }
    return Math.max(0, Math.min(255, v));
  };
}

/** Render `field` through an inverse warp: pixel (x, y) shows field(warp(x, y)). */
export function render(field: Field, w: number, h: number, warp: (x: number, y: number) => [number, number] = (x, y) => [x, y]): Gray {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [u, v] = warp(x, y);
    data[y * w + x] = field(u, v);
  }
  return { w, h, data };
}
