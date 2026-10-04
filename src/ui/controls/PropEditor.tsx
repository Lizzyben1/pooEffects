// Generic property value editor driven by PropDescriptor (used by the timeline and Effect Controls).

import { useState } from 'react';
import { Link2, Unlink } from 'lucide-react';
import type { AnimProp, Composition, CurvesValue, GradientStop, Layer, PropDescriptor, PropValue, RGBA } from '../../core/types';
import { Scrub, formatAngle, parseAngle, formatNumber } from './Scrub';
import { ColorSwatch } from './ColorPicker';
import { GradientEditor } from './GradientEditor';
import { CurvesEditor } from './CurvesEditor';
import { setPropValue } from '../../state/actions';
import { keyframedValue } from '../../anim/interpolate';
import { toLayerTime } from '../../core/evaluate';
import { Popover } from './Popover';

export interface PropEditorProps {
  comp: Composition;
  layer: Layer;
  path: string;
  prop: AnimProp;
  desc: PropDescriptor;
  /** displayed (post-expression) value */
  value: PropValue;
  time: number;
  /** larger layout for Effect Controls */
  wide?: boolean;
}

const AXES = ['X', 'Y', 'Z'];

export function PropEditor({ comp, layer, path, prop, desc, value, time, wide }: PropEditorProps) {
  const [linked, setLinked] = useState(true);
  const [textEdit, setTextEdit] = useState<DOMRect | null>(null);
  const animated = prop.keyframes.length > 0;
  const hasExpr = !!prop.expression && prop.expressionEnabled !== false;
  const cls = hasExpr ? 'expr' : animated ? 'animated' : '';
  const base = (): PropValue => (animated ? keyframedValue(prop, toLayerTime(layer, time), !!desc.spatial) : prop.value);
  const set = (v: PropValue) => setPropValue(comp.id, layer.id, path, v);
  const p = desc.precision ?? 1;

  switch (desc.kind) {
    case 'number':
    case 'slider':
    case 'percent': {
      const v = typeof value === 'number' ? value : 0;
      const range = (desc.softMax ?? desc.max ?? 100) - (desc.softMin ?? desc.min ?? 0);
      const step = desc.kind === 'percent' ? 0.5 : desc.step ?? Math.max(0.01, Math.min(1, range / 300));
      const scrub = (
        <Scrub
          value={v}
          className={cls}
          step={step}
          min={desc.min}
          max={desc.max}
          precision={desc.kind === 'percent' ? 1 : p}
          unit={desc.unit}
          onChange={(nv) => set(nv)}
        />
      );
      if (wide && desc.kind === 'slider' && desc.softMin !== undefined && desc.softMax !== undefined) {
        const pct = ((v - desc.softMin) / (desc.softMax - desc.softMin || 1)) * 100;
        return (
          <div className="pe-slider">
            {scrub}
            <input
              type="range"
              className="slider"
              min={desc.softMin}
              max={desc.softMax}
              step={(desc.softMax - desc.softMin) / 500}
              value={Math.min(desc.softMax, Math.max(desc.softMin, v))}
              style={{ ['--pct' as string]: `${Math.max(0, Math.min(100, pct))}%` }}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => set(Number(e.target.value))}
            />
          </div>
        );
      }
      return scrub;
    }
    case 'angle': {
      const v = typeof value === 'number' ? value : 0;
      return <Scrub value={v} className={cls} step={0.5} format={formatAngle} parse={parseAngle} onChange={(nv) => set(nv)} />;
    }
    case 'vec2':
    case 'vec3':
    case 'point2':
    case 'point3': {
      const arr = Array.isArray(value) ? (value as number[]) : [0, 0, 0];
      const dims = desc.dims ?? (desc.kind.endsWith('3') ? 3 : 2);
      const isScale = path.endsWith('.scale') || path === 'transform.scale';
      return (
        <span className="pe-vec">
          {isScale && (
            <button className={`icon-btn sm${linked ? ' active' : ''}`} title="Constrain proportions" onClick={() => setLinked(!linked)} onPointerDown={(e) => e.stopPropagation()}>
              {linked ? <Link2 size={11} /> : <Unlink size={11} />}
            </button>
          )}
          {Array.from({ length: dims }, (_, i) => (
            <Scrub
              key={i}
              value={arr[i] ?? 0}
              className={cls}
              precision={p}
              step={isScale ? 0.5 : 1}
              unit={desc.unit === '%' && i === dims - 1 ? '%' : undefined}
              title={AXES[i]}
              onChange={(nv) => {
                const b = (base() as number[]).slice();
                while (b.length < arr.length) b.push(arr[b.length]);
                if (isScale && linked) {
                  const ratio = (b[i] || 1e-6) !== 0 ? nv / (b[i] || 1e-6) : 1;
                  for (let k = 0; k < dims; k++) b[k] = k === i ? nv : (b[k] ?? 0) * ratio;
                } else b[i] = nv;
                set(b);
              }}
            />
          ))}
        </span>
      );
    }
    case 'color':
      return <ColorSwatch value={(value as RGBA) ?? [1, 1, 1, 1]} onChange={(c) => set(c)} />;
    case 'bool': {
      const on = !!value;
      return (
        <span className={`check${on ? ' on' : ''}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => set(!on)}>
          {on && <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5.2l2 2 4-4.4" stroke="currentColor" strokeWidth="1.8" fill="none" /></svg>}
        </span>
      );
    }
    case 'enum':
      return (
        <select className="mini-select" value={String(value)} onPointerDown={(e) => e.stopPropagation()} onChange={(e) => set(e.target.value)}>
          {desc.options?.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
        </select>
      );
    case 'layer':
      return (
        <select className="mini-select" value={String(value ?? '')} onPointerDown={(e) => e.stopPropagation()} onChange={(e) => set(e.target.value)}>
          <option value="">None</option>
          {comp.layers.filter((l) => l.id !== layer.id).map((l, i) => <option key={l.id} value={l.id}>{i + 1}. {l.name}</option>)}
        </select>
      );
    case 'gradient':
      return wide ? <GradientEditor value={value as GradientStop[]} onChange={(g) => set(g)} /> : <span className="pe-muted">Gradient</span>;
    case 'curves':
      return wide ? <CurvesEditor value={value as CurvesValue} onChange={(c) => set(c)} /> : <span className="pe-muted">Curves</span>;
    case 'path':
      return <span className="pe-muted" title="Edit paths in the Composition viewer">{animated ? 'Path (animated)' : 'Path'}</span>;
    case 'text':
      return (
        <>
          <span className="pe-text" title="Click to edit text" onClick={(e) => setTextEdit((e.currentTarget as HTMLElement).getBoundingClientRect())}>
            {String(value ?? '').replace(/\n/g, ' ⏎ ').slice(0, 32) || '(empty)'}
          </span>
          {textEdit && (
            <Popover x={textEdit.left} y={textEdit.bottom + 4} anchorRect={textEdit} onClose={() => setTextEdit(null)}>
              <div style={{ padding: 8, width: 280 }}>
                <textarea
                  className="input"
                  rows={4}
                  defaultValue={String(value ?? '')}
                  autoFocus
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      set((e.target as HTMLTextAreaElement).value);
                      setTextEdit(null);
                    }
                  }}
                  onBlur={(e) => set(e.target.value)}
                />
                <div style={{ color: 'var(--text-3)', fontSize: 11, marginTop: 4 }}>Ctrl/⌘+Enter to apply</div>
              </div>
            </Popover>
          )}
        </>
      );
    default:
      return <span className="pe-muted">{formatNumber(Number(value) || 0, p)}</span>;
  }
}
