// Modal dialogs: composition / solid / footage settings, pre-compose, time stretch, keyframe
// velocity, preferences, keyboard shortcuts, quick export, about and the welcome screen.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Clapperboard, Film, FilePlus2, FolderOpen, Gauge, Info, Keyboard, Layers, Link, Palette, Play, Search, Settings2, Sparkles, Square,
  Timer, Unlink, Upload, Download, Check, X, Cpu, ListVideo,
} from 'lucide-react';
import type { Composition, Ease, Keyframe, RGBA } from '../../core/types';
import { closeDialog, getApp, refOf, setPrefs, toast, useApp } from '../../state/store';
import type { DialogState, Preferences, RenderQueueItem } from '../../state/uiTypes';
import * as A from '../../state/actions';
import { createSolidLayer } from '../../core/factory';
import { FRAME_RATE_PRESETS, formatTime, parseTimeInput, supportsDropFrame } from '../../core/time';
import { getProp, getDescriptor } from '../../core/props';
import { toCompTime } from '../../core/evaluate';
import { Dialog } from '../controls/Dialog';
import { ColorPickerPanel, ColorSwatch } from '../controls/ColorPicker';
import { Logo } from '../icons';
import {
  FORMAT_INFO, FORMAT_ORDER, GIF_FPS_OPTIONS, SCALE_OPTIONS, canEncodeVideo, enqueue, quickExport, safeFileName,
} from '../../state/renderQueue';
import { commands as C, togglePanel } from '../commands';
import { SHORTCUTS, SHORTCUT_GROUPS, formatCombo } from './keymap';
import { host } from '../../state/engine';
import { clearAll as clearCache, stats as cacheStats } from '../../state/cache';
import { compHasAudio } from '../../audio/engine';
import { hexToRgba } from '../../math/color';
import type { ExportFormat } from '../../render/protocol';
import { applyTracker, findTracker, setTrackerFields, trackerKindName } from '../../state/tracking';
import { defaultVariant, loadSam, useRoto } from '../../state/roto';
import { SAM_VARIANTS, type SamVariant } from '../../cv/sam/protocol';
import { Crosshair, Brain, HardDriveDownload } from 'lucide-react';

export function DialogsHost() {
  const d = useApp((s) => s.dialog);
  if (!d) return null;
  return <DialogSwitch d={d} />;
}

function DialogSwitch({ d }: { d: DialogState }) {
  switch (d.kind) {
    case 'newComp':
      return <CompDialog />;
    case 'compSettings':
      return <CompDialog compId={d.compId} />;
    case 'solid':
      return <SolidDialog compId={d.compId} layerId={d.layerId} />;
    case 'interpret':
      return <InterpretDialog footageId={d.footageId} />;
    case 'precompose':
      return <PrecomposeDialog compId={d.compId} layerIds={d.layerIds} />;
    case 'timeStretch':
      return <TimeStretchDialog compId={d.compId} layerId={d.layerId} />;
    case 'keyframeVelocity':
      return <VelocityDialog compId={d.compId} />;
    case 'prefs':
      return <PrefsDialog />;
    case 'shortcuts':
      return <ShortcutsDialog />;
    case 'about':
      return <AboutDialog />;
    case 'rename':
      return <RenameDialog title={d.title} value={d.value} onSubmit={d.onSubmit} />;
    case 'export':
      return <ExportDialog compId={d.compId} />;
    case 'welcome':
      return <WelcomeDialog />;
    case 'trackTarget':
      return <TrackTargetDialog compId={d.compId} layerId={d.layerId} trackerId={d.trackerId} />;
    case 'samModel':
      return <SamModelDialog />;
  }
}

// ── shared bits ─────────────────────────────────────────────────────────────

function Row({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <>
      <label>{label}</label>
      <div className="form-row">
        {children}
        {hint && <span className="form-hint">{hint}</span>}
      </div>
    </>
  );
}

function Num({ value, onChange, min, max, step = 1, width = 90, suffix }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; width?: number; suffix?: string }) {
  return (
    <span className="num-field" style={{ width }}>
      <input
        className="input"
        type="number"
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        onBlur={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, v)));
        }}
      />
      {suffix && <em>{suffix}</em>}
    </span>
  );
}

function Toggle({ on, onChange, children }: { on: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <button type="button" className={`toggle${on ? ' on' : ''}`} onClick={() => onChange(!on)}>
      <span className="toggle-knob" />
      <span>{children}</span>
    </button>
  );
}

function Foot({ onOk, okLabel = 'OK', disabled, extra }: { onOk: () => void; okLabel?: string; disabled?: boolean; extra?: ReactNode }) {
  return (
    <>
      {extra}
      <div style={{ flex: 1 }} />
      <button className="btn ghost" onClick={closeDialog}>Cancel</button>
      <button className="btn primary" onClick={onOk} disabled={disabled}>{okLabel}</button>
    </>
  );
}

/** Enter submits (outside of textareas). */
function enterKey(fn: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
      e.preventDefault();
      fn();
    }
  };
}

// ── composition (new + settings) ────────────────────────────────────────────

const COMP_PRESETS: { name: string; w: number; h: number; fps: number }[] = [
  { name: 'HD 1080p', w: 1920, h: 1080, fps: 30 },
  { name: 'HD 1080p 24', w: 1920, h: 1080, fps: 24 },
  { name: 'HD 1080p 29.97', w: 1920, h: 1080, fps: 29.97 },
  { name: 'HD 1080p 60', w: 1920, h: 1080, fps: 60 },
  { name: 'HD 720p', w: 1280, h: 720, fps: 30 },
  { name: '4K UHD', w: 3840, h: 2160, fps: 30 },
  { name: 'Vertical 9:16', w: 1080, h: 1920, fps: 30 },
  { name: 'Square 1:1', w: 1080, h: 1080, fps: 30 },
  { name: 'Portrait 4:5', w: 1080, h: 1350, fps: 30 },
  { name: 'Cinema 2.39:1', w: 2048, h: 858, fps: 24 },
];

