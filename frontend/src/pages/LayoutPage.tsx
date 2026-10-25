import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { layoutAPI, artnetAPI } from '../utils/api';
import type { Wall, WallGroup, Light, ArtNetConfig, LayoutData } from '../types';
import LightIdPreview from '../components/LightIdPreview';
import { useEscapeKey } from '../hooks/useEscapeKey';

function LayoutPage() {
  const location = useLocation();
  const isVisible = location.pathname === '/layout';
  const [layout, setLayout] = useState<LayoutData | null>(null);
  const [artnetConfig, setArtnetConfig] = useState<ArtNetConfig | null>(null);
  const [selectedLight, setSelectedLight] = useState<Light | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingWall, setEditingWall] = useState<Wall | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');

  // Esc closes whichever modal is open
  useEscapeKey(!!selectedLight, () => setSelectedLight(null));
  useEscapeKey(!!editingWall, () => setEditingWall(null));

  useEffect(() => {
    if (isVisible) {
      loadData();
    }
  }, [isVisible]);

  // Only the first load shows the loading screen; later refreshes happen in the background
  const loadData = async () => {
    try {
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

  const handleAddWall = async () => {
    if (!layout) return;
    try {
      const position = layout.walls.length;
      await layoutAPI.createWall({
        name: `Wall ${position + 1}`,
        width: 3,
        height: 3,
        position,
        connects_to_next: true,
      } as Omit<Wall, 'id'>);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add wall');
    }
  };

  const handleDeleteWall = async (wallId: string) => {
    if (!confirm('Are you sure you want to delete this wall and all its lights?')) return;
    try {
      await layoutAPI.deleteWall(wallId);
      setEditingWall(null);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete wall');
    }
  };

  const handleMoveWall = async (wallIndex: number, direction: 'up' | 'down') => {
    if (!layout) return;
    const walls = [...layout.walls];
    const swapIndex = direction === 'up' ? wallIndex - 1 : wallIndex + 1;
    if (swapIndex < 0 || swapIndex >= walls.length) return;

    // Swap positions in array
    [walls[wallIndex], walls[swapIndex]] = [walls[swapIndex], walls[wallIndex]];
    const wallIds = walls.map(w => w.id);

    try {
      await layoutAPI.reorderWalls(wallIds);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reorder walls');
    }
  };

  const handleWallGroupChange = async (wall: Wall, groupId: string | null) => {
    try {
      await layoutAPI.updateWall(wall.id, { ...wall, group_id: groupId });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update wall group');
    }
  };

  const handleAddGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    try {
      await layoutAPI.createGroup({ name });
      setNewGroupName('');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create group');
    }
  };

  const handleRenameGroup = async (groupId: string) => {
    const name = editingGroupName.trim();
    if (!name) return;
    try {
      await layoutAPI.updateGroup(groupId, { name });
      setEditingGroupId(null);
      setEditingGroupName('');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename group');
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    if (!confirm('Delete this group? Walls in it will become ungrouped.')) return;
    try {
      await layoutAPI.deleteGroup(groupId);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete group');
    }
  };

  const isLastWall = (wall: Wall): boolean => {
    if (!layout) return false;
    return layout.walls[layout.walls.length - 1]?.id === wall.id;
  };

  const rgbwToStyle = (light: Light): string => {
    const hue = (light.light_id * 3.75) % 360;
    return `hsl(${hue}, 60%, 40%)`;
  };

  // Group walls for display
  const getGroupedWalls = (): { group: WallGroup | null; walls: { wall: Wall; index: number }[] }[] => {
    if (!layout) return [];

    const groups = layout.groups || [];
    const result: { group: WallGroup | null; walls: { wall: Wall; index: number }[] }[] = [];

    // Grouped walls
    for (const group of groups) {
      const groupWalls = layout.walls
        .map((wall, index) => ({ wall, index }))
        .filter(({ wall }) => wall.group_id === group.id);
      if (groupWalls.length > 0) {
        result.push({ group, walls: groupWalls });
      }
    }

    // Ungrouped walls
    const ungrouped = layout.walls
      .map((wall, index) => ({ wall, index }))
      .filter(({ wall }) => !wall.group_id);
    if (ungrouped.length > 0) {
      result.push({ group: null, walls: ungrouped });
    }

    return result;
  };

  const renderWallSection = (wall: Wall, wallIndex: number) => (
    <div key={wall.id} className="wall-section">
      <div className="wall-header">
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <h3 className="wall-title" style={{ margin: 0 }}>{wall.name}</h3>
            {layout && layout.groups.length > 0 && (
              <select
                className="form-select"
                value={wall.group_id || ''}
                onChange={(e) => handleWallGroupChange(wall, e.target.value || null)}
                style={{ width: 'auto', padding: '0.15rem 0.4rem', fontSize: '0.75rem' }}
                title="Wall group"
              >
                <option value="">No Group</option>
                {layout.groups.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            )}
          </div>
          <span className="wall-info">
            {wall.width}x{wall.height} • {wall.width * wall.height} lights
            {wall.connects_to_next ? (isLastWall(wall) ? ' • Connects to first' : ' • Connects to next') : ''}
          </span>
        </div>
        <div className="btn-group">
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => handleMoveWall(wallIndex, 'up')}
            disabled={wallIndex === 0}
            title="Move up"
          >
            ↑
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => handleMoveWall(wallIndex, 'down')}
            disabled={layout ? wallIndex === layout.walls.length - 1 : true}
            title="Move down"
          >
            ↓
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setEditingWall(wall)}
          >
            Edit Wall
          </button>
        </div>
      </div>

      {/* Scrolls sideways on phones instead of widening the page */}
      <div className="light-grid-scroll">
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
                  className={`light-cell ${selectedLight?.id === light.id ? 'selected' : ''}`}
                  style={{ backgroundColor: rgbwToStyle(light), position: 'relative' }}
                  onClick={() => handleLightClick(light)}
                  role="button"
                  tabIndex={0}
                  aria-label={`Edit light ${light.light_id}${light.defective_channels ? ' (defective)' : ''}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleLightClick(light);
                    }
                  }}
                  title={`Light #${light.light_id}\nDMX: ${light.dmx_start_channel}-${light.dmx_start_channel + (light.light_type === 'RGBW' ? 3 : 2)}${light.defective_channels ? `\nDefective: ${light.defective_channels.toUpperCase()}` : ''}`}
                >
                  {light.light_id}
                  {light.defective_channels && (
                    <span style={{
                      position: 'absolute',
                      top: '1px',
                      right: '3px',
                      color: '#ff4444',
                      fontSize: '10px',
                      fontWeight: 'bold',
                      lineHeight: 1,
                    }}>!</span>
                  )}
                </div>
              );
            });
          }).flat()}
        </div>
      </div>
    </div>
  );

  if (loading) {
    return <div className="page-header"><h1>Loading...</h1></div>;
  }

  const groupedWalls = getGroupedWalls();

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Light Layout</h1>
      </div>

      {layout && <LightIdPreview walls={layout.walls} onLightClick={handleLightClick} />}

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
            <button className="btn btn-primary btn-sm" onClick={handleAddWall}>
              Add Wall
            </button>
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

      {/* Wall Groups */}
      {layout && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Wall Groups</h2>
          </div>

          {layout.groups.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
              {layout.groups.map(group => (
                <div key={group.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {editingGroupId === group.id ? (
                    <>
                      <input
                        type="text"
                        className="form-input"
                        value={editingGroupName}
                        onChange={(e) => setEditingGroupName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRenameGroup(group.id);
                          if (e.key === 'Escape') { setEditingGroupId(null); setEditingGroupName(''); }
                        }}
                        autoFocus
                        style={{ flex: 1 }}
                      />
                      <button className="btn btn-primary btn-sm" onClick={() => handleRenameGroup(group.id)}>
                        Save
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={() => { setEditingGroupId(null); setEditingGroupName(''); }}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <span style={{ flex: 1, fontWeight: 500 }}>{group.name}</span>
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                        {layout.walls.filter(w => w.group_id === group.id).length} walls
                      </span>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => { setEditingGroupId(group.id); setEditingGroupName(group.name); }}
                        title="Rename"
                      >
                        ✎
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => handleDeleteGroup(group.id)}
                        title="Delete"
                      >
                        ×
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              type="text"
              className="form-input"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddGroup(); }}
              placeholder="New group name"
              style={{ flex: 1 }}
            />
            <button className="btn btn-primary btn-sm" onClick={handleAddGroup} disabled={!newGroupName.trim()}>
              Add Group
            </button>
          </div>
        </div>
      )}

      {/* Wall Sections - grouped */}
      {layout && (
        <div className="matrix-container">
          {groupedWalls.map(({ group, walls }) => (
            <div key={group ? group.id : '__ungrouped'}>
              {group && (
                <div style={{
                  padding: '0.5rem 0.75rem',
                  marginBottom: '0.25rem',
                  color: 'var(--text-secondary)',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  borderBottom: '1px solid var(--border)',
                }}>
                  {group.name}
                </div>
              )}
              {!group && layout.groups.length > 0 && (
                <div style={{
                  padding: '0.5rem 0.75rem',
                  marginBottom: '0.25rem',
                  color: 'var(--text-secondary)',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  borderBottom: '1px solid var(--border)',
                }}>
                  Ungrouped
                </div>
              )}
              {walls.map(({ wall, index }) => renderWallSection(wall, index))}
            </div>
          ))}
        </div>
      )}

      {/* Light Editor Modal */}
      {selectedLight && (
        <div className="modal-overlay" onClick={() => setSelectedLight(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="light-modal-title">
            <div className="modal-header">
              <h3 className="modal-title" id="light-modal-title">Edit Light #{selectedLight.light_id}</h3>
              <button className="modal-close" onClick={() => setSelectedLight(null)} aria-label="Close">
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

            <div className="form-group">
              <label className="form-label">Defective Channels</label>
              <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                {(['r', 'g', 'b', 'w'] as const).map((ch) => {
                  const labels: Record<string, string> = { r: 'Red', g: 'Green', b: 'Blue', w: 'White' };
                  const colors: Record<string, string> = { r: '#ff4444', g: '#44ff44', b: '#4444ff', w: '#dddddd' };
                  const current = (selectedLight.defective_channels || '').split(',').filter(Boolean);
                  const isChecked = current.includes(ch);
                  return (
                    <label key={ch} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(e) => {
                          let next: string[];
                          if (e.target.checked) {
                            next = [...current, ch];
                          } else {
                            next = current.filter(c => c !== ch);
                          }
                          setSelectedLight({
                            ...selectedLight,
                            defective_channels: next.join(','),
                          });
                        }}
                      />
                      <span style={{ color: colors[ch], fontWeight: 500 }}>{labels[ch]}</span>
                    </label>
                  );
                })}
              </div>
              <small style={{ color: 'var(--text-secondary)', display: 'block', marginTop: '0.25rem' }}>
                Mark channels that are physically broken. Defective channels will be zeroed out in output.
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
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="wall-modal-title">
            <div className="modal-header">
              <h3 className="modal-title" id="wall-modal-title">Edit Wall: {editingWall.name}</h3>
              <button className="modal-close" onClick={() => setEditingWall(null)} aria-label="Close">
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
                {isLastWall(editingWall)
                  ? 'Connects to first wall (wraps around for continuous motion effects)'
                  : 'Connects to next wall (for continuous motion effects)'}
              </label>
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-danger"
                onClick={() => handleDeleteWall(editingWall.id)}
              >
                Delete Wall
              </button>
              <div style={{ flex: 1 }} />
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
