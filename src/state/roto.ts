// ─────────────────────────────────────────────────────────────────────────────
// Roto Brush (SAM 2) controller: model lifecycle, interactive prompts, temporal
// propagation and "Freeze" (baking mattes into track mattes or animated mask
// paths). Prompts are clicks on the viewer in LAYER source pixels; they are
// converted to the matte raster and kept in the document per frame.
// ─────────────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import type { BezierPath, Keyframe, Layer, MatteInfo } from '../core/types';
import { beginTx, doc, endTx, getApp, openDialog, setApp, toast } from './store';
import { getTime, setTime } from './time';
import { uid } from '../core/ids';
import { layerSourceSize, toLayerTime } from '../core/evaluate';
import { exactFps } from '../core/time';
import { createEffect, createMask } from '../core/factory';
import { duplicateLayers, makeKeyframe, setTrackMatte } from './actions';
import { connectAnalysisPort } from '../cv/host';
import { analysisComp } from '../cv/host';
import { SAM_MODEL_BASE, SAM_VARIANTS, matteSize, type FromSam, type SamFrameRef, type SamVariant, type ToSam } from '../cv/sam/protocol';
import { getMatte, matteAtFrame, putMatte } from './mattes';
import { findLayer, frameTimes, getTracking, isTrackable, setTracking } from './tracking';
import { alignToPrevious, pointsToBezier, resampleClosed, traceContours, polygonArea, type Pt } from '../cv/mask';

export type ModelState = 'unloaded' | 'loading' | 'ready' | 'error';

export interface RotoState {
  model: ModelState;
  variant: SamVariant | null;
  provider: 'webgpu' | 'wasm' | null;
  /** download progress per file */
  files: Record<string, { loaded: number; total: number }>;
  error: string | null;
  /** a single-frame segmentation is in flight */
  busy: boolean;
  last: { encodeMs: number; decodeMs: number; score: number } | null;
  /** draw the matte boundary + prompts on the viewer */
  overlay: boolean;
}

export const useRoto = create<RotoState>()(() => ({
  model: 'unloaded', variant: null, provider: null, files: {}, error: null, busy: false, last: null, overlay: true,
}));
const setRoto = (p: Partial<RotoState>) => useRoto.setState(p);

const VARIANT_KEY = 'poo.samVariant';

let worker: Worker | null = null;
const jobs = new Map<string, (m: FromSam) => void>();
let loadWaiters: ((ok: boolean) => void)[] = [];
let seq = 1;

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../cv/sam/worker.ts', import.meta.url), { type: 'module', name: 'pooEffects-sam2' });
  worker.onmessage = (e: MessageEvent<FromSam>) => {
    const m = e.data;
    switch (m.type) {
      case 'loadProgress':
        setRoto({ files: { ...useRoto.getState().files, [m.file]: { loaded: m.loaded, total: m.total } } });
        break;
      case 'loaded':
        setRoto({ model: 'ready', provider: m.provider, variant: m.variant, error: null });
        toast(`SAM 2 ready on ${m.provider === 'webgpu' ? 'WebGPU' : 'CPU (WASM)'} · ${(m.ms / 1000).toFixed(1)} s${m.cached ? ' (cached)' : ''}`, 'success');
        for (const w of loadWaiters) w(true);
        loadWaiters = [];
        break;
      case 'loadError':
        setRoto({ model: 'error', error: m.message });
        toast(`Could not load SAM 2: ${m.message}`, 'error', 6000);
        for (const w of loadWaiters) w(false);
        loadWaiters = [];
        break;
      default: {
        const h = jobs.get(m.jobId);
        h?.(m);
        if (m.type === 'done') jobs.delete(m.jobId);
      }
    }
  };
  worker.onerror = (e) => {
    e.preventDefault?.();
    setRoto({ model: 'error', error: e.message || 'SAM worker crashed', busy: false });
    for (const [jobId, h] of jobs) h({ type: 'done', jobId, status: 'error', message: 'SAM worker crashed' });
    jobs.clear();
    worker?.terminate();
    worker = null;
  };
  const port = connectAnalysisPort();
  worker.postMessage({ type: 'port', port } satisfies ToSam, [port]);
  return worker;
}

