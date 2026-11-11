// pooEffects entry point: mount the studio, then boot the engine and restore (or create) a project
// while the splash screen reports progress.

import '@fontsource-variable/inter/wght.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import './styles/app.css';
import './styles/panels.css';
import './styles/shell.css';
import './styles/tracking.css';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { loadDocumentFonts } from './fonts';
import { startEngine } from './state/engine';
import { loadAutosave, startAutosave } from './state/projectIO';
import { restoreFonts, restoreMedia } from './state/media';
import { getApp, loadProject, openDialog, setApp, toast } from './state/store';
import { openComp } from './state/actions';
import { setTime } from './state/time';
import { buildDemoProject, ensureProceduralMedia } from './demo';
import { restoreMattes } from './state/mattes';
import { setBoot } from './ui/shell/Overlays';
import { WELCOME_KEY } from './ui/shell/Dialogs';

createRoot(document.getElementById('root')!).render(<App />);

const timeout = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function boot(): Promise<void> {
  setBoot('Loading typefaces…', 0.12);
  const fonts = loadDocumentFonts();
  setBoot('Starting the GPU renderer…', 0.25);
  const engine = startEngine().catch((e: Error) => console.error('[boot] renderer failed to start', e));
  startAutosave();
  void restoreFonts();

  setBoot('Restoring your last session…', 0.4);
  const saved = await loadAutosave().catch(() => null);
  let restored = false;
  if (saved && Object.keys(saved.project.comps).length) {
    try {
      loadProject(saved.project, saved.fileName);
      // a restored session still has whatever was never written to a file
      setApp({ dirty: saved.dirty ?? true });
      const first = getApp().activeCompId;
      if (first) openComp(first);
      restored = true;
    } catch (e) {
      console.error('[boot] the last session could not be restored', e);
    }
    if (restored) {
      // Media is secondary: whatever cannot be re-linked stays offline, the project itself is kept.
      // (Falling back to the demo here would let the next auto-save overwrite the user's session.)
      setBoot('Re-linking media…', 0.6);
      const steps: [string, () => Promise<unknown>][] = [
        ['media', () => restoreMedia(Object.values(saved.project.footage))],
        ['procedural media', () => ensureProceduralMedia(saved.project)],
        ['roto mattes', () => restoreMattes(saved.project)],
      ];
      for (const [what, run] of steps) await run().catch((e) => console.warn(`[boot] could not restore ${what}`, e));
    }
  }
  if (!restored) {
    setBoot('Building the demo scene…', 0.55);
    const { project, mainCompId, initialTime } = buildDemoProject();
    loadProject(project, null);
    openComp(mainCompId);
    setTime(mainCompId, initialTime);
    setBoot('Synthesising the soundtrack…', 0.7);
    await ensureProceduralMedia(project);
  }

  setBoot('Warming up shaders…', 0.85);
  await Promise.all([fonts, Promise.race([engine, timeout(10000)])]);
  setBoot('Ready', 1);
  setApp({ booted: true });

  let welcomed = false;
  try {
    welcomed = localStorage.getItem(WELCOME_KEY) === '1';
  } catch {
    welcomed = true;
  }
  if (!welcomed) setTimeout(() => !getApp().dialog && openDialog({ kind: 'welcome' }), getApp().prefs.showSplash ? 1300 : 400);
}

void boot().catch((e) => {
  // never leave the splash up: the app is usable even if part of start-up failed
  console.error('[boot] start-up failed', e);
  setApp({ booted: true });
  toast('Part of start-up failed — some media may be offline. See the console for details.', 'error', 7000);
});
