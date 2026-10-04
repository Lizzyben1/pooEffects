// ─────────────────────────────────────────────────────────────────────────────
// Command registry: every menu item, context menu entry and keyboard shortcut
// maps to a named command so behaviour is consistent everywhere.
// ─────────────────────────────────────────────────────────────────────────────

import { activeComp, getApp, openDialog, redo, setApp, setViewer, toast, undo, viewerOf, loadProject } from '../state/store';
import * as A from '../state/actions';
import { getTime, setTime } from '../state/time';
import {
  createAdjustmentLayer, createCameraLayer, createLightLayer, createNullLayer, createShapeLayer, createSolidLayer, createTextLayer,
  createProject, createFootageLayer, rectPath,
} from '../core/factory';
import { togglePlay, stop as stopPlayback } from '../state/playback';
import { openProjectFile, pickFiles, saveProjectFile, downloadBlob } from '../state/projectIO';
import { importFile } from '../state/media';
import { buildDemoProject, ensureProceduralMedia } from '../demo';
import { clearAll as clearCache } from '../state/cache';
import { WORKSPACES } from './dock/workspaces';
import { ensurePanel } from './dock/layout';
import { getTracking, stopTracking } from '../state/tracking';
import type { PanelId } from '../state/uiTypes';
import type { LightKind, TextAnimatorPropKey } from '../core/types';
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

const SOLID_COLORS = ['#1b1f2a', '#ff9b3f', '#4f9dff', '#3ddc84', '#b48cff', '#ff5d6c'];
let solidIdx = 0;

export async function importFiles(files: File[], addToComp = false): Promise<void> {
  let n = 0;
  for (const f of files) {
    if (/\.pooe$/i.test(f.name)) {
      await openProjectFile(f);
      return;
    }
    const footage = await importFile(f);
    if (footage) {
      A.addFootage(footage);
      n++;
      const c = comp();
      if (addToComp && c) A.addLayer(c.id, createFootageLayer(c, footage), { index: 0 });
    }
  }
  if (n) toast(`Imported ${n} item${n > 1 ? 's' : ''}`, 'success');
}

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
      break;
    default:
      A.addLayer(cid, createLightLayer(c, kind), { index: 0 });
  }
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

export function togglePanel(p: PanelId): void {
  setApp((s) => ({ layout: ensurePanel(s.layout, p), focusedPanel: p }));
}

export function setWorkspace(name: string): void {
  const f = WORKSPACES[name];
  if (f) setApp({ workspace: name, layout: f(), maximized: null });
  setTimeout(() => window.dispatchEvent(new Event('resize')), 0);
}

export async function loadDemo(): Promise<void> {
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
  stopPlayback();
  clearCache();
  const p = createProject('Untitled Project');
  loadProject(p, null);
  openDialog({ kind: 'newComp' });
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
  openProject: async () => {
    const files = await pickFiles('.pooe,application/zip', false);
    if (files[0]) await openProjectFile(files[0]);
  },
  save: () => void saveProjectFile(),
  importFile: async () => {
    const files = await pickFiles('image/*,video/*,audio/*,.ttf,.otf,.woff,.woff2,.pooe');
    await importFiles(files);
  },
  loadDemo: () => void loadDemo(),
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
    const ns = needSel();
    if (ns) A.duplicateLayers(ns[0], ns[1]);
  },
  split: () => {
    const ns = needSel();
    if (ns) A.splitLayers(ns[0], ns[1]);
  },
  delete: () => {
    const s = getApp();
    const c = comp();
    if (s.focusedPanel === 'project' && s.selItems.length) {
      A.deleteProjectItems(s.selItems);
      return;
    }
    if (!c) return;
    if (s.selKeys.length) A.deleteKeyframes(s.selKeys);
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
  easyEase: () => A.easyEase(getApp().selKeys, 'both'),
  easeIn: () => A.easyEase(getApp().selKeys, 'in'),
  easeOut: () => A.easyEase(getApp().selKeys, 'out'),
  interpLinear: () => A.setKeyframeInterpolation(getApp().selKeys, 'linear'),
  interpBezier: () => A.setKeyframeInterpolation(getApp().selKeys, 'bezier'),
  interpAuto: () => A.setKeyframeInterpolation(getApp().selKeys, 'auto'),
  interpHold: () => A.setKeyframeInterpolation(getApp().selKeys, 'hold'),
  keyframeVelocity: () => {
    const id = needComp();
    if (id && getApp().selKeys.length) openDialog({ kind: 'keyframeVelocity', compId: id });
  },
  revealKeyframes: () => A.revealKeyframes(),
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
