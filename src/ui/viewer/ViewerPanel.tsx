import { Camera, Grid3x3, Ratio, X, Layers, Box, Columns2, LayoutGrid, Square, Zap, Image as ImageIcon } from 'lucide-react';
import { setViewer, useActiveComp, useApp, viewerOf } from '../../state/store';
import { ViewPane } from './ViewPane';
import { TimeDisplay } from '../controls/TimeDisplay';
import { closeComp, openComp } from '../../state/actions';
import type { Resolution } from '../../state/uiTypes';
import type { ViewKind } from '../../render/projection';
import { MotionBlurIcon, Logo } from '../icons';
import { commands as C, saveFramePng, importFiles } from '../commands';
import { useTimeState } from '../../state/time';

const ZOOMS = [0.125, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 4, 8];
const VIEW_KINDS: { k: ViewKind; label: string }[] = [
  { k: 'active', label: 'Active Camera' }, { k: 'front', label: 'Front' }, { k: 'left', label: 'Left' }, { k: 'top', label: 'Top' },
  { k: 'back', label: 'Back' }, { k: 'right', label: 'Right' }, { k: 'bottom', label: 'Bottom' }, { k: 'custom', label: 'Custom View' },
];

function CompTabs() {
  const open = useApp((s) => s.openComps);
  const active = useApp((s) => s.activeCompId);
  const comps = useApp((s) => s.project.comps);
  if (!open.length) return null;
  return (
    <div className="comp-tabs">
      {open.map((id) => comps[id] && (
        <button key={id} className={`comp-tab${id === active ? ' active' : ''}`} onClick={() => openComp(id)}>
          <span className="comp-dot" />
          {comps[id].name}
          <span className="comp-close" onClick={(e) => { e.stopPropagation(); closeComp(id); }}><X size={10} /></span>
        </button>
      ))}
    </div>
  );
}

export function ViewerPanel() {
  const comp = useActiveComp();
  const viewer = useApp((s) => viewerOf(s, s.activeCompId));
  if (!comp) {
    return (
      <div
        className="empty viewer-empty"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void importFiles([...e.dataTransfer.files]);
        }}
      >
        <div>
          <Logo size={64} />
          <div className="big" style={{ marginTop: 14 }}>No composition open</div>
          <div>Create one with <kbd>Ctrl</kbd>+<kbd>N</kbd>, or load the demo project.</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
            <button className="btn primary" onClick={C.newComp}>New Composition</button>
            <button className="btn" onClick={C.loadDemo}>Load Demo</button>
          </div>
        </div>
      </div>
    );
  }
  const panes = viewer.layout === '1' ? [viewer.activeView] : viewer.layout === '2' ? [0, 1] : [0, 1, 2, 3];
  return (
    <div className="viewer">
      <CompTabs />
      <div className={`viewer-stage layout-${viewer.layout}`}>
        {panes.map((i) => (
          <ViewPane key={`${comp.id}:${i}`} comp={comp} index={i} view={viewer.views[i] ?? { kind: 'active' }} isActivePane={viewer.activeView === i} />
        ))}
      </div>
      <ViewerBar />
    </div>
  );
}

