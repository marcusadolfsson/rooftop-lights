import { useEffect, useRef, useState } from 'react';
import type { Light, Wall } from '../types';
import { layoutAPI } from '../utils/api';
import { rgbwToCss } from '../utils/color';
import { useFrameData } from '../hooks/useLightSocket';
import PreviewStrip from './PreviewStrip';

const PIN_KEY = 'outputMonitorPinned';
const CELL = 4; // mini strip: px per light, plus 1 px gap; walls 4 px apart
const WALL_GAP = 4;

function readPinned(): boolean {
  try { return localStorage.getItem(PIN_KEY) === '1'; } catch { return false; }
}
function writePinned(pinned: boolean) {
  try { localStorage.setItem(PIN_KEY, pinned ? '1' : '0'); } catch { /* private mode */ }
}

/** Tiny canvas of what the lights are showing, drawn like the preview strip (outside view). */
function MiniOutput({ walls }: { walls: Wall[] }) {
  const frame = useFrameData(true, 'output');
  const canvas = useRef<HTMLCanvasElement>(null);
  const rows = walls.length > 0 ? Math.max(...walls.map((w) => w.height)) : 3;
  const width = walls.reduce((sum, w) => sum + w.width * (CELL + 1), 0) + Math.max(0, walls.length - 1) * WALL_GAP - 1;
  const height = rows * (CELL + 1) - 1;

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    let x0 = 0;
    for (const wall of walls) {
      for (let y = 0; y < wall.height; y++) {
        for (let x = 0; x < wall.width; x++) {
          const light: Light | undefined = wall.matrix?.[y]?.[x];
          ctx.fillStyle = light ? rgbwToCss(frame[light.light_id], '#1f2937') : '#111';
          // Row 0 is the bottom row
          ctx.fillRect(x0 + x * (CELL + 1), (rows - 1 - y) * (CELL + 1), CELL, CELL);
        }
      }
      x0 += wall.width * (CELL + 1) + WALL_GAP;
    }
  }, [frame, walls, rows, width, height]);

  return <canvas ref={canvas} width={width} height={height} className="output-mini-canvas" aria-hidden="true" />;
}

/** The full-size strip of what the lights are showing. */
function OutputStrip({ walls }: { walls: Wall[] }) {
  const frame = useFrameData(true, 'output');
  return (
    <PreviewStrip
      walls={walls}
      getCell={(light, wall) => ({ backgroundColor: rgbwToCss(frame[light.light_id]), title: `#${light.light_id} (${wall.name})` })}
    />
  );
}

/**
 * Header button with a mini view of the light output. Clicking it opens a larger view under the
 * header, which can be pinned to stay open (remembered per browser).
 */
export function useOutputMonitor() {
  const [walls, setWalls] = useState<Wall[]>([]);
  const [pinned, setPinnedState] = useState(readPinned);
  const [open, setOpen] = useState(pinned);

  useEffect(() => {
    let cancelled = false;
    layoutAPI.getLayout().then((l) => { if (!cancelled) setWalls(l.walls); }).catch(() => { /* header just stays empty */ });
    return () => { cancelled = true; };
  }, [open]);

  const setPinned = (value: boolean) => {
    setPinnedState(value);
    writePinned(value);
    if (value) setOpen(true);
  };
  return { walls, open, setOpen, pinned, setPinned };
}

export type OutputMonitorState = ReturnType<typeof useOutputMonitor>;

export function OutputMiniButton({ monitor }: { monitor: OutputMonitorState }) {
  const { walls, open, setOpen, pinned } = monitor;
  return (
    <button
      type="button"
      className={`output-mini${open ? ' open' : ''}`}
      data-output-toggle
      aria-expanded={open}
      aria-controls="output-panel"
      title={open ? (pinned ? 'Lights output (pinned)' : 'Hide lights output') : 'Show lights output'}
      onClick={() => { if (!pinned) setOpen(!open); }}
    >
      {walls.length > 0 && <MiniOutput walls={walls} />}
    </button>
  );
}

export function OutputPanel({ monitor }: { monitor: OutputMonitorState }) {
  const { walls, open, setOpen, pinned, setPinned } = monitor;
  const panel = useRef<HTMLDivElement>(null);

  // Unpinned, it closes on Esc or a click anywhere else
  useEffect(() => {
    if (!open || pinned) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (panel.current?.contains(target) || target?.closest('[data-output-toggle]')) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, pinned, setOpen]);

  if (!open) return null;
  return (
    <div id="output-panel" ref={panel} className={`output-panel${pinned ? ' pinned' : ''}`} role="region" aria-label="Lights output">
      <div className="output-panel-header">
        <span className="preview-strip-title">Lights output</span>
        <div className="output-panel-actions">
          <button
            type="button"
            className={`btn btn-sm ${pinned ? 'btn-primary' : 'btn-secondary'}`}
            aria-pressed={pinned}
            onClick={() => setPinned(!pinned)}
            title={pinned ? 'Unpin: close when clicking elsewhere' : 'Pin: keep this open on every page'}
          >
            {pinned ? 'Pinned' : 'Pin'}
          </button>
          <button type="button" className="btn-icon" aria-label="Close lights output" onClick={() => { setPinned(false); setOpen(false); }}>×</button>
        </div>
      </div>
      {walls.length > 0 && <OutputStrip walls={walls} />}
    </div>
  );
}
