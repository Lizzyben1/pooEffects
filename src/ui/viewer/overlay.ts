// Viewport overlay: guides, selection bounds & handles, motion paths, mask/shape path editing,
// 3D gizmos, camera/light wireframes and effect point controls — plus handle hit testing.

import type { AnimProp, BezierPath, Composition, Layer } from '../../core/types';
import { FrameEval, isActiveAt, toCompTime } from '../../core/evaluate';
import * as M from '../../math/mat4';
import { LABEL_COLORS } from '../../math/color';
import { getAt } from '../../core/props';
import { spatialTangents } from '../../anim/interpolate';
import { getEffectDef } from '../../effects/catalog';
import { groupChainMatrix } from '../../shapes/evaluate';
import { apply2d, applyVec2d, type Mat2d } from '../../shapes/path';
import { exactFps } from '../../core/time';
import { compToScreen, layerBounds, layerPointToScreen, layerQuad, worldToCompPx, type ViewCtx } from './geometry';
import type { AppState } from '../../state/store';

export type HandleHit =
  | { kind: 'scale'; layerId: string; ix: number; iy: number }
  | { kind: 'anchor'; layerId: string }
  | { kind: 'rotate'; layerId: string }
  | { kind: 'axis'; layerId: string; axis: 0 | 1 | 2 }
  | { kind: 'motionKf'; layerId: string; kfId: string }
  | { kind: 'tangent'; layerId: string; kfId: string; side: 'in' | 'out' }
  | { kind: 'pathVertex'; layerId: string; path: string; vi: number; matrix: Mat2d }
  | { kind: 'pathTangent'; layerId: string; path: string; vi: number; side: 'in' | 'out'; matrix: Mat2d }
  | { kind: 'pathSegment'; layerId: string; path: string; si: number; t: number; matrix: Mat2d }
  | { kind: 'effectPoint'; layerId: string; fxId: string; paramId: string }
  | { kind: 'camera'; layerId: string; part: 'body' | 'poi' };

export interface OverlayState {
  hover: HandleHit | null;
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
  shapeDraft: { x0: number; y0: number; x1: number; y1: number } | null;
  pen: { pts: { p: [number, number]; i: [number, number]; o: [number, number] }[]; cursor: [number, number] | null } | null;
  selectedVertex: { path: string; vi: number } | null;
}

const labelColor = (l: Layer) => (l.label ? LABEL_COLORS[l.label]?.hex : '#8fa4c4') ?? '#8fa4c4';

// ── motion path sampling (memoised per immutable comp) ──────────────────────

const pathCache = new WeakMap<Composition, Map<string, { pts: number[][]; frames: number[] }>>();

function motionSamples(v: ViewCtx, layer: Layer): { pts: number[][]; frames: number[] } | null {
  const pos = layer.transform.position;
  if (pos.keyframes.length < 2) return null;
  let m = pathCache.get(v.comp);
  if (!m) {
    m = new Map();
    pathCache.set(v.comp, m);
  }
  const hit = m.get(layer.id);
  if (hit) return hit;
  const fps = exactFps(v.comp.frameRate);
  const t0 = toCompTime(layer, pos.keyframes[0].t), t1 = toCompTime(layer, pos.keyframes[pos.keyframes.length - 1].t);
  const a = Math.min(t0, t1), b = Math.max(t0, t1);
  const n = Math.min(2000, Math.max(2, Math.round((b - a) * fps)));
  const pts: number[][] = [];
  const frames: number[] = [];
  for (let k = 0; k <= n; k++) {
    const t = a + ((b - a) * k) / n;
    const fe = new FrameEval(v.project, v.comp, t);
    const parent = layer.parentId ? v.comp.layers.find((l) => l.id === layer.parentId) : undefined;
    const pv = fe.transformValues(layer).position;
    pts.push(parent ? M.transformPoint(fe.worldMatrix(parent), pv) : [pv[0], pv[1], pv[2] ?? 0]);
    frames.push(t);
  }
  const res = { pts, frames };
  m.set(layer.id, res);
  return res;
}

