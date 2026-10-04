// Rasterises evaluated shape draw ops with Canvas2D (OffscreenCanvas in the render worker).
// The result is uploaded as a texture by the GPU pipeline. Shapes are continuously rasterised:
// `scale` is the effective on-screen scale so vectors stay crisp at any zoom.

import type { BlendMode } from '../core/types';
import { rgbaToCss } from '../math/color';
import { expandBounds, pathBounds, tracePath, unionBounds, type Bounds } from './path';
import type { DrawOp, PathEntry } from './evaluate';

export type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

export interface CanvasProvider {
  /** main raster canvas (resized as needed, content cleared) */
  get(w: number, h: number): { canvas: AnyCanvas; ctx: Ctx2D };
  /** secondary scratch canvas for boolean merges */
  scratch(w: number, h: number): { canvas: AnyCanvas; ctx: Ctx2D };
}

const CANVAS_BLEND: Partial<Record<BlendMode, GlobalCompositeOperation>> = {
  normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten',
  colorDodge: 'color-dodge', colorBurn: 'color-burn', hardLight: 'hard-light', softLight: 'soft-light',
  difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color',
  luminosity: 'luminosity', add: 'lighter',
};

export function canvasBlend(m: BlendMode): GlobalCompositeOperation {
  return CANVAS_BLEND[m] ?? 'source-over';
}

export function drawOpsBounds(draws: DrawOp[]): Bounds | null {
  let b: Bounds | null = null;
  for (const d of draws) {
    const paths = d.entries.filter((e) => !e.hidden).flatMap((e) => e.paths);
    let pb = pathBounds(paths);
    if (!pb) continue;
    if (d.kind === 'stroke') {
      const miter = d.lineJoin === 'miter' ? Math.max(1, d.miterLimit) : 1;
      pb = expandBounds(pb, (d.width / 2) * miter + 1);
    }
    b = unionBounds(b, pb);
  }
  return b;
}

export interface RasterOutput {
  canvas: AnyCanvas;
  /** layer-space rectangle covered by the canvas */
  bounds: Bounds;
  /** canvas pixels per layer unit */
  scale: number;
  width: number;
  height: number;
}

function paintStyle(ctx: Ctx2D, d: DrawOp): string | CanvasGradient {
  if (d.gradient) {
    const g = d.gradient;
    let grad: CanvasGradient;
    if (g.type === 'radial') {
      const r = Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1]);
      grad = ctx.createRadialGradient(g.start[0], g.start[1], 0, g.start[0], g.start[1], Math.max(0.01, r));
    } else {
      grad = ctx.createLinearGradient(g.start[0], g.start[1], g.end[0], g.end[1]);
    }
    const stops = [...g.stops].sort((a, b) => a.p - b.p);
    for (const s of stops) grad.addColorStop(Math.max(0, Math.min(1, s.p)), rgbaToCss(s.c));
    return grad;
  }
  return rgbaToCss(d.color ?? [1, 1, 1, 1], 1);
}

function traceEntries(ctx: Ctx2D, entries: PathEntry[]): void {
  ctx.beginPath();
  for (const e of entries) {
    if (e.hidden) continue;
    for (const p of e.paths) tracePath(ctx, p);
  }
}

export function rasterizeDrawOps(
  draws: DrawOp[], scale: number, provider: CanvasProvider, maxSize = 8192, minScale = 0.02,
): RasterOutput | null {
  const b0 = drawOpsBounds(draws);
  if (!b0 || b0.w <= 0 || b0.h <= 0) return null;
  let s = Math.max(minScale, scale);
  const bounds = expandBounds(b0, 1 / s);
  let W = Math.ceil(bounds.w * s) + 2;
  let H = Math.ceil(bounds.h * s) + 2;
  if (W > maxSize || H > maxSize) {
    const f = Math.min(maxSize / W, maxSize / H);
    s *= f;
    W = Math.min(maxSize, Math.ceil(bounds.w * s) + 2);
    H = Math.min(maxSize, Math.ceil(bounds.h * s) + 2);
  }
  const { canvas, ctx } = provider.get(W, H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, W, H);
  const tf: [number, number, number, number, number, number] = [s, 0, 0, s, -bounds.x * s, -bounds.y * s];
  for (let k = draws.length - 1; k >= 0; k--) {
    const d = draws[k];
    if (d.opacity <= 0) continue;
    const live = d.entries.filter((e) => !e.hidden && e.paths.length);
    if (!live.length) continue;
    const special = live.filter((e) => e.merge === 'subtract' || e.merge === 'intersect' || e.merge === 'exclude');
    ctx.save();
    ctx.setTransform(...tf);
    ctx.globalAlpha = Math.max(0, Math.min(1, d.opacity));
    ctx.globalCompositeOperation = canvasBlend(d.blendMode);
    if (d.kind === 'fill') {
      const normal = live.filter((e) => !special.includes(e));
      if (normal.length) {
        traceEntries(ctx, normal);
        ctx.fillStyle = paintStyle(ctx, d);
        ctx.fill(d.fillRule);
      }
      for (const e of special) {
        const sc = provider.scratch(W, H);
        const sctx = sc.ctx;
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.globalCompositeOperation = 'source-over';
        sctx.globalAlpha = 1;
        sctx.clearRect(0, 0, W, H);
        sctx.setTransform(...tf);
        sctx.fillStyle = paintStyle(sctx, d);
        e.paths.forEach((p, idx) => {
          sctx.globalCompositeOperation = idx === 0 ? 'source-over' : e.merge === 'subtract' ? 'destination-out' : e.merge === 'intersect' ? 'destination-in' : 'xor';
          sctx.beginPath();
          tracePath(sctx, p);
          sctx.fill(d.fillRule);
        });
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(sc.canvas as CanvasImageSource, 0, 0);
        ctx.setTransform(...tf);
      }
    } else if (d.width > 0) {
      traceEntries(ctx, live);
      ctx.strokeStyle = paintStyle(ctx, d);
      ctx.lineWidth = d.width;
      ctx.lineCap = d.lineCap;
      ctx.lineJoin = d.lineJoin;
      ctx.miterLimit = d.miterLimit;
      if (d.dash) {
        ctx.setLineDash(d.dash);
        ctx.lineDashOffset = -d.dashOffset;
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  return { canvas, bounds: { x: bounds.x, y: bounds.y, w: W / s, h: H / s }, scale: s, width: W, height: H };
}
