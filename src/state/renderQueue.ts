// ─────────────────────────────────────────────────────────────────────────────
// Render Queue controller. Items render one after another inside the render
// worker (WebCodecs MP4/WebM, GIF, PNG-sequence ZIP). Audio is mixed down on
// the main thread with an OfflineAudioContext and transferred with the job.
// ─────────────────────────────────────────────────────────────────────────────

import type { ExportFormat } from '../render/protocol';
import type { RenderQueueItem } from './uiTypes';
import { getApp, setApp, toast } from './store';
import { host } from './engine';
import { audioContext, compHasAudio, mixdown } from '../audio/engine';
import { downloadBlob } from './projectIO';
import { uid } from '../core/ids';
import { exactFps } from '../core/time';

export interface FormatInfo {
  label: string;
  ext: string;
  video: boolean;
  alpha: boolean;
  desc: string;
}

export const FORMAT_INFO: Record<ExportFormat, FormatInfo> = {
  mp4: { label: 'MP4 · H.264', ext: 'mp4', video: true, alpha: false, desc: 'WebCodecs H.264 (HEVC / AV1 fallback) with AAC audio' },
  webm: { label: 'WebM · VP9', ext: 'webm', video: true, alpha: false, desc: 'VP9 video with Opus audio' },
  'webm-alpha': { label: 'WebM · VP9 + Alpha', ext: 'webm', video: true, alpha: true, desc: 'VP9 with a straight alpha channel' },
  gif: { label: 'Animated GIF', ext: 'gif', video: false, alpha: true, desc: 'Per-frame 256-colour palette, 1-bit transparency' },
  png: { label: 'PNG Sequence (ZIP)', ext: 'zip', video: false, alpha: true, desc: 'Lossless RGBA frames packed into a ZIP archive' },
};

export const FORMAT_ORDER: ExportFormat[] = ['mp4', 'webm', 'webm-alpha', 'gif', 'png'];
export const SCALE_OPTIONS = [1, 0.75, 0.5, 1 / 3, 0.25];
export const GIF_FPS_OPTIONS = [10, 12, 15, 20, 24, 25, 30];

/** Whether video encoding is available (the worker reports its own WebCodecs support once ready). */
export function canEncodeVideo(): boolean {
  if (host.caps) return host.caps.webcodecs;
  return typeof VideoEncoder !== 'undefined';
}

export function safeFileName(name: string): string {
  return name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'render';
}

// ── options persisted per browser ───────────────────────────────────────────

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

let autoDownload = readFlag('poo.rq.autoDownload', true);
let chimeOnDone = readFlag('poo.rq.chime', true);
export const getAutoDownload = () => autoDownload;
export const getChime = () => chimeOnDone;
export function setAutoDownload(v: boolean): void {
  autoDownload = v;
  writeFlag('poo.rq.autoDownload', v);
}
export function setChime(v: boolean): void {
  chimeOnDone = v;
  writeFlag('poo.rq.chime', v);
}

// ── item helpers ────────────────────────────────────────────────────────────

export function updateItem(id: string, partial: Partial<RenderQueueItem>): void {
  setApp((s) => ({ renderQueue: s.renderQueue.map((it) => (it.id === id ? { ...it, ...partial } : it)) }));
}

export function createQueueItem(compId: string, overrides: Partial<RenderQueueItem> = {}): RenderQueueItem | null {
  const c = getApp().project.comps[compId];
  if (!c) return null;
  const format: ExportFormat = canEncodeVideo() ? 'mp4' : 'png';
  return {
    id: uid('rq'), compId, format, scale: 1, quality: 'high', range: 'workArea', motionBlur: true, includeAudio: true, gifFps: 20,
    filename: safeFileName(c.name), status: 'queued', progress: 0, fps: 0, ...overrides,
  };
}

export function enqueue(compId: string, overrides: Partial<RenderQueueItem> = {}): RenderQueueItem | null {
  const item = createQueueItem(compId, overrides);
  if (!item) return null;
  setApp((s) => ({ renderQueue: [...s.renderQueue, item] }));
  return item;
}

/** Frame range [start, end) in seconds and the number of frames the item will produce. */
export function itemRange(item: RenderQueueItem): { start: number; end: number; frames: number; fps: number } | null {
  const comp = getApp().project.comps[item.compId];
  if (!comp) return null;
  const [start, end] = item.range === 'workArea' ? comp.workArea : [0, comp.duration];
  const fps = item.format === 'gif' ? Math.min(exactFps(comp.frameRate), item.gifFps) : exactFps(comp.frameRate);
  return { start, end, fps, frames: Math.max(1, Math.round((end - start) * fps)) };
}

