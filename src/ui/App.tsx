import { useEffect } from 'react';
import { TopBar } from './shell/TopBar';
import { StatusBar } from './shell/StatusBar';
import { Dock } from './dock/Dock';
import { DialogsHost } from './shell/Dialogs';
import { ContextMenuHost } from './controls/Menu';
import { DropOverlay, Splash, Toasts } from './shell/Overlays';
import { installKeymap } from './shell/keymap';
import { getApp, useApp } from '../state/store';
import { hexToRgba } from '../math/color';

/** Re-tint the UI from the highlight-color preference (all accent styles derive from these variables). */
function useHighlightColor(): void {
  const hex = useApp((s) => s.prefs.highlightColor);
  useEffect(() => {
    const [r, g, b] = hexToRgba(hex).map((v) => Math.round(v * 255));
    const mix = (t: number, to: number) => [r, g, b].map((c) => Math.round(c + (to - c) * t));
    const root = document.documentElement.style;
    root.setProperty('--accent', `rgb(${r}, ${g}, ${b})`);
    root.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
    root.setProperty('--accent-2', `rgb(${mix(0.35, 255).join(', ')})`);
    root.setProperty('--accent-3', `rgb(${mix(0.18, 0).join(', ')})`);
    root.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.14)`);
    root.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, 0.45)`);
  }, [hex]);
}

export function App() {
  useEffect(() => installKeymap(), []);
  useHighlightColor();
  useEffect(() => {
    // app-like right click everywhere except editable fields
    const ctx = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('input, textarea, [contenteditable="true"]')) e.preventDefault();
    };
    // only nag when nothing would otherwise preserve the work
    const unload = (e: BeforeUnloadEvent) => {
      const s = getApp();
      if (s.dirty && !s.prefs.autoSave) e.preventDefault();
    };
    window.addEventListener('contextmenu', ctx);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('contextmenu', ctx);
      window.removeEventListener('beforeunload', unload);
    };
  }, []);
  return (
    <div className="app">
      <TopBar />
      <Dock />
      <StatusBar />
      <DialogsHost />
      <ContextMenuHost />
      <Toasts />
      <DropOverlay />
      <Splash />
    </div>
  );
}
