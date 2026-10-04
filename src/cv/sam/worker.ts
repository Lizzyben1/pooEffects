// ─────────────────────────────────────────────────────────────────────────────
// SAM 2 inference worker. Loads the Hiera-Tiny encoder/decoder ONNX models
// with onnxruntime-web — WebGPU execution provider when available, WASM SIMD
// otherwise — caching the downloaded weights in Cache Storage. Frames are
// requested from the render worker over a MessagePort; image embeddings for
// recent frames are cached so repeated prompts on one frame only re-run the
// light decoder (interactive speed).
// ─────────────────────────────────────────────────────────────────────────────

/// <reference lib="webworker" />

import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { FrameClient, type RawFrame } from '../frames';
import { SAM_VARIANTS, type FromSam, type SamFrameRef, type SamVariant, type ToSam } from './protocol';
import {
  SamEngine, chooseInteractive, choosePropagated, disposeEmbedding, grayPyramid, propagatePrompts, type Embedding, type OrtModule,
  type OrtSession,
} from './engine';
import { maskBounds } from '../mask';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const client = new FrameClient();
const cancelled = new Set<string>();
let engine: SamEngine | null = null;
let provider: 'webgpu' | 'wasm' = 'wasm';
let loading: Promise<void> | null = null;
/** frame key → embedding (most recent last) */
const embeddings = new Map<string, Embedding>();

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = ctx.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
ort.env.logLevel = 'error';

