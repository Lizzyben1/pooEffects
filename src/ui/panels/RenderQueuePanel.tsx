import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Play, Square, Plus, Trash2, Download, RotateCcw, Copy, X, Film, ChevronUp, ChevronDown, CircleCheck, CircleAlert, Clapperboard,
  LoaderCircle, Ban, Clock, Eye,
} from 'lucide-react';
import type { RenderQueueItem } from '../../state/uiTypes';
import type { ExportFormat } from '../../render/protocol';
import { getApp, useApp } from '../../state/store';
import {
  FORMAT_INFO, FORMAT_ORDER, GIF_FPS_OPTIONS, SCALE_OPTIONS, canEncodeVideo, clearFinished, duplicateQueueItem, formatBytes, formatDuration,
  getAutoDownload, getChime, itemDimensions, itemRange, moveQueueItem, removeQueueItem, requeueItem, setAutoDownload, setChime,
  startRenderQueue, stopRenderQueue, updateItem,
} from '../../state/renderQueue';
import { compHasAudio } from '../../audio/engine';
import { addToRenderQueue } from '../commands';
import { formatTime } from '../../core/time';
import { MotionBlurIcon } from '../icons';

const STATUS_LABEL: Record<RenderQueueItem['status'], string> = {
  queued: 'Queued', rendering: 'Rendering', done: 'Done', error: 'Failed', cancelled: 'Stopped',
};

function StatusIcon({ status }: { status: RenderQueueItem['status'] }) {
  switch (status) {
    case 'queued':
      return <Clock size={12} />;
    case 'rendering':
      return <LoaderCircle size={12} className="spin" />;
    case 'done':
      return <CircleCheck size={12} />;
    case 'error':
      return <CircleAlert size={12} />;
    default:
      return <Ban size={12} />;
  }
}

/** Re-render once a second while something renders so elapsed / ETA stay live. */
function useTicker(active: boolean): void {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}

