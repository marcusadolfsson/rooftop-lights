import { useEffect, useRef } from 'react';

/** Calls onEscape when Esc is pressed while active (e.g. to close a modal). */
export function useEscapeKey(active: boolean, onEscape: () => void) {
  const callback = useRef(onEscape);
  useEffect(() => { callback.current = onEscape; });
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) callback.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active]);
}
