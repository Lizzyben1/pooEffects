// Text rasterisation with Canvas2D: per-glyph transforms, fill/stroke, per-glyph blur.

import type { TextDocument } from '../core/types';
import { rgbaToCss } from '../math/color';
import { glyphMatrix, type TextEvalResult } from './animate';
import type { Bounds } from '../shapes/path';
import type { CanvasProvider, RasterOutput } from '../shapes/rasterize';

export function textBounds(res: TextEvalResult, doc: TextDocument): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const asc = res.layout.ascent * 1.25, desc = res.layout.descent * 1.4;
  for (const r of res.glyphs) {
    if (r.glyph.space || r.opacity <= 0) continue;
    const m = glyphMatrix(r);
    const pad = (doc.strokeOn ? r.strokeWidth : 0) + r.blur * 3 + 2;
    const g = r.glyph;
    const extra = g.width * 0.25 + 2; // italic overhang / side bearings
    const pts = [
      [g.x - extra, g.y - asc], [g.x + g.width + extra, g.y - asc],
      [g.x + g.width + extra, g.y + desc], [g.x - extra, g.y + desc],
    ];
    for (const p of pts) {
      const x = m[0] * p[0] + m[2] * p[1] + m[4];
      const y = m[1] * p[0] + m[3] * p[1] + m[5];
      minX = Math.min(minX, x - pad);
      minY = Math.min(minY, y - pad);
      maxX = Math.max(maxX, x + pad);
      maxY = Math.max(maxY, y + pad);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function rasterizeText(res: TextEvalResult, doc: TextDocument, scale: number, provider: CanvasProvider, maxSize = 8192): RasterOutput | null {
  const b = textBounds(res, doc);
  if (!b || b.w <= 0 || b.h <= 0) return null;
  let s = Math.max(0.02, scale);
  let W = Math.ceil(b.w * s) + 2, H = Math.ceil(b.h * s) + 2;
  if (W > maxSize || H > maxSize) {
    s *= Math.min(maxSize / W, maxSize / H);
    W = Math.min(maxSize, Math.ceil(b.w * s) + 2);
    H = Math.min(maxSize, Math.ceil(b.h * s) + 2);
  }
  const { canvas, ctx } = provider.get(W, H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, W, H);
  ctx.font = res.layout.font;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  const supportsFilter = 'filter' in ctx;
  for (const r of res.glyphs) {
    if (r.glyph.space || r.opacity <= 0.001) continue;
    const m = glyphMatrix(r);
    ctx.save();
    // canvas = S·T(-b) · M
    ctx.setTransform(s * m[0], s * m[1], s * m[2], s * m[3], s * (m[4] - b.x), s * (m[5] - b.y));
    ctx.globalAlpha = r.opacity;
    if (supportsFilter) ctx.filter = r.blur > 0.05 ? `blur(${(r.blur * s * Math.sqrt(Math.abs(r.sx * r.sy))).toFixed(2)}px)` : 'none';
    const g = r.glyph;
    const doFill = () => {
      if (!doc.fillOn) return;
      ctx.fillStyle = rgbaToCss(r.fill);
      ctx.fillText(g.ch, g.x, g.y);
    };
    const doStroke = () => {
      if (!doc.strokeOn || r.strokeWidth <= 0) return;
      ctx.strokeStyle = rgbaToCss(r.stroke);
      ctx.lineWidth = r.strokeWidth;
      ctx.strokeText(g.ch, g.x, g.y);
    };
    if (doc.strokeOverFill) { doFill(); doStroke(); } else { doStroke(); doFill(); }
    ctx.restore();
  }
  return { canvas, bounds: { x: b.x, y: b.y, w: W / s, h: H / s }, scale: s, width: W, height: H };
}
