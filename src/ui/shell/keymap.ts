// ─────────────────────────────────────────────────────────────────────────────
// Global keyboard map (After Effects bindings). The table below is the single
// source of truth: the handler matches against it and the Keyboard Shortcuts
// dialog renders it, so the documentation can never drift from behaviour.
// Combos are written with "Ctrl" (⌘ on macOS), "Alt" (⌥) and "Shift".
// ─────────────────────────────────────────────────────────────────────────────

import { activeComp, getApp, setApp, setTimeline, timelineOf, toast } from '../../state/store';
import * as A from '../../state/actions';
import { getTime, timeStore } from '../../state/time';
import { stop as stopPlayback, togglePlay } from '../../state/playback';
import { commands as C, isMac, newLayer, setTool, togglePanel } from '../commands';
import { toggleMaximize } from '../dock/Dock';
import { frameDuration } from '../../core/time';
import { layerSpan, toLayerTime } from '../../core/evaluate';
import { keyframedValue } from '../../anim/interpolate';
import type { PanelId } from '../../state/uiTypes';

export type ShortcutGroup = 'File' | 'Edit' | 'Playback & Time' | 'Timeline' | 'Layers' | 'Keyframes' | 'Tools' | 'View' | 'Panels';

export interface Shortcut {
  keys: string[];
  label: string;
  group: ShortcutGroup;
  run: () => void;
  /** fire on auto-repeat while held */
  repeat?: boolean;
  /** shown in the dialog but handled elsewhere */
  displayOnly?: boolean;
  note?: string;
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = ['File', 'Edit', 'Playback & Time', 'Timeline', 'Layers', 'Keyframes', 'Tools', 'View', 'Panels'];

// ── helpers used by bindings ────────────────────────────────────────────────

function withComp(fn: (compId: string) => void): () => void {
  return () => {
    const c = activeComp();
    if (c) fn(c.id);
  };
}

function goLayerEdge(which: 'in' | 'out'): void {
  const c = activeComp();
  if (!c) return;
  const s = getApp();
  const l = c.layers.find((x) => s.selLayers.includes(x.id));
  if (!l) {
    toast('Select a layer', 'warn', 1500);
    return;
  }
  const [a, b] = layerSpan(l);
  A.goToTime(c.id, which === 'in' ? a : b - frameDuration(c.frameRate));
}

function selectAdjacentLayer(dir: -1 | 1, extend: boolean): void {
  const c = activeComp();
  if (!c || !c.layers.length) return;
  const s = getApp();
  const idx = c.layers.map((l, i) => (s.selLayers.includes(l.id) ? i : -1)).filter((i) => i >= 0);
  const from = idx.length ? (dir > 0 ? Math.max(...idx) : Math.min(...idx)) : dir > 0 ? -1 : c.layers.length;
  const next = Math.max(0, Math.min(c.layers.length - 1, from + dir));
  A.selectLayers([c.layers[next].id], extend ? 'add' : 'set');
}

function zoomTimeline(factor: number): void {
  const c = activeComp();
  if (!c) return;
  const tl = timelineOf(getApp(), c.id);
  const t = getTime(c.id);
  const pps = Math.max(2, tl.pxPerSec || 100);
  const nz = Math.max(2, Math.min(4000, pps * factor));
  const x = (t - tl.scrollTime) * pps;
  setTimeline(c.id, { pxPerSec: nz, scrollTime: Math.max(0, t - x / nz) });
}

function toggleFrameZoom(): void {
  const c = activeComp();
  if (!c) return;
  const tl = timelineOf(getApp(), c.id);
  const frameLevel = 48 * c.frameRate;
  if (tl.pxPerSec > frameLevel * 0.5) setTimeline(c.id, { pxPerSec: 0, scrollTime: 0 });
  else {
    const t = getTime(c.id);
    setTimeline(c.id, { pxPerSec: frameLevel, scrollTime: Math.max(0, t - 6 / c.frameRate) });
  }
}

function nudgeKeyframes(frames: number): void {
  const c = activeComp();
  const keys = getApp().selKeys;
  if (!c || !keys.length) return;
  A.retimeKeyframes(c.id, A.keyframeCompTimes(c.id, keys), frames * frameDuration(c.frameRate));
}

function nudgeLayersInTime(frames: number): void {
  const c = activeComp();
  const ids = getApp().selLayers;
  if (!c || !ids.length) return;
  A.shiftLayers(c.id, ids, frames * frameDuration(c.frameRate));
}

/** Arrow keys: move selected layers 1 px (10 px with Shift) in comp space. */
function nudgePosition(dx: number, dy: number): void {
  const c = activeComp();
  if (!c) return;
  const s = getApp();
  const t = getTime(c.id);
  const layers = c.layers.filter((l) => s.selLayers.includes(l.id) && !l.locked && l.type !== 'audio');
  if (!layers.length) return;
  for (const l of layers) {
    const p = keyframedValue(l.transform.position, toLayerTime(l, t), true) as number[];
    A.setPropValue(c.id, l.id, 'transform.position', [p[0] + dx, p[1] + dy, p[2] ?? 0], 'nudge');
  }
}

function setViewerToggle(key: 'grid' | 'safe' | 'layerControls'): void {
  const map = { grid: C.toggleGrid, safe: C.toggleSafe, layerControls: C.toggleLayerControls };
  map[key]();
}

const panel = (p: PanelId) => () => togglePanel(p);

// ── the table ───────────────────────────────────────────────────────────────

export const SHORTCUTS: Shortcut[] = [
  // File
  { keys: ['Ctrl+Alt+N'], label: 'New Project', group: 'File', run: C.newProject },
  { keys: ['Ctrl+O'], label: 'Open Project…', group: 'File', run: () => void C.openProject() },
  { keys: ['Ctrl+S'], label: 'Save Project', group: 'File', run: C.save },
  { keys: ['Ctrl+I'], label: 'Import File…', group: 'File', run: () => void C.importFile() },
  { keys: ['Ctrl+M'], label: 'Add to Render Queue', group: 'File', run: C.addToRenderQueue },
  { keys: ['Ctrl+Shift+E'], label: 'Quick Export…', group: 'File', run: C.export },
  { keys: ['Ctrl+Alt+S'], label: 'Save Frame As PNG', group: 'File', run: C.saveFrame },

  // Edit
  { keys: ['Ctrl+Z'], label: 'Undo', group: 'Edit', run: C.undo, repeat: true },
  { keys: ['Ctrl+Shift+Z'], label: 'Redo', group: 'Edit', run: C.redo, repeat: true },
  { keys: ['Ctrl+X'], label: 'Cut', group: 'Edit', run: C.cut },
  { keys: ['Ctrl+C'], label: 'Copy', group: 'Edit', run: C.copy },
  { keys: ['Ctrl+V'], label: 'Paste', group: 'Edit', run: C.paste },
  { keys: ['Ctrl+D'], label: 'Duplicate', group: 'Edit', run: C.duplicate },
  { keys: ['Ctrl+Shift+D'], label: 'Split Layer at Current Time', group: 'Edit', run: C.split },
  { keys: ['Delete', 'Backspace'], label: 'Delete', group: 'Edit', run: C.delete },
  { keys: ['Ctrl+A'], label: 'Select All', group: 'Edit', run: C.selectAll },
  { keys: ['Ctrl+Shift+A', 'F2'], label: 'Deselect All', group: 'Edit', run: C.deselectAll },
  { keys: ['F1'], label: 'Keyboard Shortcuts', group: 'Edit', run: C.shortcuts },

  // Playback & time
  { keys: ['Space'], label: 'Play / Stop (hold + drag in viewer to pan)', group: 'Playback & Time', run: togglePlay, displayOnly: true },
  { keys: ['Num0'], label: 'RAM Preview', group: 'Playback & Time', run: togglePlay },
  { keys: ['Esc'], label: 'Stop Playback / Clear Keyframe Selection', group: 'Playback & Time', run: () => (timeStore.getState().playing ? stopPlayback() : setApp({ selKeys: [] })) },
  { keys: ['Home', 'Ctrl+Alt+Left'], label: 'Go to Start', group: 'Playback & Time', run: C.goStart },
  { keys: ['End', 'Ctrl+Alt+Right'], label: 'Go to End', group: 'Playback & Time', run: C.goEnd },
  { keys: ['PageUp', 'Ctrl+Left'], label: 'Previous Frame', group: 'Playback & Time', run: () => A.stepFrames(-1), repeat: true },
  { keys: ['PageDown', 'Ctrl+Right'], label: 'Next Frame', group: 'Playback & Time', run: () => A.stepFrames(1), repeat: true },
  { keys: ['Shift+PageUp', 'Ctrl+Shift+Left'], label: 'Back 10 Frames', group: 'Playback & Time', run: () => A.stepFrames(-10), repeat: true },
  { keys: ['Shift+PageDown', 'Ctrl+Shift+Right'], label: 'Forward 10 Frames', group: 'Playback & Time', run: () => A.stepFrames(10), repeat: true },
  { keys: ['J'], label: 'Previous Keyframe / Marker / Edit', group: 'Playback & Time', run: () => A.jumpKeyframe(-1), repeat: true },
  { keys: ['K'], label: 'Next Keyframe / Marker / Edit', group: 'Playback & Time', run: () => A.jumpKeyframe(1), repeat: true },
  { keys: ['I'], label: 'Go to Layer In Point', group: 'Playback & Time', run: () => goLayerEdge('in') },
  { keys: ['O'], label: 'Go to Layer Out Point', group: 'Playback & Time', run: () => goLayerEdge('out') },
  { keys: ['B'], label: 'Set Work Area Start', group: 'Playback & Time', run: C.workAreaStart },
  { keys: ['N'], label: 'Set Work Area End', group: 'Playback & Time', run: C.workAreaEnd },
  { keys: ['Num*', 'Shift+8'], label: 'Add Composition Marker', group: 'Playback & Time', run: withComp((id) => A.addCompMarker(id)) },

  // Timeline
  { keys: ['U'], label: 'Reveal Animated Properties (UU: modified)', group: 'Timeline', run: () => A.revealKeyframes() },
  { keys: ['P'], label: 'Reveal Position (Shift adds)', group: 'Timeline', run: () => A.revealProps('P', false) },
  { keys: ['S'], label: 'Reveal Scale', group: 'Timeline', run: () => A.revealProps('S', false) },
  { keys: ['R'], label: 'Reveal Rotation', group: 'Timeline', run: () => A.revealProps('R', false) },
  { keys: ['T'], label: 'Reveal Opacity', group: 'Timeline', run: () => A.revealProps('T', false) },
  { keys: ['A'], label: 'Reveal Anchor Point', group: 'Timeline', run: () => A.revealProps('A', false) },
  { keys: ['Shift+P'], label: 'Add Position to Revealed', group: 'Timeline', run: () => A.revealProps('P', true) },
  { keys: ['Shift+S'], label: 'Add Scale to Revealed', group: 'Timeline', run: () => A.revealProps('S', true) },
  { keys: ['Shift+R'], label: 'Add Rotation to Revealed', group: 'Timeline', run: () => A.revealProps('R', true) },
  { keys: ['Shift+T'], label: 'Add Opacity to Revealed', group: 'Timeline', run: () => A.revealProps('T', true) },
  { keys: ['Shift+A'], label: 'Add Anchor Point to Revealed', group: 'Timeline', run: () => A.revealProps('A', true) },
  { keys: ['E'], label: 'Reveal Effects', group: 'Timeline', run: () => A.revealEffects() },
  { keys: ['M'], label: 'Reveal Masks', group: 'Timeline', run: () => A.revealMasks() },
  { keys: ['='], label: 'Zoom In (Time)', group: 'Timeline', run: () => zoomTimeline(1.5), repeat: true },
  { keys: ['-'], label: 'Zoom Out (Time)', group: 'Timeline', run: () => zoomTimeline(1 / 1.5), repeat: true },
  { keys: [';'], label: 'Toggle Frame-Level Zoom', group: 'Timeline', run: toggleFrameZoom },
  { keys: ['Shift+F3'], label: 'Toggle Graph Editor', group: 'Timeline', run: withComp((id) => setTimeline(id, { graphEditor: !timelineOf(getApp(), id).graphEditor })) },
  { keys: ['F4'], label: 'Toggle Switches / Modes Columns', group: 'Timeline', run: withComp((id) => setTimeline(id, { showModes: !timelineOf(getApp(), id).showModes })) },

  // Layers
  { keys: ['Ctrl+N', 'Alt+Shift+N'], label: 'New Composition…', group: 'Layers', run: C.newComp, note: 'Ctrl+N is reserved by most browsers outside an installed app' },
  { keys: ['Ctrl+K'], label: 'Composition Settings…', group: 'Layers', run: C.compSettings },
  { keys: ['Ctrl+Y'], label: 'New Solid…', group: 'Layers', run: C.newSolid },
  { keys: ['Ctrl+Alt+Y'], label: 'New Adjustment Layer', group: 'Layers', run: C.newAdjustment },
  { keys: ['Ctrl+Alt+Shift+Y'], label: 'New Null Object', group: 'Layers', run: C.newNull },
  { keys: ['Ctrl+Alt+Shift+T'], label: 'New Text Layer', group: 'Layers', run: C.newText },
  { keys: ['Ctrl+Alt+Shift+C'], label: 'New Camera', group: 'Layers', run: C.newCamera },
  { keys: ['Ctrl+Alt+Shift+L'], label: 'New Light', group: 'Layers', run: () => newLayer('point') },
  { keys: ['Ctrl+Shift+Y'], label: 'Layer Settings…', group: 'Layers', run: C.layerSettings },
  { keys: ['Ctrl+Shift+N', 'Ctrl+Alt+M'], label: 'New Mask', group: 'Layers', run: C.newMask },
  { keys: ['Ctrl+Shift+C'], label: 'Pre-compose…', group: 'Layers', run: C.precompose },
  { keys: ['Ctrl+Alt+T'], label: 'Enable Time Remapping', group: 'Layers', run: C.timeRemap },
  { keys: ['Ctrl+Alt+R'], label: 'Time-Reverse Layer', group: 'Layers', run: C.timeReverse },
  { keys: ['Ctrl+Alt+Home'], label: 'Center Anchor in Layer Content', group: 'Layers', run: C.centerAnchor },
  { keys: ['Ctrl+Alt+F'], label: 'Fit Layer to Comp', group: 'Layers', run: C.fitToComp },
  { keys: ['Ctrl+L'], label: 'Lock / Unlock Layer', group: 'Layers', run: C.toggleLock },
  { keys: ['Ctrl+]'], label: 'Bring Layer Forward', group: 'Layers', run: C.bringForward },
  { keys: ['Ctrl+['], label: 'Send Layer Backward', group: 'Layers', run: C.sendBackward },
  { keys: ['Ctrl+Shift+]'], label: 'Bring Layer to Front', group: 'Layers', run: C.bringToFront },
  { keys: ['Ctrl+Shift+['], label: 'Send Layer to Back', group: 'Layers', run: C.sendToBack },
  { keys: ['['], label: 'Move In Point to Current Time', group: 'Layers', run: C.moveIn },
  { keys: [']'], label: 'Move Out Point to Current Time', group: 'Layers', run: C.moveOut },
  { keys: ['Alt+['], label: 'Trim In Point to Current Time', group: 'Layers', run: C.trimIn },
  { keys: ['Alt+]'], label: 'Trim Out Point to Current Time', group: 'Layers', run: C.trimOut },
  { keys: ['Alt+PageUp'], label: 'Move Layer 1 Frame Earlier', group: 'Layers', run: () => nudgeLayersInTime(-1), repeat: true },
  { keys: ['Alt+PageDown'], label: 'Move Layer 1 Frame Later', group: 'Layers', run: () => nudgeLayersInTime(1), repeat: true },
  { keys: ['Ctrl+Up'], label: 'Select Layer Above', group: 'Layers', run: () => selectAdjacentLayer(-1, false), repeat: true },
  { keys: ['Ctrl+Down'], label: 'Select Layer Below', group: 'Layers', run: () => selectAdjacentLayer(1, false), repeat: true },
  { keys: ['Ctrl+Shift+Up'], label: 'Extend Selection Up', group: 'Layers', run: () => selectAdjacentLayer(-1, true), repeat: true },
  { keys: ['Ctrl+Shift+Down'], label: 'Extend Selection Down', group: 'Layers', run: () => selectAdjacentLayer(1, true), repeat: true },
  { keys: ['Left'], label: 'Nudge Left 1 px', group: 'Layers', run: () => nudgePosition(-1, 0), repeat: true },
  { keys: ['Right'], label: 'Nudge Right 1 px', group: 'Layers', run: () => nudgePosition(1, 0), repeat: true },
  { keys: ['Up'], label: 'Nudge Up 1 px', group: 'Layers', run: () => nudgePosition(0, -1), repeat: true },
  { keys: ['Down'], label: 'Nudge Down 1 px', group: 'Layers', run: () => nudgePosition(0, 1), repeat: true },
  { keys: ['Shift+Left'], label: 'Nudge Left 10 px', group: 'Layers', run: () => nudgePosition(-10, 0), repeat: true },
  { keys: ['Shift+Right'], label: 'Nudge Right 10 px', group: 'Layers', run: () => nudgePosition(10, 0), repeat: true },
  { keys: ['Shift+Up'], label: 'Nudge Up 10 px', group: 'Layers', run: () => nudgePosition(0, -10), repeat: true },
  { keys: ['Shift+Down'], label: 'Nudge Down 10 px', group: 'Layers', run: () => nudgePosition(0, 10), repeat: true },

  // Keyframes
  { keys: ['F9'], label: 'Easy Ease', group: 'Keyframes', run: C.easyEase },
  { keys: ['Shift+F9'], label: 'Easy Ease In', group: 'Keyframes', run: C.easeIn },
  { keys: ['Ctrl+Shift+F9'], label: 'Easy Ease Out', group: 'Keyframes', run: C.easeOut },
  { keys: ['Ctrl+Alt+H'], label: 'Toggle Hold Keyframe', group: 'Keyframes', run: C.interpHold },
  { keys: ['Ctrl+Shift+K'], label: 'Keyframe Velocity…', group: 'Keyframes', run: C.keyframeVelocity },
  { keys: ['Alt+Left'], label: 'Nudge Keyframes 1 Frame Earlier', group: 'Keyframes', run: () => nudgeKeyframes(-1), repeat: true },
  { keys: ['Alt+Right'], label: 'Nudge Keyframes 1 Frame Later', group: 'Keyframes', run: () => nudgeKeyframes(1), repeat: true },
  { keys: ['Alt+Shift+P'], label: 'Add Position Keyframe', group: 'Keyframes', run: () => C.addKeyframe('transform.position') },
  { keys: ['Alt+Shift+S'], label: 'Add Scale Keyframe', group: 'Keyframes', run: () => C.addKeyframe('transform.scale') },
  { keys: ['Alt+Shift+R'], label: 'Add Rotation Keyframe', group: 'Keyframes', run: () => C.addKeyframe('transform.rotation') },
  { keys: ['Alt+Shift+T'], label: 'Add Opacity Keyframe', group: 'Keyframes', run: () => C.addKeyframe('transform.opacity') },
  { keys: ['Alt+Shift+A'], label: 'Add Anchor Point Keyframe', group: 'Keyframes', run: () => C.addKeyframe('transform.anchor') },

  // Tools
  { keys: ['V'], label: 'Selection Tool', group: 'Tools', run: () => setTool('select') },
  { keys: ['H'], label: 'Hand Tool', group: 'Tools', run: () => setTool('hand') },
  { keys: ['Z'], label: 'Zoom Tool', group: 'Tools', run: () => setTool('zoom') },
  { keys: ['W'], label: 'Rotation Tool', group: 'Tools', run: () => setTool('rotate') },
  { keys: ['C'], label: 'Camera Tools (press again to cycle)', group: 'Tools', run: () => setTool('camera') },
  { keys: ['Y'], label: 'Pan Behind (Anchor Point) Tool', group: 'Tools', run: () => setTool('panBehind') },
  { keys: ['Q'], label: 'Shape Tools (press again to cycle)', group: 'Tools', run: () => setTool('shape') },
  { keys: ['G'], label: 'Pen Tool', group: 'Tools', run: () => setTool('pen') },
  { keys: ['Alt+W'], label: 'Roto Brush Tool (SAM 2)', group: 'Tools', run: () => setTool('roto') },
  { keys: ['Ctrl+T'], label: 'Type Tool', group: 'Tools', run: () => setTool('text'), note: 'Ctrl+T is reserved by most browsers outside an installed app' },

  // View
  { keys: ['.'], label: 'Zoom In (Viewer)', group: 'View', run: C.zoomIn, repeat: true },
  { keys: [','], label: 'Zoom Out (Viewer)', group: 'View', run: C.zoomOut, repeat: true },
  { keys: ['/'], label: 'Actual Size (100%)', group: 'View', run: C.zoom100 },
  { keys: ['Shift+/'], label: 'Fit Comp in Viewer', group: 'View', run: C.zoomFit },
  { keys: ["Ctrl+'"], label: 'Show Grid', group: 'View', run: () => setViewerToggle('grid') },
  { keys: ["'"], label: 'Title / Action Safe', group: 'View', run: () => setViewerToggle('safe') },
  { keys: ['Ctrl+Shift+H'], label: 'Show Layer Controls', group: 'View', run: () => setViewerToggle('layerControls') },
  { keys: ['`'], label: 'Maximize Panel Under Cursor', group: 'View', run: toggleMaximize },

  // Panels
  { keys: ['F3'], label: 'Effect Controls', group: 'Panels', run: panel('effectControls') },
  { keys: ['Ctrl+0'], label: 'Project', group: 'Panels', run: panel('project') },
  { keys: ['Ctrl+2'], label: 'Info', group: 'Panels', run: panel('info') },
  { keys: ['Ctrl+3'], label: 'Preview', group: 'Panels', run: panel('preview') },
  { keys: ['Ctrl+5'], label: 'Effects & Presets', group: 'Panels', run: panel('effects') },
  { keys: ['Ctrl+6'], label: 'Character', group: 'Panels', run: panel('character') },
  { keys: ['Ctrl+Alt+0'], label: 'Render Queue', group: 'Panels', run: panel('renderQueue') },
];

// ── event → combo ───────────────────────────────────────────────────────────

const CODE_NAMES: Record<string, string> = {
  Space: 'Space', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowLeft: 'Left', ArrowRight: 'Right',
  ArrowUp: 'Up', ArrowDown: 'Down', Delete: 'Delete', Backspace: 'Backspace', Escape: 'Esc', Enter: 'Enter', NumpadEnter: 'NumEnter',
  Tab: 'Tab', BracketLeft: '[', BracketRight: ']', Period: '.', Comma: ',', Slash: '/', Equal: '=', Minus: '-', Quote: "'",
  Backquote: '`', Semicolon: ';', Backslash: '\\', Numpad0: 'Num0', NumpadMultiply: 'Num*', NumpadAdd: '=', NumpadSubtract: '-',
  NumpadDecimal: '.',
};

export function comboOf(e: KeyboardEvent): string | null {
  let k: string | undefined;
  if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) k = e.code;
  else k = CODE_NAMES[e.code];
  if (!k) return null;
  const mods: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, k].join('+');
}

