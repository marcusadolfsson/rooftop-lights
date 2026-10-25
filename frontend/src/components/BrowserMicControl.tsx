import { useEffect, useSyncExternalStore, type CSSProperties } from 'react';
import { browserMic } from '../utils/browserMic';
import { useLightSocketSend } from '../hooks/useLightSocket';

/** The shared microphone stream's state, with the app's WebSocket wired in as its transport. */
export function useBrowserMic() {
  const send = useLightSocketSend();
  useEffect(() => { browserMic.setSender(send); }, [send]);
  return useSyncExternalStore(browserMic.subscribe, browserMic.getState);
}

/**
 * "Use this computer's microphone": streams this browser's mic level to the server as an audio
 * input. `compact` is the one-line version next to the Audio Level effect's source field;
 * `onStart` gets the source id the readings go out under (so the effect can select it).
 */
export default function BrowserMicControl({ compact = false, onStart }: { compact?: boolean; onStart?: (id: string) => void }) {
  const mic = useBrowserMic();
  const streaming = mic.status === 'streaming';
  const start = async () => {
    await browserMic.start();
    if (browserMic.getState().status === 'streaming') onStart?.(browserMic.effectiveId());
  };

  return (
    <div className={`browser-mic${compact ? ' compact' : ''}`}>
      {!compact && (
        <label className="browser-mic-id">
          <span>Source id</span>
          <input
            type="text"
            className="form-input"
            value={mic.sourceId}
            maxLength={64}
            onChange={(e) => browserMic.setSourceId(e.target.value)}
            aria-label="Microphone source id"
          />
        </label>
      )}
      <div className="browser-mic-row">
        {streaming ? (
          <>
            <div
              className="audio-meter browser-mic-meter"
              role="meter"
              aria-label="Microphone level"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(mic.level)}
              style={{ '--level': `${mic.level}%`, '--peak': `${mic.peak}%` } as CSSProperties}
            >
              <div className="audio-meter-fill" />
              <div className="audio-meter-peak" />
            </div>
            <span className="browser-mic-label">{compact ? `Mic: ${browserMic.effectiveId()}` : `Sending as ${browserMic.effectiveId()}`}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => browserMic.stop()}>Stop</button>
          </>
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" onClick={start} disabled={mic.status === 'starting'}>
            {mic.status === 'starting' ? 'Waiting for permission…' : compact ? "Use this computer's mic" : "Use this computer's microphone"}
          </button>
        )}
      </div>
      {mic.error && <p className="browser-mic-error" role="alert">{mic.error}</p>}
    </div>
  );
}
