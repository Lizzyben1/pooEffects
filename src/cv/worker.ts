// ─────────────────────────────────────────────────────────────────────────────
// Tracking worker: runs the point tracker, the planar (corner-pin) tracker and
// the 3D camera tracker entirely off the main thread. Frames arrive from the
// render worker as transferred ArrayBuffers; results stream back per frame so
// the UI can write keyframes and draw progress while analysis continues.
// ─────────────────────────────────────────────────────────────────────────────

/// <reference lib="webworker" />

import type { CameraSolution, CVJob, FromCV, ToCV, TrackCameraJob, TrackPlanarJob, TrackPointsJob } from './jobs';
import { FrameClient, FrameSequence } from './frames';
import { PointTracker } from './pointTracker';
import { PlanarTracker } from './planar';
import { detectCorners } from './features';
import { trackFlow } from './klt';
import { fundamentalInliers } from './geometry3d';
import { solveCamera, isCancelled, type Track2D } from './sfm';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const client = new FrameClient();
const cancelled = new Set<string>();

const post = (m: FromCV) => ctx.postMessage(m);

ctx.onmessage = (e: MessageEvent<ToCV>) => {
  const m = e.data;
  switch (m.type) {
    case 'port':
      client.attach(m.port);
      break;
    case 'cancel':
      cancelled.add(m.jobId);
      break;
    case 'run':
      void run(m.job);
      break;
  }
};

async function run(job: CVJob): Promise<void> {
  client.register(job.key, job.comp);
  try {
    switch (job.type) {
      case 'trackPoints':
        await trackPoints(job);
        break;
      case 'trackPlanar':
        await trackPlanar(job);
        break;
      case 'trackCamera':
        await trackCamera(job);
        break;
    }
  } catch (e) {
    if (cancelled.has(job.jobId) || isCancelled(e)) post({ type: 'done', jobId: job.jobId, status: 'cancelled' });
    else post({ type: 'done', jobId: job.jobId, status: 'error', message: (e as Error).message ?? String(e) });
  } finally {
    cancelled.delete(job.jobId);
    client.release(job.key);
  }
}

/** Analysis scale: full resolution up to `maxSide` pixels on the long edge. */
const scaleFor = (w: number, h: number, maxSide: number) => Math.min(1, maxSide / Math.max(w, h));

// ── point tracking ──────────────────────────────────────────────────────────

async function trackPoints(job: TrackPointsJob): Promise<void> {
  const scale = scaleFor(job.srcW, job.srcH, 2048);
  const maxFeature = Math.max(...job.points.map((p) => Math.max(p.featureW, p.featureH, p.searchW, p.searchH))) * scale;
  const levels = Math.max(2, Math.min(6, Math.ceil(Math.log2(Math.max(8, maxFeature) / 6))));
  const seq = new FrameSequence(client, job.key, job.times, scale, job.channel, job.blur, levels);
  const first = await seq.get(0);
  const s = first.raw.width / job.srcW;
  const tracker = new PointTracker(first.pyr, job.points.map((p) => ({
    id: p.id, x: p.x * s, y: p.y * s, featureW: p.featureW * s, featureH: p.featureH * s,
    searchOffX: p.searchOffX * s, searchOffY: p.searchOffY * s, searchW: p.searchW * s, searchH: p.searchH * s,
  })), {
    adaptFeature: job.adaptFeature, predictMotion: job.predictMotion, subpixel: job.subpixel,
    confidenceThreshold: job.confidenceThreshold, onLowConfidence: job.onLowConfidence,
  });
  for (let i = 1; i < seq.length; i++) {
    if (cancelled.has(job.jobId)) {
      post({ type: 'done', jobId: job.jobId, status: 'cancelled' });
      return;
    }
    const fr = await seq.get(i);
    const res = tracker.step(fr.pyr);
    post({
      type: 'pointSample', jobId: job.jobId, index: i, time: fr.time,
      points: res.map((r) => ({ id: r.id, x: r.x / s, y: r.y / s, confidence: r.confidence, stopped: r.stopped })),
    });
    post({ type: 'progress', jobId: job.jobId, stage: 'Tracking', fraction: i / (seq.length - 1) });
    if (!tracker.active) {
      post({ type: 'done', jobId: job.jobId, status: 'stopped', message: 'Confidence fell below the threshold' });
      return;
    }
  }
  post({ type: 'done', jobId: job.jobId, status: 'complete' });
}

// ── planar tracking ─────────────────────────────────────────────────────────

async function trackPlanar(job: TrackPlanarJob): Promise<void> {
  const scale = scaleFor(job.srcW, job.srcH, 1600);
  const seq = new FrameSequence(client, job.key, job.times, scale, job.channel, job.blur, 4);
  const first = await seq.get(0);
  const s = first.raw.width / job.srcW;
  const tracker = new PlanarTracker(first.pyr, job.quad.map((v) => v * s));
  if (tracker.featureCount < 8) throw new Error('Not enough detail inside the tracked surface — enlarge the corner-pin region');
  for (let i = 1; i < seq.length; i++) {
    if (cancelled.has(job.jobId)) {
      post({ type: 'done', jobId: job.jobId, status: 'cancelled' });
      return;
    }
    const fr = await seq.get(i);
    const r = tracker.step(fr.pyr);
    if (!r) {
      post({ type: 'done', jobId: job.jobId, status: 'stopped', message: `Surface lost at frame ${i}` });
      return;
    }
    post({
      type: 'planarSample', jobId: job.jobId, index: i, time: fr.time,
      quad: r.quad.map((v) => v / s), confidence: r.confidence * 100, features: r.features.map((v) => v / s),
    });
    post({ type: 'progress', jobId: job.jobId, stage: 'Tracking surface', fraction: i / (seq.length - 1) });
  }
  post({ type: 'done', jobId: job.jobId, status: 'complete' });
}

