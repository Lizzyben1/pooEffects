// Docking workspace: resizable splits, tabbed panel groups, drag tabs between groups or onto
// group edges to split, maximize the hovered panel with ` (backtick).

import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Ellipsis, Maximize2, Minimize2, X } from 'lucide-react';
import type { DockNode, PanelId } from '../../state/uiTypes';
import { getApp, setApp, useApp, openContextMenu } from '../../state/store';
import { activatePanel, movePanel, removePanel, setSizes, type DropZone } from './layout';
import { PANELS } from '../panels/registry';
import { WORKSPACES } from './workspaces';

interface DragState {
  panel: PanelId;
  x: number;
  y: number;
  target: { groupId: string; zone: DropZone; rect: DOMRect } | null;
}

let dragSetter: ((d: DragState | null) => void) | null = null;

export function Dock() {
  const layout = useApp((s) => s.layout);
  const maximized = useApp((s) => s.maximized);
  const [drag, setDrag] = useState<DragState | null>(null);
  dragSetter = setDrag;
  return (
    <div className="dock-root">
      <NodeView node={layout} />
      {maximized && (
        <div className="dock-maximized">
          <PanelGroup node={{ type: 'tabs', id: '__max', panels: [maximized], active: maximized }} maximizedView />
        </div>
      )}
      {drag && createPortal(<DragGhost drag={drag} />, document.body)}
    </div>
  );
}

function DragGhost({ drag }: { drag: DragState }) {
  const def = PANELS[drag.panel];
  const t = drag.target;
  let zoneStyle: React.CSSProperties | null = null;
  if (t) {
    const r = t.rect;
    const z = t.zone;
    zoneStyle = {
      left: z === 'right' ? r.left + r.width / 2 : r.left,
      top: z === 'bottom' ? r.top + r.height / 2 : r.top,
      width: z === 'left' || z === 'right' ? r.width / 2 : r.width,
      height: z === 'top' || z === 'bottom' ? r.height / 2 : r.height,
      position: 'fixed',
    };
  }
  return (
    <>
      {zoneStyle && <div className="drop-zone" style={{ ...zoneStyle, zIndex: 2000, pointerEvents: 'none' }} />}
      <div className="drag-ghost" style={{ left: drag.x + 12, top: drag.y + 10 }}>
        {def.icon}
        {def.title}
      </div>
    </>
  );
}

function NodeView({ node }: { node: DockNode }): ReactNode {
  if (node.type === 'tabs') return <PanelGroup node={node} />;
  return <SplitView node={node} />;
}

