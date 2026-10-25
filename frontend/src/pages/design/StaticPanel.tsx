import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Design, LayoutData, RGBW } from '../../types';
import { rgbwToCss } from '../../utils/color';
import { useIsMobile } from '../../hooks/useMediaQuery';
import ColorPicker from './ColorPicker';
import SavedList from './SavedList';
import type { FolderControls } from './Folders';
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
  onMoveDesign: (id: string, folder: string | null) => Promise<void>;
  folders: FolderControls;
}

export default function StaticPanel({
  editor, layout, designs, sidebarHeader, currentColor, setCurrentColor, hasRGBW,
  onSaveAs, onRenameDesign, onDeleteDesign, onMoveDesign, folders,
}: StaticPanelProps) {
  const { selectedDesign, hasChanges } = editor;
  return (
    <div className="design-layout">
      <div className="design-sidebar">
        {sidebarHeader}
        <SavedList
          title="Saved Designs"
          items={designs.filter((d) => d.type === 'static')}
          selectedId={selectedDesign?.id}
          onSelect={(id) => { const d = designs.find((x) => x.id === id); if (d) editor.load(d); }}
          onRename={onRenameDesign}
          onDelete={onDeleteDesign}
          scope="static"
          folders={folders}
          onMove={onMoveDesign}
        />
      </div>

      <StaticDesignEditor
        editor={editor}
        layout={layout}
        currentColor={currentColor}
        setCurrentColor={setCurrentColor}
        hasRGBW={hasRGBW}
        toolbar={
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
            {/* Keeps the row's height while it's empty, so the first paint stroke doesn't push the grid down mid-drag */}
            {!selectedDesign && !hasChanges && <button type="button" className="btn btn-sm btn-placeholder" aria-hidden="true" tabIndex={-1} disabled>Clear</button>}
          </div>
        }
      />
    </div>
  );
}

interface StaticDesignEditorProps {
  editor: StaticEditor;
  layout: LayoutData;
  currentColor: RGBW;
  setCurrentColor: (color: RGBW) => void;
  hasRGBW: boolean;
  // Buttons above the grid (New / Save / Cancel ...), supplied by whoever hosts the editor
  toolbar?: ReactNode;
}

/**
 * The static painter: wall grids, copy-wall buttons and the color picker. Renders the editor
 * column and the picker column, for a `.design-layout` around it (the Static tab, or inline in
 * the scene editor).
 */
