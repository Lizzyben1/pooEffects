// Project persistence: .pooe files (zip of project.json + media), autosave to IndexedDB.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Project } from '../core/types';
import { getApp, loadProject, setApp, toast, useApp } from './store';
import { getMedia, idbGet, idbPut, registerMedia } from './media';
import { clearAll as clearCache } from './cache';

export async function saveProjectFile(): Promise<void> {
  const s = getApp();
  const p = s.project;
  const files: Record<string, Uint8Array> = { 'project.json': strToU8(JSON.stringify(p)) };
  for (const f of Object.values(p.footage)) {
    if (f.procedural) continue;
    const m = getMedia(f.id);
    if (m) files[`media/${f.id}`] = new Uint8Array(await m.blob.arrayBuffer());
  }
  const zipped = zipSync(files, { level: 1 });
  const blob = new Blob([zipped.slice().buffer as ArrayBuffer], { type: 'application/zip' });
  const name = (s.fileName ?? p.name ?? 'Untitled').replace(/\.pooe$/i, '') + '.pooe';
  downloadBlob(blob, name);
  setApp({ dirty: false, fileName: name });
  toast(`Saved ${name}`, 'success');
}

export async function openProjectFile(file: File): Promise<void> {
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
