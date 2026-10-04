// ─────────────────────────────────────────────────────────────────────────────
// Media store (UI thread): owns imported files, decodes metadata, keeps
// decoded audio for playback/waveforms, feeds the render worker, provides the
// <video> fallback for frames WebCodecs can't decode, and persists media in
// IndexedDB so projects survive reloads.
// ─────────────────────────────────────────────────────────────────────────────

import type { Footage } from '../core/types';
import { createFootage } from '../core/factory';
import type { RenderHost } from '../render/host';
import { audioContext } from '../audio/engine';

export interface MediaEntry {
  blob: Blob;
  url: string;
  image?: ImageBitmap;
  audio?: AudioBuffer;
  peaks?: Float32Array;
  thumb?: string;
  video?: HTMLVideoElement;
}

const entries = new Map<string, MediaEntry>();
let host: RenderHost | null = null;
const listeners = new Set<() => void>();

export function onMediaChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  for (const fn of listeners) fn();
}

export function attachHost(h: RenderHost): void {
  host = h;
  h.onVideoFrameRequest = (id, t) => fallbackFrame(id, t);
  h.onRestart = () => {
    for (const [id, e] of entries) void sendToHost(id, e);
  };
}

export function getMedia(id: string): MediaEntry | undefined {
  return entries.get(id);
}

async function sendToHost(id: string, e: MediaEntry): Promise<void> {
  if (!host) return;
  if (e.image) host.addImage(id, await createImageBitmap(e.image));
  if (e.blob.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v)$/i.test((e.blob as File).name ?? '')) host.addVideo(id, e.blob);
  if (e.audio) {
    const ch: Float32Array[] = [];
    for (let i = 0; i < e.audio.numberOfChannels; i++) ch.push(e.audio.getChannelData(i));
    host.addAudio(id, ch, e.audio.sampleRate);
  }
}

// ── IndexedDB persistence ───────────────────────────────────────────────────

const DB_NAME = 'pooeffects-media';
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('media');
        req.result.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

export async function idbPut(store: 'media' | 'meta', key: string, value: unknown): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((res, rej) => {
      const tx = d.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    /* storage may be unavailable (private mode) */
  }
}

export async function idbGet<T>(store: 'media' | 'meta', key: string): Promise<T | undefined> {
  try {
    const d = await db();
    return await new Promise<T | undefined>((res, rej) => {
      const tx = d.transaction(store, 'readonly');
      const r = tx.objectStore(store).get(key);
      r.onsuccess = () => res(r.result as T | undefined);
      r.onerror = () => rej(r.error);
    });
  } catch {
    return undefined;
  }
}

// ── decoding ────────────────────────────────────────────────────────────────

function computePeaks(buf: AudioBuffer, perSecond = 200): Float32Array {
  const n = Math.max(1, Math.ceil(buf.duration * perSecond));
  const out = new Float32Array(n);
  const step = buf.sampleRate / perSecond;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      let m = 0;
      const a = Math.floor(i * step), b = Math.min(d.length, Math.floor((i + 1) * step));
      for (let k = a; k < b; k += 2) {
        const v = Math.abs(d[k]);
        if (v > m) m = v;
      }
      if (m > out[i]) out[i] = m;
    }
  }
  return out;
}

async function decodeAudio(blob: Blob): Promise<AudioBuffer | undefined> {
  try {
    const ctx = audioContext();
    return await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch {
    return undefined;
  }
}

async function videoThumb(url: string, t = 0.1): Promise<{ thumb: string; w: number; h: number; duration: number; video: HTMLVideoElement } | null> {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  v.src = url;
  try {
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error('video load failed'));
      setTimeout(() => rej(new Error('timeout')), 8000);
    });
    await seekVideo(v, Math.min(t, Math.max(0, v.duration - 0.05)));
    const c = document.createElement('canvas');
    const w = 160, h = Math.max(1, Math.round((160 * v.videoHeight) / Math.max(1, v.videoWidth)));
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(v, 0, 0, w, h);
    return { thumb: c.toDataURL('image/jpeg', 0.7), w: v.videoWidth, h: v.videoHeight, duration: v.duration, video: v };
  } catch {
    return null;
  }
}

function seekVideo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((res) => {
    if (Math.abs(v.currentTime - t) < 1e-4 && v.readyState >= 2) {
      res();
      return;
    }
    const done = () => {
      v.removeEventListener('seeked', done);
      res();
    };
    v.addEventListener('seeked', done);
    v.currentTime = t;
    setTimeout(done, 3000);
  });
}

async function fallbackFrame(id: string, t: number): Promise<ImageBitmap | null> {
  const e = entries.get(id);
  if (!e) return null;
  if (!e.video) {
    const r = await videoThumb(e.url);
    if (!r) return null;
    e.video = r.video;
  }
  await seekVideo(e.video, t);
  try {
    return await createImageBitmap(e.video);
  } catch {
    return null;
  }
}

