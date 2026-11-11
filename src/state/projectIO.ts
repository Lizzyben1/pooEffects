// Project persistence: .pooe files (zip of project.json + media), autosave to IndexedDB.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Project } from '../core/types';
import { getApp, loadProject, setApp, toast, useApp } from './store';
import { getMedia, idbGet, idbPut, registerMedia } from './media';
import { clearAll as clearCache } from './cache';
import { importMatteArchive, matteArchiveFiles } from './mattes';

let activeFileHandle: FileSystemFileHandle | null = null;

export function setActiveFileHandle(handle: FileSystemFileHandle | null): void {
  activeFileHandle = handle;
}

export async function saveProjectFile(): Promise<void> {
  const s = getApp();
  const p = s.project;
  const files: Record<string, Uint8Array> = { 'project.json': strToU8(JSON.stringify(p)) };
  for (const f of Object.values(p.footage)) {
    if (f.procedural) continue;
    const m = getMedia(f.id);
    if (m) files[`media/${f.id}`] = new Uint8Array(await m.blob.arrayBuffer());
  }
  Object.assign(files, matteArchiveFiles(p));
  const zipped = zipSync(files, { level: 1 });
  const blob = new Blob([zipped.slice().buffer as ArrayBuffer], { type: 'application/zip' });
  const name = (s.fileName ?? p.name ?? 'Untitled').replace(/\.pooe$/i, '') + '.pooe';

  if (activeFileHandle && 'createWritable' in activeFileHandle) {
    try {
      const writable = await (activeFileHandle as unknown as { createWritable: () => Promise<FileSystemWritableFileStream> }).createWritable();
      await writable.write(blob);
      await writable.close();
      saved(activeFileHandle.name);
      return;
    } catch {
      activeFileHandle = null;
    }
  }

  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      const handle = await (window as unknown as { showSaveFilePicker: (opts: object) => Promise<FileSystemFileHandle> }).showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'pooEffects Project', accept: { 'application/zip': ['.pooe'] } }],
      });
      const writable = await (handle as unknown as { createWritable: () => Promise<FileSystemWritableFileStream> }).createWritable();
      await writable.write(blob);
      await writable.close();
      activeFileHandle = handle;
      saved(handle.name);
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }

  downloadBlob(blob, name);
  saved(name);
}

function saved(name: string): void {
  setApp({ dirty: false, fileName: name });
  writeAutosave();
  toast(`Saved ${name}`, 'success');
}

/** A project file can come from anywhere: check the parts the app dereferences without asking. */
function isProject(p: unknown): p is Project {
  const o = p as Project | null;
  if (!o || typeof o !== 'object' || o.format !== 'pooeffects') return false;
  if (!o.comps || typeof o.comps !== 'object' || !o.footage || typeof o.footage !== 'object') return false;
  return Object.values(o.comps).every((c) => c && Array.isArray(c.layers) && c.width > 0 && c.height > 0 && c.duration > 0 && c.frameRate > 0);
}

export async function openProjectFile(file: File, handle?: FileSystemFileHandle): Promise<void> {
  activeFileHandle = handle ?? null;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const files = unzipSync(buf);
    const json = files['project.json'];
    if (!json) throw new Error('project.json missing');
    const project = JSON.parse(strFromU8(json)) as Project;
    if (!isProject(project)) throw new Error('Not a pooEffects project');
    project.folders ??= {};
    project.settings ??= { expressionsEnabled: true, timeDisplay: 'timecode', frameStart: 0 };
    clearCache();
    // one unreadable media file must not cost the whole project: its footage item shows as missing
    const failed: string[] = [];
    for (const [path, data] of Object.entries(files)) {
      if (!path.startsWith('media/')) continue;
      const id = path.slice(6);
      const f = project.footage[id];
      try {
        await registerMedia(id, new File([data.slice().buffer as ArrayBuffer], f?.name ?? id, { type: f?.mime || '' }));
      } catch {
        failed.push(f?.name ?? id);
      }
    }
    importMatteArchive(project, files);
    loadProject(project, file.name);
    writeAutosave();
    if (failed.length) toast(`Opened ${file.name}, but ${failed.length} media file${failed.length > 1 ? 's' : ''} could not be read: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}`, 'error', 7000);
    else toast(`Opened ${file.name}`, 'success');
  } catch (e) {
    activeFileHandle = null;
    const msg = (e as Error).message;
    toast(`Could not open ${file.name}: ${/invalid zip|unexpected|JSON/i.test(msg) ? 'the file is damaged or is not a pooEffects project' : msg}`, 'error', 6000);
  }
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(input.files ? [...input.files] : []);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

// ── autosave ────────────────────────────────────────────────────────────────

export interface Autosave {
  project: Project;
  savedAt: number;
  fileName: string | null;
  /** the session had changes that were never written to a file */
  dirty?: boolean;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Store the session now (also cancels a pending debounced write). */
function writeAutosave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const s = getApp();
  if (!s.prefs.autoSave) return;
  void idbPut('meta', 'autosave', { project: s.project, savedAt: Date.now(), fileName: s.fileName, dirty: s.dirty } satisfies Autosave);
}

export function startAutosave(): void {
  useApp.subscribe((s, prev) => {
    if (s.project === prev.project || !s.prefs.autoSave || !s.dirty) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(writeAutosave, 1500);
  });
  // an edit made in the last moments before the tab is closed or hidden is written straight away
  const flush = () => {
    if (saveTimer) writeAutosave();
  };
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
  window.addEventListener('pagehide', flush);
}

export async function loadAutosave(): Promise<Autosave | null> {
  const r = await idbGet<Autosave>('meta', 'autosave');
  return r && isProject(r.project) ? r : null;
}

/** Forget the stored session (the recovery screen's way out of a document that cannot be shown). */
export async function clearAutosave(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  await idbPut('meta', 'autosave', null);
}
