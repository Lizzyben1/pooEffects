import { useRef, useState } from 'react';
import {
  MousePointer2, Hand, ZoomIn, RotateCw, Orbit, Move, MoveDiagonal, Crosshair, Square, SquareRoundCorner, Circle, Hexagon, Star, PenTool,
  Type, Undo2, Redo2, Download, Activity, Brush,
} from 'lucide-react';
import { MENUS } from '../menus/menus';
import { MenuList } from '../controls/Menu';
import { Popover } from '../controls/Popover';
import { Logo } from '../icons';
import { getApp, openContextMenu, setApp, useApp } from '../../state/store';
import { useTimeState } from '../../state/time';
import { commands as C, isMac, setTool, setWorkspace } from '../commands';
import { WORKSPACES } from '../dock/workspaces';
import { SHORTCUTS, formatCombo } from './keymap';
import type { CameraToolKind, ShapeToolKind, ToolId } from '../../state/uiTypes';

export function TopBar() {
  return (
    <header className="topbar">
      <div className="brand" title="pooEffects">
        <Logo size={24} />
        <span className="brand-name">poo<b>Effects</b></span>
      </div>
      <MenuBar />
      <Toolbar />
      <div className="topbar-right">
        <RenderMeter />
        <WorkspaceTabs />
        <button className="btn sm primary export-btn" onClick={C.export} title="Export the active composition (Ctrl+Shift+E)">
          <Download size={12} /> Export
        </button>
      </div>
    </header>
  );
}

// ── menubar ─────────────────────────────────────────────────────────────────

function MenuBar() {
  const [open, setOpen] = useState<{ idx: number; rect: DOMRect } | null>(null);
  const closedAt = useRef<{ idx: number; t: number } | null>(null);
  const close = () => {
    if (open) closedAt.current = { idx: open.idx, t: performance.now() };
    setOpen(null);
  };
  return (
    <nav className="menus">
      {MENUS.map((m, i) => (
        <button
          key={m.label}
          className={`menu-btn${open?.idx === i ? ' open' : ''}`}
          onClick={(e) => {
            const c = closedAt.current;
            // the outside-click handler closed this same menu a moment ago: treat the click as "close"
            if (c && c.idx === i && performance.now() - c.t < 250) return;
            setOpen(open?.idx === i ? null : { idx: i, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() });
          }}
          onPointerEnter={(e) => {
            if (open && open.idx !== i) setOpen({ idx: i, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() });
          }}
        >
          {m.label}
        </button>
      ))}
      {open && (
        <Popover key={open.idx} x={open.rect.left} y={open.rect.bottom + 4} onClose={close} anchorRect={open.rect}>
          <MenuList items={MENUS[open.idx].items()} onClose={() => setOpen(null)} />
        </Popover>
      )}
    </nav>
  );
}

// ── tools ───────────────────────────────────────────────────────────────────

const SHAPE_ICONS: Record<ShapeToolKind, typeof Square> = { rect: Square, roundedRect: SquareRoundCorner, ellipse: Circle, polygon: Hexagon, star: Star };
const SHAPE_NAMES: Record<ShapeToolKind, string> = { rect: 'Rectangle', roundedRect: 'Rounded Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star' };
const CAMERA_ICONS: Record<CameraToolKind, typeof Square> = { orbit: Orbit, trackXY: Move, trackZ: MoveDiagonal };
const CAMERA_NAMES: Record<CameraToolKind, string> = { orbit: 'Orbit Camera', trackXY: 'Track XY Camera', trackZ: 'Track Z Camera' };

function shortcutFor(label: string): string {
  const s = SHORTCUTS.find((x) => x.label.startsWith(label));
  return s ? formatCombo(s.keys[0]).join(isMac ? '' : '+') : '';
}

