import { useEffect, useRef, useState } from 'react';
import { ChevronRight, FolderPlus, Plus, Trash, Upload, Search, Folder, FolderOpen } from 'lucide-react';
import type { Composition, Footage, Project } from '../../core/types';
import { getApp, openContextMenu, openDialog, setApp, useApp } from '../../state/store';
import * as A from '../../state/actions';
import { LayerTypeIcon } from '../icons';
import { getMedia, onMediaChange } from '../../state/media';
import { host, renderOptions } from '../../state/engine';
import { commands as C, importFiles, addToRenderQueue } from '../commands';
import { createFootageLayer, createPrecompLayer } from '../../core/factory';
import { formatTime } from '../../core/time';

type Item = { id: string; kind: 'folder' | 'comp' | 'footage'; name: string; folderId: string | null };

function itemsOf(p: Project): Item[] {
  return [
    ...Object.values(p.folders).map((f) => ({ id: f.id, kind: 'folder' as const, name: f.name, folderId: f.folderId })),
    ...Object.values(p.comps).map((c) => ({ id: c.id, kind: 'comp' as const, name: c.name, folderId: c.folderId })),
    ...Object.values(p.footage).map((f) => ({ id: f.id, kind: 'footage' as const, name: f.name, folderId: f.folderId })),
  ];
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function addItemToComp(id: string) {
  const s = getApp();
  const comp = s.activeCompId ? s.project.comps[s.activeCompId] : null;
  if (!comp) return;
  const f = s.project.footage[id];
  if (f) A.addLayer(comp.id, createFootageLayer(comp, f), { index: 0 });
  const c = s.project.comps[id];
  if (c && c.id !== comp.id) A.addLayer(comp.id, createPrecompLayer(comp, c), { index: 0 });
}

function CompThumb({ comp }: { comp: Composition }) {
  const [url, setUrl] = useState<string | null>(null);
  const project = useApp((s) => s.project);
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(async () => {
      const r = await host.render(`thumb:${comp.id}`, 'thumb', { ...renderOptions(comp.id, comp.duration * 0.45, { scale: 0.2, motionBlur: false, draft: true }), guides: false }, comp.bgColor, 320);
      if (!r || cancelled) {
        r?.bitmap.close();
        return;
      }
      const c = document.createElement('canvas');
      c.width = r.bitmap.width;
      c.height = r.bitmap.height;
      c.getContext('2d')!.drawImage(r.bitmap, 0, 0);
      r.bitmap.close();
      setUrl(c.toDataURL('image/jpeg', 0.82));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [comp, project.footage]);
  return url ? <img src={url} alt="" /> : <div className="thumb-ph"><LayerTypeIcon type="precomp" size={22} /></div>;
}

function FootageThumb({ f }: { f: Footage }) {
  const [, force] = useState(0);
  useEffect(() => onMediaChange(() => force((x) => x + 1)), []);
  const m = getMedia(f.id);
  if (m?.thumb) return <img src={m.thumb} alt="" />;
  if (f.kind === 'audio' && m?.peaks) {
    const pts = Array.from(m.peaks.filter((_, i) => i % Math.max(1, Math.floor(m.peaks!.length / 80)) === 0)).slice(0, 80);
    return (
      <svg viewBox={`0 0 ${pts.length} 40`} preserveAspectRatio="none" className="wave-thumb">
        {pts.map((v, i) => <rect key={i} x={i} y={20 - v * 18} width={0.7} height={Math.max(0.5, v * 36)} fill="#4f9dff" />)}
      </svg>
    );
  }
  return <div className="thumb-ph"><LayerTypeIcon type={f.kind} size={22} /></div>;
}

export function ProjectPanel() {
  const project = useApp((s) => s.project);
  const sel = useApp((s) => s.selItems);
  const activeComp = useApp((s) => s.activeCompId);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [dropping, setDropping] = useState(false);
  const items = itemsOf(project);
  const selected = sel[0] ? items.find((i) => i.id === sel[0]) : null;
  const listRef = useRef<HTMLDivElement>(null);

  const children = (parent: string | null) =>
    items.filter((i) => i.folderId === parent && (!q || i.name.toLowerCase().includes(q.toLowerCase()) || i.kind === 'folder'))
      .sort((a, b) => (a.kind === 'folder' ? -1 : 0) - (b.kind === 'folder' ? -1 : 0) || a.name.localeCompare(b.name));

  const select = (id: string, e: React.MouseEvent) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) setApp({ selItems: sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id] });
    else setApp({ selItems: [id] });
  };

  const menu = (it: Item, e: React.MouseEvent) => {
    e.preventDefault();
    if (!sel.includes(it.id)) setApp({ selItems: [it.id] });
    const ids = sel.includes(it.id) ? sel : [it.id];
    openContextMenu(e.clientX, e.clientY, [
      ...(it.kind === 'comp' ? [
        { label: 'Open Composition', action: () => A.openComp(it.id) },
        { label: 'Composition Settings…', action: () => openDialog({ kind: 'compSettings', compId: it.id }) },
        { label: 'Duplicate', action: () => A.duplicateComp(it.id) },
        { label: 'Add to Render Queue', action: () => addToRenderQueue(it.id) },
        { separator: true },
      ] : []),
      ...(it.kind === 'footage' ? [
        { label: 'Interpret Footage…', action: () => openDialog({ kind: 'interpret', footageId: it.id }) },
        { label: 'Add to Active Composition', disabled: !activeComp, action: () => addItemToComp(it.id) },
        { label: 'New Comp from Footage', action: () => {
          const f = project.footage[it.id];
          const id = A.newComp({ name: f.name.replace(/\.[^.]+$/, ''), width: f.width || 1920, height: f.height || 1080, duration: f.duration > 0 ? f.duration : 10, frameRate: f.kind === 'video' ? f.frameRate : 30 });
          const c = getApp().project.comps[id];
          if (c) A.addLayer(id, createFootageLayer(c, f), { index: 0 });
        } },
        { separator: true },
      ] : []),
      { label: 'Rename…', action: () => openDialog({ kind: 'rename', title: 'Rename', value: it.name, onSubmit: (v) => A.renameItem(it.id, v) }) },
      { label: 'Move to Folder', submenu: [
        { label: '(Root)', action: () => A.moveToFolder(ids, null) },
        ...Object.values(project.folders).map((f) => ({ label: f.name, action: () => A.moveToFolder(ids, f.id) })),
      ] },
      { label: 'Delete', danger: true, action: () => A.deleteProjectItems(ids) },
    ]);
  };

  const renderTree = (parent: string | null, depth: number): React.ReactNode =>
    children(parent).map((it) => {
      const isOpen = open[it.id] ?? true;
      const comp = it.kind === 'comp' ? project.comps[it.id] : undefined;
      const f = it.kind === 'footage' ? project.footage[it.id] : undefined;
      return (
        <div key={it.id}>
          <div
            className={`pj-row${sel.includes(it.id) ? ' sel' : ''}${it.id === activeComp ? ' active' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            draggable={it.kind !== 'folder'}
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-poo-item', it.id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onDragOver={(e) => {
              if (it.kind === 'folder' && e.dataTransfer.types.includes('application/x-poo-item')) e.preventDefault();
            }}
            onDrop={(e) => {
              const id = e.dataTransfer.getData('application/x-poo-item');
              if (id && it.kind === 'folder') {
                e.preventDefault();
                A.moveToFolder([id], it.id);
              }
            }}
            onClick={(e) => select(it.id, e)}
            onDoubleClick={() => {
              if (it.kind === 'comp') A.openComp(it.id);
              else if (it.kind === 'footage') addItemToComp(it.id);
              else setOpen({ ...open, [it.id]: !isOpen });
            }}
            onContextMenu={(e) => menu(it, e)}
          >
            {it.kind === 'folder' ? (
              <>
                <span className={`twirl${isOpen ? ' open' : ''}`} onClick={(e) => { e.stopPropagation(); setOpen({ ...open, [it.id]: !isOpen }); }}><ChevronRight size={11} /></span>
                {isOpen ? <FolderOpen size={13} className="pj-ic folder" /> : <Folder size={13} className="pj-ic folder" />}
              </>
            ) : (
              <>
                <span className="twirl-spacer" />
                <span className={`pj-ic ${it.kind === 'comp' ? 'comp' : f?.kind}`}><LayerTypeIcon type={it.kind === 'comp' ? 'precomp' : f!.kind} size={13} /></span>
              </>
            )}
            <span className="pj-name">{it.name}</span>
            <span className="pj-meta mono">
              {comp ? `${comp.width}×${comp.height}` : f ? (f.kind === 'image' ? `${f.width}×${f.height}` : formatTime(f.duration, f.frameRate || 30, false)) : ''}
            </span>
          </div>
          {it.kind === 'folder' && isOpen && renderTree(it.id, depth + 1)}
        </div>
      );
    });

  const selComp = selected?.kind === 'comp' ? project.comps[selected.id] : undefined;
  const selFoot = selected?.kind === 'footage' ? project.footage[selected.id] : undefined;

  return (
    <div
      className={`project${dropping ? ' dropping' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          void importFiles([...e.dataTransfer.files]);
        }
      }}
    >
      <div className="pj-preview">
        <div className="pj-thumb">
          {selComp ? <CompThumb comp={selComp} /> : selFoot ? <FootageThumb f={selFoot} /> : <div className="thumb-ph"><Folder size={22} /></div>}
        </div>
        <div className="pj-info">
          {selComp ? (
            <>
              <div className="pj-title">{selComp.name}</div>
              <div>{selComp.width} × {selComp.height} ({selComp.pixelAspect.toFixed(2)})</div>
              <div>Δ {formatTime(selComp.duration, selComp.frameRate, selComp.dropFrame)}, {selComp.frameRate} fps</div>
              <div>{selComp.layers.length} layers · {selComp.bitDepth} bpc</div>
            </>
          ) : selFoot ? (
            <>
              <div className="pj-title">{selFoot.name}</div>
              {selFoot.kind !== 'audio' && <div>{selFoot.width} × {selFoot.height}</div>}
              {selFoot.duration > 0 && <div>Δ {formatTime(selFoot.duration, selFoot.frameRate || 30, false)}{selFoot.kind === 'video' ? `, ${selFoot.frameRate} fps` : ''}</div>}
              <div>{selFoot.mime || selFoot.kind} · {fmtBytes(selFoot.bytes)}</div>
              <div>{[selFoot.hasVideo && 'Video', selFoot.hasAudio && 'Audio'].filter(Boolean).join(' + ')}</div>
            </>
          ) : (
            <>
              <div className="pj-title">{project.name}</div>
              <div>{Object.keys(project.comps).length} compositions</div>
              <div>{Object.keys(project.footage).length} footage items</div>
              <div style={{ color: 'var(--text-4)' }}>Drop files here to import</div>
            </>
          )}
        </div>
      </div>
      <div className="panel-toolbar">
        <div className="search">
          <Search size={12} />
          <input placeholder="Search project" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
      </div>
      <div className="pj-head"><span>Name</span><span>Info</span></div>
      <div className="scroll pj-list" ref={listRef} onClick={(e) => e.target === listRef.current && setApp({ selItems: [] })}>
        {renderTree(null, 0)}
        {!items.length && <div className="empty" style={{ minHeight: 120 }}><div>Empty project.<br />Import files or create a composition.</div></div>}
      </div>
      <div className="pj-foot">
        <button className="icon-btn" title="Import File (Ctrl+I)" onClick={C.importFile}><Upload size={13} /></button>
        <button className="icon-btn" title="New Folder" onClick={() => A.newFolder()}><FolderPlus size={13} /></button>
        <button className="icon-btn" title="New Composition (Ctrl+N)" onClick={C.newComp}><Plus size={13} /></button>
        <div className="grow" />
        <button className="icon-btn" title="Delete selected items" disabled={!sel.length} onClick={() => A.deleteProjectItems(sel)}><Trash size={13} /></button>
      </div>
    </div>
  );
}
