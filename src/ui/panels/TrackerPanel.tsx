// ─────────────────────────────────────────────────────────────────────────────
// Tracker panel (After Effects-style): Track Motion / Stabilize / Perspective
// corner pin, the 3D Camera Tracker and the SAM 2 Roto Brush, with transport
// controls (track ±1 frame, track forward/backward, stop), tracker options,
// live progress with a confidence sparkline, and apply / bake actions.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';
import {
  Crosshair, Move3d, Brush, Play, Square, StepForward, StepBack, SkipBack, Trash2, Target, RotateCcw, CheckCheck, Settings2,
  Video, Box, Type, CircleDot, Layers, Scissors, Cpu, Zap, Download, Eye, EyeOff, Undo2, Eraser, Grid3x3, Waypoints,
} from 'lucide-react';
import type { Composition, Layer, Tracker, TrackerKind, TrackChannel, LowConfidenceAction } from '../../core/types';
import { openDialog, setApp, useApp, useActiveComp } from '../../state/store';
import { useTime } from '../../state/time';
import { setPropValue, selectLayers } from '../../state/actions';
import {
  applyTracker, clearCameraTrack, createAtTrackPoints, createTrackedCamera, deleteTracker, editTrackPoint, isTrackable, newTracker, resetTracker,
  setCameraTrackFields, setGroundPlane, setTracking, setTrackerFields, setTrackerOptions, stopTracking, trackActive, trackCamera,
  trackerKindName, useTracking, type TrackJob,
} from '../../state/tracking';
import {
  bakeRotoToMasks, bakeRotoToTrackMatte, clearRoto, frameIndexAt, propagateRoto, rotoEffectOf, undoRotoPoint, useRoto,
} from '../../state/roto';
import { SAM_VARIANTS } from '../../cv/sam/protocol';
import { Scrub } from '../controls/Scrub';

