import { lazy, memo, Suspense, useCallback } from 'react';
import type { Light, RGBW, Wall } from '../types';
import { useFrameData } from '../hooks/useLightSocket';
import { rgbwToCss, simulateDefective } from '../utils/color';
import PreviewStrip from './PreviewStrip';

const Preview3D = lazy(() => import('./Preview3D'));

interface LiveLightPreviewProps {
  walls: Wall[];
  mode?: '2d' | '3d';
  // Subscribe to WebSocket frames only while true (e.g. while the page is visible)
  active: boolean;
  // Shown for lights the current frame doesn't cover (e.g. the design being edited)
  fallbackColors?: Record<number, RGBW>;
  showDefective?: boolean;
  // Ignore the scheduled output: show only previews (and fallbackColors), dark otherwise
  previewOnly?: boolean;
}

const NO_COLORS: Record<number, RGBW> = {};

/**
 * The only component that re-renders per WebSocket frame; the pages around it don't.
 */
function LiveLightPreview({ walls, mode = '2d', active, fallbackColors = NO_COLORS, showDefective = false, previewOnly = false }: LiveLightPreviewProps) {
  const frame = useFrameData(active, previewOnly);

  // Frame data is raw (unmasked); defective simulation is applied separately
  const colorOf = (lightId: number): RGBW | undefined => frame[lightId] ?? fallbackColors[lightId];

  const getLightColor = useCallback(
    (lightId: number) => rgbwToCss(frame[lightId] ?? fallbackColors[lightId]),
    [frame, fallbackColors],
  );
  const getDefectiveSimulation = useCallback(
    (lightId: number, channels: string) => simulateDefective(frame[lightId] ?? fallbackColors[lightId], channels),
    [frame, fallbackColors],
  );

  if (mode === '3d') {
    return (
      <Suspense fallback={<div className="preview-3d-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>Loading 3D view...</div>}>
        <Preview3D
          walls={walls}
          getLightColor={getLightColor}
          getDefectiveSimulation={getDefectiveSimulation}
          showDefective={showDefective}
        />
      </Suspense>
    );
  }

  const getCell = (light: Light, wall: Wall) => {
    const isDefective = showDefective && !!light.defective_channels;
    const color = colorOf(light.light_id);
    const simColor = isDefective ? simulateDefective(color, light.defective_channels) : null;
    return {
      backgroundColor: simColor || rgbwToCss(color),
      className: isDefective ? 'preview-strip-cell-defective' : undefined,
      title: `#${light.light_id} (${wall.name})${isDefective ? ' — defective: ' + light.defective_channels.toUpperCase() : ''}`,
    };
  };

  return <PreviewStrip walls={walls} getCell={getCell} />;
}

export default memo(LiveLightPreview);
