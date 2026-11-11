import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Dialog({
  title, sub, icon, children, footer, onClose, width,
}: {
  title: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  /** Enter confirms with the primary footer button. */
  const confirm = (e: { preventDefault(): void }) => {
    const primary = root.current?.querySelector<HTMLButtonElement>('.dialog-foot .btn.primary:not(:disabled)');
    if (!primary) return;
    e.preventDefault();
    primary.click();
  };
  const live = useRef({ onClose, confirm });
  live.current = { onClose, confirm };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // a popover opened from the dialog (colour picker, dropdown) is on top: it takes the key
      if (document.querySelector('.popover')) return;
      if (e.key === 'Escape') {
        // an inline number edit cancels itself first; the next Escape closes the dialog
        if ((e.target as HTMLElement | null)?.classList?.contains('scrub-edit')) return;
        e.stopPropagation();
        live.current.onClose();
        return;
      }
      // Focus fell out of the dialog (an inline number field unmounts when it commits): bring it back so
      // Tab continues inside the dialog, and let Enter still confirm.
      const el = root.current;
      const a = document.activeElement;
      if (el && (!a || a === document.body)) {
        el.focus();
        if (e.key === 'Enter') live.current.confirm(e);
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
  // Keyboard focus starts inside the dialog (on an autofocused field if there is one), so Enter and
  // Tab work straight away and keys never fall through to the app behind it.
  useEffect(() => {
    const el = root.current;
    if (el && !el.contains(document.activeElement)) el.focus();
  }, []);
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={root}
        className="dialog"
        tabIndex={-1}
        style={width ? { width } : undefined}
        onKeyDown={(e) => {
          e.stopPropagation();
          // Enter confirms unless a field already handled it or focus is on a control that Enter means
          // something else for
          const t = e.target as HTMLElement;
          if (e.key !== 'Enter' || e.defaultPrevented || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'SELECT' || t.isContentEditable) return;
          confirm(e);
        }}
      >
        <div className="dialog-head">
          {icon}
          <div style={{ flex: 1 }}>
            {title}
            {sub && <div className="sub">{sub}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}
