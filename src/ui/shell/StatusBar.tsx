import { useEffect, useState } from 'react';
import { Cpu, HardDrive, MemoryStick, MousePointerClick } from 'lucide-react';
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
