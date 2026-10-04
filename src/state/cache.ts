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
  used: number;
  compId: string;
  frame: number;
  cfg: string;
}

const entries = new Map<string, Entry>();
const signatures = new Map<string, unknown[]>();
let totalBytes = 0;
let tick = 0;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

const keyOf = (compId: string, frame: number, cfg: string) => `${compId}|${frame}|${cfg}`;

function notify(): void {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    setApp((s) => ({ cacheVersion: s.cacheVersion + 1 }));
  }, 60);
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
      e.bmp.close();
      totalBytes -= e.bytes;
      entries.delete(k);
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

export function put(project: Project, compId: string, frame: number, cfg: string, bmp: ImageBitmap): boolean {
  const comp = project.comps[compId];
  if (!comp) {
    bmp.close();
    return false;
  }
  // a frame rendered from an outdated document must not enter the cache
  const sig = signature(project, comp);
  const known = signatures.get(compId);
  if (!known) signatures.set(compId, sig);
  else if (!sameSig(known, sig)) {
    bmp.close();
    return false;
  }
  const k = keyOf(compId, frame, cfg);
  const old = entries.get(k);
  if (old) {
    old.bmp.close();
    totalBytes -= old.bytes;
  }
  const bytes = bmp.width * bmp.height * 4;
  entries.set(k, { bmp, bytes, used: ++tick, compId, frame, cfg });
  totalBytes += bytes;
  const budget = budgetBytes();
  if (totalBytes > budget) {
    const sorted = [...entries.values()].sort((a, b) => a.used - b.used);
    for (const e of sorted) {
      if (totalBytes <= budget * 0.9) break;
      if (e === entries.get(k)) continue;
      e.bmp.close();
      totalBytes -= e.bytes;
      entries.delete(keyOf(e.compId, e.frame, e.cfg));
    }
  }
  notify();
  return true;
}

export function get(compId: string, frame: number, cfg: string): ImageBitmap | null {
  const e = entries.get(keyOf(compId, frame, cfg));
  if (!e) return null;
  e.used = ++tick;
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
  for (const e of entries.values()) e.bmp.close();
  entries.clear();
  signatures.clear();
  totalBytes = 0;
  notify();
}

export function stats(): { frames: number; mb: number; budgetMb: number } {
  return { frames: entries.size, mb: totalBytes / 1048576, budgetMb: budgetBytes() / 1048576 };
}

/** Is it budget-feasible to keep caching more frames? */
export function hasRoom(nextBytes: number): boolean {
  return totalBytes + nextBytes <= budgetBytes() * 0.98;
}
