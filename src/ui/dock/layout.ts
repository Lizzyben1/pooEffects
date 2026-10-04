// Pure dock-tree operations.

import type { DockNode, PanelId } from '../../state/uiTypes';

let n = 0;
const nid = () => `dn${++n}${Math.random().toString(36).slice(2, 6)}`;

export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom';

export function findGroupOf(node: DockNode, panel: PanelId): Extract<DockNode, { type: 'tabs' }> | null {
  if (node.type === 'tabs') return node.panels.includes(panel) ? node : null;
  for (const c of node.children) {
    const r = findGroupOf(c, panel);
    if (r) return r;
  }
  return null;
}

export function hasPanel(node: DockNode, panel: PanelId): boolean {
  return !!findGroupOf(node, panel);
}

function normalize(node: DockNode): DockNode | null {
  if (node.type === 'tabs') {
    if (!node.panels.length) return null;
    return node.panels.includes(node.active) ? node : { ...node, active: node.panels[0] };
  }
  const kids: DockNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const r = normalize(c);
    if (r) {
      // flatten nested splits with the same direction
      if (r.type === 'split' && r.dir === node.dir) {
        const total = r.sizes.reduce((a, b) => a + b, 0) || 1;
        r.children.forEach((cc, j) => {
          kids.push(cc);
          sizes.push((node.sizes[i] ?? 1) * (r.sizes[j] / total));
        });
      } else {
        kids.push(r);
        sizes.push(node.sizes[i] ?? 1);
      }
    }
  });
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...node, children: kids, sizes: sizes.map((s) => s / total) };
}

export function removePanel(node: DockNode, panel: PanelId): DockNode | null {
  const strip = (x: DockNode): DockNode => {
    if (x.type === 'tabs') return { ...x, panels: x.panels.filter((p) => p !== panel) };
    return { ...x, children: x.children.map(strip) };
  };
  return normalize(strip(node));
}

export function insertPanel(node: DockNode, groupId: string, panel: PanelId, zone: DropZone): DockNode {
  const visit = (x: DockNode): DockNode => {
    if (x.type === 'tabs') {
      if (x.id !== groupId) return x;
      if (zone === 'center') return { ...x, panels: [...x.panels.filter((p) => p !== panel), panel], active: panel };
      const fresh: DockNode = { type: 'tabs', id: nid(), panels: [panel], active: panel };
      const dir = zone === 'left' || zone === 'right' ? 'row' : 'col';
      const first = zone === 'left' || zone === 'top';
      return { type: 'split', id: nid(), dir, children: first ? [fresh, x] : [x, fresh], sizes: first ? [0.35, 0.65] : [0.65, 0.35] };
    }
    return { ...x, children: x.children.map(visit) };
  };
  return normalize(visit(node)) ?? node;
}

export function movePanel(node: DockNode, panel: PanelId, groupId: string, zone: DropZone): DockNode {
  const src = findGroupOf(node, panel);
  if (src && src.id === groupId && zone === 'center') return activatePanel(node, panel);
  if (src && src.id === groupId && src.panels.length === 1) return node;
  const removed = removePanel(node, panel);
  if (!removed) return node;
  return insertPanel(removed, groupId, panel, zone);
}

export function activatePanel(node: DockNode, panel: PanelId): DockNode {
  if (node.type === 'tabs') return node.panels.includes(panel) ? { ...node, active: panel } : node;
  return { ...node, children: node.children.map((c) => activatePanel(c, panel)) };
}

export function setSizes(node: DockNode, splitId: string, sizes: number[]): DockNode {
  if (node.type === 'tabs') return node;
  if (node.id === splitId) return { ...node, sizes };
  return { ...node, children: node.children.map((c) => setSizes(c, splitId, sizes)) };
}

/** Add a panel next to a sensible group when it's not in the layout. */
export function ensurePanel(node: DockNode, panel: PanelId): DockNode {
  if (hasPanel(node, panel)) return activatePanel(node, panel);
  const prefer: Record<PanelId, PanelId[]> = {
    project: ['effectControls'], effectControls: ['project'], flowchart: ['project', 'effectControls'], viewer: ['timeline'],
    timeline: ['renderQueue'], renderQueue: ['timeline'], preview: ['info', 'effects'], info: ['preview'],
    effects: ['character', 'align', 'preview'], character: ['effects', 'align'], align: ['effects', 'character'],
    tracker: ['effects', 'preview', 'info'],
  };
  for (const p of prefer[panel] ?? []) {
    const g = findGroupOf(node, p);
    if (g) return insertPanel(node, g.id, panel, 'center');
  }
  const first = (x: DockNode): string => (x.type === 'tabs' ? x.id : first(x.children[0]));
  return insertPanel(node, first(node), panel, 'center');
}
