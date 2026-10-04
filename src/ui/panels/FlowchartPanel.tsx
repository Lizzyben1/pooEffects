// Composition Flowchart: a layered node graph of how compositions nest (precomps) and which
// footage they consume. Click a composition to open it; pan by dragging, zoom with the wheel.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Maximize, Minus, Plus, Workflow } from 'lucide-react';
import type { Composition, Footage, LayerType, Project } from '../../core/types';
import { useApp, setApp, openDialog } from '../../state/store';
import * as A from '../../state/actions';
import { getMedia, onMediaChange } from '../../state/media';
import { formatTime } from '../../core/time';
import { LayerTypeIcon } from '../icons';

const COMP_W = 240;
const COMP_H = 96;
const FOOT_W = 214;
const FOOT_H = 62;
const GAP_X = 92;
const GAP_Y = 20;
const PAD = 40;

const TYPE_COLORS: Record<LayerType | 'adjustment', string> = {
  shape: '#ff9b3f', text: '#ffd166', solid: '#b48cff', null: '#8a91a0', image: '#4f9dff', video: '#38c3ff', audio: '#3ddc84',
  precomp: '#ff6b9a', camera: '#e8e8e8', light: '#fff2a8', adjustment: '#7af0d0',
};

interface GNode {
  id: string;
  kind: 'comp' | 'footage';
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
  comp?: Composition;
  footage?: Footage;
  unused?: boolean;
}

interface GEdge {
  from: string;
  to: string;
  count: number;
}

