import { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { designsAPI, playlistsAPI, schedulesAPI, layoutAPI, previewAPI, healthAPI } from '../utils/api';
import LiveLightPreview from '../components/LiveLightPreview';
import { useEscapeKey } from '../hooks/useEscapeKey';
import type { Design, Playlist, Schedule, LayoutData } from '../types';
import { groupByFolder, hasFolders, UNFILED_LABEL } from '../utils/folders';

const ACTIVE_POLL_MS = 30000;

// What a schedule plays, as the pickers offer it. A scene is stored like a playlist
// (design_type 'playlist' + playlist_id); only its kind differs.
type TargetType = 'static' | 'motion' | 'scene' | 'playlist';
const TARGET_LABELS: Record<TargetType, string> = { static: 'Static Design', motion: 'Motion Effect', scene: 'Scene', playlist: 'Show' };
const isListTarget = (t: TargetType) => t === 'scene' || t === 'playlist';

/** Picker options grouped by folder (Unfiled first) once anything is in a folder; flat otherwise. */
function folderOptions<T extends { id: string; folder?: string | null }>(items: T[], label: (item: T) => string) {
  const option = (item: T) => <option key={item.id} value={item.id}>{label(item)}</option>;
  if (!hasFolders(items)) return items.map(option);
  return groupByFolder(items).map((group) => (
    <optgroup key={group.folder ?? ''} label={group.folder ?? UNFILED_LABEL}>
      {group.items.map(option)}
    </optgroup>
  ));
}

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
  const [selectedType, setSelectedType] = useState<TargetType>('static');
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
        design_type: isListTarget(selectedType) ? 'playlist' : selectedType,
      };

      if (isListTarget(selectedType)) {
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
        design_type: isListTarget(selectedType) ? 'playlist' : selectedType as 'static' | 'motion',
        start_date: startDate,
        end_date: endDate,
        start_time: startTime,
        end_time: endTime,
        priority,
      };

      if (isListTarget(selectedType)) {
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
    setSelectedType(targetTypeOf(schedule));
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

  const targetTypeOf = (schedule: Schedule): TargetType => {
    if (schedule.design_type !== 'playlist') return schedule.design_type;
    const kind = schedule.playlist_kind ?? playlists.find((p) => p.id === schedule.playlist_id)?.kind;
    return kind === 'scene' ? 'scene' : 'playlist';
  };

  const getScheduleDisplayName = (schedule: Schedule): string => {
    if (schedule.design_type === 'playlist') {
      return schedule.playlist_name || `Unknown ${TARGET_LABELS[targetTypeOf(schedule)]}`;
    }
    return schedule.design_name || 'Unknown Design';
  };

  const listOptions = playlists.filter((p) => (p.kind ?? 'playlist') === selectedType);

  // Type + design/scene/playlist pickers, shared by both modals
  const targetFields = (
    <>
      <div className="form-group">
        <label className="form-label" htmlFor="schedule-target-type">Type</label>
        <select
          id="schedule-target-type"
          className="form-select"
          value={selectedType}
          onChange={(e) => {
            setSelectedType(e.target.value as TargetType);
            setSelectedDesignId('');
            setSelectedPlaylistId('');
          }}
        >
          {(Object.keys(TARGET_LABELS) as TargetType[]).map((t) => (
            <option key={t} value={t}>{TARGET_LABELS[t]}</option>
          ))}
        </select>
      </div>

      {isListTarget(selectedType) ? (
        <div className="form-group">
          <label className="form-label" htmlFor="schedule-target-list">{TARGET_LABELS[selectedType]}</label>
          <select
            id="schedule-target-list"
            className="form-select"
            value={selectedPlaylistId}
            onChange={(e) => setSelectedPlaylistId(e.target.value)}
          >
            <option value="">Select a {selectedType}...</option>
            {folderOptions(listOptions, (playlist) => `${playlist.name} (${playlist.items.length} items)`)}
          </select>
        </div>
      ) : (
        <div className="form-group">
          <label className="form-label" htmlFor="schedule-target-design">Design</label>
          <select
            id="schedule-target-design"
            className="form-select"
            value={selectedDesignId}
            onChange={(e) => setSelectedDesignId(e.target.value)}
          >
            <option value="">Select a design...</option>
            {folderOptions(designs.filter((d) => d.type === selectedType), (design) => design.name)}
          </select>
        </div>
      )}
    </>
  );

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
          <LiveLightPreview walls={layout.walls} active={isVisible} source="output" />
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
                ({targetTypeOf(activeSchedule)})
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
              setSelectedType(targetTypeOf(defaultSchedule));
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
              <p>Type: {targetTypeOf(defaultSchedule)}</p>
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
                  <p style={{ color: 'var(--text-secondary)' }}>Type: {targetTypeOf(schedule)}</p>
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

            {targetFields}

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowDefaultModal(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSetDefault}
                disabled={isListTarget(selectedType) ? !selectedPlaylistId : !selectedDesignId}
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

            {targetFields}

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
                  (isListTarget(selectedType) ? !selectedPlaylistId : !selectedDesignId)
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
