// Pointer-gesture plumbing shared by every drag in the UI.
//
// A drag that only listens for `pointerup` can be left hanging: the pointer is cancelled (touch / pen),
// the window loses focus mid-drag, or the button is released somewhere that never reports it. Because
// most drags hold an undo transaction open, a hanging drag silently disables caching and background
// rendering. `trackPointer` always ends, whichever way the gesture stops.

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Follow a pointer gesture until it ends. `end` is called exactly once — on release, on cancel, when
 * the window loses focus, or when a mouse move arrives with no button held. Returns a function that
 * ends the gesture early.
 */
export function trackPointer(
  start: { pointerId?: number; clientX: number; clientY: number } | null,
  move: (e: PointerEvent) => void,
  end?: (e: PointerEvent | null) => void,
): () => void {
  const id = start?.pointerId;
  let last: PointerEvent | null = null;
  let done = false;
  const finish = (e: PointerEvent | null) => {
    if (done) return;
    done = true;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('blur', onBlur);
    end?.(e ?? last);
  };
  const mine = (e: PointerEvent) => id === undefined || e.pointerId === id;
  const onMove = (e: PointerEvent) => {
    if (!mine(e)) return;
    // the button came up where we could not see it (outside the window, over a native control)
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      finish(e);
      return;
    }
    last = e;
    move(e);
  };
  const onUp = (e: PointerEvent) => {
    if (mine(e)) finish(e);
  };
  const onBlur = () => finish(null);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('blur', onBlur);
  return () => finish(null);
}

/** Wheel delta in pixels, whatever unit the device reports (Firefox reports lines for mouse wheels). */
export function wheelDelta(e: WheelEvent): { dx: number; dy: number } {
  const k = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 600 : 1;
  return { dx: e.deltaX * k, dy: e.deltaY * k };
}

/**
 * Wheel listener that may call preventDefault. React attaches `onWheel` passively, so a handler that
 * zooms on Ctrl/⌘+wheel (or a trackpad pinch) cannot stop the browser from zooming the whole page.
 */
export function useWheel(ref: RefObject<HTMLElement | null>, handler: (e: WheelEvent) => void): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = (e: WheelEvent) => latest.current(e);
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, [ref]);
}

/**
 * Keyboard shortcuts are ignored while a form control has focus. Controls that are operated with the
 * pointer (dropdowns, buttons, sliders) would otherwise keep focus afterwards and swallow every
 * shortcut until the user clicked somewhere else. Returns an uninstall function.
 */
export function installFocusRelease(): () => void {
  const release = (el: Element | null) => {
    if (el instanceof HTMLElement && el === document.activeElement) el.blur();
  };
  // Dialogs and popovers are modal keyboard contexts of their own (shortcuts are off while they are
  // open, and Enter / Tab rely on focus staying inside): leave focus alone there.
  const modal = (el: Element | null) => !!el?.closest('.dialog, .popover');
  const onChange = (e: Event) => {
    const t = e.target as HTMLElement | null;
    if (t?.tagName === 'SELECT' && !modal(t)) release(t);
  };
  const onClick = (e: MouseEvent) => {
    // detail is 0 for keyboard-initiated clicks: leave focus alone for keyboard users
    if (e.detail === 0) return;
    const a = document.activeElement as HTMLElement | null;
    if (!a || modal(a)) return;
    const tag = a.tagName;
    if (tag === 'BUTTON' || (tag === 'INPUT' && ['range', 'checkbox', 'radio', 'button'].includes((a as HTMLInputElement).type))) release(a);
  };
  window.addEventListener('change', onChange, true);
  window.addEventListener('click', onClick, true);
  return () => {
    window.removeEventListener('change', onChange, true);
    window.removeEventListener('click', onClick, true);
  };
}
