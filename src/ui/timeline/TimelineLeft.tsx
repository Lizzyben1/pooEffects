// Left side of the timeline: layer rows (A/V switches, label, name, switches/modes, parent) and
// property tree rows (twirl-downs, stopwatches, value editors, keyframe navigators, expressions).

import { memo, useState } from 'react';
import { ChevronRight, ChevronLeft, Eye, EyeOff, Volume2, Lock, RotateCcw, Trash, Equal, ChevronDown } from 'lucide-react';
import type { Composition, Layer, PropValue, TextAnimatorPropKey, ShapeItemType } from '../../core/types';
import type { FrameEval } from '../../core/evaluate';
import { getApp, setApp, useApp, openContextMenu, propKey, openDialog } from '../../state/store';
import * as A from '../../state/actions';
import { getAt } from '../../core/props';
import type { Row } from './rows';
import { PropEditor } from '../controls/PropEditor';
import {
  AdjustmentIcon, CollapseIcon, CubeIcon, FxIcon, LayerTypeIcon, MotionBlurIcon, PickWhipIcon, QualityIcon, ShyIcon, SoloIcon, StopwatchIcon,
} from '../icons';
import { LABEL_COLORS, rgbaToCss } from '../../math/color';
import { BLEND_LABELS, layerContextMenu } from '../menus/layerMenu';
import { BLEND_MODES } from '../../core/types';
import { toLayerTime } from '../../core/evaluate';
import { createShapeItem } from '../../core/factory';
import { SHAPE_TYPE_NAMES, TEXT_ANIM_DESCS, TEXT_ANIM_ORDER } from '../../core/props';
import { getTime } from '../../state/time';
import { deleteTracker, setTracking, trackerKindName, useTracking } from '../../state/tracking';

export const INDENT = 14;

function Twirl({ open, onClick }: { open: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <span className={`twirl${open ? ' open' : ''}`} onPointerDown={(e) => e.stopPropagation()} onClick={onClick}>
      <ChevronRight size={12} />
    </span>
  );
}

function SwitchBtn({ on, onClick, title, children, dim }: { on: boolean; onClick: (e: React.MouseEvent) => void; title: string; children: React.ReactNode; dim?: boolean }) {
  return (
    <span className={`sw${on ? ' on' : ''}${dim ? ' dim' : ''}`} title={title} onPointerDown={(e) => e.stopPropagation()} onClick={onClick}>
      {children}
    </span>
  );
}

export interface LeftProps {
  row: Row;
  comp: Composition;
  fe: FrameEval;
  showModes: boolean;
  selected: boolean;
  onLayerPointerDown: (e: React.PointerEvent, layer: Layer) => void;
  onPickWhip: (e: React.PointerEvent, layer: Layer) => void;
  dropTarget: boolean;
}

function toggleKey(key: string, e: React.MouseEvent) {
  const s = getApp();
  const open = !s.expanded[key];
  if (e.altKey || e.ctrlKey || e.metaKey) {
    // recursive open/close of everything under this key
    const ex = { ...s.expanded };
    for (const k of Object.keys(ex)) if (k.startsWith(key)) ex[k] = open;
    ex[key] = open;
    setApp({ expanded: ex });
  } else A.toggleExpanded(key, open);
}

