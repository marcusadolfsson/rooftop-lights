import { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { designsAPI, playlistsAPI, schedulesAPI, layoutAPI, previewAPI, healthAPI } from '../utils/api';
import LiveLightPreview from '../components/LiveLightPreview';
import { useEscapeKey } from '../hooks/useEscapeKey';
import type { Design, Playlist, Schedule, LayoutData } from '../types';

const ACTIVE_POLL_MS = 30000;

// Parse "YYYY-MM-DD" as a local calendar date. new Date("YYYY-MM-DD") is UTC
// midnight, which displays as the previous day in time zones west of UTC.
function parseLocalDate(dateStr: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function SchedulerPage() {
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
  const [serverTimeZone, setServerTimeZone] = useState<string | null>(null);

  // Esc closes whichever modal is open
  const closeScheduleModal = () => {
    setShowScheduleModal(false);
    setEditingSchedule(null);
  };
  useEscapeKey(showDefaultModal, () => setShowDefaultModal(false));
  useEscapeKey(showScheduleModal, closeScheduleModal);

  // Load/refresh data when page becomes visible
  useEffect(() => {
    if (isVisible) {
      loadData();
    }
  }, [isVisible]);

  // Server time zone (schedule times are evaluated in it), if the backend reports one
  useEffect(() => {
    healthAPI.get()
      .then((h) => { if (typeof h.timeZone === 'string' && h.timeZone) setServerTimeZone(h.timeZone); })
      .catch(() => { /* optional; fall back to the generic hint */ });
  }, []);

  // Keep "Currently Active" fresh while the page is visible
  const refreshActive = useCallback(async () => {
    try {
      const [activeData, previewStatus] = await Promise.all([
        schedulesAPI.getActive(),
        previewAPI.getStatus(),
      ]);
      setActiveSchedule(activeData);
      setLivePreviewActive(previewStatus.isLivePreview);
      setLivePreviewInfo(previewStatus.livePreviewInfo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh active schedule');
    }
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    const id = window.setInterval(refreshActive, ACTIVE_POLL_MS);
    return () => clearInterval(id);
  }, [isVisible, refreshActive]);

  // Only the first load shows the loading screen; later refreshes happen in the background
  const loadData = async () => {
    try {
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
    const parsed = parseLocalDate(dateStr);
    const date = parsed ? parsed.toLocaleDateString() : dateStr;
    if (timeStr) return `${date} ${timeStr}`;
    return date;
  };

  const getScheduleDisplayName = (schedule: Schedule): string => {
    if (schedule.design_type === 'playlist') {
      return schedule.playlist_name || 'Unknown Playlist';
    }
    return schedule.design_name || 'Unknown Design';
  };

  const timeZoneHint = serverTimeZone ? `server time, ${serverTimeZone}` : 'server local time';

  if (loading) {
    return <div className="page-header"><h1>Loading...</h1></div>;
  }

  return (
    <div>
      {/* ArtNet Output Preview */}
      {layout && (
        <div className="preview-strip">
          <div className="preview-strip-header">
            <div className="preview-strip-title">ArtNet Output</div>
          </div>
          <LiveLightPreview walls={layout.walls} active={isVisible} />
        </div>
      )}

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
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="default-schedule-modal-title">
            <div className="modal-header">
              <h3 className="modal-title" id="default-schedule-modal-title">Set Default Schedule</h3>
              <button className="modal-close" onClick={() => setShowDefaultModal(false)} aria-label="Close">
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
        <div className="modal-overlay" onClick={closeScheduleModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="schedule-modal-title">
            <div className="modal-header">
              <h3 className="modal-title" id="schedule-modal-title">
                {editingSchedule ? 'Edit Schedule' : 'Add Date Schedule'}
              </h3>
              <button className="modal-close" onClick={closeScheduleModal} aria-label="Close">
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
                <label className="form-label" htmlFor="schedule-start-time">Start Time <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>({timeZoneHint})</span></label>
                <input
                  id="schedule-start-time"
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
                <label className="form-label" htmlFor="schedule-end-time">End Time <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>({timeZoneHint})</span></label>
                <input
                  id="schedule-end-time"
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
