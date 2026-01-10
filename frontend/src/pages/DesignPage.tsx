import { useState, useEffect } from 'react';
import { HexColorPicker } from 'react-colorful';
import { layoutAPI, designsAPI, playlistsAPI, previewAPI, aiAPI } from '../utils/api';
import { useWebSocket } from '../hooks/useWebSocket';
import type {
  Design,
  EffectType,
  Playlist,
  RGBW,
  Wall,
  LayoutData,
  StaticDesignData,
  MotionDesignData,
} from '../types';

type TabType = 'static' | 'motion' | 'playlist';

function DesignPage() {
  const { frameData } = useWebSocket();
  const [activeTab, setActiveTab] = useState<TabType>('static');
  const [layout, setLayout] = useState<LayoutData | null>(null);
  const [designs, setDesigns] = useState<Design[]>([]);
  const [effectTypes, setEffectTypes] = useState<EffectType[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Static mode state
  const [selectedDesign, setSelectedDesign] = useState<Design | null>(null);
  const [currentColors, setCurrentColors] = useState<Record<number, RGBW>>({});
  const [selectedLights, setSelectedLights] = useState<Set<number>>(new Set());
  const [currentColor, setCurrentColor] = useState<RGBW>({ r: 255, g: 255, b: 255, w: 255 });
  const [isDragging, setIsDragging] = useState(false);

  // Motion mode state
  const [selectedEffect, setSelectedEffect] = useState<EffectType | null>(null);
  const [motionColors, setMotionColors] = useState<RGBW[]>([]);
  const [motionParams, setMotionParams] = useState<Record<string, number | boolean>>({});

  // Playlist mode state
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [playlistName, setPlaylistName] = useState('');
  const [playlistMode, setPlaylistMode] = useState<'sequence' | 'random'>('sequence');

  // Preview state
  const [isLivePreview, setIsLivePreview] = useState(false);

  // Modal state
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveAsName, setSaveAsName] = useState('');

  // AI Designer state
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiDescription, setAiDescription] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [showAiPanel, setShowAiPanel] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [layoutData, designsData, effectsData, playlistsData, aiStatus] = await Promise.all([
        layoutAPI.getLayout(),
        designsAPI.getAll(),
        designsAPI.getEffectTypes(),
        playlistsAPI.getAll(),
        aiAPI.getStatus().catch(() => ({ enabled: false })),
      ]);
      setLayout(layoutData);
      setDesigns(designsData);
      setEffectTypes(effectsData);
      setPlaylists(playlistsData);
      setAiEnabled(aiStatus.enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  // Static mode functions
  const loadDesign = (design: Design) => {
    setSelectedDesign(design);
    if (design.type === 'static') {
      const data = design.data as StaticDesignData;
      setCurrentColors(data.colors || {});
    }
    setSelectedLights(new Set());
  };

  const handleLightClick = (lightId: number) => {
    if (isDragging) {
      // Apply current color while dragging
      setCurrentColors((prev) => ({
        ...prev,
        [lightId]: { ...currentColor },
      }));
    } else {
      // Toggle selection
      setSelectedLights((prev) => {
        const newSet = new Set(prev);
        if (newSet.has(lightId)) {
          newSet.delete(lightId);
        } else {
          newSet.add(lightId);
        }
        return newSet;
      });
    }
  };

  const handleLightMouseDown = (lightId: number, e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    setCurrentColors((prev) => ({
      ...prev,
      [lightId]: { ...currentColor },
    }));
  };

  const handleLightMouseEnter = (lightId: number) => {
    if (isDragging) {
      setCurrentColors((prev) => ({
        ...prev,
        [lightId]: { ...currentColor },
      }));
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, []);

  const applyColorToSelected = () => {
    if (selectedLights.size === 0) return;

    setCurrentColors((prev) => {
      const newColors = { ...prev };
      selectedLights.forEach((lightId) => {
        newColors[lightId] = { ...currentColor };
      });
      return newColors;
    });
    setSelectedLights(new Set());
  };

  const copyWallDesign = (fromWall: Wall, toWall: Wall) => {
    if (!layout) return;

    const fromMatrix = fromWall.matrix;
    const toMatrix = toWall.matrix;

    if (!fromMatrix || !toMatrix) return;

    setCurrentColors((prev) => {
      const newColors = { ...prev };

      // Copy colors based on relative position
      for (let y = 0; y < Math.min(fromWall.height, toWall.height); y++) {
        for (let x = 0; x < Math.min(fromWall.width, toWall.width); x++) {
          const fromLight = fromMatrix[y]?.[x];
          const toLight = toMatrix[y]?.[x];

          if (fromLight && toLight && prev[fromLight.light_id]) {
            newColors[toLight.light_id] = { ...prev[fromLight.light_id] };
          }
        }
      }

      return newColors;
    });
  };

  const handleSaveDesign = async () => {
    if (!selectedDesign) {
      setShowSaveModal(true);
      return;
    }

    try {
      if (activeTab === 'static') {
        await designsAPI.update(selectedDesign.id, {
          name: selectedDesign.name,
          data: { colors: currentColors },
        });
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save design');
    }
  };

  const handleSaveAs = async () => {
    if (!saveAsName.trim()) return;

    try {
      if (activeTab === 'static') {
        await designsAPI.create({
          name: saveAsName,
          type: 'static',
          data: { colors: currentColors },
        });
      } else if (activeTab === 'motion' && selectedEffect) {
        await designsAPI.create({
          name: saveAsName,
          type: 'motion',
          data: {
            type: selectedEffect.type,
            colors: motionColors,
            params: motionParams,
            speed: 1,
            scope: 'all',
          },
        });
      }
      await loadData();
      setShowSaveModal(false);
      setSaveAsName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save design');
    }
  };

  const handleDeleteDesign = async (designId: string) => {
    if (!confirm('Are you sure you want to delete this design?')) return;

    try {
      await designsAPI.delete(designId);
      if (selectedDesign?.id === designId) {
        setSelectedDesign(null);
        setCurrentColors({});
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete design');
    }
  };

  // Motion mode functions
  const selectEffect = (effect: EffectType) => {
    setSelectedEffect(effect);
    setMotionColors([...effect.defaultColors]);
    const params: Record<string, number | boolean> = {};
    Object.entries(effect.params).forEach(([key, param]) => {
      params[key] = param.default;
    });
    setMotionParams(params);
  };

  // Playlist mode functions
  const createPlaylist = async () => {
    if (!playlistName.trim()) return;

    try {
      const playlist = await playlistsAPI.create({
        name: playlistName,
        play_mode: playlistMode,
      });
      await loadData();
      setSelectedPlaylist(playlist);
      setPlaylistName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create playlist');
    }
  };

  const addToPlaylist = async (designId: string, duration: number = 10) => {
    if (!selectedPlaylist) return;

    try {
      await playlistsAPI.addItem(selectedPlaylist.id, { design_id: designId, duration });
      await loadData();
      // Refresh selected playlist
      const updated = await playlistsAPI.get(selectedPlaylist.id);
      setSelectedPlaylist(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add to playlist');
    }
  };

  const removeFromPlaylist = async (itemId: string) => {
    if (!selectedPlaylist) return;

    try {
      await playlistsAPI.removeItem(selectedPlaylist.id, itemId);
      const updated = await playlistsAPI.get(selectedPlaylist.id);
      setSelectedPlaylist(updated);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove from playlist');
    }
  };

  const deletePlaylist = async (playlistId: string) => {
    if (!confirm('Are you sure you want to delete this playlist?')) return;

    try {
      await playlistsAPI.delete(playlistId);
      if (selectedPlaylist?.id === playlistId) {
        setSelectedPlaylist(null);
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete playlist');
    }
  };

  // Preview functions
  const toggleLivePreview = async () => {
    try {
      if (isLivePreview) {
        await previewAPI.stop();
        setIsLivePreview(false);
      } else {
        if (activeTab === 'static') {
          await previewAPI.start({
            designType: 'static',
            designData: { colors: currentColors },
          });
        } else if (activeTab === 'motion' && selectedEffect) {
          await previewAPI.previewEffect({
            effectType: selectedEffect.type,
            colors: motionColors,
            params: motionParams,
          });
        } else if (activeTab === 'playlist' && selectedPlaylist) {
          await previewAPI.startPlaylist(selectedPlaylist.id);
        }
        setIsLivePreview(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle preview');
    }
  };

  // AI generation function
  const generateAIDesign = async () => {
    if (!aiDescription.trim()) return;

    setAiLoading(true);
    setAiError(null);

    try {
      const result = await aiAPI.generate(aiDescription);

      if (result.success && result.design) {
        // Reload designs to get the new one
        await loadData();

        // Find and select the new design
        const newDesign = designs.find((d) => d.id === result.designId);
        if (newDesign) {
          loadDesign(newDesign);
        }

        // Switch to appropriate tab
        if (result.design.type === 'static') {
          setActiveTab('static');
          // Load colors for static design
          if (result.design.colors) {
            const colorMap: Record<number, RGBW> = {};
            result.design.colors.forEach((color, idx) => {
              colorMap[idx + 1] = color;
            });
            setCurrentColors(colorMap);
          }
        } else {
          setActiveTab('motion');
        }

        setAiDescription('');
        setShowAiPanel(false);
      } else {
        setAiError(result.error || 'Failed to generate design');
      }
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Failed to generate design');
    } finally {
      setAiLoading(false);
    }
  };

  // Helper functions
  const rgbwToHex = (color: RGBW): string => {
    const r = Math.round(color.r);
    const g = Math.round(color.g);
    const b = Math.round(color.b);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  };

  const hexToRgbw = (hex: string, w: number = 0): RGBW => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16),
          w,
        }
      : { r: 0, g: 0, b: 0, w: 0 };
  };

  const getLightColor = (lightId: number): string => {
    // Use live frame data if preview is active, otherwise use design colors
    const color = isLivePreview && frameData[lightId] ? frameData[lightId] : currentColors[lightId];

    if (!color) return '#222';

    // Combine RGB and W for display
    const r = Math.min(255, color.r + color.w);
    const g = Math.min(255, color.g + color.w);
    const b = Math.min(255, color.b + color.w);

    return `rgb(${r}, ${g}, ${b})`;
  };

  if (loading) {
    return <div className="page-header"><h1>Loading...</h1></div>;
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Design</h1>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          {aiEnabled && (
            <button
              className={`btn ${showAiPanel ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setShowAiPanel(!showAiPanel)}
            >
              AI Designer
            </button>
          )}
          <div className="live-preview-toggle">
            <span>Live Preview</span>
            <div
              className={`toggle-switch ${isLivePreview ? 'active' : ''}`}
              onClick={toggleLivePreview}
            />
          </div>
        </div>
      </div>

      {/* AI Designer Panel */}
      {showAiPanel && aiEnabled && (
        <div className="card" style={{ marginBottom: '1rem', borderLeft: '4px solid var(--primary)' }}>
          <div className="card-header">
            <h3 className="card-title">AI Design Generator</h3>
            <button className="btn btn-sm btn-secondary" onClick={() => setShowAiPanel(false)}>
              Close
            </button>
          </div>
          <p style={{ marginBottom: '1rem', color: 'var(--text-secondary)' }}>
            Describe the light show you want and AI will generate it for you.
          </p>
          <div className="form-group">
            <textarea
              className="form-input"
              rows={3}
              value={aiDescription}
              onChange={(e) => setAiDescription(e.target.value)}
              placeholder="e.g., 'A warm sunset gradient fading from orange on the west wall to purple on the east' or 'Christmas lights with red and green candy cane stripes moving slowly'"
              disabled={aiLoading}
              style={{ resize: 'vertical' }}
            />
          </div>
          {aiError && (
            <div style={{ color: 'var(--error)', marginBottom: '1rem' }}>
              {aiError}
            </div>
          )}
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button
              className="btn btn-primary"
              onClick={generateAIDesign}
              disabled={aiLoading || !aiDescription.trim()}
            >
              {aiLoading ? 'Generating...' : 'Generate Design'}
            </button>
            {aiLoading && (
              <span style={{ color: 'var(--text-secondary)' }}>
                This may take a few seconds...
              </span>
            )}
          </div>
          <div style={{ marginTop: '1rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
            <strong>Tips:</strong>
            <ul style={{ marginTop: '0.5rem', marginLeft: '1.5rem' }}>
              <li>For static designs: describe colors, gradients, patterns, or zones</li>
              <li>For motion effects: mention movement like "moving", "chasing", "pulsing", "twinkling"</li>
              <li>Reference walls (West, North, East, South) for specific placement</li>
              <li>Describe moods: "warm", "cool", "festive", "calm", "energetic"</li>
            </ul>
          </div>
        </div>
      )}

      {error && (
        <div className="card" style={{ backgroundColor: 'var(--error)', marginBottom: '1rem' }}>
          {error}
          <button className="btn btn-sm" onClick={() => setError(null)} style={{ marginLeft: '1rem' }}>
            Dismiss
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="tabs">
        <button
          className={`tab ${activeTab === 'static' ? 'active' : ''}`}
          onClick={() => setActiveTab('static')}
        >
          Static
        </button>
        <button
          className={`tab ${activeTab === 'motion' ? 'active' : ''}`}
          onClick={() => setActiveTab('motion')}
        >
          Motion
        </button>
        <button
          className={`tab ${activeTab === 'playlist' ? 'active' : ''}`}
          onClick={() => setActiveTab('playlist')}
        >
          Playlist
        </button>
      </div>

      {/* Static Mode */}
      {activeTab === 'static' && (
        <div>
          {/* Saved Designs */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Saved Designs</h3>
              <div className="btn-group">
                <button className="btn btn-secondary btn-sm" onClick={() => {
                  setSelectedDesign(null);
                  setCurrentColors({});
                }}>
                  New
                </button>
                <button className="btn btn-primary btn-sm" onClick={handleSaveDesign}>
                  Save
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => setShowSaveModal(true)}>
                  Save As
                </button>
              </div>
            </div>

            <div className="design-list">
              {designs
                .filter((d) => d.type === 'static')
                .map((design) => (
                  <div
                    key={design.id}
                    className={`design-item ${selectedDesign?.id === design.id ? 'selected' : ''}`}
                    onClick={() => loadDesign(design)}
                  >
                    <div className="design-item-name">{design.name}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="design-item-type">{design.type}</span>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteDesign(design.id);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>

          {/* Color Picker */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Color</h3>
              <button className="btn btn-primary btn-sm" onClick={applyColorToSelected}>
                Apply to Selected ({selectedLights.size})
              </button>
            </div>

            <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
              <div>
                <HexColorPicker
                  color={rgbwToHex(currentColor)}
                  onChange={(hex) => setCurrentColor({ ...hexToRgbw(hex), w: currentColor.w })}
                />
              </div>

              <div className="rgbw-sliders" style={{ flex: 1, minWidth: '200px' }}>
                <div className="rgbw-slider">
                  <label>
                    R
                    <input
                      type="range"
                      min="0"
                      max="255"
                      value={currentColor.r}
                      onChange={(e) =>
                        setCurrentColor({ ...currentColor, r: parseInt(e.target.value) })
                      }
                    />
                    <input
                      type="number"
                      min="0"
                      max="255"
                      value={currentColor.r}
                      onChange={(e) =>
                        setCurrentColor({ ...currentColor, r: parseInt(e.target.value) || 0 })
                      }
                    />
                  </label>
                </div>
                <div className="rgbw-slider">
                  <label>
                    G
                    <input
                      type="range"
                      min="0"
                      max="255"
                      value={currentColor.g}
                      onChange={(e) =>
                        setCurrentColor({ ...currentColor, g: parseInt(e.target.value) })
                      }
                    />
                    <input
                      type="number"
                      min="0"
                      max="255"
                      value={currentColor.g}
                      onChange={(e) =>
                        setCurrentColor({ ...currentColor, g: parseInt(e.target.value) || 0 })
                      }
                    />
                  </label>
                </div>
                <div className="rgbw-slider">
                  <label>
                    B
                    <input
                      type="range"
                      min="0"
                      max="255"
                      value={currentColor.b}
                      onChange={(e) =>
                        setCurrentColor({ ...currentColor, b: parseInt(e.target.value) })
                      }
                    />
                    <input
                      type="number"
                      min="0"
                      max="255"
                      value={currentColor.b}
                      onChange={(e) =>
                        setCurrentColor({ ...currentColor, b: parseInt(e.target.value) || 0 })
                      }
                    />
                  </label>
                </div>
                <div className="rgbw-slider">
                  <label>
                    W
                    <input
                      type="range"
                      min="0"
                      max="255"
                      value={currentColor.w}
                      onChange={(e) =>
                        setCurrentColor({ ...currentColor, w: parseInt(e.target.value) })
                      }
                    />
                    <input
                      type="number"
                      min="0"
                      max="255"
                      value={currentColor.w}
                      onChange={(e) =>
                        setCurrentColor({ ...currentColor, w: parseInt(e.target.value) || 0 })
                      }
                    />
                  </label>
                </div>

                <div
                  style={{
                    width: '100%',
                    height: '40px',
                    borderRadius: '4px',
                    marginTop: '1rem',
                    backgroundColor: `rgb(${Math.min(255, currentColor.r + currentColor.w)}, ${Math.min(255, currentColor.g + currentColor.w)}, ${Math.min(255, currentColor.b + currentColor.w)})`,
                  }}
                />
              </div>
            </div>
          </div>

          {/* Light Matrix */}
          {layout && (
            <div className="matrix-container">
              {layout.walls.map((wall) => (
                <div key={wall.id} className="wall-section">
                  <div className="wall-header">
                    <h3 className="wall-title">{wall.name}</h3>
                    <div className="btn-group">
                      {wall.name === 'West' && layout.walls.find((w) => w.name === 'East') && (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() =>
                            copyWallDesign(wall, layout.walls.find((w) => w.name === 'East')!)
                          }
                        >
                          Copy to East
                        </button>
                      )}
                      {wall.name === 'North' && layout.walls.find((w) => w.name === 'South') && (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() =>
                            copyWallDesign(wall, layout.walls.find((w) => w.name === 'South')!)
                          }
                        >
                          Copy to South
                        </button>
                      )}
                    </div>
                  </div>

                  <div
                    className="light-grid"
                    style={{
                      gridTemplateColumns: `repeat(${wall.width}, 40px)`,
                    }}
                  >
                    {Array.from({ length: wall.height }, (_, rowIdx) => {
                      const y = wall.height - 1 - rowIdx;
                      return Array.from({ length: wall.width }, (_, x) => {
                        const light = wall.matrix?.[y]?.[x];
                        if (!light) return <div key={`${y}-${x}`} className="light-cell" />;

                        return (
                          <div
                            key={light.id}
                            className={`light-cell ${selectedLights.has(light.light_id) ? 'selected' : ''}`}
                            style={{ backgroundColor: getLightColor(light.light_id) }}
                            onMouseDown={(e) => handleLightMouseDown(light.light_id, e)}
                            onMouseEnter={() => handleLightMouseEnter(light.light_id)}
                            onClick={() => handleLightClick(light.light_id)}
                          >
                            {light.light_id}
                          </div>
                        );
                      });
                    }).flat()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Motion Mode */}
      {activeTab === 'motion' && (
        <div>
          {/* Effect Types */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Effect Types</h3>
            </div>
            <div className="design-list">
              {effectTypes.map((effect) => (
                <div
                  key={effect.type}
                  className={`design-item ${selectedEffect?.type === effect.type ? 'selected' : ''}`}
                  onClick={() => selectEffect(effect)}
                >
                  <div className="design-item-name">{effect.name}</div>
                  <div className="design-item-type">{effect.description}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Effect Configuration */}
          {selectedEffect && (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Configure: {selectedEffect.name}</h3>
                <div className="btn-group">
                  <button className="btn btn-primary btn-sm" onClick={() => setShowSaveModal(true)}>
                    Save as Design
                  </button>
                </div>
              </div>

              {/* Colors */}
              {selectedEffect.defaultColors.length > 0 && (
                <div className="form-group">
                  <label className="form-label">Colors</label>
                  <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                    {motionColors.map((color, idx) => (
                      <div key={idx} style={{ textAlign: 'center' }}>
                        <div
                          style={{
                            width: '60px',
                            height: '60px',
                            borderRadius: '4px',
                            backgroundColor: `rgb(${Math.min(255, color.r + color.w)}, ${Math.min(255, color.g + color.w)}, ${Math.min(255, color.b + color.w)})`,
                            border: '2px solid var(--border-color)',
                            cursor: 'pointer',
                          }}
                          onClick={() => {
                            const hex = prompt('Enter hex color:', rgbwToHex(color));
                            if (hex) {
                              const newColors = [...motionColors];
                              newColors[idx] = hexToRgbw(hex, color.w);
                              setMotionColors(newColors);
                            }
                          }}
                        />
                        <small>Color {idx + 1}</small>
                        <div>
                          <input
                            type="range"
                            min="0"
                            max="255"
                            value={color.w}
                            onChange={(e) => {
                              const newColors = [...motionColors];
                              newColors[idx] = { ...color, w: parseInt(e.target.value) };
                              setMotionColors(newColors);
                            }}
                            style={{ width: '60px' }}
                          />
                          <small>W: {color.w}</small>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Parameters */}
              {Object.entries(selectedEffect.params).length > 0 && (
                <div className="form-group">
                  <label className="form-label">Parameters</label>
                  <div className="form-row">
                    {Object.entries(selectedEffect.params).map(([key, param]) => (
                      <div key={key} className="form-group">
                        <label className="form-label">{key}</label>
                        {param.type === 'number' ? (
                          <input
                            type="range"
                            className="form-input"
                            min={param.min}
                            max={param.max}
                            step={param.step || 1}
                            value={motionParams[key] as number}
                            onChange={(e) =>
                              setMotionParams({ ...motionParams, [key]: parseFloat(e.target.value) })
                            }
                          />
                        ) : (
                          <input
                            type="checkbox"
                            checked={motionParams[key] as boolean}
                            onChange={(e) =>
                              setMotionParams({ ...motionParams, [key]: e.target.checked })
                            }
                          />
                        )}
                        <span style={{ marginLeft: '0.5rem' }}>
                          {motionParams[key]?.toString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Saved Motion Designs */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Saved Motion Designs</h3>
            </div>
            <div className="design-list">
              {designs
                .filter((d) => d.type === 'motion')
                .map((design) => (
                  <div
                    key={design.id}
                    className={`design-item ${selectedDesign?.id === design.id ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedDesign(design);
                      const data = design.data as MotionDesignData;
                      const effect = effectTypes.find((e) => e.type === data.type);
                      if (effect) {
                        setSelectedEffect(effect);
                        setMotionColors(data.colors || effect.defaultColors);
                        setMotionParams((data.params as Record<string, number | boolean>) || {});
                      }
                    }}
                  >
                    <div className="design-item-name">{design.name}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="design-item-type">
                        {(design.data as MotionDesignData).type}
                      </span>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteDesign(design.id);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>

          {/* Preview */}
          {layout && (
            <div className="preview-container">
              <div className="preview-header">
                <h3 className="preview-title">Preview</h3>
              </div>
              <div className="preview-matrix">
                {layout.walls.map((wall) =>
                  wall.matrix?.flat().map((light) => (
                    <div
                      key={light?.id}
                      className="preview-light"
                      style={{
                        backgroundColor: light ? getLightColor(light.light_id) : '#222',
                      }}
                    />
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Playlist Mode */}
      {activeTab === 'playlist' && (
        <div>
          {/* Create Playlist */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Create New Playlist</h3>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Name</label>
                <input
                  type="text"
                  className="form-input"
                  value={playlistName}
                  onChange={(e) => setPlaylistName(e.target.value)}
                  placeholder="Playlist name"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Play Mode</label>
                <select
                  className="form-select"
                  value={playlistMode}
                  onChange={(e) => setPlaylistMode(e.target.value as 'sequence' | 'random')}
                >
                  <option value="sequence">Sequential</option>
                  <option value="random">Random</option>
                </select>
              </div>
              <div className="form-group" style={{ alignSelf: 'flex-end' }}>
                <button className="btn btn-primary" onClick={createPlaylist}>
                  Create
                </button>
              </div>
            </div>
          </div>

          {/* Playlists */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Playlists</h3>
            </div>
            <div className="design-list">
              {playlists.map((playlist) => (
                <div
                  key={playlist.id}
                  className={`design-item ${selectedPlaylist?.id === playlist.id ? 'selected' : ''}`}
                  onClick={() => setSelectedPlaylist(playlist)}
                >
                  <div className="design-item-name">{playlist.name}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="design-item-type">
                      {playlist.items.length} items • {playlist.play_mode}
                    </span>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        deletePlaylist(playlist.id);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Playlist Editor */}
          {selectedPlaylist && (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Edit: {selectedPlaylist.name}</h3>
              </div>

              <h4 style={{ marginBottom: '1rem' }}>Items</h4>
              <div className="playlist-items">
                {selectedPlaylist.items.map((item, idx) => (
                  <div key={item.id} className="playlist-item">
                    <span className="playlist-item-drag">{idx + 1}.</span>
                    <span className="playlist-item-name">
                      {item.design_name} ({item.design_type})
                    </span>
                    <input
                      type="number"
                      className="form-input playlist-item-duration"
                      value={item.duration}
                      min="1"
                      onChange={async (e) => {
                        // Update duration
                        await playlistsAPI.update(selectedPlaylist.id, {
                          name: selectedPlaylist.name,
                          play_mode: selectedPlaylist.play_mode,
                          items: selectedPlaylist.items.map((i) =>
                            i.id === item.id
                              ? { design_id: i.design_id, duration: parseInt(e.target.value) || 1 }
                              : { design_id: i.design_id, duration: i.duration }
                          ),
                        });
                        const updated = await playlistsAPI.get(selectedPlaylist.id);
                        setSelectedPlaylist(updated);
                      }}
                    />
                    <span>sec</span>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => removeFromPlaylist(item.id)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>

              <h4 style={{ marginTop: '1.5rem', marginBottom: '1rem' }}>Add Design</h4>
              <div className="design-list">
                {designs.map((design) => (
                  <div
                    key={design.id}
                    className="design-item"
                    onClick={() => addToPlaylist(design.id)}
                  >
                    <div className="design-item-name">{design.name}</div>
                    <div className="design-item-type">{design.type}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Save As Modal */}
      {showSaveModal && (
        <div className="modal-overlay" onClick={() => setShowSaveModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Save Design</h3>
              <button className="modal-close" onClick={() => setShowSaveModal(false)}>
                &times;
              </button>
            </div>

            <div className="form-group">
              <label className="form-label">Design Name</label>
              <input
                type="text"
                className="form-input"
                value={saveAsName}
                onChange={(e) => setSaveAsName(e.target.value)}
                placeholder="Enter design name"
                autoFocus
              />
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowSaveModal(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleSaveAs}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DesignPage;
