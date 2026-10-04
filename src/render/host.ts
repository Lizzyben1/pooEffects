// Main-thread client for the render server. Spawns the render worker; if the platform cannot run
// WebGL2 on an OffscreenCanvas inside a worker, transparently falls back to an inline server.

import type { Project, RGBA } from '../core/types';
import type { ExportJob, FontSpec, FromWorker, RenderPurpose, ToWorker, WorkerCaps } from './protocol';
import type { RenderOptions } from './renderer';
import type { RenderServer } from './server';

export interface FrameResult {
  bitmap: ImageBitmap;
  ms: number;
  layers: number;
  errors: [string, string][];
  time: number;
  compId: string;
}

interface Pending {
  resolve: (r: FrameResult | null) => void;
  key: string;
  purpose: RenderPurpose;
}

interface ExportListener {
  onProgress: (frame: number, total: number, preview: ImageBitmap | null, fps: number) => void;
  resolve: (r: { blob: Blob; filename: string }) => void;
  reject: (e: Error) => void;
}

export class RenderHost {
  private worker: Worker | null = null;
  private server: RenderServer | null = null;
  /** messages posted while the inline server module is still loading */
  private inlineQueue: { msg: ToWorker }[] | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private lastProject: Project | null = null;
  private exports = new Map<string, ExportListener>();
  private fonts: FontSpec[];
  private readyResolve!: (c: WorkerCaps) => void;
  private readyReject!: (e: Error) => void;
  readonly ready: Promise<WorkerCaps>;
  caps: WorkerCaps | null = null;
  mode: 'worker' | 'inline' = 'worker';
  /** Called after a server restart so the media store can re-send assets. */
  onRestart: () => void = () => {};
  onVideoFrameRequest: (footageId: string, time: number) => Promise<ImageBitmap | null> = async () => null;
  onLog: (level: string, message: string) => void = (l, m) => console[l === 'error' ? 'error' : 'warn'](`[render] ${m}`);
  onErrors: (errors: [string, string][]) => void = () => {};

