// A <select> that only builds its option list when the user is about to open it.
//
// A layer row carries three dropdowns (blend mode, track matte, parent). In a 100-layer comp that is
// several hundred <option> elements per row, re-created whenever a row renders — selecting a layer,
// scrolling the timeline, renaming or reordering anything. Collapsed, the select holds just the one
// option it is showing; the full list is rendered synchronously on pointer-down / focus, which is
// before the browser opens the native popup (that happens on the following mouse-down / key press).

import { useState, type ReactNode, type SelectHTMLAttributes } from 'react';
import { flushSync } from 'react-dom';

interface Props extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'value'> {
  value: string;
  /** label of the current value, shown while collapsed */
  label: string;
  /** builds the full option list (called only while armed) */
  children: () => ReactNode;
}

export function LazySelect({ value, label, children, onPointerDown, onFocus, onKeyDown, onBlur, ...rest }: Props) {
  const [armed, setArmed] = useState(false);
  const arm = () => {
    if (!armed) flushSync(() => setArmed(true));
  };
  return (
    <select
      {...rest}
      value={value}
      onPointerDown={(e) => {
        arm();
        onPointerDown?.(e);
      }}
      onFocus={(e) => {
        arm();
        onFocus?.(e);
      }}
      onKeyDown={(e) => {
        arm();
        onKeyDown?.(e);
      }}
      onBlur={(e) => {
        setArmed(false);
        onBlur?.(e);
      }}
    >
      {armed ? children() : <option value={value}>{label}</option>}
    </select>
  );
}
