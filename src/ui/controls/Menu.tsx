import { useEffect, useState, useRef } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import type { MenuItem } from '../../state/uiTypes';
import { Popover } from './Popover';
import { useApp, setApp } from '../../state/store';

/**
 * A menu level. Pointer: hover opens submenus, click runs. Keyboard (the deepest open level listens):
 * ↑/↓ move, → or Enter opens a submenu, ← goes back a level, Enter / Space run the item, Home / End jump.
 */
export function MenuList({
  items, onClose, onBack, onSide, startActive = false,
}: {
  items: MenuItem[];
  onClose: () => void;
  /** close this level only (← in a submenu) */
  onBack?: () => void;
  /** ← / → at the top level of a menu-bar menu: move to the neighbouring menu */
  onSide?: (dir: -1 | 1) => void;
  /** opened from the keyboard: start with the first item highlighted */
  startActive?: boolean;
}) {
  const [sub, setSub] = useState<{ idx: number; rect: DOMRect; kbd: boolean } | null>(null);
  const [active, setActive] = useState(() => (startActive ? items.findIndex((it) => !it.separator && !it.disabled) : -1));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const usable = (i: number) => !!items[i] && !items[i].separator && !items[i].disabled;
  const rowRect = (i: number) => root.current?.querySelector<HTMLElement>(`[data-mi="${i}"]`)?.getBoundingClientRect();
  const run = (i: number, kbd = false) => {
    const it = items[i];
    if (!usable(i)) return;
    if (it.submenu?.length) {
      const rect = rowRect(i);
      if (rect) setSub({ idx: i, rect, kbd });
      return;
    }
    onClose();
    it.action?.();
  };
  // keyboard navigation belongs to the deepest open level
  const live = useRef({ sub, active, run, onBack, onSide });
  live.current = { sub, active, run, onBack, onSide };
  useEffect(() => {
    const step = (from: number, dir: 1 | -1) => {
      for (let n = 0, i = from; n < items.length; n++) {
        i = (i + dir + items.length) % items.length;
        if (usable(i)) return i;
      }
      return from;
    };
    const key = (e: KeyboardEvent) => {
      const s = live.current;
      if (s.sub) return;
      let handled = true;
      if (e.key === 'ArrowDown') setActive(step(s.active, 1));
      else if (e.key === 'ArrowUp') setActive(step(s.active < 0 ? 0 : s.active, -1));
      else if (e.key === 'Home') setActive(step(-1, 1));
      else if (e.key === 'End') setActive(step(0, -1));
      else if (e.key === 'ArrowRight' && s.active >= 0 && items[s.active]?.submenu?.length) s.run(s.active, true);
      else if (e.key === 'ArrowRight' && s.onSide) s.onSide(1);
      else if (e.key === 'ArrowLeft' && s.onBack) s.onBack();
      else if (e.key === 'ArrowLeft' && s.onSide) s.onSide(-1);
      else if ((e.key === 'Enter' || e.key === ' ') && s.active >= 0) s.run(s.active, true);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  useEffect(() => {
    if (active >= 0) root.current?.querySelector<HTMLElement>(`[data-mi="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <div className="menu" ref={root} role="menu">
      {items.map((it, i) => {
        if (it.separator) return <div key={i} className="menu-sep" />;
        // a greyed-out item neither runs nor opens its submenu
        const hasSub = !!it.submenu?.length && !it.disabled;
        return (
          <div
            key={i}
            data-mi={i}
            role="menuitem"
            aria-disabled={it.disabled || undefined}
            className={`menu-item${it.disabled ? ' disabled' : ''}${it.danger ? ' danger' : ''}${sub?.idx === i || active === i ? ' hover' : ''}`}
            onPointerEnter={(e) => {
              if (timer.current) clearTimeout(timer.current);
              setActive(it.disabled ? -1 : i);
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              if (hasSub) setSub((cur) => (cur?.idx === i ? cur : { idx: i, rect, kbd: false }));
              else timer.current = setTimeout(() => setSub(null), 120);
            }}
            onClick={(e) => {
              e.stopPropagation();
              run(i);
            }}
          >
            <span className="mi-check">{it.checked ? <Check size={12} strokeWidth={3} /> : null}</span>
            <span className="mi-label">{it.label}</span>
            {it.shortcut && <span className="mi-shortcut">{it.shortcut}</span>}
            {!!it.submenu?.length && <ChevronRight size={12} className="mi-arrow" />}
          </div>
        );
      })}
      {sub && items[sub.idx]?.submenu && (
        <Popover x={sub.rect.right + 2} y={sub.rect.top - 5} onClose={() => setSub(null)} anchorRect={sub.rect}>
          <MenuList items={items[sub.idx].submenu!} onClose={onClose} onBack={() => setSub(null)} startActive={sub.kbd} />
        </Popover>
      )}
    </div>
  );
}

export function ContextMenuHost() {
  const cm = useApp((s) => s.contextMenu);
  if (!cm) return null;
  const close = () => setApp({ contextMenu: null });
  return (
    <Popover x={cm.x} y={cm.y} onClose={close}>
      <MenuList items={cm.items} onClose={close} />
    </Popover>
  );
}
