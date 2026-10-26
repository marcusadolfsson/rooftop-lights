import { useEffect, useRef, useState } from 'react';
import type { Light, Wall } from '../types';
import { layoutAPI } from '../utils/api';
import { rgbwToCss } from '../utils/color';
import { useFrameData } from '../hooks/useLightSocket';
import PreviewStrip from './PreviewStrip';

const OPEN_KEY = 'outputMonitorPinned';
// Mini strip: each light is CELL_W x CELL_H px with a 1 px gap (as tall as the menu); walls 4 px apart
const CELL_W = 8;
const CELL_H = 11;
const WALL_GAP = 4;

function readOpen(): boolean {
  try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
}
function writeOpen(open: boolean) {
  try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* private mode */ }
}

/** Tiny canvas of what the lights are showing, drawn like the preview strip (outside view). */
function MiniOutput({ walls }: { walls: Wall[] }) {
  const frame = useFrameData(true, 'output');
  const canvas = useRef<HTMLCanvasElement>(null);
  const rows = walls.length > 0 ? Math.max(...walls.map((w) => w.height)) : 3;
  const width = walls.reduce((sum, w) => sum + w.width * (CELL_W + 1), 0) + Math.max(0, walls.length - 1) * WALL_GAP - 1;
  const height = rows * (CELL_H + 1) - 1;

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
          ctx.fillRect(x0 + x * (CELL_W + 1), (rows - 1 - y) * (CELL_H + 1), CELL_W, CELL_H);
        }
      }
      x0 += wall.width * (CELL_W + 1) + WALL_GAP;
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
 * header (in place of the mini view) that stays open on every page until closed; remembered per browser.
 */
export function useOutputMonitor() {
  const [walls, setWalls] = useState<Wall[]>([]);
  const [open, setOpenState] = useState(readOpen);

  useEffect(() => {
    let cancelled = false;
    layoutAPI.getLayout().then((l) => { if (!cancelled) setWalls(l.walls); }).catch(() => { /* header just stays empty */ });
    return () => { cancelled = true; };
  }, [open]);

  const setOpen = (value: boolean) => {
    setOpenState(value);
    writeOpen(value);
  };
  return { walls, open, setOpen };
}

export type OutputMonitorState = ReturnType<typeof useOutputMonitor>;

export function OutputMiniButton({ monitor }: { monitor: OutputMonitorState }) {
  const { walls, open, setOpen } = monitor;
  if (open) return null;
  return (
    <button
      type="button"
      className="output-mini"
      aria-expanded={false}
      aria-controls="output-panel"
      title="Show the lights output"
      onClick={() => setOpen(true)}
    >
      {walls.length > 0 && <MiniOutput walls={walls} />}
    </button>
  );
}

export function OutputPanel({ monitor }: { monitor: OutputMonitorState }) {
  const { walls, open, setOpen } = monitor;
  if (!open) return null;
  return (
    <div id="output-panel" className="output-panel" role="region" aria-label="Lights output">
      <div className="output-panel-header">
        <span className="preview-strip-title">Lights output</span>
        <button type="button" className="btn-icon" aria-label="Close lights output" title="Close" onClick={() => setOpen(false)}>×</button>
      </div>
      {walls.length > 0 && <OutputStrip walls={walls} />}
    </div>
  );
}