export const LayerLeft = memo(function LayerLeft({ row, comp, showModes, selected, onLayerPointerDown, onPickWhip, dropTarget }: LeftProps) {
  const layer = (row as Extract<Row, { kind: 'layer' }>).layer;
  const index = (row as Extract<Row, { kind: 'layer' }>).index;
  const expanded = useApp((s) => !!s.expanded[layer.id]);
  const [renaming, setRenaming] = useState(false);
  const ids = () => (getApp().selLayers.includes(layer.id) ? getApp().selLayers : [layer.id]);
  const sw = (key: keyof Layer) => (e: React.MouseEvent) => {
    e.stopPropagation();
    A.toggleLayerSwitch(comp.id, ids(), key);
  };
  const isAV = layer.type === 'video' || layer.type === 'audio' || layer.type === 'precomp';
  const hasVideo = layer.type !== 'audio';
  const label = LABEL_COLORS[layer.label]?.hex ?? '#555';
  return (
    <div
      className={`tl-left layer${selected ? ' selected' : ''}${dropTarget ? ' drop-target' : ''}`}
      onPointerDown={(e) => onLayerPointerDown(e, layer)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!getApp().selLayers.includes(layer.id)) A.selectLayers([layer.id]);
        openContextMenu(e.clientX, e.clientY, layerContextMenu(comp.id, getApp().selLayers));
      }}
    >
      <div className="av">
        {hasVideo ? (
          <SwitchBtn on={layer.enabled} onClick={sw('enabled')} title="Video (eye)">{layer.enabled ? <Eye size={13} /> : <EyeOff size={13} />}</SwitchBtn>
        ) : <span className="sw" />}
        {isAV ? <SwitchBtn on={layer.audioEnabled} onClick={sw('audioEnabled')} title="Audio" dim><Volume2 size={13} /></SwitchBtn> : <span className="sw" />}
        <SwitchBtn on={layer.solo} onClick={sw('solo')} title="Solo" dim><SoloIcon size={12} /></SwitchBtn>
        <SwitchBtn on={layer.locked} onClick={sw('locked')} title="Lock" dim><Lock size={12} /></SwitchBtn>
      </div>
      <span
        className="label-chip"
        style={{ background: label }}
        title={LABEL_COLORS[layer.label]?.name}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => openContextMenu(e.clientX, e.clientY, LABEL_COLORS.map((c, i) => ({ label: c.name, checked: layer.label === i, action: () => A.setLayerFields(comp.id, ids(), { label: i }) })))}
      />
      <span className="idx mono">{index + 1}</span>
      <Twirl open={expanded} onClick={(e) => toggleKey(layer.id, e)} />
      <span className="ltype"><LayerTypeIcon type={layer.adjustment ? 'adjustment' : layer.type} /></span>
      {renaming ? (
        <input
          className="rename"
          autoFocus
          defaultValue={layer.name}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              A.setLayerFields(comp.id, [layer.id], { name: (e.target as HTMLInputElement).value || layer.name });
              setRenaming(false);
            }
            if (e.key === 'Escape') setRenaming(false);
          }}
          onBlur={(e) => {
            A.setLayerFields(comp.id, [layer.id], { name: e.target.value || layer.name });
            setRenaming(false);
          }}
        />
      ) : (
        <span className={`lname${layer.guide ? ' guide' : ''}`} onDoubleClick={() => setRenaming(true)} title={layer.name}>
          {layer.name}
        </span>
      )}
      {!showModes ? (
        <div className="switches">
          <SwitchBtn on={layer.shy} onClick={sw('shy')} title="Shy" dim><ShyIcon size={13} /></SwitchBtn>
          <SwitchBtn on={layer.collapse} onClick={sw('collapse')} title="Collapse Transformations / Continuously Rasterize" dim><CollapseIcon size={13} /></SwitchBtn>
          <SwitchBtn on={true} onClick={(e) => { e.stopPropagation(); A.setLayerFields(comp.id, ids(), { quality: layer.quality === 'best' ? 'draft' : 'best' }); }} title={`Quality: ${layer.quality}`}><QualityIcon size={13} best={layer.quality === 'best'} /></SwitchBtn>
          <SwitchBtn on={layer.effectsEnabled && layer.effects.length > 0} onClick={sw('effectsEnabled')} title="Effects" dim={!layer.effects.length || !layer.effectsEnabled}><FxIcon size={13} /></SwitchBtn>
          <SwitchBtn on={layer.motionBlur} onClick={sw('motionBlur')} title="Motion Blur" dim><MotionBlurIcon size={13} /></SwitchBtn>
          <SwitchBtn on={layer.adjustment} onClick={sw('adjustment')} title="Adjustment Layer" dim><AdjustmentIcon size={12} /></SwitchBtn>
          <SwitchBtn on={layer.threeD} onClick={sw('threeD')} title="3D Layer" dim><CubeIcon size={13} /></SwitchBtn>
        </div>
      ) : (
        <div className="modes">
          <select className="mini-select" value={layer.blendMode} title="Blending Mode" onPointerDown={(e) => e.stopPropagation()} onChange={(e) => A.setLayerFields(comp.id, ids(), { blendMode: e.target.value as Layer['blendMode'] })}>
            {BLEND_MODES.map((m) => <option key={m} value={m}>{BLEND_LABELS[m]}</option>)}
          </select>
          <span className={`sw tiny${layer.preserveTransparency ? ' on' : ''}`} title="Preserve Underlying Transparency" onPointerDown={(e) => e.stopPropagation()} onClick={sw('preserveTransparency')}>T</span>
          <select
            className="mini-select"
            title="Track Matte"
            value={layer.trackMatte ? `${layer.trackMatte.layerId}|${layer.trackMatte.mode}` : ''}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) A.setTrackMatte(comp.id, layer.id, null);
              else {
                const [lid, mode] = v.split('|');
                A.setTrackMatte(comp.id, layer.id, lid, mode as 'alpha');
              }
            }}
          >
            <option value="">No Matte</option>
            {comp.layers.filter((l) => l.id !== layer.id && l.type !== 'camera' && l.type !== 'light' && l.type !== 'audio').map((l) => (
              (['alpha', 'alphaInverted', 'luma', 'lumaInverted'] as const).map((m) => (
                <option key={`${l.id}|${m}`} value={`${l.id}|${m}`}>{comp.layers.indexOf(l) + 1}. {l.name.slice(0, 14)} — {{ alpha: 'Alpha', alphaInverted: 'Alpha Inv', luma: 'Luma', lumaInverted: 'Luma Inv' }[m]}</option>
              ))
            ))}
          </select>
        </div>
      )}
      <div className="parent">
        <span className="pickwhip" title="Pick whip: drag onto a layer to parent" onPointerDown={(e) => { e.stopPropagation(); onPickWhip(e, layer); }}>
          <PickWhipIcon size={13} />
        </span>
        <select
          className="mini-select"
          value={layer.parentId ?? ''}
          title="Parent & Link"
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => A.setParent(comp.id, layer.id, e.target.value || null)}
        >
          <option value="">None</option>
          {comp.layers.filter((l) => l.id !== layer.id).map((l) => <option key={l.id} value={l.id}>{comp.layers.indexOf(l) + 1}. {l.name}</option>)}
        </select>
      </div>
    </div>
  );
});

