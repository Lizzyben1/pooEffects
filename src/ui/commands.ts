// ─────────────────────────────────────────────────────────────────────────────
// Command registry: every menu item, context menu entry and keyboard shortcut
// maps to a named command so behaviour is consistent everywhere.
// ─────────────────────────────────────────────────────────────────────────────

import { activeComp, getApp, openDialog, redo, setApp, setTimeline, setViewer, timelineOf, toast, undo, viewerOf, loadProject } from '../state/store';
import * as A from '../state/actions';
import { getTime, setTime } from '../state/time';
import {
  createAdjustmentLayer, createCameraLayer, createLightLayer, createNullLayer, createShapeLayer, createSolidLayer, createTextLayer,
  createProject, createFootageLayer, createPrecompLayer, rectPath,
} from '../core/factory';
import { togglePlay, stop as stopPlayback } from '../state/playback';
import { openProjectFile, pickFiles, saveProjectFile, downloadBlob, setActiveFileHandle } from '../state/projectIO';
import { importFile } from '../state/media';
import { buildDemoProject, ensureProceduralMedia } from '../demo';
import { clearAll as clearCache } from '../state/cache';
import { WORKSPACES } from './dock/workspaces';
import { ensurePanel } from './dock/layout';
import { deleteTracker, getTracking, stopTracking } from '../state/tracking';
import type { PanelId, SelTarget } from '../state/uiTypes';
import type { Composition, LightKind, TextAnimatorPropKey } from '../core/types';
import { host, renderOptions, getViewParams } from '../state/engine';
import { FrameEval, layerSourceSize } from '../core/evaluate';
import { layerBounds } from './viewer/geometry';
import { hexToRgba } from '../math/color';
import { enqueue } from '../state/renderQueue';

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl+';
export const ALT = isMac ? '⌥' : 'Alt+';
export const SHIFT = isMac ? '⇧' : 'Shift+';

function comp() {
  return activeComp();
}

function needComp(): string | null {
  const c = comp();
  if (!c) {
    toast('Open a composition first', 'warn');
    return null;
  }
  return c.id;
}

function sel(): string[] {
  return getApp().selLayers;
}

function needSel(): [string, string[]] | null {
  const c = needComp();
  if (!c) return null;
  const s = sel();
  if (!s.length) {
    toast('Select one or more layers', 'warn');
    return null;
  }
  return [c, s];
}

function needKeys(): string[] | null {
  if (!needComp()) return null;
  const k = getApp().selKeys;
  if (!k.length) {
    toast('Select one or more keyframes first', 'warn');
    return null;
  }
  return k;
}

/** The timeline sub-item (effect, mask, shape item…) the user picked, if it still exists on a layer of the active comp. */
export function currentTarget(): SelTarget | null {
  const s = getApp();
  const c = comp();
  const t = s.selTarget;
  if (!c || !t) return null;
  const l = c.layers.find((x) => x.id === t.layerId);
  if (!l) return null;
  switch (t.kind) {
    case 'effect': return l.effects.some((e) => e.id === t.id) ? t : null;
    case 'mask': return l.masks.some((m) => m.id === t.id) ? t : null;
    case 'tracker': return l.trackers?.some((x) => x.id === t.id) ? t : null;
    default: return t.path ? t : null;
  }
}

export function deleteTarget(compId: string, t: SelTarget): void {
  switch (t.kind) {
    case 'effect': A.removeEffect(compId, t.layerId, t.id); break;
    case 'mask': A.removeMask(compId, t.layerId, t.id); break;
    case 'shapeItem': if (t.path) A.removeShapeItem(compId, t.layerId, t.path); break;
    case 'textNode': if (t.path) A.removeTextNode(compId, t.layerId, t.path); break;
    case 'tracker': deleteTracker(compId, t.layerId, t.id); break;
  }
  setApp((s) => ({
    selTarget: null,
    selEffect: s.selEffect === t.id ? null : s.selEffect,
    selMask: s.selMask === t.id ? null : s.selMask,
    selShapeItem: s.selShapeItem === t.id ? null : s.selShapeItem,
  }));
}