function CompDialog({ compId }: { compId?: string }) {
  const existing = useApp((s) => (compId ? s.project.comps[compId] : undefined));
  const project = useApp((s) => s.project);
  const [name, setName] = useState(existing?.name ?? A.uniqueCompName(project, 'Comp 1'));
  const [w, setW] = useState(existing?.width ?? 1920);
  const [h, setH] = useState(existing?.height ?? 1080);
  const [lock, setLock] = useState(true);
  const [fps, setFps] = useState(existing?.frameRate ?? 30);
  const [dropFrame, setDropFrame] = useState(existing?.dropFrame ?? false);
  const [durText, setDurText] = useState(() => formatTime(existing?.duration ?? 10, existing?.frameRate ?? 30, existing?.dropFrame ?? false));
  const [bg, setBg] = useState<RGBA>(existing?.bgColor ?? [0.04, 0.045, 0.055, 1]);
  const [mb, setMb] = useState(existing?.motionBlur ?? true);
  const [shutter, setShutter] = useState(existing?.shutterAngle ?? 180);
  const [phase, setPhase] = useState(existing?.shutterPhase ?? -90);
  const [samples, setSamples] = useState(existing?.motionBlurSamples ?? 16);
  const [bitDepth, setBitDepth] = useState<Composition['bitDepth']>(existing?.bitDepth ?? 8);
  const duration = parseTimeInput(durText, fps, dropFrame, existing?.duration ?? 10);
  const valid = !!name.trim() && w >= 4 && h >= 4 && w <= 8192 && h <= 8192 && fps > 0 && duration !== null && duration > 0;
  const setWidth = (v: number) => {
    if (lock && w > 0) setH(Math.max(1, Math.round((v * h) / w)));
    setW(Math.round(v));
  };
  const setHeight = (v: number) => {
    if (lock && h > 0) setW(Math.max(1, Math.round((v * w) / h)));
    setH(Math.round(v));
  };
  const submit = () => {
    if (!valid || duration === null) return;
    const df = supportsDropFrame(fps) && dropFrame;
    if (existing) {
      A.updateComp(existing.id, {
        name: name.trim(), width: w, height: h, frameRate: fps, dropFrame: df, duration, bgColor: bg, motionBlur: mb, shutterAngle: shutter,
        shutterPhase: phase, motionBlurSamples: samples, bitDepth,
      });
      toast('Composition updated', 'success', 1500);
    } else {
      const id = A.newComp({ name: name.trim(), width: w, height: h, frameRate: fps, duration, bgColor: bg });
      if (df) A.updateComp(id, { dropFrame: true });
    }
    closeDialog();
  };
  const ratio = (() => {
    const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
    const d = g(w, h) || 1;
    return `${w / d}:${h / d}`;
  })();
  return (
    <Dialog
      title={existing ? 'Composition Settings' : 'New Composition'}
      sub={existing ? existing.name : 'Choose a preset or enter custom settings'}
      icon={<Clapperboard size={18} style={{ color: 'var(--accent)' }} />}
      onClose={closeDialog}
      width={640}
      footer={<Foot onOk={submit} okLabel={existing ? 'Apply' : 'Create'} disabled={!valid} />}
    >
      <div onKeyDown={enterKey(submit)}>
        <div className="preset-strip">
          {COMP_PRESETS.map((p) => {
            const active = p.w === w && p.h === h && p.fps === fps;
            const s = 34 / Math.max(p.w, p.h);
            return (
              <button
                key={p.name}
                className={`preset-card${active ? ' active' : ''}`}
                onClick={() => {
                  setW(p.w);
                  setH(p.h);
                  setFps(p.fps);
                  setDropFrame(supportsDropFrame(p.fps));
                }}
                title={`${p.w}×${p.h} · ${p.fps} fps`}
              >
                <span className="preset-shape"><i style={{ width: p.w * s, height: p.h * s }} /></span>
                <span className="preset-name">{p.name}</span>
                <span className="preset-meta">{p.w}×{p.h}</span>
              </button>
            );
          })}
        </div>
        <div className="form-grid">
          <Row label="Name">
            <input className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
          </Row>
          <Row label="Size" hint={`${ratio}`}>
            <Num value={w} onChange={setWidth} min={4} max={8192} suffix="px" />
            <button className={`icon-btn${lock ? ' active' : ''}`} title="Lock aspect ratio" onClick={() => setLock(!lock)}>{lock ? <Link size={13} /> : <Unlink size={13} />}</button>
            <Num value={h} onChange={setHeight} min={4} max={8192} suffix="px" />
          </Row>
          <Row label="Frame Rate">
            <select className="input" style={{ width: 120 }} value={FRAME_RATE_PRESETS.includes(fps) ? String(fps) : 'custom'} onChange={(e) => {
              if (e.target.value === 'custom') return;
              const v = parseFloat(e.target.value);
              setFps(v);
              setDropFrame(supportsDropFrame(v));
            }}>
              {FRAME_RATE_PRESETS.map((f) => <option key={f} value={String(f)}>{f} fps</option>)}
              <option value="custom">Custom…</option>
            </select>
            <Num value={fps} onChange={(v) => setFps(Math.max(1, Math.min(240, v)))} min={1} max={240} step={0.001} width={96} suffix="fps" />
            {supportsDropFrame(fps) && <Toggle on={dropFrame} onChange={setDropFrame}>Drop Frame</Toggle>}
          </Row>
          <Row label="Duration" hint={duration !== null ? `${duration.toFixed(3)} s` : 'invalid'}>
            <input className={`input mono${duration === null ? ' invalid' : ''}`} style={{ width: 140 }} value={durText} onChange={(e) => setDurText(e.target.value)} />
          </Row>
          <Row label="Background">
            <ColorSwatch value={bg} onChange={setBg} alpha={false} title="Background Color" />
            <span className="form-hint">Shown in the viewer; transparent when nested or exported with alpha</span>
          </Row>
        </div>
        {existing && (
          <>
            <div className="section-label">Advanced</div>
            <div className="form-grid">
              <Row label="Motion Blur">
                <Toggle on={mb} onChange={setMb}>Enable for layers with the switch on</Toggle>
              </Row>
              <Row label="Shutter Angle" hint="°">
                <input className="slider" type="range" min={0} max={720} value={shutter} style={{ ['--pct' as string]: `${(shutter / 720) * 100}%` }} onChange={(e) => setShutter(Number(e.target.value))} />
                <Num value={shutter} onChange={setShutter} min={0} max={720} width={72} />
              </Row>
              <Row label="Shutter Phase" hint="°">
                <Num value={phase} onChange={setPhase} min={-360} max={360} width={72} />
              </Row>
              <Row label="Samples" hint="sub-frames per frame">
                <input className="slider" type="range" min={2} max={64} value={samples} style={{ ['--pct' as string]: `${((samples - 2) / 62) * 100}%` }} onChange={(e) => setSamples(Number(e.target.value))} />
                <Num value={samples} onChange={(v) => setSamples(Math.round(v))} min={2} max={64} width={72} />
              </Row>
              <Row label="Color Depth">
                <div className="seg">
                  {([8, 16, 32] as const).map((b) => (
                    <button key={b} className={bitDepth === b ? 'on' : ''} onClick={() => setBitDepth(b)}>{b} bpc</button>
                  ))}
                </div>
              </Row>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

// ── solid settings ──────────────────────────────────────────────────────────

function SolidDialog({ compId, layerId }: { compId: string; layerId?: string }) {
  const comp = useApp((s) => s.project.comps[compId]);
  const layer = comp?.layers.find((l) => l.id === layerId);
  const [name, setName] = useState(layer?.name ?? (comp ? A.uniqueLayerName(comp, 'Solid') : 'Solid'));
  const [w, setW] = useState(layer?.solid?.width ?? comp?.width ?? 1920);
  const [h, setH] = useState(layer?.solid?.height ?? comp?.height ?? 1080);
  const [color, setColor] = useState<RGBA>(layer?.solid?.color ?? hexToRgba('#ff9b3f'));
  if (!comp) return null;
  const submit = () => {
    if (layer) {
      A.setLayerFields(compId, [layer.id], { name: name.trim() || layer.name, solid: { color, width: w, height: h } });
      if (!layer.transform.anchor.keyframes.length && (w !== layer.solid?.width || h !== layer.solid?.height)) {
        A.setLayerPath(compId, layer.id, 'transform.anchor.value', [w / 2, h / 2, 0]);
      }
    } else A.addLayer(compId, createSolidLayer(comp, color, name.trim() || 'Solid', w, h));
    closeDialog();
  };
  return (
    <Dialog
      title={layer ? (layer.type === 'null' ? 'Null Settings' : 'Solid Settings') : 'New Solid'}
      sub={comp.name}
      icon={<Square size={17} style={{ color: 'var(--accent)' }} fill="currentColor" fillOpacity={0.3} />}
      onClose={closeDialog}
      width={560}
      footer={<Foot onOk={submit} okLabel={layer ? 'Apply' : 'Create'} />}
    >
      <div className="solid-dialog" onKeyDown={enterKey(submit)}>
        <div className="form-grid" style={{ alignContent: 'start' }}>
          <Row label="Name"><input className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)} /></Row>
          <Row label="Width"><Num value={w} onChange={(v) => setW(Math.round(v))} min={1} max={30000} suffix="px" /></Row>
          <Row label="Height"><Num value={h} onChange={(v) => setH(Math.round(v))} min={1} max={30000} suffix="px" /></Row>
          <div />
          <div className="form-row">
            <button className="btn sm" onClick={() => { setW(comp.width); setH(comp.height); }}>Make Comp Size</button>
          </div>
          <label>Preview</label>
          <div className="solid-preview" style={{ aspectRatio: `${Math.max(1, w)} / ${Math.max(1, h)}` }}>
            <span style={{ background: `rgba(${color[0] * 255},${color[1] * 255},${color[2] * 255},1)` }} />
          </div>
        </div>
        <ColorPickerPanel value={color} onChange={setColor} alpha={false} />
      </div>
    </Dialog>
  );
}

// ── footage interpretation ──────────────────────────────────────────────────

function InterpretDialog({ footageId }: { footageId: string }) {
  const f = useApp((s) => s.project.footage[footageId]);
  const [alpha, setAlpha] = useState(f?.interpret.alpha ?? 'straight');
  const [invert, setInvert] = useState(f?.interpret.invertAlpha ?? false);
  const [conform, setConform] = useState(f?.interpret.frameRate !== null && f?.interpret.frameRate !== undefined);
  const [rate, setRate] = useState(f?.interpret.frameRate ?? f?.frameRate ?? 30);
  const [loop, setLoop] = useState(f?.interpret.loop ?? 1);
  if (!f) return null;
  const submit = () => {
    A.updateFootage(f.id, { interpret: { alpha, invertAlpha: invert, frameRate: conform ? rate : null, loop: Math.max(1, Math.round(loop)) } });
    closeDialog();
  };
  return (
    <Dialog title="Interpret Footage" sub={f.name} icon={<Film size={17} style={{ color: 'var(--blue)' }} />} onClose={closeDialog} width={520} footer={<Foot onOk={submit} />}>
      <div className="form-grid" onKeyDown={enterKey(submit)}>
        <Row label="Alpha">
          <div className="seg">
            {(['straight', 'premultiplied', 'ignore'] as const).map((a) => (
              <button key={a} className={alpha === a ? 'on' : ''} onClick={() => setAlpha(a)}>{a[0].toUpperCase() + a.slice(1)}</button>
            ))}
          </div>
        </Row>
        <Row label=""><Toggle on={invert} onChange={setInvert}>Invert Alpha</Toggle></Row>
        {f.kind === 'video' && (
          <>
            <Row label="Frame Rate" hint={`file: ${f.frameRate} fps`}>
              <Toggle on={conform} onChange={setConform}>Conform to</Toggle>
              <Num value={rate} onChange={setRate} min={1} max={240} step={0.001} width={96} suffix="fps" />
            </Row>
          </>
        )}
        {f.kind !== 'image' && (
          <Row label="Loop" hint="times">
            <Num value={loop} onChange={setLoop} min={1} max={999} width={80} />
          </Row>
        )}
        <Row label="Source">
          <span className="form-hint">{f.kind} · {f.width ? `${f.width}×${f.height} · ` : ''}{f.duration ? `${f.duration.toFixed(2)} s · ` : ''}{(f.bytes / 1024 / 1024).toFixed(2)} MB</span>
        </Row>
      </div>
    </Dialog>
  );
}

// ── pre-compose ─────────────────────────────────────────────────────────────

function PrecomposeDialog({ compId, layerIds }: { compId: string; layerIds: string[] }) {
  const project = useApp((s) => s.project);
  const comp = project.comps[compId];
  const [name, setName] = useState(() => A.uniqueCompName(project, layerIds.length === 1 ? `${comp?.layers.find((l) => l.id === layerIds[0])?.name ?? 'Layer'} Comp` : 'Pre-comp 1'));
  const [moveAll, setMoveAll] = useState(true);
  const [open, setOpen] = useState(false);
  if (!comp) return null;
  const single = layerIds.length === 1;
  const submit = () => {
    const id = A.precompose(compId, layerIds, name.trim() || 'Pre-comp 1', single ? moveAll : true);
    if (id && open) A.openComp(id);
    closeDialog();
  };
  return (
    <Dialog title="Pre-compose" sub={`${layerIds.length} layer${single ? '' : 's'} from ${comp.name}`} icon={<Layers size={17} style={{ color: 'var(--accent)' }} />} onClose={closeDialog} width={500} footer={<Foot onOk={submit} />}>
      <div onKeyDown={enterKey(submit)}>
        <div className="form-grid">
          <Row label="New comp name"><input className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)} /></Row>
        </div>
        <div className="radio-list">
          <button className={`radio${!moveAll && single ? ' on' : ''}`} disabled={!single} onClick={() => setMoveAll(false)}>
            <span className="radio-dot" />
            <span><b>Leave all attributes in “{comp.name}”</b><em>Keeps transforms, effects and masks on the new precomp layer. Single layers only.</em></span>
          </button>
          <button className={`radio${moveAll || !single ? ' on' : ''}`} onClick={() => setMoveAll(true)}>
            <span className="radio-dot" />
            <span><b>Move all attributes into the new composition</b><em>The selected layers keep their animation inside the precomp.</em></span>
          </button>
        </div>
        <Toggle on={open} onChange={setOpen}>Open New Composition</Toggle>
      </div>
    </Dialog>
  );
}

