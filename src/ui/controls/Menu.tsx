import { useState, useRef } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import type { MenuItem } from '../../state/uiTypes';
import { Popover } from './Popover';
import { useApp, setApp } from '../../state/store';

export function MenuList({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const [sub, setSub] = useState<{ idx: number; rect: DOMRect } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <div className="menu">
      {items.map((it, i) => {
        if (it.separator) return <div key={i} className="menu-sep" />;
        const hasSub = !!it.submenu?.length;
        return (
          <div
            key={i}
            className={`menu-item${it.disabled ? ' disabled' : ''}${it.danger ? ' danger' : ''}${sub?.idx === i ? ' hover' : ''}`}
            onPointerEnter={(e) => {
              if (timer.current) clearTimeout(timer.current);
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              if (hasSub) setSub({ idx: i, rect });
              else timer.current = setTimeout(() => setSub(null), 120);
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (it.disabled) return;
              if (hasSub) {
                setSub({ idx: i, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() });
                return;
              }
              onClose();
              it.action?.();
            }}
          >
            <span className="mi-check">{it.checked ? <Check size={12} strokeWidth={3} /> : null}</span>
            <span className="mi-label">{it.label}</span>
            {it.shortcut && <span className="mi-shortcut">{it.shortcut}</span>}
            {hasSub && <ChevronRight size={12} className="mi-arrow" />}
          </div>
        );
      })}
      {sub && items[sub.idx]?.submenu && (
        <Popover x={sub.rect.right + 2} y={sub.rect.top - 5} onClose={() => setSub(null)} anchorRect={sub.rect}>
          <MenuList items={items[sub.idx].submenu!} onClose={onClose} />
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
