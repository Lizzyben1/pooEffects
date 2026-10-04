// ─────────────────────────────────────────────────────────────────────────────
// Playback controller (RAM preview).
//   • If every frame of the work area is cached, playback is REAL-TIME, clocked
//     by the AudioContext when the comp has audio (frame-locked A/V sync).
//   • Otherwise it plays "render-as-you-go": frames are pre-rendered by the
//     worker a few ahead, cached (green bar fills in) and shown as soon as they
//     arrive — never faster than the comp frame rate. Once the whole range is
//     cached, playback switches to real-time automatically on the next loop.
// ─────────────────────────────────────────────────────────────────────────────

import { exactFps, timeToFrame } from '../core/time';
import { getApp, setApp } from './store';
import { getTime, setTime, timeStore } from './time';
import * as cache from './cache';
import { cancelBackground, cfgKey, getViewParams, renderToCache, type ViewParams } from './engine';
import { audioContext, compHasAudio, playComp, resumeAudio, stopAudio, setMuted } from '../audio/engine';

interface PlayState {
  compId: string;
  fps: number;
  first: number;
  last: number;
  frame: number;
  realtime: boolean;
  startFrame: number;
  wallStart: number;
  audioWhen0: number;
  audio: boolean;
  lastAdvance: number;
  inflight: Set<number>;
  params: ViewParams;
  frames: number;
  fpsWindowStart: number;
}

let st: PlayState | null = null;
let raf = 0;
let loop = true;
let muted = false;

export const isLooping = () => loop;
export function setLoop(v: boolean): void {
  loop = v;
}
export const isMuted = () => muted;
export function toggleMute(): void {
  muted = !muted;
  setMuted(muted);
}

function allCached(s: PlayState): boolean {
  const cfg = cfgKey(s.params);
  for (let f = s.first; f <= s.last; f++) if (!cache.has(s.compId, f, cfg)) return false;
  return true;
}

function beginRealtime(s: PlayState, now: number): void {
  s.realtime = true;
  s.startFrame = s.frame;
  s.wallStart = now;
  const app = getApp();
  const comp = app.project.comps[s.compId];
  s.audio = false;
  if (comp && !muted && compHasAudio(app.project, comp)) {
    s.audioWhen0 = playComp(app.project, comp, s.frame / s.fps, (s.last + 1) / s.fps);
    s.audio = true;
  }
  timeStore.setState({ realtime: true });
}

function endRealtime(s: PlayState): void {
  s.realtime = false;
  if (s.audio) stopAudio();
  s.audio = false;
  timeStore.setState({ realtime: false });
}

export function play(): void {
  const app = getApp();
  const compId = app.activeCompId;
  const comp = compId ? app.project.comps[compId] : null;
  const params = getViewParams();
  if (!comp || !compId) return;
  resumeAudio();
  cancelBackground();
  const fps = exactFps(comp.frameRate);
  const first = Math.max(0, Math.ceil(comp.workArea[0] * fps - 1e-6));
  const last = Math.max(first, Math.ceil(comp.workArea[1] * fps - 1e-6) - 1);
  let frame = timeToFrame(getTime(compId), fps);
  if (frame < first || frame >= last) frame = first;
  const p: ViewParams = params && params.compId === compId ? params : { compId, scale: 0.5, motionBlur: true, draft: false };
  st = {
    compId, fps, first, last, frame, realtime: false, startFrame: frame, wallStart: performance.now(), audioWhen0: 0, audio: false,
    lastAdvance: 0, inflight: new Set(), params: p, frames: 0, fpsWindowStart: performance.now(),
  };
  setTime(compId, frame / fps);
  timeStore.setState({ playing: true, playCompId: compId });
  if (allCached(st)) beginRealtime(st, performance.now());
  else timeStore.setState({ realtime: false });
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

export function stop(): void {
  cancelAnimationFrame(raf);
  if (st) endRealtime(st);
  st = null;
  stopAudio();
  timeStore.setState({ playing: false, playCompId: null, playFps: 0 });
}

export function togglePlay(): void {
  if (timeStore.getState().playing) stop();
  else play();
}

function prefetch(s: PlayState): void {
  const cfg = cfgKey(s.params);
  const est = Math.round(getApp().project.comps[s.compId]?.width ?? 1920) * s.params.scale * Math.round(getApp().project.comps[s.compId]?.height ?? 1080) * s.params.scale * 4;
  for (let k = 1; k <= 6 && s.inflight.size < 3; k++) {
    let f = s.frame + k;
    if (f > s.last) {
      if (!loop) break;
      f = s.first + (f - s.last - 1);
    }
    if (cache.has(s.compId, f, cfg) || s.inflight.has(f)) continue;
    if (!cache.hasRoom(est)) break;
    s.inflight.add(f);
    const frame = f;
    const params = s.params;
    void renderToCache(s.compId, frame, params).finally(() => s.inflight.delete(frame));
  }
}

function tick(now: number): void {
  const s = st;
  if (!s) return;
  const comp = getApp().project.comps[s.compId];
  if (!comp || getApp().activeCompId !== s.compId) {
    stop();
    return;
  }
  // track work-area edits during playback
  const first = Math.max(0, Math.ceil(comp.workArea[0] * s.fps - 1e-6));
  const last = Math.max(first, Math.ceil(comp.workArea[1] * s.fps - 1e-6) - 1);
  if (first !== s.first || last !== s.last) {
    s.first = first;
    s.last = last;
    if (s.realtime) endRealtime(s);
  }
  const cfg = cfgKey(s.params);
  let advanced = false;
  if (s.realtime) {
    const elapsed = s.audio ? audioContext().currentTime - s.audioWhen0 : (now - s.wallStart) / 1000;
    let f = s.startFrame + Math.floor(Math.max(0, elapsed) * s.fps + 1e-6);
    if (f > s.last) {
      if (!loop) {
        setTime(s.compId, s.last / s.fps);
        stop();
        return;
      }
      s.frame = s.first;
      endRealtime(s);
      if (allCached(s)) beginRealtime(s, now);
      f = s.first;
    }
    if (!cache.has(s.compId, f, cfg)) {
      endRealtime(s);
    } else if (f !== s.frame || !advanced) {
      if (f !== s.frame) {
        s.frame = f;
        s.frames++;
        setTime(s.compId, f / s.fps);
      }
      advanced = true;
    }
  }
  if (!s.realtime) {
    prefetch(s);
    let next = s.frame + 1;
    let wrapped = false;
    if (next > s.last) {
      if (!loop) {
        stop();
        return;
      }
      next = s.first;
      wrapped = true;
    }
    if (cache.has(s.compId, next, cfg) && now - s.lastAdvance >= 1000 / s.fps - 2) {
      s.frame = next;
      s.lastAdvance = now;
      s.frames++;
      setTime(s.compId, next / s.fps);
      if (wrapped && allCached(s)) beginRealtime(s, now);
    }
  }
  if (now - s.fpsWindowStart > 500) {
    timeStore.setState({ playFps: (s.frames * 1000) / (now - s.fpsWindowStart) });
    setApp({ renderStats: { ...getApp().renderStats, fps: (s.frames * 1000) / (now - s.fpsWindowStart) } });
    s.frames = 0;
    s.fpsWindowStart = now;
  }
  raf = requestAnimationFrame(tick);
}

