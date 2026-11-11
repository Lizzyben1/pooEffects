// Menubar definitions built from the command registry.

import type { MenuItem } from '../../state/uiTypes';
import { ALT, MOD, SHIFT, addTextAnimator, commands as C, currentTarget, newLayer, setTool, setWorkspace, startTracking, togglePanel } from '../commands';
import { activeComp, getApp, setViewer, viewerOf } from '../../state/store';
import { EFFECT_CATEGORIES, EFFECTS } from '../../effects/catalog';
import { addEffectToSelection, clipboardKind } from '../../state/actions';
import { WORKSPACES } from '../dock/workspaces';
import { PANELS } from '../panels/registry';
import type { PanelId, Resolution } from '../../state/uiTypes';
import { hasPanel } from '../dock/layout';
import type { ViewKind } from '../../render/projection';

const v = () => {
  const c = activeComp();
  return c ? viewerOf(getApp(), c.id) : null;
};

/** Grey out a group of items (their submenus stay closed) when its precondition is not met. */
const gate = (off: boolean, items: MenuItem[]): MenuItem[] => (off ? items.map((it) => (it.separator ? it : { ...it, disabled: true })) : items);

/** What is available right now — drives the greyed-out state of menu items. */
function avail() {
  const s = getApp();
  const c = activeComp();
  const layers = c ? c.layers.filter((l) => s.selLayers.includes(l.id)) : [];
  return {
    comp: !!c,
    layers: layers.length > 0,
    textLayer: layers.some((l) => l.type === 'text'),
    keys: !!c && s.selKeys.length > 0,
    target: !!currentTarget(),
    items: s.focusedPanel === 'project' && s.selItems.length > 0,
    clip: !!clipboardKind(),
  };
}

export function effectsSubmenu(): MenuItem[] {
  return EFFECT_CATEGORIES.map((cat) => ({
    label: cat,
    submenu: EFFECTS.filter((e) => e.category === cat).map((e) => ({ label: e.name, action: () => addEffectToSelection(e.type) })),
  }));
}

