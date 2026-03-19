import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { designsAPI, playlistsAPI, schedulesAPI, layoutAPI, previewAPI } from '../utils/api';
import { useWebSocket } from '../hooks/useWebSocket';
import type { Design, Playlist, Schedule, LayoutData, RGBW } from '../types';

function SchedulerPage() {
  const { frameData } = useWebSocket();
  const location = useLocation();
  const isVisible = location.pathname === '/schedule';
  const [layout, setLayout] = useState<LayoutData | null>(null);
  const [designs, setDesigns] = useState<Design[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [defaultSchedule, setDefaultSchedule] = useState<Schedule | null>(null);
  const [activeSchedule, setActiveSchedule] = useState<Schedule | null>(null);
  const [livePreviewActive, setLivePreviewActive] = useState(false);
  const [livePreviewInfo, setLivePreviewInfo] = useState<{ type: string; effectType?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal state
  const [showDefaultModal, setShowDefaultModal] = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);

  // Form state
  const [selectedType, setSelectedType] = useState<'static' | 'motion' | 'playlist'>('static');
  const [selectedDesignId, setSelectedDesignId] = useState<string>('');
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string>('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [startTime, setStartTime] = useState('16:00');
  const [endTime, setEndTime] = useState('16:00');
  const [priority, setPriority] = useState(0);

  // Load/refresh data when page becomes visible
  useEffect(() => {
    if (isVisible) {
      loadData();
    }
  }, [isVisible]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [layoutData, designsData, playlistsData, schedulesData, defaultData, activeData, previewStatus] = await Promise.all([
        layoutAPI.getLayout(),
        designsAPI.getAll(),
        playlistsAPI.getAll(),
        schedulesAPI.getAll(),
        schedulesAPI.getDefault(),
        schedulesAPI.getActive(),
        previewAPI.getStatus(),
      ]);
      setLayout(layoutData);
      setDesigns(designsData);
      setPlaylists(playlistsData);
      setSchedules(schedulesData.filter((s: Schedule) => !s.is_default));
      setDefaultSchedule(defaultData);
      setActiveSchedule(activeData);
      setLivePreviewActive(previewStatus.isLivePreview);
      setLivePreviewInfo(previewStatus.livePreviewInfo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleSetDefault = async () => {
    try {
      const data: { design_id?: string; playlist_id?: string; design_type: string } = {
        design_type: selectedType,
      };

      if (selectedType === 'playlist') {
        data.playlist_id = selectedPlaylistId;
      } else {
        data.design_id = selectedDesignId;
      }

      await schedulesAPI.setDefault(data);
      await loadData();
      setShowDefaultModal(false);
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set default schedule');
    }
  };

  const handleCreateSchedule = async () => {
    try {
      const data: {
        design_id?: string;
        playlist_id?: string;
        design_type: 'static' | 'motion' | 'playlist';
        start_date: string;
        end_date: string;
        start_time: string;
        end_time: string;
        priority: number;
      } = {
        design_type: selectedType,
        start_date: startDate,
        end_date: endDate,
        start_time: startTime,
        end_time: endTime,
        priority,
      };

      if (selectedType === 'playlist') {
        data.playlist_id = selectedPlaylistId;
      } else {
        data.design_id = selectedDesignId;
      }

      if (editingSchedule) {
        await schedulesAPI.update(editingSchedule.id, data);
      } else {
        await schedulesAPI.create(data);
      }

      await loadData();
      setShowScheduleModal(false);
      setEditingSchedule(null);
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save schedule');
    }
  };

  const handleDeleteSchedule = async (scheduleId: string) => {
    if (!confirm('Are you sure you want to delete this schedule?')) return;

    try {
      await schedulesAPI.delete(scheduleId);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete schedule');
    }
  };

  const openEditSchedule = (schedule: Schedule) => {
    setEditingSchedule(schedule);
    setSelectedType(schedule.design_type);
    setSelectedDesignId(schedule.design_id || '');
    setSelectedPlaylistId(schedule.playlist_id || '');
    setStartDate(schedule.start_date || '');
    setEndDate(schedule.end_date || '');
    setStartTime(schedule.start_time || '16:00');
    setEndTime(schedule.end_time || '16:00');
    setPriority(schedule.priority);
    setShowScheduleModal(true);
  };

  const resetForm = () => {
    setSelectedType('static');
    setSelectedDesignId('');
    setSelectedPlaylistId('');
    setStartDate('');
    setEndDate('');
    setStartTime('16:00');
    setEndTime('16:00');
    setPriority(0);
  };

  const formatDate = (dateStr: string | null, timeStr?: string | null): string => {
    if (!dateStr) return 'N/A';
    const date = new Date(dateStr).toLocaleDateString();
    if (timeStr) return `${date} ${timeStr}`;
    return date;
  };

  const getScheduleDisplayName = (schedule: Schedule): string => {
    if (schedule.design_type === 'playlist') {
      return schedule.playlist_name || 'Unknown Playlist';
    }
    return schedule.design_name || 'Unknown Design';
  };

  const getLightColor = (lightId: number): string => {
    const color: RGBW | undefined = frameData[lightId];
    if (!color) return '#222';
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
      {/* ArtNet Output Preview */}
      {layout && (() => {
        const maxRows = Math.max(...layout.walls.map(w => w.height));
        return (
          <div className="preview-strip">
            <div className="preview-strip-header">
              <div className="preview-strip-title">ArtNet Output</div>
            </div>
            <div className="preview-strip-grid-wrapper">
              <div
                className="preview-strip-grid"
                style={{ gridTemplateColumns: layout.walls.map(w => `repeat(${w.width}, 1fr)`).join(' 6px ') }}
              >
                {Array.from({ length: maxRows }, (_, rowIdx) => {
                  const y = maxRows - 1 - rowIdx;
                  return layout.walls.flatMap((wall, wallIdx) => {
                    const cells = Array.from({ length: wall.width }, (_, x) => {
                      const light = wall.matrix?.[y]?.[x];
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
                          className="preview-strip-cell"
                          style={{ backgroundColor: getLightColor(light.light_id) }}
                          title={`#${light.light_id} (${wall.name})`}
                        />
                      );
                    });
                    if (wallIdx < layout.walls.length - 1) {
                      cells.push(<div key={`spacer-${wall.id}-${y}`} className="preview-strip-spacer" />);
                    }
                    return cells;
                  });
                })}
              </div>
              <div
                className="preview-strip-labels"
                style={{ gridTemplateColumns: layout.walls.map(w => `${w.width}fr`).join(' 6px ') }}
              >
                {layout.walls.map((wall, wallIdx) => (
                  <>{wallIdx > 0 && <div key={`spacer-label-${wall.id}`} />}<div key={wall.id} className="preview-strip-label">{wall.name}</div></>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      <div className="page-header">
        <h1 className="page-title">Schedule</h1>
        <button
          className="btn btn-primary"
          onClick={() => {
            resetForm();
            setShowScheduleModal(true);
          }}
        >
          Add Date Schedule
        </button>
      </div>

      {error && (
        <div className="card" style={{ backgroundColor: 'var(--error)', marginBottom: '1rem' }}>
          {error}
          <button className="btn btn-sm" onClick={() => setError(null)} style={{ marginLeft: '1rem' }}>
            Dismiss
          </button>
        </div>
      )}

      {/* Currently Active */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Currently Active</h3>
        </div>
        {livePreviewActive ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div
              style={{
                width: '12px',
                height: '12px',
                borderRadius: '50%',
                backgroundColor: 'var(--warning, #f59e0b)',
                animation: 'pulse 2s infinite',
              }}
            />
            <div>
              <strong>Live Preview</strong>
              <span style={{ color: 'var(--text-secondary)', marginLeft: '0.5rem' }}>
                ({livePreviewInfo?.type || 'unknown'}{livePreviewInfo?.effectType ? ` - ${livePreviewInfo.effectType}` : ''})
              </span>
              <span
                style={{
                  backgroundColor: 'var(--warning, #f59e0b)',
                  color: '#000',
                  padding: '0.25rem 0.5rem',
                  borderRadius: '4px',
                  fontSize: '0.75rem',
                  marginLeft: '0.5rem',
                }}
              >
                Override
              </span>
            </div>
          </div>
        ) : activeSchedule ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div
              style={{
                width: '12px',
                height: '12px',
                borderRadius: '50%',
                backgroundColor: 'var(--success)',
                animation: 'pulse 2s infinite',
              }}
            />
            <div>
              <strong>{getScheduleDisplayName(activeSchedule)}</strong>
              <span style={{ color: 'var(--text-secondary)', marginLeft: '0.5rem' }}>
                ({activeSchedule.design_type})
              </span>
              {activeSchedule.is_default && (
                <span
                  style={{
                    backgroundColor: 'var(--accent-primary)',
                    padding: '0.25rem 0.5rem',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    marginLeft: '0.5rem',
                  }}
                >
                  Default
                </span>
              )}
            </div>
          </div>
        ) : (
          <p style={{ color: 'var(--text-secondary)' }}>No active schedule. Set a default below.</p>
        )}
      </div>

      {/* Default Schedule */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Default Schedule</h3>
          <button className="btn btn-secondary btn-sm" onClick={() => {
            if (defaultSchedule) {
              setSelectedType(defaultSchedule.design_type);
              setSelectedDesignId(defaultSchedule.design_id || '');
              setSelectedPlaylistId(defaultSchedule.playlist_id || '');
            }
            setShowDefaultModal(true);
          }}>
            {defaultSchedule ? 'Change Default' : 'Set Default'}
          </button>
        </div>

        {defaultSchedule ? (
          <div className="schedule-item default">
            <div className="schedule-item-info">
              <h4>{getScheduleDisplayName(defaultSchedule)}</h4>
              <p>Type: {defaultSchedule.design_type}</p>
              <p>This is the fallback schedule when no date-specific schedules are active.</p>
            </div>
          </div>
        ) : (
          <p style={{ color: 'var(--text-secondary)' }}>
            No default schedule set. The lights will be off unless a date-specific schedule is active.
          </p>
        )}
      </div>

      {/* Date-Specific Schedules */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Date-Specific Schedules</h3>
        </div>

        {schedules.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)' }}>
            No date-specific schedules. Add one to override the default during certain dates.
          </p>
        ) : (
          <div className="schedule-list">
            {schedules.map((schedule) => (
              <div key={schedule.id} className="schedule-item">
                <div className="schedule-item-info">
                  <h4>{getScheduleDisplayName(schedule)}</h4>
                  <p>
                    {formatDate(schedule.start_date, schedule.start_time)} - {formatDate(schedule.end_date, schedule.end_time)}
                    {schedule.priority > 0 && ` • Priority: ${schedule.priority}`}
                  </p>
                  <p style={{ color: 'var(--text-secondary)' }}>Type: {schedule.design_type}</p>
                </div>
                <div className="btn-group">
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => openEditSchedule(schedule)}
                  >
                    Edit
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => handleDeleteSchedule(schedule.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Default Schedule Modal */}
      {showDefaultModal && (
        <div className="modal-overlay" onClick={() => setShowDefaultModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Set Default Schedule</h3>
              <button className="modal-close" onClick={() => setShowDefaultModal(false)}>
                &times;
              </button>
            </div>

            <div className="form-group">
              <label className="form-label">Type</label>
              <select
                className="form-select"
                value={selectedType}
                onChange={(e) => {
                  setSelectedType(e.target.value as 'static' | 'motion' | 'playlist');
                  setSelectedDesignId('');
                  setSelectedPlaylistId('');
                }}
              >
                <option value="static">Static Design</option>
                <option value="motion">Motion Effect</option>
                <option value="playlist">Playlist</option>
              </select>
            </div>

            {selectedType === 'playlist' ? (
              <div className="form-group">
                <label className="form-label">Playlist</label>
                <select
                  className="form-select"
                  value={selectedPlaylistId}
                  onChange={(e) => setSelectedPlaylistId(e.target.value)}
                >
                  <option value="">Select a playlist...</option>
                  {playlists.map((playlist) => (
                    <option key={playlist.id} value={playlist.id}>
                      {playlist.name} ({playlist.items.length} items)
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="form-group">
                <label className="form-label">Design</label>
                <select
                  className="form-select"
                  value={selectedDesignId}
                  onChange={(e) => setSelectedDesignId(e.target.value)}
                >
                  <option value="">Select a design...</option>
                  {designs
                    .filter((d) => d.type === selectedType)
                    .map((design) => (
                      <option key={design.id} value={design.id}>
                        {design.name}
                      </option>
                    ))}
                </select>
              </div>
            )}

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowDefaultModal(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSetDefault}
                disabled={selectedType === 'playlist' ? !selectedPlaylistId : !selectedDesignId}
              >
                Set Default
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Schedule Modal */}
      {showScheduleModal && (
        <div className="modal-overlay" onClick={() => {
          setShowScheduleModal(false);
          setEditingSchedule(null);
        }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                {editingSchedule ? 'Edit Schedule' : 'Add Date Schedule'}
              </h3>
              <button className="modal-close" onClick={() => {
                setShowScheduleModal(false);
                setEditingSchedule(null);
              }}>
                &times;
              </button>
            </div>

            <div className="form-group">
              <label className="form-label">Type</label>
              <select
                className="form-select"
                value={selectedType}
                onChange={(e) => {
                  setSelectedType(e.target.value as 'static' | 'motion' | 'playlist');
                  setSelectedDesignId('');
                  setSelectedPlaylistId('');
                }}
              >
                <option value="static">Static Design</option>
                <option value="motion">Motion Effect</option>
                <option value="playlist">Playlist</option>
              </select>
            </div>

            {selectedType === 'playlist' ? (
              <div className="form-group">
                <label className="form-label">Playlist</label>
                <select
                  className="form-select"
                  value={selectedPlaylistId}
                  onChange={(e) => setSelectedPlaylistId(e.target.value)}
                >
                  <option value="">Select a playlist...</option>
                  {playlists.map((playlist) => (
                    <option key={playlist.id} value={playlist.id}>
                      {playlist.name} ({playlist.items.length} items)
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="form-group">
                <label className="form-label">Design</label>
                <select
                  className="form-select"
                  value={selectedDesignId}
                  onChange={(e) => setSelectedDesignId(e.target.value)}
                >
                  <option value="">Select a design...</option>
                  {designs
                    .filter((d) => d.type === selectedType)
                    .map((design) => (
                      <option key={design.id} value={design.id}>
                        {design.name}
                      </option>
                    ))}
                </select>
              </div>
            )}

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Start Date</label>
                <input
                  type="date"
                  className="form-input"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Start Time</label>
                <input
                  type="time"
                  className="form-input"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">End Date</label>
                <input
                  type="date"
                  className="form-input"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">End Time</label>
                <input
                  type="time"
                  className="form-input"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Priority</label>
              <input
                type="number"
                className="form-input"
                value={priority}
                onChange={(e) => setPriority(parseInt(e.target.value) || 0)}
                min="0"
              />
              <small style={{ color: 'var(--text-secondary)' }}>
                Higher priority schedules take precedence when dates overlap
              </small>
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setShowScheduleModal(false);
                  setEditingSchedule(null);
                }}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleCreateSchedule}
                disabled={
                  !startDate ||
                  !endDate ||
                  (selectedType === 'playlist' ? !selectedPlaylistId : !selectedDesignId)
                }
              >
                {editingSchedule ? 'Save' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}

export default SchedulerPage;