export function defaultVariant(): SamVariant {
  try {
    const v = localStorage.getItem(VARIANT_KEY) as SamVariant | null;
    if (v && v in SAM_VARIANTS) return v;
  } catch {
    /* storage unavailable */
  }
  return 'gpu' in navigator ? 'fp16' : 'int8';
}

export function loadSam(variant: SamVariant, local?: { encoder: ArrayBuffer; encoderData?: ArrayBuffer; decoder: ArrayBuffer; decoderData?: ArrayBuffer }): Promise<boolean> {
  const st = useRoto.getState();
  if (st.model === 'ready' && st.variant === variant && !local) return Promise.resolve(true);
  try {
    localStorage.setItem(VARIANT_KEY, variant);
  } catch {
    /* ignore */
  }
  setRoto({ model: 'loading', variant, files: {}, error: null });
  const w = ensureWorker();
  const transfer = local ? [local.encoder, local.decoder, ...(local.encoderData ? [local.encoderData] : []), ...(local.decoderData ? [local.decoderData] : [])] : [];
  w.postMessage({ type: 'load', variant, baseUrl: SAM_MODEL_BASE, local } satisfies ToSam, transfer);
  return new Promise((res) => loadWaiters.push(res));
}

let modelPrompted = false;

/** True when the model is ready; otherwise starts loading (or asks once) and returns false. */
function requireModel(): boolean {
  const st = useRoto.getState();
  if (st.model === 'ready') return true;
  if (st.model === 'loading') {
    toast('SAM 2 is still loading…', 'info');
    return false;
  }
  let remembered = false;
  try {
    remembered = !!localStorage.getItem(VARIANT_KEY);
  } catch {
    remembered = false;
  }
  if (remembered && st.model !== 'error') void loadSam(defaultVariant());
  else if (!modelPrompted || st.model === 'error') {
    modelPrompted = true;
    openDialog({ kind: 'samModel' });
  }
  return false;
}

// ── roto sessions ───────────────────────────────────────────────────────────

export function rotoEffectOf(layer: Layer, project = getApp().project): { fxId: string; info: MatteInfo } | null {
  for (const fx of layer.effects) {
    if (fx.type !== 'rotoBrush') continue;
    const id = fx.params.matte?.value as string;
    const info = id ? project.mattes?.[id] : undefined;
    if (info) return { fxId: fx.id, info };
  }
  return null;
}

/** Make sure the layer carries a Roto Brush effect with a segmentation; returns it. */
export function ensureRoto(compId: string, layerId: string): { fxId: string; info: MatteInfo } | null {
  const s = getApp();
  const f = findLayer(s.project, compId, layerId);
  if (!f) return null;
  if (!isTrackable(f.layer)) {
    toast('Roto Brush works on footage and precomp layers', 'error');
    return null;
  }
  const existing = rotoEffectOf(f.layer, s.project);
  if (existing) return existing;
  const { w, h } = layerSourceSize(s.project, f.comp, f.layer);
  const ms = matteSize(w, h);
  const id = uid('mt');
  const info: MatteInfo = { id, layerId, name: `${f.layer.name} Roto`, width: ms.w, height: ms.h, fps: exactFps(f.comp.frameRate), revs: {}, prompts: [] };
  const fx = createEffect('rotoBrush', { w, h }, f.layer.effects.map((e) => e.name));
  fx.params.matte = { value: id, keyframes: [] };
  doc((d) => {
    const l = d.comps[compId]?.layers.find((x) => x.id === layerId);
    if (!l) return;
    if (!d.mattes) d.mattes = {};
    d.mattes[id] = info as never;
    l.effects.push(fx as never);
  });
  setApp({ selLayers: [layerId], selEffect: fx.id });
  return { fxId: fx.id, info };
}

export const frameIndexAt = (layer: Layer, info: MatteInfo, compTime: number): number => Math.round(toLayerTime(layer, compTime) * info.fps);

