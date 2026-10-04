import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Fixed-position popover anchored at a screen point, auto-flipped to stay on screen. */
export function Popover({
  x, y, onClose, children, className = '', anchorRect, align = 'start',
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  anchorRect?: DOMRect;
  align?: 'start' | 'end';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = align === 'end' ? x - r.width : x;
    let top = y;
    if (left + r.width > window.innerWidth - 6) left = Math.max(6, window.innerWidth - r.width - 6);
    if (top + r.height > window.innerHeight - 6) {
      top = anchorRect ? anchorRect.top - r.height - 4 : Math.max(6, window.innerHeight - r.height - 6);
      if (top < 6) top = 6;
    }
    setPos({ left: Math.max(6, left), top, ready: true });
  }, [x, y, anchorRect, align]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const t = setTimeout(() => window.addEventListener('pointerdown', down, true), 0);
    window.addEventListener('keydown', key, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className={`popover ${className}`} style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>,
    document.body,
  );
}