/** Pretty-print a combo for the current platform. */
export function formatCombo(combo: string): string[] {
  return combo.split('+').map((part) => {
    if (!isMac) return part;
    return ({ Ctrl: '⌘', Alt: '⌥', Shift: '⇧', Left: '←', Right: '→', Up: '↑', Down: '↓', Backspace: '⌫', Delete: '⌦', Esc: '⎋' } as Record<string, string>)[part] ?? part;
  });
}

const table = new Map<string, Shortcut>();
for (const s of SHORTCUTS) if (!s.displayOnly) for (const k of s.keys) table.set(k, s);

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

// ── install ─────────────────────────────────────────────────────────────────

/** Space plays on release unless the viewer was dragged while it was held (temporary hand tool). */
let spaceDown = false;
let spaceUsedForPan = false;

export function installKeymap(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || isTyping(e.target)) return;
    const s = getApp();
    if (s.dialog || s.contextMenu) return;
    if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (!e.repeat) {
        spaceDown = true;
        spaceUsedForPan = false;
      }
      return;
    }
    const combo = comboOf(e);
    if (!combo) return;
    const sc = table.get(combo);
    if (!sc) return;
    e.preventDefault();
    if (e.repeat && !sc.repeat) return;
    sc.run();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code !== 'Space' || !spaceDown) return;
    spaceDown = false;
    if (!spaceUsedForPan && !isTyping(e.target) && !getApp().dialog) togglePlay();
  };
  const onPointer = () => {
    if (spaceDown) spaceUsedForPan = true;
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('pointerdown', onPointer, true);
  return () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('pointerdown', onPointer, true);
  };
}
