import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { EMPTY_FRAME, LightSocketStore, type ConnectionStatus, type FrameData } from './lightSocket';

const LightSocketContext = createContext<LightSocketStore | null>(null);

export function LightSocketProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new LightSocketStore());
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  return <LightSocketContext.Provider value={store}>{children}</LightSocketContext.Provider>;
}

function useStore(): LightSocketStore {
  const store = useContext(LightSocketContext);
  if (!store) throw new Error('useLightSocket hooks must be used inside <LightSocketProvider>');
  return store;
}

export function useConnectionStatus(): ConnectionStatus {
  const store = useStore();
  return useSyncExternalStore(store.subscribeStatus, store.getStatus);
}

const noopSubscribe = () => () => {};
const getEmptyFrame = () => EMPTY_FRAME;

/**
 * Latest frame from the server. Pass enabled=false (e.g. while the page is hidden)
 * to unsubscribe, so the component stops re-rendering on every frame.
 */
export function useFrameData(enabled = true): FrameData {
  const store = useStore();
  return useSyncExternalStore(
    enabled ? store.subscribeFrame : noopSubscribe,
    enabled ? store.getFrame : getEmptyFrame,
  );
}

/** Send a message on the app's WebSocket; returns false when it isn't connected. */
export function useLightSocketSend(): (data: string) => boolean {
  return useStore().send;
}