function parentWorldAt(v: ViewCtx, layer: Layer, compTime: number): M.Mat4 {
  if (!layer.parentId) return M.identity();
  const fe = Math.abs(compTime - v.fe.time) < 1e-9 ? v.fe : new FrameEval(v.project, v.comp, compTime);
  const parent = v.comp.layers.find((l) => l.id === layer.parentId);
  return parent ? fe.worldMatrix(parent) : M.identity();
}

// ── drawing helpers ─────────────────────────────────────────────────────────

function sq(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, fill: string, stroke = '#000a') {
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.fillRect(Math.round(x - s / 2) + 0.5, Math.round(y - s / 2) + 0.5, s, s);
  ctx.strokeRect(Math.round(x - s / 2) + 0.5, Math.round(y - s / 2) + 0.5, s, s);
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string | null, stroke: string) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function anchorMark(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.save();
  ctx.strokeStyle = '#000b';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.moveTo(x - 9, y);
  ctx.lineTo(x + 9, y);
  ctx.moveTo(x, y - 9);
  ctx.lineTo(x, y + 9);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.3;
  ctx.stroke();
  ctx.restore();
}

/** Layer-space bezier path to screen (via an optional shape-group matrix). */
function tracePathScreen(ctx: CanvasRenderingContext2D, v: ViewCtx, layer: Layer, p: BezierPath, m: Mat2d | null): [number, number][] | null {
  const S = (q: number[]) => layerPointToScreen(v, layer, m ? apply2d(m, q) : q);
  const pts: [number, number][] = [];
  const n = p.v.length;
  if (!n) return null;
  const v0 = S(p.v[0]);
  if (!v0) return null;
  ctx.beginPath();
  ctx.moveTo(v0[0], v0[1]);
  pts.push(v0);
  const segs = p.closed ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    const a = p.v[k], b = p.v[(k + 1) % n];
    const c1 = S([a[0] + p.o[k][0], a[1] + p.o[k][1]]);
    const c2 = S([b[0] + p.i[(k + 1) % n][0], b[1] + p.i[(k + 1) % n][1]]);
    const e = S(b);
    if (!c1 || !c2 || !e) return null;
    ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], e[0], e[1]);
    if (k < n - 1) pts.push(e);
  }
  if (p.closed) ctx.closePath();
  return pts;
}

/** Editable paths for a layer: masks (always for selected layers) and the selected shape path item. */
export function editablePaths(v: ViewCtx, layer: Layer, app: AppState): { path: string; value: BezierPath; matrix: Mat2d | null; color: string }[] {
  const out: { path: string; value: BezierPath; matrix: Mat2d | null; color: string }[] = [];
  for (const m of layer.masks) {
    if (m.locked) continue;
    const val = v.fe.prop(layer, `masks.${m.id}.path`, m.path);
    out.push({ path: `masks.${m.id}.path`, value: val, matrix: null, color: `rgb(${m.color.slice(0, 3).map((c) => Math.round(c * 255)).join(',')})` });
  }
  if (layer.shape && app.selShapeItem) {
    const find = (items: typeof layer.shape.contents, base: string): string | null => {
      for (const it of items) {
        const p = `${base}.${it.id}`;
        if (it.id === app.selShapeItem) {
          if (it.type === 'path') return p;
          if (it.type === 'group') {
            const inner = it.contents.find((c) => c.type === 'path');
            return inner ? `${p}.contents.${inner.id}` : null;
          }
          return null;
        }
        if (it.type === 'group') {
          const r = find(it.contents, `${p}.contents`);
          if (r) return r;
        }
      }
      return null;
    };
    const itemPath = find(layer.shape.contents, 'shape.contents');
    if (itemPath) {
      const item = getAt(layer, itemPath) as { id: string; path: { value: BezierPath } } | undefined;
      if (item) {
        const matrix = groupChainMatrix(layer.shape.contents, item.id, (p, path, sp) => v.fe.prop(layer, path, p, sp));
        const val = v.fe.prop(layer, `${itemPath}.path`, getAt(layer, `${itemPath}.path`) as AnimProp<BezierPath>);
        out.push({ path: `${itemPath}.path`, value: val, matrix, color: '#5fd1ff' });
      }
    }
  }
  return out;
}