const SOLID_COLORS = ['#1b1f2a', '#ff9b3f', '#4f9dff', '#3ddc84', '#b48cff', '#ff5d6c'];
let solidIdx = 0;

/**
 * Replacing the project cannot be undone. When the open one has changes that were never written to a
 * file, ask first: Save (then continue), Don't Save (continue) or Cancel.
 */
export function guardUnsaved(next: () => void): void {
  const s = getApp();
  if (!s.dirty || !Object.keys(s.project.comps).length) {
    next();
    return;
  }
  openDialog({
    kind: 'confirm',
    title: 'Save changes first?',
    message: `“${s.fileName ?? s.project.name}” has changes that have not been saved to a file. They will be lost if you continue without saving.`,
    okLabel: 'Save…',
    onOk: () => {
      void saveProjectFile().then(() => {
        // the save can be cancelled from the file picker: only move on once it really happened
        if (!getApp().dirty) next();
      });
    },
    alt: { label: 'Don’t Save', action: next },
  });
}

const FONT_FILE = /\.(ttf|otf|woff2?)$/i;

export async function importFiles(files: File[], addToComp = false): Promise<void> {
  const project = files.find((f) => /\.pooe$/i.test(f.name));
  if (project) {
    guardUnsaved(() => void openProjectFile(project));
    return;
  }
  let n = 0;
  let fonts = 0;
  const rejected: string[] = [];
  for (const f of files) {
    try {
      const footage = await importFile(f);
      if (footage) {
        A.addFootage(footage);
        n++;
        const c = comp();
        if (addToComp && c) A.addLayer(c.id, createFootageLayer(c, footage), { index: 0 });
      } else if (FONT_FILE.test(f.name)) fonts++;
      else rejected.push(f.name);
    } catch (e) {
      console.warn(`[import] ${f.name}`, e);
      rejected.push(f.name);
    }
  }
  const parts: string[] = [];
  if (n) parts.push(`${n} item${n > 1 ? 's' : ''}`);
  if (fonts) parts.push(`${fonts} font${fonts > 1 ? 's' : ''}`);
  if (parts.length) toast(`Imported ${parts.join(' and ')}`, 'success');
  if (rejected.length) {
    toast(
      `Could not import ${rejected.slice(0, 3).join(', ')}${rejected.length > 3 ? ` and ${rejected.length - 3} more` : ''}: unsupported or damaged file. Images, video, audio, fonts and .pooe projects can be imported.`,
      'error', 6500,
    );
  }
}

/**
 * Add a project item (footage or composition) to the active comp as a new layer at `index`.
 * Used by double-click, the Project context menu and drag-and-drop onto the viewer / timeline.
 */
export function addProjectItemToComp(id: string, index = 0): string | null {
  const s = getApp();
  const c = comp();
  if (!c) {
    // nothing open: footage starts a comp of its own, a comp simply opens
    const f = s.project.footage[id];
    if (f) return newCompFromFootage(id);
    if (s.project.comps[id]) A.openComp(id);
    return null;
  }
  const f = s.project.footage[id];
  if (f) {
    const l = createFootageLayer(c, f);
    A.addLayer(c.id, l, { index });
    return l.id;
  }
  const nested = s.project.comps[id];
  if (!nested) return null;
  if (nested.id === c.id || A.compUses(s.project, nested, c.id)) {
    toast(`“${nested.name}” contains this composition — nesting it here would loop forever`, 'warn', 4000);
    return null;
  }
  const l = createPrecompLayer(c, nested);
  A.addLayer(c.id, l, { index });
  return l.id;
}

