// ─────────────────────────────────────────────────────────────────────────────
// Motion tracking: tracker documents, analysis jobs and applying results.
//
//  * Track Motion / Stabilize Motion — 1-point (position) or 2-point
//    (position + rotation + scale) feature trackers whose Feature Center,
//    Attach Point and Confidence are keyframed per frame on the tracked layer,
//    then baked into a target layer (or the layer's own anchor point when
//    stabilizing) as ordinary keyframes.
//  * Perspective corner pin — planar homography tracking of four corners,
//    applied as a keyframed Corner Pin effect on the target.
//  * 3D Camera Tracker — background analysis + solve stored on the layer;
//    "Create Camera" bakes an animated one-node camera, and track points can
//    spawn nulls / solids / text placed on the reconstructed scene.
// A whole tracking run is ONE undo step (transaction).
// ─────────────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import type { Draft } from 'immer';
import type { AnimProp, CameraTrack, Composition, Keyframe, Layer, Project, Tracker, TrackerKind, TrackPoint } from '../core/types';
import { beginTx, doc, endTx, getApp, setApp, toast } from './store';
import { getTime, setTime } from './time';
import { uid } from '../core/ids';
import { prop } from '../core/props';
import { FrameEval, isActiveAt, layerSourceSize, stretchFactor, toCompTime, toLayerTime } from '../core/evaluate';
import { keyframedValue } from '../anim/interpolate';
import { exactFps, frameDuration } from '../core/time';
import { createCameraLayer, createEffect, createNullLayer, createSolidLayer, createTextLayer } from '../core/factory';
import { addLayer, makeKeyframe, uniqueLayerName } from './actions';
import * as M from '../math/mat4';
import { analysisComp, cancelJob, newJobId, runJob } from '../cv/host';
import type { CameraSolution, FromCV } from '../cv/jobs';
import { mat3Mul, mat3T, mat3Vec, matToEulerXYZ, normalize3, cross3, dot3, symEig, type V3 } from '../cv/linalg';

// ── UI / job state ──────────────────────────────────────────────────────────

export type TrackOp = 'points' | 'planar' | 'camera' | 'roto';

export interface TrackJob {
  id: string;
  op: TrackOp;
  compId: string;
  layerId: string;
  trackerId?: string;
  direction: 1 | -1;
  done: number;
  total: number;
  stage: string;
  fraction: number;
  /** comp times analysed so far, with confidence 0..100 (timeline strip) */
  samples: { t: number; c: number }[];
  startedAt: number;
}

export interface TrackingState {
  job: TrackJob | null;
  /** tracker shown in the Tracker panel and on the viewer */
  active: { compId: string; layerId: string; trackerId: string } | null;
  activePoint: string | null;
  /** feature cloud of the frame being analysed (source pixels) */
  live: { layerId: string; time: number; pts: number[] } | null;
  /** selected / hovered 3D camera-track points */
  camSel: number[];
  camHover: number | null;
  /** show the camera-track points in the viewer */
  showTrackPoints: boolean;
  /** Tracker panel operation tab */
  mode: 'motion' | 'camera' | 'roto';
  lastResult: string | null;
}

export const useTracking = create<TrackingState>()(() => ({
  job: null, active: null, activePoint: null, live: null, camSel: [], camHover: null, showTrackPoints: true, mode: 'motion', lastResult: null,
}));
export const getTracking = () => useTracking.getState();
export const setTracking = (p: Partial<TrackingState>) => useTracking.setState(p);

// ── lookups ─────────────────────────────────────────────────────────────────

export function findLayer(project: Project, compId: string, layerId: string): { comp: Composition; layer: Layer } | null {
  const comp = project.comps[compId];
  const layer = comp?.layers.find((l) => l.id === layerId);
  return comp && layer ? { comp, layer } : null;
}

export function findTracker(project: Project, compId: string, layerId: string, trackerId: string): { comp: Composition; layer: Layer; tracker: Tracker } | null {
  const f = findLayer(project, compId, layerId);
  const tracker = f?.layer.trackers?.find((t) => t.id === trackerId);
  return f && tracker ? { ...f, tracker } : null;
}

export function activeTracker(): { comp: Composition; layer: Layer; tracker: Tracker } | null {
  const a = getTracking().active;
  return a ? findTracker(getApp().project, a.compId, a.layerId, a.trackerId) : null;
}

/** Layers whose source can be analysed (footage and precomps). */
export const isTrackable = (l: Layer): boolean => l.type === 'video' || l.type === 'image' || l.type === 'precomp';

const layerDraft = (d: Draft<Project>, compId: string, layerId: string): Draft<Layer> | undefined =>
  d.comps[compId]?.layers.find((l) => l.id === layerId);

const trackerDraft = (d: Draft<Project>, compId: string, layerId: string, trackerId: string): Draft<Tracker> | undefined =>
  layerDraft(d, compId, layerId)?.trackers?.find((t) => t.id === trackerId);

// ── tracker documents ───────────────────────────────────────────────────────

const KIND_NAMES: Record<TrackerKind, string> = { transform: 'Track Motion', stabilize: 'Stabilize', perspective: 'Perspective' };

function makePoint(name: string, x: number, y: number, fw: number, sw: number): TrackPoint {
  return {
    id: uid('tp'), name, enabled: true,
    featureCenter: prop([x, y]), featureSize: [fw, fw], searchOffset: [0, 0], searchSize: [sw, sw],
    confidence: prop(100), attachPoint: prop([x, y]), attachOffset: [0, 0],
  };
}