// ── main draw ───────────────────────────────────────────────────────────────

export function drawOverlay(ctx: CanvasRenderingContext2D, v: ViewCtx, app: AppState, ov: OverlayState, w: number, h: number, activePane: boolean): void {
  ctx.clearRect(0, 0, w, h);
  const { comp, xf } = v;
  const viewer = app.viewers[comp.id];
  const tl = compToScreen(xf, [0, 0]);
  const br = compToScreen(xf, [comp.width, comp.height]);
  // comp frame outline
  ctx.strokeStyle = activePane ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(tl[0]) - 0.5, Math.round(tl[1]) - 0.5, Math.round(br[0] - tl[0]) + 1, Math.round(br[1] - tl[1]) + 1);

  if (viewer?.grid || viewer?.propGrid) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(tl[0], tl[1], br[0] - tl[0], br[1] - tl[1]);
    ctx.clip();
    ctx.strokeStyle = 'rgba(120,170,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (viewer.grid) {
      const step = 50;
      for (let x = 0; x <= comp.width; x += step) {
        const s = compToScreen(xf, [x, 0]);
        ctx.moveTo(Math.round(s[0]) + 0.5, tl[1]);
        ctx.lineTo(Math.round(s[0]) + 0.5, br[1]);
      }
      for (let y = 0; y <= comp.height; y += step) {
        const s = compToScreen(xf, [0, y]);
        ctx.moveTo(tl[0], Math.round(s[1]) + 0.5);
        ctx.lineTo(br[0], Math.round(s[1]) + 0.5);
      }
    }
    if (viewer.propGrid) {
      for (const f of [1 / 3, 2 / 3]) {
        const sx = tl[0] + (br[0] - tl[0]) * f, sy = tl[1] + (br[1] - tl[1]) * f;
        ctx.moveTo(Math.round(sx) + 0.5, tl[1]);
        ctx.lineTo(Math.round(sx) + 0.5, br[1]);
        ctx.moveTo(tl[0], Math.round(sy) + 0.5);
        ctx.lineTo(br[0], Math.round(sy) + 0.5);
      }
    }
    ctx.stroke();
    ctx.restore();
  }
  if (viewer?.safe) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    for (const [f, a] of [[0.9, 0.4], [0.8, 0.28]] as const) {
      const ww = (br[0] - tl[0]) * f, hh = (br[1] - tl[1]) * f;
      const x = tl[0] + ((br[0] - tl[0]) - ww) / 2, y = tl[1] + ((br[1] - tl[1]) - hh) / 2;
      ctx.strokeStyle = `rgba(255,255,255,${a})`;
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(ww), Math.round(hh));
    }
    ctx.setLineDash([]);
    const c = compToScreen(xf, [comp.width / 2, comp.height / 2]);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.moveTo(c[0] - 10, c[1]);
    ctx.lineTo(c[0] + 10, c[1]);
    ctx.moveTo(c[0], c[1] - 10);
    ctx.lineTo(c[0], c[1] + 10);
    ctx.stroke();
    ctx.restore();
  }

  const showControls = viewer?.layerControls !== false;
  const time = v.fe.time;
  // nulls & non-active-view cameras/lights
  for (const l of comp.layers) {
    if (!isActiveAt(l, time) || (comp.hideShyLayers && l.shy)) continue;
    if (l.type === 'null' && showControls) {
      const b = layerBounds(v.project, comp, l, v.fe);
      const q = b ? layerQuad(v, l, b) : null;
      if (q) {
        ctx.strokeStyle = labelColor(l) + 'aa';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        q.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if ((l.type === 'camera' || l.type === 'light') && !v.proj.active) drawCameraLight(ctx, v, l, app.selLayers.includes(l.id));
  }

  if (!showControls) {
    drawTransient(ctx, ov);
    return;
  }

  // selected layers
  for (const l of comp.layers) {
    if (!app.selLayers.includes(l.id) || !isActiveAt(l, time)) continue;
    if (l.type === 'camera' || l.type === 'light' || l.type === 'audio') continue;
    if (!l.threeD && !v.proj.active) continue;
    const col = labelColor(l);
    const b = layerBounds(v.project, comp, l, v.fe);
    const q = b ? layerQuad(v, l, b) : null;
    if (q) {
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      q.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.stroke();
      if (!l.locked) {
        const mids: [number, number][] = [];
        for (let i = 0; i < 4; i++) {
          const a = q[i], c = q[(i + 1) % 4];
          mids.push([(a[0] + c[0]) / 2, (a[1] + c[1]) / 2]);
        }
        for (const p of [...q, ...mids]) sq(ctx, p[0], p[1], 6, col);
      }
    }
    // motion path
    const ms = motionSamples(v, l);
    if (ms) {
      const pts = ms.pts.map((p) => {
        const c = worldToCompPx(v, p, l.threeD);
        return c ? compToScreen(xf, c) : null;
      });
      ctx.strokeStyle = col + 'cc';
      ctx.lineWidth = 1;
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        if (!p) {
          started = false;
          continue;
        }
        if (!started) ctx.moveTo(p[0], p[1]);
        else ctx.lineTo(p[0], p[1]);
        started = true;
      }
      ctx.stroke();
      ctx.fillStyle = col;
      for (const p of pts) if (p) ctx.fillRect(p[0] - 1, p[1] - 1, 2, 2);
      const kfs = l.transform.position.keyframes;
      kfs.forEach((k, idx) => {
        const kt = toCompTime(l, k.t);
        const pw = parentWorldAt(v, l, kt);
        const wv = M.transformPoint(pw, k.v as number[]);
        const c = worldToCompPx(v, wv, l.threeD);
        if (!c) return;
        const s = compToScreen(xf, c);
        const [ti, to] = spatialTangents(kfs, idx);
        const selKf = app.selKeys.some((key) => key.endsWith(`|transform.position|${k.id}`));
        for (const [tv, side] of [[ti, 'in'], [to, 'out']] as const) {
          if (Math.hypot(...tv) < 1e-6) continue;
          if ((side === 'in' && idx === 0) || (side === 'out' && idx === kfs.length - 1)) continue;
          const tw = M.transformPoint(pw, (k.v as number[]).map((x, j) => x + (tv[j] ?? 0)));
          const tc = worldToCompPx(v, tw, l.threeD);
          if (!tc) continue;
          const ts = compToScreen(xf, tc);
          ctx.strokeStyle = col + '99';
          ctx.beginPath();
          ctx.moveTo(s[0], s[1]);
          ctx.lineTo(ts[0], ts[1]);
          ctx.stroke();
          const hov = ov.hover?.kind === 'tangent' && ov.hover.kfId === k.id && ov.hover.side === side;
          circle(ctx, ts[0], ts[1], hov ? 4.5 : 3.5, '#0c0e12', col);
        }
        const hov = ov.hover?.kind === 'motionKf' && ov.hover.kfId === k.id;
        sq(ctx, s[0], s[1], hov || selKf ? 8 : 6, selKf ? '#ffc46b' : '#0c0e12', col);
      });
    }
    // anchor
    const tv = v.fe.transformValues(l);
    const ap = layerPointToScreen(v, l, tv.anchor);
    if (ap) {
      anchorMark(ctx, ap[0], ap[1], ov.hover?.kind === 'anchor' && ov.hover.layerId === l.id ? '#ffc46b' : '#fff');
      if (l.threeD && app.selLayers.length === 1 && v.proj.active) drawAxes(ctx, v, l, ap, ov);
    }
    // editable paths
    for (const ep of editablePaths(v, l, app)) {
      ctx.save();
      const verts = tracePathScreen(ctx, v, l, ep.value, ep.matrix);
      ctx.strokeStyle = ep.color;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      if (verts && !l.locked) {
        const p = ep.value;
        verts.forEach((s, vi) => {
          const isSel = ov.selectedVertex?.path === ep.path && ov.selectedVertex.vi === vi;
          if (isSel) {
            for (const side of ['in', 'out'] as const) {
              const tv2 = side === 'in' ? p.i[vi] : p.o[vi];
              if (Math.hypot(tv2[0], tv2[1]) < 1e-6) continue;
              const local = [p.v[vi][0] + tv2[0], p.v[vi][1] + tv2[1]];
              const ts = layerPointToScreen(v, l, ep.matrix ? apply2d(ep.matrix, local) : local);
              if (!ts) continue;
              ctx.strokeStyle = ep.color;
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(s[0], s[1]);
              ctx.lineTo(ts[0], ts[1]);
              ctx.stroke();
              circle(ctx, ts[0], ts[1], 3.5, '#0c0e12', ep.color);
            }
          }
          const hov = ov.hover?.kind === 'pathVertex' && ov.hover.path === ep.path && ov.hover.vi === vi;
          sq(ctx, s[0], s[1], hov || isSel ? 7 : 5, isSel ? ep.color : '#0c0e12', ep.color);
        });
      }
      ctx.restore();
    }
    // effect points
    if (app.selEffect) {
      const fx = l.effects.find((e) => e.id === app.selEffect);
      const def = fx ? getEffectDef(fx.type) : undefined;
      if (fx && def) {
        for (const pd of def.params) {
          if (pd.kind !== 'point2') continue;
          const pv = v.fe.prop(l, `effects.${fx.id}.params.${pd.id}`, fx.params[pd.id]) as number[];
          const s = layerPointToScreen(v, l, pv);
          if (!s) continue;
          const hov = ov.hover?.kind === 'effectPoint' && ov.hover.paramId === pd.id;
          ctx.save();
          ctx.strokeStyle = '#000b';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(s[0], s[1], 7, 0, Math.PI * 2);
          ctx.moveTo(s[0] - 11, s[1]);
          ctx.lineTo(s[0] + 11, s[1]);
          ctx.moveTo(s[0], s[1] - 11);
          ctx.lineTo(s[0], s[1] + 11);
          ctx.stroke();
          ctx.strokeStyle = hov ? '#ffc46b' : '#ff9b3f';
          ctx.lineWidth = 1.4;
          ctx.stroke();
          ctx.fillStyle = '#ffd9a8';
          ctx.font = '600 10px Inter, sans-serif';
          ctx.fillText(pd.name, s[0] + 10, s[1] - 9);
          ctx.restore();
        }
      }
    }
  }
  drawTransient(ctx, ov);
}

