// Viewport geometry: comp ↔ screen mapping, layer bounds, projection of layer-space points through
// parenting + 3D camera, hit testing and ray/plane intersection for 3D manipulation.

import type { Composition, Layer, Project } from '../../core/types';
import { FrameEval, isActiveAt, toLayerTime, layerSourceSize } from '../../core/evaluate';
import * as M from '../../math/mat4';
import { computeProjection, worldToComp, type Projection, type ViewSpec } from '../../render/projection';
import { evaluateShapeContents } from '../../shapes/evaluate';
import { drawOpsBounds } from '../../shapes/rasterize';
import { evaluateText } from '../../text/animate';
import { textBounds } from '../../text/rasterize';
import type { Measure } from '../../text/layout';
import type { Bounds } from '../../shapes/path';

export interface PaneXform {
  /** screen position of the comp center */
  cx: number;
  cy: number;
  /** screen px per comp px */
  zoom: number;
  compW: number;
  compH: number;
}

export const compToScreen = (x: PaneXform, p: number[]): [number, number] => [x.cx + (p[0] - x.compW / 2) * x.zoom, x.cy + (p[1] - x.compH / 2) * x.zoom];
export const screenToComp = (x: PaneXform, sx: number, sy: number): [number, number] => [(sx - x.cx) / x.zoom + x.compW / 2, (sy - x.cy) / x.zoom + x.compH / 2];

let measureCtx: CanvasRenderingContext2D | null = null;
export const uiMeasure: Measure = (s, font) => {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')!;
  measureCtx.font = font;
  return measureCtx.measureText(s).width;
};

/** Layer-space content bounds used for selection handles & hit testing. */
export function layerBounds(project: Project, comp: Composition, layer: Layer, fe: FrameEval): Bounds | null {
  switch (layer.type) {
    case 'solid':
    case 'null':
    case 'image':
    case 'video':
    case 'precomp': {
      const s = layerSourceSize(project, comp, layer);
      return { x: 0, y: 0, w: s.w, h: s.h };
    }
    case 'shape': {
      if (!layer.shape) return null;
      const draws = evaluateShapeContents(layer.shape.contents, (p, path, sp) => fe.prop(layer, path, p, sp), toLayerTime(layer, fe.time));
      return drawOpsBounds(draws);
    }
    case 'text': {
      if (!layer.text) return null;
      const res = evaluateText(layer.text, (p, path) => fe.prop(layer, path, p), toLayerTime(layer, fe.time), uiMeasure);
      return textBounds(res, layer.text.document);
    }
    default:
      return null;
  }
}

export interface ViewCtx {
  project: Project;
  comp: Composition;
  fe: FrameEval;
  proj: Projection;
  xf: PaneXform;
  view: ViewSpec;
}

export function makeViewCtx(project: Project, comp: Composition, time: number, view: ViewSpec, xf: PaneXform): ViewCtx {
  const fe = new FrameEval(project, comp, time);
  return { project, comp, fe, proj: computeProjection(comp, fe, view), xf, view };
}

/** World (comp) point → comp pixels for a layer of the given dimensionality. */
export function worldToCompPx(v: ViewCtx, world: number[], threeD: boolean): [number, number] | null {
  if (threeD) return worldToComp(v.proj, v.comp, world);
  if (!v.proj.active) return null;
  return [world[0], world[1]];
}

export function layerPointToScreen(v: ViewCtx, layer: Layer, p: number[]): [number, number] | null {
  const w = M.transformPoint(v.fe.worldMatrix(layer), [p[0], p[1], p[2] ?? 0]);
  const c = worldToCompPx(v, w, layer.threeD);
  return c ? compToScreen(v.xf, c) : null;
}

export function layerQuad(v: ViewCtx, layer: Layer, b: Bounds): [number, number][] | null {
  const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map((p) => layerPointToScreen(v, layer, p));
  if (pts.some((p) => !p)) return null;
  return pts as [number, number][];
}

export function pointInQuad(pt: [number, number], q: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const xi = q[i][0], yi = q[i][1], xj = q[j][0], yj = q[j][1];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/** Topmost layer under the screen point. */
export function hitLayer(v: ViewCtx, sx: number, sy: number, includeLocked = false): Layer | null {
  const anySolo = v.comp.layers.some((l) => l.solo);
  for (const l of v.comp.layers) {
    if (!l.enabled && l.type !== 'null' && l.type !== 'camera' && l.type !== 'light') continue;
    if (l.locked && !includeLocked) continue;
    if (!isActiveAt(l, v.fe.time)) continue;
    if (anySolo && !l.solo && l.type !== 'camera' && l.type !== 'light') continue;
    if (v.comp.hideShyLayers && l.shy) continue;
    if (l.type === 'camera' || l.type === 'light') {
      if (v.proj.active) continue;
      const p = layerPointToScreen(v, l, [0, 0, 0]);
      if (p && Math.hypot(p[0] - sx, p[1] - sy) < 14) return l;
      continue;
    }
    if (l.type === 'audio') continue;
    const b = layerBounds(v.project, v.comp, l, v.fe);
    if (!b) continue;
    const q = layerQuad(v, l, b);
    if (q && pointInQuad([sx, sy], q)) return l;
  }
  return null;
}

// ── 3D rays ─────────────────────────────────────────────────────────────────

export interface Ray {
  o: number[];
  d: number[];
}

export function compPxRay(v: ViewCtx, cx: number, cy: number): Ray | null {
  const inv = M.invert(v.proj.viewProj);
  if (!inv) return null;
  const nx = (cx / v.comp.width) * 2 - 1, ny = (cy / v.comp.height) * 2 - 1;
  const a = M.transformVec4(inv, [nx, ny, -1, 1]);
  const b = M.transformVec4(inv, [nx, ny, 1, 1]);
  const p0 = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
  const p1 = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
  const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return { o: p0, d: [d[0] / l, d[1] / l, d[2] / l] };
}

export function rayPlane(r: Ray, p: number[], n: number[]): number[] | null {
  const den = r.d[0] * n[0] + r.d[1] * n[1] + r.d[2] * n[2];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p[0] - r.o[0]) * n[0] + (p[1] - r.o[1]) * n[1] + (p[2] - r.o[2]) * n[2]) / den;
  if (t < 0) return null;
  return [r.o[0] + r.d[0] * t, r.o[1] + r.d[1] * t, r.o[2] + r.d[2] * t];
}

/** Camera forward direction (world) for the view. */
export function viewForward(v: ViewCtx): number[] {
  const inv = M.invert(v.proj.view) ?? M.identity();
  const f = M.transformDir(inv, [0, 0, 1]);
  const l = Math.hypot(f[0], f[1], f[2]) || 1;
  return [f[0] / l, f[1] / l, f[2] / l];
}

/** Convert a world-space delta to the parent space of `layer`. */
export function worldDeltaToParent(v: ViewCtx, layer: Layer, d: number[]): number[] {
  const parent = layer.parentId ? v.comp.layers.find((l) => l.id === layer.parentId) : undefined;
  if (!parent) return d;
  const inv = M.invert(v.fe.worldMatrix(parent));
  return inv ? M.transformDir(inv, d) : d;
}