function buildGraph(project: Project): { nodes: GNode[]; edges: GEdge[]; width: number; height: number } {
  const comps = Object.values(project.comps);
  const footage = Object.values(project.footage);
  const edgeMap = new Map<string, GEdge>();
  const parents = new Map<string, string[]>();
  for (const c of comps) {
    for (const l of c.layers) {
      const target = l.source?.compId ?? l.source?.footageId;
      if (!target || (!project.comps[target] && !project.footage[target])) continue;
      const key = `${c.id}>${target}`;
      const e = edgeMap.get(key);
      if (e) e.count++;
      else {
        edgeMap.set(key, { from: c.id, to: target, count: 1 });
        parents.set(target, [...(parents.get(target) ?? []), c.id]);
      }
    }
  }
  // longest-path layering from the root compositions (comps nested nowhere)
  const depth = new Map<string, number>();
  const roots = comps.filter((c) => !parents.has(c.id));
  for (const r of roots.length ? roots : comps) depth.set(r.id, 0);
  for (let pass = 0; pass < comps.length + footage.length + 1; pass++) {
    let changed = false;
    for (const e of edgeMap.values()) {
      const d = (depth.get(e.from) ?? 0) + 1;
      if ((depth.get(e.to) ?? -1) < d) {
        depth.set(e.to, d);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const maxDepth = Math.max(0, ...depth.values());
  const nodes: GNode[] = [];
  for (const c of comps) nodes.push({ id: c.id, kind: 'comp', depth: depth.get(c.id) ?? 0, x: 0, y: 0, w: COMP_W, h: COMP_H, comp: c });
  for (const f of footage) {
    const used = depth.has(f.id);
    nodes.push({ id: f.id, kind: 'footage', depth: used ? depth.get(f.id)! : maxDepth + 1, x: 0, y: 0, w: FOOT_W, h: FOOT_H, footage: f, unused: !used });
  }
  const columns: GNode[][] = [];
  for (const n of nodes) (columns[n.depth] ??= []).push(n);
  // initial order: comps first, alphabetical; then two barycentre sweeps to reduce crossings
  const pos = new Map<string, number>();
  columns.forEach((col) => {
    col.sort((a, b) => (a.kind === b.kind ? (a.comp?.name ?? a.footage?.name ?? '').localeCompare(b.comp?.name ?? b.footage?.name ?? '') : a.kind === 'comp' ? -1 : 1));
    col.forEach((n, i) => pos.set(n.id, i));
  });
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let d = 1; d < columns.length; d++) {
      const col = columns[d];
      if (!col) continue;
      const bary = (n: GNode) => {
        const ps = parents.get(n.id) ?? [];
        return ps.length ? ps.reduce((a, p) => a + (pos.get(p) ?? 0), 0) / ps.length : Number.MAX_SAFE_INTEGER;
      };
      col.sort((a, b) => bary(a) - bary(b));
      col.forEach((n, i) => pos.set(n.id, i));
    }
  }
  let width = 0;
  let height = 0;
  let x = PAD;
  const colHeights = columns.map((col) => (col ? col.reduce((a, n) => a + n.h + GAP_Y, -GAP_Y) : 0));
  const tallest = Math.max(0, ...colHeights);
  columns.forEach((col, d) => {
    if (!col) return;
    const colW = Math.max(...col.map((n) => n.w));
    let y = PAD + (tallest - colHeights[d]) / 2;
    for (const n of col) {
      n.x = x + (colW - n.w) / 2;
      n.y = y;
      y += n.h + GAP_Y;
    }
    x += colW + GAP_X;
    width = Math.max(width, x - GAP_X + PAD);
    height = Math.max(height, y - GAP_Y + PAD);
  });
  return { nodes, edges: [...edgeMap.values()], width: Math.max(width, 200), height: Math.max(height, 120) };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function FlowchartPanel() {
  const project = useApp((s) => s.project);
  const activeCompId = useApp((s) => s.activeCompId);
  const selItems = useApp((s) => s.selItems);
  // re-render when media thumbnails finish decoding
  const [, setMediaTick] = useState(0);
  useEffect(() => onMediaChange(() => setMediaTick((n) => n + 1)), []);
  const graph = useMemo(() => buildGraph(project), [project]);
  const hostRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const fitted = useRef(false);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (!size.w || !size.h) return;
    const k = Math.min(1.25, Math.max(0.15, Math.min(size.w / graph.width, size.h / graph.height)));
    setView({ k, x: (size.w - graph.width * k) / 2, y: (size.h - graph.height * k) / 2 });
  }, [size.w, size.h, graph.width, graph.height]);

  useEffect(() => {
    if (!fitted.current && size.w > 0) {
      fitted.current = true;
      fit();
    }
  }, [fit, size.w]);

  // refit when the graph's structure changes size noticeably
  const graphSig = `${graph.nodes.length}|${graph.edges.length}`;
  const lastSig = useRef(graphSig);
  useEffect(() => {
    if (lastSig.current !== graphSig) {
      lastSig.current = graphSig;
      fit();
    }
  }, [graphSig, fit]);

  // the active composition's subtree gets animated edges
  const activeSet = useMemo(() => {
    const set = new Set<string>();
    if (!activeCompId) return set;
    const stack = [activeCompId];
    while (stack.length) {
      const id = stack.pop()!;
      if (set.has(id)) continue;
      set.add(id);
      for (const e of graph.edges) if (e.from === id) stack.push(e.to);
    }
    return set;
  }, [graph, activeCompId]);

  const zoomAt = (factor: number, cx: number, cy: number) => {
    setView((v) => {
      const k = Math.min(3, Math.max(0.1, v.k * factor));
      const f = k / v.k;
      return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    });
  };

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      else setView((v) => ({ ...v, x: v.x - e.deltaX }));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const onBgPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    const sx = e.clientX, sy = e.clientY;
    const v0 = view;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setView({ ...v0, x: v0.x + ev.clientX - sx, y: v0.y + ev.clientY - sy });
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const comps = Object.keys(project.comps).length;

  if (!comps && !Object.keys(project.footage).length) {
    return (
      <div className="empty">
        <div>
          <Workflow size={28} style={{ color: 'var(--text-4)' }} />
          <div className="big" style={{ marginTop: 8 }}>Nothing to chart yet</div>
          Create a composition or import footage to see how your project fits together.
        </div>
      </div>
    );
  }

  return (
    <div className="flow" ref={hostRef} onPointerDown={onBgPointerDown} onDoubleClick={(e) => e.target === e.currentTarget && fit()}>
      <svg className="flow-svg" width={size.w} height={size.h}>
        <defs>
          <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="currentColor" />
          </marker>
          <linearGradient id="flow-comp-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#ff9b3f" stopOpacity="0.95" />
            <stop offset="1" stopColor="#ff6b9a" stopOpacity="0.95" />
          </linearGradient>
          <linearGradient id="flow-foot-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#4f9dff" stopOpacity="0.95" />
            <stop offset="1" stopColor="#38c3ff" stopOpacity="0.95" />
          </linearGradient>
          <pattern id="flow-dots" width={24} height={24} patternUnits="userSpaceOnUse" patternTransform={`translate(${view.x % (24 * view.k)} ${view.y % (24 * view.k)}) scale(${view.k})`}>
            <circle cx="1" cy="1" r="1" fill="rgba(255,255,255,0.06)" />
          </pattern>
          <clipPath id="flow-thumb-clip">
            <rect x="0" y="0" width="62" height="42" rx="5" />
          </clipPath>
        </defs>
        <rect width={size.w} height={size.h} fill="url(#flow-dots)" pointerEvents="none" />
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {graph.edges.map((e) => {
            const a = byId.get(e.from);
            const b = byId.get(e.to);
            if (!a || !b) return null;
            const x1 = a.x + a.w, y1 = a.y + a.h / 2;
            const x2 = b.x - 4, y2 = b.y + b.h / 2;
            const dx = Math.max(40, (x2 - x1) * 0.5);
            const d = `M${x1} ${y1}C${x1 + dx} ${y1},${x2 - dx} ${y2},${x2} ${y2}`;
            const live = activeSet.has(e.from);
            const hot = hover === e.from || hover === e.to;
            const isComp = b.kind === 'comp';
            return (
              <g key={`${e.from}>${e.to}`} className={`flow-edge${live ? ' live' : ''}${hot ? ' hot' : ''}`} style={{ color: isComp ? '#ff7f73' : '#45b0ff' }}>
                <path d={d} className="flow-edge-under" />
                <path d={d} className="flow-edge-line" stroke={`url(#${isComp ? 'flow-comp-grad' : 'flow-foot-grad'})`} markerEnd="url(#flow-arrow)" />
                {e.count > 1 && (
                  <g transform={`translate(${(x1 + x2) / 2} ${(y1 + y2) / 2})`}>
                    <rect x={-13} y={-9} width={26} height={18} rx={9} className="flow-count-bg" />
                    <text className="flow-count" textAnchor="middle" dy="4">×{e.count}</text>
                  </g>
                )}
              </g>
            );
          })}
          {graph.nodes.map((n) =>
            n.kind === 'comp' ? (
              <CompNode
                key={n.id}
                n={n}
                active={n.id === activeCompId}
                inTree={activeSet.has(n.id)}
                onHover={setHover}
              />
            ) : (
              <FootageNode key={n.id} n={n} selected={selItems.includes(n.id)} inTree={activeSet.has(n.id)} onHover={setHover} />
            ),
          )}
        </g>
      </svg>
      <div className="flow-legend" title="Click a comp to open it · double-click for settings · drag to pan · wheel to zoom" onPointerDown={(e) => e.stopPropagation()}>
        <span><i style={{ background: 'linear-gradient(90deg,#ff9b3f,#ff6b9a)' }} />Precomp</span>
        <span><i style={{ background: 'linear-gradient(90deg,#4f9dff,#38c3ff)' }} />Footage</span>
      </div>
      <div className="flow-zoom" onPointerDown={(e) => e.stopPropagation()}>
        <button className="icon-btn sm" title="Zoom out" onClick={() => zoomAt(1 / 1.2, size.w / 2, size.h / 2)}><Minus size={12} /></button>
        <span className="mono">{Math.round(view.k * 100)}%</span>
        <button className="icon-btn sm" title="Zoom in" onClick={() => zoomAt(1.2, size.w / 2, size.h / 2)}><Plus size={12} /></button>
        <button className="icon-btn sm" title="Fit (double-click background)" onClick={fit}><Maximize size={12} /></button>
      </div>
    </div>
  );
}