/** Add a foreground (label 1) or background (0) prompt at layer-source pixel (x, y) on the current frame. */
export function addRotoPoint(compId: string, layerId: string, x: number, y: number, label: 0 | 1): void {
  if (!requireModel()) return;
  if (useRoto.getState().busy || getTracking().job) return;
  const r = ensureRoto(compId, layerId);
  if (!r) return;
  const s = getApp();
  const f = findLayer(s.project, compId, layerId)!;
  const info = s.project.mattes![r.info.id];
  const t = getTime(compId);
  const frame = frameIndexAt(f.layer, info, t);
  const { w: sw } = layerSourceSize(s.project, f.comp, f.layer);
  const k = info.width / sw;
  const prev = info.prompts.find((p) => p.frame === frame)?.points ?? [];
  const points: [number, number, number][] = [...prev, [x * k, y * k, label]];
  segmentFrame(compId, layerId, frame, t, points);
}

/** Remove the last prompt of the current frame (or all of them) and re-segment. */
export function undoRotoPoint(compId: string, layerId: string, all = false): void {
  const s = getApp();
  const f = findLayer(s.project, compId, layerId);
  const r = f ? rotoEffectOf(f.layer, s.project) : null;
  if (!f || !r) return;
  const t = getTime(compId);
  const frame = frameIndexAt(f.layer, r.info, t);
  const prev = r.info.prompts.find((p) => p.frame === frame)?.points ?? [];
  const points = all ? [] : prev.slice(0, -1);
  if (!points.some((p) => p[2] === 1)) {
    doc((d) => {
      const info = d.mattes?.[r.info.id];
      if (!info) return;
      delete info.revs[String(frame)];
      info.prompts = info.prompts.filter((p) => p.frame !== frame);
    });
    return;
  }
  if (!requireModel()) return;
  segmentFrame(compId, layerId, frame, t, points);
}

function segmentFrame(compId: string, layerId: string, frame: number, time: number, points: [number, number, number][]): void {
  const s = getApp();
  const f = findLayer(s.project, compId, layerId)!;
  const r = rotoEffectOf(f.layer, s.project)!;
  const ac = analysisComp(s.project, f.comp, f.layer);
  const jobId = `seg_${seq++}`;
  setRoto({ busy: true });
  jobs.set(jobId, (m) => {
    if (m.type === 'mask') {
      const rev = putMatte(r.info.id, m.w, m.h, m.data);
      doc((d) => {
        const info = d.mattes?.[r.info.id];
        if (!info) return;
        info.width = m.w;
        info.height = m.h;
        info.revs[String(frame)] = rev;
        info.prompts = [...info.prompts.filter((p) => p.frame !== frame), { frame, points }].sort((a, b) => a.frame - b.frame) as never;
      });
      setRoto({ last: { encodeMs: m.encodeMs, decodeMs: m.decodeMs, score: m.score } });
    } else if (m.type === 'done') {
      setRoto({ busy: false });
      if (m.status === 'error') toast(`Segmentation failed: ${m.message}`, 'error', 5000);
    }
  });
  ensureWorker().postMessage({
    type: 'segment', jobId, key: ac.key, comp: ac.comp, srcW: ac.w, srcH: ac.h, matteW: r.info.width, matteH: r.info.height,
    ref: { time, frame }, points, box: null,
  } satisfies ToSam);
}

