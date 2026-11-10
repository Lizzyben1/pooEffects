// Context menus for layers and keyframes.

import type { MenuItem, SelTarget } from '../../state/uiTypes';
import { commands as C, MOD, SHIFT, ALT, deleteTarget, newLayer, startTracking } from '../commands';
import { getApp, openDialog, setApp, setTimeline } from '../../state/store';
import type { AnimProp, BlendMode, Layer, PropDescriptor } from '../../core/types';
import * as A from '../../state/actions';
import { effectsSubmenu } from './menus';
import { LABEL_COLORS } from '../../math/color';
import { openComp } from '../../state/actions';

export const BLEND_LABELS: Record<BlendMode, string> = {
  normal: 'Normal', dissolve: 'Dissolve', darken: 'Darken', multiply: 'Multiply', colorBurn: 'Color Burn', linearBurn: 'Linear Burn',
  darkerColor: 'Darker Color', lighten: 'Lighten', screen: 'Screen', colorDodge: 'Color Dodge', add: 'Add', lighterColor: 'Lighter Color',
  overlay: 'Overlay', softLight: 'Soft Light', hardLight: 'Hard Light', linearLight: 'Linear Light', vividLight: 'Vivid Light',
  pinLight: 'Pin Light', hardMix: 'Hard Mix', difference: 'Difference', exclusion: 'Exclusion', subtract: 'Subtract', divide: 'Divide',
  hue: 'Hue', saturation: 'Saturation', color: 'Color', luminosity: 'Luminosity', stencilAlpha: 'Stencil Alpha', stencilLuma: 'Stencil Luma',
  silhouetteAlpha: 'Silhouette Alpha', silhouetteLuma: 'Silhouette Luma', alphaAdd: 'Alpha Add', luminescentPremul: 'Luminescent Premul',
};

export const BLEND_GROUPS: BlendMode[][] = [
  ['normal', 'dissolve'],
  ['darken', 'multiply', 'colorBurn', 'linearBurn', 'darkerColor'],
  ['lighten', 'screen', 'colorDodge', 'add', 'lighterColor'],
  ['overlay', 'softLight', 'hardLight', 'linearLight', 'vividLight', 'pinLight', 'hardMix'],
  ['difference', 'exclusion', 'subtract', 'divide'],
  ['hue', 'saturation', 'color', 'luminosity'],
  ['stencilAlpha', 'stencilLuma', 'silhouetteAlpha', 'silhouetteLuma', 'alphaAdd', 'luminescentPremul'],
];

/** Right-click on empty timeline / viewer space: things you can do to the composition. */
export function compContextMenu(): MenuItem[] {
  const clip = A.clipboardKind();
  return [
    { label: 'New', submenu: [
      { label: 'Text', shortcut: `${MOD}${ALT}${SHIFT}T`, action: C.newText },
      { label: 'Solid…', shortcut: `${MOD}Y`, action: C.newSolid },
      { label: 'Shape Layer', action: C.newShape },
      { label: 'Null Object', shortcut: `${MOD}${ALT}${SHIFT}Y`, action: C.newNull },
      { label: 'Adjustment Layer', shortcut: `${MOD}${ALT}Y`, action: C.newAdjustment },
      { label: 'Camera', shortcut: `${MOD}${ALT}${SHIFT}C`, action: C.newCamera },
      { label: 'Light', submenu: (['point', 'spot', 'parallel', 'ambient'] as const).map((k) => ({ label: `${k[0].toUpperCase()}${k.slice(1)} Light`, action: () => newLayer(k) })) },
    ] },
    { label: 'Composition Settings…', shortcut: `${MOD}K`, action: C.compSettings },
    { label: 'Add Marker', shortcut: `${SHIFT}8`, action: C.addMarker },
    { separator: true },
    { label: clip === 'keyframes' ? 'Paste Keyframes' : 'Paste', shortcut: `${MOD}V`, disabled: !clip, action: C.paste },
    { label: 'Select All', shortcut: `${MOD}A`, action: C.selectAll },
    { separator: true },
    { label: 'Add to Render Queue', shortcut: `${MOD}M`, action: C.addToRenderQueue },
    { label: 'Save Frame As PNG', shortcut: `${MOD}${ALT}S`, action: C.saveFrame },
  ];
}

