import { useState, lazy, Suspense, Fragment } from 'react';
import type { Light, Wall } from '../types';

const Preview3D = lazy(() => import('./Preview3D'));

interface LightIdPreviewProps {
  walls: Wall[];
  onLightClick?: (light: Light) => void;
}

// Same layout as the Design page preview strip, but each cell shows its light ID instead of a color
export default function LightIdPreview({ walls: layoutWalls, onLightClick }: LightIdPreviewProps) {
  const [previewMode, setPreviewMode] = useState<'2d' | '3d'>('2d');
  const [view, setView] = useState<'outside' | 'inside'>('outside');
  const inside = view === 'inside';
  // From inside, the unrolled strip is the mirror image: walls in reverse order, each wall read right-to-left
  const walls = inside ? [...layoutWalls].reverse() : layoutWalls;
  const maxRows = Math.max(...walls.map(w => w.height));

  return (
    <div className="preview-strip">
      <div className="preview-strip-header">
        <div className="preview-strip-title">Light IDs</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div className="preview-mode-toggle">
            <button className={view === 'outside' ? 'active' : ''} onClick={() => setView('outside')}>
              Outside
            </button>
            <button className={view === 'inside' ? 'active' : ''} onClick={() => setView('inside')}>
              Inside
            </button>
          </div>
          <div className="preview-mode-toggle">
            <button className={previewMode === '2d' ? 'active' : ''} onClick={() => setPreviewMode('2d')}>
              2D
            </button>
            <button className={previewMode === '3d' ? 'active' : ''} onClick={() => setPreviewMode('3d')}>
              3D
            </button>
          </div>
        </div>
      </div>
      {previewMode === '2d' ? (
        <div className="preview-strip-grid-wrapper">
          <div
            className="preview-strip-grid"
            style={{ gridTemplateColumns: walls.map(w => `repeat(${w.width}, 1fr)`).join(' 6px ') }}
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
                  return (
                    <div
                      key={light.id}
                      className="preview-strip-cell preview-strip-cell-id"
                      title={`#${light.light_id} (${wall.name}) — DMX ${light.dmx_start_channel}`}
                      onClick={() => onLightClick?.(light)}
                    >
                      {light.light_id}
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
            style={{ gridTemplateColumns: walls.map(w => `${w.width}fr`).join(' 6px ') }}
          >
            {walls.map((wall, wallIdx) => (
              <Fragment key={wall.id}>
                {wallIdx > 0 && <div />}
                <div className="preview-strip-label">{wall.name}</div>
              </Fragment>
            ))}
          </div>
        </div>
      ) : (
        <Suspense fallback={<div className="preview-3d-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>Loading 3D view...</div>}>
          <Preview3D
            walls={layoutWalls}
            getLightColor={() => '#334155'}
            getDefectiveSimulation={() => null}
            showDefective={false}
            showIds
            view={view}
          />
        </Suspense>
      )}
    </div>
  );
}