function drawTransient(ctx: CanvasRenderingContext2D, ov: OverlayState) {
  if (ov.marquee) {
    const m = ov.marquee;
    ctx.fillStyle = 'rgba(79,157,255,0.10)';
    ctx.strokeStyle = 'rgba(130,186,255,0.9)';
    ctx.lineWidth = 1;
    const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
    ctx.fillRect(x, y, Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(Math.abs(m.x1 - m.x0)), Math.round(Math.abs(m.y1 - m.y0)));
  }
  if (ov.shapeDraft) {
    const d = ov.shapeDraft;
    ctx.strokeStyle = '#ffc46b';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.2;
    ctx.strokeRect(Math.min(d.x0, d.x1) + 0.5, Math.min(d.y0, d.y1) + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    ctx.setLineDash([]);
  }
  if (ov.pen && ov.pen.pts.length) {
    const pts = ov.pen.pts;
    ctx.strokeStyle = '#5fd1ff';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(pts[0].p[0], pts[0].p[1]);
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      ctx.bezierCurveTo(a.p[0] + a.o[0], a.p[1] + a.o[1], b.p[0] + b.i[0], b.p[1] + b.i[1], b.p[0], b.p[1]);
    }
    if (ov.pen.cursor) {
      const a = pts[pts.length - 1];
      ctx.setLineDash([4, 4]);
      ctx.bezierCurveTo(a.p[0] + a.o[0], a.p[1] + a.o[1], ov.pen.cursor[0], ov.pen.cursor[1], ov.pen.cursor[0], ov.pen.cursor[1]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of pts) {
      if (Math.hypot(p.o[0], p.o[1]) > 0.5) {
        ctx.beginPath();
        ctx.moveTo(p.p[0] + p.i[0], p.p[1] + p.i[1]);
        ctx.lineTo(p.p[0] + p.o[0], p.p[1] + p.o[1]);
        ctx.stroke();
        circle(ctx, p.p[0] + p.o[0], p.p[1] + p.o[1], 3, '#0c0e12', '#5fd1ff');
        circle(ctx, p.p[0] + p.i[0], p.p[1] + p.i[1], 3, '#0c0e12', '#5fd1ff');
      }
      sq(ctx, p.p[0], p.p[1], 6, '#0c0e12', '#5fd1ff');
    }
  }
}

function axisEnds(v: ViewCtx, l: Layer, ap: [number, number]): [number, number][] {
  const w = v.fe.worldMatrix(l);
  const tv = v.fe.transformValues(l);
  const origin = M.transformPoint(w, tv.anchor);
  // fixed screen length: scale world axis length by distance
  const ends: [number, number][] = [];
  for (const d of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    const dir = M.transformDir(w, d);
    const dl = Math.hypot(...dir) || 1;
    let len = 100;
    const probe = worldToCompPx(v, [origin[0] + (dir[0] / dl) * len, origin[1] + (dir[1] / dl) * len, origin[2] + (dir[2] / dl) * len], true);
    if (probe) {
      const s = compToScreen(v.xf, probe);
      const pxLen = Math.hypot(s[0] - ap[0], s[1] - ap[1]);
      if (pxLen > 1e-3) len = (len * 70) / pxLen;
    }
    const end = worldToCompPx(v, [origin[0] + (dir[0] / dl) * len, origin[1] + (dir[1] / dl) * len, origin[2] + (dir[2] / dl) * len], true);
    ends.push(end ? compToScreen(v.xf, end) : ap);
  }
  return ends;
}

function drawAxes(ctx: CanvasRenderingContext2D, v: ViewCtx, l: Layer, ap: [number, number], ov: OverlayState) {
  const ends = axisEnds(v, l, ap);
  const cols = ['#ff5d6c', '#3ddc84', '#4f9dff'];
  ends.forEach((e, i) => {
    const hov = ov.hover?.kind === 'axis' && ov.hover.axis === i;
    ctx.strokeStyle = cols[i];
    ctx.lineWidth = hov ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(ap[0], ap[1]);
    ctx.lineTo(e[0], e[1]);
    ctx.stroke();
    const ang = Math.atan2(e[1] - ap[1], e[0] - ap[0]);
    ctx.fillStyle = cols[i];
    ctx.beginPath();
    ctx.moveTo(e[0] + Math.cos(ang) * 7, e[1] + Math.sin(ang) * 7);
    ctx.lineTo(e[0] + Math.cos(ang + 2.5) * 6, e[1] + Math.sin(ang + 2.5) * 6);
    ctx.lineTo(e[0] + Math.cos(ang - 2.5) * 6, e[1] + Math.sin(ang - 2.5) * 6);
    ctx.closePath();
    ctx.fill();
  });
}

function drawCameraLight(ctx: CanvasRenderingContext2D, v: ViewCtx, l: Layer, selected: boolean) {
  const w = v.fe.worldMatrix(l);
  const pos = M.getTranslation(w);
  const pc = worldToCompPx(v, pos, true);
  if (!pc) return;
  const s = compToScreen(v.xf, pc);
  const col = selected ? '#ffc46b' : labelColor(l);
  ctx.save();
  ctx.strokeStyle = col;
  ctx.fillStyle = col + '33';
  ctx.lineWidth = 1.3;
  if (l.type === 'camera' && l.camera) {
    const zoom = v.fe.prop(l, 'camera.zoom', l.camera.zoom);
    const hw = v.comp.width / 2, hh = v.comp.height / 2;
    const far = zoom;
    const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => M.transformPoint(w, [x * 0.25, y * 0.25, far * 0.25]));
    const cs = corners.map((c) => worldToCompPx(v, c, true)).map((c) => (c ? compToScreen(v.xf, c) : null));
    if (cs.every(Boolean)) {
      ctx.beginPath();
      for (const c of cs) {
        ctx.moveTo(s[0], s[1]);
        ctx.lineTo(c![0], c![1]);
      }
      cs.forEach((c, i) => (i ? ctx.lineTo(c![0], c![1]) : ctx.moveTo(c![0], c![1])));
      ctx.closePath();
      ctx.stroke();
    }
    if (l.camera.kind === 'twoNode') {
      const poi = v.fe.prop(l, 'camera.pointOfInterest', l.camera.pointOfInterest, true);
      const parent = l.parentId ? v.comp.layers.find((x) => x.id === l.parentId) : undefined;
      const pw = parent ? M.transformPoint(v.fe.worldMatrix(parent), poi) : poi;
      const pp = worldToCompPx(v, pw, true);
      if (pp) {
        const ps = compToScreen(v.xf, pp);
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(s[0], s[1]);
        ctx.lineTo(ps[0], ps[1]);
        ctx.stroke();
        ctx.setLineDash([]);
        circle(ctx, ps[0], ps[1], 4, '#0c0e12', col);
      }
    }
    ctx.fillRect(s[0] - 7, s[1] - 5, 14, 10);
    ctx.strokeRect(s[0] - 7, s[1] - 5, 14, 10);
  } else {
    ctx.beginPath();
    ctx.arc(s[0], s[1], 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(s[0] + Math.cos(ang) * 10, s[1] + Math.sin(ang) * 10);
      ctx.lineTo(s[0] + Math.cos(ang) * 14, s[1] + Math.sin(ang) * 14);
      ctx.stroke();
    }
  }
  ctx.fillStyle = col;
  ctx.font = '600 10px Inter, sans-serif';
  ctx.fillText(l.name, s[0] + 12, s[1] + 4);
  ctx.restore();
}