/** Create a tracker on a layer and make it the active tracker. */
export function newTracker(compId: string, layerId: string, kind: TrackerKind, opts: { rotation?: boolean; scale?: boolean } = {}): string | null {
  const s = getApp();
  const f = findLayer(s.project, compId, layerId);
  if (!f) return null;
  if (!isTrackable(f.layer)) {
    toast('Tracking needs a footage or precomp layer', 'error');
    return null;
  }
  const { w, h } = layerSourceSize(s.project, f.comp, f.layer);
  const fw = Math.round(Math.max(24, Math.min(w, h) * 0.05));
  const sw = Math.round(fw * 2.6);
  const id = uid('trk');
  const count = (f.layer.trackers?.length ?? 0) + 1;
  const tracker: Tracker = {
    id, name: `Tracker ${count}`, kind,
    position: true, rotation: !!opts.rotation, scale: !!opts.scale, points: [],
    targetLayerId: null, applyDims: 'xy',
    options: {
      channel: 'luminance', blur: 0, adaptFeature: false, predictMotion: true, subpixel: true,
      confidenceThreshold: 80, onLowConfidence: 'adapt',
    },
  };
  if (kind === 'perspective') {
    const qx = w * 0.18, qy = h * 0.18;
    const corners: [string, number, number][] = [
      ['Track Point 1', w / 2 - qx, h / 2 - qy], ['Track Point 2', w / 2 + qx, h / 2 - qy],
      ['Track Point 3', w / 2 + qx, h / 2 + qy], ['Track Point 4', w / 2 - qx, h / 2 + qy],
    ];
    tracker.points = corners.map(([n, x, y]) => makePoint(n, x, y, fw, sw));
    tracker.position = false;
  } else {
    tracker.points = [makePoint('Track Point 1', w / 2, h / 2, fw, sw)];
    if (tracker.rotation || tracker.scale) tracker.points.push(makePoint('Track Point 2', w / 2 + w * 0.22, h / 2, fw, sw));
  }
  doc((d) => {
    const l = layerDraft(d, compId, layerId);
    if (!l) return;
    if (!l.trackers) l.trackers = [];
    l.trackers.push(tracker as never);
  });
  setTracking({ active: { compId, layerId, trackerId: id }, activePoint: tracker.points[0].id });
  setApp({ selLayers: [layerId] });
  setApp((st) => ({ expanded: { ...st.expanded, [layerId]: true, [`${layerId}|trackers`]: true, [`${layerId}|trackers.${id}`]: true } }));
  return id;
}

export function trackerKindName(k: TrackerKind): string {
  return KIND_NAMES[k];
}

export function setTrackerFields(compId: string, layerId: string, trackerId: string, fields: Partial<Pick<Tracker, 'name' | 'kind' | 'position' | 'rotation' | 'scale' | 'targetLayerId' | 'applyDims'>>): void {
  doc((d) => {
    const t = trackerDraft(d, compId, layerId, trackerId);
    if (!t) return;
    Object.assign(t, fields);
    if (t.kind !== 'perspective') {
      const need = t.rotation || t.scale ? 2 : 1;
      if (t.points.length < need) {
        const p0 = t.points[0];
        const c = p0.featureCenter.value as number[];
        const np = makePoint('Track Point 2', c[0] + p0.featureSize[0] * 4, c[1], p0.featureSize[0], p0.searchSize[0]);
        t.points.push(np as never);
      } else if (t.points.length > need) t.points.splice(need);
    }
  });
}

export function setTrackerOptions(compId: string, layerId: string, trackerId: string, fields: Partial<Tracker['options']>): void {
  doc((d) => {
    const t = trackerDraft(d, compId, layerId, trackerId);
    if (t) Object.assign(t.options, fields);
  }, { coalesce: `trkopt:${trackerId}` });
}

export function deleteTracker(compId: string, layerId: string, trackerId: string): void {
  doc((d) => {
    const l = layerDraft(d, compId, layerId);
    if (!l?.trackers) return;
    l.trackers = l.trackers.filter((t) => t.id !== trackerId) as never;
  });
  const a = getTracking().active;
  if (a?.trackerId === trackerId) setTracking({ active: null, activePoint: null });
}

/** Remove all tracking keyframes (keeps the current boxes). */
export function resetTracker(compId: string, layerId: string, trackerId: string): void {
  const t = getTime(compId);
  doc((d) => {
    const l = layerDraft(d, compId, layerId);
    const tr = l?.trackers?.find((x) => x.id === trackerId);
    if (!l || !tr) return;
    const lt = toLayerTime(l as Layer, t);
    for (const p of tr.points) {
      for (const key of ['featureCenter', 'attachPoint', 'confidence'] as const) {
        const ap = p[key] as Draft<AnimProp>;
        if (ap.keyframes.length) ap.value = keyframedValue(ap as AnimProp, lt, false) as never;
        ap.keyframes = [];
      }
    }
  });
}

const valueAt = (p: AnimProp<number[]>, lt: number): number[] => (p.keyframes.length ? (keyframedValue(p as AnimProp, lt, true) as number[]) : p.value);

/** Feature centre / boxes of a track point at a comp time. */
export function pointGeometryAt(layer: Layer, p: TrackPoint, compTime: number): { center: number[]; attach: number[]; confidence: number } {
  const lt = toLayerTime(layer, compTime);
  return {
    center: valueAt(p.featureCenter, lt),
    attach: valueAt(p.attachPoint, lt),
    confidence: p.confidence.keyframes.length ? (keyframedValue(p.confidence as AnimProp, lt, false) as number) : p.confidence.value,
  };
}

/** Write a value to an animated-or-static property at layer time `lt`. */
function writeAt(ap: Draft<AnimProp>, lt: number, v: number[] | number, tol: number): void {
  if (!ap.keyframes.length) {
    ap.value = v as never;
    return;
  }
  const k = ap.keyframes.find((x) => Math.abs(x.t - lt) < tol);
  if (k) k.v = v as never;
  else {
    ap.keyframes.push(linearKey(lt, v) as never);
    ap.keyframes.sort((a, b) => a.t - b.t);
  }
}

function linearKey(t: number, v: number[] | number): Keyframe {
  const k = makeKeyframe(t, v, Array.isArray(v));
  k.inType = 'linear';
  k.outType = 'linear';
  if (Array.isArray(v)) k.spatial = 'linear';
  return k;
}

