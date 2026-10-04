// ─────────────────────────────────────────────────────────────────────────────
// Grayscale image primitives for tracking: channel extraction, Gaussian
// pyramids, Scharr gradients, bilinear sampling and integral images.
// Pixel values are kept in 0..255 floats so thresholds read like 8-bit values.
// ─────────────────────────────────────────────────────────────────────────────

export interface Gray {
  w: number;
  h: number;
  data: Float32Array;
}

import type { TrackChannel } from '../core/types';

export type { TrackChannel };

export function makeGray(w: number, h: number): Gray {
  return { w, h, data: new Float32Array(w * h) };
}

/** Extract one analysis channel from (premultiplied or straight) RGBA8 pixels. */
export function toGray(rgba: ArrayLike<number>, w: number, h: number, channel: TrackChannel = 'luminance'): Gray {
  const out = makeGray(w, h);
  const d = out.data;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    switch (channel) {
      case 'red': d[i] = r; break;
      case 'green': d[i] = g; break;
      case 'blue': d[i] = b; break;
      case 'saturation': {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        d[i] = mx > 0 ? ((mx - mn) / mx) * 255 : 0;
        break;
      }
      default: d[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
  }
  return out;
}

/** Separable Gaussian blur with clamped edges. */
export function blurGray(img: Gray, sigma: number): Gray {
  if (sigma < 0.3) return { w: img.w, h: img.h, data: img.data.slice() };
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const { w, h } = img;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i;
        acc += img.data[row + xx] * k[i + r];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
        acc += tmp[yy * w + x] * k[i + r];
      }
      out[y * w + x] = acc;
    }
  }
  return { w, h, data: out };
}

/** 5-tap binomial low-pass + 2× decimation (Burt–Adelson REDUCE). */
export function pyrDown(img: Gray): Gray {
  const { w, h, data } = img;
  const nw = Math.max(1, (w + 1) >> 1), nh = Math.max(1, (h + 1) >> 1);
  const tmp = new Float32Array(nw * h);
  const cx = (x: number) => (x < 0 ? 0 : x >= w ? w - 1 : x);
  const cy = (y: number) => (y < 0 ? 0 : y >= h ? h - 1 : y);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < nw; x++) {
      const sx = x * 2;
      tmp[y * nw + x] =
        (data[row + cx(sx - 2)] + 4 * data[row + cx(sx - 1)] + 6 * data[row + sx] + 4 * data[row + cx(sx + 1)] + data[row + cx(sx + 2)]) / 16;
    }
  }
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = y * 2;
    const r0 = cy(sy - 2) * nw, r1 = cy(sy - 1) * nw, r2 = cy(sy) * nw, r3 = cy(sy + 1) * nw, r4 = cy(sy + 2) * nw;
    for (let x = 0; x < nw; x++) out[y * nw + x] = (tmp[r0 + x] + 4 * tmp[r1 + x] + 6 * tmp[r2 + x] + 4 * tmp[r3 + x] + tmp[r4 + x]) / 16;
  }
  return { w: nw, h: nh, data: out };
}

/** Bilinear resample to an arbitrary size (area-averaged when shrinking by > 2×). */
export function resizeGray(img: Gray, w: number, h: number): Gray {
  let src = img;
  while (src.w >= w * 2 && src.h >= h * 2) src = pyrDown(src);
  const out = makeGray(w, h);
  const sx = src.w / w, sy = src.h / h;
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    for (let x = 0; x < w; x++) out.data[y * w + x] = sample(src, (x + 0.5) * sx - 0.5, fy);
  }
  return out;
}

/** Bilinear sample with edge clamping. */
export function sample(img: Gray, x: number, y: number): number {
  const { w, h, data } = img;
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = x | 0, y0 = y | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0, fy = y - y0;
  const a = data[y0 * w + x0], b = data[y0 * w + x1], c = data[y1 * w + x0], d = data[y1 * w + x1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Bilinear sample of a raw float plane with the same layout as `img`. */
export function samplePlane(plane: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = x | 0, y0 = y | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0, fy = y - y0;
  const a = plane[y0 * w + x0], b = plane[y0 * w + x1], c = plane[y1 * w + x0], d = plane[y1 * w + x1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Scharr derivatives (normalised so a unit ramp has gradient 1). */
export function gradients(img: Gray): { gx: Float32Array; gy: Float32Array } {
  const { w, h, data } = img;
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = (y > 0 ? y - 1 : 0) * w, yc = y * w, yp = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1;
      gx[yc + x] = (3 * (data[ym + xp] - data[ym + xm]) + 10 * (data[yc + xp] - data[yc + xm]) + 3 * (data[yp + xp] - data[yp + xm])) / 32;
      gy[yc + x] = (3 * (data[yp + xm] - data[ym + xm]) + 10 * (data[yp + x] - data[ym + x]) + 3 * (data[yp + xp] - data[ym + xp])) / 32;
    }
  }
  return { gx, gy };
}

export interface Pyramid {
  levels: Gray[];
  gx: Float32Array[];
  gy: Float32Array[];
}

/** Gaussian pyramid with per-level gradients. Stops when a level would drop below `minSize`. */
export function buildPyramid(img: Gray, maxLevels: number, minSize = 24): Pyramid {
  const levels: Gray[] = [img];
  while (levels.length < maxLevels) {
    const top = levels[levels.length - 1];
    if (Math.min(top.w, top.h) / 2 < minSize) break;
    levels.push(pyrDown(top));
  }
  const gx: Float32Array[] = [], gy: Float32Array[] = [];
  for (const l of levels) {
    const g = gradients(l);
    gx.push(g.gx);
    gy.push(g.gy);
  }
  return { levels, gx, gy };
}

/** Summed-area tables of values and squared values, (w+1)×(h+1). */
export interface Integral {
  w: number;
  h: number;
  sum: Float64Array;
  sq: Float64Array;
}

export function integral(img: Gray): Integral {
  const { w, h, data } = img;
  const W = w + 1;
  const sum = new Float64Array(W * (h + 1)), sq = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, rq = 0;
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      rs += v;
      rq += v * v;
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + rs;
      sq[(y + 1) * W + x + 1] = sq[y * W + x + 1] + rq;
    }
  }
  return { w, h, sum, sq };
}

/** Sum and squared sum over [x0, x1) × [y0, y1). */
export function boxStats(ii: Integral, x0: number, y0: number, x1: number, y1: number): [number, number] {
  const W = ii.w + 1;
  const a = y0 * W + x0, b = y0 * W + x1, c = y1 * W + x0, d = y1 * W + x1;
  return [ii.sum[d] - ii.sum[b] - ii.sum[c] + ii.sum[a], ii.sq[d] - ii.sq[b] - ii.sq[c] + ii.sq[a]];
}
