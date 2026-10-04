// ─────────────────────────────────────────────────────────────────────────────
// Viewer overlay + hit testing for the computer-vision tools:
//   • point tracker widgets — feature region (solid) inside the search region
//     (dashed), corner handles, attach-point crosshair, confidence readout and
//     the tracked motion path
//   • perspective corner-pin quad with the live planar feature cloud
//   • 3D camera-tracker point cloud (size ∝ nearness, colour by depth) with an
//     After Effects-style target disc on the plane through the hovered point
//   • Roto Brush matte boundary and green/red prompt points
// Everything is drawn in screen space from layer-space data, so trackers
// follow the layer's own transform in the comp viewer.
// ─────────────────────────────────────────────────────────────────────────────

import type { CameraTrack, Layer, Tracker } from '../../core/types';
import type { AppState } from '../../state/store';
import type { TrackingState } from '../../state/tracking';
import { pointGeometryAt, findTracker } from '../../state/tracking';
import type { RotoState } from '../../state/roto';
import { frameIndexAt, rotoEffectOf } from '../../state/roto';
import { matteContours } from '../../state/mattes';
import { compPxRay, layerPointToScreen, rayPlane, screenToComp, type ViewCtx } from './geometry';
import { isActiveAt, layerSourceSize, toLayerTime } from '../../core/evaluate';
import * as M from '../../math/mat4';
import { mat3Vec, normalize3, cross3, symEig, type V3 } from '../../cv/linalg';
import { keyframedValue } from '../../anim/interpolate';

export type TrackHit =
  | { kind: 'feature'; layerId: string; trackerId: string; pointId: string }
  | { kind: 'featureEdge'; layerId: string; trackerId: string; pointId: string; ix: number; iy: number }
  | { kind: 'search'; layerId: string; trackerId: string; pointId: string }
  | { kind: 'searchEdge'; layerId: string; trackerId: string; pointId: string; ix: number; iy: number }
  | { kind: 'attach'; layerId: string; trackerId: string; pointId: string }
  | { kind: 'camPoint'; layerId: string; id: number };

const POINT_COLORS = ['#ffd24a', '#4fd6ff', '#ff6fb1', '#8cff6a'];

/** Screen → layer-space point (2D layers directly; 3D layers via the layer plane). */
export function screenToLayer(v: ViewCtx, layer: Layer, sx: number, sy: number): [number, number] | null {
  const W = v.fe.worldMatrix(layer);
  const inv = M.invert(W);
  if (!inv) return null;
  const c = screenToComp(v.xf, sx, sy);
  if (!layer.threeD) {
    const p = M.transformPoint(inv, [c[0], c[1], 0]);
    return [p[0], p[1]];
  }
  const ray = compPxRay(v, c[0], c[1]);
  if (!ray) return null;
  const o = M.transformPoint(W, [0, 0, 0]);
  const n = M.transformDir(W, [0, 0, 1]);
  const hit = rayPlane(ray, o, n);
  if (!hit) return null;
  const p = M.transformPoint(inv, hit);
  return [p[0], p[1]];
}

