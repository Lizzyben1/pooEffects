import { useMemo, useState } from 'react';
import { ChevronRight, RotateCcw, Trash, Copy, GripVertical, Sparkles, ChevronLeft } from 'lucide-react';
import type { AnimProp, Composition, EffectInstance, Layer, PropValue } from '../../core/types';
import { setApp, useActiveComp, useApp, openContextMenu, openDialog } from '../../state/store';
import { useThrottledTime } from '../../state/time';
import { FrameEval, toLayerTime } from '../../core/evaluate';
import { getEffectDef, type EffectParamDef } from '../../effects/catalog';
import * as A from '../../state/actions';
import { PropEditor } from '../controls/PropEditor';
import { FxIcon, StopwatchIcon, LayerTypeIcon } from '../icons';
import { togglePanel } from '../commands';

export function EffectControlsPanel() {
  const comp = useActiveComp();
  const selLayers = useApp((s) => s.selLayers);
  const layer = comp?.layers.find((l) => l.id === selLayers[0]);
  if (!comp || !layer) {
    return (
      <div className="empty">
        <div>
          <Sparkles size={26} style={{ color: 'var(--text-4)' }} />
          <div className="big" style={{ marginTop: 8 }}>No layer selected</div>
          Select a layer to edit its effects.
        </div>
      </div>
    );
  }
  return <EffectControls comp={comp} layer={layer} />;
}

function EffectControls({ comp, layer }: { comp: Composition; layer: Layer }) {
  const project = useApp((s) => s.project);
  const t = useThrottledTime(comp.id, 10);
  const fe = useMemo(() => new FrameEval(project, comp, t, 0, null), [project, comp, t]);
  const [dragOver, setDragOver] = useState<number | null>(null);
  return (
    <div
      className="fxc"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-poo-effect')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        const type = e.dataTransfer.getData('application/x-poo-effect');
        if (type) {
          e.preventDefault();
          A.addEffect(comp.id, layer.id, type);
        }
      }}
    >
      <div className="fxc-head">
        <LayerTypeIcon type={layer.adjustment ? 'adjustment' : layer.type} />
        <span className="fxc-title">{comp.name} • <b>{layer.name}</b></span>
        <div className="grow" />
        <button className="btn sm ghost" onClick={() => togglePanel('effects')}><Sparkles size={12} /> Add Effect</button>
      </div>
      <div className="scroll fxc-list">
        {!layer.effects.length && (
          <div className="empty" style={{ minHeight: 160 }}>
            <div>
              <div className="big">No effects on this layer</div>
              Drag an effect from <b>Effects &amp; Presets</b>, or double-click one there.
            </div>
          </div>
        )}
        {layer.effects.map((fx, i) => (
          <EffectCard key={fx.id} comp={comp} layer={layer} fx={fx} fe={fe} index={i} dragOver={dragOver === i} setDragOver={setDragOver} />
        ))}
      </div>
    </div>
  );
}

function EffectCard({ comp, layer, fx, fe, index, dragOver, setDragOver }: { comp: Composition; layer: Layer; fx: EffectInstance; fe: FrameEval; index: number; dragOver: boolean; setDragOver: (n: number | null) => void }) {
  const def = getEffectDef(fx.type);
  const open = useApp((s) => s.expanded[`fxc|${fx.id}`] !== false);
  const sel = useApp((s) => s.selEffect === fx.id);
  const groups = new Map<string, EffectParamDef[]>();
  const order: (EffectParamDef | string)[] = [];
  for (const p of def?.params ?? []) {
    if (p.hidden) continue;
    if (p.group) {
      if (!groups.has(p.group)) {
        groups.set(p.group, []);
        order.push(p.group);
      }
      groups.get(p.group)!.push(p);
    } else order.push(p);
  }
  return (
    <div
      className={`fx-card${sel ? ' sel' : ''}${!fx.enabled ? ' off' : ''}${dragOver ? ' drag-over' : ''}`}
      onPointerDown={() => setApp({ selEffect: fx.id })}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-poo-fxmove')) {
          e.preventDefault();
          setDragOver(index);
        }
      }}
      onDragLeave={() => setDragOver(null)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData('application/x-poo-fxmove');
        setDragOver(null);
        if (id) {
          e.preventDefault();
          e.stopPropagation();
          A.moveEffect(comp.id, layer.id, id, index);
        }
      }}
    >
      <div className="fx-card-head">
        <span
          className="fx-grip"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-poo-fxmove', fx.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          title="Drag to reorder"
        >
          <GripVertical size={12} />
        </span>
        <span className={`twirl${open ? ' open' : ''}`} onClick={() => A.toggleExpanded(`fxc|${fx.id}`, !open)}><ChevronRight size={12} /></span>
        <span className={`sw${fx.enabled ? ' on' : ''}`} title="Effect on/off" onClick={() => A.setEffectField(comp.id, layer.id, fx.id, { enabled: !fx.enabled })}><FxIcon size={13} /></span>
        <span className="fx-name" onDoubleClick={() => openDialog({ kind: 'rename', title: 'Rename Effect', value: fx.name, onSubmit: (v) => A.setEffectField(comp.id, layer.id, fx.id, { name: v }) })}>{fx.name}</span>
        <span className="fx-cat">{def?.category}</span>
        <div className="grow" />
        <button className="link-btn" onClick={() => A.resetEffect(comp.id, layer.id, fx.id)} title="Reset"><RotateCcw size={11} /> Reset</button>
        <button
          className="icon-btn sm"
          onClick={(e) => openContextMenu(e.clientX, e.clientY, [
            { label: 'Duplicate', action: () => A.duplicateEffect(comp.id, layer.id, fx.id) },
            { label: 'Rename…', action: () => openDialog({ kind: 'rename', title: 'Rename Effect', value: fx.name, onSubmit: (v) => A.setEffectField(comp.id, layer.id, fx.id, { name: v }) }) },
            { label: 'Move Up', disabled: index === 0, action: () => A.moveEffect(comp.id, layer.id, fx.id, index - 1) },
            { label: 'Move Down', disabled: index === layer.effects.length - 1, action: () => A.moveEffect(comp.id, layer.id, fx.id, index + 1) },
            { separator: true },
            { label: 'Delete', danger: true, action: () => A.removeEffect(comp.id, layer.id, fx.id) },
          ])}
        >
          <Copy size={11} />
        </button>
        <button className="icon-btn sm" title="Delete effect" onClick={() => A.removeEffect(comp.id, layer.id, fx.id)}><Trash size={11} /></button>
      </div>
      {open && def && (
        <div className="fx-params">
          {order.map((o) => {
            if (typeof o === 'string') {
              return <ParamGroup key={o} name={o} fxId={fx.id}>{groups.get(o)!.map((p) => <ParamRow key={p.id} comp={comp} layer={layer} fx={fx} pd={p} fe={fe} />)}</ParamGroup>;
            }
            return <ParamRow key={o.id} comp={comp} layer={layer} fx={fx} pd={o} fe={fe} />;
          })}
        </div>
      )}
    </div>
  );
}