/** Interactive edit of a track point (drag of the boxes in the viewer). */
export function editTrackPoint(
  compId: string, layerId: string, trackerId: string, pointId: string,
  e: { center?: number[]; featureSize?: number[]; searchOffset?: number[]; searchSize?: number[]; attach?: number[] },
): void {
  const t = getTime(compId);
  const comp = getApp().project.comps[compId];
  const tol = comp ? frameDuration(comp.frameRate) / 2 : 1 / 60;
  doc((d) => {
    const l = layerDraft(d, compId, layerId);
    const tr = l?.trackers?.find((x) => x.id === trackerId);
    const p = tr?.points.find((x) => x.id === pointId);
    if (!l || !p) return;
    const lt = toLayerTime(l as Layer, t);
    if (e.featureSize) p.featureSize = e.featureSize.map((v) => Math.max(4, v));
    if (e.searchSize) p.searchSize = e.searchSize.map((v, i) => Math.max(v, (p.featureSize[i] ?? 4) + 2));
    if (e.searchOffset) p.searchOffset = e.searchOffset;
    if (e.center) {
      writeAt(p.featureCenter as Draft<AnimProp>, lt, e.center, tol);
      writeAt(p.attachPoint as Draft<AnimProp>, lt, [e.center[0] + p.attachOffset[0], e.center[1] + p.attachOffset[1]], tol);
    }
    if (e.attach) {
      const c = valueAt(p.featureCenter as AnimProp<number[]>, lt);
      p.attachOffset = [e.attach[0] - c[0], e.attach[1] - c[1]];
      writeAt(p.attachPoint as Draft<AnimProp>, lt, e.attach, tol);
    }
  }, { coalesce: `tp:${pointId}` });
}

// ── frame ranges ────────────────────────────────────────────────────────────

/** Comp frame times from `start` (snapped) toward the layer's in or out point. */
export function frameTimes(comp: Composition, layer: Layer, start: number, dir: 1 | -1, maxFrames = Infinity): number[] {
  const fps = exactFps(comp.frameRate);
  const fd = 1 / fps;
  const lo = Math.max(0, Math.min(layer.inPoint, layer.outPoint));
  const hi = Math.min(comp.duration, Math.max(layer.inPoint, layer.outPoint)) - fd * 0.5;
  let f = Math.round(start * fps);
  const out: number[] = [];
  while (out.length <= maxFrames) {
    const t = f / fps;
    if (t < lo - 1e-6 || t > hi + 1e-6) break;
    out.push(t);
    f += dir;
  }
  return out;
}

// ── running point / planar trackers ─────────────────────────────────────────

/** Track the active tracker forward/backward from the CTI (`oneFrame` = a single step). */
export function trackActive(dir: 1 | -1, oneFrame = false): void {
  const a = getTracking().active;
  if (!a) {
    toast('Create a tracker first (Track Motion, Stabilize or Perspective)', 'info');
    return;
  }
  if (getTracking().job) return;
  const s = getApp();
  const f = findTracker(s.project, a.compId, a.layerId, a.trackerId);
  if (!f) return;
  const { comp, layer, tracker } = f;
  const t0 = getTime(comp.id);
  if (!isActiveAt(layer, t0)) {
    toast('Move the time indicator inside the layer to start tracking', 'error');
    return;
  }
  const times = frameTimes(comp, layer, t0, dir, oneFrame ? 1 : Infinity);
  if (times.length < 2) {
    toast(dir > 0 ? 'Already at the last frame of the layer' : 'Already at the first frame of the layer', 'info');
    return;
  }
  const ac = analysisComp(s.project, comp, layer);
  const jobId = newJobId('trk');
  const lt0 = toLayerTime(layer, times[0]);
  const tol = frameDuration(comp.frameRate) / 2;
  beginTx();
  // keyframe the starting state so the track has an anchor frame
  doc((d) => {
    const tr = trackerDraft(d, comp.id, layer.id, tracker.id);
    if (!tr) return;
    for (const p of tr.points) {
      const c = valueAt(p.featureCenter as AnimProp<number[]>, lt0);
      for (const [key, v] of [['featureCenter', c], ['attachPoint', [c[0] + p.attachOffset[0], c[1] + p.attachOffset[1]]], ['confidence', 100]] as const) {
        const ap = p[key] as Draft<AnimProp>;
        if (!ap.keyframes.length) {
          ap.keyframes.push(linearKey(lt0, v as number[] | number) as never);
        } else writeAt(ap, lt0, v as number[] | number, tol);
      }
    }
  });
  const job: TrackJob = {
    id: jobId, op: tracker.kind === 'perspective' ? 'planar' : 'points', compId: comp.id, layerId: layer.id, trackerId: tracker.id,
    direction: dir, done: 0, total: times.length - 1, stage: 'Tracking', fraction: 0, samples: [{ t: times[0], c: 100 }], startedAt: performance.now(),
  };
  setTracking({ job, live: null });
  const finish = (status: string, message?: string) => {
    endTx();
    const j = getTracking().job;
    setTracking({ job: null, live: null, lastResult: message ?? null });
    if (status === 'error') toast(`Tracking failed: ${message}`, 'error', 5000);
    else if (status === 'stopped') toast(message ?? 'Tracking stopped', 'info');
    else if (status === 'complete' && j && j.total > 1) toast(`Tracked ${j.done} frame${j.done === 1 ? '' : 's'}`, 'success');
  };
  const onMessage = (m: FromCV) => {
    switch (m.type) {
      case 'pointSample':
        writePointSample(comp.id, layer.id, tracker.id, m.time, m.points, tol);
        bumpJob(m.time, Math.min(...m.points.map((p) => p.confidence)));
        break;
      case 'planarSample':
        writePlanarSample(comp.id, layer.id, tracker.id, m.time, m.quad, m.confidence, tol);
        setTracking({ live: { layerId: layer.id, time: m.time, pts: m.features } });
        bumpJob(m.time, m.confidence);
        break;
      case 'progress':
        break;
      case 'done':
        finish(m.status, m.message);
        break;
      default:
        break;
    }
  };
  let lastMove = 0;
  const bumpJob = (t: number, c: number) => {
    const j = getTracking().job;
    if (!j || j.id !== jobId) return;
    setTracking({ job: { ...j, done: j.done + 1, fraction: (j.done + 1) / j.total, samples: [...j.samples, { t, c }] } });
    // follow the track with the CTI, throttled so viewer renders don't starve the analysis renders
    const now = performance.now();
    if (now - lastMove > 160 || j.done + 1 >= j.total) {
      lastMove = now;
      setTime(comp.id, t);
    }
  };
  if (tracker.kind === 'perspective') {
    const quad = tracker.points.flatMap((p) => valueAt(p.featureCenter, lt0));
    runJob({
      type: 'trackPlanar', jobId, key: ac.key, comp: ac.comp, times, srcW: ac.w, srcH: ac.h,
      channel: tracker.options.channel, blur: tracker.options.blur, quad,
    }, { onMessage });
  } else {
    runJob({
      type: 'trackPoints', jobId, key: ac.key, comp: ac.comp, times, srcW: ac.w, srcH: ac.h,
      channel: tracker.options.channel, blur: tracker.options.blur,
      points: tracker.points.filter((p) => p.enabled).map((p) => {
        const c = valueAt(p.featureCenter, lt0);
        return {
          id: p.id, x: c[0], y: c[1], featureW: p.featureSize[0], featureH: p.featureSize[1],
          searchOffX: p.searchOffset[0], searchOffY: p.searchOffset[1], searchW: p.searchSize[0], searchH: p.searchSize[1],
        };
      }),
      adaptFeature: tracker.options.adaptFeature, predictMotion: tracker.options.predictMotion, subpixel: tracker.options.subpixel,
      confidenceThreshold: tracker.options.confidenceThreshold, onLowConfidence: tracker.options.onLowConfidence,
    }, { onMessage });
  }
}