function rectScreen(v: ViewCtx, layer: Layer, cx: number, cy: number, w: number, h: number): [number, number][] | null {
  const pts: [number, number][] = [];
  for (const [ix, iy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const s = layerPointToScreen(v, layer, [cx + (ix * w) / 2, cy + (iy * h) / 2]);
    if (!s) return null;
    pts.push(s);
  }
  return pts;
}

function poly(ctx: CanvasRenderingContext2D, q: [number, number][]): void {
  ctx.beginPath();
  q.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.closePath();
}

function pointInQuad(q: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i], [xj, yj] = q[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/** Handle positions: 4 corners + 4 edge midpoints, with their ±1/0 directions. */
function handles(q: [number, number][]): { p: [number, number]; ix: number; iy: number }[] {
  const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return [
    { p: q[0], ix: -1, iy: -1 }, { p: q[1], ix: 1, iy: -1 }, { p: q[2], ix: 1, iy: 1 }, { p: q[3], ix: -1, iy: 1 },
    { p: mid(q[0], q[1]), ix: 0, iy: -1 }, { p: mid(q[1], q[2]), ix: 1, iy: 0 }, { p: mid(q[2], q[3]), ix: 0, iy: 1 }, { p: mid(q[3], q[0]), ix: -1, iy: 0 },
  ];
}

function activeTrackerFor(v: ViewCtx, tr: TrackingState): { layer: Layer; tracker: Tracker } | null {
  const a = tr.active;
  if (!a || a.compId !== v.comp.id) return null;
  const f = findTracker(v.project, a.compId, a.layerId, a.trackerId);
  if (!f || !isActiveAt(f.layer, v.fe.time)) return null;
  return { layer: f.layer, tracker: f.tracker };
}

// ── drawing ─────────────────────────────────────────────────────────────────

export function drawTrackOverlay(ctx: CanvasRenderingContext2D, v: ViewCtx, app: AppState, tr: TrackingState, roto: RotoState, hover: TrackHit | null): void {
  if (v.view.kind !== 'active') return;
  ctx.save();
  drawCameraPoints(ctx, v, app, tr);
  drawRoto(ctx, v, app, roto);
  const at = activeTrackerFor(v, tr);
  if (at) {
    if (at.tracker.kind === 'perspective') drawPerspective(ctx, v, at.layer, at.tracker, tr, hover);
    else drawPoints(ctx, v, at.layer, at.tracker, tr, hover);
  }
  ctx.restore();
}

function drawPoints(ctx: CanvasRenderingContext2D, v: ViewCtx, layer: Layer, tracker: Tracker, tr: TrackingState, hover: TrackHit | null): void {
  const t = v.fe.time;
  tracker.points.forEach((p, i) => {
    if (!p.enabled) return;
    const col = POINT_COLORS[i % POINT_COLORS.length];
    const g = pointGeometryAt(layer, p, t);
    const c = g.center;
    // motion path through the tracked keyframes
    const keys = p.featureCenter.keyframes;
    if (keys.length > 1) {
      ctx.strokeStyle = `${col}88`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let started = false;
      for (const k of keys) {
        const s = layerPointToScreen(v, layer, k.v as number[]);
        if (!s) continue;
        if (!started) { ctx.moveTo(s[0], s[1]); started = true; } else ctx.lineTo(s[0], s[1]);
      }
      ctx.stroke();
      ctx.fillStyle = col;
      for (const k of keys) {
        const s = layerPointToScreen(v, layer, k.v as number[]);
        if (s) ctx.fillRect(s[0] - 1, s[1] - 1, 2, 2);
      }
    }
    const search = rectScreen(v, layer, c[0] + p.searchOffset[0], c[1] + p.searchOffset[1], p.searchSize[0], p.searchSize[1]);
    const feat = rectScreen(v, layer, c[0], c[1], p.featureSize[0], p.featureSize[1]);
    if (!search || !feat) return;
    const isActive = tr.activePoint === p.id;
    const hov = hover && 'pointId' in hover && hover.pointId === p.id ? hover : null;
    // search region
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = hov?.kind === 'search' || hov?.kind === 'searchEdge' ? 2 : 1.2;
    ctx.strokeStyle = col;
    poly(ctx, search);
    ctx.stroke();
    ctx.setLineDash([]);
    // feature region with a soft dark halo for legibility
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    poly(ctx, feat);
    ctx.stroke();
    ctx.lineWidth = hov?.kind === 'feature' || hov?.kind === 'featureEdge' || isActive ? 2 : 1.5;
    ctx.strokeStyle = col;
    poly(ctx, feat);
    ctx.stroke();
    if (isActive) {
      ctx.fillStyle = `${col}1a`;
      poly(ctx, feat);
      ctx.fill();
    }
    for (const q of [feat, search]) {
      for (const h of handles(q)) {
        ctx.fillStyle = '#101216';
        ctx.fillRect(h.p[0] - 3, h.p[1] - 3, 6, 6);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.strokeRect(h.p[0] - 3, h.p[1] - 3, 6, 6);
      }
    }
    // attach point
    const a = layerPointToScreen(v, layer, g.attach);
    if (a) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(a[0] - 7, a[1]); ctx.lineTo(a[0] + 7, a[1]);
      ctx.moveTo(a[0], a[1] - 7); ctx.lineTo(a[0], a[1] + 7);
      ctx.stroke();
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.arc(a[0], a[1], 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    // label + confidence
    const top = feat.reduce((m, q) => (q[1] < m[1] ? q : m), feat[0]);
    const tracked = p.confidence.keyframes.length > 0;
    const label = `${p.name.replace('Track Point', 'TP')}${tracked ? ` · ${g.confidence.toFixed(0)}%` : ''}`;
    ctx.font = '600 10.5px Inter, system-ui, sans-serif';
    const w = ctx.measureText(label).width + 10;
    const lx = top[0] - w / 2, ly = Math.min(...search.map((q) => q[1])) - 18;
    ctx.fillStyle = 'rgba(12,13,17,0.82)';
    ctx.beginPath();
    ctx.roundRect(lx, ly, w, 15, 4);
    ctx.fill();
    ctx.fillStyle = tracked ? confColor(g.confidence) : col;
    ctx.fillText(label, lx + 5, ly + 11);
  });
  // two-point trackers: show the measuring line between the feature centres
  if (tracker.points.length === 2 && (tracker.rotation || tracker.scale)) {
    const a = layerPointToScreen(v, layer, pointGeometryAt(layer, tracker.points[0], t).center);
    const b = layerPointToScreen(v, layer, pointGeometryAt(layer, tracker.points[1], t).center);
    if (a && b) {
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

export function confColor(c: number): string {
  const k = Math.max(0, Math.min(1, (c - 50) / 50));
  const r = Math.round(255 * (1 - k) + 80 * k), g = Math.round(90 + 140 * k), b = Math.round(90 + 30 * k);
  return `rgb(${r},${g},${b})`;
}

function drawPerspective(ctx: CanvasRenderingContext2D, v: ViewCtx, layer: Layer, tracker: Tracker, tr: TrackingState, hover: TrackHit | null): void {
  const t = v.fe.time;
  const corners = tracker.points.slice(0, 4).map((p) => layerPointToScreen(v, layer, pointGeometryAt(layer, p, t).center));
  if (corners.some((c) => !c)) return;
  const q = corners as [number, number][];
  const grad = ctx.createLinearGradient(q[0][0], q[0][1], q[2][0], q[2][1]);
  grad.addColorStop(0, 'rgba(255,155,63,0.16)');
  grad.addColorStop(1, 'rgba(79,214,255,0.12)');
  ctx.fillStyle = grad;
  poly(ctx, q);
  ctx.fill();
  // perspective grid inside the plane (bilinear in screen space approximates the projective grid)
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  const lerp = (a: [number, number], b: [number, number], k: number): [number, number] => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  for (let k = 1; k < 4; k++) {
    const u = k / 4;
    const a = lerp(q[0], q[1], u), b = lerp(q[3], q[2], u);
    const c = lerp(q[0], q[3], u), d = lerp(q[1], q[2], u);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]);
    ctx.stroke();
  }
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  poly(ctx, q);
  ctx.stroke();
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = '#ffb35c';
  poly(ctx, q);
  ctx.stroke();
  // live planar features
  if (tr.live && tr.live.layerId === layer.id && Math.abs(tr.live.time - t) < 1e-3) {
    ctx.fillStyle = 'rgba(140,255,106,0.9)';
    for (let i = 0; i < tr.live.pts.length; i += 2) {
      const s = layerPointToScreen(v, layer, [tr.live.pts[i], tr.live.pts[i + 1]]);
      if (s) ctx.fillRect(s[0] - 1.5, s[1] - 1.5, 3, 3);
    }
  }
  q.forEach((c, i) => {
    const hov = hover && 'pointId' in hover && hover.pointId === tracker.points[i].id;
    ctx.fillStyle = '#101216';
    ctx.strokeStyle = POINT_COLORS[i];
    ctx.lineWidth = hov ? 2.5 : 1.6;
    ctx.beginPath();
    ctx.arc(c[0], c[1], hov ? 7 : 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = POINT_COLORS[i];
    ctx.font = '700 9px Inter, system-ui, sans-serif';
    ctx.fillText(String(i + 1), c[0] - 2.6, c[1] + 3.2);
  });
  const g0 = pointGeometryAt(layer, tracker.points[0], t);
  if (tracker.points[0].confidence.keyframes.length) {
    const label = `Planar · ${g0.confidence.toFixed(0)}%`;
    ctx.font = '600 10.5px Inter, system-ui, sans-serif';
    const w = ctx.measureText(label).width + 10;
    const top = q.reduce((m, p) => (p[1] < m[1] ? p : m), q[0]);
    ctx.fillStyle = 'rgba(12,13,17,0.82)';
    ctx.beginPath();
    ctx.roundRect(top[0] - w / 2, top[1] - 26, w, 15, 4);
    ctx.fill();
    ctx.fillStyle = confColor(g0.confidence);
    ctx.fillText(label, top[0] - w / 2 + 5, top[1] - 15);
  }
}

/** Screen position of a camera-track point at the current frame. */
function camPointScreen(v: ViewCtx, layer: Layer, ct: CameraTrack, X: number[], frame: number): { s: [number, number]; z: number } | null {
  const fr = ct.frames[frame];
  if (!fr) return null;
  const c = mat3Vec(fr.R, X);
  const z = c[2] + fr.t[2];
  if (z <= 1e-9) return null;
  const u = ct.width / 2 + (ct.f * (c[0] + fr.t[0])) / z, w = ct.height / 2 + (ct.f * (c[1] + fr.t[1])) / z;
  const s = layerPointToScreen(v, layer, [u * ct.sourceScale, w * ct.sourceScale]);
  return s ? { s, z } : null;
}

export function cameraFrameIndex(layer: Layer, ct: CameraTrack, compTime: number): number {
  return Math.round((toLayerTime(layer, compTime) - ct.t0) / ct.dt);
}

/** Layers whose camera-track points are currently shown. */
export function cameraTrackLayers(v: ViewCtx, app: AppState, tr: TrackingState): Layer[] {
  if (!tr.showTrackPoints) return [];
  return v.comp.layers.filter((l) => l.cameraTrack?.solved && app.selLayers.includes(l.id) && isActiveAt(l, v.fe.time));
}

function drawCameraPoints(ctx: CanvasRenderingContext2D, v: ViewCtx, app: AppState, tr: TrackingState): void {
  // live features while analysing
  if (tr.job?.op === 'camera' && tr.live) {
    const layer = v.comp.layers.find((l) => l.id === tr.live!.layerId);
    if (layer && Math.abs(tr.live.time - v.fe.time) < 0.6 / (v.comp.frameRate || 30)) {
      ctx.fillStyle = 'rgba(255,210,74,0.85)';
      for (let i = 0; i < tr.live.pts.length; i += 2) {
        const s = layerPointToScreen(v, layer, [tr.live.pts[i], tr.live.pts[i + 1]]);
        if (s) ctx.fillRect(s[0] - 1.5, s[1] - 1.5, 3, 3);
      }
    }
  }
  for (const layer of cameraTrackLayers(v, app, tr)) {
    const ct = layer.cameraTrack!;
    const fi = cameraFrameIndex(layer, ct, v.fe.time);
    if (fi < 0 || fi >= ct.frames.length) continue;
    const vis: { id: number; s: [number, number]; z: number; X: number[] }[] = [];
    for (const p of ct.points) {
      if (fi < p.first - 1 || fi > p.last + 1) continue;
      const r = camPointScreen(v, layer, ct, p.X, fi);
      if (r) vis.push({ id: p.id, s: r.s, z: r.z, X: p.X });
    }
    if (!vis.length) continue;
    const zs = vis.map((p) => p.z).sort((a, b) => a - b);
    const zNear = zs[Math.floor(zs.length * 0.05)], zFar = zs[Math.floor(zs.length * 0.95)] || zNear + 1, zMed = zs[zs.length >> 1];
    const sel = new Set(tr.camSel);
    for (const p of vis) {
      const k = Math.max(0, Math.min(1, (p.z - zNear) / Math.max(1e-9, zFar - zNear)));
      const size = Math.max(2.5, Math.min(9, 5 * (zMed / p.z)));
      const hue = 28 + k * 170;
      ctx.strokeStyle = `hsl(${hue} 95% 62%)`;
      ctx.lineWidth = sel.has(p.id) ? 2.2 : 1.4;
      ctx.beginPath();
      ctx.moveTo(p.s[0] - size, p.s[1] - size); ctx.lineTo(p.s[0] + size, p.s[1] + size);
      ctx.moveTo(p.s[0] + size, p.s[1] - size); ctx.lineTo(p.s[0] - size, p.s[1] + size);
      ctx.stroke();
      if (sel.has(p.id)) {
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.beginPath();
        ctx.arc(p.s[0], p.s[1], size * 0.75 + 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `hsl(${hue} 95% 52%)`;
        ctx.beginPath();
        ctx.arc(p.s[0], p.s[1], size * 0.75, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // target disc on the plane through the hovered/selected points
    const focus = tr.camSel.length >= 3 ? vis.filter((p) => sel.has(p.id)) : tr.camHover !== null ? nearestThree(vis, tr.camHover) : [];
    if (focus.length >= 3) drawTarget(ctx, v, layer, ct, fi, focus.map((p) => p.X), vis.find((p) => p.id === tr.camHover)?.X ?? null);
  }
}

function nearestThree(vis: { id: number; s: [number, number]; X: number[] }[], id: number): { id: number; s: [number, number]; X: number[] }[] {
  const h = vis.find((p) => p.id === id);
  if (!h) return [];
  return [...vis].sort((a, b) => Math.hypot(a.s[0] - h.s[0], a.s[1] - h.s[1]) - Math.hypot(b.s[0] - h.s[0], b.s[1] - h.s[1])).slice(0, 3);
}

function drawTarget(ctx: CanvasRenderingContext2D, v: ViewCtx, layer: Layer, ct: CameraTrack, fi: number, pts: number[][], centre: number[] | null): void {
  const c: V3 = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) c[k] += p[k] / pts.length;
  const C = new Float64Array(9);
  for (const p of pts) {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] += d[i] * d[j];
  }
  const { vectors } = symEig(C, 3);
  const n = normalize3([vectors[0], vectors[3], vectors[6]]);
  const ref: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize3(cross3(n, ref)), w = cross3(n, u);
  const o = centre ?? c;
  // radius ≈ 4% of the point's depth
  const fr = ct.frames[fi];
  const zc = mat3Vec(fr.R, o)[2] + fr.t[2];
  const rings = [1, 0.66, 0.33];
  rings.forEach((rk, ri) => {
    const r = zc * 0.06 * rk;
    ctx.beginPath();
    let ok = true;
    for (let k = 0; k <= 40; k++) {
      const a = (k / 40) * Math.PI * 2;
      const X = [o[0] + (u[0] * Math.cos(a) + w[0] * Math.sin(a)) * r, o[1] + (u[1] * Math.cos(a) + w[1] * Math.sin(a)) * r, o[2] + (u[2] * Math.cos(a) + w[2] * Math.sin(a)) * r];
      const s = camPointScreen(v, layer, ct, X, fi);
      if (!s) { ok = false; break; }
      if (k === 0) ctx.moveTo(s.s[0], s.s[1]); else ctx.lineTo(s.s[0], s.s[1]);
    }
    if (!ok) return;
    ctx.closePath();
    ctx.fillStyle = ri % 2 === 0 ? 'rgba(255,64,96,0.38)' : 'rgba(255,255,255,0.32)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
  });
}

function drawRoto(ctx: CanvasRenderingContext2D, v: ViewCtx, app: AppState, roto: RotoState): void {
  if (!roto.overlay) return;
  for (const layer of v.comp.layers) {
    if (!(app.selLayers.includes(layer.id) || app.tool === 'roto')) continue;
    if (!isActiveAt(layer, v.fe.time)) continue;
    const r = rotoEffectOf(layer, v.project);
    if (!r) continue;
    const info = r.info;
    const fi = frameIndexAt(layer, info, v.fe.time);
    const rev = info.revs[String(fi)];
    const { w: sw } = layerSourceSize(v.project, v.comp, layer);
    const k = sw / info.width;
    if (rev !== undefined) {
      const cs = matteContours(info.id, rev);
      ctx.lineJoin = 'round';
      for (const pass of [0, 1]) {
        ctx.lineWidth = pass ? 1.6 : 5;
        ctx.strokeStyle = pass ? '#ff4fa3' : 'rgba(255,79,163,0.25)';
        for (const c of cs) {
          ctx.beginPath();
          c.forEach(([x, y], i) => {
            const s = layerPointToScreen(v, layer, [(x + 0.5) * k, (y + 0.5) * k]);
            if (!s) return;
            if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]);
          });
          ctx.closePath();
          ctx.stroke();
        }
      }
    }
    const prompts = info.prompts.find((p) => p.frame === fi)?.points ?? [];
    for (const [x, y, label] of prompts) {
      const s = layerPointToScreen(v, layer, [x * k, y * k]);
      if (!s) continue;
      ctx.fillStyle = label ? '#2fe07a' : '#ff4d5e';
      ctx.strokeStyle = '#0b0c10';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s[0], s[1], 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(s[0] - 3, s[1]); ctx.lineTo(s[0] + 3, s[1]);
      if (label) { ctx.moveTo(s[0], s[1] - 3); ctx.lineTo(s[0], s[1] + 3); }
      ctx.stroke();
    }
  }
}

// ── hit testing ─────────────────────────────────────────────────────────────

export function hitTrack(v: ViewCtx, app: AppState, tr: TrackingState, sx: number, sy: number): TrackHit | null {
  if (v.view.kind !== 'active') return null;
  const at = activeTrackerFor(v, tr);
  if (at) {
    const { layer, tracker } = at;
    const t = v.fe.time;
    const base = { layerId: layer.id, trackerId: tracker.id };
    if (tracker.kind === 'perspective') {
      for (const p of tracker.points.slice(0, 4)) {
        const s = layerPointToScreen(v, layer, pointGeometryAt(layer, p, t).center);
        if (s && Math.hypot(s[0] - sx, s[1] - sy) < 9) return { kind: 'feature', ...base, pointId: p.id };
      }
    } else {
      // active point first so overlapping boxes favour it
      const order = [...tracker.points].sort((a, b) => (a.id === tr.activePoint ? -1 : b.id === tr.activePoint ? 1 : 0));
      for (const p of order) {
        if (!p.enabled) continue;
        const g = pointGeometryAt(layer, p, t);
        const a = layerPointToScreen(v, layer, g.attach);
        if (a && Math.hypot(a[0] - sx, a[1] - sy) < 6) return { kind: 'attach', ...base, pointId: p.id };
        const feat = rectScreen(v, layer, g.center[0], g.center[1], p.featureSize[0], p.featureSize[1]);
        const search = rectScreen(v, layer, g.center[0] + p.searchOffset[0], g.center[1] + p.searchOffset[1], p.searchSize[0], p.searchSize[1]);
        if (!feat || !search) continue;
        for (const h of handles(feat)) if (Math.hypot(h.p[0] - sx, h.p[1] - sy) < 6) return { kind: 'featureEdge', ...base, pointId: p.id, ix: h.ix, iy: h.iy };
        for (const h of handles(search)) if (Math.hypot(h.p[0] - sx, h.p[1] - sy) < 6) return { kind: 'searchEdge', ...base, pointId: p.id, ix: h.ix, iy: h.iy };
        if (pointInQuad(feat, sx, sy)) return { kind: 'feature', ...base, pointId: p.id };
        if (pointInQuad(search, sx, sy)) return { kind: 'search', ...base, pointId: p.id };
      }
    }
  }
  for (const layer of cameraTrackLayers(v, app, tr)) {
    const ct = layer.cameraTrack!;
    const fi = cameraFrameIndex(layer, ct, v.fe.time);
    let best: { id: number; d: number } | null = null;
    for (const p of ct.points) {
      if (fi < p.first - 1 || fi > p.last + 1) continue;
      const r = camPointScreen(v, layer, ct, p.X, fi);
      if (!r) continue;
      const d = Math.hypot(r.s[0] - sx, r.s[1] - sy);
      if (d < 8 && (!best || d < best.d)) best = { id: p.id, d };
    }
    if (best) return { kind: 'camPoint', layerId: layer.id, id: best.id };
  }
  return null;
}

/** Camera-track point ids inside a screen rectangle. */
export function camPointsInRect(v: ViewCtx, app: AppState, tr: TrackingState, x0: number, y0: number, x1: number, y1: number): number[] {
  const out: number[] = [];
  for (const layer of cameraTrackLayers(v, app, tr)) {
    const ct = layer.cameraTrack!;
    const fi = cameraFrameIndex(layer, ct, v.fe.time);
    for (const p of ct.points) {
      if (fi < p.first - 1 || fi > p.last + 1) continue;
      const r = camPointScreen(v, layer, ct, p.X, fi);
      if (r && r.s[0] >= x0 && r.s[0] <= x1 && r.s[1] >= y0 && r.s[1] <= y1) out.push(p.id);
    }
  }
  return out;
}

/** Keyframed feature centre at a comp time, for drag start values. */
export function featureCenterAt(layer: Layer, tracker: Tracker, pointId: string, compTime: number): number[] | null {
  const p = tracker.points.find((x) => x.id === pointId);
  if (!p) return null;
  const lt = toLayerTime(layer, compTime);
  return p.featureCenter.keyframes.length ? (keyframedValue(p.featureCenter, lt, true) as number[]) : p.featureCenter.value;
}