export function TrackerPanel() {
  const comp = useActiveComp();
  const mode = useTracking((s) => s.mode);
  return (
    <div className="trk">
      <div className="trk-modes" role="tablist">
        {([['motion', 'Track Motion', <Crosshair key="m" size={13} />], ['camera', '3D Camera', <Move3d key="c" size={13} />], ['roto', 'Roto Brush', <Brush key="r" size={13} />]] as const).map(([id, label, icon]) => (
          <button key={id} role="tab" aria-selected={mode === id} className={`trk-mode${mode === id ? ' on' : ''}`} onClick={() => setTracking({ mode: id })}>
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </div>
      {!comp ? (
        <div className="trk-empty">Open a composition to start tracking.</div>
      ) : (
        <div className="trk-body">
          {mode === 'motion' && <MotionSection comp={comp} />}
          {mode === 'camera' && <CameraSection comp={comp} />}
          {mode === 'roto' && <RotoSection comp={comp} />}
        </div>
      )}
    </div>
  );
}

// ── shared ──────────────────────────────────────────────────────────────────

function useSourceLayer(comp: Composition): Layer | null {
  const sel = useApp((s) => s.selLayers);
  const active = useTracking((s) => s.active);
  return useMemo(() => {
    const trackable = comp.layers.filter(isTrackable);
    return trackable.find((l) => sel.includes(l.id))
      ?? (active?.compId === comp.id ? trackable.find((l) => l.id === active.layerId) : undefined)
      ?? null;
  }, [comp, sel, active]);
}

function SourcePicker({ comp, layer, label = 'Motion Source' }: { comp: Composition; layer: Layer | null; label?: string }) {
  const trackable = comp.layers.filter(isTrackable);
  return (
    <div className="trk-row">
      <span className="trk-label">{label}</span>
      <select className="trk-select" value={layer?.id ?? ''} onChange={(e) => e.target.value && selectLayers([e.target.value])}>
        <option value="">{trackable.length ? 'Select a footage layer…' : 'No footage or precomp layers'}</option>
        {trackable.map((l) => (
          <option key={l.id} value={l.id}>{comp.layers.indexOf(l) + 1}. {l.name}</option>
        ))}
      </select>
    </div>
  );
}

function Sparkline({ samples, color = 'var(--accent)' }: { samples: { t: number; c: number }[]; color?: string }) {
  if (samples.length < 2) return null;
  const ts = samples.map((s) => s.t);
  const t0 = Math.min(...ts), t1 = Math.max(...ts) || t0 + 1;
  const pts = samples.map((s) => `${(((s.t - t0) / (t1 - t0 || 1)) * 100).toFixed(2)},${(30 - (Math.max(0, Math.min(100, s.c)) / 100) * 28).toFixed(2)}`).join(' ');
  return (
    <svg className="trk-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="confidence over time">
      <line x1="0" x2="100" y1={30 - 0.8 * 28} y2={30 - 0.8 * 28} className="trk-spark-thr" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function JobBar({ job, label }: { job: TrackJob; label?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, job.fraction)) * 100);
  const elapsed = (performance.now() - job.startedAt) / 1000;
  const fps = job.done > 0 ? job.done / Math.max(0.001, elapsed) : 0;
  return (
    <div className="trk-job">
      <div className="trk-job-head">
        <span className="trk-job-stage"><span className="trk-pulse" />{label ?? job.stage}</span>
        <span className="trk-job-meta">{job.op !== 'camera' || job.stage === 'Analyzing footage' ? `${job.done}/${job.total} · ${fps.toFixed(1)} fps` : `${pct}%`}</span>
        <button className="btn sm danger" onClick={stopTracking} title="Stop"><Square size={10} fill="currentColor" /> Stop</button>
      </div>
      <div className="trk-progress"><div style={{ width: `${pct}%` }} /></div>
      {job.op !== 'camera' && <Sparkline samples={job.samples} />}
    </div>
  );
}

// ── motion ──────────────────────────────────────────────────────────────────

const CHANNELS: [TrackChannel, string][] = [['luminance', 'Luminance'], ['red', 'Red'], ['green', 'Green'], ['blue', 'Blue'], ['saturation', 'Saturation']];
const LOW_CONF: [LowConfidenceAction, string][] = [['continue', 'Continue tracking'], ['stop', 'Stop tracking'], ['extrapolate', 'Extrapolate motion'], ['adapt', 'Adapt feature']];

function MotionSection({ comp }: { comp: Composition }) {
  const layer = useSourceLayer(comp);
  const active = useTracking((s) => s.active);
  const job = useTracking((s) => s.job);
  const trackers = layer?.trackers ?? [];
  const tracker = trackers.find((t) => active?.layerId === layer?.id && t.id === active?.trackerId) ?? null;
  const target = tracker?.targetLayerId ? comp.layers.find((l) => l.id === tracker.targetLayerId) : null;
  const busy = !!job;
  const create = (kind: TrackerKind) => {
    if (!layer) return;
    newTracker(comp.id, layer.id, kind, kind === 'perspective' ? {} : { rotation: false, scale: false });
  };
  const keyCount = tracker ? Math.max(0, ...tracker.points.map((p) => p.featureCenter.keyframes.length)) : 0;
  return (
    <>
      <SourcePicker comp={comp} layer={layer} />
      <div className="trk-actions3">
        <button className="btn sm" disabled={!layer || busy} onClick={() => create('transform')} title="Track position (and optionally rotation/scale) of a feature"><Crosshair size={12} /> Track Motion</button>
        <button className="btn sm" disabled={!layer || busy} onClick={() => create('stabilize')} title="Lock the footage to a feature"><Target size={12} /> Stabilize</button>
        <button className="btn sm" disabled={!layer || busy} onClick={() => create('perspective')} title="4-point planar homography corner pin"><Grid3x3 size={12} /> Perspective</button>
      </div>
      {layer && trackers.length > 0 && (
        <div className="trk-row">
          <span className="trk-label">Current Track</span>
          <select className="trk-select" value={tracker?.id ?? ''} onChange={(e) => setTracking({ active: { compId: comp.id, layerId: layer.id, trackerId: e.target.value }, activePoint: null })}>
            {!tracker && <option value="">Choose…</option>}
            {trackers.map((t) => <option key={t.id} value={t.id}>{t.name} — {trackerKindName(t.kind)}</option>)}
          </select>
          {tracker && <button className="icon-btn sm" title="Delete tracker" disabled={busy} onClick={() => deleteTracker(comp.id, layer.id, tracker.id)}><Trash2 size={12} /></button>}
        </div>
      )}
      {!tracker && (
        <div className="trk-hint">
          {layer ? (trackers.length ? 'Pick a track above, or create a new one.' : 'Create a tracker, then drag its feature box onto a high-contrast detail in the viewer.') : 'Select a footage or precomp layer in the timeline.'}
        </div>
      )}
      {layer && tracker && (
        <>
          <div className="trk-row">
            <span className="trk-label">Track Type</span>
            <select className="trk-select" value={tracker.kind} disabled={busy} onChange={(e) => setTrackerFields(comp.id, layer.id, tracker.id, { kind: e.target.value as TrackerKind })}>
              <option value="transform">Transform</option>
              <option value="stabilize">Stabilize</option>
              <option value="perspective">Perspective corner pin</option>
            </select>
          </div>
          {tracker.kind !== 'perspective' && (
            <div className="trk-checks">
              {(['position', 'rotation', 'scale'] as const).map((k) => (
                <label key={k} className="chk-label">
                  <input type="checkbox" checked={tracker[k]} disabled={busy || k === 'position'} onChange={(e) => setTrackerFields(comp.id, layer.id, tracker.id, { [k]: e.target.checked })} />
                  {k[0].toUpperCase() + k.slice(1)}
                </label>
              ))}
            </div>
          )}
          {tracker.kind !== 'stabilize' && (
            <div className="trk-row">
              <span className="trk-label">Motion Target</span>
              <span className="trk-target" title={target ? target.name : 'A new null is created on Apply'}>{target ? target.name : <em>New Null (on Apply)</em>}</span>
              <button className="btn sm ghost" onClick={() => openDialog({ kind: 'trackTarget', compId: comp.id, layerId: layer.id, trackerId: tracker.id })}>Edit Target…</button>
            </div>
          )}
          <div className="trk-analyze">
            <span className="trk-label">Analyze</span>
            <div className="trk-transport">
              <button className="icon-btn" disabled={busy} title="Track backward (to the layer's in point)" onClick={() => trackActive(-1)}><SkipBack size={13} /></button>
              <button className="icon-btn" disabled={busy} title="Track 1 frame backward" onClick={() => trackActive(-1, true)}><StepBack size={13} /></button>
              <button className="icon-btn" disabled={busy} title="Track 1 frame forward" onClick={() => trackActive(1, true)}><StepForward size={13} /></button>
              <button className="icon-btn primary" disabled={busy} title="Track forward (to the layer's out point)" onClick={() => trackActive(1)}><Play size={13} fill="currentColor" /></button>
              <button className="icon-btn" disabled={!busy} title="Stop" onClick={stopTracking}><Square size={11} fill="currentColor" /></button>
            </div>
          </div>
          {job && (job.op === 'points' || job.op === 'planar') && <JobBar job={job} />}
          <PointList comp={comp} layer={layer} tracker={tracker} />
          <details className="trk-options">
            <summary><Settings2 size={12} /> Options</summary>
            <div className="trk-row">
              <span className="trk-label">Channel</span>
              <select className="trk-select" value={tracker.options.channel} onChange={(e) => setTrackerOptions(comp.id, layer.id, tracker.id, { channel: e.target.value as TrackChannel })}>
                {CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="trk-row">
              <span className="trk-label">Pre-blur</span>
              <Scrub value={tracker.options.blur} min={0} max={20} step={0.1} precision={1} unit="px" onChange={(v) => setTrackerOptions(comp.id, layer.id, tracker.id, { blur: v })} />
            </div>
            <div className="trk-checks col">
              <label className="chk-label"><input type="checkbox" checked={tracker.options.adaptFeature} onChange={(e) => setTrackerOptions(comp.id, layer.id, tracker.id, { adaptFeature: e.target.checked })} /> Adapt feature on every frame</label>
              <label className="chk-label"><input type="checkbox" checked={tracker.options.predictMotion} onChange={(e) => setTrackerOptions(comp.id, layer.id, tracker.id, { predictMotion: e.target.checked })} /> Predict motion</label>
              <label className="chk-label"><input type="checkbox" checked={tracker.options.subpixel} onChange={(e) => setTrackerOptions(comp.id, layer.id, tracker.id, { subpixel: e.target.checked })} /> Sub-pixel positioning</label>
            </div>
            <div className="trk-row">
              <span className="trk-label">If confidence &lt;</span>
              <Scrub value={tracker.options.confidenceThreshold} min={0} max={100} step={1} precision={0} unit="%" onChange={(v) => setTrackerOptions(comp.id, layer.id, tracker.id, { confidenceThreshold: v })} />
              <select className="trk-select" value={tracker.options.onLowConfidence} onChange={(e) => setTrackerOptions(comp.id, layer.id, tracker.id, { onLowConfidence: e.target.value as LowConfidenceAction })}>
                {LOW_CONF.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </details>
          <div className="trk-footer">
            <span className="trk-keys">{keyCount ? `${keyCount} tracked frames` : 'Not tracked yet'}</span>
            <div className="grow" />
            <button className="btn sm ghost" disabled={busy || !keyCount} onClick={() => resetTracker(comp.id, layer.id, tracker.id)}><RotateCcw size={11} /> Reset</button>
            <button className="btn sm primary" disabled={busy || keyCount < 2} onClick={() => applyTracker(comp.id, layer.id, tracker.id)}><CheckCheck size={12} /> Apply</button>
          </div>
        </>
      )}
    </>
  );
}

function PointList({ comp, layer, tracker }: { comp: Composition; layer: Layer; tracker: Tracker }) {
  const activePoint = useTracking((s) => s.activePoint);
  if (tracker.kind === 'perspective') {
    return (
      <div className="trk-points">
        <div className="trk-point-head">Corners track as one plane: drag the four numbered handles onto the surface corners.</div>
      </div>
    );
  }
  return (
    <div className="trk-points">
      {tracker.points.map((p, i) => (
        <div key={p.id} className={`trk-point${activePoint === p.id ? ' on' : ''}`} onClick={() => setTracking({ activePoint: p.id })}>
          <span className="trk-chip" style={{ background: ['#ffd24a', '#4fd6ff', '#ff6fb1', '#8cff6a'][i % 4] }} />
          <span className="trk-point-name">{p.name}</span>
          <span className="trk-dim" title="Feature region">F</span>
          <Scrub value={p.featureSize[0]} min={4} max={2000} precision={0} width={36} onChange={(v) => setFeature(comp, layer, tracker, p.id, 'featureSize', v)} />
          <span className="trk-dim" title="Search region">S</span>
          <Scrub value={p.searchSize[0]} min={8} max={4000} precision={0} width={36} onChange={(v) => setFeature(comp, layer, tracker, p.id, 'searchSize', v)} />
        </div>
      ))}
    </div>
  );
}

function setFeature(comp: Composition, layer: Layer, tracker: Tracker, pointId: string, key: 'featureSize' | 'searchSize', v: number): void {
  editTrackPoint(comp.id, layer.id, tracker.id, pointId, { [key]: [v, v] });
}

// ── 3D camera tracker ───────────────────────────────────────────────────────

function CameraSection({ comp }: { comp: Composition }) {
  const layer = useSourceLayer(comp);
  const job = useTracking((s) => s.job);
  const sel = useTracking((s) => s.camSel);
  const show = useTracking((s) => s.showTrackPoints);
  const ct = layer?.cameraTrack ?? null;
  const busy = !!job;
  const shotType = ct?.shotType ?? 'auto';
  const detail = ct?.detail ?? 'medium';
  const fov = ct?.fov ?? null;
  const [pendingCfg, setPending] = useState<PendingCfg>({});
  const setCfg = (f: Parameters<typeof setCameraTrackFields>[2]) => {
    if (layer && ct) setCameraTrackFields(comp.id, layer.id, f);
    else setPending((p) => ({ ...p, ...f }));
  };
  const hfov = ct?.solved ? (2 * Math.atan(ct.width / 2 / ct.f) * 180) / Math.PI : 0;
  const focalMm = ct?.solved ? (ct.f * 36) / ct.width : 0;
  return (
    <>
      <SourcePicker comp={comp} layer={layer} label="Footage" />
      <div className="trk-row">
        <span className="trk-label">Shot Type</span>
        <select className="trk-select" value={pendingCfg.shotType ?? shotType} disabled={busy} onChange={(e) => setCfg({ shotType: e.target.value as 'auto' | 'free' | 'tripod' })}>
          <option value="auto">Auto-detect</option>
          <option value="free">Free move (parallax)</option>
          <option value="tripod">Tripod pan (rotation only)</option>
        </select>
      </div>
      <div className="trk-row">
        <span className="trk-label">Angle of View</span>
        <select className="trk-select" value={(pendingCfg.fov !== undefined ? pendingCfg.fov : fov) === null ? 'auto' : 'fixed'} disabled={busy} onChange={(e) => setCfg({ fov: e.target.value === 'auto' ? null : 54 })}>
          <option value="auto">Estimate automatically</option>
          <option value="fixed">Specify horizontal</option>
        </select>
        {(pendingCfg.fov !== undefined ? pendingCfg.fov : fov) !== null && (
          <Scrub value={(pendingCfg.fov ?? fov) ?? 54} min={5} max={170} precision={1} unit="°" onChange={(v) => setCfg({ fov: v })} />
        )}
      </div>
      <div className="trk-row">
        <span className="trk-label">Detail</span>
        <div className="seg">
          {(['low', 'medium', 'high'] as const).map((d) => (
            <button key={d} className={`seg-btn${(pendingCfg.detail ?? detail) === d ? ' on' : ''}`} disabled={busy} onClick={() => setCfg({ detail: d })}>{d[0].toUpperCase() + d.slice(1)}</button>
          ))}
        </div>
      </div>
      <div className="trk-footer">
        {ct?.solved && <button className="btn sm ghost" disabled={busy} onClick={() => layer && clearCameraTrack(comp.id, layer.id)}><Eraser size={11} /> Clear</button>}
        <div className="grow" />
        <button
          className="btn sm primary"
          disabled={!layer || busy}
          onClick={() => {
            if (!layer) return;
            trackCamera(comp.id, layer.id, { shotType: pendingCfg.shotType ?? shotType, fov: pendingCfg.fov !== undefined ? pendingCfg.fov : fov, detail: pendingCfg.detail ?? detail });
            setPending({});
          }}
        >
          <Video size={12} /> {ct?.solved ? 'Re-analyze' : 'Track Camera'}
        </button>
      </div>
      {job?.op === 'camera' && <JobBar job={job} label={job.stage === 'Analyzing footage' ? 'Analyzing in background' : job.stage} />}
      {ct?.solved && layer && (
        <>
          <div className="trk-stats">
            <Stat label="Solve error" value={`${ct.rms.toFixed(2)} px`} good={ct.rms < 0.8} />
            <Stat label="Track points" value={String(ct.points.length)} />
            <Stat label="Angle of view" value={`${hfov.toFixed(1)}°`} />
            <Stat label="Focal (36 mm)" value={`${focalMm.toFixed(1)} mm`} />
            <Stat label="Frames" value={String(ct.frames.length)} />
            <Stat label="Mode" value={ct.mode === 'tripod' ? 'Tripod' : 'Free move'} />
          </div>
          <ErrorChart errors={ct.frameError} />
          <div className="trk-row">
            <label className="chk-label"><input type="checkbox" checked={show} onChange={(e) => setTracking({ showTrackPoints: e.target.checked })} /> Show track points</label>
            <div className="grow" />
            <span className="trk-keys">{sel.length ? `${sel.length} selected` : 'Drag in the viewer to select'}</span>
          </div>
          <div className="trk-row">
            <span className="trk-label">Scene Scale</span>
            <Scrub value={(ct.sceneScale || 1) * 100} min={1} max={10000} precision={0} unit="%" onChange={(v) => setCameraTrackFields(comp.id, layer.id, { sceneScale: v / 100 })} />
            {ct.ground && <span className="trk-badge">Ground plane set</span>}
          </div>
          <div className="trk-grid2">
            <button className="btn sm" disabled={sel.length < 3 || ct.mode === 'tripod'} onClick={() => setGroundPlane(comp.id, layer.id)} title="Select 3+ points on the floor"><Waypoints size={12} /> Set Ground Plane</button>
            <button className="btn sm" onClick={() => { createTrackedCamera(comp.id, layer.id); }}><Video size={12} /> Create Camera</button>
            <button className="btn sm" disabled={!sel.length} onClick={() => createAtTrackPoints(comp.id, layer.id, 'null')}><CircleDot size={12} /> Null + Camera</button>
            <button className="btn sm" disabled={!sel.length} onClick={() => createAtTrackPoints(comp.id, layer.id, 'solid')}><Box size={12} /> Solid + Camera</button>
            <button className="btn sm" disabled={!sel.length} onClick={() => createAtTrackPoints(comp.id, layer.id, 'text')}><Type size={12} /> Text + Camera</button>
            <button className="btn sm" disabled={sel.length < 2} onClick={() => createAtTrackPoints(comp.id, layer.id, 'null', true)}><Layers size={12} /> Nulls per point</button>
          </div>
        </>
      )}
      {!ct?.solved && !job && (
        <div className="trk-hint">
          The tracker detects FAST/Shi–Tomasi features, follows them with pyramidal KLT, prunes outliers with RANSAC, then solves camera rotation, translation and focal length with incremental structure-from-motion and bundle adjustment — all inside a Web Worker.
        </div>
      )}
    </>
  );
}

interface PendingCfg {
  shotType?: 'auto' | 'free' | 'tripod';
  fov?: number | null;
  detail?: 'low' | 'medium' | 'high';
}

function Stat({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className={`trk-stat${good ? ' good' : ''}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function ErrorChart({ errors }: { errors: number[] }) {
  const valid = errors.filter((e) => e >= 0);
  if (valid.length < 2) return null;
  const max = Math.max(1.5, ...valid);
  const n = errors.length;
  const bars = errors.map((e, i) => {
    const h = e < 0 ? 30 : (e / max) * 28;
    const cls = e < 0 ? 'bad' : e > 1.5 ? 'warn' : '';
    return <rect key={i} x={(i / n) * 100} y={30 - h} width={Math.max(0.3, 100 / n - 0.15)} height={h} className={cls} />;
  });
  return (
    <div className="trk-chart" title="Reprojection error per frame (analysis pixels)">
      <svg viewBox="0 0 100 30" preserveAspectRatio="none">{bars}</svg>
      <span>error / frame · max {max.toFixed(2)} px</span>
    </div>
  );
}

// ── roto brush ──────────────────────────────────────────────────────────────

function RotoSection({ comp }: { comp: Composition }) {
  const layer = useSourceLayer(comp);
  const project = useApp((s) => s.project);
  const tool = useApp((s) => s.tool);
  const roto = useRoto();
  const job = useTracking((s) => s.job);
  const time = useTime(comp.id);
  const r = layer ? rotoEffectOf(layer, project) : null;
  const frame = layer && r ? frameIndexAt(layer, r.info, time) : 0;
  const prompts = r?.info.prompts.find((p) => p.frame === frame)?.points ?? [];
  const nFrames = r ? Object.keys(r.info.revs).length : 0;
  const hasHere = !!r && r.info.revs[String(frame)] !== undefined;
  const fx = r && layer ? layer.effects.find((e) => e.id === r.fxId) : null;
  const busy = !!job;
  const totalMB = Object.values(roto.files).reduce((a, f) => a + f.total, 0) / 1048576;
  const loadedMB = Object.values(roto.files).reduce((a, f) => a + f.loaded, 0) / 1048576;
  const param = (id: string) => fx?.params[id]?.value;
  const setParam = (id: string, v: number | boolean | string) => {
    if (layer && fx) setPropValue(comp.id, layer.id, `effects.${fx.id}.params.${id}`, v);
  };
  return (
    <>
      <div className={`trk-model ${roto.model}`}>
        <div className="trk-model-icon">{roto.provider === 'webgpu' ? <Zap size={15} /> : <Cpu size={15} />}</div>
        <div className="trk-model-text">
          <b>SAM 2 · Hiera-Tiny</b>
          <span>
            {roto.model === 'ready' && `${roto.provider === 'webgpu' ? 'WebGPU' : 'CPU / WASM'} · ${roto.variant ? SAM_VARIANTS[roto.variant].label.split(' — ')[0] : ''}`}
            {roto.model === 'loading' && (totalMB > 0 ? `Downloading ${loadedMB.toFixed(1)} / ${totalMB.toFixed(1)} MB…` : 'Preparing…')}
            {roto.model === 'unloaded' && 'Not loaded — runs fully in your browser'}
            {roto.model === 'error' && (roto.error ?? 'Failed to load')}
          </span>
          {roto.model === 'loading' && totalMB > 0 && <div className="trk-progress"><div style={{ width: `${Math.min(100, (loadedMB / totalMB) * 100)}%` }} /></div>}
        </div>
        {roto.model !== 'ready' && roto.model !== 'loading' && (
          <button className="btn sm primary" onClick={() => openDialog({ kind: 'samModel' })}><Download size={12} /> Load</button>
        )}
      </div>
      <SourcePicker comp={comp} layer={layer} label="Layer" />
      <div className="trk-row">
        <button className={`btn sm${tool === 'roto' ? ' primary' : ''}`} onClick={() => setApp({ tool: tool === 'roto' ? 'select' : 'roto' })} title="Roto Brush tool (Alt+W)">
          <Brush size={12} /> Roto Brush Tool
        </button>
        <span className="trk-hint inline">Click = <b className="g">foreground</b> · Alt/right-click = <b className="r">background</b></span>
      </div>
      {layer && r && (
        <>
          <div className="trk-row">
            <span className="trk-label">Frame {frame}</span>
            <span className="trk-keys">{prompts.length ? `${prompts.length} prompt${prompts.length === 1 ? '' : 's'}` : hasHere ? 'propagated' : 'no matte'}</span>
            <div className="grow" />
            <button className="icon-btn sm" title="Undo last prompt" disabled={!prompts.length || roto.busy || busy} onClick={() => undoRotoPoint(comp.id, layer.id)}><Undo2 size={12} /></button>
            <button className="icon-btn sm" title="Clear this frame's prompts" disabled={!prompts.length || roto.busy || busy} onClick={() => undoRotoPoint(comp.id, layer.id, true)}><Eraser size={12} /></button>
            {roto.busy && <span className="trk-busy">segmenting…</span>}
          </div>
          <div className="trk-analyze">
            <span className="trk-label">Propagate</span>
            <div className="trk-transport">
              <button className="icon-btn" disabled={busy || !hasHere} title="Propagate backward" onClick={() => propagateRoto(comp.id, layer.id, -1)}><SkipBack size={13} /></button>
              <button className="icon-btn primary" disabled={busy || !hasHere} title="Propagate forward" onClick={() => propagateRoto(comp.id, layer.id, 1)}><Play size={13} fill="currentColor" /></button>
              <button className="icon-btn" disabled={!busy} title="Stop" onClick={stopTracking}><Square size={11} fill="currentColor" /></button>
            </div>
            <span className="trk-keys">{nFrames} frame{nFrames === 1 ? '' : 's'}</span>
          </div>
          {job?.op === 'roto' && <JobBar job={job} />}
          {roto.last && <div className="trk-perf">encode {roto.last.encodeMs.toFixed(0)} ms · decode {roto.last.decodeMs.toFixed(0)} ms · score {(roto.last.score * 100).toFixed(0)}</div>}
          {fx && (
            <div className="trk-refine">
              <div className="trk-row">
                <span className="trk-label">View</span>
                <div className="seg">
                  {([['final', 'Foreground'], ['matte', 'Matte'], ['overlay', 'Overlay']] as const).map(([v, l]) => (
                    <button key={v} className={`seg-btn${param('output') === v ? ' on' : ''}`} onClick={() => setParam('output', v)}>{l}</button>
                  ))}
                </div>
                <button className="icon-btn sm" title="Toggle boundary overlay" onClick={() => useRoto.setState({ overlay: !roto.overlay })}>{roto.overlay ? <Eye size={12} /> : <EyeOff size={12} />}</button>
              </div>
              {([['feather', 'Feather', 0, 200, 'px', 1], ['contrast', 'Contrast', 0, 100, '%', 0], ['shiftEdge', 'Shift Edge', -100, 100, 'px', 1], ['chatter', 'Reduce Chatter', 0, 100, '%', 0], ['decontamination', 'Decontaminate', 0, 100, '%', 0]] as const).map(([id, label, min, max, unit, prec]) => (
                <div key={id} className="trk-row">
                  <span className="trk-label">{label}</span>
                  {id === 'decontamination' && <input type="checkbox" checked={!!param('decontaminate')} onChange={(e) => setParam('decontaminate', e.target.checked)} />}
                  <Scrub value={Number(param(id) ?? 0)} min={min} max={max} precision={prec} unit={unit} onChange={(v) => setParam(id, v)} />
                </div>
              ))}
            </div>
          )}
          <div className="trk-section-title"><Scissors size={11} /> Freeze</div>
          <div className="trk-grid2">
            <button className="btn sm" disabled={!nFrames || busy} onClick={() => bakeRotoToTrackMatte(comp.id, layer.id)}><Layers size={12} /> Bake to Track Matte</button>
            <button className="btn sm" disabled={!nFrames || busy} onClick={() => bakeRotoToMasks(comp.id, layer.id)}><Waypoints size={12} /> Bake to Mask Path</button>
            <button className="btn sm ghost" disabled={!nFrames || busy} onClick={() => clearRoto(comp.id, layer.id)}><Trash2 size={12} /> Clear Mattes</button>
          </div>
        </>
      )}
      {layer && !r && <div className="trk-hint">Pick the Roto Brush tool and click the subject in the viewer. SAM 2 segments it instantly; then propagate through the shot and refine the edge.</div>}
    </>
  );
}