export function StaticDesignEditor({ editor, layout, currentColor, setCurrentColor, hasRGBW, toolbar }: StaticDesignEditorProps) {
  const { colors, colorTool } = editor;
  const [selectedLights, setSelectedLights] = useState<Set<number>>(new Set());
  // Drag-to-paint state; refs because pointermove reads them between renders
  const draggingRef = useRef(false);
  const lastPaintedRef = useRef<number | null>(null);
  const isMobile = useIsMobile();
  // Phones show one wall at a time so the cells stay big enough to tap
  const [mobileWallId, setMobileWallId] = useState<string | null>(null);

  // Stop painting on pointerup anywhere; clicking outside the grid/picker clears the selection
  useEffect(() => {
    const handlePointerUp = () => {
      draggingRef.current = false;
      lastPaintedRef.current = null;
    };
    const handleDeselect = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.light-cell') && !target.closest('.color-window')) {
        setSelectedLights(new Set());
      }
    };
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerUp);
    document.addEventListener('mousedown', handleDeselect);
    return () => {
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerUp);
      document.removeEventListener('mousedown', handleDeselect);
    };
  }, []);

  const paintLight = (lightId: number) => {
    lastPaintedRef.current = lightId;
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

  // Pointer events cover mouse, touch and pen alike. preventDefault stops text
  // selection and the emulated mousedown that would clear the selection.
  const handleLightPointerDown = (lightId: number, e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (colorTool === 'apply') {
      draggingRef.current = true;
      paintLight(lightId);
    } else {
      pickupColor(lightId);
    }
  };

  // Touch pointers stay captured by the cell they started on, so find the cell
  // under the finger rather than relying on enter/leave events
  const handleGridPointerMove = (e: ReactPointerEvent) => {
    if (!draggingRef.current || colorTool !== 'apply') return;
    const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-light-id]');
    const id = cell ? Number(cell.dataset.lightId) : NaN;
    if (Number.isFinite(id) && id !== lastPaintedRef.current) paintLight(id);
  };

  // Picker changes also recolor the selected lights
  const handleColorChange = (color: RGBW) => {
    setCurrentColor(color);
    if (selectedLights.size > 0) editor.paint(selectedLights, color);
  };

  const eastWall = layout.walls.find((w) => w.name === 'East');
  const southWall = layout.walls.find((w) => w.name === 'South');
  const mobileWall = layout.walls.find((w) => w.id === mobileWallId) ?? layout.walls[0];
  const shownWalls = isMobile && mobileWall ? [mobileWall] : layout.walls;
  const copyButtonStyle = { padding: '0.2rem 0.5rem', fontSize: '0.7rem' };

  return (
    <>
      <div className="design-main">
        {toolbar}
        {isMobile && layout.walls.length > 1 && (
          <div className="wall-switcher" role="group" aria-label="Wall">
            {layout.walls.map((wall) => (
              <button
                key={wall.id}
                type="button"
                className={wall.id === mobileWall?.id ? 'active' : ''}
                aria-pressed={wall.id === mobileWall?.id}
                onClick={() => setMobileWallId(wall.id)}
              >
                {wall.name}
              </button>
            ))}
          </div>
        )}
        <div className={`matrix-walls-wrap${isMobile ? ' matrix-walls-mobile' : ''}`} onPointerMove={handleGridPointerMove}>
          {shownWalls.map((wall) => (
            <div
              key={wall.id}
              className="wall-group"
              style={isMobile ? undefined : { flex: `${wall.width} 0 0`, minWidth: `${wall.width * 4}%` }}
            >
              <div className="wall-group-label">
                <span>{wall.name}</span>
                {isMobile && <span className="wall-group-size">{wall.width}×{wall.height}</span>}
                {wall.name === 'West' && eastWall && <button className="btn btn-secondary btn-sm" style={copyButtonStyle} onClick={() => editor.copyWall(wall, eastWall)}>Copy to East</button>}
                {wall.name === 'North' && southWall && <button className="btn btn-secondary btn-sm" style={copyButtonStyle} onClick={() => editor.copyWall(wall, southWall)}>Copy to South</button>}
              </div>
              <div
                className="light-grid light-grid-paint"
                style={{
                  gridTemplateColumns: `repeat(${wall.width}, ${isMobile ? 'minmax(0, 1fr)' : '1fr'})`,
                  // Narrow walls (3 wide) shouldn't stretch into giant tiles on phones
                  maxWidth: isMobile ? `${wall.width * 72}px` : undefined,
                }}
              >
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
                        data-light-id={id}
                        className={`light-cell${selected ? ' selected' : ''}`}
                        style={{ backgroundColor: rgbwToCss(colors[id]), cursor: colorTool === 'pickup' ? 'crosshair' : 'pointer' }}
                        role="button"
                        tabIndex={0}
                        aria-label={`Light ${id} (${wall.name})${colorTool === 'pickup' ? ': pick up color' : ': paint'}`}
                        aria-pressed={selected}
                        onPointerDown={(e) => handleLightPointerDown(id, e)}
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

      {/* Right Column: Color Picker (directly below the grid on phones) */}
      <div className="color-picker-column">
        <ColorPicker
          color={currentColor}
          onChange={handleColorChange}
          hasRGBW={hasRGBW}
          tool={colorTool}
          onToolChange={editor.setColorTool}
        />
      </div>
    </>
  );
}
