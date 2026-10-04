// ─────────────────────────────────────────────────────────────────────────────
// Application store (zustand). The project document is immutable (immer);
// every committed edit pushes the previous document onto the undo stack.
// Continuous gestures (drags, scrubs) run inside a transaction so the whole
// gesture becomes ONE undo step. Rapid discrete edits can be coalesced.
// ─────────────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import type { Composition, KeyframeRef, Project } from '../core/types';
import { createProject } from '../core/factory';
import type {
  CameraToolKind, ContextMenuState, DialogState, DockNode, PanelId, Preferences, RenderQueueItem, RevealMode, ShapeToolKind,
  TimelineState, Toast, ToolId, ViewerState,
} from './uiTypes';
import { DEFAULT_WORKSPACE, WORKSPACES } from '../ui/dock/workspaces';

export interface AppState {
  project: Project;
  past: Project[];
  future: Project[];
  txDepth: number;
  txBase: Project | null;
  lastCoalesce: string | null;
  lastCommitAt: number;
  dirty: boolean;
  fileName: string | null;

  activeCompId: string | null;
  openComps: string[];
  selLayers: string[];
  selKeys: string[];
  selProps: string[];
  selItems: string[];
  selEffect: string | null;
  selShapeItem: string | null;
  selMask: string | null;

  tool: ToolId;
  shapeTool: ShapeToolKind;
  cameraTool: CameraToolKind;
  viewers: Record<string, ViewerState>;
  timelines: Record<string, TimelineState>;
  expanded: Record<string, boolean>;
  reveal: RevealMode;
  workspace: string;
  layout: DockNode;
  maximized: PanelId | null;
  focusedPanel: PanelId | null;
  dialog: DialogState | null;
  contextMenu: ContextMenuState | null;
  toasts: Toast[];
  prefs: Preferences;
  renderQueue: RenderQueueItem[];
  exprErrors: Record<string, string>;
  cacheVersion: number;
  renderStats: { ms: number; layers: number; fps: number };
  /** video decode path & timing per footage id (from the render worker) */
  mediaStats: Record<string, import('../render/protocol').VideoDecodeStats>;
  info: { x?: number; y?: number; rgba?: number[] };
  booted: boolean;
}

const HISTORY_LIMIT = 250;

const DEFAULT_PREFS: Preferences = {
  cacheBudgetMB: 1536,
  backgroundRender: true,
  audioScrub: true,
  autoSave: true,
  showSplash: true,
  highlightColor: '#ff9b3f',
  timelineLabelBars: true,
  softwareVideoDecode: false,
};

function loadPrefs(): Preferences {
  try {
    const raw = localStorage.getItem('poo.prefs');
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULT_PREFS };
}

export const useApp = create<AppState>()(() => ({
  project: createProject(),
  past: [],
  future: [],
  txDepth: 0,
  txBase: null,
  lastCoalesce: null,
  lastCommitAt: 0,
  dirty: false,
  fileName: null,
  activeCompId: null,
  openComps: [],
  selLayers: [],
  selKeys: [],
  selProps: [],
  selItems: [],
  selEffect: null,
  selShapeItem: null,
  selMask: null,
  tool: 'select',
  shapeTool: 'rect',
  cameraTool: 'orbit',
  viewers: {},
  timelines: {},
  expanded: {},
  reveal: { kind: 'none' },
  workspace: DEFAULT_WORKSPACE,
  layout: WORKSPACES[DEFAULT_WORKSPACE](),
  maximized: null,
  focusedPanel: null,
  dialog: null,
  contextMenu: null,
  toasts: [],
  prefs: loadPrefs(),
  renderQueue: [],
  exprErrors: {},
  cacheVersion: 0,
  renderStats: { ms: 0, layers: 0, fps: 0 },
  mediaStats: {},
  info: {},
  booted: false,
}));