function KeyNav({ comp, layer, path }: { comp: Composition; layer: Layer; path: string }) {
  const p = getAt(layer, path) as import('../../core/types').AnimProp | undefined;
  if (!p || !p.keyframes.length) return <span className="kfnav" />;
  const t = getTime(comp.id);
  const lt = toLayerTime(layer, t);
  const fd = 0.5 / comp.frameRate;
  const at = p.keyframes.some((k) => Math.abs(k.t - lt) < fd);
  const prev = [...p.keyframes].reverse().find((k) => k.t < lt - fd);
  const next = p.keyframes.find((k) => k.t > lt + fd);
  const go = (k: typeof prev) => k && A.goToTime(comp.id, layer.startTime + k.t * (layer.stretch / 100));
  return (
    <span className="kfnav" onPointerDown={(e) => e.stopPropagation()}>
      <button className={`kfnav-btn${prev ? '' : ' off'}`} onClick={() => go(prev)} title="Previous keyframe (J)"><ChevronLeft size={11} /></button>
      <button className={`kfnav-diamond${at ? ' on' : ''}`} onClick={() => A.toggleKeyframeAtCTI(comp.id, layer.id, path)} title="Add/remove keyframe at current time" />
      <button className={`kfnav-btn${next ? '' : ' off'}`} onClick={() => go(next)} title="Next keyframe (K)"><ChevronRight size={11} /></button>
    </span>
  );
}