function Toolbar() {
  const tool = useApp((s) => s.tool);
  const shapeTool = useApp((s) => s.shapeTool);
  const cameraTool = useApp((s) => s.cameraTool);
  const canUndo = useApp((s) => s.past.length > 0);
  const canRedo = useApp((s) => s.future.length > 0);
  const ShapeIcon = SHAPE_ICONS[shapeTool];
  const CamIcon = CAMERA_ICONS[cameraTool];
  const btn = (id: ToolId, Icon: typeof Square, title: string, sub = false) => (
    <button
      key={id}
      className={`tool${tool === id ? ' active' : ''}`}
      title={`${title} (${shortcutFor(title.split(' (')[0])})`}
      onClick={() => setTool(id)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (id === 'shape') {
          openContextMenu(e.clientX, e.clientY, (Object.keys(SHAPE_NAMES) as ShapeToolKind[]).map((k) => ({
            label: SHAPE_NAMES[k], checked: getApp().shapeTool === k, action: () => setApp({ tool: 'shape', shapeTool: k }),
          })));
        } else if (id === 'camera') {
          openContextMenu(e.clientX, e.clientY, (Object.keys(CAMERA_NAMES) as CameraToolKind[]).map((k) => ({
            label: CAMERA_NAMES[k], checked: getApp().cameraTool === k, action: () => setApp({ tool: 'camera', cameraTool: k }),
          })));
        }
      }}
    >
      <Icon size={15} strokeWidth={1.8} />
      {sub && <span className="sub" />}
    </button>
  );
  return (
    <div className="toolbar">
      <button className="tool" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={C.undo}><Undo2 size={15} strokeWidth={1.8} /></button>
      <button className="tool" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={C.redo}><Redo2 size={15} strokeWidth={1.8} /></button>
      <span className="tool-sep" />
      {btn('select', MousePointer2, 'Selection Tool')}
      {btn('hand', Hand, 'Hand Tool')}
      {btn('zoom', ZoomIn, 'Zoom Tool')}
      <span className="tool-sep" />
      {btn('rotate', RotateCw, 'Rotation Tool')}
      {btn('camera', CamIcon, `Camera Tools (${CAMERA_NAMES[cameraTool]}; right-click for more)`, true)}
      {btn('panBehind', Crosshair, 'Pan Behind (Anchor Point) Tool')}
      <span className="tool-sep" />
      {btn('shape', ShapeIcon, `Shape Tools (${SHAPE_NAMES[shapeTool]}; right-click for more)`, true)}
      {btn('pen', PenTool, 'Pen Tool')}
      {btn('text', Type, 'Type Tool')}
      <span className="tool-sep" />
      {btn('roto', Brush, 'Roto Brush Tool — SAM 2 (Alt+W)')}
    </div>
  );
}

// ── render meter & workspaces ───────────────────────────────────────────────

function RenderMeter() {
  const stats = useApp((s) => s.renderStats);
  const playing = useTimeState((s) => s.playing);
  const fps = useTimeState((s) => s.playFps);
  const realtime = useTimeState((s) => s.realtime);
  const hot = stats.ms > 60;
  return (
    <div className={`render-meter${playing ? ' playing' : ''}${hot ? ' hot' : ''}`} title="Last GPU frame time · playback rate">
      <Activity size={12} />
      {playing ? (
        <span className="mono">{fps.toFixed(1)} fps{realtime ? ' · RAM' : ''}</span>
      ) : (
        <span className="mono">{stats.ms ? `${stats.ms.toFixed(1)} ms` : '— ms'}</span>
      )}
      <span className="rm-layers mono">{stats.layers}L</span>
    </div>
  );
}

function WorkspaceTabs() {
  const ws = useApp((s) => s.workspace);
  return (
    <>
      <div className="ws-tabs" role="tablist" aria-label="Workspace">
        {Object.keys(WORKSPACES).map((w) => (
          <button key={w} role="tab" aria-selected={ws === w} className={`ws-tab${ws === w ? ' on' : ''}`} onClick={() => setWorkspace(w)}>
            {w}
          </button>
        ))}
      </div>
      <select className="workspace-select" aria-label="Workspace" value={ws} onChange={(e) => setWorkspace(e.target.value)}>
        {Object.keys(WORKSPACES).map((w) => <option key={w} value={w}>{w}</option>)}
      </select>
    </>
  );
}