export function stopTracking(): void {
  const j = getTracking().job;
  if (!j) return;
  if (j.op === 'roto') {
    void import('./roto').then((m) => m.stopRoto());
    return;
  }
  cancelJob(j.id);
}

function writePointSample(compId: string, layerId: string, trackerId: string, time: number, pts: { id: string; x: number; y: number; confidence: number; stopped: boolean }[], tol: number): void {
  doc((d) => {
    const l = layerDraft(d, compId, layerId);
    const tr = l?.trackers?.find((x) => x.id === trackerId);
    if (!l || !tr) return;
    const lt = toLayerTime(l as Layer, time);
    for (const s of pts) {
      if (s.stopped) continue;
      const p = tr.points.find((x) => x.id === s.id);
      if (!p) continue;
      writeKey(p.featureCenter as Draft<AnimProp>, lt, [s.x, s.y], tol);
      writeKey(p.attachPoint as Draft<AnimProp>, lt, [s.x + p.attachOffset[0], s.y + p.attachOffset[1]], tol);
      writeKey(p.confidence as Draft<AnimProp>, lt, +s.confidence.toFixed(2), tol);
    }
  });
}

function writePlanarSample(compId: string, layerId: string, trackerId: string, time: number, quad: number[], confidence: number, tol: number): void {
  doc((d) => {
    const l = layerDraft(d, compId, layerId);
    const tr = l?.trackers?.find((x) => x.id === trackerId);
    if (!l || !tr) return;
    const lt = toLayerTime(l as Layer, time);
    tr.points.forEach((p, i) => {
      if (i >= 4) return;
      const v = [quad[i * 2], quad[i * 2 + 1]];
      writeKey(p.featureCenter as Draft<AnimProp>, lt, v, tol);
      writeKey(p.attachPoint as Draft<AnimProp>, lt, [v[0] + p.attachOffset[0], v[1] + p.attachOffset[1]], tol);
      writeKey(p.confidence as Draft<AnimProp>, lt, +confidence.toFixed(2), tol);
    });
  });
}

function writeKey(ap: Draft<AnimProp>, lt: number, v: number[] | number, tol: number): void {
  const k = ap.keyframes.find((x) => Math.abs(x.t - lt) < tol);
  if (k) k.v = v as never;
  else {
    ap.keyframes.push(linearKey(lt, v) as never);
    ap.keyframes.sort((a, b) => a.t - b.t);
  }
}

// ── applying motion ─────────────────────────────────────────────────────────

/** Union of keyframe times (layer time) across the tracker's feature centres. */
function trackTimes(tracker: Tracker): number[] {
  const set = new Set<number>();
  for (const p of tracker.points) for (const k of p.featureCenter.keyframes) set.add(+k.t.toFixed(6));
  return [...set].sort((a, b) => a - b);
}

/** Apply the active tracker's result (Track Motion → target, Stabilize → self, Perspective → corner pin). */
export function applyTracker(compId: string, layerId: string, trackerId: string): void {
  const s = getApp();
  const f = findTracker(s.project, compId, layerId, trackerId);
  if (!f) return;
  const { comp, layer, tracker } = f;
  const times = trackTimes(tracker);
  if (times.length < 2) {
    toast('Track the feature first — there are no tracking keyframes to apply', 'error');
    return;
  }
  if (tracker.kind === 'stabilize') return applyStabilize(comp, layer, tracker, times);
  let targetId = tracker.targetLayerId && comp.layers.some((l) => l.id === tracker.targetLayerId) ? tracker.targetLayerId : null;
  beginTx();
  try {
    if (!targetId) {
      const n = createNullLayer(comp, `${layer.name} Track`);
      n.name = uniqueLayerName(comp, n.name);
      n.inPoint = layer.inPoint;
      n.outPoint = layer.outPoint;
      addLayer(comp.id, n, { index: Math.max(0, comp.layers.indexOf(layer)), select: false });
      targetId = n.id;
      doc((d) => {
        const tr = trackerDraft(d, comp.id, layer.id, tracker.id);
        if (tr) tr.targetLayerId = targetId;
      });
    }
    if (tracker.kind === 'perspective') applyCornerPin(comp.id, layer.id, tracker.id, targetId, times);
    else applyTransform(comp.id, layer.id, tracker.id, targetId, times);
  } finally {
    endTx();
  }
  setApp({ selLayers: [targetId] });
  toast(`Applied ${tracker.name} to ${getApp().project.comps[comp.id]?.layers.find((l) => l.id === targetId)?.name ?? 'target'}`, 'success');
}

const unwrapAngle = (a: number, ref: number) => a + 360 * Math.round((ref - a) / 360);

