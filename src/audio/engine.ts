// ─────────────────────────────────────────────────────────────────────────────
// Audio engine (Web Audio API)
//   • playback: schedules every audible layer (recursing into precomps) on the
//     AudioContext clock; the playback loop uses ctx.currentTime as its master
//     clock so picture and sound stay locked;
//   • scrubbing: plays short frame-sized snippets while dragging the CTI;
//   • mixdown: renders the comp's audio offline for export.
// Audio levels (dB) are keyframeable and scheduled as gain automation.
// ─────────────────────────────────────────────────────────────────────────────

import type { Composition, Layer, Project } from '../core/types';
import { stretchFactor } from '../core/evaluate';
import { keyframedValue } from '../anim/interpolate';
import { getMedia } from '../state/media';
import { frameDuration } from '../core/time';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let live: { src: AudioBufferSourceNode; gain: GainNode }[] = [];
const reversedCache = new WeakMap<AudioBuffer, AudioBuffer>();

export function audioContext(): AudioContext {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  return ctx;
}

export function resumeAudio(): void {
  const c = audioContext();
  if (c.state === 'suspended') void c.resume();
}

export function setMuted(muted: boolean): void {
  audioContext();
  if (master) master.gain.value = muted ? 0 : 1;
}

function reversed(buf: AudioBuffer, c: BaseAudioContext): AudioBuffer {
  let r = reversedCache.get(buf);
  if (!r) {
    r = c.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const src = buf.getChannelData(ch);
      const dst = r.getChannelData(ch);
      for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
    }
    reversedCache.set(buf, r);
  }
  return r;
}

const dbToGain = (db: number) => Math.pow(10, db / 20);

interface Mapping {
  /** comp-local time → seconds on the target clock (relative to `when0`) */
  toClock: (t: number) => number;
  /** playback-rate multiplier accumulated through nested precomps */
  rate: number;
}

/**
 * Schedule all audible layers of `comp` for comp-local times in [t0, t1).
 * `toClock` maps comp time to context time offset; `rate` is the accumulated speed factor.
 */
function scheduleComp(
  c: BaseAudioContext, dest: AudioNode, project: Project, comp: Composition, t0: number, t1: number, map: Mapping,
  out: { src: AudioBufferSourceNode; gain: GainNode }[], depth = 0,
): void {
  if (depth > 8) return;
  const anySolo = comp.layers.some((l) => l.solo && l.audioEnabled);
  for (const layer of comp.layers) {
    if (!layer.audioEnabled || (anySolo && !layer.solo)) continue;
    const a = Math.max(t0, Math.min(layer.inPoint, layer.outPoint));
    const b = Math.min(t1, Math.max(layer.inPoint, layer.outPoint));
    if (b <= a) continue;
    const k = stretchFactor(layer);
    if (layer.type === 'precomp' && layer.source?.compId) {
      const nested = project.comps[layer.source.compId];
      if (!nested) continue;
      const n0 = (a - layer.startTime) / k, n1 = (b - layer.startTime) / k;
      if (k < 0) continue; // reversed precomp audio is not supported
      scheduleComp(c, dest, project, nested, n0, n1, {
        toClock: (nt) => map.toClock(layer.startTime + nt * k),
        rate: map.rate / k,
      }, out, depth + 1);
      continue;
    }
    const fid = layer.source?.footageId;
    if (!fid) continue;
    const f = project.footage[fid];
    if (!f || !f.hasAudio) continue;
    const buf = getMedia(fid)?.audio;
    if (!buf) continue;
    // level automation (dB average of L/R), shared by every source this layer schedules
    const lv = layer.audio?.levels;
    const levelAt = (t: number) => {
      if (!lv) return 1;
      const v = lv.keyframes.length ? keyframedValue(lv, (t - layer.startTime) / k, false) : lv.value;
      return dbToGain(((v[0] ?? 0) + (v[1] ?? 0)) / 2);
    };
    const makeGain = (from: number, to: number): GainNode => {
      const gain = c.createGain();
      gain.connect(dest);
      if (lv && lv.keyframes.length) {
        const step = frameDuration(comp.frameRate);
        for (let t = from; t < to; t += step) gain.gain.setValueAtTime(levelAt(t), Math.max(0, map.toClock(t)));
      } else gain.gain.value = levelAt(from);
      return gain;
    };

    if (layer.timeRemapEnabled && layer.timeRemap.keyframes.length) {
      // Time remapping: the source position follows the remap curve. Each stretch where the curve runs
      // forwards (or backwards) becomes one source whose playback rate is automated to the curve's slope,
      // so the sound speeds up, slows down and reverses with the picture. Freeze frames are silent.
      const srcAt = (t: number) => keyframedValue(layer.timeRemap, (t - layer.startTime) / k, false) as number;
      const step = Math.max(1 / 120, frameDuration(comp.frameRate) / 2);
      const flush = (s0: number, s1: number, dir: number, rates: number[]) => {
        if (!dir || s1 - s0 < 1e-6) return;
        const srcBuf = dir > 0 ? buf : reversed(buf, c);
        const pos = Math.min(buf.duration, Math.max(0, srcAt(s0)));
        const offset = dir > 0 ? pos : buf.duration - pos;
        if (offset >= buf.duration - 1e-4) return;
        const src = c.createBufferSource();
        src.buffer = srcBuf;
        const gain = makeGain(s0, s1);
        src.connect(gain);
        rates.forEach((r, i) => src.playbackRate.setValueAtTime(Math.min(16, Math.max(0.01, r * map.rate)), Math.max(0, map.toClock(s0 + i * step))));
        src.start(Math.max(c.currentTime, map.toClock(s0)), offset);
        src.stop(Math.max(c.currentTime, map.toClock(s1)));
        out.push({ src, gain });
      };
      let runStart = a, dir = 0, rates: number[] = [];
      for (let t = a; t < b - 1e-9; t += step) {
        const t2 = Math.min(b, t + step);
        const ds = srcAt(t2) - srcAt(t);
        const d = ds > 1e-7 ? 1 : ds < -1e-7 ? -1 : 0;
        if (d !== dir) {
          flush(runStart, t, dir, rates);
          runStart = t;
          dir = d;
          rates = [];
        }
        rates.push(Math.abs(ds) / (t2 - t));
      }
      flush(runStart, b, dir, rates);
      continue;
    }

    const reverse = k < 0;
    const ak = Math.abs(k);
    let offset = (a - layer.startTime) / k;
    const dur = (b - a) / ak;
    let useBuf = buf;
    if (reverse) {
      useBuf = reversed(buf, c);
      offset = buf.duration - offset;
    }
    if (offset >= useBuf.duration || offset + dur <= 0) continue;
    const startDelay = Math.max(0, -offset);
    const src = c.createBufferSource();
    src.buffer = useBuf;
    src.playbackRate.value = map.rate / ak;
    const gain = makeGain(a, b);
    src.connect(gain);
    const when = map.toClock(a) + startDelay;
    src.start(Math.max(c.currentTime, when), Math.max(0, offset), Math.max(0.001, dur - startDelay));
    out.push({ src, gain });
  }
}

