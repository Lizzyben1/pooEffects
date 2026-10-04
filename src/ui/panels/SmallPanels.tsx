import { useEffect, useState } from 'react';
import {
  Play, Pause, SkipBack, SkipForward, StepBack, StepForward, Repeat, Volume2, VolumeX, Bold, Italic, CaseUpper,
  TextAlignStart, TextAlignCenter, TextAlignEnd, AlignStartVertical, AlignCenterVertical, AlignEndVertical, AlignStartHorizontal,
  AlignCenterHorizontal, AlignEndHorizontal, Cpu, MonitorPlay, MemoryStick,
} from 'lucide-react';
import { getApp, useActiveComp, useApp, viewerOf, setViewer } from '../../state/store';
import { usePlaying, useTimeState, getTime } from '../../state/time';
import { togglePlay, isLooping, setLoop, isMuted, toggleMute } from '../../state/playback';
import * as A from '../../state/actions';
import { stats as cacheStats, clearAll as clearCache } from '../../state/cache';
import { host } from '../../state/engine';
import { FONT_FAMILIES } from '../../fonts';
import { customFonts, onMediaChange } from '../../state/media';
import type { Composition, Layer, RGBA, TextDocument } from '../../core/types';
import { ColorSwatch } from '../controls/ColorPicker';
import { Scrub } from '../controls/Scrub';
import { TimeDisplay } from '../controls/TimeDisplay';
import { FrameEval, toLayerTime } from '../../core/evaluate';
import { layerBounds, layerQuad, makeViewCtx } from '../viewer/geometry';
import * as M from '../../math/mat4';
import { keyframedValue } from '../../anim/interpolate';
import type { Resolution } from '../../state/uiTypes';

// ── Preview ─────────────────────────────────────────────────────────────────

