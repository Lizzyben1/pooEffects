// Window-level overlays: toasts, the boot splash, and the global file-drop target.

import { useEffect, useState } from 'react';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { CircleAlert, CircleCheck, Info, TriangleAlert, Upload, FileVideo, FileImage, FileAudio, Type } from 'lucide-react';
import { useApp } from '../../state/store';
import { Logo } from '../icons';
import { importFiles } from '../commands';

// ── toasts ──────────────────────────────────────────────────────────────────

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'success' ? <CircleCheck size={14} /> : t.kind === 'warn' ? <TriangleAlert size={14} /> : t.kind === 'error' ? <CircleAlert size={14} /> : <Info size={14} />}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

// ── splash ──────────────────────────────────────────────────────────────────

export const bootStore = createStore<{ step: string; progress: number }>(() => ({ step: 'Starting…', progress: 0.05 }));

export function setBoot(step: string, progress: number): void {
  bootStore.setState({ step, progress });
}

export function Splash() {
  const booted = useApp((s) => s.booted);
  const enabled = useApp((s) => s.prefs.showSplash);
  const { step, progress } = useStore(bootStore);
  const [minDone, setMinDone] = useState(!enabled);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => setMinDone(true), 1500);
    return () => clearTimeout(t);
  }, [enabled]);
  const leaving = booted && minDone;
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setGone(true), 750);
    return () => clearTimeout(t);
  }, [leaving]);
  if (gone) return null;
  return (
    <div className={`splash${leaving ? ' leaving' : ''}${enabled ? '' : ' minimal'}`} aria-hidden={leaving}>
      <div className="splash-bg">
        <span className="orb o1" />
        <span className="orb o2" />
        <span className="orb o3" />
        <div className="splash-grid" />
      </div>
      <div className="splash-center">
        <div className="splash-logo">
          <Logo size={112} animated />
          <span className="splash-ring" />
        </div>
        <div className="splash-name">poo<b>Effects</b></div>
        <div className="splash-tag">Motion graphics · VFX · Compositing — in the browser</div>
        <div className="splash-bar"><i style={{ width: `${Math.round(Math.min(1, progress) * 100)}%` }} /></div>
        <div className="splash-step mono">{step}</div>
      </div>
      <div className="splash-foot mono">WebGL2 · Web Workers · WebCodecs · Web Audio</div>
    </div>
  );
}

// ── global file drop ────────────────────────────────────────────────────────

export function DropOverlay() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setActive(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setActive(false);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const drop = (e: DragEvent) => {
      depth = 0;
      setActive(false);
      if (!hasFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      // dropping onto the viewer or timeline also adds the footage to the active composition
      const target = e.target as HTMLElement | null;
      const toComp = !!target?.closest?.('[data-panel="viewer"], [data-panel="timeline"]');
      void importFiles(files, toComp);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);
  if (!active) return null;
  return (
    <div className="file-drop">
      <div className="file-drop-card">
        <div className="file-drop-icons">
          <FileVideo size={22} />
          <FileImage size={22} />
          <Upload size={30} />
          <FileAudio size={22} />
          <Type size={22} />
        </div>
        <div className="file-drop-title">Drop to import</div>
        <div className="file-drop-sub">Video · images · audio · fonts · .pooe projects — drop on the viewer or timeline to add to the comp</div>
      </div>
    </div>
  );
}
