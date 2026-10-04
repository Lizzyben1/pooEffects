// Panel registry: every dockable panel's title, tab icon and body component.

import type { ComponentType, ReactNode } from 'react';
import { AlignCenterHorizontal, ChartGantt, FolderOpen, Info, ListVideo, MonitorPlay, SlidersHorizontal, Sparkles, Type, Gauge, Workflow, Crosshair } from 'lucide-react';
import type { PanelId } from '../../state/uiTypes';
import { ProjectPanel } from './ProjectPanel';
import { ViewerPanel } from '../viewer/ViewerPanel';
import { TimelinePanel } from '../timeline/TimelinePanel';
import { EffectControlsPanel } from './EffectControlsPanel';
import { EffectsPanel } from './EffectsPanel';
import { AlignPanel, CharacterPanel, InfoPanel, PreviewPanel } from './SmallPanels';
import { RenderQueuePanel } from './RenderQueuePanel';
import { FlowchartPanel } from './FlowchartPanel';
import { TrackerPanel } from './TrackerPanel';

export interface PanelDef {
  title: string;
  icon: ReactNode;
  component: ComponentType;
  /** optional extra controls rendered in the tab strip */
  tools?: ComponentType;
}

const I = 12;

export const PANELS: Record<PanelId, PanelDef> = {
  project: { title: 'Project', icon: <FolderOpen size={I} />, component: ProjectPanel },
  viewer: { title: 'Composition', icon: <MonitorPlay size={I} />, component: ViewerPanel },
  timeline: { title: 'Timeline', icon: <ChartGantt size={I} />, component: TimelinePanel },
  effectControls: { title: 'Effect Controls', icon: <SlidersHorizontal size={I} />, component: EffectControlsPanel },
  effects: { title: 'Effects & Presets', icon: <Sparkles size={I} />, component: EffectsPanel },
  preview: { title: 'Preview', icon: <Gauge size={I} />, component: PreviewPanel },
  info: { title: 'Info', icon: <Info size={I} />, component: InfoPanel },
  character: { title: 'Character', icon: <Type size={I} />, component: CharacterPanel },
  align: { title: 'Align', icon: <AlignCenterHorizontal size={I} />, component: AlignPanel },
  renderQueue: { title: 'Render Queue', icon: <ListVideo size={I} />, component: RenderQueuePanel },
  flowchart: { title: 'Flowchart', icon: <Workflow size={I} />, component: FlowchartPanel },
  tracker: { title: 'Tracker', icon: <Crosshair size={I} />, component: TrackerPanel },
};
