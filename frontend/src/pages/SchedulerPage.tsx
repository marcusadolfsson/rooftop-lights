import { useState, useEffect } from 'react';
import { designsAPI, playlistsAPI, schedulesAPI } from '../utils/api';
import type { Design, Playlist, Schedule } from '../types';

function SchedulerPage() {
  const [designs, setDesigns] = useState<Design[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [defaultSchedule, setDefaultSchedule] = useState<Schedule | null>(null);
  const [activeSchedule, setActiveSchedule] = useState<Schedule | null>(null);
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
  const [priority, setPriority] = useState(0);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [designsData, playlistsData, schedulesData, defaultData, activeData] = await Promise.all([
        designsAPI.getAll(),
        playlistsAPI.getAll(),
        schedulesAPI.getAll(),
        schedulesAPI.getDefault(),
        schedulesAPI.getActive(),
      ]);
      setDesigns(designsData);
      setPlaylists(playlistsData);
      setSchedules(schedulesData.filter((s: Schedule) => !s.is_default));
      setDefaultSchedule(defaultData);
      setActiveSchedule(activeData);
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
        priority: number;
      } = {
        design_type: selectedType,
        start_date: startDate,
        end_date: endDate,
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
    setPriority(schedule.priority);
    setShowScheduleModal(true);
  };

  const resetForm = () => {
    setSelectedType('static');
    setSelectedDesignId('');
    setSelectedPlaylistId('');
    setStartDate('');
    setEndDate('');
    setPriority(0);
  };

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString();
  };

  const getScheduleDisplayName = (schedule: Schedule): string => {
    if (schedule.design_type === 'playlist') {
      return schedule.playlist_name || 'Unknown Playlist';
    }
    return schedule.design_name || 'Unknown Design';
  };

  if (loading) {
    return <div className="page-header"><h1>Loading...</h1></div>;
  }

  return (
    <div>
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
        {activeSchedule ? (
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
                    {formatDate(schedule.start_date)} - {formatDate(schedule.end_date)}
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
                <label className="form-label">End Date</label>
                <input
                  type="date"
                  className="form-input"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
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