function CompNode({ n, active, inTree, onHover }: { n: GNode; active: boolean; inTree: boolean; onHover: (id: string | null) => void }) {
  const c = n.comp!;
  const counts = new Map<string, number>();
  for (const l of c.layers) {
    const t = l.adjustment ? 'adjustment' : l.type;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const total = c.layers.length || 1;
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  let acc = 0;
  const barW = n.w - 28;
  const threeD = c.layers.some((l) => l.threeD || l.type === 'camera');
  return (
    <g
      className={`flow-node comp${active ? ' active' : ''}${inTree ? ' in-tree' : ''}`}
      transform={`translate(${n.x} ${n.y})`}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerEnter={() => onHover(n.id)}
      onPointerLeave={() => onHover(null)}
      onClick={() => {
        A.openComp(c.id);
        setApp({ selItems: [c.id] });
      }}
      onDoubleClick={() => openDialog({ kind: 'compSettings', compId: c.id })}
    >
      <title>{`${c.name}\n${c.width}×${c.height} · ${c.frameRate} fps · ${c.layers.length} layers\n${entries.map(([t, k]) => `${k} ${t}`).join(', ')}\nClick to open · double-click for settings`}</title>
      <rect className="flow-card" width={n.w} height={n.h} rx={10} />
      <rect className="flow-accent" x={0} y={10} width={3} height={n.h - 20} rx={1.5} />
      <g transform="translate(14 13)" className="flow-icon">
        <LayerTypeIcon type="precomp" size={15} />
      </g>
      <text className="flow-title" x={36} y={25}>{truncate(c.name, 24)}</text>
      {threeD && <text className="flow-badge" x={n.w - 14} y={25} textAnchor="end">3D</text>}
      <text className="flow-meta" x={14} y={47}>
        {c.width}×{c.height} · {c.frameRate} fps · {formatTime(c.duration, c.frameRate, c.dropFrame)}
      </text>
      <g transform={`translate(14 ${n.h - 30})`}>
        <rect width={barW} height={6} rx={3} className="flow-bar-bg" />
        {c.layers.length > 0 &&
          entries.map(([t, k]) => {
            const w = (k / total) * barW;
            const x = acc;
            acc += w;
            return <rect key={t} x={x} width={Math.max(0, w - 1)} height={6} rx={2} fill={TYPE_COLORS[t as LayerType] ?? '#888'} />;
          })}
        <text className="flow-meta small" y={20}>
          {c.layers.length} layer{c.layers.length === 1 ? '' : 's'}
          {entries.slice(0, 3).map(([t, k]) => ` · ${k} ${t}`).join('')}
        </text>
      </g>
    </g>
  );
}

function FootageNode({ n, selected, inTree, onHover }: { n: GNode; selected: boolean; inTree: boolean; onHover: (id: string | null) => void }) {
  const f = n.footage!;
  const thumb = getMedia(f.id)?.thumb;
  const kindLabel = f.kind === 'image' ? 'Still' : f.kind === 'video' ? 'Video' : 'Audio';
  const meta = f.kind === 'audio' ? `${kindLabel} · ${f.duration.toFixed(1)}s` : f.kind === 'video' ? `${f.width}×${f.height} · ${f.duration.toFixed(1)}s` : `${f.width}×${f.height}`;
  return (
    <g
      className={`flow-node footage${selected ? ' selected' : ''}${inTree ? ' in-tree' : ''}${n.unused ? ' unused' : ''}`}
      transform={`translate(${n.x} ${n.y})`}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerEnter={() => onHover(n.id)}
      onPointerLeave={() => onHover(null)}
      onClick={() => setApp({ selItems: [f.id] })}
      onDoubleClick={() => openDialog({ kind: 'interpret', footageId: f.id })}
    >
      <title>{`${f.name}\n${meta}${n.unused ? '\nNot used in any composition' : ''}\nDouble-click to interpret`}</title>
      <rect className="flow-card" width={n.w} height={n.h} rx={10} />
      <g transform="translate(10 10)">
        <rect width={62} height={42} rx={5} className="flow-thumb-bg" />
        {thumb ? (
          <image href={thumb} width={62} height={42} preserveAspectRatio="xMidYMid slice" clipPath="url(#flow-thumb-clip)" />
        ) : (
          <g transform="translate(23 13)" className="flow-icon">
            <LayerTypeIcon type={f.kind} size={16} />
          </g>
        )}
      </g>
      <text className="flow-title" x={82} y={27}>{truncate(f.name, 17)}</text>
      <text className="flow-meta" x={82} y={45}>{n.unused ? 'Unused · ' : ''}{meta}</text>
    </g>
  );
}
