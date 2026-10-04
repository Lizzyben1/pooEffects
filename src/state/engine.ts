// Engine wiring: the singleton RenderHost, project → worker sync, view parameters shared between
// the viewer, the playback controller and background (predictive) cache rendering.

import { RenderHost, type FrameResult } from '../render/host';
import type { RenderOptions, ViewSpec } from '../render/renderer';
import { BUNDLED_FONTS } from '../fonts';
import { attachHost } from './media';
import { getApp, setApp, useApp } from './store';
import * as cache from './cache';
import { getTime, timeStore } from './time';
import { exactFps, timeToFrame } from '../core/time';
import type { Project } from '../core/types';

export const host = new RenderHost(BUNDLED_FONTS);

export interface ViewParams {
  compId: string;
  scale: number;
  motionBlur: boolean;
  draft: boolean;
}

let viewParams: ViewParams | null = null;

export function cfgKey(p: Pick<ViewParams, 'scale' | 'motionBlur' | 'draft'>): string {
  return `${p.scale.toFixed(4)}|${p.motionBlur ? 1 : 0}|${p.draft ? 1 : 0}`;
}

export function setViewParams(p: ViewParams): void {
  if (viewParams && viewParams.compId === p.compId && viewParams.scale === p.scale && viewParams.motionBlur === p.motionBlur && viewParams.draft === p.draft) return;
  viewParams = p;
  scheduleBackground();
}

export function getViewParams(): ViewParams | null {
  return viewParams;
}

export function renderOptions(compId: string, time: number, p: Pick<ViewParams, 'scale' | 'motionBlur' | 'draft'>, view?: ViewSpec): RenderOptions {
  return { compId, time, scale: p.scale, motionBlur: p.motionBlur, draft: p.draft, guides: true, view: view ?? { kind: 'active' } };
}

/** Render a frame for caching; resolves true when stored. */
export async function renderToCache(compId: string, frame: number, p: ViewParams): Promise<boolean> {
  const project = getApp().project;
  const comp = project.comps[compId];
  if (!comp) return false;
  const t = frame / exactFps(comp.frameRate);
  const r = await host.render('cache', 'cache', renderOptions(compId, t, p), null);
  if (!r) return false;
  return cache.put(project, compId, frame, cfgKey(p), r.bitmap);
}

/** Viewer render with cache lookup/population (active camera view only). */
export async function renderForView(viewKey: string, compId: string, time: number, p: ViewParams, view: ViewSpec): Promise<{ bitmap: ImageBitmap; cached: boolean; result?: FrameResult } | null> {
  const project = getApp().project;
  const comp = project.comps[compId];
  if (!comp) return null;
  const fps = exactFps(comp.frameRate);
  const frame = timeToFrame(time, fps);
  const cfg = cfgKey(p);
  const cacheable = view.kind === 'active';
  if (cacheable) {
    const hit = cache.get(compId, frame, cfg);
    if (hit) return { bitmap: hit, cached: true };
  }
  const r = await host.render(viewKey, 'view', renderOptions(compId, frame / fps, p, view), null);
  if (!r) return null;
  setApp({ renderStats: { ms: r.ms, layers: r.layers, fps: getApp().renderStats.fps } });
  if (cacheable && getApp().txDepth === 0) {
    // keep a reference in the cache when allowed; the cache owns the bitmap from then on
    const stored = cache.put(project, compId, frame, cfg, r.bitmap);
    if (stored) return { bitmap: cache.get(compId, frame, cfg)!, cached: true, result: r };
    return null;
  }
  return { bitmap: r.bitmap, cached: false, result: r };
}

// ── predictive background rendering ─────────────────────────────────────────

let bgTimer: ReturnType<typeof setTimeout> | null = null;
let bgInflight = 0;
let bgGeneration = 0;

export function scheduleBackground(delay = 450): void {
  if (bgTimer) clearTimeout(bgTimer);
  bgGeneration++;
  bgTimer = setTimeout(() => {
    bgTimer = null;
    pumpBackground(bgGeneration);
  }, delay);
}

function pumpBackground(gen: number): void {
  const s = getApp();
  const p = viewParams;
  if (!s.prefs.backgroundRender || !p || timeStore.getState().playing || gen !== bgGeneration || s.txDepth > 0) return;
  const comp = s.project.comps[p.compId];
  if (!comp) return;
  const fps = exactFps(comp.frameRate);
  const cfg = cfgKey(p);
  const first = Math.ceil(comp.workArea[0] * fps - 1e-6);
  const last = Math.ceil(comp.workArea[1] * fps - 1e-6) - 1;
  const cur = Math.max(first, Math.min(last, timeToFrame(getTime(comp.id), fps)));
  const est = Math.round(comp.width * p.scale) * Math.round(comp.height * p.scale) * 4;
  while (bgInflight < 2) {
    let next = -1;
    for (let k = 0; k <= last - first; k++) {
      const f = first + ((cur - first + k) % (last - first + 1));
      if (!cache.has(comp.id, f, cfg) && !pendingBg.has(f)) {
        next = f;
        break;
      }
    }
    if (next < 0 || !cache.hasRoom(est)) return;
    bgInflight++;
    pendingBg.add(next);
    const f = next;
    void renderToCache(comp.id, f, p).finally(() => {
      bgInflight--;
      pendingBg.delete(f);
      if (gen === bgGeneration) setTimeout(() => pumpBackground(gen), 0);
    });
  }
}

const pendingBg = new Set<number>();

export function cancelBackground(): void {
  bgGeneration++;
  if (bgTimer) clearTimeout(bgTimer);
  bgTimer = null;
  host.cancel('cache');
}

// ── startup ─────────────────────────────────────────────────────────────────

let started = false;

export function startEngine(): Promise<unknown> {
  if (started) return host.ready;
  started = true;
  attachHost(host);
  host.onErrors = (errors) => {
    const map: Record<string, string> = {};
    for (const [k, v] of errors) map[k] = v;
    const cur = getApp().exprErrors;
    const same = Object.keys(map).length === Object.keys(cur).length && Object.entries(map).every(([k, v]) => cur[k] === v);
    if (!same) setApp({ exprErrors: map });
  };
  host.start();
  host.setProject(getApp().project);
  let lastProject: Project = getApp().project;
  useApp.subscribe((s) => {
    if (s.project === lastProject) return;
    lastProject = s.project;
    host.setProject(s.project);
    const dropped = cache.validate(s.project);
    if (dropped.length) cancelBackground();
    scheduleBackground(700);
  });
  timeStore.subscribe((s, prev) => {
    if (s.playing !== prev.playing && !s.playing) scheduleBackground(600);
  });
  return host.ready;
}