/** Propagate the current frame's matte forward (1) or backward (−1) until a frame with user prompts or the layer end. */
export function propagateRoto(compId: string, layerId: string, dir: 1 | -1): void {
  if (!requireModel()) return;
  if (getTracking().job) return;
  const s = getApp();
  const f = findLayer(s.project, compId, layerId);
  const r = f ? rotoEffectOf(f.layer, s.project) : null;
  if (!f || !r) {
    toast('Paint foreground points with the Roto Brush tool (Alt+W) first', 'info');
    return;
  }
  const t = getTime(compId);
  const frame = frameIndexAt(f.layer, r.info, t);
  const seed = matteAtFrame(r.info, frame);
  if (!seed) {
    toast('The current frame has no matte — add foreground points here first', 'info');
    return;
  }
  const userFrames = new Set(r.info.prompts.filter((p) => p.frame !== frame).map((p) => p.frame));
  const refs: SamFrameRef[] = [];
  for (const tt of frameTimes(f.comp, f.layer, t, dir).slice(1)) {
    const fr = frameIndexAt(f.layer, r.info, tt);
    if (userFrames.has(fr)) break;
    refs.push({ time: tt, frame: fr });
  }
  if (!refs.length) {
    toast('Nothing to propagate in that direction', 'info');
    return;
  }
  const ac = analysisComp(s.project, f.comp, f.layer);
  const jobId = `prop_${seq++}`;
  beginTx();
  setTracking({
    job: { id: jobId, op: 'roto', compId, layerId, direction: dir, done: 0, total: refs.length, stage: 'Propagating', fraction: 0, samples: [{ t, c: 100 }], startedAt: performance.now() },
  });
  const seedPoints = r.info.prompts.find((p) => p.frame === frame)?.points ?? [];
  let lastMove = 0;
  jobs.set(jobId, (m) => {
    const j = getTracking().job;
    switch (m.type) {
      case 'mask': {
        const rev = putMatte(r.info.id, m.w, m.h, m.data);
        doc((d) => {
          const info = d.mattes?.[r.info.id];
          if (info) info.revs[String(m.ref.frame)] = rev;
        });
        if (j) setTracking({ job: { ...j, done: j.done + 1, fraction: (j.done + 1) / j.total, samples: [...j.samples, { t: m.ref.time, c: Math.max(0, Math.min(100, m.score * 100)) }] } });
        if (performance.now() - lastMove > 160) {
          lastMove = performance.now();
          setTime(compId, m.ref.time);
        }
        setRoto({ last: { encodeMs: m.encodeMs, decodeMs: m.decodeMs, score: m.score } });
        break;
      }
      case 'progress':
        if (j) setTracking({ job: { ...j, stage: m.stage } });
        break;
      case 'done':
        endTx();
        setTracking({ job: null });
        if (getTracking().job === null && j) setTime(compId, j.samples[j.samples.length - 1]?.t ?? t);
        if (m.status === 'error') toast(`Propagation failed: ${m.message}`, 'error', 5000);
        else if (m.status === 'stopped') toast(m.message ?? 'Propagation stopped', 'info');
        else if (m.status === 'complete') toast(`Propagated ${refs.length} frame${refs.length === 1 ? '' : 's'}`, 'success');
        break;
      default:
        break;
    }
  });
  const seedCopy = seed.alpha.slice();
  ensureWorker().postMessage({
    type: 'propagate', jobId, key: ac.key, comp: ac.comp, srcW: ac.w, srcH: ac.h, matteW: r.info.width, matteH: r.info.height,
    seed: seedCopy, seedRef: { time: t, frame }, frames: refs, points: seedPoints,
  } satisfies ToSam, [seedCopy.buffer]);
}

export function stopRoto(): void {
  const j = getTracking().job;
  if (j?.op === 'roto') worker?.postMessage({ type: 'cancel', jobId: j.id } satisfies ToSam);
}

// ── freeze / bake ───────────────────────────────────────────────────────────

/** Convert the segmentation into a native track matte: a duplicate layer carries the roto alpha. */
export function bakeRotoToTrackMatte(compId: string, layerId: string): void {
  const s = getApp();
  const f = findLayer(s.project, compId, layerId);
  const r = f ? rotoEffectOf(f.layer, s.project) : null;
  if (!f || !r || !Object.keys(r.info.revs).length) {
    toast('There is no roto matte to bake on this layer', 'error');
    return;
  }
  beginTx();
  try {
    const [dupId] = duplicateLayers(compId, [layerId]);
    doc((d) => {
      const c = d.comps[compId];
      const dup = c?.layers.find((l) => l.id === dupId);
      const orig = c?.layers.find((l) => l.id === layerId);
      if (!dup || !orig) return;
      dup.name = `${orig.name} · Roto Matte`;
      dup.effects = dup.effects.filter((e) => e.type === 'rotoBrush') as never;
      for (const e of dup.effects) e.params.output.value = 'final' as never;
      dup.trackers = undefined;
      dup.cameraTrack = undefined;
      dup.masks = [];
      dup.label = 10;
      orig.effects = orig.effects.filter((e) => e.type !== 'rotoBrush') as never;
    });
    setTrackMatte(compId, layerId, dupId, 'alpha');
  } finally {
    endTx();
  }
  setApp({ selLayers: [layerId] });
  toast('Roto frozen into a track matte', 'success');
}