function applyTransform(compId: string, layerId: string, trackerId: string, targetId: string, times: number[]): void {
  const project = getApp().project;
  const f = findTracker(project, compId, layerId, trackerId)!;
  const { comp, layer, tracker } = f;
  const target = comp.layers.find((l) => l.id === targetId)!;
  const p1 = tracker.points[0], p2 = tracker.points[1];
  const useRot = tracker.rotation && !!p2, useScale = tracker.scale && !!p2;
  const fe0 = new FrameEval(project, comp, toCompTime(layer, times[0]));
  const angleAt = (lt: number) => {
    const q1 = valueAt(p1.featureCenter, lt), q2 = valueAt(p2.featureCenter, lt);
    return (Math.atan2(q2[1] - q1[1], q2[0] - q1[0]) * 180) / Math.PI;
  };
  const distAt = (lt: number) => {
    const q1 = valueAt(p1.featureCenter, lt), q2 = valueAt(p2.featureCenter, lt);
    return Math.hypot(q2[0] - q1[0], q2[1] - q1[1]);
  };
  const ang0 = p2 ? angleAt(times[0]) : 0, dist0 = p2 ? distAt(times[0]) : 1;
  const tv0 = fe0.transformValues(target);
  const tol = frameDuration(comp.frameRate) / 2;
  doc((d) => {
    const tl = layerDraft(d, compId, targetId);
    if (!tl) return;
    const pos = tl.transform.position as Draft<AnimProp>;
    const rot = tl.transform.rotation as Draft<AnimProp>;
    const scl = tl.transform.scale as Draft<AnimProp>;
    if (tracker.position) pos.keyframes = [];
    if (useRot) rot.keyframes = [];
    if (useScale) scl.keyframes = [];
    let prevAng = 0;
    for (const lt of times) {
      const tc = toCompTime(layer, lt);
      const fe = new FrameEval(project, comp, tc);
      const tlt = toLayerTime(target, tc);
      if (tracker.position) {
        const attach = valueAt(p1.attachPoint, lt);
        let cp = fe.toComp(layer, attach);
        const parent = fe.layer(target.parentId);
        if (parent) {
          const inv = M.invert(fe.worldMatrix(parent));
          if (inv) cp = M.transformPoint(inv, [cp[0], cp[1], 0]).slice(0, 2);
        }
        const cur = (target.transform.position.keyframes.length ? fe.transformValues(target).position : tv0.position).slice();
        const v = [
          tracker.applyDims !== 'y' ? cp[0] : cur[0],
          tracker.applyDims !== 'x' ? cp[1] : cur[1],
          cur[2] ?? 0,
        ];
        writeKey(pos, tlt, v, tol);
      }
      if (useRot) {
        const a = unwrapAngle(angleAt(lt) - ang0, prevAng);
        prevAng = a;
        writeKey(rot, tlt, tv0.rotation + a, tol);
      }
      if (useScale) {
        const k = distAt(lt) / Math.max(1e-6, dist0);
        writeKey(scl, tlt, tv0.scale.map((v, i) => (i < 2 ? v * k : v)), tol);
      }
    }
  });
}

function applyStabilize(comp: Composition, layer: Layer, tracker: Tracker, times: number[]): void {
  const project = getApp().project;
  const p1 = tracker.points[0], p2 = tracker.points[1];
  const useRot = tracker.rotation && !!p2, useScale = tracker.scale && !!p2;
  const fe0 = new FrameEval(project, comp, toCompTime(layer, times[0]));
  const tv0 = fe0.transformValues(layer);
  const angleAt = (lt: number) => {
    const q1 = valueAt(p1.featureCenter, lt), q2 = valueAt(p2.featureCenter, lt);
    return (Math.atan2(q2[1] - q1[1], q2[0] - q1[0]) * 180) / Math.PI;
  };
  const distAt = (lt: number) => {
    const q1 = valueAt(p1.featureCenter, lt), q2 = valueAt(p2.featureCenter, lt);
    return Math.hypot(q2[0] - q1[0], q2[1] - q1[1]);
  };
  const ang0 = p2 ? angleAt(times[0]) : 0, dist0 = p2 ? distAt(times[0]) : 1;
  const tol = frameDuration(comp.frameRate) / 2;
  // the attach point at the first frame stays where it currently appears in the comp
  const attach0 = valueAt(p1.attachPoint, times[0]);
  const anchorScreen = fe0.toComp(layer, attach0);
  doc((d) => {
    const l = layerDraft(d, comp.id, layer.id);
    if (!l) return;
    const anc = l.transform.anchor as Draft<AnimProp>;
    const pos = l.transform.position as Draft<AnimProp>;
    anc.keyframes = [];
    if (tracker.position) {
      pos.keyframes = [];
      pos.value = [anchorScreen[0], anchorScreen[1], (tv0.position[2] ?? 0)] as never;
    }
    if (useRot) l.transform.rotation.keyframes = [];
    if (useScale) l.transform.scale.keyframes = [];
    let prevAng = 0;
    for (const lt of times) {
      const attach = valueAt(p1.attachPoint, lt);
      const cur = tv0.anchor;
      writeKey(anc, lt, [
        tracker.applyDims !== 'y' ? attach[0] : cur[0],
        tracker.applyDims !== 'x' ? attach[1] : cur[1],
        cur[2] ?? 0,
      ], tol);
      if (useRot) {
        const a = unwrapAngle(angleAt(lt) - ang0, prevAng);
        prevAng = a;
        writeKey(l.transform.rotation as Draft<AnimProp>, lt, tv0.rotation - a, tol);
      }
      if (useScale) {
        const k = dist0 / Math.max(1e-6, distAt(lt));
        writeKey(l.transform.scale as Draft<AnimProp>, lt, tv0.scale.map((v, i) => (i < 2 ? v * k : v)), tol);
      }
    }
  });
  toast(`Stabilized ${layer.name} (${times.length} frames)`, 'success');
}

