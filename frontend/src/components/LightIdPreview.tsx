import { useState, lazy, Suspense } from 'react';
import type { Light, Wall } from '../types';
import PreviewStrip from './PreviewStrip';

const Preview3D = lazy(() => import('./Preview3D'));

interface LightIdPreviewProps {
  walls: Wall[];
  onLightClick?: (light: Light) => void;
}

const idCell = (light: Light, wall: Wall) => ({
  className: 'preview-strip-cell-id',
  title: `#${light.light_id} (${wall.name}) — DMX ${light.dmx_start_channel}`,
  content: light.light_id,
});
const idCellLabel = (light: Light, wall: Wall) => `Edit light ${light.light_id} (${wall.name})`;
const idColor = () => '#334155';
const noDefective = () => null;

// Same layout as the Design page preview strip, but each cell shows its light ID instead of a color
export default function LightIdPreview({ walls, onLightClick }: LightIdPreviewProps) {
  const [previewMode, setPreviewMode] = useState<'2d' | '3d'>('2d');
  const [view, setView] = useState<'outside' | 'inside'>('outside');

  return (
    <div className="preview-strip">
      <div className="preview-strip-header">
        <div className="preview-strip-title">Light IDs</div>
        <div className="preview-strip-controls">
          <div className="preview-mode-toggle" role="group" aria-label="Viewpoint">
            <button className={view === 'outside' ? 'active' : ''} aria-pressed={view === 'outside'} onClick={() => setView('outside')}>
              Outside
            </button>
            <button className={view === 'inside' ? 'active' : ''} aria-pressed={view === 'inside'} onClick={() => setView('inside')}>
              Inside
            </button>
          </div>
          <div className="preview-mode-toggle" role="group" aria-label="Preview mode">
            <button className={previewMode === '2d' ? 'active' : ''} aria-pressed={previewMode === '2d'} onClick={() => setPreviewMode('2d')}>
              2D
            </button>
            <button className={previewMode === '3d' ? 'active' : ''} aria-pressed={previewMode === '3d'} onClick={() => setPreviewMode('3d')}>
              3D
            </button>
          </div>
        </div>
      </div>
      {previewMode === '2d' ? (
        <PreviewStrip
          walls={walls}
          view={view}
          getCell={idCell}
          onLightClick={onLightClick}
          getCellLabel={idCellLabel}
        />
      ) : (
        <Suspense fallback={<div className="preview-3d-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>Loading 3D view...</div>}>
          <Preview3D
            walls={walls}
            getLightColor={idColor}
            getDefectiveSimulation={noDefective}
            showDefective={false}
            showIds
            view={view}
          />
        </Suspense>
      )}
    </div>
  );
}