export function newCompFromFootage(footageId: string): string | null {
  const f = getApp().project.footage[footageId];
  if (!f) return null;
  const id = A.newComp({
    name: f.name.replace(/\.[^.]+$/, ''), width: f.width || 1920, height: f.height || 1080,
    duration: f.duration > 0 ? f.duration : 10, frameRate: f.kind === 'video' && f.frameRate ? f.frameRate : 30,
  });
  const c = getApp().project.comps[id];
  if (c) A.addLayer(id, createFootageLayer(c, f), { index: 0 });
  return id;
}

/** Drag payloads between panels (HTML5 drag & drop). */
export const DND_ITEM = 'application/x-poo-item';
export const DND_EFFECT = 'application/x-poo-effect';

export function newLayer(kind: 'text' | 'solid' | 'null' | 'shape' | 'adjustment' | 'camera' | LightKind): void {
  const cid = needComp();
  if (!cid) return;
  const c = comp()!;
  switch (kind) {
    case 'text': {
      const l = createTextLayer(c, 'Your Text', { size: 120 });
      l.transform.position.value = [c.width / 2, c.height / 2 + 40, 0];
      A.addLayer(cid, l);
      break;
    }
    case 'solid':
      A.addLayer(cid, createSolidLayer(c, hexToRgba(SOLID_COLORS[solidIdx++ % SOLID_COLORS.length]), 'Solid'));
      break;
    case 'null':
      A.addLayer(cid, createNullLayer(c, 'Null 1'));
      break;
    case 'shape':
      A.addLayer(cid, createShapeLayer(c, [], 'Shape Layer 1'));
      break;
    case 'adjustment':
      A.addLayer(cid, createAdjustmentLayer(c));
      break;
    case 'camera':
      A.addLayer(cid, createCameraLayer(c, 35, 'Camera 1'), { index: 0 });
      hint3D(c);
      break;
    default:
      A.addLayer(cid, createLightLayer(c, kind), { index: 0 });
      hint3D(c);
  }
}

/** Cameras and lights only act on 3D layers; say so when the comp has none (the usual "nothing happened" trap). */
export function hint3D(c: Composition): void {
  if (c.layers.some((l) => l.threeD)) return;
  toast('Cameras and lights only affect 3D layers. Make a layer 3D with its cube switch in the timeline, or Layer ▸ Switches ▸ 3D Layer.', 'info', 6500);
}

export function setTool(t: ReturnType<typeof getApp>['tool']): void {
  const s = getApp();
  if (t === 'shape' && s.tool === 'shape') {
    const order = ['rect', 'roundedRect', 'ellipse', 'polygon', 'star'] as const;
    setApp({ shapeTool: order[(order.indexOf(s.shapeTool) + 1) % order.length] });
  } else if (t === 'camera' && s.tool === 'camera') {
    const order = ['orbit', 'trackXY', 'trackZ'] as const;
    setApp({ cameraTool: order[(order.indexOf(s.cameraTool) + 1) % order.length] });
  } else setApp({ tool: t });
  if (t === 'roto') void import('../state/tracking').then((T) => T.setTracking({ mode: 'roto' }));
}

export function zoomViewer(f: number | 'fit' | 1): void {
  const c = comp();
  if (!c) return;
  const v = viewerOf(getApp(), c.id);
  if (f === 'fit') setViewer(c.id, { zoom: null, panX: 0, panY: 0 });
  else if (f === 1) setViewer(c.id, { zoom: 1, panX: 0, panY: 0 });
  else {
    const el = document.querySelector('.view-pane.active') as HTMLElement | null;
    const fit = el ? Math.min((el.clientWidth - 40) / c.width, (el.clientHeight - 40) / c.height) : 0.5;
    const cur = v.zoom ?? fit;
    const steps = [0.015625, 0.03125, 0.0625, 0.125, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 8, 16, 32];
    const next = f > 1 ? steps.find((s) => s > cur * 1.01) ?? 32 : [...steps].reverse().find((s) => s < cur * 0.99) ?? 0.015625;
    setViewer(c.id, { zoom: next, panX: v.panX * (next / cur), panY: v.panY * (next / cur) });
  }
}

