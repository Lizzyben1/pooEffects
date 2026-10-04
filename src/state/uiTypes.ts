// Non-document UI state types.

import type { ViewSpec } from '../render/renderer';
import type { ExportFormat } from '../render/protocol';

export type PanelId =
  | 'project' | 'viewer' | 'timeline' | 'effectControls' | 'effects' | 'preview' | 'info' | 'character' | 'align' | 'renderQueue' | 'flowchart'
  | 'tracker';

export type DockNode =
  | { type: 'split'; id: string; dir: 'row' | 'col'; children: DockNode[]; sizes: number[] }
  | { type: 'tabs'; id: string; panels: PanelId[]; active: PanelId };

export type ToolId = 'select' | 'hand' | 'zoom' | 'rotate' | 'camera' | 'panBehind' | 'shape' | 'pen' | 'text' | 'roto';
export type ShapeToolKind = 'rect' | 'roundedRect' | 'ellipse' | 'polygon' | 'star';
export type CameraToolKind = 'orbit' | 'trackXY' | 'trackZ';
export type Resolution = 'auto' | 'full' | 'half' | 'third' | 'quarter';

export interface ViewerState {
  /** screen pixels per comp pixel; null = fit */
  zoom: number | null;
  panX: number;
  panY: number;
  resolution: Resolution;
  layout: '1' | '2' | '4';
  views: ViewSpec[];
  activeView: number;
  grid: boolean;
  propGrid: boolean;
  safe: boolean;
  transparency: boolean;
  layerControls: boolean;
  motionBlur: boolean;
  draft3D: boolean;
}

export interface TimelineState {
  /** pixels per second */
  pxPerSec: number;
  /** comp time at the left edge of the track area */
  scrollTime: number;
  graphEditor: boolean;
  graphMode: 'value' | 'speed';
  leftWidth: number;
  showModes: boolean;
}

export type RevealMode =
  | { kind: 'none' }
  | { kind: 'keyframes' }
  | { kind: 'modified' }
  | { kind: 'props'; props: string[] };

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

export interface MenuItem {
  label?: string;
  shortcut?: string;
  action?: () => void;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  submenu?: MenuItem[];
  danger?: boolean;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export type DialogState =
  | { kind: 'newComp' }
  | { kind: 'compSettings'; compId: string }
  | { kind: 'solid'; compId: string; layerId?: string }
  | { kind: 'interpret'; footageId: string }
  | { kind: 'precompose'; compId: string; layerIds: string[] }
  | { kind: 'timeStretch'; compId: string; layerId: string }
  | { kind: 'keyframeVelocity'; compId: string }
  | { kind: 'prefs' }
  | { kind: 'shortcuts' }
  | { kind: 'about' }
  | { kind: 'rename'; title: string; value: string; onSubmit: (v: string) => void }
  | { kind: 'export'; compId: string }
  | { kind: 'welcome' }
  | { kind: 'trackTarget'; compId: string; layerId: string; trackerId: string }
  | { kind: 'samModel' };

export interface RenderQueueItem {
  id: string;
  compId: string;
  format: ExportFormat;
  scale: number;
  quality: 'low' | 'medium' | 'high' | 'very-high';
  range: 'workArea' | 'comp';
  motionBlur: boolean;
  includeAudio: boolean;
  gifFps: number;
  filename: string;
  status: 'queued' | 'rendering' | 'done' | 'error' | 'cancelled';
  progress: number;
  /** frames rendered so far / total frames of the job */
  frame?: number;
  total?: number;
  fps: number;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  outputUrl?: string;
  outputSize?: number;
  preview?: string;
}

export interface Preferences {
  cacheBudgetMB: number;
  backgroundRender: boolean;
  audioScrub: boolean;
  autoSave: boolean;
  showSplash: boolean;
  highlightColor: string;
  timelineLabelBars: boolean;
}