function ViewerBar() {
  const comp = useActiveComp()!;
  const viewer = useApp((s) => viewerOf(s, comp.id));
  const stats = useApp((s) => s.renderStats);
  const playing = useTimeState((s) => s.playing);
  const realtime = useTimeState((s) => s.realtime);
  const playFps = useTimeState((s) => s.playFps);
  const zoomLabel = viewer.zoom === null ? 'fit' : String(viewer.zoom);
  const activeView = viewer.views[viewer.activeView] ?? { kind: 'active' };
  const set = (p: Parameters<typeof setViewer>[1]) => setViewer(comp.id, p);
  return (
    <div className="viewer-bar">
      <select className="mini-select" value={zoomLabel} title="Magnification" onChange={(e) => set(e.target.value === 'fit' ? { zoom: null, panX: 0, panY: 0 } : { zoom: Number(e.target.value) })}>
        <option value="fit">Fit</option>
        {ZOOMS.map((z) => <option key={z} value={String(z)}>{Math.round(z * 1000) / 10}%</option>)}
        {viewer.zoom !== null && !ZOOMS.includes(viewer.zoom) && <option value={zoomLabel}>{Math.round(viewer.zoom * 1000) / 10}%</option>}
      </select>
      <select className="mini-select" value={viewer.resolution} title="Resolution / Down Sample Factor" onChange={(e) => set({ resolution: e.target.value as Resolution })}>
        <option value="auto">Auto</option>
        <option value="full">Full</option>
        <option value="half">Half</option>
        <option value="third">Third</option>
        <option value="quarter">Quarter</option>
      </select>
      <div className="vb-sep" />
      <button className="icon-btn" title="Take Snapshot (Save Frame As PNG)" onClick={() => void saveFramePng()}><Camera size={14} /></button>
      <button className={`icon-btn${viewer.transparency ? ' active' : ''}`} title="Toggle Transparency Grid" onClick={() => set({ transparency: !viewer.transparency })}><ImageIcon size={14} /></button>
      <button className={`icon-btn${viewer.grid || viewer.propGrid ? ' active' : ''}`} title="Grid (Ctrl+')" onClick={() => set({ grid: !viewer.grid })}><Grid3x3 size={14} /></button>
      <button className={`icon-btn${viewer.safe ? ' active' : ''}`} title="Title/Action Safe (')" onClick={() => set({ safe: !viewer.safe })}><Ratio size={14} /></button>
      <button className={`icon-btn${viewer.layerControls ? ' active' : ''}`} title="Layer Controls (Ctrl+Shift+H)" onClick={() => set({ layerControls: !viewer.layerControls })}><Layers size={14} /></button>
      <button className={`icon-btn${viewer.motionBlur ? ' active' : ''}`} title="Motion Blur in Viewer" onClick={() => set({ motionBlur: !viewer.motionBlur })}><MotionBlurIcon size={14} /></button>
      <button className={`icon-btn${viewer.draft3D ? ' active' : ''}`} title="Draft 3D (disable DOF & motion blur for speed)" onClick={() => set({ draft3D: !viewer.draft3D })}><Zap size={14} /></button>
      <div className="vb-sep" />
      <Box size={13} style={{ color: 'var(--text-3)' }} />
      <select
        className="mini-select"
        value={activeView.kind}
        title="3D View"
        onChange={(e) => {
          const views = [...viewer.views];
          views[viewer.activeView] = { ...views[viewer.activeView], kind: e.target.value as ViewKind };
          set({ views });
        }}
      >
        {VIEW_KINDS.map((v) => <option key={v.k} value={v.k}>{v.label}</option>)}
      </select>
      <div className="vb-group">
        <button className={`icon-btn sm${viewer.layout === '1' ? ' active' : ''}`} title="1 View" onClick={() => set({ layout: '1' })}><Square size={12} /></button>
        <button className={`icon-btn sm${viewer.layout === '2' ? ' active' : ''}`} title="2 Views" onClick={() => set({ layout: '2' })}><Columns2 size={12} /></button>
        <button className={`icon-btn sm${viewer.layout === '4' ? ' active' : ''}`} title="4 Views" onClick={() => set({ layout: '4' })}><LayoutGrid size={12} /></button>
      </div>
      <div className="grow" />
      <span className="vb-stat mono" title="Last frame render time (GPU worker)">
        {playing ? (
          <>
            <span className={`live-dot${realtime ? ' rt' : ''}`} />
            {realtime ? 'Real-time' : 'Rendering'} · {playFps.toFixed(1)} fps
          </>
        ) : (
          <>{stats.ms.toFixed(1)} ms · {stats.layers} layers</>
        )}
      </span>
      <div className="vb-sep" />
      <TimeDisplay comp={comp} />
      <span className="vb-dims mono">{comp.width}×{comp.height} · {comp.frameRate} fps</span>
    </div>
  );
}