export const getApp = () => useApp.getState();
export const setApp = (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => useApp.setState(partial);

// ── document commits & history ──────────────────────────────────────────────

export interface DocOptions {
  /** merge with the previous commit if it had the same key and happened recently */
  coalesce?: string;
}

/** Apply an immer recipe to the project. */
export function doc(recipe: (d: Draft<Project>) => void, opts: DocOptions = {}): void {
  const s = getApp();
  const next = produce(s.project, recipe);
  commit(next, opts);
}

export function commit(next: Project, opts: DocOptions = {}): void {
  const s = getApp();
  if (next === s.project) return;
  if (s.txDepth > 0) {
    setApp({ project: next, dirty: true });
    return;
  }
  const now = performance.now();
  const coalesce = !!opts.coalesce && s.lastCoalesce === opts.coalesce && now - s.lastCommitAt < 900;
  setApp({
    project: next,
    past: coalesce ? s.past : [...s.past, s.project].slice(-HISTORY_LIMIT),
    future: [],
    dirty: true,
    lastCoalesce: opts.coalesce ?? null,
    lastCommitAt: now,
  });
}

export function beginTx(): void {
  const s = getApp();
  if (s.txDepth === 0) setApp({ txDepth: 1, txBase: s.project });
  else setApp({ txDepth: s.txDepth + 1 });
}

export function endTx(): void {
  const s = getApp();
  if (s.txDepth <= 0) return;
  if (s.txDepth > 1) {
    setApp({ txDepth: s.txDepth - 1 });
    return;
  }
  const base = s.txBase;
  if (base && base !== s.project) {
    setApp({ txDepth: 0, txBase: null, past: [...s.past, base].slice(-HISTORY_LIMIT), future: [], lastCoalesce: null, lastCommitAt: performance.now() });
  } else setApp({ txDepth: 0, txBase: null });
}

export function cancelTx(): void {
  const s = getApp();
  if (s.txDepth <= 0) return;
  setApp({ txDepth: 0, project: s.txBase ?? s.project, txBase: null });
}

function sanitizeSelection(p: Project): Partial<AppState> {
  const s = getApp();
  const comp = s.activeCompId ? p.comps[s.activeCompId] : undefined;
  const ids = new Set(comp?.layers.map((l) => l.id) ?? []);
  const activeCompId = comp ? s.activeCompId : Object.keys(p.comps)[0] ?? null;
  return {
    activeCompId,
    openComps: s.openComps.filter((c) => p.comps[c]),
    selLayers: s.selLayers.filter((id) => ids.has(id)),
    selKeys: s.selKeys.filter((k) => ids.has(k.split('|')[0])),
    selProps: s.selProps.filter((k) => ids.has(k.split('|')[0])),
  };
}

export function undo(): void {
  const s = getApp();
  if (s.txDepth > 0) cancelTx();
  const st = getApp();
  if (!st.past.length) return;
  const prev = st.past[st.past.length - 1];
  setApp({ project: prev, past: st.past.slice(0, -1), future: [st.project, ...st.future], dirty: true, lastCoalesce: null, ...sanitizeSelection(prev) });
}

export function redo(): void {
  const s = getApp();
  if (!s.future.length) return;
  const next = s.future[0];
  setApp({ project: next, future: s.future.slice(1), past: [...s.past, s.project].slice(-HISTORY_LIMIT), dirty: true, lastCoalesce: null, ...sanitizeSelection(next) });
}

/** Replace the whole project (open/new), resetting history. */
export function loadProject(p: Project, fileName: string | null = null): void {
  const compId = Object.keys(p.comps)[0] ?? null;
  setApp({
    project: p, past: [], future: [], txDepth: 0, txBase: null, dirty: false, fileName,
    activeCompId: compId, openComps: compId ? [compId] : [], selLayers: [], selKeys: [], selProps: [], selItems: [],
    selEffect: null, selShapeItem: null, selMask: null, expanded: {}, reveal: { kind: 'none' }, exprErrors: {},
  });
}

// ── accessors ───────────────────────────────────────────────────────────────

export function activeComp(): Composition | null {
  const s = getApp();
  return s.activeCompId ? s.project.comps[s.activeCompId] ?? null : null;
}

export function useActiveComp(): Composition | null {
  return useApp((s) => (s.activeCompId ? s.project.comps[s.activeCompId] ?? null : null));
}

export const keyOf = (r: KeyframeRef): string => `${r.layerId}|${r.path}|${r.kfId}`;
export const refOf = (k: string): KeyframeRef => {
  const [layerId, path, kfId] = k.split('|');
  return { layerId, path, kfId };
};
export const propKey = (layerId: string, path: string): string => `${layerId}|${path}`;

// ── ui helpers ──────────────────────────────────────────────────────────────

let toastId = 1;
export function toast(message: string, kind: Toast['kind'] = 'info', ms = 3200): void {
  const t: Toast = { id: toastId++, kind, message };
  setApp((s) => ({ toasts: [...s.toasts, t].slice(-5) }));
  setTimeout(() => setApp((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })), ms);
}

export function defaultViewer(): ViewerState {
  return {
    zoom: null, panX: 0, panY: 0, resolution: 'auto', layout: '1',
    views: [{ kind: 'active' }, { kind: 'top', zoom: 0.25 }, { kind: 'front', zoom: 0.25 }, { kind: 'custom' }],
    activeView: 0, grid: false, propGrid: false, safe: false, transparency: false, layerControls: true, motionBlur: true, draft3D: false,
  };
}

export function defaultTimeline(): TimelineState {
  return { pxPerSec: 120, scrollTime: 0, graphEditor: false, graphMode: 'value', leftWidth: 600, showModes: true };
}

export function viewerOf(s: AppState, compId: string | null): ViewerState {
  return (compId && s.viewers[compId]) || DEFAULT_VIEWER;
}

export function timelineOf(s: AppState, compId: string | null): TimelineState {
  return (compId && s.timelines[compId]) || DEFAULT_TIMELINE;
}

const DEFAULT_VIEWER = defaultViewer();
const DEFAULT_TIMELINE = defaultTimeline();

export function setViewer(compId: string, partial: Partial<ViewerState>): void {
  setApp((s) => ({ viewers: { ...s.viewers, [compId]: { ...(s.viewers[compId] ?? defaultViewer()), ...partial } } }));
}

export function setTimeline(compId: string, partial: Partial<TimelineState>): void {
  setApp((s) => ({ timelines: { ...s.timelines, [compId]: { ...(s.timelines[compId] ?? defaultTimeline()), ...partial } } }));
}

export function setPrefs(partial: Partial<Preferences>): void {
  setApp((s) => {
    const prefs = { ...s.prefs, ...partial };
    try {
      localStorage.setItem('poo.prefs', JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
    return { prefs };
  });
}

export function openDialog(d: DialogState): void {
  setApp({ dialog: d, contextMenu: null });
}

export function closeDialog(): void {
  setApp({ dialog: null });
}

export function openContextMenu(x: number, y: number, items: ContextMenuState['items']): void {
  setApp({ contextMenu: { x, y, items } });
}
