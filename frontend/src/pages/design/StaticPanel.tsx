import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { Design, LayoutData, RGBW } from '../../types';
import { rgbwToCss } from '../../utils/color';
import ColorPicker from './ColorPicker';
import SavedList from './SavedList';
import type { StaticEditor } from './editors';

interface StaticPanelProps {
  editor: StaticEditor;
  layout: LayoutData;
  designs: Design[];
  sidebarHeader: ReactNode;
  currentColor: RGBW;
  setCurrentColor: (color: RGBW) => void;
  hasRGBW: boolean;
  onSaveAs: () => void;
  onRenameDesign: (id: string, name: string) => Promise<void>;
  onDeleteDesign: (id: string) => void;
}

export default function StaticPanel({
  editor, layout, designs, sidebarHeader, currentColor, setCurrentColor, hasRGBW,
  onSaveAs, onRenameDesign, onDeleteDesign,
}: StaticPanelProps) {
  const { selectedDesign, colors, hasChanges, colorTool } = editor;
  const [selectedLights, setSelectedLights] = useState<Set<number>>(new Set());
  const [isDragging, setIsDragging] = useState(false);

  // Stop painting on mouseup anywhere; clicking outside the grid/picker clears the selection
  useEffect(() => {
    const handleMouseUp = () => setIsDragging(false);
    const handleDeselect = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.light-cell') && !target.closest('.color-window')) {
        setSelectedLights(new Set());
      }
    };
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousedown', handleDeselect);
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleDeselect);
    };
  }, []);

  const paintLight = (lightId: number) => {
    editor.paint([lightId], currentColor);
    setSelectedLights((prev) => new Set(prev).add(lightId));
  };

  const pickupColor = (lightId: number) => {
    const color = colors[lightId];
    if (color) setCurrentColor({ ...color });
  };

  const handleLightActivate = (lightId: number) => {
    if (colorTool === 'pickup') pickupColor(lightId);
    else paintLight(lightId);
  };

  const handleLightMouseDown = (lightId: number, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (colorTool === 'apply') {
      setIsDragging(true);
      paintLight(lightId);
    } else {
      pickupColor(lightId);
    }
  };

  const handleLightMouseEnter = (lightId: number) => {
    if (isDragging && colorTool === 'apply') paintLight(lightId);
  };

  // Picker changes also recolor the selected lights
  const handleColorChange = (color: RGBW) => {
    setCurrentColor(color);
    if (selectedLights.size > 0) editor.paint(selectedLights, color);
  };

  const eastWall = layout.walls.find((w) => w.name === 'East');
  const southWall = layout.walls.find((w) => w.name === 'South');

  return (
    <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
      <div className="design-sidebar">
        {sidebarHeader}
        <SavedList
          title="Saved Designs"
          items={designs.filter((d) => d.type === 'static')}
          selectedId={selectedDesign?.id}
          onSelect={(id) => { const d = designs.find((x) => x.id === id); if (d) editor.load(d); }}
          onRename={onRenameDesign}
          onDelete={onDeleteDesign}
        />
      </div>

      {/* Center: Light Matrix */}
      <div style={{ flex: 1 }}>
        <div className="btn-group" style={{ marginBottom: '0.5rem' }}>
          {selectedDesign ? (
            <button className="btn btn-primary btn-sm" onClick={editor.startNew}>New</button>
          ) : (
            hasChanges && <button className="btn btn-secondary btn-sm" onClick={editor.startNew}>Clear</button>
          )}
          {hasChanges && selectedDesign && <button className="btn btn-primary btn-sm" onClick={editor.save}>Save</button>}
          {hasChanges && selectedDesign && <button className="btn btn-secondary btn-sm" onClick={onSaveAs}>Save As</button>}
          {hasChanges && !selectedDesign && <button className="btn btn-primary btn-sm" onClick={onSaveAs}>Save</button>}
          {selectedDesign && hasChanges && <button className="btn btn-secondary btn-sm" onClick={editor.cancel}>Cancel</button>}
        </div>
        <div className="matrix-walls-wrap">
          {layout.walls.map((wall) => (
            <div key={wall.id} className="wall-group" style={{ flex: `${wall.width} 0 0`, minWidth: `${wall.width * 4}%` }}>
              <div className="wall-group-label">
                <span>{wall.name}</span>
                {wall.name === 'West' && eastWall && <button className="btn btn-secondary btn-sm" style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem' }} onClick={() => editor.copyWall(wall, eastWall)}>Copy to East</button>}
                {wall.name === 'North' && southWall && <button className="btn btn-secondary btn-sm" style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem' }} onClick={() => editor.copyWall(wall, southWall)}>Copy to South</button>}
              </div>
              <div className="light-grid" style={{ gridTemplateColumns: `repeat(${wall.width}, 1fr)` }}>
                {Array.from({ length: wall.height }, (_, rowIdx) => {
                  const y = wall.height - 1 - rowIdx;
                  return Array.from({ length: wall.width }, (_, x) => {
                    const light = wall.matrix?.[y]?.[x];
                    if (!light) return <div key={`${y}-${x}`} className="light-cell" />;
                    const id = light.light_id;
                    const selected = selectedLights.has(id);
                    return (
                      <div
                        key={light.id}
                        className={`light-cell${selected ? ' selected' : ''}`}
                        style={{ backgroundColor: rgbwToCss(colors[id]), cursor: colorTool === 'pickup' ? 'crosshair' : 'pointer' }}
                        role="button"
                        tabIndex={0}
                        aria-label={`Light ${id} (${wall.name})${colorTool === 'pickup' ? ': pick up color' : ': paint'}`}
                        aria-pressed={selected}
                        onMouseDown={(e) => handleLightMouseDown(id, e)}
                        onMouseEnter={() => handleLightMouseEnter(id)}
                        onClick={() => handleLightActivate(id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleLightActivate(id);
                          }
                        }}
                      >
                        {id}
                      </div>
                    );
                  });
                }).flat()}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right Column: Color Picker */}
      <div className="color-picker-column">
        <ColorPicker
          color={currentColor}
          onChange={handleColorChange}
          hasRGBW={hasRGBW}
          tool={colorTool}
          onToolChange={editor.setColorTool}
        />
      </div>
    </div>
  );
}