// ── 3D camera tracking ──────────────────────────────────────────────────────

const DETAIL = { low: { n: 280, side: 720 }, medium: { n: 450, side: 960 }, high: { n: 700, side: 1280 } };

async function trackCamera(job: TrackCameraJob): Promise<void> {
  const d = DETAIL[job.detail];
  const scale = scaleFor(job.srcW, job.srcH, d.side);
  const seq = new FrameSequence(client, job.key, job.times, scale, 'luminance', 0, 4);
  const F = seq.length;
  const tracks: Track2D[] = [];
  /** indices of tracks alive in the previous frame */
  let alive: number[] = [];
  let prev = await seq.get(0);
  const W = prev.raw.width, H = prev.raw.height;
  const s = W / job.srcW;
  const minDist = Math.max(6, Math.round(W / 48));
  const spawn = (fi: number, frame: typeof prev, count: number) => {
    const avoid: number[] = [];
    for (const ti of alive) avoid.push(tracks[ti].xy[fi * 2], tracks[ti].xy[fi * 2 + 1]);
    const cs = detectCorners(frame.pyr.levels[0], { maxCorners: count, minDistance: minDist, quality: 0.01, method: 'fast', fastThreshold: 14, border: 10, avoid });
    for (const c of cs) {
      const xy = new Float32Array(F * 2).fill(NaN);
      xy[fi * 2] = c.x;
      xy[fi * 2 + 1] = c.y;
      const p = (Math.round(c.y) * W + Math.round(c.x)) * 4;
      tracks.push({ id: tracks.length, xy, color: [frame.raw.pixels[p], frame.raw.pixels[p + 1], frame.raw.pixels[p + 2]] });
      alive.push(tracks.length - 1);
    }
  };
  spawn(0, prev, d.n);
  const emitFeatures = (fi: number, time: number) => {
    const feats: number[] = [];
    for (const ti of alive) feats.push(tracks[ti].xy[fi * 2] / s, tracks[ti].xy[fi * 2 + 1] / s);
    post({ type: 'cameraFeatures', jobId: job.jobId, index: fi, time, features: feats });
  };
  emitFeatures(0, prev.time);
  for (let fi = 1; fi < F; fi++) {
    if (cancelled.has(job.jobId)) {
      post({ type: 'done', jobId: job.jobId, status: 'cancelled' });
      return;
    }
    const cur = await seq.get(fi);
    const pts = new Float32Array(alive.length * 2);
    alive.forEach((ti, k) => {
      pts[k * 2] = tracks[ti].xy[(fi - 1) * 2];
      pts[k * 2 + 1] = tracks[ti].xy[(fi - 1) * 2 + 1];
    });
    const flow = trackFlow(prev.pyr, cur.pyr, pts, { radius: 7, fbThreshold: 0.7, maxResidual: 28 });
    // epipolar consistency prunes features sliding along edges or riding on moving objects
    const p1: number[] = [], p2: number[] = [];
    for (let k = 0; k < alive.length; k++) {
      p1.push(flow.status[k] ? pts[k * 2] : NaN, pts[k * 2 + 1]);
      p2.push(flow.status[k] ? flow.pts[k * 2] : NaN, flow.pts[k * 2 + 1]);
    }
    const inl = fundamentalInliers(p1, p2, 1.25);
    const next: number[] = [];
    alive.forEach((ti, k) => {
      if (!flow.status[k] || !inl[k]) return;
      tracks[ti].xy[fi * 2] = flow.pts[k * 2];
      tracks[ti].xy[fi * 2 + 1] = flow.pts[k * 2 + 1];
      next.push(ti);
    });
    alive = next;
    if (alive.length < d.n * 0.7) spawn(fi, cur, d.n - alive.length);
    if (fi % 2 === 0 || fi === F - 1) emitFeatures(fi, cur.time);
    post({ type: 'progress', jobId: job.jobId, stage: 'Analyzing footage', fraction: fi / (F - 1) });
    prev = cur;
  }
  // short tracks carry little structure and mostly noise
  const useful = tracks.filter((t) => {
    let n = 0;
    for (let f = 0; f < F; f++) if (Number.isFinite(t.xy[f * 2])) n++;
    return n >= Math.min(8, Math.max(3, F / 4));
  });
  const res = solveCamera(useful, {
    width: W, height: H, frameCount: F, shotType: job.shotType, fovDeg: job.fov,
    onProgress: (stage, fraction) => post({ type: 'progress', jobId: job.jobId, stage, fraction }),
    cancelled: () => cancelled.has(job.jobId),
  });
  const solution: CameraSolution = {
    width: W, height: H, sourceScale: job.srcW / W, mode: res.mode, f: res.f,
    frames: res.cameras.map((c) => ({ R: c.R.map((v) => +v.toFixed(9)), t: c.t.map((v) => +v.toFixed(7)) })),
    frameError: res.cameras.map((c) => +c.error.toFixed(3)),
    points: res.points.map((p) => ({ id: p.id, X: p.X.map((v) => +v.toFixed(6)), error: +p.error.toFixed(3), first: p.first, last: p.last, color: p.color })),
    rms: res.rms,
  };
  post({ type: 'cameraSolved', jobId: job.jobId, solution });
  post({ type: 'done', jobId: job.jobId, status: 'complete' });
}
