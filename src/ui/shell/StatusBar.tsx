import { useEffect, useState } from 'react';
import { Cpu, Film, HardDrive, MemoryStick, MousePointerClick } from 'lucide-react';
import type { Composition, Project } from '../../core/types';
import type { VideoDecodeStats } from '../../render/protocol';
import { useActiveComp, useApp } from '../../state/store';
import { host } from '../../state/engine';
import { stats as cacheStats } from '../../state/cache';
import { formatTime } from '../../core/time';
import type { CameraToolKind, ToolId } from '../../state/uiTypes';

const TOOL_HINTS: Record<Exclude<ToolId, 'camera'>, string> = {
  select: 'Click to select · drag to move (Shift constrains) · drag handles to scale or rotate · marquee to select several',
  hand: 'Drag to pan the viewer — hold Space or the middle mouse button with any tool',
  zoom: 'Click to zoom in · Alt+click to zoom out · Ctrl+wheel zooms faster',
  rotate: 'Drag a layer to rotate it · Shift snaps to 45°',
  panBehind: 'Drag the anchor point without moving the layer on screen',
  shape: 'Drag to draw (Shift constrains) · with a shape layer selected the path is added to it',
  pen: 'Click to add vertices · drag for Bézier handles · click the first vertex or press Enter to close',
  text: 'Click to create point text · click a text layer to edit its source text',
  roto: 'Roto Brush (SAM 2): click the subject to add foreground · Alt-click or right-click adds background · propagate from the Tracker panel',
};

const CAMERA_HINTS: Record<CameraToolKind, string> = {
  orbit: 'Drag to orbit the active camera around its point of interest (custom views orbit the scene)',
  trackXY: 'Drag to track the camera horizontally and vertically',
  trackZ: 'Drag to dolly the camera towards or away from its point of interest',
};

export function StatusBar() {
  const comp = useActiveComp();
  const project = useApp((s) => s.project);
  const fileName = useApp((s) => s.fileName);
  const dirty = useApp((s) => s.dirty);
  const tool = useApp((s) => s.tool);
  const cameraTool = useApp((s) => s.cameraTool);
  const selLayers = useApp((s) => s.selLayers.length);
  const selKeys = useApp((s) => s.selKeys.length);
  const autoSave = useApp((s) => s.prefs.autoSave);
  useApp((s) => s.cacheVersion);
  const [ready, setReady] = useState(!!host.caps);
  useEffect(() => {
    let alive = true;
    host.ready.then(() => alive && setReady(true)).catch(() => alive && setReady(false));
    return () => {
      alive = false;
    };
  }, []);
  const mediaStats = useApp((s) => s.mediaStats);
  const decode = comp ? decodeSummary(project, comp, mediaStats) : null;
  const cs = cacheStats();
  const hint = tool === 'camera' ? CAMERA_HINTS[cameraTool] : TOOL_HINTS[tool];
  return (
    <footer className="statusbar">
      <span className={`sb-project${dirty ? ' dirty' : ''}`} title={dirty ? 'Unsaved changes (Ctrl+S saves a .pooe file)' : 'Saved'}>
        <i />
        {fileName ?? project.name}
      </span>
      {comp && (
        <span className="sb-comp">
          <b>{comp.name}</b> {comp.width}×{comp.height} · {comp.frameRate} fps · {formatTime(comp.duration, comp.frameRate, comp.dropFrame)}
        </span>
      )}
      {(selLayers > 0 || selKeys > 0) && (
        <span className="sb-sel">
          {selLayers > 0 && `${selLayers} layer${selLayers > 1 ? 's' : ''}`}
          {selLayers > 0 && selKeys > 0 && ' · '}
          {selKeys > 0 && `${selKeys} keyframe${selKeys > 1 ? 's' : ''}`}
        </span>
      )}
      <span className="sb-hint"><MousePointerClick size={11} /> {hint}</span>
      <span className="grow" />
      {decode && (
        <span className={`sb-item sb-decode ${decode.path}`} title={decode.tooltip}>
          <span className="dot" />
          <Film size={11} />
          {decode.label}
        </span>
      )}
      <span className="sb-item" title="RAM preview cache">
        <MemoryStick size={11} />
        {cs.mb.toFixed(0)} / {cs.budgetMb} MB · {cs.frames} fr
      </span>
      <span className="sb-item" title={autoSave ? 'Project and media are kept in browser storage' : 'Auto-save is off (Preferences)'}>
        <HardDrive size={11} />
        {autoSave ? 'Auto-save on' : 'Auto-save off'}
      </span>
      <span className={`sb-item${ready && host.mode === 'worker' ? '' : ' warn'}`} title={host.caps ? `WebGL2 · max texture ${host.caps.maxTex}px · float targets ${host.caps.floatRender ? 'yes' : 'no'}` : 'Starting renderer…'}>
        <span className="dot" />
        <Cpu size={11} />
        {ready ? `WebGL2 · ${host.mode === 'worker' ? 'Worker' : 'Main thread'}` : 'Starting GPU…'}
      </span>
    </footer>
  );
}