export const PropLeft = memo(function PropLeft({ row, comp, fe }: { row: Extract<Row, { kind: 'prop' }>; comp: Composition; fe: FrameEval; t: number }) {
  const { layer, path, prop, desc, depth } = row;
  const value = fe.prop(layer, path, prop, desc.spatial) as PropValue;
  const err = useApp((s) => s.exprErrors[`${layer.id}|${path}`]);
  const selected = useApp((s) => s.selProps.includes(propKey(layer.id, path)));
  const animatable = desc.animatable !== false;
  return (
    <div
      className={`tl-left prop${selected ? ' selected' : ''}`}
      style={{ paddingLeft: 6 + depth * INDENT }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const k = propKey(layer.id, path);
        setApp((s) => ({ selProps: e.shiftKey ? (s.selProps.includes(k) ? s.selProps.filter((x) => x !== k) : [...s.selProps, k]) : [k], selLayers: s.selLayers.includes(layer.id) ? s.selLayers : [layer.id] }));
      }}
    >
      <span className="twirl-spacer" />
      {animatable ? (
        <span
          className={`stopwatch${prop.keyframes.length ? ' on' : ''}`}
          title="Time-Vary Stopwatch (Alt+click: expression)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            if (e.altKey) A.setExpression(comp.id, layer.id, path, prop.expression !== undefined ? null : desc.kind === 'number' || desc.kind === 'angle' ? 'value' : 'value');
            else A.toggleStopwatch(comp.id, layer.id, path);
          }}
        >
          <StopwatchIcon size={13} on={prop.keyframes.length > 0} />
        </span>
      ) : <span className="stopwatch" />}
      {prop.expression !== undefined && (
        <span
          className={`expr-toggle${prop.expressionEnabled === false ? ' off' : ''}${err ? ' err' : ''}`}
          title={err ? `Expression error: ${err}` : 'Enable expression'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => A.toggleExpressionEnabled(comp.id, layer.id, path)}
        >
          <Equal size={11} />
        </span>
      )}
      <span className="pname" title={path}>{row.label}</span>
      <span className="pval" onPointerDown={(e) => e.stopPropagation()}>
        <PropEditor comp={comp} layer={layer} path={path} prop={prop} desc={desc} value={value} time={fe.time} />
      </span>
      {animatable && <KeyNav comp={comp} layer={layer} path={path} />}
    </div>
  );
});

export function ExprLeft({ row, comp }: { row: Extract<Row, { kind: 'expr' }>; comp: Composition }) {
  const err = useApp((s) => s.exprErrors[`${row.layer.id}|${row.path}`]);
  return (
    <div className="tl-left expr" style={{ paddingLeft: 30 + row.depth * INDENT }}>
      <div className="expr-box">
        <div className="expr-head">
          <span>Expression</span>
          {err ? <span className="expr-err" title={err}>⚠ {err}</span> : <span className="expr-ok">✓</span>}
          <button className="icon-btn sm" title="Remove expression" onClick={() => A.setExpression(comp.id, row.layer.id, row.path, null)}><Trash size={11} /></button>
        </div>
        <textarea
          className="expr-input mono"
          spellCheck={false}
          defaultValue={row.prop.expression ?? ''}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
              e.preventDefault();
              A.setExpression(comp.id, row.layer.id, row.path, (e.target as HTMLTextAreaElement).value);
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
          onBlur={(e) => {
            if (e.target.value !== row.prop.expression) A.setExpression(comp.id, row.layer.id, row.path, e.target.value);
          }}
          placeholder="wiggle(2, 30)"
        />
      </div>
    </div>
  );
}

