// Worker-side media store: still images, frame-accurate video decoding (WebCodecs via mediabunny,
// with a main-thread <video> fallback), audio samples for audio-reactive effects, and fonts.

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type InputVideoTrack, type VideoSample } from 'mediabunny';
import type { AssetHost } from './renderer';

interface DecodedFrame {
  frame: VideoFrame | ImageBitmap;
  start: number;
  end: number;
  key: string;
  w: number;
  h: number;
}

/** Sequential-friendly frame access for one video file. */
class VideoStream {
  private input: Input | null = null;
  private track: InputVideoTrack | null = null;
  private sink: VideoSampleSink | null = null;
  private iter: AsyncGenerator<VideoSample, void, unknown> | null = null;
  private lastStart = -1;
  private cache: DecodedFrame[] = [];
  failed = false;
  ready: Promise<void>;
  readonly id: string;

  constructor(id: string, blob: Blob) {
    this.id = id;
    this.ready = this.open(blob);
  }

  private async open(blob: Blob): Promise<void> {
    try {
      this.input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      this.track = await this.input.getPrimaryVideoTrack();
      if (!this.track || !(await this.track.canDecode())) throw new Error('video track not decodable');
      this.sink = new VideoSampleSink(this.track);
    } catch {
      this.failed = true;
    }
  }

  cached(t: number): DecodedFrame | null {
    for (const f of this.cache) if (t >= f.start - 1e-4 && t < f.end - 1e-4) return f;
    return null;
  }

  private store(sample: VideoSample): DecodedFrame {
    const vf = sample.toVideoFrame();
    const d: DecodedFrame = {
      frame: vf,
      start: sample.timestamp,
      end: sample.timestamp + Math.max(1e-3, sample.duration || 1 / 30),
      key: `${this.id}@${sample.timestamp.toFixed(6)}`,
      w: vf.displayWidth,
      h: vf.displayHeight,
    };
    sample.close();
    this.cache.push(d);
    while (this.cache.length > 10) {
      const old = this.cache.shift()!;
      old.frame.close();
    }
    return d;
  }

  private resetIter(): void {
    if (this.iter) void this.iter.return(undefined);
    this.iter = null;
  }

  async frameAt(t: number): Promise<DecodedFrame | null> {
    await this.ready;
    if (this.failed || !this.sink) return null;
    const hit = this.cached(t);
    if (hit) return hit;
    try {
      const forward = this.iter && t >= this.lastStart && t - this.lastStart < 1.5;
      if (!forward) {
        this.resetIter();
        this.iter = this.sink.samples(Math.max(0, t - 1e-3));
      }
      let prev: VideoSample | null = null;
      for (let guard = 0; guard < 900; guard++) {
        const r = await this.iter!.next();
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
        return this.store(s);
      }
      // requested time is past the last frame: hold the final frame
      if (prev) return this.store(prev);
      return this.cache[this.cache.length - 1] ?? null;
    } catch {
      this.resetIter();
      try {
        const s = await this.sink.getSample(t);
        return s ? this.store(s) : null;
      } catch {
        this.failed = true;
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

  constructor(requestFallback: FallbackFrameRequester) {
    this.requestFallback = requestFallback;
  }

  setImage(id: string, bmp: ImageBitmap): void {
    this.images.get(id)?.close();
    this.images.set(id, bmp);
  }

  setVideo(id: string, blob: Blob): void {
    this.videos.get(id)?.dispose();
    this.videos.set(id, new VideoStream(id, blob));
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

  /** Make sure frames for the given footage times are decoded (await before a synchronous render). */
  async prepare(needs: Map<string, number[]>): Promise<void> {
    const jobs: Promise<unknown>[] = [];
    for (const [id, times] of needs) {
      const v = this.videos.get(id);
      for (const t of times) {
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
    const bmp = await this.requestFallback(id, t);
    if (!bmp) return null;
    const d: DecodedFrame = { frame: bmp, start: t, end: t + fd, key: `${id}@fb${t.toFixed(5)}`, w: bmp.width, h: bmp.height };
    list.push(d);
    while (list.length > 6) list.shift()!.frame.close();
    this.fallbackFrames.set(id, list);
    return d;
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
