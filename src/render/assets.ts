// Worker-side media store: still images, frame-accurate video decoding (WebCodecs via mediabunny,
// with a main-thread <video> fallback), audio samples for audio-reactive effects, and fonts.

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type InputVideoTrack, type VideoSample } from 'mediabunny';
import { inflateSync } from 'fflate';
import type { AssetHost } from './renderer';
import type { VideoDecodeStats } from './protocol';

const newStats = (): VideoDecodeStats => ({ path: 'pending', codec: null, decoded: 0, decodeMs: 0, seeks: 0, hits: 0, reason: null, accel: 'auto' });

interface DecodedFrame {
  frame: VideoFrame | ImageBitmap;
  start: number;
  end: number;
  key: string;
  w: number;
  h: number;
}

/** Raced against a decoder call: resolves to null after `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<null>((res) => (timer = setTimeout(() => res(null), ms)))]).finally(() => clearTimeout(timer));
}

/** How long a single decoder step may take before the stream is considered stalled. */
const STALL_MS = 4000;
const FRAME_CACHE = 12;

/**
 * Sequential-friendly frame access for one video file (WebCodecs via mediabunny).
 *
 * Decoder-owned VideoFrames are copied to ImageBitmaps and closed immediately: hardware decoders
 * (e.g. D3D11 on Windows) have a small fixed pool of output surfaces, and retaining decoded frames
 * starves that pool — decode() then stalls and every render waiting on it hangs.
 * Requests are serialised (one shared iterator), and a watchdog turns a stalled decoder into a
 * fallback instead of a hang.
 */
