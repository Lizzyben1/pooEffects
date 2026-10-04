// ─────────────────────────────────────────────────────────────────────────────
// Document actions. Every edit goes through `doc()` (undoable). Times passed
// to these functions are COMPOSITION times; keyframes are stored in layer time.
// ─────────────────────────────────────────────────────────────────────────────

import type { Draft } from 'immer';
import { current, isDraft } from 'immer';
import type {
  AnimProp, BezierPath, Composition, Ease, EffectInstance, Footage, Keyframe, Layer, Mask, MaskMode, Project, PropValue,
  ShapeItem, SpatialInterp, TemporalInterp, TextAnimatorPropKey, TextDocument,
} from '../core/types';
import {
  activeComp, beginTx, doc, endTx, getApp, keyOf, propKey, refOf, setApp, toast, defaultTimeline,
} from './store';
import { getTime, setTime } from './time';
import { getAt, getDescriptor, getProp, isAnimProp, parentPath, lastSeg, animatedPaths, forEachAnimProp } from '../core/props';
import { uid } from '../core/ids';
import {
  createComp, createEffect, createMask, createPrecompLayer, createRangeSelector, createTextAnimator, createAnimatorProp,
  createWigglySelector, type CompOptions,
} from '../core/factory';
import { FrameEval, layerSourceSize, stretchFactor, toCompTime, toLayerTime } from '../core/evaluate';
import { keyframedValue, defaultEases, EASY_EASE_INFLUENCE, autoSpeed, isNumArray, easeDims } from '../anim/interpolate';
import { frameDuration, snapToFrame } from '../core/time';
import * as M from '../math/mat4';
import { getEffectDef, resolveDefault } from '../effects/catalog';

// ── draft helpers ───────────────────────────────────────────────────────────

const compOf = (d: Draft<Project>, compId: string): Draft<Composition> | undefined => d.comps[compId];
const layerOf = (d: Draft<Project>, compId: string, layerId: string): Draft<Layer> | undefined =>
  d.comps[compId]?.layers.find((l) => l.id === layerId);
const plain = <T>(x: T): T => (isDraft(x) ? (current(x as never) as T) : x);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(plain(x))) as T;

function regenIds<T>(obj: T): T {
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      o.forEach(walk);
      return;
    }
    if (typeof o.id === 'string' && o.id.length > 10) o.id = uid(o.id.slice(0, o.id.length - 10) || 'x');
    for (const k of Object.keys(o)) if (k !== 'id') walk(o[k]);
  };
  walk(obj);
  return obj;
}