function applyCornerPin(compId: string, layerId: string, trackerId: string, targetId: string, times: number[]): void {
  const project = getApp().project;
  const f = findTracker(project, compId, layerId, trackerId)!;
  const { comp, layer, tracker } = f;
  const target = comp.layers.find((l) => l.id === targetId)!;
  const dims = layerSourceSize(project, comp, target);
  const tol = frameDuration(comp.frameRate) / 2;
  doc((d) => {
    const tl = layerDraft(d, compId, targetId);
    if (!tl) return;
    let fx = tl.effects.find((e) => e.type === 'cornerPin');
    if (!fx) {
      const created = createEffect('cornerPin', dims, tl.effects.map((e) => e.name));
      tl.effects.push(created as never);
      fx = tl.effects[tl.effects.length - 1];
    }
    const ids = ['ul', 'ur', 'lr', 'll'];
    for (const id of ids) (fx.params[id] as Draft<AnimProp>).keyframes = [];
    for (const lt of times) {
      const tc = toCompTime(layer, lt);
      const fe = new FrameEval(project, comp, tc);
      const inv = M.invert(fe.worldMatrix(target));
      const tlt = toLayerTime(target, tc);
      tracker.points.slice(0, 4).forEach((p, i) => {
        const cp = fe.toComp(layer, valueAt(p.attachPoint, lt));
        const lp = inv ? M.transformPoint(inv, [cp[0], cp[1], 0]) : [cp[0], cp[1]];
        writeKey(fx!.params[ids[i]] as Draft<AnimProp>, tlt, [lp[0], lp[1]], tol);
      });
    }
  });
}

// ── 3D camera tracker ───────────────────────────────────────────────────────

/** Analyse a footage layer and solve its camera (background job). */
export function trackCamera(compId: string, layerId: string, settings?: Partial<Pick<CameraTrack, 'shotType' | 'fov' | 'detail'>>): void {
  if (getTracking().job) return;
  const s = getApp();
  const f = findLayer(s.project, compId, layerId);
  if (!f) return;
  const { comp, layer } = f;
  if (!isTrackable(layer)) {
    toast('The 3D Camera Tracker needs a footage or precomp layer', 'error');
    return;
  }
  const prev = layer.cameraTrack;
  const cfg = { shotType: settings?.shotType ?? prev?.shotType ?? 'auto', fov: settings?.fov !== undefined ? settings.fov : prev?.fov ?? null, detail: settings?.detail ?? prev?.detail ?? 'medium' };
  const times = frameTimes(comp, layer, Math.max(layer.inPoint, 0), 1);
  if (times.length < 8) {
    toast('The layer needs at least 8 frames for a camera solve', 'error');
    return;
  }
  const ac = analysisComp(s.project, comp, layer);
  const jobId = newJobId('cam');
  setTracking({
    job: { id: jobId, op: 'camera', compId, layerId, direction: 1, done: 0, total: times.length, stage: 'Analyzing footage', fraction: 0, samples: [], startedAt: performance.now() },
    live: null, camSel: [],
  });
  const fd = frameDuration(comp.frameRate);
  runJob({ type: 'trackCamera', jobId, key: ac.key, comp: ac.comp, times, srcW: ac.w, srcH: ac.h, ...cfg }, {
    onMessage: (m) => {
      const j = getTracking().job;
      switch (m.type) {
        case 'cameraFeatures':
          setTracking({ live: { layerId, time: m.time, pts: m.features } });
          if (j) setTracking({ job: { ...j, done: m.index + 1, samples: [...j.samples, { t: m.time, c: Math.min(100, (m.features.length / 2 / 3)) }] } });
          break;
        case 'progress':
          if (j) setTracking({ job: { ...j, stage: m.stage, fraction: m.fraction } });
          break;
        case 'cameraSolved':
          storeSolution(compId, layerId, m.solution, toLayerTime(layer, times[0]), fd / stretchFactor(layer), cfg);
          break;
        case 'done':
          setTracking({ job: null, live: null });
          if (m.status === 'error') toast(`Camera solve failed: ${m.message}`, 'error', 6000);
          else if (m.status === 'cancelled') toast('Camera analysis cancelled', 'info');
          break;
        default:
          break;
      }
    },
  });
}

function storeSolution(compId: string, layerId: string, sol: CameraSolution, t0: number, dt: number, cfg: { shotType: CameraTrack['shotType']; fov: number | null; detail: CameraTrack['detail'] }): void {
  const ct: CameraTrack = {
    id: uid('ct'), ...cfg, solved: true,
    width: sol.width, height: sol.height, sourceScale: sol.sourceScale, mode: sol.mode, f: sol.f,
    t0, dt, frames: sol.frames, frameError: sol.frameError, points: sol.points, rms: sol.rms, ground: null, sceneScale: 1,
  };
  doc((d) => {
    const l = layerDraft(d, compId, layerId);
    if (l) l.cameraTrack = ct as never;
  });
  const hfov = (2 * Math.atan(sol.width / 2 / sol.f) * 180) / Math.PI;
  toast(`Camera solved · ${sol.points.length} track points · error ${sol.rms.toFixed(2)} px · ${hfov.toFixed(1)}° FOV${sol.mode === 'tripod' ? ' · tripod' : ''}`, 'success', 6000);
  setTracking({ lastResult: `Solved ${sol.frames.length} frames` });
}

export function clearCameraTrack(compId: string, layerId: string): void {
  doc((d) => {
    const l = layerDraft(d, compId, layerId);
    if (l) l.cameraTrack = null;
  });
  setTracking({ camSel: [] });
}

export function setCameraTrackFields(compId: string, layerId: string, fields: Partial<Pick<CameraTrack, 'shotType' | 'fov' | 'detail' | 'sceneScale'>>): void {
  doc((d) => {
    const l = layerDraft(d, compId, layerId);
    if (l?.cameraTrack) Object.assign(l.cameraTrack, fields);
  });
}

/**
 * Mapping from solver space to composition space. The reference (first) camera becomes the
 * default AE camera at [w/2, h/2, −zoom]; the scene is scaled so the median track-point depth
 * equals the zoom (track points then sit near z = 0 at 100% scale). With a ground plane, the
 * plane becomes horizontal (normal → −Y) with its origin at the comp centre.
 */
export interface SceneMap {
  zoom: number;
  toComp: (X: number[]) => V3;
  camera: (i: number, prevOrientation?: V3) => { position: V3; orientation: V3 };
  warning: string | null;
}