// ── time stretch ────────────────────────────────────────────────────────────

function TimeStretchDialog({ compId, layerId }: { compId: string; layerId: string }) {
  const comp = useApp((s) => s.project.comps[compId]);
  const layer = comp?.layers.find((l) => l.id === layerId);
  const [pct, setPct] = useState(layer?.stretch ?? 100);
  if (!comp || !layer) return null;
  const span = Math.abs(layer.outPoint - layer.inPoint);
  const newDur = span * Math.abs(pct / (layer.stretch || 100));
  const submit = () => {
    if (pct !== 0) A.timeStretch(compId, layerId, pct);
    closeDialog();
  };
  return (
    <Dialog title="Time Stretch" sub={layer.name} icon={<Timer size={17} style={{ color: 'var(--accent)' }} />} onClose={closeDialog} width={440} footer={<Foot onOk={submit} disabled={pct === 0} />}>
      <div className="form-grid" onKeyDown={enterKey(submit)}>
        <Row label="Original Duration"><span className="mono form-hint">{formatTime(span, comp.frameRate, comp.dropFrame)}</span></Row>
        <Row label="Stretch Factor" hint="negative values reverse time">
          <Num value={pct} onChange={setPct} min={-10000} max={10000} step={1} width={110} suffix="%" />
        </Row>
        <Row label="New Duration"><span className="mono form-value">{formatTime(newDur, comp.frameRate, comp.dropFrame)}</span></Row>
        <Row label="Quick">
          {[50, 100, 200, -100].map((v) => <button key={v} className="btn sm" onClick={() => setPct(v)}>{v}%</button>)}
        </Row>
      </div>
    </Dialog>
  );
}

