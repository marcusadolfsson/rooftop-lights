import { useState, useEffect } from 'react';
import { layoutAPI, artnetAPI } from '../utils/api';
import type { Wall, Light, ArtNetConfig, LayoutData } from '../types';

function LayoutPage() {
  const [layout, setLayout] = useState<LayoutData | null>(null);
  const [artnetConfig, setArtnetConfig] = useState<ArtNetConfig | null>(null);
  const [selectedLight, setSelectedLight] = useState<Light | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingWall, setEditingWall] = useState<Wall | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [layoutData, artnetData] = await Promise.all([
        layoutAPI.getLayout(),
        artnetAPI.getConfig(),
      ]);
      setLayout(layoutData);
      setArtnetConfig(artnetData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleArtnetSave = async () => {
    if (!artnetConfig) return;

    try {
      await artnetAPI.updateConfig(artnetConfig);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save ArtNet config');
    }
  };

  const handleTestArtnet = async () => {
    try {
      const result = await artnetAPI.test();
      setTestMessage(result.message);
      setTimeout(() => setTestMessage(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to test ArtNet');
    }
  };

  const handleLightClick = (light: Light) => {
    setSelectedLight(selectedLight?.id === light.id ? null : light);
  };

  const handleLightUpdate = async (lightId: string, updates: Partial<Light>) => {
    try {
      await layoutAPI.updateLight(lightId, updates);
      await loadData();
      setSelectedLight(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update light');
    }
  };

  const handleWallUpdate = async (wallId: string, updates: Partial<Wall>) => {
    try {
      await layoutAPI.updateWall(wallId, updates);
      await loadData();
      setEditingWall(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update wall');
    }
  };

  const rgbwToStyle = (light: Light): string => {
    // Generate a visual representation of the light position
    const hue = (light.light_id * 3.75) % 360;
    return `hsl(${hue}, 60%, 40%)`;
  };

  if (loading) {
    return <div className="page-header"><h1>Loading...</h1></div>;
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Light Layout</h1>
      </div>

      {error && (
        <div className="card" style={{ backgroundColor: 'var(--error)', marginBottom: '1rem' }}>
          {error}
          <button className="btn btn-sm" onClick={() => setError(null)} style={{ marginLeft: '1rem' }}>
            Dismiss
          </button>
        </div>
      )}

      {testMessage && (
        <div className="card" style={{ backgroundColor: 'var(--success)', marginBottom: '1rem' }}>
          {testMessage}
        </div>
      )}

      {/* ArtNet Configuration */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">ArtNet Configuration</h2>
          <div className="btn-group">
            <button className="btn btn-secondary btn-sm" onClick={handleTestArtnet}>
              Test Flash
            </button>
            <button className="btn btn-primary btn-sm" onClick={handleArtnetSave}>
              Save
            </button>
          </div>
        </div>

        {artnetConfig && (
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Mode</label>
              <select
                className="form-select"
                value={artnetConfig.mode}
                onChange={(e) =>
                  setArtnetConfig({ ...artnetConfig, mode: e.target.value as 'multicast' | 'unicast' })
                }
              >
                <option value="multicast">Multicast (Broadcast)</option>
                <option value="unicast">Unicast (Specific IP)</option>
              </select>
            </div>

            {artnetConfig.mode === 'unicast' && (
              <div className="form-group">
                <label className="form-label">Unicast IP Address</label>
                <input
                  type="text"
                  className="form-input"
                  value={artnetConfig.unicastAddress || ''}
                  onChange={(e) =>
                    setArtnetConfig({ ...artnetConfig, unicastAddress: e.target.value })
                  }
                  placeholder="192.168.1.100"
                />
              </div>
            )}

            <div className="form-group">
              <label className="form-label">Universe</label>
              <input
                type="number"
                className="form-input"
                value={artnetConfig.universe}
                onChange={(e) =>
                  setArtnetConfig({ ...artnetConfig, universe: parseInt(e.target.value) || 0 })
                }
                min="0"
                max="32767"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Refresh Rate: {artnetConfig.refreshRate} FPS</label>
              <input
                type="range"
                className="form-input"
                value={artnetConfig.refreshRate}
                onChange={(e) =>
                  setArtnetConfig({ ...artnetConfig, refreshRate: parseInt(e.target.value) || 40 })
                }
                min="1"
                max="44"
                style={{ padding: 0 }}
              />
              <small style={{ color: 'var(--text-secondary)', display: 'block', marginTop: '0.25rem' }}>
                1-44 FPS (40 recommended for motion effects)
              </small>
            </div>
          </div>
        )}
      </div>

      {/* Layout Summary */}
      {layout && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Layout Summary</h2>
          </div>
          <div className="form-row">
            <div>
              <strong>Total Lights:</strong> {layout.totalLights}
            </div>
            <div>
              <strong>Total DMX Channels:</strong> {layout.totalDMXChannels}
            </div>
            <div>
              <strong>Walls:</strong> {layout.walls.length}
            </div>
          </div>
        </div>
      )}

      {/* Wall Sections */}
      {layout && (
        <div className="matrix-container">
          {layout.walls.map((wall) => (
            <div key={wall.id} className="wall-section">
              <div className="wall-header">
                <div>
                  <h3 className="wall-title">{wall.name}</h3>
                  <span className="wall-info">
                    {wall.width}x{wall.height} • {wall.width * wall.height} lights
                    {wall.connects_to_next ? ' • Connects to next' : ''}
                  </span>
                </div>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setEditingWall(wall)}
                >
                  Edit Wall
                </button>
              </div>

              <div
                className="light-grid"
                style={{
                  gridTemplateColumns: `repeat(${wall.width}, 40px)`,
                }}
              >
                {/* Render from top row (height-1) to bottom row (0) */}
                {Array.from({ length: wall.height }, (_, rowIdx) => {
                  const y = wall.height - 1 - rowIdx;
                  return Array.from({ length: wall.width }, (_, x) => {
                    const light = wall.matrix?.[y]?.[x];
                    if (!light) return <div key={`${y}-${x}`} className="light-cell" />;

                    return (
                      <div
                        key={light.id}
                        className={`light-cell ${selectedLight?.id === light.id ? 'selected' : ''}`}
                        style={{ backgroundColor: rgbwToStyle(light) }}
                        onClick={() => handleLightClick(light)}
                        title={`Light #${light.light_id}\nDMX: ${light.dmx_start_channel}-${light.dmx_start_channel + (light.light_type === 'RGBW' ? 3 : 2)}`}
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

      {/* Light Editor Modal */}
      {selectedLight && (
        <div className="modal-overlay" onClick={() => setSelectedLight(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Edit Light #{selectedLight.light_id}</h3>
              <button className="modal-close" onClick={() => setSelectedLight(null)}>
                &times;
              </button>
            </div>

            <div className="form-group">
              <label className="form-label">Light ID</label>
              <input
                type="number"
                className="form-input"
                value={selectedLight.light_id}
                onChange={(e) =>
                  setSelectedLight({ ...selectedLight, light_id: parseInt(e.target.value) || 1 })
                }
                min="1"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Light Type</label>
              <select
                className="form-select"
                value={selectedLight.light_type}
                onChange={(e) =>
                  setSelectedLight({ ...selectedLight, light_type: e.target.value as 'RGB' | 'RGBW' })
                }
              >
                <option value="RGBW">RGBW (4 channels)</option>
                <option value="RGB">RGB (3 channels)</option>
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">DMX Start Channel</label>
              <input
                type="number"
                className="form-input"
                value={selectedLight.dmx_start_channel}
                onChange={(e) =>
                  setSelectedLight({
                    ...selectedLight,
                    dmx_start_channel: parseInt(e.target.value) || 1,
                  })
                }
                min="1"
                max="512"
              />
              <small style={{ color: 'var(--text-secondary)' }}>
                Calculated: ((Light ID - 1) * {selectedLight.light_type === 'RGBW' ? 4 : 3}) + 1 ={' '}
                {(selectedLight.light_id - 1) * (selectedLight.light_type === 'RGBW' ? 4 : 3) + 1}
              </small>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setSelectedLight(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => handleLightUpdate(selectedLight.id, selectedLight)}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Wall Editor Modal */}
      {editingWall && (
        <div className="modal-overlay" onClick={() => setEditingWall(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Edit Wall: {editingWall.name}</h3>
              <button className="modal-close" onClick={() => setEditingWall(null)}>
                &times;
              </button>
            </div>

            <div className="form-group">
              <label className="form-label">Name</label>
              <input
                type="text"
                className="form-input"
                value={editingWall.name}
                onChange={(e) => setEditingWall({ ...editingWall, name: e.target.value })}
              />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Width</label>
                <input
                  type="number"
                  className="form-input"
                  value={editingWall.width}
                  onChange={(e) =>
                    setEditingWall({ ...editingWall, width: parseInt(e.target.value) || 1 })
                  }
                  min="1"
                />
              </div>

              <div className="form-group">
                <label className="form-label">Height</label>
                <input
                  type="number"
                  className="form-input"
                  value={editingWall.height}
                  onChange={(e) =>
                    setEditingWall({ ...editingWall, height: parseInt(e.target.value) || 1 })
                  }
                  min="1"
                />
              </div>
            </div>

            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  checked={editingWall.connects_to_next}
                  onChange={(e) =>
                    setEditingWall({ ...editingWall, connects_to_next: e.target.checked })
                  }
                />
                Connects to next wall (for continuous motion effects)
              </label>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setEditingWall(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => handleWallUpdate(editingWall.id, editingWall)}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default LayoutPage;