export function FieldLeft({ row, comp }: { row: Extract<Row, { kind: 'field' }>; comp: Composition }) {
  const c = row.control;
  const value = getAt(row.layer, c.path);
  return (
    <div className="tl-left prop" style={{ paddingLeft: 6 + row.depth * INDENT }}>
      <span className="twirl-spacer" />
      <span className="stopwatch" />
      <span className="pname">{row.label}</span>
      <span className="pval" onPointerDown={(e) => e.stopPropagation()}>
        {c.type === 'select' && (
          <select className="mini-select" value={String(value)} onChange={(e) => A.setLayerPath(comp.id, row.layer.id, c.path, e.target.value)}>
            {c.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        )}
        {c.type === 'check' && (
          <span className={`check${value ? ' on' : ''}`} onClick={() => A.setLayerPath(comp.id, row.layer.id, c.path, !value)}>
            {value ? <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5.2l2 2 4-4.4" stroke="currentColor" strokeWidth="1.8" fill="none" /></svg> : null}
          </span>
        )}
        {c.type === 'number' && (
          <input
            className="mini-num mono"
            type="number"
            defaultValue={Number(value)}
            step={c.step}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => A.setLayerPath(comp.id, row.layer.id, c.path, Number(e.target.value))}
          />
        )}
      </span>
    </div>
  );
}

const SHAPE_ADD: ShapeItemType[] = ['rect', 'ellipse', 'polystar', 'path', 'fill', 'stroke', 'gfill', 'gstroke', 'merge', 'offset', 'puckerBloat', 'repeater', 'roundCorners', 'trim', 'twist', 'wiggle', 'zigzag', 'group'];

export const GroupLeft = memo(function GroupLeft({ row, comp }: { row: Extract<Row, { kind: 'group' }>; comp: Composition }) {
  const open = useApp((s) => !!s.expanded[row.key] || s.reveal.kind !== 'none');
  const selEffect = useApp((s) => s.selEffect);
  const selShape = useApp((s) => s.selShapeItem);
  const activeTrackerId = useTracking((s) => s.active?.trackerId ?? null);
  const layer = row.layer;
  let extra: React.ReactNode = null;
  let selected = false;
  switch (row.group) {
    case 'tracker': {
      const t = layer.trackers?.find((x) => x.id === row.ref);
      selected = activeTrackerId === row.ref;
      if (t) {
        extra = (
          <span className="gx" onPointerDown={(e) => e.stopPropagation()}>
            <span className="trk-kind">{trackerKindName(t.kind)}</span>
            <button className="icon-btn sm" title="Delete tracker" onClick={() => deleteTracker(comp.id, layer.id, t.id)}><Trash size={11} /></button>
          </span>
        );
      }
      break;
    }
    case 'mask': {
      const m = layer.masks.find((x) => x.id === row.ref);
      if (m) {
        extra = (
          <span className="gx" onPointerDown={(e) => e.stopPropagation()}>
            <span className="mask-chip" style={{ background: rgbaToCss(m.color) }} />
            <select className="mini-select" value={m.mode} onChange={(e) => A.setMaskFields(comp.id, layer.id, m.id, { mode: e.target.value as typeof m.mode })}>
              {A.MASK_MODES.map((md) => <option key={md} value={md}>{md[0].toUpperCase() + md.slice(1)}</option>)}
            </select>
            <label className="inv"><span className={`check${m.inverted ? ' on' : ''}`} onClick={() => A.setMaskFields(comp.id, layer.id, m.id, { inverted: !m.inverted })}>{m.inverted ? '✓' : ''}</span>Inverted</label>
            <button className="icon-btn sm" title="Delete mask" onClick={() => A.removeMask(comp.id, layer.id, m.id)}><Trash size={11} /></button>
          </span>
        );
      }
      break;
    }
    case 'effect': {
      const fx = layer.effects.find((x) => x.id === row.ref);
      selected = selEffect === row.ref;
      if (fx) {
        extra = (
          <span className="gx" onPointerDown={(e) => e.stopPropagation()}>
            <span className={`sw${fx.enabled ? ' on' : ''}`} title="Effect on/off" onClick={() => A.setEffectField(comp.id, layer.id, fx.id, { enabled: !fx.enabled })}><FxIcon size={12} /></span>
            <button className="link-btn" onClick={() => A.resetEffect(comp.id, layer.id, fx.id)}><RotateCcw size={10} /> Reset</button>
            <button className="icon-btn sm" title="Delete effect" onClick={() => A.removeEffect(comp.id, layer.id, fx.id)}><Trash size={11} /></button>
          </span>
        );
      }
      break;
    }
    case 'contents':
      extra = (
        <span className="gx" onPointerDown={(e) => e.stopPropagation()}>
          <button
            className="link-btn"
            onClick={(e) =>
              openContextMenu(e.clientX, e.clientY, SHAPE_ADD.map((t) => ({
                label: SHAPE_TYPE_NAMES[t],
                action: () => A.addShapeItem(comp.id, layer.id, createShapeItem(t), row.path === 'shape.contents' ? null : row.path!.replace(/\.contents$/, ''), ['fill', 'stroke', 'gfill', 'gstroke', 'trim', 'repeater', 'merge', 'zigzag', 'roundCorners', 'offset', 'puckerBloat', 'twist', 'wiggle'].includes(t)),
              })))
            }
          >
            Add <ChevronDown size={10} />
          </button>
        </span>
      );
      break;
    case 'shapeGroup':
    case 'shapeItem': {
      const item = row.path ? (getAt(layer, row.path) as { enabled: boolean; id: string } | undefined) : undefined;
      selected = selShape === row.ref;
      if (item) {
        extra = (
          <span className="gx" onPointerDown={(e) => e.stopPropagation()}>
            <span className={`sw${item.enabled ? ' on' : ''}`} title="Show/hide" onClick={() => A.setLayerPath(comp.id, layer.id, `${row.path}.enabled`, !item.enabled)}>
              {item.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
            </span>
            <button className="icon-btn sm" title="Move up" onClick={() => A.moveShapeItem(comp.id, layer.id, row.path!, -1)}>↑</button>
            <button className="icon-btn sm" title="Move down" onClick={() => A.moveShapeItem(comp.id, layer.id, row.path!, 1)}>↓</button>
            <button className="icon-btn sm" title="Delete" onClick={() => A.removeShapeItem(comp.id, layer.id, row.path!)}><Trash size={11} /></button>
          </span>
        );
      }
      break;
    }
    case 'text':
      extra = (
        <span className="gx" onPointerDown={(e) => e.stopPropagation()}>
          <button
            className="link-btn"
            onClick={(e) => openContextMenu(e.clientX, e.clientY, TEXT_ANIM_ORDER.map((k) => ({ label: TEXT_ANIM_DESCS[k].name, action: () => A.addTextAnimator(comp.id, layer.id, [k]) })))}
          >
            Animate <ChevronDown size={10} />
          </button>
        </span>
      );
      break;
    case 'animator': {
      const a = layer.text?.animators.find((x) => x.id === row.ref);
      if (a) {
        extra = (
          <span className="gx" onPointerDown={(e) => e.stopPropagation()}>
            <button
              className="link-btn"
              onClick={(e) =>
                openContextMenu(e.clientX, e.clientY, [
                  { label: 'Property', submenu: TEXT_ANIM_ORDER.filter((k) => !a.props[k]).map((k: TextAnimatorPropKey) => ({ label: TEXT_ANIM_DESCS[k].name, action: () => A.addAnimatorProperty(comp.id, layer.id, a.id, k) })) },
                  { label: 'Selector', submenu: [{ label: 'Range', action: () => A.addSelector(comp.id, layer.id, a.id, 'range') }, { label: 'Wiggly', action: () => A.addSelector(comp.id, layer.id, a.id, 'wiggly') }] },
                ])
              }
            >
              Add <ChevronDown size={10} />
            </button>
            <button className="icon-btn sm" title="Delete animator" onClick={() => A.removeTextNode(comp.id, layer.id, row.path!)}><Trash size={11} /></button>
          </span>
        );
      }
      break;
    }
    case 'selector':
      extra = (
        <span className="gx" onPointerDown={(e) => e.stopPropagation()}>
          <button className="icon-btn sm" title="Delete selector" onClick={() => A.removeTextNode(comp.id, layer.id, row.path!)}><Trash size={11} /></button>
        </span>
      );
      break;
  }
  return (
    <div
      className={`tl-left group${selected ? ' selected' : ''}`}
      style={{ paddingLeft: 6 + row.depth * INDENT }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (row.group === 'effect') setApp({ selEffect: row.ref ?? null, selLayers: getApp().selLayers.includes(layer.id) ? getApp().selLayers : [layer.id] });
        if (row.group === 'shapeGroup' || row.group === 'shapeItem') setApp({ selShapeItem: row.ref ?? null, selLayers: getApp().selLayers.includes(layer.id) ? getApp().selLayers : [layer.id] });
        if (row.group === 'mask') setApp({ selMask: row.ref ?? null });
        if (row.group === 'tracker' && row.ref) setTracking({ active: { compId: comp.id, layerId: layer.id, trackerId: row.ref } });
        if (row.group === 'trackPoint' && row.ref) {
          const tid = row.path?.split('.')[1];
          if (tid) setTracking({ active: { compId: comp.id, layerId: layer.id, trackerId: tid }, activePoint: row.ref });
        }
      }}
      onDoubleClick={() => {
        if (row.group === 'mask' || row.group === 'effect' || row.group === 'shapeGroup' || row.group === 'shapeItem' || row.group === 'animator' || row.group === 'selector' || row.group === 'tracker' || row.group === 'trackPoint') {
          openDialog({
            kind: 'rename', title: 'Rename', value: row.label, onSubmit: (v) => {
              if (row.group === 'effect') A.setEffectField(comp.id, layer.id, row.ref!, { name: v });
              else if (row.group === 'mask') A.setMaskFields(comp.id, layer.id, row.ref!, { name: v });
              else if (row.path) A.setLayerPath(comp.id, layer.id, `${row.path}.name`, v);
            },
          });
        }
      }}
    >
      <Twirl open={open} onClick={(e) => toggleKey(row.key, e)} />
      <span className="gname">{row.label}</span>
      {extra}
    </div>
  );
});