/** Right-click on a property row. */
export function propContextMenu(compId: string, layer: Layer, path: string, prop: AnimProp, desc: PropDescriptor): MenuItem[] {
  const animatable = desc.animatable !== false;
  const numeric = desc.kind !== 'text' && desc.kind !== 'bool' && desc.kind !== 'enum' && desc.kind !== 'layer' && desc.kind !== 'curves';
  const hasKeys = prop.keyframes.length > 0;
  const keysOf = () => prop.keyframes.map((k) => `${layer.id}|${path}|${k.id}`);
  return [
    { label: hasKeys ? 'Add / Remove Keyframe Here' : 'Add Keyframe (Start Animating)', disabled: !animatable, action: () => A.toggleKeyframeAtCTI(compId, layer.id, path) },
    { label: 'Remove All Keyframes', disabled: !hasKeys, action: () => A.toggleStopwatch(compId, layer.id, path) },
    { label: 'Select All Keyframes', disabled: !hasKeys, action: () => setApp({ selKeys: keysOf(), selLayers: [layer.id] }) },
    { separator: true },
    {
      label: prop.expression !== undefined ? 'Remove Expression' : 'Add Expression',
      disabled: !animatable,
      action: () => {
        A.setExpression(compId, layer.id, path, prop.expression !== undefined ? null : 'value');
        setApp((s) => ({ expanded: { ...s.expanded, [`${layer.id}|expr|${path}`]: true } }));
      },
    },
    {
      label: 'Show in Graph Editor',
      disabled: !hasKeys || !numeric,
      action: () => {
        setApp({ selProps: [`${layer.id}|${path}`], selLayers: [layer.id] });
        setTimeline(compId, { graphEditor: true });
      },
    },
  ];
}

/** Right-click on an effect / mask / shape item / animator row. */
export function targetContextMenu(compId: string, target: SelTarget, name: string, rename: (v: string) => void): MenuItem[] {
  const items: MenuItem[] = [{ label: 'Rename…', action: () => openDialog({ kind: 'rename', title: 'Rename', value: name, onSubmit: rename }) }];
  if (target.kind === 'effect') {
    items.push(
      { label: 'Duplicate', shortcut: `${MOD}D`, action: () => A.duplicateEffect(compId, target.layerId, target.id) },
      { label: 'Reset', action: () => A.resetEffect(compId, target.layerId, target.id) },
    );
  }
  items.push({ separator: true }, { label: 'Delete', shortcut: 'Del', danger: true, action: () => deleteTarget(compId, target) });
  return items;
}