class VideoStream {
  private input: Input | null = null;
  private track: InputVideoTrack | null = null;
  private sink: VideoSampleSink | null = null;
  private iter: AsyncGenerator<VideoSample, void, unknown> | null = null;
  private lastStart = -1;
  private cache: DecodedFrame[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private stalls = 0;
  failed = false;
  ready: Promise<void>;
  readonly id: string;
  readonly stats: VideoDecodeStats = newStats();

  constructor(id: string, blob: Blob, preferSoftware = false) {
    this.id = id;
    this.stats.accel = preferSoftware ? 'software' : 'auto';
    this.ready = this.open(blob);
  }

  private makeSink(): VideoSampleSink {
    return new VideoSampleSink(this.track!, this.stats.accel === 'software' ? { hardwareAcceleration: 'prefer-software' } : undefined);
  }

  /** Switch to (or away from) the software decoder; restarts the decode iterator. */
  setSoftware(on: boolean): void {
    const want = on ? 'software' : 'auto';
    if (this.stats.accel === want || !this.track) return;
    this.stats.accel = want;
    this.resetIter();
    if (this.failed && this.stats.reason?.includes('stalled')) {
      this.failed = false;
      this.stats.path = 'webcodecs';
      this.stats.reason = null;
      this.stalls = 0;
    }
    if (!this.failed) this.sink = this.makeSink();
  }

  private async open(blob: Blob): Promise<void> {
    try {
      this.input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      this.track = await this.input.getPrimaryVideoTrack();
      if (!this.track) throw new Error('no video track');
      this.stats.codec = (await this.track.getCodecParameterString().catch(() => null)) ?? this.track.codec ?? null;
      if (!(await this.track.canDecode())) throw new Error(`this browser cannot decode ${this.track.codec ?? 'this codec'} with WebCodecs`);
      this.sink = this.makeSink();
      this.stats.path = 'webcodecs';
    } catch (e) {
      this.fail((e as Error).message ?? String(e));
    }
  }

  private fail(reason: string): void {
    this.failed = true;
    this.stats.path = 'failed';
    this.stats.reason = reason;
    this.resetIter();
  }

  cached(t: number): DecodedFrame | null {
    for (const f of this.cache) if (t >= f.start - 1e-4 && t < f.end - 1e-4) return f;
    return null;
  }

  /** Copy the sample into an ImageBitmap and release the decoder's surface right away. */
  private async store(sample: VideoSample): Promise<DecodedFrame> {
    const start = sample.timestamp;
    const end = sample.timestamp + Math.max(1e-3, sample.duration || 1 / 30);
    let frame: VideoFrame | ImageBitmap;
    const vf = sample.toVideoFrame();
    sample.close();
    try {
      frame = await createImageBitmap(vf);
      vf.close();
    } catch {
      // createImageBitmap(VideoFrame) unsupported: keep the frame (cache is small)
      frame = vf;
    }
    const d: DecodedFrame = {
      frame, start, end, key: `${this.id}@${start.toFixed(6)}`,
      w: (frame as ImageBitmap).width ?? (frame as VideoFrame).displayWidth, h: (frame as ImageBitmap).height ?? (frame as VideoFrame).displayHeight,
    };
    this.cache.push(d);
    while (this.cache.length > FRAME_CACHE) this.cache.shift()!.frame.close();
    return d;
  }

  private resetIter(): void {
    if (this.iter) void this.iter.return(undefined).catch(() => {});
    this.iter = null;
  }

  /** Decoded frame covering footage time t. Calls are serialised on this stream. */
  frameAt(t: number): Promise<DecodedFrame | null> {
    const run = this.queue.then(() => this.decodeAt(t));
    this.queue = run.catch(() => null);
    return run;
  }

  private async decodeAt(t: number): Promise<DecodedFrame | null> {
    await this.ready;
    if (this.failed || !this.sink) return null;
    const hit = this.cached(t);
    if (hit) {
      this.stats.hits++;
      return hit;
    }
    const t0 = performance.now();
    const done = (d: DecodedFrame | null) => {
      this.stats.decoded++;
      this.stats.decodeMs += performance.now() - t0;
      return d;
    };
    try {
      const forward = this.iter && t >= this.lastStart && t - this.lastStart < 1.5;
      if (!forward) {
        this.resetIter();
        this.stats.seeks++;
        this.iter = this.sink.samples(Math.max(0, t - 1e-3));
      }
      let prev: VideoSample | null = null;
      for (let guard = 0; guard < 900; guard++) {
        const r = await withTimeout(this.iter!.next(), STALL_MS);
        if (r === null) throw new Error('decoder stalled');
        if (r.done) break;
        const s = r.value;
        const end = s.timestamp + Math.max(1e-3, s.duration || 1 / 30);
        this.lastStart = s.timestamp;
        if (end <= t + 1e-4) {
          prev?.close();
          prev = s;
          continue;
        }
        prev?.close();
        this.stalls = 0;
        return done(await this.store(s));
      }
      // requested time is past the last frame: hold the final frame
      if (prev) return done(await this.store(prev));
      return this.cache[this.cache.length - 1] ?? null;
    } catch (e) {
      this.resetIter();
      if ((e as Error).message === 'decoder stalled' && ++this.stalls >= 2) {
        if (this.stats.accel === 'auto') {
          // a hardware decoder that stops producing frames (seen with H.264 on some AMD/D3D11 drivers):
          // retry with the software decoder before giving up on WebCodecs
          this.stats.accel = 'software';
          this.stats.reason = `hardware decoder stalled (${this.stats.codec ?? 'video'}) — switched to software decoding`;
          this.stalls = 0;
          this.sink = this.makeSink();
          return this.decodeAt(t);
        }
        this.fail(`WebCodecs decoder stalled (${this.stats.codec ?? 'video'})`);
        return null;
      }
      try {
        const s = await withTimeout(this.sink.getSample(t), STALL_MS);
        return s ? done(await this.store(s)) : null;
      } catch (err) {
        this.fail((err as Error).message ?? 'decode error');
        return null;
      }
    }
  }

  dispose(): void {
    this.resetIter();
    for (const f of this.cache) f.frame.close();
    this.cache = [];
    this.input?.dispose?.();
  }
}

export interface FallbackFrameRequester {
  (footageId: string, time: number): Promise<ImageBitmap | null>;
}

export class WorkerAssets implements AssetHost {
  private images = new Map<string, ImageBitmap>();
  private videos = new Map<string, VideoStream>();
  private fallbackFrames = new Map<string, DecodedFrame[]>();
  private audio = new Map<string, { mono: Float32Array; sampleRate: number }>();
  private requestFallback: FallbackFrameRequester;
  private fallbackStats = new Map<string, VideoDecodeStats>();
  private fallbackAttempts = new Map<string, number>();
  /** roto matte revisions: deflated planes + a small cache of inflated ones */
  private mattes = new Map<string, Map<number, { w: number; h: number; data: Uint8Array }>>();
  private inflated = new Map<string, Uint8Array>();

  constructor(requestFallback: FallbackFrameRequester) {
    this.requestFallback = requestFallback;
  }

  setImage(id: string, bmp: ImageBitmap): void {
    this.images.get(id)?.close();
    this.images.set(id, bmp);
  }

  private preferSoftware = false;

  setVideo(id: string, blob: Blob): void {
    this.videos.get(id)?.dispose();
    this.videos.set(id, new VideoStream(id, blob, this.preferSoftware));
  }

  setPreferSoftware(on: boolean): void {
    this.preferSoftware = on;
    for (const v of this.videos.values()) v.setSoftware(on);
  }

  setAudio(id: string, channels: Float32Array[], sampleRate: number): void {
    const n = channels[0]?.length ?? 0;
    const mono = new Float32Array(n);
    for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length;
    this.audio.set(id, { mono, sampleRate });
  }

  remove(id: string): void {
    this.images.get(id)?.close();
    this.images.delete(id);
    this.videos.get(id)?.dispose();
    this.videos.delete(id);
    this.audio.delete(id);
    const fb = this.fallbackFrames.get(id);
    fb?.forEach((f) => f.frame.close());
    this.fallbackFrames.delete(id);
  }

  image(id: string): ImageBitmap | null {
    return this.images.get(id) ?? null;
  }