export function itemDimensions(item: RenderQueueItem): { w: number; h: number } | null {
  const comp = getApp().project.comps[item.compId];
  if (!comp) return null;
  let w = Math.max(2, Math.round(comp.width * item.scale));
  let h = Math.max(2, Math.round(comp.height * item.scale));
  if (FORMAT_INFO[item.format].video) {
    w -= w % 2;
    h -= h % 2;
  }
  return { w, h };
}

const previewUrls = new Map<string, string>();
const previewSeq = new Map<string, number>();

function releaseUrls(item: RenderQueueItem): void {
  const p = previewUrls.get(item.id);
  if (p) URL.revokeObjectURL(p);
  previewUrls.delete(item.id);
  previewSeq.delete(item.id);
  if (item.outputUrl) URL.revokeObjectURL(item.outputUrl);
}

async function setPreview(id: string, bmp: ImageBitmap): Promise<void> {
  const seq = (previewSeq.get(id) ?? 0) + 1;
  previewSeq.set(id, seq);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  // a newer preview may have finished encoding first; never let an older one replace it
  if (!blob || previewSeq.get(id) !== seq) return;
  const url = URL.createObjectURL(blob);
  const old = previewUrls.get(id);
  if (old) URL.revokeObjectURL(old);
  previewUrls.set(id, url);
  updateItem(id, { preview: url });
}

export function removeQueueItem(id: string): void {
  const item = getApp().renderQueue.find((i) => i.id === id);
  if (!item) return;
  if (item.status === 'rendering') {
    if (currentJob) host.cancelExport(currentJob.jobId);
    skipCurrent = true;
  }
  releaseUrls(item);
  setApp((s) => ({ renderQueue: s.renderQueue.filter((i) => i.id !== id) }));
}

export function clearFinished(): void {
  const done = getApp().renderQueue.filter((i) => i.status !== 'queued' && i.status !== 'rendering');
  for (const it of done) releaseUrls(it);
  setApp((s) => ({ renderQueue: s.renderQueue.filter((i) => i.status === 'queued' || i.status === 'rendering') }));
}

/** Put a finished / failed item back in the queue so the next run renders it again. */
export function requeueItem(id: string): void {
  const item = getApp().renderQueue.find((i) => i.id === id);
  if (!item || item.status === 'rendering') return;
  releaseUrls(item);
  updateItem(id, {
    status: 'queued', progress: 0, frame: 0, total: undefined, fps: 0, error: undefined, startedAt: undefined, finishedAt: undefined,
    outputUrl: undefined, outputSize: undefined, preview: undefined,
  });
}

export function duplicateQueueItem(id: string): void {
  const s = getApp();
  const idx = s.renderQueue.findIndex((i) => i.id === id);
  if (idx < 0) return;
  const src = s.renderQueue[idx];
  const copy: RenderQueueItem = {
    ...src, id: uid('rq'), status: 'queued', progress: 0, frame: 0, total: undefined, fps: 0, error: undefined, startedAt: undefined,
    finishedAt: undefined, outputUrl: undefined, outputSize: undefined, preview: undefined, filename: `${src.filename}_copy`,
  };
  const next = [...s.renderQueue];
  next.splice(idx + 1, 0, copy);
  setApp({ renderQueue: next });
}

export function moveQueueItem(id: string, dir: -1 | 1): void {
  const q = [...getApp().renderQueue];
  const i = q.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= q.length) return;
  [q[i], q[j]] = [q[j], q[i]];
  setApp({ renderQueue: q });
}

// ── running the queue ───────────────────────────────────────────────────────

let running = false;
let stopRequested = false;
let skipCurrent = false;
let currentJob: { jobId: string; itemId: string } | null = null;