// ── keyframe velocity ───────────────────────────────────────────────────────

function VelocityDialog({ compId }: { compId: string }) {
  const project = useApp((s) => s.project);
  const selKeys = useApp((s) => s.selKeys);
  const comp = project.comps[compId];
  const first = selKeys[0] ? refOf(selKeys[0]) : null;
  const layer = first ? comp?.layers.find((l) => l.id === first.layerId) : undefined;
  const prop = layer && first ? getProp(layer, first.path) : undefined;
  const kf = prop?.keyframes.find((k) => k.id === first?.kfId) as Keyframe | undefined;
  const desc = layer && first ? getDescriptor(layer, first.path) : undefined;
  const dims = Math.max(kf?.easeIn.length ?? 1, 1);
  const [inE, setIn] = useState<Ease[]>(() => (kf ? kf.easeIn.map((e) => ({ ...e })) : [{ speed: 0, influence: 1 / 3 }]));
  const [outE, setOut] = useState<Ease[]>(() => (kf ? kf.easeOut.map((e) => ({ ...e })) : [{ speed: 0, influence: 1 / 3 }]));
  const [continuous, setContinuous] = useState(kf ? kf.inType === 'continuous' || kf.outType === 'continuous' : false);
  if (!comp || !layer || !first || !kf) {
    return (
      <Dialog title="Keyframe Velocity" onClose={closeDialog} footer={<button className="btn" onClick={closeDialog}>Close</button>}>
        <div className="empty" style={{ minHeight: 100 }}>Select one or more keyframes first.</div>
      </Dialog>
    );
  }
  const unit = desc?.spatial ? 'px/sec' : desc?.unit === '°' ? '°/sec' : desc?.unit === '%' ? '%/sec' : 'units/sec';
  const dimNames = dims === 1 ? [''] : ['X', 'Y', 'Z'].slice(0, dims);
  const update = (side: 'in' | 'out', i: number, f: Partial<Ease>) => {
    const set = side === 'in' ? setIn : setOut;
    const cur = side === 'in' ? inE : outE;
    const next = cur.map((e, j) => (j === i ? { ...e, ...f } : e));
    set(next);
    if (continuous && f.speed !== undefined) {
      const other = side === 'in' ? setOut : setIn;
      other((o) => o.map((e, j) => (j === i ? { ...e, speed: f.speed! } : e)));
    }
  };
  const submit = () => {
    for (const key of selKeys) {
      for (let i = 0; i < dims; i++) {
        A.setKeyframeEase(compId, key, 'in', i, inE[i] ?? inE[0], false);
        A.setKeyframeEase(compId, key, 'out', i, outE[i] ?? outE[0], false);
      }
    }
    closeDialog();
  };
  const side = (label: string, which: 'in' | 'out', list: Ease[]) => (
    <div className="vel-side">
      <div className="section-label" style={{ marginTop: 0 }}>{label}</div>
      {dimNames.map((dn, i) => (
        <div key={i} className="vel-row">
          {dn && <span className="vel-dim">{dn}</span>}
          <Num value={Math.round((list[i]?.speed ?? 0) * 1000) / 1000} onChange={(v) => update(which, i, { speed: v })} step={1} width={110} suffix={unit} />
          <Num value={Math.round((list[i]?.influence ?? 0) * 10000) / 100} onChange={(v) => update(which, i, { influence: Math.max(0.1, Math.min(100, v)) / 100 })} min={0.1} max={100} step={1} width={90} suffix="%" />
        </div>
      ))}
    </div>
  );
  return (
    <Dialog
      title="Keyframe Velocity"
      sub={`${layer.name} · ${desc?.name ?? first.path} · ${selKeys.length} keyframe${selKeys.length > 1 ? 's' : ''} @ ${formatTime(toCompTime(layer, kf.t), comp.frameRate, comp.dropFrame)}`}
      icon={<Gauge size={17} style={{ color: 'var(--accent)' }} />}
      onClose={closeDialog}
      width={560}
      footer={<Foot onOk={submit} extra={<Toggle on={continuous} onChange={setContinuous}>Continuous</Toggle>} />}
    >
      <div className="vel-grid" onKeyDown={enterKey(submit)}>
        {side('Incoming Velocity', 'in', inE)}
        {side('Outgoing Velocity', 'out', outE)}
      </div>
      <div className="form-hint" style={{ marginTop: 10 }}>Speed is in property units per second; influence is how far the handle reaches toward the neighbouring keyframe.</div>
    </Dialog>
  );
}

