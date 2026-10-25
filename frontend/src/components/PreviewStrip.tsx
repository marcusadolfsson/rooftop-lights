import { Fragment, type ReactNode } from 'react';
import type { Light, Wall } from '../types';

export interface PreviewCell {
  backgroundColor?: string;
  className?: string;
  title?: string;
  content?: ReactNode;
}

interface PreviewStripProps {
  walls: Wall[];
  // Describes how each light renders (color, extra class, tooltip, content)
  getCell: (light: Light, wall: Wall) => PreviewCell;
  // 'inside' mirrors the unrolled strip: walls in reverse order, each read right-to-left
  view?: 'outside' | 'inside';
  onLightClick?: (light: Light) => void;
  // Accessible name for a clickable cell
  getCellLabel?: (light: Light, wall: Wall) => string;
}

/** The unrolled 2D strip of all walls, shared by the Design, Schedule and Layout pages. */
export default function PreviewStrip({ walls: layoutWalls, getCell, view = 'outside', onLightClick, getCellLabel }: PreviewStripProps) {
  const inside = view === 'inside';
  const walls = inside ? [...layoutWalls].reverse() : layoutWalls;
  if (walls.length === 0) return null;
  const maxRows = Math.max(...walls.map((w) => w.height));

  return (
    <div className="preview-strip-grid-wrapper">
      <div
        className="preview-strip-grid"
        style={{ gridTemplateColumns: walls.map((w) => `repeat(${w.width}, 1fr)`).join(' 6px ') }}
      >
        {Array.from({ length: maxRows }, (_, rowIdx) => {
          const y = maxRows - 1 - rowIdx;
          return walls.flatMap((wall, wallIdx) => {
            const cells = Array.from({ length: wall.width }, (_, x) => {
              const light = wall.matrix?.[y]?.[inside ? wall.width - 1 - x : x];
              if (!light || y >= wall.height) {
                return (
                  <div
                    key={`${wall.id}-${y}-${x}`}
                    className="preview-strip-cell"
                    style={{ backgroundColor: '#111' }}
                  />
                );
              }
              const cell = getCell(light, wall);
              const className = `preview-strip-cell${cell.className ? ` ${cell.className}` : ''}`;
              const style = cell.backgroundColor ? { backgroundColor: cell.backgroundColor } : undefined;
              if (!onLightClick) {
                return (
                  <div key={light.id} className={className} style={style} title={cell.title}>
                    {cell.content}
                  </div>
                );
              }
              return (
                <div
                  key={light.id}
                  className={className}
                  style={style}
                  title={cell.title}
                  role="button"
                  tabIndex={0}
                  aria-label={getCellLabel?.(light, wall) ?? cell.title}
                  onClick={() => onLightClick(light)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onLightClick(light);
                    }
                  }}
                >
                  {cell.content}
                </div>
              );
            });
            if (wallIdx < walls.length - 1) {
              cells.push(<div key={`spacer-${wall.id}-${y}`} className="preview-strip-spacer" />);
            }
            return cells;
          });
        })}
      </div>
      <div
        className="preview-strip-labels"
        style={{ gridTemplateColumns: walls.map((w) => `${w.width}fr`).join(' 6px ') }}
      >
        {walls.map((wall, wallIdx) => (
          <Fragment key={wall.id}>
            {wallIdx > 0 && <div />}
            <div className="preview-strip-label">{wall.name}</div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
