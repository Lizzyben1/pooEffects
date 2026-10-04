// Render server: owns the GPU renderer + media store and services requests from the UI thread.
// Runs inside a module Web Worker (preferred) or inline on the main thread as a fallback.
//
// Scheduling: requests carry a purpose — 'view' (interactive viewer, coalesced per key so only
// the newest request for a viewport is rendered), 'cache' (RAM-preview pre-rendering) and
// 'thumb' (project thumbnails). The pump always services views first and yields to the event
// loop between frames so newer requests can supersede queued ones.

import type { Project } from '../core/types';
import type { FontSpec, FromWorker, RenderPurpose, ToWorker, WorkerCaps } from './protocol';
import { Renderer, collectVideoNeeds, type RenderOptions } from './renderer';
import { WorkerAssets } from './assets';
import { clearTextCaches } from '../text/layout';
import { runExport } from '../export/exporter';
import type { Composition, RGBA } from '../core/types';
import type { AnalysisReply, AnalysisRequest } from '../cv/protocol';

interface Job {
  id: number;
  key: string;
  purpose: RenderPurpose;
  opts: RenderOptions;
  bg: RGBA | null;
  maxSize?: number;
  /** analysis frame request: reply over this port instead of posting a 'frame' */
  analysis?: { port: MessagePort; reqId: number };
}

const PRIORITY: Record<RenderPurpose, number> = { view: 0, analysis: 0.5, cache: 1, thumb: 2 };

const yieldLoop = () => new Promise<void>((r) => setTimeout(r, 0));

type Post = (m: FromWorker, transfer?: Transferable[]) => void;

export class RenderServer {
  private renderer: Renderer | null = null;
  private assets: WorkerAssets;
  private project: Project | null = null;
  private queue: Job[] = [];
  private pumping = false;
  private exporting: { jobId: string; cancelled: boolean } | null = null;
  private fallbackReqs = new Map<number, (b: ImageBitmap | null) => void>();
  private nextFallback = 1;
  private post: Post;
  private analysisComps = new Map<string, Composition>();
  private nextAnalysisJob = -1;
  private canvasFactory: () => OffscreenCanvas | HTMLCanvasElement;

  constructor(post: Post, canvasFactory?: () => OffscreenCanvas | HTMLCanvasElement) {
    this.post = post;
    this.canvasFactory = canvasFactory ?? (() => new OffscreenCanvas(16, 16));
    this.assets = new WorkerAssets((footageId, time) => this.requestFallbackFrame(footageId, time));
  }