export function sceneMap(project: Project, comp: Composition, layer: Layer, ct: CameraTrack): SceneMap {
  const fe = new FrameEval(project, comp, toCompTime(layer, ct.t0));
  const W = fe.worldMatrix(layer);
  const sl = Math.hypot(W[0], W[1]);
  const { w: sw, h: sh } = layerSourceSize(project, comp, layer);
  const pc = M.transformPoint(W, [sw / 2, sh / 2, 0]);
  let warning: string | null = null;
  if (Math.abs(pc[0] - comp.width / 2) > 2 || Math.abs(pc[1] - comp.height / 2) > 2) warning = 'The tracked layer is not centred in the comp; the solved camera assumes a centred layer.';
  if (Math.abs(Math.atan2(W[1], W[0])) > 1e-3) warning = 'The tracked layer is rotated; reset its rotation for an exact camera match.';
  const zoom = ct.f * ct.sourceScale * sl;
  const R0 = ct.frames[0].R, t0 = ct.frames[0].t;
  const toY = (X: number[]): V3 => {
    const c = mat3Vec(R0, X);
    return [c[0] + t0[0], c[1] + t0[1], c[2] + t0[2]];
  };
  const depths = ct.points.map((p) => toY(p.X)[2]).filter((z) => z > 0).sort((a, b) => a - b);
  const med = depths.length ? depths[depths.length >> 1] : 1;
  const s = (zoom / med) * (ct.sceneScale || 1);
  let Q = Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
  let O: V3 = [0, 0, 0];
  let P: V3 = [comp.width / 2, comp.height / 2, -zoom];
  if (ct.ground && ct.mode === 'free') {
    const o = toY(ct.ground.origin);
    let n = normalize3(mat3Vec(R0, ct.ground.normal));
    // the "up" side of the plane is the side the reference camera is on (camera at Y-origin)
    if (dot3(n, [-o[0], -o[1], -o[2]]) < 0) n = [-n[0], -n[1], -n[2]];
    const yAxis: V3 = [-n[0], -n[1], -n[2]];
    let zAxis: V3 = [0, 0, 1];
    zAxis = normalize3([zAxis[0] - yAxis[0] * dot3(zAxis, yAxis), zAxis[1] - yAxis[1] * dot3(zAxis, yAxis), zAxis[2] - yAxis[2] * dot3(zAxis, yAxis)]);
    const xAxis = cross3(yAxis, zAxis);
    Q = Float64Array.of(...xAxis, ...yAxis, ...zAxis);
    O = o;
    P = [comp.width / 2, comp.height / 2, 0];
  }
  const toComp = (X: number[]): V3 => {
    const y = toY(X);
    const q = mat3Vec(Q, [y[0] - O[0], y[1] - O[1], y[2] - O[2]]);
    return [P[0] + s * q[0], P[1] + s * q[1], P[2] + s * q[2]];
  };
  const camera = (i: number, prev?: V3) => {
    const fr = ct.frames[i];
    const Rt = mat3T(fr.R);
    const c = mat3Vec(Rt, fr.t);
    const C: V3 = [-c[0], -c[1], -c[2]];
    const position = toComp(C);
    // camera → AE world rotation
    const Rae = mat3Mul(mat3Mul(Q, R0), Rt);
    const orientation = matToEulerXYZ(Rae, prev);
    return { position, orientation };
  };
  return { zoom, toComp, camera, warning };
}

const TRACKER_CAMERA = '3D Tracker Camera';

/** Create (or refresh) the animated camera for a solved layer. Returns the camera layer id. */
export function createTrackedCamera(compId: string, layerId: string): string | null {
  const s = getApp();
  const f = findLayer(s.project, compId, layerId);
  const ct = f?.layer.cameraTrack;
  if (!f || !ct?.solved) {
    toast('Analyze the footage with the 3D Camera Tracker first', 'error');
    return null;
  }
  const { comp, layer } = f;
  const map = sceneMap(s.project, comp, layer, ct);
  if (map.warning) toast(map.warning, 'info', 5000);
  let cam = comp.layers.find((l) => l.type === 'camera' && l.name === TRACKER_CAMERA && l.comment === layer.id);
  let id = cam?.id ?? null;
  if (!cam) {
    const c = createCameraLayer(comp, 50, TRACKER_CAMERA);
    c.comment = layer.id;
    c.camera!.kind = 'oneNode';
    c.label = 4;
    addLayer(comp.id, c, { index: 0, select: false });
    cam = c;
    id = c.id;
  }
  const camId = id!;
  doc((d) => {
    const cl = layerDraft(d, compId, camId);
    if (!cl || !cl.camera) return;
    cl.camera.kind = 'oneNode';
    cl.camera.zoom = { value: map.zoom, keyframes: [] } as never;
    cl.camera.focusDistance = { value: map.zoom, keyframes: [] } as never;
    const posKeys: Keyframe[] = [], oriKeys: Keyframe[] = [];
    let prev: V3 | undefined;
    for (let i = 0; i < ct.frames.length; i++) {
      const tc = toCompTime(layer, ct.t0 + i * ct.dt);
      const lt = toLayerTime(cl as Layer, tc);
      const { position, orientation } = map.camera(i, prev);
      prev = orientation;
      posKeys.push(linearKey(lt, position.map((v) => +v.toFixed(3))));
      oriKeys.push(linearKey(lt, orientation.map((v) => +v.toFixed(4))));
    }
    // orientation interpolates per component — never spatially
    for (const k of oriKeys) delete k.spatial;
    cl.transform.position = { value: posKeys[0].v as number[], keyframes: posKeys } as never;
    cl.transform.orientation = { value: oriKeys[0].v as number[], keyframes: oriKeys } as never;
    cl.transform.rotationX = { value: 0, keyframes: [] } as never;
    cl.transform.rotationY = { value: 0, keyframes: [] } as never;
    cl.transform.rotation = { value: 0, keyframes: [] } as never;
  });
  return camId;
}

/** Fit a plane through ≥ 3 points (PCA); returns centroid and unit normal. */
function fitPlane(pts: number[][]): { c: V3; n: V3 } {
  const c: V3 = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) c[k] += p[k] / pts.length;
  const C = new Float64Array(9);
  for (const p of pts) {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] += d[i] * d[j];
  }
  const { vectors } = symEig(C, 3);
  return { c, n: normalize3([vectors[0], vectors[3], vectors[6]]) };
}