/** Narrower than this, the timeline's left pane cannot fit the Switches and Modes columns side by side. */
export const TIMELINE_BOTH_MIN = 690;

/** F4 / column header: both → switches → modes → both (skipping 'both' when the pane is too narrow to show it). */
export function cycleTimelineColumns(compId: string): void {
  const tl = timelineOf(getApp(), compId);
  const fits = tl.leftWidth >= TIMELINE_BOTH_MIN;
  const shown = tl.columns === 'both' && !fits ? 'switches' : tl.columns;
  const next = shown === 'both' ? 'switches' : shown === 'switches' ? 'modes' : fits ? 'both' : 'switches';
  setTimeline(compId, { columns: next });
}

export function togglePanel(p: PanelId): void {
  setApp((s) => ({ layout: ensurePanel(s.layout, p), focusedPanel: p }));
}

export function setWorkspace(name: string): void {
  const f = WORKSPACES[name];
  if (f) setApp({ workspace: name, layout: f(), maximized: null });
  setTimeout(() => window.dispatchEvent(new Event('resize')), 0);
}

export function loadDemo(): void {
  guardUnsaved(() => void openDemo());
}

async function openDemo(): Promise<void> {
  stopPlayback();
  clearCache();
  const { project, mainCompId, initialTime } = buildDemoProject();
  loadProject(project, null);
  A.openComp(mainCompId);
  setTime(mainCompId, initialTime);
  toast('Loaded the demo project — press Space to play', 'success', 4000);
  await ensureProceduralMedia(project);
}

export function newProject(): void {
  guardUnsaved(() => {
    stopPlayback();
    clearCache();
    setActiveFileHandle(null);
    const p = createProject('Untitled Project');
    loadProject(p, null);
    openDialog({ kind: 'newComp' });
  });
}