export const MENUS: { label: string; items: () => MenuItem[] }[] = [
  {
    label: 'File',
    items: () => {
      const a = avail();
      return [
      { label: 'New Project', shortcut: `${MOD}${ALT}N`, action: C.newProject },
      { label: 'Open Project…', shortcut: `${MOD}O`, action: C.openProject },
      { label: 'Save Project', shortcut: `${MOD}S`, action: C.save },
      { separator: true },
      { label: 'Import File…', shortcut: `${MOD}I`, action: C.importFile },
      { label: 'Load Demo Project', action: C.loadDemo },
      { separator: true },
      { label: 'Export / Add to Render Queue', shortcut: `${MOD}M`, disabled: !a.comp, action: C.addToRenderQueue },
      { label: 'Quick Export…', shortcut: `${MOD}${SHIFT}E`, disabled: !a.comp, action: C.export },
      { label: 'Save Frame As PNG', shortcut: `${MOD}${ALT}S`, disabled: !a.comp, action: C.saveFrame },
      ];
    },
  },
  {
    label: 'Edit',
    items: () => {
      const s = getApp();
      const a = avail();
      const any = a.layers || a.keys || a.target || a.items;
      return [
        { label: 'Undo', shortcut: `${MOD}Z`, action: C.undo, disabled: !s.past.length },
        { label: 'Redo', shortcut: `${MOD}${SHIFT}Z`, action: C.redo, disabled: !s.future.length },
        { separator: true },
        { label: 'Cut', shortcut: `${MOD}X`, disabled: !(a.layers || a.keys), action: C.cut },
        { label: 'Copy', shortcut: `${MOD}C`, disabled: !(a.layers || a.keys), action: C.copy },
        { label: 'Paste', shortcut: `${MOD}V`, disabled: !a.clip || !a.comp, action: C.paste },
        { label: 'Duplicate', shortcut: `${MOD}D`, disabled: !(a.layers || a.target), action: C.duplicate },
        { label: 'Split Layer', shortcut: `${MOD}${SHIFT}D`, disabled: !a.layers, action: C.split },
        { label: 'Delete', shortcut: 'Del', disabled: !any, action: C.delete },
        { separator: true },
        { label: 'Select All', shortcut: `${MOD}A`, disabled: !a.comp, action: C.selectAll },
        { label: 'Deselect All', shortcut: `${MOD}${SHIFT}A`, disabled: !any, action: C.deselectAll },
        { separator: true },
        { label: 'Preferences…', action: C.prefs },
        { label: 'Keyboard Shortcuts', shortcut: 'F1', action: C.shortcuts },
      ];
    },
  },
  {
    label: 'Composition',
    items: () => {
      const off = !avail().comp;
      return [
        { label: 'New Composition…', shortcut: `${MOD}N`, action: C.newComp },
        { label: 'Composition Settings…', shortcut: `${MOD}K`, disabled: off, action: C.compSettings },
        { separator: true },
        { label: 'Preview (Play / Stop)', shortcut: 'Space', disabled: off, action: C.play },
        { label: 'Set Work Area Start', shortcut: 'B', disabled: off, action: C.workAreaStart },
        { label: 'Set Work Area End', shortcut: 'N', disabled: off, action: C.workAreaEnd },
        { label: 'Trim Comp to Work Area', disabled: off, action: C.trimComp },
        { label: 'Add Marker', shortcut: `${SHIFT}8`, disabled: off, action: C.addMarker },
        { separator: true },
        { label: 'Add to Render Queue', shortcut: `${MOD}M`, disabled: off, action: C.addToRenderQueue },
        { label: 'Save Frame As PNG', shortcut: `${MOD}${ALT}S`, disabled: off, action: C.saveFrame },
      ];
    },
  },
  {
    label: 'Layer',
    items: () => {
      const a = avail();
      return [
      ...gate(!a.comp, [{
        label: 'New',
        submenu: [
          { label: 'Text', shortcut: `${MOD}${ALT}${SHIFT}T`, action: C.newText },
          { label: 'Solid…', shortcut: `${MOD}Y`, action: C.newSolid },
          { label: 'Light', submenu: (['point', 'spot', 'parallel', 'ambient'] as const).map((k) => ({ label: `${k[0].toUpperCase()}${k.slice(1)} Light`, action: () => newLayer(k) })) },
          { label: 'Camera', shortcut: `${MOD}${ALT}${SHIFT}C`, action: C.newCamera },
          { label: 'Null Object', shortcut: `${MOD}${ALT}${SHIFT}Y`, action: C.newNull },
          { label: 'Shape Layer', action: C.newShape },
          { label: 'Adjustment Layer', shortcut: `${MOD}${ALT}Y`, action: C.newAdjustment },
        ],
      }]),
      ...gate(!a.layers, [
      { label: 'Layer Settings…', shortcut: `${MOD}${SHIFT}Y`, action: C.layerSettings },
      { label: 'Rename', shortcut: 'Enter', disabled: getApp().selLayers.length !== 1, action: C.renameLayer },
      { separator: true },
      { label: 'New Mask', shortcut: `${MOD}${SHIFT}N`, action: C.newMask },
      {
        label: 'Transform',
        submenu: [
          { label: 'Reset', action: C.resetTransform },
          { label: 'Center Anchor Point in Layer Content', shortcut: `${MOD}${ALT}Home`, action: C.centerAnchor },
          { label: 'Fit to Comp', shortcut: `${MOD}${ALT}F`, action: C.fitToComp },
        ],
      },
      {
        label: 'Time',
        submenu: [
          { label: 'Enable Time Remapping', shortcut: `${MOD}${ALT}T`, action: C.timeRemap },
          { label: 'Time-Reverse Layer', shortcut: `${MOD}${ALT}R`, action: C.timeReverse },
          { label: 'Time Stretch…', action: C.timeStretch },
          { label: 'Freeze Frame', action: C.freezeFrame },
        ],
      },
      { label: 'Pre-compose…', shortcut: `${MOD}${SHIFT}C`, action: C.precompose },
      { separator: true },
      {
        label: 'Switches',
        submenu: [
          { label: 'Hide / Show', action: C.toggleVisible },
          { label: '3D Layer', action: C.toggle3D },
          { label: 'Motion Blur', action: C.toggleMotionBlur },
          { label: 'Solo', action: C.toggleSolo },
          { label: 'Lock', shortcut: `${MOD}L`, action: C.toggleLock },
          { label: 'Shy', action: C.toggleShy },
        ],
      },
      {
        label: 'Arrange',
        submenu: [
          { label: 'Bring Layer to Front', shortcut: `${MOD}${SHIFT}]`, action: C.bringToFront },
          { label: 'Bring Layer Forward', shortcut: `${MOD}]`, action: C.bringForward },
          { label: 'Send Layer Backward', shortcut: `${MOD}[`, action: C.sendBackward },
          { label: 'Send Layer to Back', shortcut: `${MOD}${SHIFT}[`, action: C.sendToBack },
        ],
      },
      ]),
      ];
    },
  },
  {
    label: 'Effect',
    items: () => [
      { label: 'Effect Controls', shortcut: 'F3', action: () => togglePanel('effectControls') },
      { label: 'Effects & Presets', shortcut: `${MOD}5`, action: () => togglePanel('effects') },
      { separator: true },
      ...gate(!avail().layers, effectsSubmenu()),
    ],
  },
  {
    label: 'Animation',
    items: () => {
      const a = avail();
      return [
      ...gate(!a.layers, [{
        label: 'Add Keyframe',
        submenu: [
          { label: 'Anchor Point', shortcut: `${ALT}${SHIFT}A`, action: () => C.addKeyframe('transform.anchor') },
          { label: 'Position', shortcut: `${ALT}${SHIFT}P`, action: () => C.addKeyframe('transform.position') },
          { label: 'Scale', shortcut: `${ALT}${SHIFT}S`, action: () => C.addKeyframe('transform.scale') },
          { label: 'Rotation', shortcut: `${ALT}${SHIFT}R`, action: () => C.addKeyframe('transform.rotation') },
          { label: 'Opacity', shortcut: `${ALT}${SHIFT}T`, action: () => C.addKeyframe('transform.opacity') },
        ],
      }]),
      ...gate(!a.keys, [
      {
        label: 'Keyframe Interpolation',
        submenu: [
          { label: 'Linear', action: C.interpLinear },
          { label: 'Bezier', action: C.interpBezier },
          { label: 'Auto Bezier', action: C.interpAuto },
          { label: 'Toggle Hold', shortcut: `${MOD}${ALT}H`, action: C.interpHold },
        ],
      },
      { label: 'Keyframe Velocity…', shortcut: `${MOD}${SHIFT}K`, action: C.keyframeVelocity },
      {
        label: 'Keyframe Assistant',
        submenu: [
          { label: 'Easy Ease', shortcut: 'F9', action: C.easyEase },
          { label: 'Easy Ease In', shortcut: `${SHIFT}F9`, action: C.easeIn },
          { label: 'Easy Ease Out', shortcut: `${MOD}${SHIFT}F9`, action: C.easeOut },
        ],
      },
      ]),
      ...gate(!a.textLayer, [{
        label: 'Animate Text',
        submenu: (['position', 'scale', 'rotation', 'opacity', 'fillColor', 'tracking', 'blur', 'skew'] as const).map((k) => ({
          label: { position: 'Position', scale: 'Scale', rotation: 'Rotation', opacity: 'Opacity', fillColor: 'Fill Color', tracking: 'Tracking', blur: 'Blur', skew: 'Skew' }[k],
          action: () => addTextAnimator(k),
        })),
      }]),
      { separator: true },
      ...gate(!a.comp, [
      { label: 'Track Camera', action: () => startTracking('camera') },
      { label: 'Track Motion', action: () => startTracking('transform') },
      { label: 'Stabilize Motion', action: () => startTracking('stabilize') },
      { label: 'Track Perspective Corner Pin', action: () => startTracking('perspective') },
      { label: 'Roto Brush (SAM 2)', shortcut: `${ALT}W`, action: () => startTracking('roto') },
      { separator: true },
      { label: 'Reveal Properties with Keyframes', shortcut: 'U', action: C.revealKeyframes },
      { label: 'Reveal Modified Properties', shortcut: 'UU', action: C.revealModified },
      ]),
      ];
    },
  },
  {
    label: 'View',
    items: () => {
      const vs = v();
      const c = activeComp();
      const setRes = (r: Resolution) => c && setViewer(c.id, { resolution: r });
      const setView = (k: ViewKind) => {
        if (!c || !vs) return;
        const views = [...vs.views];
        views[vs.activeView] = { ...views[vs.activeView], kind: k };
        setViewer(c.id, { views });
      };
      return [
        { label: 'Zoom In', shortcut: '.', action: C.zoomIn },
        { label: 'Zoom Out', shortcut: ',', action: C.zoomOut },
        { label: 'Fit', shortcut: `${SHIFT}/`, action: C.zoomFit },
        { label: 'Actual Size (100%)', shortcut: '/', action: C.zoom100 },
        {
          label: 'Resolution',
          submenu: (['auto', 'full', 'half', 'third', 'quarter'] as Resolution[]).map((r) => ({ label: r[0].toUpperCase() + r.slice(1), checked: vs?.resolution === r, action: () => setRes(r) })),
        },
        { separator: true },
        { label: 'Show Grid', shortcut: `${MOD}'`, checked: !!vs?.grid, action: C.toggleGrid },
        { label: 'Proportional Grid', checked: !!vs?.propGrid, action: C.togglePropGrid },
        { label: 'Title/Action Safe', shortcut: "'", checked: !!vs?.safe, action: C.toggleSafe },
        { label: 'Transparency Grid', checked: !!vs?.transparency, action: C.toggleTransparency },
        { label: 'Show Layer Controls', shortcut: `${MOD}${SHIFT}H`, checked: vs?.layerControls !== false, action: C.toggleLayerControls },
        { separator: true },
        {
          label: '3D View',
          submenu: (['active', 'front', 'left', 'top', 'back', 'right', 'bottom', 'custom'] as ViewKind[]).map((k) => ({
            label: k === 'active' ? 'Active Camera' : k === 'custom' ? 'Custom View' : k[0].toUpperCase() + k.slice(1),
            checked: vs?.views[vs.activeView]?.kind === k,
            action: () => setView(k),
          })),
        },
        {
          label: 'View Layout',
          submenu: (['1', '2', '4'] as const).map((n) => ({ label: `${n} View${n === '1' ? '' : 's'}`, checked: vs?.layout === n, action: () => c && setViewer(c.id, { layout: n }) })),
        },
        { separator: true },
        {
          label: 'Tools',
          submenu: [
            { label: 'Selection', shortcut: 'V', action: () => setTool('select') },
            { label: 'Hand', shortcut: 'H', action: () => setTool('hand') },
            { label: 'Zoom', shortcut: 'Z', action: () => setTool('zoom') },
            { label: 'Rotation', shortcut: 'W', action: () => setTool('rotate') },
            { label: 'Camera', shortcut: 'C', action: () => setTool('camera') },
            { label: 'Pan Behind', shortcut: 'Y', action: () => setTool('panBehind') },
            { label: 'Shape', shortcut: 'Q', action: () => setTool('shape') },
            { label: 'Pen', shortcut: 'G', action: () => setTool('pen') },
            { label: 'Type', shortcut: `${MOD}T`, action: () => setTool('text') },
          ],
        },
      ];
    },
  },
  {
    label: 'Window',
    items: () => {
      const s = getApp();
      return [
        ...Object.keys(WORKSPACES).map((w) => ({ label: `Workspace: ${w}`, checked: s.workspace === w, action: () => setWorkspace(w) })),
        { separator: true },
        ...(Object.keys(PANELS) as PanelId[]).map((p) => ({ label: PANELS[p].title, checked: hasPanel(s.layout, p), action: () => togglePanel(p) })),
      ];
    },
  },
  {
    label: 'Help',
    items: () => [
      { label: 'Keyboard Shortcuts', shortcut: 'F1', action: C.shortcuts },
      { label: 'About pooEffects', action: C.about },
    ],
  },
];