async function imageThumb(bmp: ImageBitmap): Promise<string> {
  const c = document.createElement('canvas');
  const w = 160, h = Math.max(1, Math.round((160 * bmp.height) / Math.max(1, bmp.width)));
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
  return c.toDataURL('image/png');
}

/** Register a blob under a footage id (decode, persist, send to the worker). */
export async function registerMedia(id: string, blob: Blob, persist = true): Promise<MediaEntry> {
  const old = entries.get(id);
  if (old) URL.revokeObjectURL(old.url);
  const e: MediaEntry = { blob, url: URL.createObjectURL(blob) };
  const type = blob.type || '';
  const name = (blob as File).name ?? '';
  const isImage = type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(name);
  const isVideo = type.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v)$/i.test(name);
  const isAudio = type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(name);
  if (isImage) {
    e.image = await createImageBitmap(blob);
    e.thumb = await imageThumb(e.image);
  }
  if (isVideo || isAudio) {
    e.audio = await decodeAudio(blob);
    if (e.audio) e.peaks = computePeaks(e.audio);
  }
  if (isVideo) {
    const r = await videoThumb(e.url);
    if (r) {
      e.thumb = r.thumb;
      e.video = r.video;
    }
  }
  entries.set(id, e);
  await sendToHost(id, e);
  if (persist) void idbPut('media', id, blob);
  emit();
  return e;
}

/** Restore persisted media for footage items of a project. */
export async function restoreMedia(footage: Footage[]): Promise<void> {
  await Promise.all(
    footage.map(async (f) => {
      if (entries.has(f.id) || f.procedural) return;
      const blob = await idbGet<Blob>('media', f.id);
      if (blob) await registerMedia(f.id, blob, false);
    }),
  );
}

/** Probe a file and build a Footage item (does not add it to the project). */
export async function importFile(file: File): Promise<Footage | null> {
  const name = file.name;
  const type = file.type || '';
  const isImage = type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(name);
  const isVideo = type.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v)$/i.test(name);
  const isAudio = type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(name);
  const isFont = /\.(ttf|otf|woff2?)$/i.test(name);
  if (isFont) {
    const family = name.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[-_]+/g, ' ');
    const buf = await file.arrayBuffer();
    try {
      const face = new FontFace(family, buf);
      await face.load();
      document.fonts.add(face);
      host?.addFont(family, buf);
      void idbPut('meta', `font:${family}`, buf);
      customFonts.add(family);
      emit();
    } catch {
      return null;
    }
    return null;
  }
  if (!isImage && !isVideo && !isAudio) return null;
  let f: Footage;
  if (isImage) {
    const bmp = await createImageBitmap(file);
    f = createFootage({ name, kind: 'image', mime: type, width: bmp.width, height: bmp.height, bytes: file.size, hasVideo: true, hasAudio: false });
    bmp.close();
  } else {
    let width = 0, height = 0, duration = 0, fps = 30, hasVideo = isVideo, hasAudio = isAudio;
    try {
      // the demuxer is only needed when probing imports, so it stays out of the startup bundle
      const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny');
      const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
      const vt = await input.getPrimaryVideoTrack();
      const at = await input.getPrimaryAudioTrack();
      duration = await input.computeDuration();
      hasVideo = !!vt;
      hasAudio = !!at;
      if (vt) {
        width = vt.displayWidth;
        height = vt.displayHeight;
        const stats = await vt.computePacketStats(120);
        fps = stats.averagePacketRate > 0 ? Math.round(stats.averagePacketRate * 1000) / 1000 : 30;
      }
    } catch {
      // fall back to the media element for metadata
      const url = URL.createObjectURL(file);
      const r = isVideo ? await videoThumb(url) : null;
      URL.revokeObjectURL(url);
      if (r) {
        width = r.w;
        height = r.h;
        duration = r.duration;
      }
    }
    f = createFootage({
      name, kind: hasVideo ? 'video' : 'audio', mime: type, width, height, duration, frameRate: fps || 30,
      bytes: file.size, hasVideo, hasAudio,
    });
  }
  await registerMedia(f.id, file);
  return f;
}

export const customFonts = new Set<string>();

export async function restoreFonts(): Promise<void> {
  try {
    const d = await db();
    const keys: string[] = await new Promise((res, rej) => {
      const tx = d.transaction('meta', 'readonly');
      const r = tx.objectStore('meta').getAllKeys();
      r.onsuccess = () => res(r.result as string[]);
      r.onerror = () => rej(r.error);
    });
    for (const k of keys.filter((x) => x.startsWith('font:'))) {
      const family = k.slice(5);
      const buf = await idbGet<ArrayBuffer>('meta', k);
      if (!buf) continue;
      const face = new FontFace(family, buf);
      await face.load();
      document.fonts.add(face);
      host?.addFont(family, buf);
      customFonts.add(family);
    }
    emit();
  } catch {
    /* ignore */
  }
}

/** Register procedurally generated media (demo assets) without persisting. */
export async function registerProcedural(id: string, blob: Blob): Promise<void> {
  await registerMedia(id, blob, false);
}