export function PreviewPanel() {
  const comp = useActiveComp();
  const playing = usePlaying();
  const realtime = useTimeState((s) => s.realtime);
  const fps = useTimeState((s) => s.playFps);
  const [loop, setL] = useState(isLooping());
  const [muted, setM] = useState(isMuted());
  // subscribe so the RAM-cache meter refreshes whenever frames are cached or purged
  useApp((s) => s.cacheVersion);
  const viewer = useApp((s) => viewerOf(s, s.activeCompId));
  const st = cacheStats();
  if (!comp) return <div className="empty">No composition</div>;
  return (
    <div className="preview-panel">
      <div className="transport">
        <button className="icon-btn" title="First Frame (Home)" onClick={() => A.goToTime(comp.id, 0)}><SkipBack size={15} /></button>
        <button className="icon-btn" title="Previous Frame (PageUp)" onClick={() => A.stepFrames(-1)}><StepBack size={15} /></button>
        <button className={`play-btn${playing ? ' playing' : ''}`} title="Play / Stop (Space)" onClick={togglePlay}>
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button className="icon-btn" title="Next Frame (PageDown)" onClick={() => A.stepFrames(1)}><StepForward size={15} /></button>
        <button className="icon-btn" title="Last Frame (End)" onClick={() => A.goToTime(comp.id, comp.duration)}><SkipForward size={15} /></button>
      </div>
      <div className="transport sub">
        <button className={`icon-btn${loop ? ' active' : ''}`} title="Loop" onClick={() => { setLoop(!loop); setL(!loop); }}><Repeat size={14} /></button>
        <button className={`icon-btn${muted ? '' : ' active'}`} title="Mute audio" onClick={() => { toggleMute(); setM(!muted); }}>{muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
        <div className="grow" />
        <TimeDisplay comp={comp} />
      </div>
      <div className="pv-grid">
        <label>Resolution</label>
        <select className="mini-select" value={viewer.resolution} onChange={(e) => setViewer(comp.id, { resolution: e.target.value as Resolution })}>
          <option value="auto">Auto</option><option value="full">Full</option><option value="half">Half</option><option value="third">Third</option><option value="quarter">Quarter</option>
        </select>
        <label>Status</label>
        <span className="mono">{playing ? (realtime ? `Real-time · ${fps.toFixed(1)} fps` : `Caching · ${fps.toFixed(1)} fps`) : 'Stopped'}</span>
        <label>RAM Cache</label>
        <span className="mono">{st.frames} frames · {st.mb.toFixed(0)} / {st.budgetMb.toFixed(0)} MB</span>
      </div>
      <div className="cache-meter"><span style={{ width: `${Math.min(100, (st.mb / st.budgetMb) * 100)}%` }} /></div>
      <button className="btn sm ghost" onClick={() => clearCache()} style={{ alignSelf: 'flex-start' }}>Purge RAM Cache</button>
      <p className="pv-hint">Press <kbd>Space</kbd> to preview. Uncached frames render in the GPU worker while playing (green bar fills), then playback switches to real-time with audio.</p>
    </div>
  );
}

// ── Info ────────────────────────────────────────────────────────────────────

export function InfoPanel() {
  const info = useApp((s) => s.info);
  const stats = useApp((s) => s.renderStats);
  const comp = useActiveComp();
  const sel = useApp((s) => s.selLayers);
  const project = useApp((s) => s.project);
  const layer = comp?.layers.find((l) => l.id === sel[0]);
  const caps = host.caps;
  const c = info.rgba;
  return (
    <div className="info-panel">
      <div className="info-row">
        <span className="info-swatch" style={{ background: c ? `rgb(${c[0]},${c[1]},${c[2]})` : 'transparent' }} />
        <div className="info-rgb mono">
          <div><b>R</b> {c ? c[0] : '—'}</div>
          <div><b>G</b> {c ? c[1] : '—'}</div>
          <div><b>B</b> {c ? c[2] : '—'}</div>
          <div><b>A</b> {c ? c[3] : '—'}</div>
        </div>
        <div className="info-xy mono">
          <div><b>X</b> {info.x !== undefined ? info.x.toFixed(0) : '—'}</div>
          <div><b>Y</b> {info.y !== undefined ? info.y.toFixed(0) : '—'}</div>
        </div>
      </div>
      {layer && comp && (
        <div className="info-layer">
          <div className="info-title">{layer.name}</div>
          <div className="mono">In {layer.inPoint.toFixed(2)}s · Out {layer.outPoint.toFixed(2)}s · Stretch {layer.stretch}%</div>
          <div className="mono">{layer.effects.length} effects · {layer.masks.length} masks{layer.parentId ? ` · parent: ${comp.layers.find((x) => x.id === layer.parentId)?.name}` : ''}</div>
        </div>
      )}
      <div className="info-sys">
        <div><Cpu size={12} /> Render: <b className="mono">{stats.ms.toFixed(1)} ms</b> / frame · {stats.layers} layers</div>
        <div><MonitorPlay size={12} /> GPU: <b>{host.mode === 'worker' ? 'WebGL2 · Web Worker' : 'WebGL2 · inline'}</b>{caps?.floatRender ? ' · float' : ''}</div>
        <div><MemoryStick size={12} /> Max texture: <b className="mono">{caps?.maxTex ?? '—'}</b> · WebCodecs: <b>{caps?.webcodecs ? 'yes' : 'no'}</b></div>
        <div style={{ color: 'var(--text-4)' }}>{Object.keys(project.comps).length} comps · {Object.keys(project.footage).length} footage</div>
      </div>
    </div>
  );
}

// ── Character ───────────────────────────────────────────────────────────────

export function CharacterPanel() {
  const comp = useActiveComp();
  const sel = useApp((s) => s.selLayers);
  const [, force] = useState(0);
  useEffect(() => onMediaChange(() => force((x) => x + 1)), []);
  const texts = comp?.layers.filter((l) => sel.includes(l.id) && l.type === 'text') ?? [];
  const l = texts[0];
  if (!comp || !l?.text) {
    return <div className="empty"><div><div className="big">Character</div>Select a text layer to edit its typography.<br />Use the <kbd>Ctrl</kbd>+<kbd>T</kbd> Type tool to create one.</div></div>;
  }
  const d = l.text.document;
  const set = (f: Partial<TextDocument>) => A.setTextDocument(comp.id, texts.map((x) => x.id), f);
  const families = [...new Set([...FONT_FAMILIES, ...customFonts])];
  return (
    <div className="char-panel">
      <select className="input" value={d.font} onChange={(e) => set({ font: e.target.value })} style={{ fontFamily: d.font }}>
        {families.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
      </select>
      <div className="char-grid">
        <label>Weight</label>
        <select className="mini-select" value={String(d.weight)} onChange={(e) => set({ weight: Number(e.target.value) })}>
          {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
        <label>Size</label>
        <Scrub value={d.size} min={1} max={2000} step={0.5} unit="px" onChange={(v) => set({ size: v })} />
        <label>Leading</label>
        <Scrub value={d.leading} min={0} max={4000} step={0.5} format={(v) => (v === 0 ? 'Auto' : v.toFixed(1))} onChange={(v) => set({ leading: v })} />
        <label>Tracking</label>
        <Scrub value={d.tracking} min={-1000} max={4000} step={1} precision={0} onChange={(v) => set({ tracking: v })} />
        <label>Baseline</label>
        <Scrub value={d.baselineShift} step={0.5} unit="px" onChange={(v) => set({ baselineShift: v })} />
        <label>Fill</label>
        <span className="char-color">
          <span className={`check${d.fillOn ? ' on' : ''}`} onClick={() => set({ fillOn: !d.fillOn })}>{d.fillOn ? '✓' : ''}</span>
          <ColorSwatch value={d.fill} onChange={(c: RGBA) => set({ fill: c })} />
        </span>
        <label>Stroke</label>
        <span className="char-color">
          <span className={`check${d.strokeOn ? ' on' : ''}`} onClick={() => set({ strokeOn: !d.strokeOn })}>{d.strokeOn ? '✓' : ''}</span>
          <ColorSwatch value={d.stroke} onChange={(c: RGBA) => set({ stroke: c })} />
          <Scrub value={d.strokeWidth} min={0} max={500} step={0.25} unit="px" onChange={(v) => set({ strokeWidth: v })} />
        </span>
        <label>Stroke Order</label>
        <select className="mini-select" value={d.strokeOverFill ? 'over' : 'under'} onChange={(e) => set({ strokeOverFill: e.target.value === 'over' })}>
          <option value="under">Fill Over Stroke</option>
          <option value="over">Stroke Over Fill</option>
        </select>
        <label>Box Width</label>
        <Scrub value={d.boxWidth ?? 0} min={0} max={10000} step={1} precision={0} format={(v) => (v <= 0 ? 'Point Text' : `${v.toFixed(0)}px`)} onChange={(v) => set({ boxWidth: v <= 0 ? null : v })} />
      </div>
      <div className="char-toggles">
        <button className={`icon-btn${d.weight >= 700 ? ' active' : ''}`} title="Bold" onClick={() => set({ weight: d.weight >= 700 ? 400 : 700 })}><Bold size={13} /></button>
        <button className={`icon-btn${d.italic ? ' active' : ''}`} title="Italic" onClick={() => set({ italic: !d.italic })}><Italic size={13} /></button>
        <button className={`icon-btn${d.allCaps ? ' active' : ''}`} title="All Caps" onClick={() => set({ allCaps: !d.allCaps })}><CaseUpper size={13} /></button>
        <span className="tool-sep" />
        <button className={`icon-btn${d.justify === 'left' ? ' active' : ''}`} title="Left align" onClick={() => set({ justify: 'left' })}><TextAlignStart size={13} /></button>
        <button className={`icon-btn${d.justify === 'center' ? ' active' : ''}`} title="Center" onClick={() => set({ justify: 'center' })}><TextAlignCenter size={13} /></button>
        <button className={`icon-btn${d.justify === 'right' ? ' active' : ''}`} title="Right align" onClick={() => set({ justify: 'right' })}><TextAlignEnd size={13} /></button>
      </div>
      <div className="char-preview" style={{ fontFamily: `"${d.font}"`, fontWeight: d.weight, fontStyle: d.italic ? 'italic' : 'normal', textTransform: d.allCaps ? 'uppercase' : 'none', letterSpacing: `${d.tracking / 1000}em` }}>
        {String(l.text.sourceText.value).slice(0, 40) || 'Aa'}
      </div>
    </div>
  );
}

// ── Align ───────────────────────────────────────────────────────────────────

type AlignOp = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

function alignLayers(comp: Composition, ids: string[], op: AlignOp, toComp: boolean) {
  const s = getApp();
  const t = getTime(comp.id);
  const v = makeViewCtx(s.project, comp, t, { kind: 'active' }, { cx: 0, cy: 0, zoom: 1, compW: comp.width, compH: comp.height });
  const items = comp.layers.filter((l) => ids.includes(l.id) && !l.locked).map((l) => {
    const b = layerBounds(s.project, comp, l, v.fe);
    const q = b ? layerQuad(v, l, b) : null;
    if (!q) return null;
    const xs = q.map((p) => p[0] + comp.width / 2), ys = q.map((p) => p[1] + comp.height / 2);
    return { l, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }).filter(Boolean) as { l: Layer; x0: number; x1: number; y0: number; y1: number }[];
  if (!items.length) return;
  const box = toComp || items.length < 2
    ? { x0: 0, x1: comp.width, y0: 0, y1: comp.height }
    : { x0: Math.min(...items.map((i) => i.x0)), x1: Math.max(...items.map((i) => i.x1)), y0: Math.min(...items.map((i) => i.y0)), y1: Math.max(...items.map((i) => i.y1)) };
  for (const it of items) {
    let dx = 0, dy = 0;
    if (op === 'left') dx = box.x0 - it.x0;
    if (op === 'right') dx = box.x1 - it.x1;
    if (op === 'hcenter') dx = (box.x0 + box.x1) / 2 - (it.x0 + it.x1) / 2;
    if (op === 'top') dy = box.y0 - it.y0;
    if (op === 'bottom') dy = box.y1 - it.y1;
    if (op === 'vcenter') dy = (box.y0 + box.y1) / 2 - (it.y0 + it.y1) / 2;
    const parent = it.l.parentId ? comp.layers.find((x) => x.id === it.l.parentId) : undefined;
    const fe = new FrameEval(s.project, comp, t);
    const inv = parent ? M.invert(fe.worldMatrix(parent)) : null;
    const d = inv ? M.transformDir(inv, [dx, dy, 0]) : [dx, dy, 0];
    const p = it.l.transform.position;
    const cur = (p.keyframes.length ? keyframedValue(p, toLayerTime(it.l, t), true) : p.value) as number[];
    A.setPropValue(comp.id, it.l.id, 'transform.position', [cur[0] + d[0], cur[1] + d[1], cur[2] ?? 0]);
  }
}

export function AlignPanel() {
  const comp = useActiveComp();
  const sel = useApp((s) => s.selLayers);
  const [toComp, setToComp] = useState(true);
  if (!comp) return <div className="empty">No composition</div>;
  const btn = (op: AlignOp, icon: React.ReactNode, title: string) => (
    <button className="icon-btn align-btn" title={title} disabled={!sel.length} onClick={() => alignLayers(comp, sel, op, toComp)}>{icon}</button>
  );
  return (
    <div className="align-panel">
      <div className="align-row">
        <span>Align Layers to:</span>
        <select className="mini-select" value={toComp ? 'comp' : 'sel'} onChange={(e) => setToComp(e.target.value === 'comp')}>
          <option value="comp">Composition</option>
          <option value="sel">Selection</option>
        </select>
      </div>
      <div className="align-btns">
        {btn('left', <AlignStartVertical size={16} />, 'Align Left')}
        {btn('hcenter', <AlignCenterVertical size={16} />, 'Align Horizontal Center')}
        {btn('right', <AlignEndVertical size={16} />, 'Align Right')}
        <span className="tool-sep" />
        {btn('top', <AlignStartHorizontal size={16} />, 'Align Top')}
        {btn('vcenter', <AlignCenterHorizontal size={16} />, 'Align Vertical Center')}
        {btn('bottom', <AlignEndHorizontal size={16} />, 'Align Bottom')}
      </div>
      {!sel.length && <p className="pv-hint">Select layers in the timeline or viewer.</p>}
    </div>
  );
}
