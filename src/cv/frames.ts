// Worker-side client for analysis frames rendered by the render worker over a MessagePort,
// with an LRU of grayscale pyramids and one-frame read-ahead.

import type { Composition, TrackChannel } from '../core/types';
import type { AnalysisReply, AnalysisRequest } from './protocol';
import { blurGray, buildPyramid, toGray, type Pyramid } from './image';

export interface RawFrame {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export class FrameClient {
  private port: MessagePort | null = null;
  private nextReq = 1;
  private pending = new Map<number, { resolve: (f: RawFrame) => void; reject: (e: Error) => void }>();
  private registered = new Set<string>();

  attach(port: MessagePort): void {
    this.port = port;
    port.onmessage = (e: MessageEvent<AnalysisReply>) => {
      const m = e.data;
      const p = this.pending.get(m.reqId);
      if (!p) return;
      this.pending.delete(m.reqId);
      if (m.type === 'frame') p.resolve({ width: m.width, height: m.height, pixels: new Uint8Array(m.pixels) });
      else p.reject(new Error(m.message));
    };
    port.start?.();
  }

  get ready(): boolean {
    return !!this.port;
  }

  register(key: string, comp: Composition): void {
    const msg: AnalysisRequest = { type: 'comp', key, comp };
    this.port?.postMessage(msg);
    this.registered.add(key);
  }

  release(key: string): void {
    if (!this.registered.delete(key)) return;
    const msg: AnalysisRequest = { type: 'dropComp', key };
    this.port?.postMessage(msg);
  }

  frame(key: string, time: number, scale: number): Promise<RawFrame> {
    if (!this.port) return Promise.reject(new Error('analysis channel not connected'));
    const reqId = this.nextReq++;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      const msg: AnalysisRequest = { type: 'frame', reqId, key, time, scale };
      this.port!.postMessage(msg);
    });
  }
}

export interface AnalysisFrame {
  time: number;
  raw: RawFrame;
  pyr: Pyramid;
}

/** Sequential reader over a list of comp times with read-ahead and pyramid construction. */
export class FrameSequence {
  private cache = new Map<number, Promise<AnalysisFrame>>();
  constructor(
    private client: FrameClient,
    private key: string,
    private times: number[],
    private scale: number,
    private channel: TrackChannel,
    private blur: number,
    private levels: number,
  ) {}

  get length(): number {
    return this.times.length;
  }

  private load(i: number): Promise<AnalysisFrame> {
    let p = this.cache.get(i);
    if (!p) {
      const t = this.times[i];
      p = this.client.frame(this.key, t, this.scale).then((raw) => {
        let g = toGray(raw.pixels, raw.width, raw.height, this.channel);
        if (this.blur * this.scale > 0.25) g = blurGray(g, this.blur * this.scale);
        return { time: t, raw, pyr: buildPyramid(g, this.levels) };
      });
      this.cache.set(i, p);
    }
    return p;
  }

  /** Frame i; also starts loading frame i+1 and drops frames older than i−1. */
  async get(i: number): Promise<AnalysisFrame> {
    const f = this.load(i);
    if (i + 1 < this.times.length) void this.load(i + 1).catch(() => {});
    for (const k of [...this.cache.keys()]) if (k < i - 1 || k > i + 1) this.cache.delete(k);
    return f;
  }
}