function SplitView({ node }: { node: Extract<DockNode, { type: 'split' }> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const onDown = (i: number, e: React.PointerEvent) => {
    e.preventDefault();
    const el = ref.current!;
    const rect = el.getBoundingClientRect();
    const total = node.dir === 'row' ? rect.width : rect.height;
    const start = node.dir === 'row' ? e.clientX : e.clientY;
    const sizes0 = [...node.sizes];
    setDragIdx(i);
    const move = (ev: PointerEvent) => {
      const cur = node.dir === 'row' ? ev.clientX : ev.clientY;
      const d = (cur - start) / total;
      const a = sizes0[i] + d, b = sizes0[i + 1] - d;
      const min = 0.05;
      if (a < min || b < min) return;
      const next = [...sizes0];
      next[i] = a;
      next[i + 1] = b;
      setApp((s) => ({ layout: setSizes(s.layout, node.id, next) }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragIdx(null);
      window.dispatchEvent(new Event('resize'));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div ref={ref} className={`dock-split ${node.dir}`}>
      {node.children.map((c, i) => (
        <div key={c.id} style={{ display: 'contents' }}>
          <div className="dock-child" style={{ flex: `${node.sizes[i]} 1 0` }}>
            <NodeView node={c} />
          </div>
          {i < node.children.length - 1 && (
            <div className={`splitter ${node.dir}${dragIdx === i ? ' dragging' : ''}`} onPointerDown={(e) => onDown(i, e)} />
          )}
        </div>
      ))}
    </div>
  );
}

function zoneFor(rect: DOMRect, x: number, y: number): DropZone {
  const fx = (x - rect.left) / rect.width, fy = (y - rect.top) / rect.height;
  if (fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7) return 'center';
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  return (Object.entries(d).sort((a, b) => a[1] - b[1])[0][0] as DropZone);
}

function startTabDrag(panel: PanelId, e: React.PointerEvent) {
  const sx = e.clientX, sy = e.clientY;
  let active = false;
  const move = (ev: PointerEvent) => {
    if (!active && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 7) return;
    active = true;
    let target: DragState['target'] = null;
    const els = document.elementsFromPoint(ev.clientX, ev.clientY);
    const g = els.find((el) => (el as HTMLElement).dataset?.groupId) as HTMLElement | undefined;
    if (g && g.dataset.groupId !== '__max') {
      const rect = g.getBoundingClientRect();
      target = { groupId: g.dataset.groupId!, zone: zoneFor(rect, ev.clientX, ev.clientY), rect };
    }
    dragSetter?.({ panel, x: ev.clientX, y: ev.clientY, target });
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (active) {
      const els = document.elementsFromPoint(ev.clientX, ev.clientY);
      const g = els.find((el) => (el as HTMLElement).dataset?.groupId) as HTMLElement | undefined;
      if (g && g.dataset.groupId !== '__max') {
        const zone = zoneFor(g.getBoundingClientRect(), ev.clientX, ev.clientY);
        setApp((s) => ({ layout: movePanel(s.layout, panel, g.dataset.groupId!, zone) }));
        window.dispatchEvent(new Event('resize'));
      }
    }
    dragSetter?.(null);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

export function closePanel(panel: PanelId) {
  setApp((s) => {
    const next = removePanel(s.layout, panel);
    return next ? { layout: next, maximized: s.maximized === panel ? null : s.maximized } : {};
  });
}

function panelMenu(panel: PanelId, x: number, y: number) {
  const s = getApp();
  openContextMenu(x, y, [
    { label: s.maximized === panel ? 'Restore Panel' : 'Maximize Panel', shortcut: '`', action: () => setApp({ maximized: s.maximized === panel ? null : panel }) },
    { label: 'Close Panel', action: () => closePanel(panel) },
    { separator: true },
    { label: 'Reset Workspace', action: () => setApp({ layout: WORKSPACES[s.workspace]?.() ?? WORKSPACES.Standard(), maximized: null }) },
  ]);
}

function PanelGroup({ node, maximizedView }: { node: Extract<DockNode, { type: 'tabs' }>; maximizedView?: boolean }) {
  const focused = useApp((s) => s.focusedPanel);
  const maximized = useApp((s) => s.maximized);
  const def = PANELS[node.active];
  const Body = def.component;
  const isFocused = focused === node.active;
  return (
    <div
      className={`panel${isFocused ? ' focused' : ''}`}
      data-group-id={node.id}
      data-panel={node.active}
      onPointerDownCapture={() => {
        if (getApp().focusedPanel !== node.active) setApp({ focusedPanel: node.active });
      }}
      onPointerEnter={() => {
        hoveredPanel = node.active;
      }}
    >
      <div className="panel-tabs">
        {node.panels.map((p) => {
          const d = PANELS[p];
          return (
            <button
              key={p}
              className={`panel-tab${p === node.active ? ' active' : ''}`}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                setApp((s) => ({ layout: activatePanel(s.layout, p), focusedPanel: p }));
                if (!maximizedView) startTabDrag(p, e);
              }}
              onDoubleClick={() => setApp({ maximized: maximized === p ? null : p })}
              onContextMenu={(e) => {
                e.preventDefault();
                panelMenu(p, e.clientX, e.clientY);
              }}
            >
              {d.icon}
              {d.title}
              {!maximizedView && (
                <span
                  className="tab-close"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    closePanel(p);
                  }}
                >
                  <X size={10} />
                </span>
              )}
            </button>
          );
        })}
        <div className="spacer" />
        <div className="tab-tools">
          {def.tools && <def.tools />}
          <button className="icon-btn sm" title={maximized ? 'Restore (`)' : 'Maximize (`)'} onClick={() => setApp({ maximized: maximized ? null : node.active })}>
            {maximized ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
          </button>
          <button className="icon-btn sm" title="Panel menu" onClick={(e) => panelMenu(node.active, e.clientX, e.clientY)}>
            <Ellipsis size={12} />
          </button>
        </div>
      </div>
      <div className="panel-body">
        <Body />
      </div>
    </div>
  );
}

export let hoveredPanel: PanelId | null = null;

/** ` (backtick): maximize the panel under the cursor, or restore. */
export function toggleMaximize(): void {
  const s = getApp();
  setApp({ maximized: s.maximized ? null : hoveredPanel ?? s.focusedPanel ?? 'viewer' });
  setTimeout(() => window.dispatchEvent(new Event('resize')), 0);
}