export function uniqueLayerName(comp: Composition, base: string): string {
  const names = new Set(comp.layers.map((l) => l.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\s+\d+$/, '');
  let n = 2;
  while (names.has(`${stem} ${n}`)) n++;
  return `${stem} ${n}`;
}

export function uniqueCompName(p: Project, base: string): string {
  const names = new Set(Object.values(p.comps).map((c) => c.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\s+\d+$/, '');
  let n = 2;
  while (names.has(`${stem} ${n}`)) n++;
  return `${stem} ${n}`;
}

// ── keyframes ───────────────────────────────────────────────────────────────

export function makeKeyframe(t: number, v: PropValue, spatial: boolean): Keyframe {
  const k: Keyframe = {
    id: uid('k'), t, v: clone(v), inType: 'linear', outType: 'linear',
    easeIn: defaultEases(v, spatial), easeOut: defaultEases(v, spatial),
  };
  if (spatial) k.spatial = 'auto';
  if (typeof v === 'string' || typeof v === 'boolean' || (v && typeof v === 'object' && !Array.isArray(v) && !('v' in (v as object)))) {
    k.inType = 'hold';
    k.outType = 'hold';
  }
  return k;
}

/** Insert or update a keyframe at layer time t (within half a frame). */
export function upsertKeyframe(p: Draft<AnimProp>, t: number, v: PropValue, spatial: boolean, tolerance: number): void {
  const existing = p.keyframes.find((k) => Math.abs(k.t - t) < tolerance);
  if (existing) {
    existing.v = clone(v) as never;
    return;
  }
  const k = makeKeyframe(t, v, spatial);
  // inherit interpolation from the neighbour (AE copies the previous keyframe's types)
  const prev = [...p.keyframes].reverse().find((x) => x.t < t);
  if (prev) {
    k.inType = prev.inType === 'hold' ? 'linear' : prev.inType;
    k.outType = prev.outType;
    if (prev.spatial) k.spatial = prev.spatial === 'bezier' || prev.spatial === 'continuous' ? 'auto' : prev.spatial;
  }
  p.keyframes.push(k as never);
  p.keyframes.sort((a, b) => a.t - b.t);
}

function halfFrame(compId: string): number {
  const c = getApp().project.comps[compId];
  return c ? frameDuration(c.frameRate) / 2 : 1 / 60;
}

/** Set a property value; auto-keyframes at the CTI when the stopwatch is on. */
export function setPropValue(compId: string, layerId: string, path: string, value: PropValue, coalesce?: string): void {
  const t = getTime(compId);
  doc((d) => {
    const layer = layerOf(d, compId, layerId);
    if (!layer) return;
    const p = getAt(layer, path) as Draft<AnimProp> | undefined;
    if (!p || !isAnimProp(p)) return;
    if (p.keyframes.length) {
      const spatial = !!getDescriptor(plain(layer) as Layer, path).spatial;
      upsertKeyframe(p, toLayerTime(layer as Layer, t), value, spatial, halfFrame(compId) / Math.abs(stretchFactor(layer as Layer)));
    } else p.value = clone(value) as never;
  }, { coalesce: coalesce ?? `${layerId}:${path}` });
}

export function toggleStopwatch(compId: string, layerId: string, path: string): void {
  const t = getTime(compId);
  doc((d) => {
    const layer = layerOf(d, compId, layerId);
    if (!layer) return;
    const p = getAt(layer, path) as Draft<AnimProp> | undefined;
    if (!p || !isAnimProp(p)) return;
    const L = plain(layer) as Layer;
    const spatial = !!getDescriptor(L, path).spatial;
    const lt = toLayerTime(L, t);
    if (p.keyframes.length) {
      p.value = clone(keyframedValue(plain(p) as AnimProp, lt, spatial)) as never;
      p.keyframes = [];
    } else {
      p.keyframes = [makeKeyframe(lt, plain(p.value) as PropValue, spatial) as never];
    }
  });
}

export function addKeyframeAt(compId: string, layerId: string, path: string, compTime = getTime(compId)): void {
  doc((d) => {
    const layer = layerOf(d, compId, layerId);
    if (!layer) return;
    const p = getAt(layer, path) as Draft<AnimProp> | undefined;
    if (!p || !isAnimProp(p)) return;
    const L = plain(layer) as Layer;
    const spatial = !!getDescriptor(L, path).spatial;
    const lt = toLayerTime(L, compTime);
    const v = keyframedValue(plain(p) as AnimProp, lt, spatial);
    upsertKeyframe(p, lt, v, spatial, halfFrame(compId));
  });
}

/** Add or remove a keyframe at the CTI (keyframe navigator diamond). */
export function toggleKeyframeAtCTI(compId: string, layerId: string, path: string): void {
  const comp = getApp().project.comps[compId];
  const layer = comp?.layers.find((l) => l.id === layerId);
  const p = layer ? getProp(layer, path) : undefined;
  if (!layer || !p) return;
  const lt = toLayerTime(layer, getTime(compId));
  const tol = halfFrame(compId);
  const hit = p.keyframes.find((k) => Math.abs(k.t - lt) < tol);
  if (hit) deleteKeyframes([keyOf({ layerId, path, kfId: hit.id })]);
  else if (!p.keyframes.length) toggleStopwatch(compId, layerId, path);
  else addKeyframeAt(compId, layerId, path);
}

export function deleteKeyframes(keys: string[], compId = getApp().activeCompId): void {
  if (!compId || !keys.length) return;
  const t = getTime(compId);
  const byProp = new Map<string, Set<string>>();
  for (const k of keys) {
    const r = refOf(k);
    const pk = propKey(r.layerId, r.path);
    if (!byProp.has(pk)) byProp.set(pk, new Set());
    byProp.get(pk)!.add(r.kfId);
  }
  doc((d) => {
    for (const [pk, ids] of byProp) {
      const [layerId, path] = pk.split('|');
      const layer = layerOf(d, compId, layerId);
      if (!layer) continue;
      const p = getAt(layer, path) as Draft<AnimProp> | undefined;
      if (!p || !isAnimProp(p)) continue;
      const L = plain(layer) as Layer;
      const spatial = !!getDescriptor(L, path).spatial;
      const valueNow = keyframedValue(plain(p) as AnimProp, toLayerTime(L, t), spatial);
      p.keyframes = p.keyframes.filter((k) => !ids.has(k.id));
      if (!p.keyframes.length) p.value = clone(valueNow) as never;
    }
  });
  setApp((s) => ({ selKeys: s.selKeys.filter((k) => !keys.includes(k)) }));
}

/** Retime keyframes from original comp times by dt (used by drags inside a transaction). */
export function retimeKeyframes(compId: string, orig: Map<string, number>, dt: number): void {
  const comp = getApp().project.comps[compId];
  if (!comp) return;
  doc((d) => {
    const groups = new Map<string, { kfId: string; t: number }[]>();
    for (const [k, t0] of orig) {
      const r = refOf(k);
      const pk = propKey(r.layerId, r.path);
      if (!groups.has(pk)) groups.set(pk, []);
      groups.get(pk)!.push({ kfId: r.kfId, t: t0 + dt });
    }
    for (const [pk, moves] of groups) {
      const [layerId, path] = pk.split('|');
      const layer = layerOf(d, compId, layerId);
      if (!layer) continue;
      const p = getAt(layer, path) as Draft<AnimProp> | undefined;
      if (!p || !isAnimProp(p)) continue;
      const L = plain(layer) as Layer;
      const movedIds = new Set(moves.map((m) => m.kfId));
      for (const m of moves) {
        const k = p.keyframes.find((x) => x.id === m.kfId);
        if (k) k.t = toLayerTime(L, snapToFrame(m.t, comp.frameRate));
      }
      // a moved keyframe landing on a stationary one replaces it
      const tol = halfFrame(compId) * 0.5;
      p.keyframes = p.keyframes.filter((k) => movedIds.has(k.id) || !p.keyframes.some((o) => movedIds.has(o.id) && Math.abs(o.t - k.t) < tol));
      p.keyframes.sort((a, b) => a.t - b.t);
    }
  });
}

/** Comp times of keyframes (for drag start snapshots). */
export function keyframeCompTimes(compId: string, keys: string[]): Map<string, number> {
  const comp = getApp().project.comps[compId];
  const out = new Map<string, number>();
  if (!comp) return out;
  for (const k of keys) {
    const r = refOf(k);
    const layer = comp.layers.find((l) => l.id === r.layerId);
    const p = layer ? getProp(layer, r.path) : undefined;
    const kf = p?.keyframes.find((x) => x.id === r.kfId);
    if (layer && kf) out.set(k, toCompTime(layer, kf.t));
  }
  return out;
}

function forEachSelectedKf(keys: string[], compId: string, d: Draft<Project>, fn: (kf: Draft<Keyframe>, p: Draft<AnimProp>, idx: number, layer: Draft<Layer>, path: string) => void): void {
  for (const k of keys) {
    const r = refOf(k);
    const layer = layerOf(d, compId, r.layerId);
    if (!layer) continue;
    const p = getAt(layer, r.path) as Draft<AnimProp> | undefined;
    if (!p || !isAnimProp(p)) continue;
    const idx = p.keyframes.findIndex((x) => x.id === r.kfId);
    if (idx >= 0) fn(p.keyframes[idx], p, idx, layer, r.path);
  }
}

export function setKeyframeInterpolation(keys: string[], temporal: TemporalInterp | null, spatial?: SpatialInterp, compId = getApp().activeCompId): void {
  if (!compId || !keys.length) return;
  doc((d) => {
    forEachSelectedKf(keys, compId, d, (kf, p, idx, layer, path) => {
      if (temporal) {
        if (temporal === 'hold') {
          kf.outType = 'hold';
        } else {
          kf.inType = temporal;
          kf.outType = temporal;
          if (temporal === 'bezier' || temporal === 'continuous') {
            const P = plain(p) as AnimProp;
            const isSpatial = !!getDescriptor(plain(layer) as Layer, path).spatial;
            const dims = easeDims(kf.v as PropValue, isSpatial);
            const sc = (k: Keyframe, dd: number) => (typeof k.v === 'number' ? (k.v as number) : isNumArray(k.v) ? (k.v as number[])[dd] ?? 0 : P.keyframes.indexOf(k));
            const eases: Ease[] = [];
            for (let dd = 0; dd < dims; dd++) eases.push({ speed: isSpatial ? 0 : autoSpeed(P.keyframes, idx, dd, sc), influence: EASY_EASE_INFLUENCE });
            kf.easeIn = eases.map((e) => ({ ...e })) as never;
            kf.easeOut = eases.map((e) => ({ ...e })) as never;
          }
        }
      }
      if (spatial && kf.spatial !== undefined) {
        if ((spatial === 'bezier' || spatial === 'continuous') && (kf.spatial === 'auto' || kf.spatial === 'linear')) {
          // freeze current auto tangents so the path doesn't jump
          const P = plain(p) as AnimProp;
          const v = kf.v as number[];
          const prev = P.keyframes[idx - 1]?.v as number[] | undefined;
          const next = P.keyframes[idx + 1]?.v as number[] | undefined;
          if (prev && next) {
            const dir = next.map((x, j) => x - prev[j]);
            const dl = Math.hypot(...dir) || 1;
            const dIn = Math.hypot(...v.map((x, j) => x - prev[j]));
            const dOut = Math.hypot(...next.map((x, j) => x - v[j]));
            kf.ti = dir.map((c) => (-c / dl) * (dIn / 3)) as never;
            kf.to = dir.map((c) => (c / dl) * (dOut / 3)) as never;
          } else {
            kf.ti = v.map(() => 0) as never;
            kf.to = v.map(() => 0) as never;
          }
        }
        kf.spatial = spatial;
      }
    });
  });
}

export function easyEase(keys: string[], which: 'both' | 'in' | 'out', compId = getApp().activeCompId): void {
  if (!compId || !keys.length) return;
  doc((d) => {
    forEachSelectedKf(keys, compId, d, (kf, _p, _i, layer, path) => {
      const spatial = !!getDescriptor(plain(layer) as Layer, path).spatial;
      const e = defaultEases(kf.v as PropValue, spatial, EASY_EASE_INFLUENCE);
      if (which !== 'out') {
        kf.inType = 'bezier';
        kf.easeIn = e.map((x) => ({ ...x })) as never;
      }
      if (which !== 'in') {
        kf.outType = 'bezier';
        kf.easeOut = e.map((x) => ({ ...x })) as never;
      }
    });
  });
}

/** Graph editor: edit one side's ease of one keyframe dimension. */
export function setKeyframeEase(compId: string, key: string, side: 'in' | 'out', dim: number, ease: Ease, coalesce = true): void {
  doc((d) => {
    forEachSelectedKf([key], compId, d, (kf) => {
      const list = (side === 'in' ? kf.easeIn : kf.easeOut) as Ease[];
      while (list.length <= dim) list.push({ speed: 0, influence: EASY_EASE_INFLUENCE });
      list[dim] = { speed: ease.speed, influence: Math.max(0.001, Math.min(1, ease.influence)) };
      if (side === 'in') kf.inType = kf.inType === 'continuous' ? 'continuous' : 'bezier';
      else kf.outType = kf.outType === 'continuous' ? 'continuous' : 'bezier';
      if (kf.inType === 'continuous' || kf.outType === 'continuous') {
        const other = (side === 'in' ? kf.easeOut : kf.easeIn) as Ease[];
        while (other.length <= dim) other.push({ speed: 0, influence: EASY_EASE_INFLUENCE });
        other[dim] = { ...other[dim], speed: ease.speed };
      }
    });
  }, coalesce ? { coalesce: `ease:${key}` } : {});
}

export function setKeyframeValue(compId: string, key: string, value: PropValue): void {
  doc((d) => forEachSelectedKf([key], compId, d, (kf) => (kf.v = clone(value) as never)), { coalesce: `kfv:${key}` });
}

export function setSpatialTangents(compId: string, key: string, ti: number[] | null, to: number[] | null, breakLink: boolean): void {
  doc((d) => {
    forEachSelectedKf([key], compId, d, (kf) => {
      const v = kf.v as number[];
      if (kf.spatial === 'auto' || kf.spatial === 'linear' || !kf.ti || !kf.to) {
        kf.ti = (kf.ti ?? v.map(() => 0)) as never;
        kf.to = (kf.to ?? v.map(() => 0)) as never;
      }
      kf.spatial = breakLink ? 'bezier' : 'continuous';
      if (ti) {
        kf.ti = ti as never;
        if (!breakLink) {
          const l = Math.hypot(...(kf.to as number[])) || Math.hypot(...ti);
          const tl = Math.hypot(...ti) || 1;
          kf.to = ti.map((c) => (-c / tl) * l) as never;
        }
      }
      if (to) {
        kf.to = to as never;
        if (!breakLink) {
          const l = Math.hypot(...(kf.ti as number[])) || Math.hypot(...to);
          const tl = Math.hypot(...to) || 1;
          kf.ti = to.map((c) => (-c / tl) * l) as never;
        }
      }
    });
  });
}

export function toggleRoving(keys: string[]): void {
  const compId = getApp().activeCompId;
  if (!compId) return;
  doc((d) => forEachSelectedKf(keys, compId, d, (kf) => (kf.roving = !kf.roving)));
}

// ── keyframe clipboard ──────────────────────────────────────────────────────

interface ClipKeyframes {
  kind: 'keyframes';
  items: { path: string; keyframes: Keyframe[] }[];
  t0: number;
}
interface ClipLayers {
  kind: 'layers';
  layers: Layer[];
}
let clipboard: ClipKeyframes | ClipLayers | null = null;

export function copySelection(): void {
  const s = getApp();
  const comp = activeComp();
  if (!comp) return;
  if (s.selKeys.length) {
    const items = new Map<string, Keyframe[]>();
    let t0 = Infinity;
    let layerForPaths: Layer | null = null;
    for (const k of s.selKeys) {
      const r = refOf(k);
      const layer = comp.layers.find((l) => l.id === r.layerId);
      const p = layer ? getProp(layer, r.path) : undefined;
      const kf = p?.keyframes.find((x) => x.id === r.kfId);
      if (!layer || !kf) continue;
      layerForPaths = layer;
      const ct = toCompTime(layer, kf.t);
      t0 = Math.min(t0, ct);
      const list = items.get(r.path) ?? [];
      list.push({ ...clone(kf), t: ct });
      items.set(r.path, list);
    }
    if (layerForPaths) {
      clipboard = { kind: 'keyframes', items: [...items].map(([path, keyframes]) => ({ path, keyframes })), t0 };
      toast(`Copied ${s.selKeys.length} keyframe${s.selKeys.length > 1 ? 's' : ''}`);
    }
    return;
  }
  if (s.selLayers.length) {
    clipboard = { kind: 'layers', layers: comp.layers.filter((l) => s.selLayers.includes(l.id)).map((l) => clone(l)) };
    toast(`Copied ${s.selLayers.length} layer${s.selLayers.length > 1 ? 's' : ''}`);
  }
}

export function cutSelection(): void {
  copySelection();
  const s = getApp();
  if (s.selKeys.length) deleteKeyframes(s.selKeys);
  else if (s.selLayers.length && s.activeCompId) deleteLayers(s.activeCompId, s.selLayers);
}

export function paste(): void {
  const s = getApp();
  const comp = activeComp();
  if (!comp || !clipboard) return;
  const t = getTime(comp.id);
  if (clipboard.kind === 'layers') {
    const layers = clipboard.layers.map((l) => regenIds(clone(l)));
    const idMap = new Map<string, string>();
    clipboard.layers.forEach((l, i) => idMap.set(l.id, layers[i].id));
    for (const l of layers) {
      if (l.parentId) l.parentId = idMap.get(l.parentId) ?? (comp.layers.some((x) => x.id === l.parentId) ? l.parentId : null);
      if (l.trackMatte) {
        const m = idMap.get(l.trackMatte.layerId) ?? (comp.layers.some((x) => x.id === l.trackMatte!.layerId) ? l.trackMatte.layerId : null);
        l.trackMatte = m ? { ...l.trackMatte, layerId: m } : null;
      }
    }
    doc((d) => {
      const c = compOf(d, comp.id);
      if (!c) return;
      for (const l of layers) l.name = uniqueLayerName(c as Composition, l.name);
      c.layers.unshift(...(layers as never[]));
    });
    setApp({ selLayers: layers.map((l) => l.id), selKeys: [] });
    return;
  }
  // keyframes: paste onto the first selected layer (or the source layer when the paths exist)
  const targetId = s.selLayers[0];
  if (!targetId) {
    toast('Select a layer to paste keyframes into', 'warn');
    return;
  }
  const clip = clipboard;
  const newKeys: string[] = [];
  doc((d) => {
    const layer = layerOf(d, comp.id, targetId);
    if (!layer) return;
    const L = plain(layer) as Layer;
    for (const item of clip.items) {
      const p = getAt(layer, item.path) as Draft<AnimProp> | undefined;
      if (!p || !isAnimProp(p)) continue;
      for (const kf of item.keyframes) {
        const nk = { ...clone(kf), id: uid('k'), t: toLayerTime(L, kf.t - clip.t0 + t) };
        p.keyframes = p.keyframes.filter((x) => Math.abs(x.t - nk.t) > 1e-6);
        p.keyframes.push(nk as never);
        newKeys.push(keyOf({ layerId: targetId, path: item.path, kfId: nk.id }));
      }
      p.keyframes.sort((a, b) => a.t - b.t);
    }
  });
  setApp({ selKeys: newKeys });
}

// ── navigation ──────────────────────────────────────────────────────────────

export function goToTime(compId: string, t: number): void {
  const comp = getApp().project.comps[compId];
  if (!comp) return;
  const fd = frameDuration(comp.frameRate);
  setTime(compId, Math.max(0, Math.min(comp.duration - fd, snapToFrame(t, comp.frameRate))));
}

export function stepFrames(n: number): void {
  const comp = activeComp();
  if (!comp) return;
  goToTime(comp.id, getTime(comp.id) + n * frameDuration(comp.frameRate));
}

/** J / K: jump to the previous / next keyframe or marker of the relevant layers. */
export function jumpKeyframe(dir: -1 | 1): void {
  const comp = activeComp();
  if (!comp) return;
  const s = getApp();
  const t = getTime(comp.id);
  const layers = s.selLayers.length ? comp.layers.filter((l) => s.selLayers.includes(l.id)) : comp.layers;
  const times: number[] = [...comp.markers.map((m) => m.time), comp.workArea[0], comp.workArea[1]];
  for (const l of layers) {
    for (const path of animatedPaths(l)) {
      const p = getProp(l, path);
      for (const k of p?.keyframes ?? []) times.push(toCompTime(l, k.t));
    }
    times.push(l.inPoint, l.outPoint);
    for (const m of l.markers) times.push(toCompTime(l, m.time));
  }
  const eps = frameDuration(comp.frameRate) * 0.5;
  const cand = times.filter((x) => (dir > 0 ? x > t + eps : x < t - eps));
  if (!cand.length) return;
  goToTime(comp.id, dir > 0 ? Math.min(...cand) : Math.max(...cand));
}

// ── layers ──────────────────────────────────────────────────────────────────

export function addLayer(compId: string, layer: Layer, opts: { index?: number; select?: boolean } = {}): void {
  doc((d) => {
    const c = compOf(d, compId);
    if (!c) return;
    layer.name = uniqueLayerName(c as Composition, layer.name);
    let index = opts.index ?? 0;
    if (opts.index === undefined) {
      const sel = getApp().selLayers;
      const idx = c.layers.findIndex((l) => sel.includes(l.id));
      if (idx >= 0) index = idx;
    }
    c.layers.splice(index, 0, layer as never);
  });
  if (opts.select !== false) setApp({ selLayers: [layer.id], selKeys: [], selProps: [] });
}

export function deleteLayers(compId: string, ids: string[]): void {
  if (!ids.length) return;
  const del = new Set(ids);
  doc((d) => {
    const c = compOf(d, compId);
    if (!c) return;
    c.layers = c.layers.filter((l) => !del.has(l.id));
    for (const l of c.layers) {
      if (l.parentId && del.has(l.parentId)) l.parentId = null;
      if (l.trackMatte && del.has(l.trackMatte.layerId)) l.trackMatte = null;
    }
  });
  setApp((s) => ({ selLayers: s.selLayers.filter((x) => !del.has(x)), selKeys: s.selKeys.filter((k) => !del.has(k.split('|')[0])) }));
}

export function duplicateLayers(compId: string, ids: string[]): string[] {
  const comp = getApp().project.comps[compId];
  if (!comp || !ids.length) return [];
  const idMap = new Map<string, string>();
  const dups: Layer[] = [];
  for (const l of comp.layers) {
    if (!ids.includes(l.id)) continue;
    const c = regenIds(clone(l));
    idMap.set(l.id, c.id);
    dups.push(c);
  }
  for (const c of dups) {
    if (c.parentId && idMap.has(c.parentId)) c.parentId = idMap.get(c.parentId)!;
    if (c.trackMatte && idMap.has(c.trackMatte.layerId)) c.trackMatte = { ...c.trackMatte, layerId: idMap.get(c.trackMatte.layerId)! };
  }
  doc((d) => {
    const c = compOf(d, compId);
    if (!c) return;
    for (const dup of dups) {
      const srcId = [...idMap].find(([, v]) => v === dup.id)![0];
      const idx = c.layers.findIndex((l) => l.id === srcId);
      dup.name = uniqueLayerName(c as Composition, dup.name);
      c.layers.splice(Math.max(0, idx), 0, dup as never);
    }
  });
  const newIds = dups.map((x) => x.id);
  setApp({ selLayers: newIds, selKeys: [] });
  return newIds;
}

export function splitLayers(compId: string, ids: string[], t = getTime(compId)): void {
  const comp = getApp().project.comps[compId];
  if (!comp) return;
  const targets = comp.layers.filter((l) => ids.includes(l.id) && t > Math.min(l.inPoint, l.outPoint) && t < Math.max(l.inPoint, l.outPoint));
  if (!targets.length) return;
  const created: string[] = [];
  doc((d) => {
    const c = compOf(d, compId);
    if (!c) return;
    for (const src of targets) {
      const idx = c.layers.findIndex((l) => l.id === src.id);
      const orig = c.layers[idx];
      const dup = regenIds(clone(src));
      dup.name = uniqueLayerName(c as Composition, src.name);
      dup.inPoint = t;
      orig.outPoint = t;
      c.layers.splice(idx, 0, dup as never);
      created.push(dup.id);
    }
  });
  setApp({ selLayers: created });
}

export function reorderLayers(compId: string, ids: string[], toIndex: number): void {
  doc((d) => {
    const c = compOf(d, compId);
    if (!c) return;
    const moving = c.layers.filter((l) => ids.includes(l.id));
    const rest = c.layers.filter((l) => !ids.includes(l.id));
    const before = c.layers.slice(0, toIndex).filter((l) => !ids.includes(l.id)).length;
    rest.splice(before, 0, ...moving);
    c.layers = rest as never;
  });
}

export function arrangeLayers(compId: string, ids: string[], how: 'forward' | 'backward' | 'front' | 'back'): void {
  const comp = getApp().project.comps[compId];
  if (!comp || !ids.length) return;
  const idxs = comp.layers.map((l, i) => (ids.includes(l.id) ? i : -1)).filter((i) => i >= 0);
  const first = Math.min(...idxs), last = Math.max(...idxs);
  const to = how === 'front' ? 0 : how === 'back' ? comp.layers.length : how === 'forward' ? Math.max(0, first - 1) : last + 2;
  reorderLayers(compId, ids, to);
}

export function setLayerFields(compId: string, ids: string[], fields: Partial<Layer>, coalesce?: string): void {
  doc((d) => {
    for (const id of ids) {
      const l = layerOf(d, compId, id);
      if (l) Object.assign(l, clone(fields));
    }
  }, coalesce ? { coalesce } : {});
}

/** Set any non-animated field by dot path inside a layer (e.g. "text.document.font"). */
export function setLayerPath(compId: string, layerId: string, path: string, value: unknown, coalesce?: string): void {
  doc((d) => {
    const l = layerOf(d, compId, layerId);
    if (!l) return;
    const parent = getAt(l, parentPath(path));
    if (parent && typeof parent === 'object') (parent as Record<string, unknown>)[lastSeg(path)] = clone(value);
  }, coalesce ? { coalesce } : {});
}

export function toggleLayerSwitch(compId: string, ids: string[], key: keyof Layer): void {
  const comp = getApp().project.comps[compId];
  if (!comp) return;
  const first = comp.layers.find((l) => ids.includes(l.id));
  if (!first) return;
  const v = !first[key];
  doc((d) => {
    for (const id of ids) {
      const l = layerOf(d, compId, id);
      if (!l) continue;
      (l as Record<string, unknown>)[key as string] = v;
      if (key === 'threeD' && !v) {
        // flatten: keep x/y, reset 3D-only rotations
        l.transform.rotationX.value = 0;
        l.transform.rotationY.value = 0;
        l.transform.orientation.value = [0, 0, 0];
      }
    }
  });
}

/** 2D decomposition helpers used by parenting compensation. */
function decompose2D(m: M.Mat4): { rot: number; sx: number; sy: number } {
  const sx = Math.hypot(m[0], m[1]);
  const det = m[0] * m[5] - m[1] * m[4];
  const sy = (det < 0 ? -1 : 1) * Math.hypot(m[4], m[5]);
  return { rot: (Math.atan2(m[1], m[0]) * 180) / Math.PI, sx, sy };
}

export function setParent(compId: string, layerId: string, parentId: string | null, compensate = true): void {
  const p = getApp().project;
  const comp = p.comps[compId];
  if (!comp) return;
  // refuse cycles
  let cur = parentId;
  for (let i = 0; cur && i < 64; i++) {
    if (cur === layerId) {
      toast('Cannot parent a layer to its own descendant', 'warn');
      return;
    }
    cur = comp.layers.find((l) => l.id === cur)?.parentId ?? null;
  }
  const fe = new FrameEval(p, comp, getTime(compId));
  const layer = comp.layers.find((l) => l.id === layerId);
  if (!layer) return;
  const oldParent = layer.parentId ? comp.layers.find((l) => l.id === layer.parentId) : undefined;
  const newParent = parentId ? comp.layers.find((l) => l.id === parentId) : undefined;
  const oldW = oldParent ? fe.worldMatrix(oldParent) : M.identity();
  const newW = newParent ? fe.worldMatrix(newParent) : M.identity();
  const inv = M.invert(newW) ?? M.identity();
  const conv = M.multiply(inv, oldW); // old parent space → new parent space
  const d0 = decompose2D(oldW), d1 = decompose2D(newW);
  doc((d) => {
    const l = layerOf(d, compId, layerId);
    if (!l) return;
    l.parentId = parentId;
    if (!compensate) return;
    const mapPos = (v: number[]) => {
      const r = M.transformPoint(conv, v);
      return [r[0], r[1], v.length > 2 ? r[2] : 0];
    };
    const pos = l.transform.position;
    if (pos.keyframes.length) for (const k of pos.keyframes) k.v = mapPos(k.v as number[]) as never;
    else pos.value = mapPos(pos.value as number[]) as never;
    const dr = d0.rot - d1.rot;
    const rot = l.transform.rotation;
    if (rot.keyframes.length) for (const k of rot.keyframes) k.v = ((k.v as number) + dr) as never;
    else rot.value = (rot.value as number) + dr;
    const fx = d0.sx / (d1.sx || 1), fy = d0.sy / (d1.sy || 1);
    const sc = l.transform.scale;
    const mapS = (v: number[]) => [v[0] * fx, v[1] * fy, v[2]];
    if (sc.keyframes.length) for (const k of sc.keyframes) k.v = mapS(k.v as number[]) as never;
    else sc.value = mapS(sc.value as number[]) as never;
  });
}

export function setTrackMatte(compId: string, layerId: string, matteId: string | null, mode: 'alpha' | 'alphaInverted' | 'luma' | 'lumaInverted' = 'alpha'): void {
  doc((d) => {
    const l = layerOf(d, compId, layerId);
    if (!l) return;
    l.trackMatte = matteId ? { layerId: matteId, mode } : null;
    if (matteId) {
      const m = layerOf(d, compId, matteId);
      if (m) m.enabled = false;
    }
  });
}

// ── layer timing ────────────────────────────────────────────────────────────

export function shiftLayers(compId: string, ids: string[], dt: number): void {
  doc((d) => {
    for (const id of ids) {
      const l = layerOf(d, compId, id);
      if (!l) continue;
      l.startTime += dt;
      l.inPoint += dt;
      l.outPoint += dt;
    }
  });
}

export function trimLayers(compId: string, ids: string[], which: 'in' | 'out', t = getTime(compId)): void {
  const comp = getApp().project.comps[compId];
  if (!comp) return;
  const fd = frameDuration(comp.frameRate);
  doc((d) => {
    for (const id of ids) {
      const l = layerOf(d, compId, id);
      if (!l) continue;
      if (which === 'in') l.inPoint = Math.min(t, l.outPoint - fd);
      else l.outPoint = Math.max(t + fd, l.inPoint + fd);
    }
  });
}

export function moveLayersTo(compId: string, ids: string[], which: 'in' | 'out', t = getTime(compId)): void {
  const comp = getApp().project.comps[compId];
  if (!comp) return;
  const fd = frameDuration(comp.frameRate);
  doc((d) => {
    for (const id of ids) {
      const l = layerOf(d, compId, id);
      if (!l) continue;
      const dt = which === 'in' ? t - l.inPoint : t + fd - l.outPoint;
      l.startTime += dt;
      l.inPoint += dt;
      l.outPoint += dt;
    }
  });
}

export function timeReverse(compId: string, ids: string[]): void {
  doc((d) => {
    for (const id of ids) {
      const l = layerOf(d, compId, id);
      if (!l) continue;
      l.startTime = l.inPoint + l.outPoint - l.startTime;
      l.stretch = -l.stretch;
    }
  });
}

export function timeStretch(compId: string, id: string, percent: number): void {
  if (!percent) return;
  doc((d) => {
    const l = layerOf(d, compId, id);
    if (!l) return;
    const k0 = l.stretch / 100, k1 = percent / 100;
    l.startTime = l.inPoint - (l.inPoint - l.startTime) * (k1 / k0);
    l.outPoint = l.inPoint + (l.outPoint - l.inPoint) * Math.abs(k1 / k0);
    l.stretch = percent;
  });
}

export function setTimeRemap(compId: string, id: string, on: boolean): void {
  const comp = getApp().project.comps[compId];
  const layer = comp?.layers.find((l) => l.id === id);
  if (!comp || !layer) return;
  doc((d) => {
    const l = layerOf(d, compId, id);
    if (!l) return;
    l.timeRemapEnabled = on;
    if (on) {
      const fd = frameDuration(comp.frameRate);
      const a = toLayerTime(layer, layer.inPoint), b = toLayerTime(layer, layer.outPoint - fd);
      l.timeRemap = { value: a, keyframes: [makeKeyframe(toLayerTime(layer, layer.inPoint), a, false), makeKeyframe(toLayerTime(layer, layer.outPoint - fd), b, false)] } as never;
    } else l.timeRemap = { value: 0, keyframes: [] } as never;
  });
}

export function freezeFrame(compId: string, id: string): void {
  const comp = getApp().project.comps[compId];
  const layer = comp?.layers.find((l) => l.id === id);
  if (!comp || !layer) return;
  const t = getTime(compId);
  const fe = new FrameEval(getApp().project, comp, t);
  const st = fe.sourceTime(layer);
  doc((d) => {
    const l = layerOf(d, compId, id);
    if (!l) return;
    l.timeRemapEnabled = true;
    const k = makeKeyframe(toLayerTime(layer, t), st, false);
    k.inType = 'hold';
    k.outType = 'hold';
    l.timeRemap = { value: st, keyframes: [k] } as never;
  });
}

// ── transforms ──────────────────────────────────────────────────────────────

export function resetTransform(compId: string, ids: string[]): void {
  const p = getApp().project;
  const comp = p.comps[compId];
  if (!comp) return;
  doc((d) => {
    for (const id of ids) {
      const l = layerOf(d, compId, id);
      if (!l) continue;
      const size = layerSourceSize(p, comp, l as Layer);
      const isShapeLike = l.type === 'shape' || l.type === 'text';
      const t = l.transform;
      t.anchor = { value: isShapeLike ? [0, 0, 0] : [size.w / 2, size.h / 2, 0], keyframes: [] } as never;
      t.position = { value: [comp.width / 2, comp.height / 2, 0], keyframes: [] } as never;
      t.scale = { value: [100, 100, 100], keyframes: [] } as never;
      t.rotation = { value: 0, keyframes: [] } as never;
      t.rotationX = { value: 0, keyframes: [] } as never;
      t.rotationY = { value: 0, keyframes: [] } as never;
      t.orientation = { value: [0, 0, 0], keyframes: [] } as never;
      t.opacity = { value: 100, keyframes: [] } as never;
    }
  });
}

export function fitToComp(compId: string, ids: string[], mode: 'fit' | 'width' | 'height' = 'fit'): void {
  const p = getApp().project;
  const comp = p.comps[compId];
  if (!comp) return;
  doc((d) => {
    for (const id of ids) {
      const l = layerOf(d, compId, id);
      if (!l || l.type === 'shape' || l.type === 'text') continue;
      const size = layerSourceSize(p, comp, l as Layer);
      const sx = (comp.width / size.w) * 100, sy = (comp.height / size.h) * 100;
      const s = mode === 'width' ? sx : mode === 'height' ? sy : Math.min(sx, sy);
      l.transform.scale = { value: [s, s, 100], keyframes: [] } as never;
      l.transform.position = { value: [comp.width / 2, comp.height / 2, 0], keyframes: [] } as never;
      l.transform.anchor = { value: [size.w / 2, size.h / 2, 0], keyframes: [] } as never;
    }
  });
}

export function centerAnchor(compId: string, ids: string[], contentBounds?: (l: Layer) => { x: number; y: number; w: number; h: number } | null): void {
  const p = getApp().project;
  const comp = p.comps[compId];
  if (!comp) return;
  const fe = new FrameEval(p, comp, getTime(compId));
  doc((d) => {
    for (const id of ids) {
      const l = layerOf(d, compId, id);
      if (!l) continue;
      const L = plain(l) as Layer;
      const b = contentBounds?.(L) ?? (() => {
        const s = layerSourceSize(p, comp, L);
        return { x: 0, y: 0, w: s.w, h: s.h };
      })();
      if (!b) continue;
      const tv = fe.transformValues(L);
      const newA = [b.x + b.w / 2, b.y + b.h / 2, tv.anchor[2] ?? 0];
      // keep the layer in place: position moves by the transformed anchor delta
      const local = fe.localMatrix(L);
      const before = M.transformPoint(local, tv.anchor);
      const after = M.transformPoint(local, newA);
      const parentSpaceDelta = [after[0] - before[0], after[1] - before[1], after[2] - before[2]];
      if (l.transform.anchor.keyframes.length || l.transform.position.keyframes.length) continue;
      l.transform.anchor.value = newA as never;
      const pv = l.transform.position.value as number[];
      l.transform.position.value = [pv[0] + parentSpaceDelta[0], pv[1] + parentSpaceDelta[1], (pv[2] ?? 0) + parentSpaceDelta[2]] as never;
    }
  });
}

// ── compositions ────────────────────────────────────────────────────────────

export function newComp(opts: CompOptions, open = true): string {
  const c = createComp({ ...opts, name: uniqueCompName(getApp().project, opts.name ?? 'Comp 1') });
  doc((d) => {
    d.comps[c.id] = c as never;
  });
  if (open) openComp(c.id);
  return c.id;
}

export function openComp(compId: string): void {
  setApp((s) => ({
    activeCompId: compId,
    openComps: s.openComps.includes(compId) ? s.openComps : [...s.openComps, compId],
    selLayers: [],
    selKeys: [],
    selProps: [],
    timelines: s.timelines[compId] ? s.timelines : { ...s.timelines, [compId]: defaultTimeline() },
  }));
}

export function closeComp(compId: string): void {
  setApp((s) => {
    const openComps = s.openComps.filter((c) => c !== compId);
    return { openComps, activeCompId: s.activeCompId === compId ? openComps[openComps.length - 1] ?? null : s.activeCompId };
  });
}

export function updateComp(compId: string, fields: Partial<Composition>): void {
  doc((d) => {
    const c = compOf(d, compId);
    if (!c) return;
    const oldDur = c.duration;
    Object.assign(c, clone(fields));
    if (fields.duration !== undefined && fields.duration !== oldDur) {
      c.workArea = [Math.min(c.workArea[0], c.duration), Math.min(c.workArea[1] >= oldDur - 1e-6 ? c.duration : c.workArea[1], c.duration)];
      for (const l of c.layers) {
        if (l.outPoint >= oldDur - 1e-6 && (l.type === 'solid' || l.type === 'shape' || l.type === 'text' || l.type === 'null' || l.type === 'camera' || l.type === 'light' || l.type === 'image')) l.outPoint = c.duration;
      }
    }
  });
  const t = getTime(compId);
  const c = getApp().project.comps[compId];
  if (c && t >= c.duration) goToTime(compId, c.duration);
}

export function setWorkArea(compId: string, start?: number, end?: number): void {
  doc((d) => {
    const c = compOf(d, compId);
    if (!c) return;
    const fd = frameDuration(c.frameRate);
    let [a, b] = c.workArea;
    if (start !== undefined) a = Math.max(0, Math.min(start, b - fd));
    if (end !== undefined) b = Math.min(c.duration, Math.max(end, a + fd));
    c.workArea = [a, b];
  }, { coalesce: `wa:${compId}` });
}

export function trimCompToWorkArea(compId: string): void {
  const c = getApp().project.comps[compId];
  if (!c) return;
  const [a, b] = c.workArea;
  doc((d) => {
    const cc = compOf(d, compId);
    if (!cc) return;
    for (const l of cc.layers) {
      l.startTime -= a;
      l.inPoint -= a;
      l.outPoint -= a;
    }
    for (const m of cc.markers) m.time -= a;
    cc.duration = b - a;
    cc.workArea = [0, b - a];
  });
  goToTime(compId, 0);
}

export function duplicateComp(compId: string): string | null {
  const p = getApp().project;
  const c = p.comps[compId];
  if (!c) return null;
  const copy = regenIds(clone(c));
  copy.name = uniqueCompName(p, c.name);
  // remap parent / matte references inside the copy
  const map = new Map(c.layers.map((l, i) => [l.id, copy.layers[i].id]));
  for (const l of copy.layers) {
    if (l.parentId) l.parentId = map.get(l.parentId) ?? null;
    if (l.trackMatte) l.trackMatte = map.has(l.trackMatte.layerId) ? { ...l.trackMatte, layerId: map.get(l.trackMatte.layerId)! } : null;
  }
  doc((d) => {
    d.comps[copy.id] = copy as never;
  });
  return copy.id;
}

export function addCompMarker(compId: string, t = getTime(compId), comment = ''): void {
  doc((d) => {
    const c = compOf(d, compId);
    if (!c) return;
    c.markers.push({ id: uid('mk'), time: t, duration: 0, comment, label: 11 } as never);
    c.markers.sort((a, b) => a.time - b.time);
  });
}

export function precompose(compId: string, ids: string[], name: string, moveAll = true): string | null {
  const p = getApp().project;
  const comp = p.comps[compId];
  if (!comp || !ids.length) return null;
  const moving = comp.layers.filter((l) => ids.includes(l.id));
  const nested = createComp({ name: uniqueCompName(p, name), width: comp.width, height: comp.height, frameRate: comp.frameRate, duration: comp.duration, bgColor: comp.bgColor });
  nested.motionBlur = comp.motionBlur;
  nested.shutterAngle = comp.shutterAngle;
  nested.layers = moving.map((l) => {
    const c = clone(l);
    if (c.parentId && !ids.includes(c.parentId)) c.parentId = null;
    if (c.trackMatte && !ids.includes(c.trackMatte.layerId)) c.trackMatte = null;
    return c;
  });
  const pl = createPrecompLayer(comp, nested);
  pl.name = nested.name;
  if (!moveAll && moving.length === 1) {
    // keep transform on the outer layer (AE "Leave all attributes")
    pl.transform = clone(moving[0].transform);
    nested.layers[0].transform = clone(createPrecompLayer(nested, nested).transform);
  }
  const firstIdx = comp.layers.findIndex((l) => ids.includes(l.id));
  doc((d) => {
    d.comps[nested.id] = nested as never;
    const c = compOf(d, compId);
    if (!c) return;
    c.layers = c.layers.filter((l) => !ids.includes(l.id));
    for (const l of c.layers) {
      if (l.parentId && ids.includes(l.parentId)) l.parentId = null;
      if (l.trackMatte && ids.includes(l.trackMatte.layerId)) l.trackMatte = null;
    }
    c.layers.splice(Math.min(firstIdx, c.layers.length), 0, pl as never);
  });
  setApp({ selLayers: [pl.id] });
  return nested.id;
}

export function deleteProjectItems(ids: string[]): void {
  const p = getApp().project;
  const compIds = ids.filter((id) => p.comps[id]);
  const footIds = ids.filter((id) => p.footage[id]);
  const folderIds = ids.filter((id) => p.folders[id]);
  doc((d) => {
    for (const id of compIds) delete d.comps[id];
    for (const id of footIds) delete d.footage[id];
    for (const id of folderIds) {
      delete d.folders[id];
      for (const c of Object.values(d.comps)) if (c.folderId === id) c.folderId = null;
      for (const f of Object.values(d.footage)) if (f.folderId === id) f.folderId = null;
      for (const f of Object.values(d.folders)) if (f.folderId === id) f.folderId = null;
    }
    for (const c of Object.values(d.comps)) {
      c.layers = c.layers.filter((l) => !(l.source?.compId && compIds.includes(l.source.compId)) && !(l.source?.footageId && footIds.includes(l.source.footageId)));
    }
  });
  setApp((s) => ({
    selItems: [],
    openComps: s.openComps.filter((c) => !compIds.includes(c)),
    activeCompId: s.activeCompId && compIds.includes(s.activeCompId) ? Object.keys(getApp().project.comps)[0] ?? null : s.activeCompId,
  }));
}

export function renameItem(id: string, name: string): void {
  doc((d) => {
    if (d.comps[id]) d.comps[id].name = name;
    else if (d.footage[id]) d.footage[id].name = name;
    else if (d.folders[id]) d.folders[id].name = name;
  });
}

export function newFolder(name = 'New Folder', parent: string | null = null): string {
  const id = uid('fo');
  doc((d) => {
    d.folders[id] = { id, name, folderId: parent };
  });
  return id;
}

export function moveToFolder(ids: string[], folderId: string | null): void {
  doc((d) => {
    for (const id of ids) {
      if (id === folderId) continue;
      if (d.comps[id]) d.comps[id].folderId = folderId;
      else if (d.footage[id]) d.footage[id].folderId = folderId;
      else if (d.folders[id]) d.folders[id].folderId = folderId;
    }
  });
}

export function addFootage(f: Footage): void {
  doc((d) => {
    d.footage[f.id] = f as never;
  });
}

export function updateFootage(id: string, fields: Partial<Footage>): void {
  doc((d) => {
    const f = d.footage[id];
    if (f) Object.assign(f, clone(fields));
  });
}

// ── effects ─────────────────────────────────────────────────────────────────

export function addEffect(compId: string, layerId: string, type: string): void {
  const p = getApp().project;
  const comp = p.comps[compId];
  const layer = comp?.layers.find((l) => l.id === layerId);
  if (!comp || !layer) return;
  if (layer.type === 'camera' || layer.type === 'light' || layer.type === 'audio') {
    toast('Effects cannot be applied to this layer type', 'warn');
    return;
  }
  const dims = layerSourceSize(p, comp, layer);
  const fx = createEffect(type, dims, layer.effects.map((e) => e.name));
  doc((d) => {
    const l = layerOf(d, compId, layerId);
    l?.effects.push(fx as never);
  });
  setApp((s) => ({ selEffect: fx.id, expanded: { ...s.expanded, [`${layerId}|effects`]: true, [`${layerId}|effects.${fx.id}`]: true } }));
}

export function addEffectToSelection(type: string): void {
  const s = getApp();
  if (!s.activeCompId || !s.selLayers.length) {
    toast('Select a layer to apply an effect', 'warn');
    return;
  }
  beginTx();
  for (const id of s.selLayers) addEffect(s.activeCompId, id, type);
  endTx();
  const def = getEffectDef(type);
  if (def) toast(`Applied ${def.name}`, 'success', 1800);
}

export function removeEffect(compId: string, layerId: string, fxId: string): void {
  doc((d) => {
    const l = layerOf(d, compId, layerId);
    if (l) l.effects = l.effects.filter((e) => e.id !== fxId);
  });
}

export function moveEffect(compId: string, layerId: string, fxId: string, toIndex: number): void {
  doc((d) => {
    const l = layerOf(d, compId, layerId);
    if (!l) return;
    const i = l.effects.findIndex((e) => e.id === fxId);
    if (i < 0) return;
    const [fx] = l.effects.splice(i, 1);
    l.effects.splice(Math.max(0, Math.min(l.effects.length, toIndex)), 0, fx);
  });
}

export function resetEffect(compId: string, layerId: string, fxId: string): void {
  const p = getApp().project;
  const comp = p.comps[compId];
  const layer = comp?.layers.find((l) => l.id === layerId);
  const fx = layer?.effects.find((e) => e.id === fxId);
  const def = fx ? getEffectDef(fx.type) : undefined;
  if (!comp || !layer || !fx || !def) return;
  const dims = layerSourceSize(p, comp, layer);
  doc((d) => {
    const e = layerOf(d, compId, layerId)?.effects.find((x) => x.id === fxId);
    if (!e) return;
    for (const pd of def.params) e.params[pd.id] = { value: resolveDefault(pd, dims), keyframes: [] } as never;
  });
}

export function duplicateEffect(compId: string, layerId: string, fxId: string): void {
  doc((d) => {
    const l = layerOf(d, compId, layerId);
    if (!l) return;
    const i = l.effects.findIndex((e) => e.id === fxId);
    if (i < 0) return;
    const c = regenIds(clone(l.effects[i])) as EffectInstance;
    c.name = `${c.name} copy`;
    l.effects.splice(i + 1, 0, c as never);
  });
}

export function setEffectField(compId: string, layerId: string, fxId: string, fields: Partial<EffectInstance>): void {
  doc((d) => {
    const e = layerOf(d, compId, layerId)?.effects.find((x) => x.id === fxId);
    if (e) Object.assign(e, fields);
  });
}

// ── masks ───────────────────────────────────────────────────────────────────

export function addMask(compId: string, layerId: string, path: BezierPath): string | null {
  let id: string | null = null;
  doc((d) => {
    const l = layerOf(d, compId, layerId);
    if (!l) return;
    const m = createMask(path, l.masks.length);
    id = m.id;
    l.masks.push(m as never);
  });
  setApp((s) => ({ expanded: { ...s.expanded, [`${layerId}|masks`]: true }, selMask: id }));
  return id;
}

export function setMaskFields(compId: string, layerId: string, maskId: string, fields: Partial<Pick<Mask, 'mode' | 'inverted' | 'name' | 'locked' | 'color'>>): void {
  doc((d) => {
    const m = layerOf(d, compId, layerId)?.masks.find((x) => x.id === maskId);
    if (m) Object.assign(m, fields);
  });
}

export function removeMask(compId: string, layerId: string, maskId: string): void {
  doc((d) => {
    const l = layerOf(d, compId, layerId);
    if (l) l.masks = l.masks.filter((m) => m.id !== maskId);
  });
}

export const MASK_MODES: MaskMode[] = ['none', 'add', 'subtract', 'intersect', 'lighten', 'darken', 'difference'];

// ── shape contents ──────────────────────────────────────────────────────────

/** Add a shape item into a layer's contents (or into the group at `groupPath`), at the top. */
export function addShapeItem(compId: string, layerId: string, item: ShapeItem, groupPath: string | null = null, atEnd = false): void {
  doc((d) => {
    const l = layerOf(d, compId, layerId);
    if (!l || !l.shape) return;
    const list = groupPath ? (getAt(l, `${groupPath}.contents`) as Draft<ShapeItem>[] | undefined) : l.shape.contents;
    if (!list) return;
    if (atEnd) list.push(item as never);
    else list.unshift(item as never);
  });
  setApp((s) => ({ selShapeItem: item.id, expanded: { ...s.expanded, [`${layerId}|shape.contents`]: true } }));
}

export function removeShapeItem(compId: string, layerId: string, itemPath: string): void {
  doc((d) => {
    const l = layerOf(d, compId, layerId);
    if (!l) return;
    const list = getAt(l, parentPath(itemPath)) as Draft<ShapeItem>[] | undefined;
    if (!Array.isArray(list)) return;
    const id = lastSeg(itemPath);
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list.splice(i, 1);
  });
}

export function moveShapeItem(compId: string, layerId: string, itemPath: string, delta: -1 | 1): void {
  doc((d) => {
    const l = layerOf(d, compId, layerId);
    if (!l) return;
    const list = getAt(l, parentPath(itemPath)) as Draft<ShapeItem>[] | undefined;
    if (!Array.isArray(list)) return;
    const i = list.findIndex((x) => x.id === lastSeg(itemPath));
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
  });
}

// ── text ────────────────────────────────────────────────────────────────────

export function setSourceText(compId: string, layerId: string, text: string): void {
  setPropValue(compId, layerId, 'text.sourceText', text, `src:${layerId}`);
  doc((d) => {
    const l = layerOf(d, compId, layerId);
    if (l && l.type === 'text') l.name = text.split('\n')[0].slice(0, 40) || 'Text';
  }, { coalesce: `src:${layerId}` });
}

export function setTextDocument(compId: string, layerIds: string[], fields: Partial<TextDocument>): void {
  doc((d) => {
    for (const id of layerIds) {
      const l = layerOf(d, compId, id);
      if (l?.text) Object.assign(l.text.document, fields);
    }
  }, { coalesce: `doc:${layerIds.join(',')}:${Object.keys(fields).join(',')}` });
}

export function addTextAnimator(compId: string, layerId: string, keys: TextAnimatorPropKey[]): void {
  doc((d) => {
    const l = layerOf(d, compId, layerId);
    if (!l?.text) return;
    const a = createTextAnimator(keys, l.text.animators.length + 1);
    l.text.animators.push(a as never);
  });
  setApp((s) => ({ expanded: { ...s.expanded, [`${layerId}|text`]: true } }));
}

export function addAnimatorProperty(compId: string, layerId: string, animId: string, key: TextAnimatorPropKey): void {
  doc((d) => {
    const a = layerOf(d, compId, layerId)?.text?.animators.find((x) => x.id === animId);
    if (a && !a.props[key]) (a.props as Record<string, unknown>)[key] = createAnimatorProp(key);
  });
}

export function addSelector(compId: string, layerId: string, animId: string, kind: 'range' | 'wiggly'): void {
  doc((d) => {
    const a = layerOf(d, compId, layerId)?.text?.animators.find((x) => x.id === animId);
    if (!a) return;
    const s = kind === 'range' ? createRangeSelector() : createWigglySelector();
    s.name = `${kind === 'range' ? 'Range' : 'Wiggly'} Selector ${a.selectors.length + 1}`;
    a.selectors.push(s as never);
  });
}

export function removeTextNode(compId: string, layerId: string, path: string): void {
  doc((d) => {
    const l = layerOf(d, compId, layerId);
    if (!l) return;
    const parent = getAt(l, parentPath(path));
    const id = lastSeg(path);
    if (Array.isArray(parent)) {
      const i = parent.findIndex((x: { id: string }) => x.id === id);
      if (i >= 0) parent.splice(i, 1);
    } else if (parent && typeof parent === 'object') delete (parent as Record<string, unknown>)[id];
  });
}

// ── expressions ─────────────────────────────────────────────────────────────

export function setExpression(compId: string, layerId: string, path: string, expr: string | null): void {
  doc((d) => {
    const l = layerOf(d, compId, layerId);
    const p = l ? (getAt(l, path) as Draft<AnimProp> | undefined) : undefined;
    if (!p || !isAnimProp(p)) return;
    if (expr === null) {
      delete p.expression;
      delete p.expressionEnabled;
    } else {
      p.expression = expr;
      p.expressionEnabled = true;
    }
  }, { coalesce: `expr:${layerId}:${path}` });
}

export function toggleExpressionEnabled(compId: string, layerId: string, path: string): void {
  doc((d) => {
    const l = layerOf(d, compId, layerId);
    const p = l ? (getAt(l, path) as Draft<AnimProp> | undefined) : undefined;
    if (p && isAnimProp(p) && p.expression !== undefined) p.expressionEnabled = p.expressionEnabled === false;
  });
}

// ── selection ───────────────────────────────────────────────────────────────

export function selectLayers(ids: string[], mode: 'set' | 'add' | 'toggle' = 'set'): void {
  setApp((s) => {
    let sel: string[];
    if (mode === 'set') sel = ids;
    else if (mode === 'add') sel = [...new Set([...s.selLayers, ...ids])];
    else sel = s.selLayers.filter((x) => !ids.includes(x)).concat(ids.filter((x) => !s.selLayers.includes(x)));
    return { selLayers: sel, selKeys: mode === 'set' ? [] : s.selKeys };
  });
}

export function selectAllLayers(): void {
  const comp = activeComp();
  if (comp) setApp({ selLayers: comp.layers.map((l) => l.id) });
}

export function deselectAll(): void {
  setApp({ selLayers: [], selKeys: [], selProps: [], selEffect: null, selMask: null, selShapeItem: null });
}

export function selectAllKeyframes(layerIds?: string[]): void {
  const comp = activeComp();
  if (!comp) return;
  const keys: string[] = [];
  for (const l of comp.layers) {
    if (layerIds && !layerIds.includes(l.id)) continue;
    forEachAnimProp(l, '', (p, path) => {
      for (const k of p.keyframes) keys.push(keyOf({ layerId: l.id, path, kfId: k.id }));
    });
  }
  setApp({ selKeys: keys });
}

// ── reveal (U / UU / P / S / R / T / A) ─────────────────────────────────────

const REVEAL_PROPS: Record<string, string[]> = {
  P: ['transform.position'],
  S: ['transform.scale'],
  R: ['transform.rotation', 'transform.rotationX', 'transform.rotationY', 'transform.orientation'],
  T: ['transform.opacity'],
  A: ['transform.anchor'],
};

export function revealProps(letter: 'P' | 'S' | 'R' | 'T' | 'A', additive: boolean): void {
  const props = REVEAL_PROPS[letter];
  setApp((s) => {
    const cur = s.reveal.kind === 'props' ? s.reveal.props : [];
    if (additive) {
      const has = props.every((p) => cur.includes(p));
      const next = has ? cur.filter((p) => !props.includes(p)) : [...new Set([...cur, ...props])];
      return { reveal: next.length ? { kind: 'props', props: next } : { kind: 'none' } };
    }
    const same = s.reveal.kind === 'props' && cur.length === props.length && props.every((p) => cur.includes(p));
    return { reveal: same ? { kind: 'none' } : { kind: 'props', props } };
  });
  setTimelineRevealExpand();
}

let lastU = 0;
export function revealKeyframes(): void {
  const now = performance.now();
  const double = now - lastU < 350;
  lastU = now;
  setApp((s) => {
    if (double) return { reveal: { kind: 'modified' } };
    return { reveal: s.reveal.kind === 'keyframes' || s.reveal.kind === 'modified' ? { kind: 'none' } : { kind: 'keyframes' } };
  });
  setTimelineRevealExpand();
}

export function revealEffects(): void {
  const s = getApp();
  const comp = activeComp();
  if (!comp) return;
  const ids = s.selLayers.length ? s.selLayers : comp.layers.map((l) => l.id);
  const allOpen = ids.every((id) => s.expanded[`${id}|effects`]);
  setApp((st) => {
    const ex = { ...st.expanded };
    for (const id of ids) {
      ex[id] = !allOpen;
      ex[`${id}|effects`] = !allOpen;
    }
    return { expanded: ex, reveal: { kind: 'none' } };
  });
}

export function revealMasks(): void {
  const s = getApp();
  const comp = activeComp();
  if (!comp) return;
  const ids = (s.selLayers.length ? s.selLayers : comp.layers.map((l) => l.id)).filter((id) => comp.layers.find((l) => l.id === id)?.masks.length);
  const allOpen = ids.every((id) => s.expanded[`${id}|masks`]);
  setApp((st) => {
    const ex = { ...st.expanded };
    for (const id of ids) {
      ex[id] = !allOpen;
      ex[`${id}|masks`] = !allOpen;
    }
    return { expanded: ex, reveal: { kind: 'none' } };
  });
}

function setTimelineRevealExpand(): void {
  const s = getApp();
  const comp = activeComp();
  if (!comp) return;
  const ids = s.selLayers.length ? s.selLayers : comp.layers.map((l) => l.id);
  setApp((st) => {
    const ex = { ...st.expanded };
    for (const id of ids) ex[id] = st.reveal.kind !== 'none';
    return { expanded: ex };
  });
}

export function toggleExpanded(key: string, value?: boolean): void {
  setApp((s) => ({ expanded: { ...s.expanded, [key]: value ?? !s.expanded[key] } }));
}

