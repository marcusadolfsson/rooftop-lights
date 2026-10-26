import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { previewAPI } from '../utils/api';
import type { PlaylistItemInput, RGBW } from '../types';

export interface EffectPreviewData {
  effectType: string;
  colors: RGBW[];
  params?: Record<string, unknown>;
  speed?: number;
  scope?: string;
}

export type PreviewRequest =
  | { kind: 'static'; colors: Record<number, RGBW> }
  | ({ kind: 'effect' } & EffectPreviewData)
  | { kind: 'playlist'; playlistId: string }
  // The scene / playlist editor's current (possibly unsaved) contents, from item startIndex on.
  // playlistId is the playlist being edited, when it is saved.
  | { kind: 'playlistItems'; items: PlaylistItemInput[]; playMode: 'sequence' | 'random'; startIndex: number; playlistId?: string };

interface QueueItem {
  run: () => Promise<unknown>;
  replaceable: boolean;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

/**
 * Sends preview requests one at a time, in order. A queued "replaceable" request
 * (a design/effect preview) is dropped when a newer one is queued behind it, so a
 * slow request for design A can never land after — and override — design B.
 * Non-replaceable requests (stop, clear, status sync, live toggles) always run.
 */
class PreviewQueue {
  private pending: QueueItem[] = [];
  private running = false;

  push<T>(run: () => Promise<T>, replaceable: boolean): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      const last = this.pending[this.pending.length - 1];
      if (replaceable && last?.replaceable) {
        this.pending.pop();
        last.resolve(undefined); // superseded
      }
      this.pending.push({ run, replaceable, resolve: resolve as (v: unknown) => void, reject });
      void this.drain();
    });
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    while (this.pending.length > 0) {
      const item = this.pending.shift()!;
      try {
        item.resolve(await item.run());
      } catch (err) {
        item.reject(err);
      }
    }
    this.running = false;
  }
}

const ERROR_REPEAT_MS = 10000;

function sendRequest(req: PreviewRequest, live: boolean) {
  switch (req.kind) {
    case 'static':
      return previewAPI.start({ designType: 'static', designData: { colors: req.colors }, live });
    case 'effect': {
      const { kind: _kind, ...data } = req;
      return previewAPI.previewEffect({ ...data, live });
    }
    case 'playlist':
      return previewAPI.startPlaylist({ playlistId: req.playlistId, live });
    case 'playlistItems':
      return previewAPI.startPlaylist({ playlistId: req.playlistId, items: req.items, play_mode: req.playMode, startIndex: req.startIndex, live });
  }
}

export interface PreviewControls {
  isLive: boolean;
  isLiveRef: RefObject<boolean>;
  /** Preview on the WebSocket; also on the physical lights if live preview is on (or `live` says so). */
  send: (req: PreviewRequest, live?: boolean) => void;
  stop: () => void;
  /** Drop the WebSocket-only preview (the schedule, or live preview, shows through again). */
  clearSoft: () => void;
  toggleLive: (current: PreviewRequest | null) => Promise<void>;
}

/**
 * Live-preview state plus a single sequenced sender for preview requests.
 * Errors go to onError, de-duplicated so a failing debounced preview doesn't spam.
 */
export function usePreview({ isVisible, onError }: { isVisible: boolean; onError: (message: string) => void }): PreviewControls {
  const [isLive, setIsLiveState] = useState(false);
  const isLiveRef = useRef(false);
  const queueRef = useRef<PreviewQueue | null>(null);
  if (!queueRef.current) queueRef.current = new PreviewQueue();
  const queue = queueRef.current;

  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  const lastErrorRef = useRef<{ message: string; at: number } | null>(null);

  const report = useCallback((err: unknown, context: string) => {
    const message = `${context}: ${err instanceof Error ? err.message : String(err)}`;
    const now = Date.now();
    const last = lastErrorRef.current;
    if (last && last.message === message && now - last.at < ERROR_REPEAT_MS) return;
    lastErrorRef.current = { message, at: now };
    onErrorRef.current(message);
  }, []);

  const setLive = useCallback((value: boolean) => {
    isLiveRef.current = value;
    setIsLiveState(value);
  }, []);

  const send = useCallback((req: PreviewRequest, live?: boolean) => {
    const sendLive = live ?? isLiveRef.current;
    queue.push(() => sendRequest(req, sendLive), true).catch((err) => report(err, 'Preview failed'));
  }, [queue, report]);

  const stop = useCallback(() => {
    setLive(false);
    queue.push(() => previewAPI.stop(), false).catch((err) => report(err, 'Failed to stop preview'));
  }, [queue, report, setLive]);

  const clearSoft = useCallback(() => {
    queue.push(() => previewAPI.clearSoft(), false).catch((err) => report(err, 'Failed to clear preview'));
  }, [queue, report]);

  const toggleLive = useCallback(async (current: PreviewRequest | null) => {
    if (isLiveRef.current) {
      setLive(false);
      try {
        await queue.push(() => previewAPI.stop(), false);
      } catch (err) {
        setLive(true);
        report(err, 'Failed to stop live preview');
      }
      return;
    }
    if (!current) {
      report(new Error('select an effect or show first'), 'Cannot start live preview');
      return;
    }
    setLive(true);
    try {
      await queue.push(() => sendRequest(current, true), false);
    } catch (err) {
      setLive(false);
      report(err, 'Failed to start live preview');
    }
  }, [queue, report, setLive]);

  // Re-sync live state from the backend whenever the page becomes visible (another
  // tab or the Schedule page may have changed it). Leaving the page clears the
  // WS-only preview so the schedule shows through; live preview keeps running.
  useEffect(() => {
    if (isVisible) {
      queue.push(async () => {
        const status = await previewAPI.getStatus();
        setLive(status.isLivePreview);
      }, false).catch((err) => report(err, 'Failed to read preview status'));
    } else {
      queue.push(() => previewAPI.clearSoft(), false).catch((err) => report(err, 'Failed to clear preview'));
    }
  }, [isVisible, queue, report, setLive]);

  return useMemo(() => ({ isLive, isLiveRef, send, stop, clearSoft, toggleLive }), [isLive, send, stop, clearSoft, toggleLive]);
}