/** Start comp audio at comp time `t`; returns the context time that corresponds to `t`. */
export function playComp(project: Project, comp: Composition, t: number, end: number): number {
  const c = audioContext();
  stopAudio();
  const when0 = c.currentTime + 0.06;
  scheduleComp(c, master!, project, comp, t, end, { toClock: (x) => when0 + (x - t), rate: 1 }, live);
  return when0;
}

export function stopAudio(): void {
  for (const { src } of live) {
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
    src.disconnect();
  }
  live = [];
}

let scrubTimer: ReturnType<typeof setTimeout> | null = null;

/** Play a short snippet at time t (audio scrubbing). */
export function scrubAt(project: Project, comp: Composition, t: number): void {
  if (!compHasAudio(project, comp)) return;
  const c = audioContext();
  resumeAudio();
  stopAudio();
  const len = Math.max(frameDuration(comp.frameRate) * 2, 0.07);
  const when0 = c.currentTime + 0.01;
  scheduleComp(c, master!, project, comp, t, t + len, { toClock: (x) => when0 + (x - t), rate: 1 }, live);
  if (scrubTimer) clearTimeout(scrubTimer);
  scrubTimer = setTimeout(stopAudio, len * 1000 + 40);
}

export function compHasAudio(project: Project, comp: Composition, depth = 0): boolean {
  if (depth > 8) return false;
  return comp.layers.some((l: Layer) => {
    if (!l.audioEnabled) return false;
    if (l.type === 'precomp' && l.source?.compId) {
      const n = project.comps[l.source.compId];
      return !!n && compHasAudio(project, n, depth + 1);
    }
    const f = l.source?.footageId ? project.footage[l.source.footageId] : undefined;
    return !!f?.hasAudio && !!getMedia(f.id)?.audio;
  });
}

/** Offline mixdown of [start, end) for export. */
export async function mixdown(project: Project, comp: Composition, start: number, end: number, sampleRate = 48000): Promise<{ channels: Float32Array[]; sampleRate: number } | null> {
  if (!compHasAudio(project, comp)) return null;
  const length = Math.max(1, Math.ceil((end - start) * sampleRate));
  const oc = new OfflineAudioContext(2, length, sampleRate);
  const nodes: { src: AudioBufferSourceNode; gain: GainNode }[] = [];
  scheduleComp(oc, oc.destination, project, comp, start, end, { toClock: (x) => x - start, rate: 1 }, nodes);
  const rendered = await oc.startRendering();
  return { channels: [rendered.getChannelData(0).slice(), rendered.getChannelData(1).slice()], sampleRate };
}

