// Workspace presets (dock layout trees).

import type { DockNode, PanelId } from '../../state/uiTypes';

let n = 0;
const id = () => `d${++n}${Math.random().toString(36).slice(2, 6)}`;

const tabs = (panels: PanelId[], active?: PanelId): DockNode => ({ type: 'tabs', id: id(), panels, active: active ?? panels[0] });
const row = (children: DockNode[], sizes: number[]): DockNode => ({ type: 'split', id: id(), dir: 'row', children, sizes });
const col = (children: DockNode[], sizes: number[]): DockNode => ({ type: 'split', id: id(), dir: 'col', children, sizes });

export const WORKSPACES: Record<string, () => DockNode> = {
  Standard: () =>
    col([
      row([
        tabs(['project', 'effectControls', 'flowchart'], 'effectControls'),
        tabs(['viewer']),
        col([tabs(['preview', 'info']), tabs(['effects', 'character', 'align'])], [0.44, 0.56]),
      ], [0.2, 0.6, 0.2]),
      tabs(['timeline', 'renderQueue']),
    ], [0.6, 0.4]),
  Animation: () =>
    col([
      row([
        tabs(['viewer']),
        col([tabs(['effectControls', 'project']), tabs(['preview', 'info'])], [0.62, 0.38]),
      ], [0.74, 0.26]),
      tabs(['timeline', 'renderQueue']),
    ], [0.52, 0.48]),
  Effects: () =>
    col([
      row([
        tabs(['effectControls', 'project']),
        tabs(['viewer']),
        tabs(['effects', 'character', 'align', 'info']),
      ], [0.26, 0.5, 0.24]),
      tabs(['timeline', 'renderQueue', 'preview']),
    ], [0.64, 0.36]),
  Typography: () =>
    col([
      row([
        tabs(['project', 'effects']),
        tabs(['viewer']),
        col([tabs(['character']), tabs(['effectControls', 'align'])], [0.5, 0.5]),
      ], [0.18, 0.58, 0.24]),
      tabs(['timeline']),
    ], [0.6, 0.4]),
  Minimal: () => col([tabs(['viewer']), tabs(['timeline'])], [0.62, 0.38]),
};

export const DEFAULT_WORKSPACE = 'Standard';