// ── preferences ─────────────────────────────────────────────────────────────

const HIGHLIGHTS = ['#ff9b3f', '#4f9dff', '#3ddc84', '#b48cff', '#ff5d9e', '#2fd4d4', '#ffd34d'];

function PrefsDialog() {
  const prefs = useApp((s) => s.prefs);
  const set = (p: Partial<Preferences>) => setPrefs(p);
  const st = cacheStats();
  return (
    <Dialog title="Preferences" icon={<Settings2 size={17} style={{ color: 'var(--accent)' }} />} onClose={closeDialog} width={580} footer={<>
      <button className="btn ghost" onClick={() => {
        set({ cacheBudgetMB: 1536, backgroundRender: true, audioScrub: true, autoSave: true, showSplash: true, highlightColor: '#ff9b3f', timelineLabelBars: true });
        toast('Preferences reset', 'info', 1500);
      }}>Reset to Defaults</button>
      <div style={{ flex: 1 }} />
      <button className="btn primary" onClick={closeDialog}>Done</button>
    </>}>
      <div className="section-label" style={{ marginTop: 4 }}>Previews &amp; Cache</div>
      <div className="form-grid">
        <Row label="RAM cache budget" hint={`${prefs.cacheBudgetMB >= 1024 ? `${(prefs.cacheBudgetMB / 1024).toFixed(1)} GB` : `${prefs.cacheBudgetMB} MB`}`}>
          <input className="slider" type="range" min={256} max={8192} step={128} value={prefs.cacheBudgetMB} style={{ ['--pct' as string]: `${((prefs.cacheBudgetMB - 256) / (8192 - 256)) * 100}%` }} onChange={(e) => set({ cacheBudgetMB: Number(e.target.value) })} />
        </Row>
        <Row label="In use" hint={`${st.frames} frames`}>
          <div className="mini-meter"><i style={{ width: `${Math.min(100, (st.mb / Math.max(1, st.budgetMb)) * 100)}%` }} /></div>
          <button className="btn sm" onClick={() => { clearCache(); toast('RAM cache purged', 'info', 1500); }}>Purge</button>
        </Row>
        <Row label="Background caching"><Toggle on={prefs.backgroundRender} onChange={(v) => set({ backgroundRender: v })}>Render the work area into the cache while idle</Toggle></Row>
      </div>
      <div className="section-label">Audio</div>
      <div className="form-grid">
        <Row label="Scrubbing"><Toggle on={prefs.audioScrub} onChange={(v) => set({ audioScrub: v })}>Play audio snippets while dragging the time indicator</Toggle></Row>
      </div>
      <div className="section-label">General</div>
      <div className="form-grid">
        <Row label="Auto-save"><Toggle on={prefs.autoSave} onChange={(v) => set({ autoSave: v })}>Keep the project in browser storage</Toggle></Row>
        <Row label="Startup"><Toggle on={prefs.showSplash} onChange={(v) => set({ showSplash: v })}>Show the splash screen</Toggle></Row>
      </div>
      <div className="section-label">Appearance</div>
      <div className="form-grid">
        <Row label="Highlight color">
          <div className="hl-swatches">
            {HIGHLIGHTS.map((c) => (
              <button key={c} className={`hl-swatch${prefs.highlightColor === c ? ' on' : ''}`} style={{ background: c }} onClick={() => set({ highlightColor: c })} title={c}>
                {prefs.highlightColor === c && <Check size={11} strokeWidth={3} />}
              </button>
            ))}
            <ColorSwatch value={hexToRgba(prefs.highlightColor)} alpha={false} title="Custom highlight" onChange={(c) => set({ highlightColor: `#${c.slice(0, 3).map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}` })} />
          </div>
        </Row>
        <Row label="Timeline"><Toggle on={prefs.timelineLabelBars} onChange={(v) => set({ timelineLabelBars: v })}>Tint layer bars with label colors</Toggle></Row>
      </div>
    </Dialog>
  );
}

// ── keyboard shortcuts ──────────────────────────────────────────────────────