  private requestFallbackFrame(footageId: string, time: number): Promise<ImageBitmap | null> {
    const reqId = this.nextFallback++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.fallbackReqs.delete(reqId);
        resolve(null);
      }, 4000);
      this.fallbackReqs.set(reqId, (b) => {
        clearTimeout(timer);
        resolve(b);
      });
      this.post({ type: 'needVideoFrame', reqId, footageId, time });
    });
  }

  private async loadFonts(fonts: FontSpec[]): Promise<void> {
    const set = (globalThis as unknown as { fonts?: FontFaceSet }).fonts ?? (typeof document !== 'undefined' ? document.fonts : undefined);
    if (!set || typeof FontFace === 'undefined') return;
    await Promise.all(
      fonts.map(async (f) => {
        try {
          const face = new FontFace(f.family, `url(${f.url})`, { weight: f.weight ?? 'normal', style: f.style ?? 'normal' });
          await face.load();
          set.add(face);
        } catch {
          /* a missing font falls back to the system stack */
        }
      }),
    );
    clearTextCaches();
    this.renderer?.invalidateRasters();
  }

  async handle(msg: ToWorker): Promise<void> {
    switch (msg.type) {
      case 'init': {
        try {
          const canvas = this.canvasFactory();
          this.renderer = new Renderer(canvas, this.project ?? emptyProject(), this.assets);
          const glc = this.renderer.glc;
          const caps: WorkerCaps = {
            webgl2: true, floatRender: glc.floatRender, maxTex: glc.maxTex,
            webcodecs: typeof VideoEncoder !== 'undefined', offscreen: typeof OffscreenCanvas !== 'undefined',
          };
          await this.loadFonts(msg.fonts);
          this.post({ type: 'ready', caps });
        } catch (e) {
          this.post({ type: 'fatal', message: (e as Error).message });
        }
        break;
      }
      case 'project':
        this.project = msg.project;
        this.renderer?.setProject(msg.project);
        break;
      case 'image':
        this.assets.setImage(msg.id, msg.bitmap);
        break;
      case 'video':
        this.assets.setVideo(msg.id, msg.blob);
        break;
      case 'audio':
        this.assets.setAudio(msg.id, msg.channels, msg.sampleRate);
        break;
      case 'font': {
        const set = (globalThis as unknown as { fonts?: FontFaceSet }).fonts ?? (typeof document !== 'undefined' ? document.fonts : undefined);
        if (set) {
          try {
            const face = new FontFace(msg.family, msg.buffer, msg.descriptors ?? {});
            await face.load();
            set.add(face);
            clearTextCaches();
            this.renderer?.invalidateRasters();
          } catch (e) {
            this.post({ type: 'log', level: 'warn', message: `Font ${msg.family}: ${(e as Error).message}` });
          }
        }
        break;
      }
      case 'removeAsset':
        this.assets.remove(msg.id);
        this.renderer?.forgetImage(msg.id);
        break;
      case 'render': {
        const job: Job = { id: msg.id, key: msg.key, purpose: msg.purpose, opts: msg.opts, bg: msg.bg, maxSize: msg.maxSize };
        if (msg.purpose === 'view') {
          const superseded = this.queue.filter((j) => j.purpose === 'view' && j.key === msg.key);
          if (superseded.length) {
            this.queue = this.queue.filter((j) => !superseded.includes(j));
            this.post({ type: 'cancelled', ids: superseded.map((j) => j.id) });
          }
        }
        this.queue.push(job);
        void this.pump();
        break;
      }
      case 'cancel': {
        const keep = new Set(msg.keepIds ?? []);
        const drop = this.queue.filter((j) => j.purpose === msg.purpose && !keep.has(j.id));
        if (drop.length) {
          this.queue = this.queue.filter((j) => !drop.includes(j));
          this.post({ type: 'cancelled', ids: drop.map((j) => j.id) });
        }
        break;
      }
      case 'export': {
        if (!this.renderer || !this.project) {
          this.post({ type: 'exportError', jobId: msg.job.jobId, message: 'Renderer not ready' });
          break;
        }
        const state = { jobId: msg.job.jobId, cancelled: false };
        this.exporting = state;
        this.renderer.setProject(this.project);
        runExport(msg.job, {
          renderer: this.renderer,
          assets: this.assets,
          post: this.post,
          cancelled: () => state.cancelled,
        })
          .catch((e) => this.post({ type: 'exportError', jobId: msg.job.jobId, message: (e as Error).message }))
          .finally(() => {
            if (this.exporting === state) this.exporting = null;
            void this.pump();
          });
        break;
      }
      case 'cancelExport':
        if (this.exporting && this.exporting.jobId === msg.jobId) this.exporting.cancelled = true;
        break;
      case 'videoFrameReply': {
        const cb = this.fallbackReqs.get(msg.reqId);
        this.fallbackReqs.delete(msg.reqId);
        cb?.(msg.bitmap);
        break;
      }
      case 'analysisPort': {
        const port = msg.port;
        port.onmessage = (e: MessageEvent<AnalysisRequest>) => this.onAnalysis(port, e.data);
        port.start?.();
        break;
      }
      case 'matte':
        this.assets.setMatte(msg.id, msg.rev, msg.w, msg.h, msg.data);
        break;
      case 'dropMatte':
        this.assets.dropMatte(msg.id, msg.revs);
        break;
    }
  }

  private onAnalysis(port: MessagePort, m: AnalysisRequest): void {
    switch (m.type) {
      case 'comp':
        this.analysisComps.set(m.key, m.comp);
        break;
      case 'dropComp':
        this.analysisComps.delete(m.key);
        break;
      case 'frame': {
        const comp = this.analysisComps.get(m.key);
        if (!comp) {
          const reply: AnalysisReply = { type: 'frameError', reqId: m.reqId, message: 'analysis comp not registered' };
          port.postMessage(reply);
          break;
        }
        this.queue.push({
          id: this.nextAnalysisJob--, key: m.key, purpose: 'analysis', bg: null,
          opts: { compId: comp.id, time: m.time, scale: m.scale, guides: false, draft: false, motionBlur: false },
          analysis: { port, reqId: m.reqId },
        });
        void this.pump();
        break;
      }
    }
  }

  /** Render a layer's source through its synthetic comp and send raw RGBA8 pixels to the CV worker. */
  private async renderAnalysis(job: Job): Promise<void> {
    const { port, reqId } = job.analysis!;
    try {
      const r = this.renderer;
      const comp = this.analysisComps.get(job.key);
      if (!r || !this.project || !comp) throw new Error('renderer not ready');
      const project = { ...this.project, comps: { ...this.project.comps, [comp.id]: comp } };
      const needs = new Map<string, number[]>();
      collectVideoNeeds(project, comp, job.opts.time, needs);
      if (needs.size) await this.assets.prepare(needs);
      r.setProject(project);
      let px: Uint8Array, w: number, h: number;
      try {
        const res = r.render(job.opts);
        if (!res) throw new Error('analysis comp missing');
        px = r.readPixels(res.tex);
        w = res.tex.w;
        h = res.tex.h;
        r.endFrame();
      } finally {
        r.setProject(this.project);
      }
      const reply: AnalysisReply = { type: 'frame', reqId, width: w, height: h, pixels: px.buffer as ArrayBuffer };
      port.postMessage(reply, [px.buffer as ArrayBuffer]);
    } catch (e) {
      const reply: AnalysisReply = { type: 'frameError', reqId, message: (e as Error).message ?? String(e) };
      port.postMessage(reply);
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        if (this.exporting) {
          // keep the viewer alive during exports, but at a reduced rate
          await new Promise((r) => setTimeout(r, 120));
          const views = this.queue.filter((j) => j.purpose === 'view');
          if (!views.length) continue;
        }
        let bi = 0;
        for (let k = 1; k < this.queue.length; k++) {
          const a = this.queue[k], b = this.queue[bi];
          if (PRIORITY[a.purpose] < PRIORITY[b.purpose] || (PRIORITY[a.purpose] === PRIORITY[b.purpose] && a.id < b.id)) bi = k;
        }
        if (this.exporting && this.queue[bi].purpose !== 'view') continue;
        const job = this.queue.splice(bi, 1)[0];
        try {
          await this.renderJob(job);
        } catch (e) {
          if (!job.analysis) this.post({ type: 'renderError', id: job.id, key: job.key, message: (e as Error).message ?? String(e) });
        }
        await yieldLoop();
      }
    } finally {
      this.pumping = false;
    }
  }

  private async renderJob(job: Job): Promise<void> {
    if (job.analysis) return this.renderAnalysis(job);
    const r = this.renderer;
    if (!r || !this.project) throw new Error('renderer not ready');
    const comp = this.project.comps[job.opts.compId];
    if (!comp) throw new Error('composition not found');
    const needs = new Map<string, number[]>();
    collectVideoNeeds(this.project, comp, job.opts.time, needs);
    if (needs.size) await this.assets.prepare(needs);
    r.setProject(this.project);
    let opts = job.opts;
    if (job.maxSize) opts = { ...opts, scale: Math.min(opts.scale, job.maxSize / Math.max(comp.width, comp.height)) };
    const res = r.render(opts);
    if (!res) throw new Error('composition not found');
    r.present(res.tex, job.bg);
    const canvas = r.glc.canvas as OffscreenCanvas;
    const bitmap = 'transferToImageBitmap' in canvas ? canvas.transferToImageBitmap() : await createImageBitmap(canvas);
    r.endFrame();
    this.post(
      {
        type: 'frame', id: job.id, key: job.key, purpose: job.purpose, bitmap, ms: r.lastStats.ms, layers: r.lastStats.layers,
        errors: [...r.errors.entries()], time: job.opts.time, compId: job.opts.compId,
      },
      [bitmap],
    );
  }
}

function emptyProject(): Project {
  return {
    format: 'pooeffects', version: 1, name: '', comps: {}, footage: {}, folders: {},
    settings: { expressionsEnabled: true, timeDisplay: 'timecode', frameStart: 0 },
  };
}
