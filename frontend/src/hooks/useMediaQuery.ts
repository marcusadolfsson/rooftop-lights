import { useCallback, useSyncExternalStore } from 'react';

// Keep in sync with the @media (max-width: 768px) blocks in index.css
export const MOBILE_QUERY = '(max-width: 768px)';

/** True while the media query matches; re-renders when it flips (e.g. on rotation). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const mql = window.matchMedia(query);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

/** Phone-sized layout: the Design page stacks into one column and shows one wall at a time. */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}