async function pickAndOpenProject(): Promise<void> {
  if (typeof window !== 'undefined' && 'showOpenFilePicker' in window) {
    try {
      const [handle] = await (window as unknown as { showOpenFilePicker: (opts: object) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker({
        types: [{ description: 'pooEffects Project', accept: { 'application/zip': ['.pooe'] } }],
        multiple: false,
      });
      if (handle) {
        const file = await handle.getFile();
        await openProjectFile(file, handle);
        return;
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  const files = await pickFiles('.pooe,application/zip', false);
  if (files[0]) await openProjectFile(files[0]);
}

export async function saveFramePng(): Promise<void> {
  const c = comp();
  if (!c) return;
  const r = await host.render('snapshot', 'thumb', { ...renderOptions(c.id, getTime(c.id), { scale: 1, motionBlur: true, draft: false }), guides: false }, null);
  if (!r) return;
  const canvas = document.createElement('canvas');
  canvas.width = r.bitmap.width;
  canvas.height = r.bitmap.height;
  canvas.getContext('2d')!.drawImage(r.bitmap, 0, 0);
  r.bitmap.close();
  canvas.toBlob((b) => b && downloadBlob(b, `${c.name}_${Math.round(getTime(c.id) * 1000)}ms.png`), 'image/png');
}

export function addTextAnimator(key: TextAnimatorPropKey): void {
  const ns = needSel();
  if (!ns) return;
  const c = comp()!;
  const texts = c.layers.filter((l) => ns[1].includes(l.id) && l.type === 'text');
  if (!texts.length) {
    toast('Select a text layer', 'warn');
    return;
  }
  for (const l of texts) A.addTextAnimator(ns[0], l.id, [key]);
}

export function newMaskOnSelection(): void {
  const ns = needSel();
  if (!ns) return;
  const p = getApp().project;
  const c = comp()!;
  for (const id of ns[1]) {
    const l = c.layers.find((x) => x.id === id);
    if (!l || l.type === 'camera' || l.type === 'light' || l.type === 'audio') continue;
    const s = layerSourceSize(p, c, l);
    A.addMask(ns[0], id, rectPath(0, 0, s.w, s.h));
  }
}

/** Adds the active composition to the render queue and opens the queue panel. */
export function addToRenderQueue(compId?: string): void {
  const id = compId ?? needComp();
  if (!id) return;
  const item = enqueue(id);
  if (!item) return;
  togglePanel('renderQueue');
  toast(`Added “${getApp().project.comps[id].name}” to the Render Queue`, 'success', 2000);
}

export const commands = {
  // file
  newProject,
  openProject: () => guardUnsaved(() => void pickAndOpenProject()),
  save: () => void saveProjectFile(),
  importFile: async () => {
    const files = await pickFiles('image/*,video/*,audio/*,.ttf,.otf,.woff,.woff2,.pooe');
    await importFiles(files);
  },
  loadDemo,
  saveFrame: () => void saveFramePng(),
  addToRenderQueue: () => addToRenderQueue(),
  // edit
  undo: () => {
    // a running track/propagation is one open transaction — finish it before undoing
    const job = getTracking().job;
    if (job && job.op !== 'camera') {
      stopTracking();
      toast('Stopping the analysis — undo again to revert it', 'info');
      return;
    }
    undo();
  },
  redo,
  cut: () => A.cutSelection(),
  copy: () => A.copySelection(),
  paste: () => A.paste(),
  duplicate: () => {
    const c = comp();
    const t = currentTarget();
    if (c && t?.kind === 'effect') {
      A.duplicateEffect(c.id, t.layerId, t.id);
      return;
    }
    const ns = needSel();
    if (ns) A.duplicateLayers(ns[0], ns[1]);
  },
  split: () => {
    const ns = needSel();
    if (ns) A.splitLayers(ns[0], ns[1]);
  },
  /** Delete what the user last picked: project items, keyframes, a timeline sub-item (effect, mask, shape…), else the layers. */
  delete: () => {
    const s = getApp();
    const c = comp();
    if (s.focusedPanel === 'project' && s.selItems.length) {
      A.deleteProjectItems(s.selItems);
      return;
    }
    if (!c) return;
    const t = currentTarget();
    if (s.selKeys.length) A.deleteKeyframes(s.selKeys);
    else if (t) deleteTarget(c.id, t);
    else if (s.selEffect && s.focusedPanel === 'effectControls') {
      const l = c.layers.find((x) => x.effects.some((e) => e.id === s.selEffect));
      if (l) A.removeEffect(c.id, l.id, s.selEffect);
    } else if (s.selLayers.length) A.deleteLayers(c.id, s.selLayers);
  },
  selectAll: () => {
    const s = getApp();
    if (s.focusedPanel === 'timeline' && s.selLayers.length && s.selKeys.length) A.selectAllKeyframes(s.selLayers);
    else A.selectAllLayers();
  },
  deselectAll: () => A.deselectAll(),
  prefs: () => openDialog({ kind: 'prefs' }),
  shortcuts: () => openDialog({ kind: 'shortcuts' }),
  // composition
  newComp: () => openDialog({ kind: 'newComp' }),
  compSettings: () => {
    const id = needComp();
    if (id) openDialog({ kind: 'compSettings', compId: id });
  },
  trimComp: () => {
    const id = needComp();
    if (id) A.trimCompToWorkArea(id);
  },
  play: () => togglePlay(),
  // layer creation
  newText: () => newLayer('text'),
  newSolid: () => {
    const id = needComp();
    if (id) openDialog({ kind: 'solid', compId: id });
  },
  newNull: () => newLayer('null'),
  newShape: () => newLayer('shape'),
  newAdjustment: () => newLayer('adjustment'),
  newCamera: () => newLayer('camera'),
  newLight: () => newLayer('point'),
  newMask: () => newMaskOnSelection(),
  precompose: () => {
    const ns = needSel();
    if (ns) openDialog({ kind: 'precompose', compId: ns[0], layerIds: ns[1] });
  },
  layerSettings: () => {
    const ns = needSel();
    if (!ns) return;
    const l = comp()!.layers.find((x) => x.id === ns[1][0]);
    if (l?.type === 'solid' || l?.type === 'null') openDialog({ kind: 'solid', compId: ns[0], layerId: l.id });
  },
  timeReverse: () => {
    const ns = needSel();
    if (ns) A.timeReverse(ns[0], ns[1]);
  },
  timeStretch: () => {
    const ns = needSel();
    if (ns) openDialog({ kind: 'timeStretch', compId: ns[0], layerId: ns[1][0] });
  },
  timeRemap: () => {
    const ns = needSel();
    if (!ns) return;
    const l = comp()!.layers.find((x) => x.id === ns[1][0]);
    if (l) A.setTimeRemap(ns[0], l.id, !l.timeRemapEnabled);
  },
  freezeFrame: () => {
    const ns = needSel();
    if (ns) for (const id of ns[1]) A.freezeFrame(ns[0], id);
  },
  centerAnchor: () => {
    const ns = needSel();
    if (!ns) return;
    const s = getApp();
    const c = s.project.comps[ns[0]];
    if (!c) return;
    const fe = new FrameEval(s.project, c, getTime(c.id));
    A.centerAnchor(ns[0], ns[1], (l) => layerBounds(s.project, c, l, fe));
  },
  fitToComp: () => {
    const ns = needSel();
    if (ns) A.fitToComp(ns[0], ns[1]);
  },
  resetTransform: () => {
    const ns = needSel();
    if (ns) A.resetTransform(ns[0], ns[1]);
  },
  bringForward: () => {
    const ns = needSel();
    if (ns) A.arrangeLayers(ns[0], ns[1], 'forward');
  },
  sendBackward: () => {
    const ns = needSel();
    if (ns) A.arrangeLayers(ns[0], ns[1], 'backward');
  },
  bringToFront: () => {
    const ns = needSel();
    if (ns) A.arrangeLayers(ns[0], ns[1], 'front');
  },
  sendToBack: () => {
    const ns = needSel();
    if (ns) A.arrangeLayers(ns[0], ns[1], 'back');
  },
  toggle3D: () => {
    const ns = needSel();
    if (ns) A.toggleLayerSwitch(ns[0], ns[1], 'threeD');
  },
  toggleMotionBlur: () => {
    const ns = needSel();
    if (ns) A.toggleLayerSwitch(ns[0], ns[1], 'motionBlur');
  },
  toggleSolo: () => {
    const ns = needSel();
    if (ns) A.toggleLayerSwitch(ns[0], ns[1], 'solo');
  },
  toggleLock: () => {
    const ns = needSel();
    if (ns) A.toggleLayerSwitch(ns[0], ns[1], 'locked');
  },
  toggleShy: () => {
    const ns = needSel();
    if (ns) A.toggleLayerSwitch(ns[0], ns[1], 'shy');
  },
  toggleVisible: () => {
    const ns = needSel();
    if (ns) A.toggleLayerSwitch(ns[0], ns[1], 'enabled');
  },
  trimIn: () => {
    const ns = needSel();
    if (ns) A.trimLayers(ns[0], ns[1], 'in');
  },
  trimOut: () => {
    const ns = needSel();
    if (ns) A.trimLayers(ns[0], ns[1], 'out');
  },
  moveIn: () => {
    const ns = needSel();
    if (ns) A.moveLayersTo(ns[0], ns[1], 'in');
  },
  moveOut: () => {
    const ns = needSel();
    if (ns) A.moveLayersTo(ns[0], ns[1], 'out');
  },
  // animation
  easyEase: () => {
    const k = needKeys();
    if (k) A.easyEase(k, 'both');
  },
  easeIn: () => {
    const k = needKeys();
    if (k) A.easyEase(k, 'in');
  },
  easeOut: () => {
    const k = needKeys();
    if (k) A.easyEase(k, 'out');
  },
  interpLinear: () => {
    const k = needKeys();
    if (k) A.setKeyframeInterpolation(k, 'linear');
  },
  interpBezier: () => {
    const k = needKeys();
    if (k) A.setKeyframeInterpolation(k, 'bezier');
  },
  interpAuto: () => {
    const k = needKeys();
    if (k) A.setKeyframeInterpolation(k, 'auto');
  },
  interpHold: () => {
    const k = needKeys();
    if (k) A.toggleHold(k);
  },
  keyframeVelocity: () => {
    const id = needComp();
    if (id && needKeys()) openDialog({ kind: 'keyframeVelocity', compId: id });
  },
  revealKeyframes: () => A.revealKeyframes(),
  revealModified: () => A.revealModified(),
  addKeyframe: (path: string) => {
    const ns = needSel();
    if (ns) for (const id of ns[1]) A.addKeyframeAt(ns[0], id, path);
  },
  // time
  goStart: () => {
    const c = comp();
    if (c) A.goToTime(c.id, 0);
  },
  goEnd: () => {
    const c = comp();
    if (c) A.goToTime(c.id, c.duration);
  },
  addMarker: () => {
    const id = needComp();
    if (id) A.addCompMarker(id);
  },
  workAreaStart: () => {
    const c = comp();
    if (c) A.setWorkArea(c.id, getTime(c.id));
  },
  workAreaEnd: () => {
    const c = comp();
    if (c) A.setWorkArea(c.id, undefined, getTime(c.id) + 1 / c.frameRate);
  },
  // view
  zoomIn: () => zoomViewer(2),
  zoomOut: () => zoomViewer(0.5),
  zoomFit: () => zoomViewer('fit'),
  zoom100: () => zoomViewer(1),
  toggleGrid: () => {
    const c = comp();
    if (c) setViewer(c.id, { grid: !viewerOf(getApp(), c.id).grid });
  },
  togglePropGrid: () => {
    const c = comp();
    if (c) setViewer(c.id, { propGrid: !viewerOf(getApp(), c.id).propGrid });
  },
  toggleSafe: () => {
    const c = comp();
    if (c) setViewer(c.id, { safe: !viewerOf(getApp(), c.id).safe });
  },
  toggleTransparency: () => {
    const c = comp();
    if (c) setViewer(c.id, { transparency: !viewerOf(getApp(), c.id).transparency });
  },
  toggleLayerControls: () => {
    const c = comp();
    if (c) setViewer(c.id, { layerControls: !viewerOf(getApp(), c.id).layerControls });
  },
  about: () => openDialog({ kind: 'about' }),
  export: () => {
    const id = needComp();
    if (id) openDialog({ kind: 'export', compId: id });
  },
  currentScale: () => getViewParams()?.scale ?? 0.5,
};


// ── motion tracking entry points (menus, layer context menu) ────────────────

/** Start a tracking workflow on the first selected footage/precomp layer and reveal the Tracker panel. */
export function startTracking(op: 'transform' | 'stabilize' | 'perspective' | 'camera' | 'roto'): void {
  const comp = activeComp();
  if (!comp) return;
  void import('../state/tracking').then((T) => {
    const sel = getApp().selLayers;
    const layer = comp.layers.find((l) => sel.includes(l.id) && T.isTrackable(l)) ?? comp.layers.find((l) => T.isTrackable(l));
    togglePanel('tracker');
    T.setTracking({ mode: op === 'camera' ? 'camera' : op === 'roto' ? 'roto' : 'motion' });
    if (!layer) {
      toast('Add or select a footage or precomp layer to track', 'info');
      return;
    }
    setApp({ selLayers: [layer.id] });
    if (op === 'camera') T.trackCamera(comp.id, layer.id);
    else if (op === 'roto') setApp({ tool: 'roto' });
    else T.newTracker(comp.id, layer.id, op);
  });
}