export function RenderQueuePanel() {
  const queue = useApp((s) => s.renderQueue);
  const hasComp = useApp((s) => !!s.activeCompId);
  const [auto, setAuto] = useState(getAutoDownload());
  const [chime, setCh] = useState(getChime());
  const [viewing, setViewing] = useState<RenderQueueItem | null>(null);
  const rendering = queue.some((i) => i.status === 'rendering');
  const queued = queue.filter((i) => i.status === 'queued').length;
  const finished = queue.some((i) => i.status !== 'queued' && i.status !== 'rendering');
  const video = canEncodeVideo();
  useTicker(rendering);
  return (
    <div className="rq">
      <div className="panel-toolbar rq-toolbar">
        {rendering ? (
          <button className="btn sm danger" onClick={stopRenderQueue} title="Stop rendering">
            <Square size={11} fill="currentColor" /> Stop
          </button>
        ) : (
          <button className="btn sm primary" onClick={() => void startRenderQueue()} disabled={!queued} title="Render all queued items">
            <Play size={11} fill="currentColor" /> Render{queued ? ` (${queued})` : ''}
          </button>
        )}
        <button className="btn sm ghost" onClick={() => addToRenderQueue()} disabled={!hasComp} title="Add the active composition (Ctrl+M)">
          <Plus size={12} /> Add Active Comp
        </button>
        <button className="btn sm ghost" onClick={clearFinished} disabled={!finished}>
          <Trash2 size={12} /> Clear Finished
        </button>
        <div className="grow" />
        <label className="chk-label" title="Download each file as soon as it finishes">
          <input type="checkbox" checked={auto} onChange={(e) => { setAutoDownload(e.target.checked); setAuto(e.target.checked); }} /> Auto-download
        </label>
        <label className="chk-label" title="Play a chime when the queue finishes">
          <input type="checkbox" checked={chime} onChange={(e) => { setChime(e.target.checked); setCh(e.target.checked); }} /> Chime
        </label>
        <span className={`rq-caps${video ? ' ok' : ''}`} title={video ? 'Hardware video encoders are available through WebCodecs' : 'WebCodecs VideoEncoder is unavailable in this browser'}>
          <span className="dot" />
          {video ? 'WebCodecs' : 'GIF / PNG only'}
        </span>
      </div>
      <div className="scroll rq-list">
        {!queue.length && (
          <div className="empty rq-empty">
            <div>
              <Clapperboard size={30} style={{ color: 'var(--text-4)' }} />
              <div className="big" style={{ marginTop: 10 }}>The Render Queue is empty</div>
              Press <kbd>Ctrl</kbd>+<kbd>M</kbd> or use <b>Add Active Comp</b> to queue a composition.
              <div className="rq-formats">
                {FORMAT_ORDER.map((f) => (
                  <span key={f} className={`rq-format-chip${FORMAT_INFO[f].video && !video ? ' off' : ''}`} title={FORMAT_INFO[f].desc}>{FORMAT_INFO[f].label}</span>
                ))}
              </div>
            </div>
          </div>
        )}
        {queue.map((it, i) => (
          <QueueRow key={it.id} item={it} index={i} count={queue.length} onView={() => setViewing(it)} />
        ))}
      </div>
      {viewing && <OutputViewer item={queue.find((q) => q.id === viewing.id) ?? viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function QueueRow({ item, index, count, onView }: { item: RenderQueueItem; index: number; count: number; onView: () => void }) {
  const comps = useApp((s) => s.project.comps);
  const project = useApp((s) => s.project);
  const comp = comps[item.compId];
  const info = FORMAT_INFO[item.format];
  const locked = item.status === 'rendering';
  const editable = item.status === 'queued';
  const range = itemRange(item);
  const dims = itemDimensions(item);
  const video = canEncodeVideo();
  const hasAudio = comp ? compHasAudio(project, comp) : false;
  const set = (p: Partial<RenderQueueItem>) => updateItem(item.id, p);
  const elapsed = item.startedAt ? ((item.finishedAt ?? Date.now()) - item.startedAt) / 1000 : 0;
  const remaining = item.status === 'rendering' && item.fps > 0 && item.total ? (item.total - (item.frame ?? 0)) / item.fps : NaN;
  const pct = Math.round(item.progress * 100);
  const viewable = item.status === 'done' && !!item.outputUrl && item.format !== 'png';
  return (
    <div className={`rq-item ${item.status}`}>
      <div className={`rq-thumb${viewable ? ' viewable' : ''}`} onClick={viewable ? onView : undefined} title={viewable ? 'Preview the rendered file' : undefined}>
        {item.preview ? <img src={item.preview} alt="" draggable={false} /> : <Film size={20} />}
        {item.status === 'rendering' && <div className="rq-thumb-pct">{pct}%</div>}
        {viewable && <div className="rq-thumb-play"><Play size={16} fill="currentColor" /></div>}
      </div>
      <div className="rq-main">
        <div className="rq-line">
          <span className="rq-index">{index + 1}</span>
          {editable ? (
            <select className="mini-select rq-comp" value={item.compId} onChange={(e) => set({ compId: e.target.value })}>
              {Object.values(comps).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          ) : (
            <span className="rq-comp-name">{comp?.name ?? 'Missing composition'}</span>
          )}
          <span className={`rq-status ${item.status}`}><StatusIcon status={item.status} />{STATUS_LABEL[item.status]}</span>
          <div className="grow" />
          <button className="icon-btn sm" title="Move up" disabled={index === 0 || locked} onClick={() => moveQueueItem(item.id, -1)}><ChevronUp size={12} /></button>
          <button className="icon-btn sm" title="Move down" disabled={index === count - 1 || locked} onClick={() => moveQueueItem(item.id, 1)}><ChevronDown size={12} /></button>
          {(item.status === 'done' || item.status === 'error' || item.status === 'cancelled') && (
            <button className="icon-btn sm" title="Render again" onClick={() => requeueItem(item.id)}><RotateCcw size={12} /></button>
          )}
          <button className="icon-btn sm" title="Duplicate with the same settings" onClick={() => duplicateQueueItem(item.id)}><Copy size={12} /></button>
          <button className="icon-btn sm" title={locked ? 'Cancel and remove' : 'Remove'} onClick={() => removeQueueItem(item.id)}><X size={13} /></button>
        </div>

        <div className={`rq-settings${editable ? '' : ' readonly'}`}>
          <label className="rq-field">
            <span>Format</span>
            <select className="mini-select" disabled={!editable} value={item.format} onChange={(e) => set({ format: e.target.value as ExportFormat })}>
              {FORMAT_ORDER.map((f) => (
                <option key={f} value={f} disabled={FORMAT_INFO[f].video && !video}>{FORMAT_INFO[f].label}</option>
              ))}
            </select>
          </label>
          <label className="rq-field">
            <span>Size</span>
            <select className="mini-select" disabled={!editable} value={String(item.scale)} onChange={(e) => set({ scale: Number(e.target.value) })}>
              {SCALE_OPTIONS.map((s) => <option key={s} value={String(s)}>{Math.round(s * 100)}%</option>)}
            </select>
            {dims && <em>{dims.w}×{dims.h}</em>}
          </label>
          {info.video && (
            <label className="rq-field">
              <span>Quality</span>
              <select className="mini-select" disabled={!editable} value={item.quality} onChange={(e) => set({ quality: e.target.value as RenderQueueItem['quality'] })}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="very-high">Very High</option>
              </select>
            </label>
          )}
          {item.format === 'gif' && (
            <label className="rq-field">
              <span>Frame Rate</span>
              <select className="mini-select" disabled={!editable} value={item.gifFps} onChange={(e) => set({ gifFps: Number(e.target.value) })}>
                {GIF_FPS_OPTIONS.map((f) => <option key={f} value={f}>{f} fps</option>)}
              </select>
            </label>
          )}
          <label className="rq-field">
            <span>Range</span>
            <select className="mini-select" disabled={!editable} value={item.range} onChange={(e) => set({ range: e.target.value as RenderQueueItem['range'] })}>
              <option value="workArea">Work Area</option>
              <option value="comp">Length of Comp</option>
            </select>
            {range && comp && <em>{formatTime(range.end - range.start, comp.frameRate, comp.dropFrame)} · {range.frames} fr</em>}
          </label>
          <button className={`rq-toggle${item.motionBlur ? ' on' : ''}`} disabled={!editable} onClick={() => set({ motionBlur: !item.motionBlur })} title="Render with the composition's motion blur settings">
            <MotionBlurIcon size={13} /> Motion Blur
          </button>
          {info.video && (
            <button
              className={`rq-toggle${item.includeAudio && hasAudio ? ' on' : ''}`}
              disabled={!editable || !hasAudio}
              onClick={() => set({ includeAudio: !item.includeAudio })}
              title={hasAudio ? 'Mix down and encode the composition audio' : 'This composition has no audio'}
            >
              ♪ Audio
            </button>
          )}
          <label className="rq-field rq-file">
            <span>Output</span>
            <input
              className="input"
              disabled={!editable}
              value={item.filename}
              onChange={(e) => set({ filename: e.target.value.replace(/[\\/:*?"<>|]+/g, '') })}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <em>.{info.ext}</em>
          </label>
        </div>

        <div className="rq-progress-row">
          <div className={`rq-bar ${item.status}`}>
            <div className="rq-bar-fill" style={{ width: `${item.status === 'done' ? 100 : pct}%` }} />
          </div>
          <div className="rq-stats mono">
            {item.status === 'rendering' && (
              <>
                <span>{item.frame ?? 0}/{item.total ?? range?.frames ?? 0}</span>
                <span>{item.fps ? `${item.fps.toFixed(1)} fps` : 'starting…'}</span>
                <span>{formatDuration(elapsed)} elapsed</span>
                <span>{isFinite(remaining) ? `${formatDuration(remaining)} left` : ''}</span>
              </>
            )}
            {item.status === 'queued' && <span>{info.desc}</span>}
            {item.status === 'done' && (
              <>
                <span>{item.outputSize ? formatBytes(item.outputSize) : ''}</span>
                <span>{formatDuration(elapsed)}</span>
                <span>{item.total && elapsed > 0 ? `${(item.total / elapsed).toFixed(1)} fps avg` : ''}</span>
              </>
            )}
            {item.status === 'error' && <span className="rq-error" title={item.error}>{item.error}</span>}
            {item.status === 'cancelled' && <span>Stopped after {item.frame ?? 0} frames</span>}
          </div>
          {item.status === 'done' && item.outputUrl && (
            <div className="rq-actions">
              {viewable && <button className="btn sm ghost" onClick={onView}><Eye size={12} /> Preview</button>}
              <a className="btn sm primary" href={item.outputUrl} download={`${item.filename}.${info.ext}`}><Download size={12} /> Download</a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function OutputViewer({ item, onClose }: { item: RenderQueueItem; onClose: () => void }) {
  const info = FORMAT_INFO[item.format];
  const comp = getApp().project.comps[item.compId];
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  if (!item.outputUrl) return null;
  return createPortal(
    <div className="dialog-backdrop rq-viewer" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rq-viewer-card">
        <div className="rq-viewer-head">
          <Film size={14} />
          <span>{item.filename}.{info.ext}</span>
          <span className="rq-viewer-meta">{comp?.name} · {info.label}{item.outputSize ? ` · ${formatBytes(item.outputSize)}` : ''}</span>
          <div className="grow" />
          <a className="btn sm primary" href={item.outputUrl} download={`${item.filename}.${info.ext}`}><Download size={12} /> Download</a>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        <div className={`rq-viewer-stage${info.alpha ? ' checker' : ''}`}>
          {info.video ? <video src={item.outputUrl} controls autoPlay loop playsInline /> : <img src={item.outputUrl} alt={item.filename} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}