/** Trace every matte frame into an animated Bézier mask path on the layer. */
export function bakeRotoToMasks(compId: string, layerId: string): void {
  const s = getApp();
  const f = findLayer(s.project, compId, layerId);
  const r = f ? rotoEffectOf(f.layer, s.project) : null;
  const frames = r ? Object.keys(r.info.revs).map(Number).sort((a, b) => a - b) : [];
  if (!f || !r || !frames.length) {
    toast('There is no roto matte to bake on this layer', 'error');
    return;
  }
  const { w: sw } = layerSourceSize(s.project, f.comp, f.layer);
  const k = sw / r.info.width;
  // vertex budget from the first frame's perimeter
  let n = 32;
  const contours = new Map<number, Pt[]>();
  for (const fr of frames) {
    const m = getMatte(r.info.id, r.info.revs[String(fr)]);
    if (!m) continue;
    const cs = traceContours(m.alpha, m.w, m.h, 128);
    if (!cs.length || Math.abs(polygonArea(cs[0])) < 16) continue;
    // clockwise (positive area in y-down space) so vertex order is consistent
    const c = polygonArea(cs[0]) < 0 ? cs[0].slice().reverse() : cs[0];
    contours.set(fr, c);
  }
  if (!contours.size) {
    toast('The mattes are empty — nothing to trace', 'error');
    return;
  }
  const first = contours.values().next().value as Pt[];
  let per = 0;
  for (let i = 0; i < first.length; i++) {
    const a = first[i], b = first[(i + 1) % first.length];
    per += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  n = Math.max(16, Math.min(72, Math.round((per * k) / 28)));
  const keys: Keyframe[] = [];
  let prev: Pt[] | null = null;
  for (const [fr, c] of contours) {
    let pts = resampleClosed(c, n).map(([x, y]) => [(x + 0.5) * k, (y + 0.5) * k] as Pt);
    if (prev) pts = alignToPrevious(prev, pts);
    else {
      // start at the top-most vertex for a stable first frame
      let top = 0;
      pts.forEach((p, i) => { if (p[1] < pts[top][1]) top = i; });
      pts = pts.map((_, i) => pts[(i + top) % n]);
    }
    prev = pts;
    const path: BezierPath = pointsToBezier(pts);
    const kf = makeKeyframe(fr / r.info.fps, path, false);
    kf.inType = 'linear';
    kf.outType = 'linear';
    keys.push(kf);
  }
  const mask = createMask(keys[0].v as BezierPath, f.layer.masks.length);
  mask.name = 'Roto Mask';
  mask.path = { value: keys[0].v as BezierPath, keyframes: keys as never };
  doc((d) => {
    const l = d.comps[compId]?.layers.find((x) => x.id === layerId);
    if (!l) return;
    l.masks.push(mask as never);
    for (const e of l.effects) if (e.type === 'rotoBrush') e.enabled = false;
  });
  setApp({ selLayers: [layerId], selMask: mask.id });
  toast(`Baked ${keys.length} frame${keys.length === 1 ? '' : 's'} into "Roto Mask" (${n} vertices)`, 'success');
}

export function clearRoto(compId: string, layerId: string): void {
  const s = getApp();
  const f = findLayer(s.project, compId, layerId);
  const r = f ? rotoEffectOf(f.layer, s.project) : null;
  if (!r) return;
  doc((d) => {
    const info = d.mattes?.[r.info.id];
    if (!info) return;
    info.revs = {};
    info.prompts = [];
  });
}