const post = (m: FromSam, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

ctx.onmessage = (e: MessageEvent<ToSam>) => {
  const m = e.data;
  switch (m.type) {
    case 'port':
      client.attach(m.port);
      break;
    case 'load':
      loading = load(m.variant, m.baseUrl, m.local).catch((err: Error) => {
        loading = null;
        post({ type: 'loadError', message: err.message ?? String(err) });
      });
      break;
    case 'segment':
      void (async () => {
        try {
          await loading;
          if (!engine) throw new Error('SAM 2 model is not loaded');
          client.register(m.key, m.comp);
          const frame = await client.frame(m.key, m.ref.time, m.matteW / m.srcW);
          const t0 = performance.now();
          const emb = await embeddingFor(m.key, m.ref, frame);
          const t1 = performance.now();
          const r = await engine.decode(emb, m.points, m.box, frame.width, frame.height);
          const pick = chooseInteractive(r, m.points, frame.width, frame.height);
          const t2 = performance.now();
          post({ type: 'mask', jobId: m.jobId, ref: m.ref, w: frame.width, h: frame.height, data: pick.mask, score: pick.score, points: m.points, encodeMs: t1 - t0, decodeMs: t2 - t1 }, [pick.mask.buffer]);
          post({ type: 'done', jobId: m.jobId, status: 'complete' });
        } catch (err) {
          post({ type: 'done', jobId: m.jobId, status: 'error', message: (err as Error).message ?? String(err) });
        }
      })();
      break;
    case 'propagate':
      void propagate(m);
      break;
    case 'cancel':
      cancelled.add(m.jobId);
      break;
    case 'clearCache':
      for (const e2 of embeddings.values()) disposeEmbedding(e2);
      embeddings.clear();
      break;
  }
};

async function fetchModelFile(url: string, label: string): Promise<{ data: Uint8Array; cached: boolean }> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open('pooeffects-models-v1');
    const hit = await cache.match(url);
    if (hit) {
      const buf = new Uint8Array(await hit.arrayBuffer());
      post({ type: 'loadProgress', file: label, loaded: buf.byteLength, total: buf.byteLength });
      return { data: buf, cached: true };
    }
  } catch {
    cache = null;
  }
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${label}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0, lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (loaded - lastPost > 512 * 1024) {
      lastPost = loaded;
      post({ type: 'loadProgress', file: label, loaded, total });
    }
  }
  const data = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    data.set(c, off);
    off += c.byteLength;
  }
  post({ type: 'loadProgress', file: label, loaded, total: total || loaded });
  if (cache) await cache.put(url, new Response(data.slice().buffer, { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {});
  return { data, cached: false };
}

async function webgpuAvailable(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!gpu && !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function load(variant: SamVariant, baseUrl: string, local?: { encoder: ArrayBuffer; encoderData?: ArrayBuffer; decoder: ArrayBuffer; decoderData?: ArrayBuffer }): Promise<void> {
  const t0 = performance.now();
  const v = SAM_VARIANTS[variant];
  let enc: Uint8Array, encData: Uint8Array | undefined, dec: Uint8Array, decData: Uint8Array | undefined;
  let cached = true;
  if (local) {
    enc = new Uint8Array(local.encoder);
    dec = new Uint8Array(local.decoder);
    encData = local.encoderData ? new Uint8Array(local.encoderData) : undefined;
    decData = local.decoderData ? new Uint8Array(local.decoderData) : undefined;
  } else {
    const files = await Promise.all([
      fetchModelFile(`${baseUrl}${v.encoder}.onnx`, 'encoder graph'),
      fetchModelFile(`${baseUrl}${v.encoder}.onnx_data`, 'encoder weights'),
      fetchModelFile(`${baseUrl}${v.decoder}.onnx`, 'decoder graph'),
      fetchModelFile(`${baseUrl}${v.decoder}.onnx_data`, 'decoder weights'),
    ]);
    [enc, encData, dec, decData] = files.map((f) => f.data);
    cached = files.every((f) => f.cached);
  }
  const make = async (ep: 'webgpu' | 'wasm') => {
    const opts = (name: string, data?: Uint8Array): ort.InferenceSession.SessionOptions => ({
      executionProviders: [ep],
      graphOptimizationLevel: 'all',
      externalData: data ? [{ path: `${name}.onnx_data`, data }] : undefined,
    });
    const encoder = await ort.InferenceSession.create(enc, opts(v.encoder, encData));
    const decoder = await ort.InferenceSession.create(dec, opts(v.decoder, decData));
    return { encoder, decoder };
  };
  let sessions: { encoder: ort.InferenceSession; decoder: ort.InferenceSession };
  if (await webgpuAvailable()) {
    try {
      sessions = await make('webgpu');
      provider = 'webgpu';
    } catch {
      sessions = await make('wasm');
      provider = 'wasm';
    }
  } else {
    sessions = await make('wasm');
    provider = 'wasm';
  }
  engine = new SamEngine(ort as unknown as OrtModule, sessions.encoder as unknown as OrtSession, sessions.decoder as unknown as OrtSession);
  post({ type: 'loaded', provider, variant, ms: performance.now() - t0, cached });
}

async function embeddingFor(key: string, ref: SamFrameRef, frame: RawFrame): Promise<Embedding> {
  const k = `${key}@${ref.frame}`;
  const hit = embeddings.get(k);
  if (hit) {
    embeddings.delete(k);
    embeddings.set(k, hit);
    return hit;
  }
  const e = await engine!.encode(frame.pixels, frame.width, frame.height);
  embeddings.set(k, e);
  while (embeddings.size > 3) {
    const [old, ev] = embeddings.entries().next().value as [string, Embedding];
    disposeEmbedding(ev);
    embeddings.delete(old);
  }
  return e;
}

async function propagate(m: Extract<ToSam, { type: 'propagate' }>): Promise<void> {
  try {
    await loading;
    if (!engine) throw new Error('SAM 2 model is not loaded');
    client.register(m.key, m.comp);
    const scale = m.matteW / m.srcW;
    const seedFrame = await client.frame(m.key, m.seedRef.time, scale);
    const w = seedFrame.width, h = seedFrame.height;
    let prevPyr = grayPyramid(seedFrame.pixels, w, h);
    let prevMask = m.seed;
    if (prevMask.length !== w * h) throw new Error('Seed matte does not match the frame size');
    if (!maskBounds(prevMask, w, h)) throw new Error('The starting frame has an empty matte — add foreground points first');
    let carried = m.points;
    let next = client.frame(m.key, m.frames[0]?.time ?? 0, scale);
    for (let i = 0; i < m.frames.length; i++) {
      if (cancelled.has(m.jobId)) {
        post({ type: 'done', jobId: m.jobId, status: 'cancelled' });
        return;
      }
      const ref = m.frames[i];
      const frame = await next;
      if (i + 1 < m.frames.length) next = client.frame(m.key, m.frames[i + 1].time, scale);
      const pyr = grayPyramid(frame.pixels, w, h);
      const step = propagatePrompts(prevMask, prevPyr, pyr, w, h, carried);
      if (!step) {
        post({ type: 'done', jobId: m.jobId, status: 'stopped', message: `Object lost at frame ${ref.frame}` });
        return;
      }
      const t0 = performance.now();
      const emb = await embeddingFor(m.key, ref, frame);
      const t1 = performance.now();
      const r = await engine.decode(emb, step.points, step.box, w, h);
      const pick = choosePropagated(r, step, w, h);
      const t2 = performance.now();
      if (!pick) {
        post({ type: 'done', jobId: m.jobId, status: 'stopped', message: `Object lost at frame ${ref.frame}` });
        return;
      }
      const copy = pick.mask.slice();
      post({ type: 'mask', jobId: m.jobId, ref, w, h, data: copy, score: pick.score, points: step.points, encodeMs: t1 - t0, decodeMs: t2 - t1 }, [copy.buffer]);
      post({ type: 'progress', jobId: m.jobId, stage: provider === 'webgpu' ? 'Propagating (WebGPU)' : 'Propagating (WASM)', fraction: (i + 1) / m.frames.length });
      prevMask = pick.mask;
      prevPyr = pyr;
      carried = step.points.filter((p) => p[2] === 1).slice(0, 3);
    }
    post({ type: 'done', jobId: m.jobId, status: 'complete' });
  } catch (err) {
    post({ type: 'done', jobId: m.jobId, status: 'error', message: (err as Error).message ?? String(err) });
  } finally {
    cancelled.delete(m.jobId);
  }
}
