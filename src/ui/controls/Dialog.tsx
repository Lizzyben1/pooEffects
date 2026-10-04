import { useEffect, type ReactNode } from 'react';
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
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={width ? { width } : undefined} onKeyDown={(e) => e.stopPropagation()}>
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