/** Use the selected track points as the ground plane and origin. */
export function setGroundPlane(compId: string, layerId: string): void {
  const sel = getTracking().camSel;
  const f = findLayer(getApp().project, compId, layerId);
  const ct = f?.layer.cameraTrack;
  if (!f || !ct) return;
  if (ct.mode === 'tripod') {
    toast('Tripod solves have no depth — a ground plane cannot be set', 'error');
    return;
  }
  const pts = ct.points.filter((p) => sel.includes(p.id)).map((p) => p.X);
  if (pts.length < 3) {
    toast('Select at least 3 track points to define the ground plane', 'error');
    return;
  }
  const { c, n } = fitPlane(pts);
  beginTx();
  doc((d) => {
    const l = layerDraft(d, compId, layerId);
    if (l?.cameraTrack) l.cameraTrack.ground = { origin: [...c], normal: [...n] } as never;
  });
  const hasCam = getApp().project.comps[compId]?.layers.some((l) => l.type === 'camera' && l.name === TRACKER_CAMERA && l.comment === layerId);
  if (hasCam) createTrackedCamera(compId, layerId);
  endTx();
  toast('Ground plane and origin set', 'success');
}

export type SceneLayerKind = 'null' | 'solid' | 'text' | 'shadowCatcher';

/** Create a 3D layer (and the tracked camera) at the selected track points. */
export function createAtTrackPoints(compId: string, layerId: string, kind: SceneLayerKind, perPoint = false): void {
  const s = getApp();
  const f = findLayer(s.project, compId, layerId);
  const ct = f?.layer.cameraTrack;
  if (!f || !ct?.solved) return;
  const sel = getTracking().camSel;
  const chosen = ct.points.filter((p) => sel.includes(p.id));
  if (!chosen.length) {
    toast('Select one or more track points in the viewer first', 'error');
    return;
  }
  beginTx();
  try {
    const camId = createTrackedCamera(compId, layerId);
    const comp = getApp().project.comps[compId];
    const layer = comp.layers.find((l) => l.id === layerId)!;
    const map = sceneMap(getApp().project, comp, layer, getApp().project.comps[compId].layers.find((l) => l.id === layerId)!.cameraTrack!);
    const groups = perPoint ? chosen.map((p) => [p]) : [chosen];
    const camPos = (() => {
      const camLayer = comp.layers.find((l) => l.id === camId);
      const v = camLayer?.transform.position.keyframes[0]?.v ?? camLayer?.transform.position.value;
      return (v as number[] | undefined) ?? [comp.width / 2, comp.height / 2, -map.zoom];
    })();
    const created: string[] = [];
    groups.forEach((g, gi) => {
      const P = g.map((p) => map.toComp(p.X));
      const c: V3 = [0, 0, 0];
      for (const p of P) for (let k = 0; k < 3; k++) c[k] += p[k] / P.length;
      let orientation: V3 = [0, 0, 0];
      let size = 0;
      if (P.length >= 3) {
        let { n } = fitPlane(P);
        // layer z axis points away from the camera (we see the layer's front)
        if (dot3(n, [c[0] - camPos[0], c[1] - camPos[1], c[2] - camPos[2]]) < 0) n = [-n[0], -n[1], -n[2]];
        let xProj: V3 = [1 - n[0] * dot3([1, 0, 0], n), -n[1] * dot3([1, 0, 0], n), -n[2] * dot3([1, 0, 0], n)];
        if (Math.hypot(xProj[0], xProj[1], xProj[2]) < 1e-4) {
          xProj = [-n[0] * dot3([0, 1, 0], n), 1 - n[1] * dot3([0, 1, 0], n), -n[2] * dot3([0, 1, 0], n)];
        }
        const x = normalize3(xProj);
        const y = cross3(n, x);
        const R = Float64Array.of(x[0], y[0], n[0], x[1], y[1], n[1], x[2], y[2], n[2]);
        orientation = matToEulerXYZ(R);
        for (const p of P) size = Math.max(size, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
      }
      const label = groups.length > 1 ? ` ${gi + 1}` : '';
      let L: Layer;
      if (kind === 'null') L = createNullLayer(comp, `Track Null${label}`);
      else if (kind === 'text') {
        L = createTextLayer(comp, 'Text');
        L.name = `Track Text${label}`;
      } else {
        const side = Math.round(Math.max(200, size * 2.2 || 400));
        L = createSolidLayer(comp, kind === 'shadowCatcher' ? [0.5, 0.5, 0.5, 1] : [0.85, 0.35, 0.95, 1], kind === 'shadowCatcher' ? `Shadow Catcher${label}` : `Track Solid${label}`, side, side);
      }
      L.threeD = true;
      L.transform.position.value = [+c[0].toFixed(3), +c[1].toFixed(3), +c[2].toFixed(3)];
      L.transform.orientation.value = orientation.map((v) => +v.toFixed(4));
      if (kind === 'shadowCatcher') L.material.acceptsLights = true;
      addLayer(compId, L, { index: 1, select: false });
      created.push(L.id);
    });
    setApp({ selLayers: created });
    toast(`Created ${created.length} layer${created.length === 1 ? '' : 's'} and the tracked camera`, 'success');
  } finally {
    endTx();
  }
}

/** Project a camera-track point to comp pixels at the current time (for the viewer overlay). */
export function trackPointScreen(ct: CameraTrack, layer: Layer, fe: FrameEval, X: number[], compTime: number): { x: number; y: number; depth: number; visible: boolean; frame: number } | null {
  const lt = toLayerTime(layer, compTime);
  const i = Math.round((lt - ct.t0) / ct.dt);
  if (i < 0 || i >= ct.frames.length) return null;
  const fr = ct.frames[i];
  const c = mat3Vec(fr.R, X);
  const z = c[2] + fr.t[2];
  if (z <= 1e-6) return null;
  const u = ct.width / 2 + (ct.f * (c[0] + fr.t[0])) / z, v = ct.height / 2 + (ct.f * (c[1] + fr.t[1])) / z;
  const sp = fe.toComp(layer, [u * ct.sourceScale, v * ct.sourceScale]);
  return { x: sp[0], y: sp[1], depth: z, visible: true, frame: i };
}
