// ─────────────────────────────────────────────────────────────────────────────
// RAM preview frame cache.
// Rendered frames (ImageBitmaps transferred from the render worker) are kept
// per composition and render configuration. Invalidation is dependency based:
// thanks to immer's structural sharing, a composition is unchanged exactly when
// the object references of the comp, every nested precomp and every footage
// item it uses are unchanged — a cheap shallow comparison per document edit.
// ─────────────────────────────────────────────────────────────────────────────

import type { Composition, Project } from '../core/types';
import { getApp, setApp } from './store';

interface Entry {
  bmp: ImageBitmap;
  bytes: number;
  compId: string;
  frame: number;
  cfg: string;
}

/** Insertion order is recency order: a hit re-inserts its entry, so the first entries are the least recently used. */
const entries = new Map<string, Entry>();
const signatures = new Map<string, unknown[]>();
let totalBytes = 0;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

/** Bitmaps a viewer is currently showing (ref-counted). They are never closed while pinned. */
const pins = new Map<ImageBitmap, number>();
/** Pinned bitmaps that have left the cache: closed when their last pin is released. */
const orphans = new Set<ImageBitmap>();

const keyOf = (compId: string, frame: number, cfg: string) => `${compId}|${frame}|${cfg}`;

function notify(): void {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    setApp((s) => ({ cacheVersion: s.cacheVersion + 1 }));
  }, 60);
}

/** Release a bitmap that left the cache — unless a viewer is still painting it. */
function discard(bmp: ImageBitmap): void {
  if (pins.has(bmp)) orphans.add(bmp);
  else bmp.close();
}

function remove(k: string, e: Entry): void {
  entries.delete(k);
  totalBytes -= e.bytes;
  discard(e.bmp);
}

/**
 * Keep a cached bitmap alive while a viewer displays it. Without this, evicting or invalidating the
 * frame on screen closes the bitmap under the viewer and the next repaint (pan, zoom, resize) goes blank.
 */
export function pin(bmp: ImageBitmap): void {
  pins.set(bmp, (pins.get(bmp) ?? 0) + 1);
}

export function unpin(bmp: ImageBitmap): void {
  const n = (pins.get(bmp) ?? 0) - 1;
  if (n > 0) {
    pins.set(bmp, n);
    return;
  }
  pins.delete(bmp);
  if (orphans.delete(bmp)) bmp.close();
}

function signature(project: Project, comp: Composition, out: unknown[] = [], seen = new Set<string>()): unknown[] {
  if (seen.has(comp.id)) return out;
  seen.add(comp.id);
  out.push(comp);
  for (const l of comp.layers) {
    if (l.source?.compId) {
      const n = project.comps[l.source.compId];
      out.push(n);
      if (n) signature(project, n, out, seen);
    }
    if (l.source?.footageId) out.push(project.footage[l.source.footageId]);
    // roto mattes live outside the comp tree; their info object changes whenever pixels do
    for (const fx of l.effects) if (fx.type === 'rotoBrush') out.push(project.mattes?.[fx.params.matte?.value as string]);
  }
  return out;
}

function sameSig(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function dropComp(compId: string): void {
  let changed = false;
  for (const [k, e] of entries) {
    if (e.compId === compId) {
      remove(k, e);
      changed = true;
    }
  }
  if (changed) notify();
}

/** Re-validate all cached comps against the new project. Returns ids of comps that were invalidated. */
export function validate(project: Project): string[] {
  const dropped: string[] = [];
  for (const [compId, sig] of signatures) {
    const comp = project.comps[compId];
    if (!comp) {
      dropComp(compId);
      signatures.delete(compId);
      dropped.push(compId);
      continue;
    }
    const next = signature(project, comp);
    if (!sameSig(sig, next)) {
      dropComp(compId);
      signatures.set(compId, next);
      dropped.push(compId);
    }
  }
  return dropped;
}

function budgetBytes(): number {
  return getApp().prefs.cacheBudgetMB * 1024 * 1024;
}

/**
 * Make room down to `target` bytes. Frames of other compositions / render settings go first (they are
 * the least likely to be needed again), then the least recently used frames of the current one.
 */
function evict(target: number, keep: string, compId: string, cfg: string): void {
  if (totalBytes <= target) return;
  for (const own of [false, true]) {
    for (const [k, e] of entries) {
      if (totalBytes <= target) return;
      if (k === keep || (e.compId === compId && e.cfg === cfg) !== own) continue;
      remove(k, e);
    }
  }
}

/**
 * Store a rendered frame. Returns false — leaving the bitmap with the caller — when the frame was
 * rendered from a document that has since changed and must not enter the cache.
 */
export function put(project: Project, compId: string, frame: number, cfg: string, bmp: ImageBitmap): boolean {
  const comp = project.comps[compId];
  if (!comp) return false;
  const sig = signature(project, comp);
  const known = signatures.get(compId);
  if (!known) signatures.set(compId, sig);
  else if (!sameSig(known, sig)) return false;
  const k = keyOf(compId, frame, cfg);
  const old = entries.get(k);
  if (old) remove(k, old);
  const bytes = bmp.width * bmp.height * 4;
  entries.set(k, { bmp, bytes, compId, frame, cfg });
  totalBytes += bytes;
  const budget = budgetBytes();
  if (totalBytes > budget) evict(budget * 0.9, k, compId, cfg);
  notify();
  return true;
}

export function get(compId: string, frame: number, cfg: string): ImageBitmap | null {
  const k = keyOf(compId, frame, cfg);
  const e = entries.get(k);
  if (!e) return null;
  // mark as most recently used
  entries.delete(k);
  entries.set(k, e);
  return e.bmp;
}

export function has(compId: string, frame: number, cfg: string): boolean {
  return entries.has(keyOf(compId, frame, cfg));
}

export function cachedFrames(compId: string, cfg: string): Set<number> {
  const out = new Set<number>();
  for (const e of entries.values()) if (e.compId === compId && e.cfg === cfg) out.add(e.frame);
  return out;
}

export function clearAll(): void {
  for (const e of entries.values()) discard(e.bmp);
  entries.clear();
  signatures.clear();
  totalBytes = 0;
  notify();
}

export function stats(): { frames: number; mb: number; budgetMb: number } {
  return { frames: entries.size, mb: totalBytes / 1048576, budgetMb: budgetBytes() / 1048576 };
}

/** Can a frame of this size be cached at all? (Playback keeps rendering; older frames are evicted to make room.) */
export function hasRoom(nextBytes: number): boolean {
  return nextBytes <= budgetBytes() * 0.95;
}

/**
 * Is there room to cache one more frame of this comp / configuration WITHOUT evicting its own frames?
 * Background caching stops when this turns false — otherwise a work area larger than the budget would
 * be re-rendered forever, each new frame pushing out one that then has to be rendered again.
 */
export function hasRoomFor(compId: string, cfg: string, nextBytes: number): boolean {
  const budget = budgetBytes();
  if (nextBytes > budget * 0.95) return false;
  if (totalBytes + nextBytes <= budget) return true;
  let foreign = 0;
  for (const e of entries.values()) if (e.compId !== compId || e.cfg !== cfg) foreign += e.bytes;
  return totalBytes - foreign + nextBytes <= budget;
}