  constructor(fonts: FontSpec[]) {
    this.fonts = fonts;
    this.ready = new Promise((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
  }

  start(): void {
    const forceInline = typeof OffscreenCanvas === 'undefined' || /[?&]inline-render\b/.test(globalThis.location?.search ?? '');
    if (forceInline) {
      this.startInline('OffscreenCanvas unavailable');
      return;
    }
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'pooEffects-render' });
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
      this.worker.onerror = (e) => {
        e.preventDefault?.();
        this.startInline(e.message || 'worker error');
      };
      this.post({ type: 'init', fonts: this.fonts });
    } catch (e) {
      this.startInline((e as Error).message);
    }
  }

  private startInline(reason: string): void {
    if (this.mode === 'inline' && (this.server || this.inlineQueue)) return;
    this.onLog('warn', `Using inline renderer (${reason})`);
    this.worker?.terminate();
    this.worker = null;
    this.mode = 'inline';
    for (const [, p] of this.pending) p.resolve(null);
    this.pending.clear();
    this.inlineQueue = [];
    // the main-thread renderer is only downloaded when a worker can't render
    void import('./server')
      .then(({ RenderServer }) => {
        const server = new RenderServer(
          (m) => queueMicrotask(() => this.onMessage(m)),
          () => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(16, 16) : document.createElement('canvas')),
        );
        void server.handle({ type: 'init', fonts: this.fonts });
        if (this.lastProject) void server.handle({ type: 'project', project: this.lastProject });
        const queued = this.inlineQueue ?? [];
        this.server = server;
        this.inlineQueue = null;
        for (const q of queued) void server.handle(q.msg);
        this.onRestart();
      })
      .catch((e: Error) => this.readyReject(new Error(`Inline renderer failed to load: ${e.message}`)));
  }

  post(msg: ToWorker, transfer: Transferable[] = []): void {
    if (this.worker) this.worker.postMessage(msg, transfer);
    else if (this.server) void this.server.handle(msg);
    else if (this.inlineQueue) this.inlineQueue.push({ msg });
  }

  private onMessage(m: FromWorker): void {
    switch (m.type) {
      case 'ready':
        this.caps = m.caps;
        this.readyResolve(m.caps);
        break;
      case 'fatal':
        if (this.mode === 'worker') this.startInline(m.message);
        else this.readyReject(new Error(m.message));
        break;
      case 'frame': {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.errors.length || m.purpose === 'view') this.onErrors(m.errors);
        if (p) p.resolve({ bitmap: m.bitmap, ms: m.ms, layers: m.layers, errors: m.errors, time: m.time, compId: m.compId });
        else m.bitmap.close();
        break;
      }
      case 'renderError': {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        this.onLog('error', m.message);
        p?.resolve(null);
        break;
      }
      case 'cancelled':
        for (const id of m.ids) {
          this.pending.get(id)?.resolve(null);
          this.pending.delete(id);
        }
        break;
      case 'needVideoFrame':
        void this.onVideoFrameRequest(m.footageId, m.time).then((bitmap) => {
          this.post({ type: 'videoFrameReply', reqId: m.reqId, bitmap }, bitmap ? [bitmap] : []);
        });
        break;
      case 'exportProgress': {
        const l = this.exports.get(m.jobId);
        if (l) l.onProgress(m.frame, m.total, m.preview, m.fps);
        else m.preview?.close();
        break;
      }
      case 'exportDone': {
        const l = this.exports.get(m.jobId);
        this.exports.delete(m.jobId);
        l?.resolve({ blob: m.blob, filename: m.filename });
        break;
      }
      case 'exportError': {
        const l = this.exports.get(m.jobId);
        this.exports.delete(m.jobId);
        l?.reject(new Error(m.message));
        break;
      }
      case 'log':
        this.onLog(m.level, m.message);
        break;
    }
  }

  setProject(p: Project): void {
    if (p === this.lastProject) return;
    this.lastProject = p;
    this.post({ type: 'project', project: p });
  }

  render(key: string, purpose: RenderPurpose, opts: RenderOptions, bg: RGBA | null, maxSize?: number): Promise<FrameResult | null> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, key, purpose });
      this.post({ type: 'render', id, key, purpose, opts, bg, maxSize });
    });
  }

  cancel(purpose: RenderPurpose): void {
    this.post({ type: 'cancel', purpose });
  }

  inFlight(purpose: RenderPurpose): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.purpose === purpose) n++;
    return n;
  }

  addImage(id: string, bitmap: ImageBitmap): void {
    this.post({ type: 'image', id, bitmap }, this.worker ? [bitmap] : []);
  }

  addVideo(id: string, blob: Blob): void {
    this.post({ type: 'video', id, blob });
  }

  addAudio(id: string, channels: Float32Array[], sampleRate: number): void {
    const copies = channels.map((c) => c.slice());
    this.post({ type: 'audio', id, channels: copies, sampleRate }, this.worker ? copies.map((c) => c.buffer) : []);
  }

  addFont(family: string, buffer: ArrayBuffer, descriptors?: { weight?: string; style?: string }): void {
    const copy = buffer.slice(0);
    this.post({ type: 'font', family, buffer: copy, descriptors }, this.worker ? [copy] : []);
  }

  removeAsset(id: string): void {
    this.post({ type: 'removeAsset', id });
  }

  export(job: ExportJob, onProgress: ExportListener['onProgress']): Promise<{ blob: Blob; filename: string }> {
    return new Promise((resolve, reject) => {
      this.exports.set(job.jobId, { onProgress, resolve, reject });
      const transfer = job.audio && this.worker ? job.audio.channels.map((c) => c.buffer) : [];
      this.post({ type: 'export', job }, transfer);
    });
  }

  cancelExport(jobId: string): void {
    this.post({ type: 'cancelExport', jobId });
  }
}