export async function startRenderQueue(): Promise<void> {
  if (running) return;
  if (!getApp().renderQueue.some((i) => i.status === 'queued')) {
    toast('Nothing queued — add a composition first', 'warn');
    return;
  }
  running = true;
  stopRequested = false;
  let succeeded = 0;
  let failed = 0;
  try {
    for (;;) {
      if (stopRequested) break;
      const item = getApp().renderQueue.find((i) => i.status === 'queued');
      if (!item) break;
      const ok = await renderItem(item);
      if (ok === true) succeeded++;
      else if (ok === false) failed++;
    }
  } finally {
    running = false;
    currentJob = null;
  }
  if (succeeded && chimeOnDone) playChime(failed === 0);
  if (succeeded + failed > 1) toast(`Render queue finished: ${succeeded} done${failed ? `, ${failed} failed` : ''}`, failed ? 'warn' : 'success', 4000);
}

export function stopRenderQueue(): void {
  stopRequested = true;
  if (currentJob) host.cancelExport(currentJob.jobId);
}

/** Resolves true on success, false on failure, null when cancelled. */
async function renderItem(item: RenderQueueItem): Promise<boolean | null> {
  const project = getApp().project;
  const comp = project.comps[item.compId];
  const info = FORMAT_INFO[item.format];
  const fail = (message: string): false => {
    updateItem(item.id, { status: 'error', error: message, finishedAt: Date.now() });
    toast(`Render failed: ${message}`, 'error', 6000);
    return false;
  };
  if (!comp) return fail('The composition no longer exists');
  const range = itemRange(item)!;
  if (range.end - range.start <= 1e-6) return fail('The render range is empty');
  if (info.video && !canEncodeVideo()) return fail('This browser has no WebCodecs VideoEncoder — choose GIF or PNG sequence');

  releaseUrls(item);
  updateItem(item.id, {
    status: 'rendering', progress: 0, frame: 0, total: range.frames, fps: 0, startedAt: Date.now(), finishedAt: undefined, error: undefined,
    outputUrl: undefined, outputSize: undefined, preview: undefined,
  });

  let audio: { channels: Float32Array[]; sampleRate: number } | null = null;
  if (info.video && item.includeAudio && compHasAudio(project, comp)) {
    try {
      audio = await mixdown(project, comp, range.start, range.end);
    } catch (e) {
      toast(`Audio mixdown failed, exporting silent video (${(e as Error).message})`, 'warn', 5000);
    }
  }
  if (stopRequested) {
    updateItem(item.id, { status: 'cancelled', finishedAt: Date.now() });
    return null;
  }

  const jobId = uid('job');
  currentJob = { jobId, itemId: item.id };
  skipCurrent = false;
  try {
    const { blob, filename } = await host.export(
      {
        jobId, compId: comp.id, format: item.format, start: range.start, end: range.end, scale: item.scale, quality: item.quality,
        motionBlur: item.motionBlur, filename: `${item.filename}.${info.ext}`, audio, gifFps: item.gifFps,
      },
      (frame, total, preview, fps) => {
        if (!getApp().renderQueue.some((i) => i.id === item.id)) {
          preview?.close();
          return;
        }
        updateItem(item.id, { progress: frame / total, frame, total, fps });
        if (preview) void setPreview(item.id, preview);
      },
    );
    if (!getApp().renderQueue.some((i) => i.id === item.id)) return null;
    const url = URL.createObjectURL(blob);
    updateItem(item.id, { status: 'done', progress: 1, outputUrl: url, outputSize: blob.size, finishedAt: Date.now() });
    if (autoDownload) downloadBlob(blob, filename);
    toast(`Rendered ${filename} (${formatBytes(blob.size)})`, 'success', 3500);
    return true;
  } catch (e) {
    const message = (e as Error).message;
    if (message === 'cancelled' || stopRequested || skipCurrent) {
      if (getApp().renderQueue.some((i) => i.id === item.id)) updateItem(item.id, { status: 'cancelled', finishedAt: Date.now() });
      return null;
    }
    return fail(message);
  } finally {
    currentJob = null;
  }
}

/** Shortcut used by the Quick Export dialog: queue one item and start rendering. */
export function quickExport(compId: string, overrides: Partial<RenderQueueItem>): void {
  const item = enqueue(compId, overrides);
  if (item) void startRenderQueue();
}

// ── formatting ──────────────────────────────────────────────────────────────

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '--:--';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** A soft two-note chime (synthesised, no asset) when the queue finishes. */
function playChime(success: boolean): void {
  try {
    const ctx = audioContext();
    const now = ctx.currentTime + 0.02;
    const notes = success ? [783.99, 1174.66] : [392, 311.13];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = now + i * 0.14;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 1);
    });
  } catch {
    /* audio unavailable */
  }
}
