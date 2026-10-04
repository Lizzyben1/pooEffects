// ─────────────────────────────────────────────────────────────────────────────
// Main-thread side of the computer-vision subsystem. Spawns the tracking worker
// (and, on demand, the SAM 2 worker), wires each one to the render worker with
// its own MessageChannel so analysis frames flow worker → worker as
// transferable buffers, and multiplexes job callbacks.
// ─────────────────────────────────────────────────────────────────────────────

import type { Composition, Layer, Project } from '../core/types';
import { layerSourceSize } from '../core/evaluate';
import { createTransform } from '../core/factory';
import { host as renderHost } from '../state/engine';
import type { CVJob, FromCV, ToCV } from './jobs';

export interface JobHandlers {
  onMessage: (m: FromCV) => void;
}

let worker: Worker | null = null;
const handlers = new Map<string, JobHandlers>();
let jobSeq = 1;

/** Create a MessagePort pair and hand one end to the render worker. */
export function connectAnalysisPort(): MessagePort {
  const ch = new MessageChannel();
  renderHost.post({ type: 'analysisPort', port: ch.port1 }, [ch.port1]);
  return ch.port2;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'pooEffects-tracker' });
  worker.onmessage = (e: MessageEvent<FromCV>) => {
    const m = e.data;
    const h = handlers.get(m.jobId);
    h?.onMessage(m);
    if (m.type === 'done') handlers.delete(m.jobId);
  };
  worker.onerror = (e) => {
    e.preventDefault?.();
    for (const [jobId, h] of handlers) h.onMessage({ type: 'done', jobId, status: 'error', message: e.message || 'tracking worker crashed' });
    handlers.clear();
    worker?.terminate();
    worker = null;
  };
  const port = connectAnalysisPort();
  const msg: ToCV = { type: 'port', port };
  worker.postMessage(msg, [port]);
  // the render worker may restart (inline fallback); re-connect on restart
  const prev = renderHost.onRestart;
  renderHost.onRestart = () => {
    prev();
    if (!worker) return;
    const p = connectAnalysisPort();
    worker.postMessage({ type: 'port', port: p } satisfies ToCV, [p]);
  };
  return worker;
}

export function newJobId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${jobSeq++}`;
}

export function runJob(job: CVJob, h: JobHandlers): void {
  const w = ensureWorker();
  handlers.set(job.jobId, h);
  const msg: ToCV = { type: 'run', job };
  w.postMessage(msg);
}

export function cancelJob(jobId: string): void {
  worker?.postMessage({ type: 'cancel', jobId } satisfies ToCV);
}

/**
 * A single-layer composition that renders `layer`'s source at source resolution with an identity
 * transform and no masks/effects/matte — what After Effects' Layer panel shows to the tracker.
 * Timing (start time, stretch, time remapping) is preserved, so comp times map 1:1.
 */
export function analysisComp(project: Project, comp: Composition, layer: Layer): { key: string; comp: Composition; w: number; h: number } {
  const { w, h } = layerSourceSize(project, comp, layer);
  const clone: Layer = JSON.parse(JSON.stringify(layer));
  clone.transform = createTransform([0, 0, 0], [0, 0, 0]);
  clone.masks = [];
  clone.effects = [];
  clone.trackMatte = null;
  clone.parentId = null;
  clone.threeD = false;
  clone.motionBlur = false;
  clone.adjustment = false;
  clone.enabled = true;
  clone.solo = false;
  clone.blendMode = 'normal';
  clone.trackers = undefined;
  clone.cameraTrack = undefined;
  const id = `__cv_${layer.id}`;
  const synthetic: Composition = {
    ...comp,
    id,
    name: `${layer.name} (analysis)`,
    width: w,
    height: h,
    layers: [clone],
    motionBlur: false,
    bgColor: [0, 0, 0, 1],
    markers: [],
  };
  return { key: id, comp: synthetic, w, h };
}
