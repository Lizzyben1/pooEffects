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
      setApp({ dirty: false, fileName: activeFileHandle.name });
      toast(`Saved ${activeFileHandle.name}`, 'success');
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
      setApp({ dirty: false, fileName: handle.name });
      toast(`Saved ${handle.name}`, 'success');
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }

  downloadBlob(blob, name);
  setApp({ dirty: false, fileName: name });
  toast(`Saved ${name}`, 'success');
}

export async function openProjectFile(file: File, handle?: FileSystemFileHandle): Promise<void> {
  activeFileHandle = handle ?? null;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const files = unzipSync(buf);
    const json = files['project.json'];
    if (!json) throw new Error('project.json missing');
    const project = JSON.parse(strFromU8(json)) as Project;
    if (project.format !== 'pooeffects') throw new Error('Not a pooEffects project');
    clearCache();
    for (const [path, data] of Object.entries(files)) {
      if (!path.startsWith('media/')) continue;
      const id = path.slice(6);
      const f = project.footage[id];
      await registerMedia(id, new File([data.slice().buffer as ArrayBuffer], f?.name ?? id, { type: f?.mime || '' }));
    }
    importMatteArchive(project, files);
    loadProject(project, file.name);
    toast(`Opened ${file.name}`, 'success');
  } catch (e) {
    toast(`Could not open project: ${(e as Error).message}`, 'error', 5000);
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

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function startAutosave(): void {
  useApp.subscribe((s, prev) => {
    if (s.project === prev.project || !s.prefs.autoSave || !s.dirty) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void idbPut('meta', 'autosave', { project: getApp().project, savedAt: Date.now(), fileName: getApp().fileName });
    }, 1500);
  });
}

export async function loadAutosave(): Promise<{ project: Project; savedAt: number; fileName: string | null } | null> {
  const r = await idbGet<{ project: Project; savedAt: number; fileName: string | null }>('meta', 'autosave');
  return r && r.project?.format === 'pooeffects' ? r : null;
}