  setMatte(id: string, rev: number, w: number, h: number, data: Uint8Array): void {
    let m = this.mattes.get(id);
    if (!m) this.mattes.set(id, (m = new Map()));
    m.set(rev, { w, h, data });
    this.inflated.delete(`${id}:${rev}`);
  }

  dropMatte(id: string, revs?: number[]): void {
    const m = this.mattes.get(id);
    if (!m) return;
    if (!revs) {
      this.mattes.delete(id);
      for (const k of [...this.inflated.keys()]) if (k.startsWith(`${id}:`)) this.inflated.delete(k);
      return;
    }
    for (const r of revs) {
      m.delete(r);
      this.inflated.delete(`${id}:${r}`);
    }
  }

  matte(id: string, rev: number): { data: Uint8Array; w: number; h: number; key: string } | null {
    const e = this.mattes.get(id)?.get(rev);
    if (!e) return null;
    const ck = `${id}:${rev}`;
    let raw = this.inflated.get(ck);
    if (!raw) {
      raw = inflateSync(e.data);
      this.inflated.set(ck, raw);
      while (this.inflated.size > 12) this.inflated.delete(this.inflated.keys().next().value as string);
    }
    return { data: raw, w: e.w, h: e.h, key: ck };
  }

  /** Make sure frames for the given footage times are decoded (await before a synchronous render). */
  async prepare(needs: Map<string, number[]>): Promise<void> {
    const jobs: Promise<unknown>[] = [];
    for (const [id, times] of needs) {
      const v = this.videos.get(id);
      // ascending order keeps the shared decode iterator moving forward (motion-blur sub-frames, duplicates)
      for (const t of [...new Set(times)].sort((a, b) => a - b)) {
        if (v && !v.failed) {
          jobs.push(v.frameAt(t).then((r) => (r ? r : this.fallback(id, t))));
        } else jobs.push(this.fallback(id, t));
      }
    }
    await Promise.all(jobs);
  }

  private async fallback(id: string, t: number): Promise<DecodedFrame | null> {
    const list = this.fallbackFrames.get(id) ?? [];
    const fd = 1 / 120;
    const hit = list.find((f) => Math.abs(f.start - t) < fd);
    if (hit) return hit;
    let st = this.fallbackStats.get(id);
    if (!st) this.fallbackStats.set(id, (st = newStats()));
    const t0 = performance.now();
    const bmp = await this.requestFallback(id, t);
    this.fallbackAttempts.set(id, (this.fallbackAttempts.get(id) ?? 0) + 1);
    if (!bmp) return null;
    st.decoded++;
    st.decodeMs += performance.now() - t0;
    const d: DecodedFrame = { frame: bmp, start: t, end: t + fd, key: `${id}@fb${t.toFixed(5)}`, w: bmp.width, h: bmp.height };
    list.push(d);
    while (list.length > 6) list.shift()!.frame.close();
    this.fallbackFrames.set(id, list);
    return d;
  }

  /** Decode statistics per video footage (WebCodecs stream, or the <video> fallback when it failed). */
  videoStats(): Record<string, VideoDecodeStats> {
    const out: Record<string, VideoDecodeStats> = {};
    for (const [id, v] of this.videos) {
      const fb = this.fallbackStats.get(id);
      const attempts = this.fallbackAttempts.get(id) ?? 0;
      if (!v.failed) out[id] = { ...v.stats };
      else if (fb && fb.decoded > 0) out[id] = { ...fb, path: 'fallback', codec: v.stats.codec, reason: v.stats.reason };
      else if (attempts > 0) out[id] = { ...v.stats, path: 'failed', reason: `${v.stats.reason ?? 'WebCodecs unavailable'}; the <video> element can't play it either` };
      else out[id] = { ...v.stats };
    }
    return out;
  }

  videoFrame(id: string, t: number): { frame: TexImageSource; key: string; w: number; h: number } | null {
    const v = this.videos.get(id);
    const f = v && !v.failed ? v.cached(t) : null;
    if (f) return { frame: f.frame as unknown as TexImageSource, key: f.key, w: f.w, h: f.h };
    const list = this.fallbackFrames.get(id);
    if (list?.length) {
      let best = list[0];
      for (const x of list) if (Math.abs(x.start - t) < Math.abs(best.start - t)) best = x;
      return { frame: best.frame as unknown as TexImageSource, key: best.key, w: best.w, h: best.h };
    }
    return null;
  }

  audioSamples(id: string, t: number, dur: number): { data: Float32Array; sampleRate: number } | null {
    const a = this.audio.get(id);
    if (!a) return null;
    const s0 = Math.floor(t * a.sampleRate);
    const n = Math.max(1, Math.floor(dur * a.sampleRate));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = s0 + i;
      out[i] = k >= 0 && k < a.mono.length ? a.mono[k] : 0;
    }
    return { data: out, sampleRate: a.sampleRate };
  }
}