/** Video footage used by a comp (including nested precomps). */
function videoFootageIn(project: Project, comp: Composition, out = new Set<string>(), seen = new Set<string>()): Set<string> {
  if (seen.has(comp.id)) return out;
  seen.add(comp.id);
  for (const l of comp.layers) {
    const fid = l.source?.footageId;
    if (l.type === 'video' && fid && project.footage[fid]?.hasVideo) out.add(fid);
    const nested = l.source?.compId ? project.comps[l.source.compId] : undefined;
    if (nested) videoFootageIn(project, nested, out, seen);
  }
  return out;
}

const PATH_LABEL: Record<VideoDecodeStats['path'], string> = { pending: 'Opening', webcodecs: 'WebCodecs', fallback: '<video> fallback', failed: 'Undecodable' };
const PATH_RANK: Record<VideoDecodeStats['path'], number> = { webcodecs: 0, pending: 1, fallback: 2, failed: 3 };

/** Worst decode path among the comp's videos, with the average decode time of the busiest stream. */
function decodeSummary(project: Project, comp: Composition, stats: Record<string, VideoDecodeStats>): { path: VideoDecodeStats['path']; label: string; tooltip: string } | null {
  const ids = [...videoFootageIn(project, comp)];
  if (!ids.length) return null;
  let worst: VideoDecodeStats['path'] = 'webcodecs';
  let decoded = 0, ms = 0;
  const lines: string[] = [];
  for (const id of ids) {
    const st = stats[id];
    const name = project.footage[id]?.name ?? id;
    if (!st) {
      lines.push(`${name}: waiting for first decode`);
      if (PATH_RANK.pending > PATH_RANK[worst]) worst = 'pending';
      continue;
    }
    if (PATH_RANK[st.path] > PATH_RANK[worst]) worst = st.path;
    decoded += st.decoded;
    ms += st.decodeMs;
    const avg = st.decoded ? (st.decodeMs / st.decoded).toFixed(1) : '–';
    lines.push(`${name}: ${PATH_LABEL[st.path]}${st.path === 'webcodecs' ? (st.accel === 'software' ? ' (software)' : ' (GPU allowed)') : ''}${st.codec ? ` · ${st.codec}` : ''} · ${avg} ms/frame · ${st.decoded} decoded · ${st.hits} cache hits · ${st.seeks} seeks${st.reason ? `\n   ${st.reason}` : ''}`);
  }
  const avg = decoded ? ms / decoded : 0;
  const label = worst === 'failed' ? 'Video: undecodable' : `${PATH_LABEL[worst]}${decoded ? ` · ${avg.toFixed(1)} ms` : ''}`;
  return { path: worst, label, tooltip: `Video decode path\n${lines.join('\n')}` };
}
