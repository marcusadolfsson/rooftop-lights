import { useEffect, useState, type CSSProperties } from 'react';
import { audioAPI } from '../utils/api';
import type { AudioInputStatus, AudioSource } from '../types';
import BrowserMicControl from './BrowserMicControl';

const POLL_MS = 500;

/** Example sender sketch for an ESP32 with an analog microphone, pointed at this server. */
function esp32Sketch(host: string, port: number): string {
  return `#include <WiFi.h>
#include <WiFiUdp.h>

const char* WIFI_SSID = "your-wifi";
const char* WIFI_PASS = "your-password";
const char* SERVER    = "${host}";
const uint16_t PORT   = ${port};
const char* SOURCE_ID = "mic-1";
const int MIC_PIN     = 34;  // analog mic (MAX4466 / MAX9814) output

WiFiUDP udp;
uint32_t seq = 0;
float peak = 0;
float dc = 2048;  // DC offset of the mic signal (ADC is 0-4095)

// RMS over ~20 ms, mapped from -60..0 dBFS to 0..100
float readLevel() {
  double acc = 0;
  int n = 0;
  uint32_t start = millis();
  while (millis() - start < 20) {
    float s = analogRead(MIC_PIN);
    dc += (s - dc) * 0.001f;
    float v = (s - dc) / 2048.0f;
    acc += v * v;
    n++;
  }
  float rms = sqrt(acc / max(n, 1));
  float db = 20.0f * log10f(rms + 1e-6f);
  return constrain((db + 60.0f) * (100.0f / 60.0f), 0.0f, 100.0f);
}

void setup() {
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(250);
}

void loop() {
  float level = readLevel();
  peak = max(level, peak * 0.95f);
  char msg[96];
  int len = snprintf(msg, sizeof msg, "{\\"id\\":\\"%s\\",\\"level\\":%.1f,\\"peak\\":%.0f,\\"seq\\":%lu}",
                     SOURCE_ID, level, peak, (unsigned long)seq++);
  udp.beginPacket(SERVER, PORT);
  udp.write((const uint8_t*)msg, len);
  udp.endPacket();
  delay(5);  // ~20 ms of sampling + 5 ms = about 40 readings per second
}
`;
}

function ago(ms: number): string {
  if (ms < 1000) return 'just now';
  if (ms < 60_000) return `${Math.round(ms / 1000)} s ago`;
  return `${Math.round(ms / 60_000)} min ago`;
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard blocked (http): the text can still be selected */ });
  };
  return (
    <div className="audio-code">
      <div className="audio-code-head">
        <span>{label}</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre><code>{text}</code></pre>
    </div>
  );
}

/**
 * Light Layout card: audio inputs the server hears (for the Audio Level effect) with a live level
 * bar, and copy-paste examples for sending levels. Polls only while the page is showing.
 */
export default function AudioInputsCard({ visible }: { visible: boolean }) {
  const [sources, setSources] = useState<AudioSource[] | null>(null);
  const [status, setStatus] = useState<AudioInputStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    audioAPI.getStatus().then(setStatus).catch(() => setStatus(null));
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const list = await audioAPI.getSources();
          if (!cancelled) { setSources(list); setError(null); }
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load audio inputs');
        }
      }
      if (!cancelled) timer = window.setTimeout(poll, POLL_MS);
    };
    poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [visible]);

  const host = window.location.hostname || 'SERVER-IP';
  const port = status?.udpPort ?? 7000;
  const udpOff = status !== null && status.udpPort === null;
  const curl = `curl -X POST -H 'Content-Type: application/json' \\\n  -d '{"id":"mic-1","level":42.5,"peak":71}' \\\n  ${window.location.origin}/api/audio/level`;
  const netcat = `echo -n '{"id":"test","level":60}' | nc -u -w0 ${host} ${port}`;

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">Audio Inputs</h2>
        <span className="audio-status">
          {status === null ? '' : udpOff ? 'UDP off · HTTP only'
            : status.listening ? `UDP ${port} · listening` : `UDP ${port} · not listening${status.error ? ` (${status.error})` : ''}`}
        </span>
      </div>
      <p className="audio-intro">
        Live levels for the Audio Level effect. Send one JSON reading per packet, 30–50 per second:
        {' '}<code>{'{"id":"mic-1","level":42.5,"peak":71,"seq":1234}'}</code> (level and peak 0–100).
      </p>

      <BrowserMicControl />

      {error && <p className="audio-empty">{error}</p>}
      {sources !== null && sources.length === 0 && !error && (
        <p className="audio-empty">No audio inputs yet{udpOff ? '' : ` — send readings to ${host}:${port} (UDP)`} or POST them to /api/audio/level.</p>
      )}
      {sources !== null && sources.length > 0 && (
        <ul className="audio-sources">
          {sources.map((s) => {
            const stale = s.ageMs > 1000;
            return (
              <li key={s.id} className={`audio-source${stale ? ' stale' : ''}`}>
                <div className="audio-source-head">
                  <strong>{s.id}</strong>
                  <span className="audio-source-level">{Math.round(s.level)}</span>
                </div>
                <div
                  className="audio-meter"
                  role="meter"
                  aria-label={`${s.id} level`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(s.level)}
                  style={{ '--level': `${Math.max(0, Math.min(100, s.level))}%`, '--peak': `${Math.max(0, Math.min(100, s.peak ?? 0))}%` } as CSSProperties}
                >
                  <div className="audio-meter-fill" />
                  {s.peak !== null && !stale && <div className="audio-meter-peak" />}
                </div>
                <div className="audio-source-meta">
                  <span>{ago(s.ageMs)}</span>
                  <span>{s.packetsPerSecond} packets/s</span>
                  <span>{s.address ?? 'unknown'} · {s.transport.toUpperCase()}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <details className="audio-howto">
        <summary>How to send audio levels</summary>
        <p>
          UDP to <code>{host}:{port}</code> (preferred), or HTTP POST with the same JSON (one object or an array).
          {' '}<code>id</code> defaults to <code>default</code>; <code>seq</code> lets the server drop late packets.
          A source that stops sending fades to dark after a second. Or use this computer's microphone above
          (it streams over the page's connection while this tab is open).
        </p>
        {!udpOff && <CopyBlock label="Test from a terminal (UDP)" text={netcat} />}
        <CopyBlock label="HTTP (curl)" text={curl} />
        {!udpOff && <CopyBlock label="ESP32 (Arduino) with an analog microphone" text={esp32Sketch(host, port)} />}
      </details>
    </div>
  );
}
