// ─────────────────────────────────────────────────────────────────────────────
// Roto matte store (UI thread). Every segmentation result is stored as an
// immutable, deflate-compressed revision; the document's MatteInfo maps
// frame → revision, which makes undo/redo of roto work exact. Revisions are
// mirrored to the render worker (for the Roto Brush effect), persisted in
// IndexedDB next to the media, and written into .pooe project files.
// ─────────────────────────────────────────────────────────────────────────────

import { deflateSync, inflateSync } from 'fflate';
import type { MatteInfo, Project } from '../core/types';
import { host } from './engine';
import { idbGet, idbPut } from './media';
import { traceContours, simplifyClosed, type Pt } from '../cv/mask';

interface Rev {
  w: number;
  h: number;
  data: Uint8Array;
}

const revs = new Map<string, Map<number, Rev>>();
const raw = new Map<string, Uint8Array>();
let revCounter = Date.now() * 1000;

export const newRevId = (): number => ++revCounter;

const idbKey = (id: string, rev: number) => `matte/${id}/${rev}`;

function sendToHost(id: string, rev: number, r: Rev): void {
  const copy = r.data.slice();
  host.post({ type: 'matte', id, rev, w: r.w, h: r.h, data: copy }, host.mode === 'worker' ? [copy.buffer] : []);
}

/** Store a new matte revision (8-bit alpha, w×h). Returns its revision id. */
export function putMatte(id: string, w: number, h: number, alpha: Uint8Array): number {
  const rev = newRevId();
  const r: Rev = { w, h, data: deflateSync(alpha, { level: 6 }) };
  let m = revs.get(id);
  if (!m) revs.set(id, (m = new Map()));
  m.set(rev, r);
  cacheRaw(`${id}:${rev}`, alpha);
  sendToHost(id, rev, r);
  void idbPut('media', idbKey(id, rev), r);
  return rev;
}

function cacheRaw(k: string, a: Uint8Array): void {
  raw.delete(k);
  raw.set(k, a);
  while (raw.size > 24) raw.delete(raw.keys().next().value as string);
}

export function getMatte(id: string, rev: number | undefined): { w: number; h: number; alpha: Uint8Array } | null {
  if (rev === undefined) return null;
  const r = revs.get(id)?.get(rev);
  if (!r) return null;
  const k = `${id}:${rev}`;
  let a = raw.get(k);
  if (!a) {
    a = inflateSync(r.data);
    cacheRaw(k, a);
  }
  return { w: r.w, h: r.h, alpha: a };
}

/** Matte of a layer-time frame index (exact frame only). */
export function matteAtFrame(info: MatteInfo, frame: number): { w: number; h: number; alpha: Uint8Array } | null {
  return getMatte(info.id, info.revs[String(frame)]);
}

/** Re-send every revision to the render worker (after a renderer restart). */
export function resendMattes(): void {
  for (const [id, m] of revs) for (const [rev, r] of m) sendToHost(id, rev, r);
}

/** Load the revisions referenced by a project from IndexedDB (autosave restore). */
export async function restoreMattes(project: Project): Promise<void> {
  for (const info of Object.values(project.mattes ?? {})) {
    for (const rev of Object.values(info.revs)) {
      if (revs.get(info.id)?.has(rev)) continue;
      const r = await idbGet<Rev>('media', idbKey(info.id, rev));
      if (!r) continue;
      let m = revs.get(info.id);
      if (!m) revs.set(info.id, (m = new Map()));
      m.set(rev, r);
      sendToHost(info.id, rev, r);
    }
  }
}

/** Files to embed in a .pooe archive for the revisions the project references. */
export function matteArchiveFiles(project: Project): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const info of Object.values(project.mattes ?? {})) {
    for (const rev of new Set(Object.values(info.revs))) {
      const r = revs.get(info.id)?.get(rev);
      if (r) out[`mattes/${info.id}/${rev}`] = r.data;
    }
  }
  return out;
}

/** Register revisions read from a .pooe archive. */
export function importMatteArchive(project: Project, files: Record<string, Uint8Array>): void {
  for (const [path, data] of Object.entries(files)) {
    if (!path.startsWith('mattes/')) continue;
    const [, id, revStr] = path.split('/');
    const info = project.mattes?.[id];
    const rev = Number(revStr);
    if (!info || !Number.isFinite(rev)) continue;
    const r: Rev = { w: info.width, h: info.height, data };
    let m = revs.get(id);
    if (!m) revs.set(id, (m = new Map()));
    m.set(rev, r);
    revCounter = Math.max(revCounter, rev);
    sendToHost(id, rev, r);
    void idbPut('media', idbKey(id, rev), r);
  }
}

// ── contours for the viewer overlay ─────────────────────────────────────────

const contourCache = new Map<string, Pt[][]>();

/** Simplified iso-contours (matte pixels) of a revision, cached. */
export function matteContours(id: string, rev: number): Pt[][] {
  const k = `${id}:${rev}`;
  const hit = contourCache.get(k);
  if (hit) return hit;
  const m = getMatte(id, rev);
  if (!m) return [];
  const cs = traceContours(m.alpha, m.w, m.h, 128)
    .filter((c) => c.length > 6)
    .slice(0, 24)
    .map((c) => simplifyClosed(c, 0.6));
  contourCache.set(k, cs);
  while (contourCache.size > 48) contourCache.delete(contourCache.keys().next().value as string);
  return cs;
}
