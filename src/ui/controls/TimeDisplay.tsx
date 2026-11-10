// Editable current-time display (timecode or frames), AE style: click to type a time.

import { useEffect, useRef, useState } from 'react';
import { formatTime, parseTimeInput } from '../../core/time';
import type { Composition } from '../../core/types';
import { useApp } from '../../state/store';
import { goToTime } from '../../state/actions';
import { useTime } from '../../state/time';

export function TimeDisplay({ comp, big = false }: { comp: Composition; big?: boolean }) {
  const t = useTime(comp.id);
  const settings = useApp((s) => s.project.settings);
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const closed = useRef(false);
  useEffect(() => {
    if (edit) {
      closed.current = false;
      ref.current?.focus();
      ref.current?.select();
    }
  }, [edit]);
  const label = formatTime(t, comp.frameRate, comp.dropFrame, settings.timeDisplay, settings.frameStart);
  if (edit) {
    const commit = () => {
      if (closed.current) return;
      closed.current = true;
      const v = parseTimeInput(text, comp.frameRate, comp.dropFrame, t);
      if (v !== null) goToTime(comp.id, v);
      setEdit(false);
    };
    return (
      <input
        ref={ref}
        className={`time-input mono${big ? ' big' : ''}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            closed.current = true;
            setEdit(false);
          }
        }}
        onBlur={commit}
      />
    );
  }
  return (
    <span
      className={`time-display mono${big ? ' big' : ''}`}
      title="Current time — click to type (e.g. 2:15, f60, 1.5s, +10)"
      onClick={() => {
        setText(label);
        setEdit(true);
      }}
    >
      {label}
    </span>
  );
}
