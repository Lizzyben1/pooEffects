// What the user sees in place of a part of the UI that failed to render (see ErrorBoundary).

import { useEffect, useRef } from 'react';
import { TriangleAlert } from 'lucide-react';
import { getApp, undo, useApp } from '../../state/store';
import { clearAutosave, saveProjectFile } from '../../state/projectIO';

const text = (e: Error): string => e.message || String(e);

/** Try again by itself once the document changes (undo, another project): the cause may be gone. */
function useRetryOnProjectChange(retry: () => void): void {
  const project = useApp((s) => s.project);
  const seen = useRef(project);
  useEffect(() => {
    if (project !== seen.current) retry();
  }, [project, retry]);
}

/** A single panel failed: the rest of the app keeps working. */
export function PanelCrash({ title, error, retry }: { title: string; error: Error; retry: () => void }) {
  // most render failures come from the edit that was just made, so undoing it is the real remedy
  const canUndo = getApp().past.length > 0;
  useRetryOnProjectChange(retry);
  return (
    <div className="crash" role="alert">
      <TriangleAlert size={22} />
      <div className="crash-title">The {title} panel ran into a problem</div>
      <div className="crash-msg">{text(error)}</div>
      <div className="crash-actions">
        <button className="btn sm" onClick={retry}>Reload Panel</button>
        {canUndo && (
          <button
            className="btn sm"
            onClick={undo}
          >
            Undo Last Change
          </button>
        )}
      </div>
      <div className="crash-hint">Your project is intact — save it with Ctrl/⌘+S. Reload the page if this keeps happening.</div>
    </div>
  );
}

/** The app shell itself failed. Offers every way back, including out of a session that cannot be shown. */
export function AppCrash({ error, retry }: { error: Error; retry: () => void }) {
  const canUndo = getApp().past.length > 0;
  useRetryOnProjectChange(retry);
  return (
    <div className="crash full" role="alert">
      <TriangleAlert size={30} />
      <div className="crash-title">pooEffects ran into a problem</div>
      <div className="crash-msg">{text(error)}</div>
      <div className="crash-actions">
        <button className="btn primary" onClick={retry}>Try Again</button>
        {canUndo && (
          <button
            className="btn"
            onClick={undo}
          >
            Undo Last Change
          </button>
        )}
        <button className="btn" onClick={() => void saveProjectFile()}>Save Project…</button>
        <button
          className="btn danger"
          title="Forget the automatically saved session and start with the demo project"
          onClick={() => void clearAutosave().then(() => window.location.reload())}
        >
          Start Fresh
        </button>
      </div>
      <div className="crash-hint">Your work is still in memory: save it to a .pooe file before reloading or starting fresh.</div>
    </div>
  );
}