export function layerContextMenu(compId: string, ids: string[]): MenuItem[] {
  const comp = getApp().project.comps[compId];
  const first = comp?.layers.find((l) => l.id === ids[0]);
  if (!comp || !first) return compContextMenu();
  const blendItems: MenuItem[] = [];
  BLEND_GROUPS.forEach((g, gi) => {
    if (gi) blendItems.push({ separator: true });
    for (const m of g) blendItems.push({ label: BLEND_LABELS[m], checked: first.blendMode === m, action: () => A.setLayerFields(compId, ids, { blendMode: m }) });
  });
  const items: MenuItem[] = [];
  if (first.type === 'precomp' && first.source?.compId) items.push({ label: 'Open Pre-comp', action: () => openComp(first.source!.compId!) }, { separator: true });
  items.push(
    { label: 'Effect', submenu: effectsSubmenu() },
    { label: 'Mask', submenu: [{ label: 'New Mask', shortcut: `${MOD}${SHIFT}N`, action: C.newMask }] },
    { label: 'Blending Mode', submenu: blendItems },
    {
      label: 'Track Matte',
      submenu: [
        { label: 'No Track Matte', checked: !first.trackMatte, action: () => A.setTrackMatte(compId, first.id, null) },
        { separator: true },
        ...comp.layers.filter((l) => l.id !== first.id).slice(0, 30).map((l) => ({
          label: `${comp.layers.indexOf(l) + 1}. ${l.name}`,
          checked: first.trackMatte?.layerId === l.id,
          submenu: (['alpha', 'alphaInverted', 'luma', 'lumaInverted'] as const).map((m) => ({
            label: { alpha: 'Alpha Matte', alphaInverted: 'Alpha Inverted Matte', luma: 'Luma Matte', lumaInverted: 'Luma Inverted Matte' }[m],
            checked: first.trackMatte?.layerId === l.id && first.trackMatte.mode === m,
            action: () => A.setTrackMatte(compId, first.id, l.id, m),
          })),
        })),
      ],
    },
    {
      label: 'Switches',
      submenu: [
        { label: 'Video (Eye)', checked: first.enabled, action: C.toggleVisible },
        { label: '3D Layer', checked: first.threeD, action: C.toggle3D },
        { label: 'Motion Blur', checked: first.motionBlur, action: C.toggleMotionBlur },
        { label: 'Adjustment Layer', checked: first.adjustment, action: () => A.toggleLayerSwitch(compId, ids, 'adjustment') },
        { label: 'Guide Layer', checked: first.guide, action: () => A.toggleLayerSwitch(compId, ids, 'guide') },
        { label: 'Solo', checked: first.solo, action: C.toggleSolo },
        { label: 'Lock', checked: first.locked, action: C.toggleLock },
        { label: 'Shy', checked: first.shy, action: C.toggleShy },
        { label: 'Collapse / Continuously Rasterize', checked: first.collapse, action: () => A.toggleLayerSwitch(compId, ids, 'collapse') },
        { label: 'Auto-Orient Along Path', checked: first.autoOrient === 'path', action: () => A.setLayerFields(compId, ids, { autoOrient: first.autoOrient === 'path' ? 'off' : 'path' }) },
        { label: 'Auto-Orient Towards Camera', checked: first.autoOrient === 'camera', action: () => A.setLayerFields(compId, ids, { autoOrient: first.autoOrient === 'camera' ? 'off' : 'camera' }) },
      ],
    },
    {
      label: 'Label',
      submenu: LABEL_COLORS.map((c, i) => ({ label: c.name, checked: first.label === i, action: () => A.setLayerFields(compId, ids, { label: i }) })),
    },
    { separator: true },
    {
      label: 'Transform',
      submenu: [
        { label: 'Reset', action: C.resetTransform },
        { label: 'Center Anchor Point', shortcut: `${MOD}${ALT}Home`, action: C.centerAnchor },
        { label: 'Fit to Comp', shortcut: `${MOD}${ALT}F`, action: C.fitToComp },
      ],
    },
    {
      label: 'Time',
      submenu: [
        { label: first.timeRemapEnabled ? 'Disable Time Remapping' : 'Enable Time Remapping', action: C.timeRemap },
        { label: 'Time-Reverse Layer', action: C.timeReverse },
        { label: 'Time Stretch…', action: C.timeStretch },
        { label: 'Freeze Frame', action: C.freezeFrame },
      ],
    },
    ...(first.type === 'video' || first.type === 'image' || first.type === 'precomp'
      ? [{
        label: 'Tracking',
        submenu: [
          { label: 'Track Camera', action: () => startTracking('camera') },
          { label: 'Track Motion', action: () => startTracking('transform') },
          { label: 'Stabilize Motion', action: () => startTracking('stabilize') },
          { label: 'Track Perspective Corner Pin', action: () => startTracking('perspective') },
          { label: 'Roto Brush (SAM 2)', shortcut: `${ALT}W`, action: () => startTracking('roto') },
        ],
      }]
      : []),
    { label: 'Pre-compose…', shortcut: `${MOD}${SHIFT}C`, action: C.precompose },
    { separator: true },
    { label: 'Rename', action: () => openDialog({ kind: 'rename', title: 'Rename Layer', value: first.name, onSubmit: (v) => A.setLayerFields(compId, [first.id], { name: v }) }) },
    { label: 'Duplicate', shortcut: `${MOD}D`, action: C.duplicate },
    { label: 'Split Layer', shortcut: `${MOD}${SHIFT}D`, action: C.split },
    { separator: true },
    { label: 'Cut', shortcut: `${MOD}X`, action: C.cut },
    { label: 'Copy', shortcut: `${MOD}C`, action: C.copy },
    { label: 'Paste', shortcut: `${MOD}V`, disabled: !A.clipboardKind(), action: C.paste },
    { label: 'Delete', shortcut: 'Del', danger: true, action: () => A.deleteLayers(compId, ids) },
  );
  return items;
}

export function keyframeContextMenu(): MenuItem[] {
  const keys = getApp().selKeys;
  return [
    {
      label: 'Keyframe Interpolation',
      submenu: [
        { label: 'Linear', action: C.interpLinear },
        { label: 'Bezier', action: C.interpBezier },
        { label: 'Auto Bezier', action: C.interpAuto },
        { label: 'Hold', action: C.interpHold },
      ],
    },
    {
      label: 'Spatial Interpolation',
      submenu: (['linear', 'bezier', 'continuous', 'auto'] as const).map((sp) => ({
        label: { linear: 'Linear', bezier: 'Bezier', continuous: 'Continuous Bezier', auto: 'Auto Bezier' }[sp],
        action: () => A.setKeyframeInterpolation(keys, null, sp),
      })),
    },
    { label: 'Keyframe Velocity…', action: C.keyframeVelocity },
    { label: 'Rove Across Time', action: () => A.toggleRoving(keys) },
    { separator: true },
    { label: 'Easy Ease', shortcut: 'F9', action: C.easyEase },
    { label: 'Easy Ease In', shortcut: `${SHIFT}F9`, action: C.easeIn },
    { label: 'Easy Ease Out', shortcut: `${MOD}${SHIFT}F9`, action: C.easeOut },
    { separator: true },
    { label: 'Copy', shortcut: `${MOD}C`, action: C.copy },
    { label: 'Delete', shortcut: 'Del', danger: true, action: () => A.deleteKeyframes(keys) },
    { label: 'Deselect', action: () => setApp({ selKeys: [] }) },
  ];
}