function ShortcutsDialog() {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const groups = SHORTCUT_GROUPS.map((g) => ({
    g,
    items: SHORTCUTS.filter((s) => s.group === g && (!query || s.label.toLowerCase().includes(query) || s.keys.some((k) => k.toLowerCase().includes(query)))),
  })).filter((x) => x.items.length);
  return (
    <Dialog title="Keyboard Shortcuts" sub="After Effects bindings · ⌘ replaces Ctrl on macOS" icon={<Keyboard size={18} style={{ color: 'var(--accent)' }} />} onClose={closeDialog} width={860}>
      <div className="search" style={{ marginBottom: 12, flex: 'none' }}>
        <Search size={12} />
        <input placeholder="Search commands or keys…" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="sc-grid">
        {groups.map(({ g, items }) => (
          <div key={g} className="sc-group">
            <div className="sc-title">{g}</div>
            {items.map((s, i) => (
              <div key={i} className="sc-row" title={s.note}>
                <span className="sc-label">{s.label}{s.note ? ' *' : ''}</span>
                <span className="sc-keys">
                  {s.keys.map((k, j) => (
                    <span key={k} className="sc-combo">
                      {j > 0 && <span className="sc-or">or</span>}
                      {formatCombo(k).map((part, n) => <kbd key={n}>{part}</kbd>)}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
        {!groups.length && <div className="empty" style={{ gridColumn: '1 / -1' }}>No shortcut matches “{q}”.</div>}
      </div>
      <div className="form-hint" style={{ marginTop: 10 }}>* Reserved by most browsers unless pooEffects runs as an installed app; an alternative binding is listed.</div>
    </Dialog>
  );
}

// ── about ───────────────────────────────────────────────────────────────────

function AboutDialog() {
  const caps = host.caps;
  const checks: [string, boolean | undefined][] = [
    ['WebGL 2', caps?.webgl2],
    ['Float render targets', caps?.floatRender],
    ['OffscreenCanvas worker', caps ? host.mode === 'worker' : undefined],
    ['WebCodecs encode', caps?.webcodecs],
    ['Web Audio', typeof AudioContext !== 'undefined'],
    ['IndexedDB', typeof indexedDB !== 'undefined'],
  ];
  return (
    <Dialog title="" onClose={closeDialog} width={560}>
      <div className="about">
        <div className="about-hero">
          <Logo size={86} animated />
          <div>
            <div className="about-name">poo<b>Effects</b></div>
            <div className="about-tag">Motion graphics, VFX &amp; compositing — entirely in your browser.</div>
            <div className="about-ver mono">v1.0 · client-side · no uploads</div>
          </div>
        </div>
        <div className="section-label">This browser</div>
        <div className="about-caps">
          {checks.map(([label, ok]) => (
            <span key={label} className={`cap${ok ? ' ok' : ok === false ? ' no' : ''}`}>
              {ok ? <Check size={11} strokeWidth={3} /> : ok === false ? <X size={11} strokeWidth={3} /> : <Cpu size={11} />}
              {label}
            </span>
          ))}
          {caps && <span className="cap ok"><Info size={11} />Max texture {caps.maxTex}px</span>}
        </div>
        <div className="section-label">Built with</div>
        <div className="about-libs">
          React 19 · zustand · immer · WebGL2 (hand-written shader graph) · mediabunny (WebCodecs mux/demux) · gifenc · fflate · lucide
        </div>
      </div>
    </Dialog>
  );
}

// ── rename ──────────────────────────────────────────────────────────────────

function RenameDialog({ title, value, onSubmit }: { title: string; value: string; onSubmit: (v: string) => void }) {
  const [v, setV] = useState(value);
  const submit = () => {
    if (v.trim()) onSubmit(v.trim());
    closeDialog();
  };
  return (
    <Dialog title={title} onClose={closeDialog} width={420} footer={<Foot onOk={submit} disabled={!v.trim()} />}>
      <input className="input" value={v} autoFocus onFocus={(e) => e.target.select()} onChange={(e) => setV(e.target.value)} onKeyDown={enterKey(submit)} />
    </Dialog>
  );
}

// ── quick export ────────────────────────────────────────────────────────────

const FORMAT_ICONS: Record<ExportFormat, ReactNode> = {
  mp4: <Film size={18} />,
  webm: <Play size={18} />,
  'webm-alpha': <Sparkles size={18} />,
  gif: <Palette size={18} />,
  png: <Layers size={18} />,
};

function ExportDialog({ compId }: { compId: string }) {
  const project = useApp((s) => s.project);
  const comp = project.comps[compId];
  const video = canEncodeVideo();
  const [format, setFormat] = useState<ExportFormat>(video ? 'mp4' : 'png');
  const [scale, setScale] = useState(1);
  const [quality, setQuality] = useState<RenderQueueItem['quality']>('high');
  const [range, setRange] = useState<RenderQueueItem['range']>('workArea');
  const [motionBlur, setMotionBlur] = useState(true);
  const [audio, setAudio] = useState(true);
  const [gifFps, setGifFps] = useState(20);
  const [filename, setFilename] = useState(comp ? safeFileName(comp.name) : 'render');
  const hasAudio = useMemo(() => (comp ? compHasAudio(project, comp) : false), [project, comp]);
  if (!comp) return null;
  const info = FORMAT_INFO[format];
  const [a, b] = range === 'workArea' ? comp.workArea : [0, comp.duration];
  let W = Math.max(2, Math.round(comp.width * scale)), H = Math.max(2, Math.round(comp.height * scale));
  if (info.video) {
    W -= W % 2;
    H -= H % 2;
  }
  const opts: Partial<RenderQueueItem> = { format, scale, quality, range, motionBlur, includeAudio: audio, gifFps, filename: filename || 'render' };
  return (
    <Dialog
      title="Export"
      sub={`${comp.name} · ${formatTime(b - a, comp.frameRate, comp.dropFrame)} · ${W}×${H}`}
      icon={<Download size={18} style={{ color: 'var(--accent)' }} />}
      onClose={closeDialog}
      width={660}
      footer={<>
        <span className="form-hint">{info.desc}</span>
        <div style={{ flex: 1 }} />
        <button className="btn ghost" onClick={closeDialog}>Cancel</button>
        <button className="btn" onClick={() => { enqueue(comp.id, opts); togglePanel('renderQueue'); closeDialog(); }}><ListVideo size={13} /> Add to Queue</button>
        <button className="btn primary" disabled={info.video && !video} onClick={() => { quickExport(comp.id, opts); togglePanel('renderQueue'); closeDialog(); }}><Play size={12} fill="currentColor" /> Render</button>
      </>}
    >
      <div className="fmt-grid">
        {FORMAT_ORDER.map((f) => {
          const fi = FORMAT_INFO[f];
          const off = fi.video && !video;
          return (
            <button key={f} className={`fmt-card${format === f ? ' on' : ''}`} disabled={off} onClick={() => setFormat(f)} title={off ? 'WebCodecs VideoEncoder is unavailable in this browser' : fi.desc}>
              <span className="fmt-ic">{FORMAT_ICONS[f]}</span>
              <span className="fmt-label">{fi.label}</span>
              <span className="fmt-ext mono">.{fi.ext}{fi.alpha ? ' · alpha' : ''}</span>
            </button>
          );
        })}
      </div>
      <div className="form-grid" style={{ marginTop: 14 }}>
        <Row label="Resolution" hint={`${W}×${H}`}>
          <div className="seg">
            {SCALE_OPTIONS.map((s) => <button key={s} className={scale === s ? 'on' : ''} onClick={() => setScale(s)}>{Math.round(s * 100)}%</button>)}
          </div>
        </Row>
        {info.video && (
          <Row label="Quality">
            <div className="seg">
              {(['low', 'medium', 'high', 'very-high'] as const).map((q) => <button key={q} className={quality === q ? 'on' : ''} onClick={() => setQuality(q)}>{q === 'very-high' ? 'Very High' : q[0].toUpperCase() + q.slice(1)}</button>)}
            </div>
          </Row>
        )}
        {format === 'gif' && (
          <Row label="Frame Rate">
            <div className="seg">
              {GIF_FPS_OPTIONS.map((f) => <button key={f} className={gifFps === f ? 'on' : ''} onClick={() => setGifFps(f)}>{f}</button>)}
            </div>
          </Row>
        )}
        <Row label="Range" hint={`${formatTime(a, comp.frameRate, comp.dropFrame)} → ${formatTime(b, comp.frameRate, comp.dropFrame)}`}>
          <div className="seg">
            <button className={range === 'workArea' ? 'on' : ''} onClick={() => setRange('workArea')}>Work Area</button>
            <button className={range === 'comp' ? 'on' : ''} onClick={() => setRange('comp')}>Entire Comp</button>
          </div>
        </Row>
        <Row label="Options">
          <Toggle on={motionBlur} onChange={setMotionBlur}>Motion Blur</Toggle>
          {info.video && <Toggle on={audio && hasAudio} onChange={setAudio}>{hasAudio ? 'Include Audio' : 'No audio in comp'}</Toggle>}
        </Row>
        <Row label="File name" hint={`.${info.ext}`}>
          <input className="input" value={filename} onChange={(e) => setFilename(e.target.value.replace(/[\\/:*?"<>|]+/g, ''))} />
        </Row>
      </div>
    </Dialog>
  );
}

// ── welcome ─────────────────────────────────────────────────────────────────

export const WELCOME_KEY = 'poo.welcomed';

function WelcomeDialog() {
  const [again, setAgain] = useState(false);
  const close = () => {
    try {
      localStorage.setItem(WELCOME_KEY, again ? '0' : '1');
    } catch {
      /* storage unavailable */
    }
    closeDialog();
  };
  const act = (fn: () => void) => () => {
    close();
    fn();
  };
  const hasComp = !!getApp().activeCompId;
  return (
    <Dialog title="" onClose={close} width={720}>
      <div className="welcome">
        <div className="welcome-hero">
          <div className="welcome-glow" />
          <Logo size={72} animated />
          <div>
            <div className="welcome-title">Welcome to poo<b>Effects</b></div>
            <div className="welcome-sub">A GPU motion-graphics &amp; compositing studio that runs entirely in your browser. Nothing is uploaded — your media never leaves this machine.</div>
          </div>
        </div>
        <div className="welcome-actions">
          <button className="welcome-card primary" onClick={act(() => (hasComp ? undefined : C.loadDemo()))}>
            <Sparkles size={20} />
            <b>{hasComp ? 'Explore the demo' : 'Load the demo'}</b>
            <span>A 12-second title sequence with 3D camera, DOF, shape operators, kinetic type and music.</span>
          </button>
          <button className="welcome-card" onClick={act(C.newComp)}>
            <FilePlus2 size={20} />
            <b>New composition</b>
            <span>Start from HD, 4K, vertical or square presets.</span>
          </button>
          <button className="welcome-card" onClick={act(() => void C.importFile())}>
            <Upload size={20} />
            <b>Import media</b>
            <span>Video, images, audio and fonts — or just drop files anywhere.</span>
          </button>
          <button className="welcome-card" onClick={act(() => void C.openProject())}>
            <FolderOpen size={20} />
            <b>Open project</b>
            <span>Continue a saved <span className="mono">.pooe</span> project file.</span>
          </button>
        </div>
        <div className="welcome-tips">
          <span><kbd>Space</kbd> play</span>
          <span><kbd>J</kbd><kbd>K</kbd> jump keyframes</span>
          <span><kbd>U</kbd> reveal animation</span>
          <span><kbd>F9</kbd> easy ease</span>
          <span><kbd>`</kbd> maximize panel</span>
          <span><kbd>F1</kbd> all shortcuts</span>
        </div>
        <div className="welcome-foot">
          <Toggle on={again} onChange={setAgain}>Show this again next time</Toggle>
          <div style={{ flex: 1 }} />
          <button className="btn primary" onClick={close}>Get started</button>
        </div>
      </div>
    </Dialog>
  );
}

// ── tracker: edit target ────────────────────────────────────────────────────

function TrackTargetDialog({ compId, layerId, trackerId }: { compId: string; layerId: string; trackerId: string }) {
  const project = useApp((s) => s.project);
  const f = findTracker(project, compId, layerId, trackerId);
  const [target, setTarget] = useState<string>(f?.tracker.targetLayerId ?? '');
  const [dims, setDims] = useState<'xy' | 'x' | 'y'>(f?.tracker.applyDims ?? 'xy');
  if (!f) return null;
  const candidates = f.comp.layers.filter((l) => l.id !== layerId && l.type !== 'audio');
  const save = (apply: boolean) => {
    setTrackerFields(compId, layerId, trackerId, { targetLayerId: target || null, applyDims: dims });
    closeDialog();
    if (apply) applyTracker(compId, layerId, trackerId);
  };
  const isPin = f.tracker.kind === 'perspective';
  return (
    <Dialog
      title="Motion Target"
      sub={`${f.tracker.name} · ${trackerKindName(f.tracker.kind)} · source “${f.layer.name}”`}
      icon={<Crosshair size={17} style={{ color: 'var(--accent)' }} />}
      onClose={closeDialog}
      width={480}
      footer={<Foot onOk={() => save(false)} extra={<button className="btn" onClick={() => save(true)}>OK &amp; Apply</button>} />}
    >
      <div className="form-grid" onKeyDown={enterKey(() => save(false))}>
        <Row label="Apply Motion To" hint={isPin ? 'receives a keyframed Corner Pin effect' : 'position (and rotation/scale) keyframes'}>
          <select className="input" value={target} onChange={(e) => setTarget(e.target.value)} style={{ minWidth: 240 }}>
            <option value="">New Null Object (created on Apply)</option>
            {candidates.map((l) => <option key={l.id} value={l.id}>{f.comp.layers.indexOf(l) + 1}. {l.name}</option>)}
          </select>
        </Row>
        {!isPin && (
          <Row label="Apply Dimensions">
            <div className="seg">
              {([['xy', 'X and Y'], ['x', 'X only'], ['y', 'Y only']] as const).map(([v, l]) => (
                <button key={v} className={`seg-btn${dims === v ? ' on' : ''}`} onClick={() => setDims(v)}>{l}</button>
              ))}
            </div>
          </Row>
        )}
        <Row label="Rotation / Scale">
          <span className="form-hint">{isPin ? 'Perspective tracks drive all four corners.' : f.tracker.rotation || f.tracker.scale ? `Also applies ${[f.tracker.rotation && 'rotation', f.tracker.scale && 'scale'].filter(Boolean).join(' and ')} from the two-point track.` : 'Enable Rotation or Scale in the Tracker panel for a two-point track.'}</span>
        </Row>
      </div>
    </Dialog>
  );
}

// ── SAM 2 model ─────────────────────────────────────────────────────────────

function SamModelDialog() {
  const [variant, setVariant] = useState<SamVariant>(defaultVariant());
  const [gpu, setGpu] = useState<boolean | null>(null);
  const roto = useRoto();
  useEffect(() => {
    const g = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!g) {
      setGpu(false);
      return;
    }
    g.requestAdapter().then((a) => setGpu(!!a)).catch(() => setGpu(false));
  }, []);
  const loadLocal = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.onnx,.onnx_data';
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      const pick = (enc: boolean, data: boolean) => files.find((f) => (enc ? /vision_encoder/i.test(f.name) : /prompt_encoder|mask_decoder/i.test(f.name)) && (data ? /\.onnx_data$/i.test(f.name) : /\.onnx$/i.test(f.name)));
      const e = pick(true, false), ed = pick(true, true), dd = pick(false, false), dda = pick(false, true);
      if (!e || !dd) {
        toast('Select the vision_encoder and prompt_encoder_mask_decoder .onnx files (plus their .onnx_data)', 'error', 6000);
        return;
      }
      const name = e.name.replace(/\.onnx$/i, '');
      const v = (Object.entries(SAM_VARIANTS).find(([, x]) => x.encoder === name)?.[0] ?? variant) as SamVariant;
      closeDialog();
      void loadSam(v, {
        encoder: await e.arrayBuffer(), encoderData: ed ? await ed.arrayBuffer() : undefined,
        decoder: await dd.arrayBuffer(), decoderData: dda ? await dda.arrayBuffer() : undefined,
      });
    };
    input.click();
  };
  const start = () => {
    closeDialog();
    void loadSam(variant);
  };
  return (
    <Dialog
      title="SAM 2 Auto-Rotoscope"
      sub="Segment Anything 2 · Hiera-Tiny · runs entirely in your browser"
      icon={<Brain size={17} style={{ color: 'var(--accent)' }} />}
      onClose={closeDialog}
      width={560}
      footer={<Foot onOk={start} okLabel={roto.model === 'ready' ? 'Reload' : 'Download & Load'} extra={<button className="btn ghost" onClick={loadLocal}><HardDriveDownload size={13} /> Load from files…</button>} />}
    >
      <div className="sam-dlg">
        <p className="sam-lead">
          The model is downloaded once from Hugging Face (<span className="mono">onnx-community/sam2.1-hiera-tiny-ONNX</span>), cached in browser storage, and
          executed with ONNX Runtime Web inside a worker — {gpu === null ? 'checking for WebGPU…' : gpu ? <b className="ok">WebGPU is available on this device.</b> : <b className="warn">WebGPU is not available; inference falls back to CPU (WASM) and is much slower.</b>}
        </p>
        <div className="sam-variants">
          {(Object.keys(SAM_VARIANTS) as SamVariant[]).map((v) => (
            <button key={v} className={`sam-variant${variant === v ? ' on' : ''}`} onClick={() => setVariant(v)}>
              <span className="sam-radio" />
              <span className="sam-vtext">
                <b>{SAM_VARIANTS[v].label.split(' — ')[0]}</b>
                <span>{SAM_VARIANTS[v].label.split(' — ')[1]}</span>
              </span>
              <span className="sam-size">{SAM_VARIANTS[v].mb} MB</span>
              {((gpu && v === 'fp16') || (gpu === false && v === 'int8')) && <span className="sam-rec">Recommended</span>}
            </button>
          ))}
        </div>
        <p className="form-hint">Nothing leaves your machine: frames are rendered and segmented locally. Prompts: click = foreground, Alt/right-click = background.</p>
      </div>
    </Dialog>
  );
}