// ── hit testing ─────────────────────────────────────────────────────────────

export function hitHandle(v: ViewCtx, app: AppState, sx: number, sy: number, selectedVertex: OverlayState['selectedVertex']): HandleHit | null {
  const near = (p: [number, number] | null, r = 7) => !!p && Math.hypot(p[0] - sx, p[1] - sy) <= r;
  const time = v.fe.time;
  for (const l of v.comp.layers) {
    if (!app.selLayers.includes(l.id) || !isActiveAt(l, time) || l.locked) continue;
    if (l.type === 'camera' || l.type === 'light') continue;
    if (!l.threeD && !v.proj.active) continue;
    // effect points first
    if (app.selEffect) {
      const fx = l.effects.find((e) => e.id === app.selEffect);
      const def = fx ? getEffectDef(fx.type) : undefined;
      if (fx && def) {
        for (const pd of def.params) {
          if (pd.kind !== 'point2') continue;
          const pv = v.fe.prop(l, `effects.${fx.id}.params.${pd.id}`, fx.params[pd.id]) as number[];
          if (near(layerPointToScreen(v, l, pv), 9)) return { kind: 'effectPoint', layerId: l.id, fxId: fx.id, paramId: pd.id };
        }
      }
    }
    // editable paths: tangents of selected vertex, vertices, then segments
    for (const ep of editablePaths(v, l, app)) {
      const p = ep.value;
      const S = (q: number[]) => layerPointToScreen(v, l, ep.matrix ? apply2d(ep.matrix, q) : q);
      if (selectedVertex && selectedVertex.path === ep.path && p.v[selectedVertex.vi]) {
        const vi = selectedVertex.vi;
        for (const side of ['in', 'out'] as const) {
          const t = side === 'in' ? p.i[vi] : p.o[vi];
          if (Math.hypot(t[0], t[1]) < 1e-6) continue;
          if (near(S([p.v[vi][0] + t[0], p.v[vi][1] + t[1]]))) return { kind: 'pathTangent', layerId: l.id, path: ep.path, vi, side, matrix: ep.matrix ?? [1, 0, 0, 1, 0, 0] };
        }
      }
      for (let vi = 0; vi < p.v.length; vi++) {
        if (near(S(p.v[vi]))) return { kind: 'pathVertex', layerId: l.id, path: ep.path, vi, matrix: ep.matrix ?? [1, 0, 0, 1, 0, 0] };
      }
    }
    // motion path keyframes & tangents
    const kfs = l.transform.position.keyframes;
    if (kfs.length > 1) {
      for (let idx = 0; idx < kfs.length; idx++) {
        const k = kfs[idx];
        const kt = toCompTime(l, k.t);
        const pw = parentWorldAt(v, l, kt);
        const [ti, to] = spatialTangents(kfs, idx);
        for (const [tv, side] of [[ti, 'in'], [to, 'out']] as const) {
          if (Math.hypot(...tv) < 1e-6) continue;
          const tw = M.transformPoint(pw, (k.v as number[]).map((x, j) => x + (tv[j] ?? 0)));
          const tc = worldToCompPx(v, tw, l.threeD);
          if (tc && near(compToScreen(v.xf, tc), 6)) return { kind: 'tangent', layerId: l.id, kfId: k.id, side };
        }
        const wv = M.transformPoint(pw, k.v as number[]);
        const c = worldToCompPx(v, wv, l.threeD);
        if (c && near(compToScreen(v.xf, c), 6)) return { kind: 'motionKf', layerId: l.id, kfId: k.id };
      }
    }
    const tv = v.fe.transformValues(l);
    const ap = layerPointToScreen(v, l, tv.anchor);
    if (l.threeD && ap && app.selLayers.length === 1 && v.proj.active) {
      const ends = axisEnds(v, l, ap);
      for (let i = 0; i < 3; i++) {
        const e = ends[i];
        // distance to segment
        const dx = e[0] - ap[0], dy = e[1] - ap[1];
        const L2 = dx * dx + dy * dy;
        const t = L2 > 0 ? Math.max(0.25, Math.min(1, ((sx - ap[0]) * dx + (sy - ap[1]) * dy) / L2)) : 0;
        if (Math.hypot(sx - (ap[0] + dx * t), sy - (ap[1] + dy * t)) < 6) return { kind: 'axis', layerId: l.id, axis: i as 0 | 1 | 2 };
      }
    }
    if (near(ap, 8)) return { kind: 'anchor', layerId: l.id };
    const b = layerBounds(v.project, v.comp, l, v.fe);
    const q = b ? layerQuad(v, l, b) : null;
    if (q) {
      const pts: [number, number, number, number][] = [
        [q[0][0], q[0][1], 0, 0], [q[1][0], q[1][1], 2, 0], [q[2][0], q[2][1], 2, 2], [q[3][0], q[3][1], 0, 2],
        [(q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2, 1, 0], [(q[1][0] + q[2][0]) / 2, (q[1][1] + q[2][1]) / 2, 2, 1],
        [(q[2][0] + q[3][0]) / 2, (q[2][1] + q[3][1]) / 2, 1, 2], [(q[3][0] + q[0][0]) / 2, (q[3][1] + q[0][1]) / 2, 0, 1],
      ];
      for (const p of pts) if (Math.hypot(p[0] - sx, p[1] - sy) < 7) return { kind: 'scale', layerId: l.id, ix: p[2], iy: p[3] };
      // just outside a corner → rotate
      for (let i = 0; i < 4; i++) {
        const d = Math.hypot(q[i][0] - sx, q[i][1] - sy);
        if (d >= 7 && d < 18) return { kind: 'rotate', layerId: l.id };
      }
    }
  }
  // cameras in non-active views
  if (!v.proj.active) {
    for (const l of v.comp.layers) {
      if ((l.type !== 'camera' && l.type !== 'light') || !isActiveAt(l, time)) continue;
      const pos = M.getTranslation(v.fe.worldMatrix(l));
      const c = worldToCompPx(v, pos, true);
      if (c && near(compToScreen(v.xf, c), 12)) return { kind: 'camera', layerId: l.id, part: 'body' };
      const poiProp = l.camera?.pointOfInterest ?? l.light?.pointOfInterest;
      if (poiProp && (l.camera?.kind === 'twoNode' || l.light?.kind === 'spot' || l.light?.kind === 'parallel')) {
        const poi = v.fe.prop(l, l.camera ? 'camera.pointOfInterest' : 'light.pointOfInterest', poiProp, true);
        const pc = worldToCompPx(v, poi, true);
        if (pc && near(compToScreen(v.xf, pc), 8)) return { kind: 'camera', layerId: l.id, part: 'poi' };
      }
    }
  }
  return null;
}

export { applyVec2d };