function ParamGroup({ name, fxId, children }: { name: string; fxId: string; children: React.ReactNode }) {
  const key = `fxg|${fxId}|${name}`;
  const open = useApp((s) => !!s.expanded[key]);
  return (
    <div className="fx-group">
      <div className="fx-group-head" onClick={() => A.toggleExpanded(key, !open)}>
        <span className={`twirl${open ? ' open' : ''}`}><ChevronRight size={11} /></span>
        {name}
      </div>
      {open && children}
    </div>
  );
}

function ParamRow({ comp, layer, fx, pd, fe }: { comp: Composition; layer: Layer; fx: EffectInstance; pd: EffectParamDef; fe: FrameEval }) {
  const path = `effects.${fx.id}.params.${pd.id}`;
  const prop = fx.params[pd.id] as AnimProp | undefined;
  if (!prop) return null;
  const value = fe.prop(layer, path, prop, pd.spatial) as PropValue;
  const animatable = pd.animatable !== false && pd.kind !== 'curves';
  const tall = pd.kind === 'curves' || pd.kind === 'gradient';
  const lt = toLayerTime(layer, fe.time);
  const fd = 0.5 / comp.frameRate;
  const atKey = prop.keyframes.some((k) => Math.abs(k.t - lt) < fd);
  const prev = [...prop.keyframes].reverse().find((k) => k.t < lt - fd);
  const next = prop.keyframes.find((k) => k.t > lt + fd);
  return (
    <div className={`fx-row${tall ? ' tall' : ''}`}>
      <span className="fx-sw">
        {animatable ? (
          <span className={`stopwatch${prop.keyframes.length ? ' on' : ''}`} title="Stopwatch (Alt+click: expression)" onClick={(e) => (e.altKey ? A.setExpression(comp.id, layer.id, path, prop.expression !== undefined ? null : 'value') : A.toggleStopwatch(comp.id, layer.id, path))}>
            <StopwatchIcon size={13} on={prop.keyframes.length > 0} />
          </span>
        ) : null}
      </span>
      <span className="fx-pname">{pd.name}</span>
      <span className="fx-pval">
        <PropEditor comp={comp} layer={layer} path={path} prop={prop} desc={pd} value={value} time={fe.time} wide />
      </span>
      {animatable && prop.keyframes.length > 0 && (
        <span className="kfnav">
          <button className={`kfnav-btn${prev ? '' : ' off'}`} onClick={() => prev && A.goToTime(comp.id, layer.startTime + prev.t * (layer.stretch / 100))}><ChevronLeft size={11} /></button>
          <button className={`kfnav-diamond${atKey ? ' on' : ''}`} onClick={() => A.toggleKeyframeAtCTI(comp.id, layer.id, path)} />
          <button className={`kfnav-btn${next ? '' : ' off'}`} onClick={() => next && A.goToTime(comp.id, layer.startTime + next.t * (layer.stretch / 100))}><ChevronRight size={11} /></button>
        </span>
      )}
      {prop.expression !== undefined && <span className="fx-expr mono" title={prop.expression}>= {prop.expression.slice(0, 28)}</span>}
    </div>
  );
}

