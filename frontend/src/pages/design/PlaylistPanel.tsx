import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Design, Playlist } from '../../types';
import SavedList, { trashIcon } from './SavedList';
import { formatSeconds, MAX_REPEAT_COUNT, type EditingPlaylistItem, type PlaylistEditor } from './editors';

interface PlaylistPanelProps {
  editor: PlaylistEditor;
  designs: Design[];
  playlists: Playlist[];
  sidebarHeader: ReactNode;
  onSave: () => void;
}

export default function PlaylistPanel({ editor, designs, playlists, sidebarHeader, onSave }: PlaylistPanelProps) {
  const { selectedPlaylist, items, dragKey } = editor;

  // Move buttons by `${item key}:${delta}`. After a move, focus follows the item; when its
  // arrow just became disabled (top/bottom) focus goes to the other arrow instead of <body>.
  const moveButtons = useRef(new Map<string, HTMLButtonElement>());
  const [moved, setMoved] = useState<{ key: string; delta: -1 | 1 } | null>(null);
  useEffect(() => {
    if (!moved) return;
    const idx = items.findIndex((i) => i.key === moved.key);
    if (idx < 0) return;
    const atEnd = moved.delta === -1 ? idx === 0 : idx === items.length - 1;
    const delta = atEnd ? -moved.delta : moved.delta;
    moveButtons.current.get(`${moved.key}:${delta}`)?.focus();
    setMoved(null);
  }, [items, moved]);
  const move = (key: string, delta: -1 | 1) => {
    editor.moveItem(key, delta);
    setMoved({ key, delta });
  };
  const moveButtonRef = (key: string, delta: -1 | 1) => (el: HTMLButtonElement | null) => {
    if (el) moveButtons.current.set(`${key}:${delta}`, el);
    else moveButtons.current.delete(`${key}:${delta}`);
  };

  // Why "times" is unavailable for an item, or null when it can repeat
  const noTimesReason = (item: EditingPlaylistItem): string | null => {
    if (editor.cycleSeconds(item) !== null) return null;
    if (item.child_playlist_id) return 'This playlist is empty, so it can only play for a number of seconds';
    if (item.design_type === 'static') return 'Static designs have no cycle to repeat; set how many seconds to show it';
    return 'This effect has no fixed cycle (it is random or custom code), so it can only play for a number of seconds';
  };
  const itemLabel = (item: EditingPlaylistItem) => item.name ?? 'item';

  return (
    <div className="design-layout">
      <div className="design-sidebar">
        {sidebarHeader}
        <SavedList
          title="Saved Playlists"
          items={playlists.map((p) => ({
            id: p.id,
            name: p.name,
            meta: (
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
              {p.items.length} items{p.totalSeconds ? ` · ${formatSeconds(p.totalSeconds)}` : ''}
            </span>
          ),
          }))}
          selectedId={selectedPlaylist?.id}
          onSelect={(id) => { const p = playlists.find((x) => x.id === id); if (p) editor.load(p); }}
          onRename={editor.rename}
          onDelete={editor.remove}
        />
        <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={editor.startNew}>New Playlist</button>
      </div>

      {/* Right: Playlist Editor */}
      <div className="design-main">
        <div className="card">
          <div className="card-header playlist-editor-header">
            <h3 className="card-title">
              {selectedPlaylist ? (
                <input
                  className="form-input"
                  aria-label="Playlist name"
                  style={{ padding: '0.2rem 0.4rem', fontSize: '0.9rem', fontWeight: 600, background: 'transparent', border: '1px solid transparent', width: '200px' }}
                  value={editor.name}
                  onChange={(e) => editor.setName(e.target.value)}
                  onFocus={(e) => { e.target.style.borderColor = 'var(--border-color)'; }}
                  onBlur={(e) => { e.target.style.borderColor = 'transparent'; }}
                />
              ) : 'New Playlist'}
            </h3>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <select className="form-select" aria-label="Play mode" style={{ width: 'auto', padding: '0.4rem 0.6rem', fontSize: '0.8rem' }} value={editor.mode} onChange={(e) => editor.setMode(e.target.value as 'sequence' | 'random')}>
                <option value="sequence">Sequential</option>
                <option value="random">Random</option>
              </select>
              <button className="btn btn-primary btn-sm" onClick={onSave} disabled={items.length === 0}>Save</button>
            </div>
          </div>
          {items.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '1.5rem 0' }}>Add designs or playlists from the list below to build your playlist.</p>
          ) : (
            <div className="playlist-items">
              {items.map((item, idx) => {
                const mode = editor.effectiveMode(item);
                const noTimes = noTimesReason(item);
                const label = itemLabel(item);
                return (
                <div
                  key={item.key}
                  className={`playlist-item${dragKey === item.key ? ' dragging' : ''}`}
                  draggable
                  onDragStart={() => editor.dragStart(item.key)}
                  onDragOver={(e) => editor.dragOver(e, item.key)}
                  onDragEnd={editor.dragEnd}
                >
                  <span
                    className="playlist-item-drag"
                    title="Drag to reorder (or focus and use arrow keys)"
                    role="button"
                    tabIndex={0}
                    aria-label={`Reorder ${label}, position ${idx + 1} of ${items.length}. Use up and down arrow keys to move.`}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowUp') { e.preventDefault(); editor.moveItem(item.key, -1); }
                      if (e.key === 'ArrowDown') { e.preventDefault(); editor.moveItem(item.key, 1); }
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>
                  </span>
                  <span className="playlist-item-name">
                    {label}{' '}
                    {item.child_playlist_id
                      ? <span className="playlist-tag">Playlist</span>
                      : <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>({item.design_type})</span>}
                  </span>
                  <span className="playlist-item-timing">
                    {/* Play for X seconds, or X complete cycles (designs) / times through (playlists) */}
                    <span className="preview-mode-toggle playlist-item-mode" role="group" aria-label={`How long ${label} plays`}>
                      <button type="button" className={mode === 'seconds' ? 'active' : ''} aria-pressed={mode === 'seconds'} onClick={() => editor.updateItem(item.key, 'repeat_mode', 'seconds')}>sec</button>
                      <span title={noTimes ?? (item.child_playlist_id ? 'Play the whole playlist this many times' : 'Play this many complete cycles of the effect')}>
                        <button type="button" className={mode === 'times' ? 'active' : ''} aria-pressed={mode === 'times'} disabled={noTimes !== null} onClick={() => editor.updateItem(item.key, 'repeat_mode', 'times')}>times</button>
                      </span>
                    </span>
                    {mode === 'seconds' ? (
                      <input type="number" className="form-input playlist-item-duration" aria-label={`Seconds to play ${label}`} value={item.duration} min="1" onChange={(e) => editor.updateItem(item.key, 'duration', Math.max(1, parseInt(e.target.value) || 1))} />
                    ) : (
                      <input type="number" className="form-input playlist-item-duration" aria-label={`Times to play ${label}`} value={item.repeat_count} min="1" max={MAX_REPEAT_COUNT} onChange={(e) => editor.updateItem(item.key, 'repeat_count', Math.min(MAX_REPEAT_COUNT, Math.max(1, parseInt(e.target.value) || 1)))} />
                    )}
                    <span className="playlist-item-length" title={mode === 'times' ? `${editor.cycleSeconds(item)} s each` : undefined}>{formatSeconds(editor.itemSeconds(item))}</span>
                  </span>
                  <select className="form-select" aria-label="Transition" style={{ width: 'auto', padding: '0.4rem 0.5rem', fontSize: '0.8rem' }} value={item.transition} onChange={(e) => editor.updateItem(item.key, 'transition', e.target.value)}>
                    <option value="cut">Cut</option>
                    <option value="fade">Fade</option>
                    <option value="fade_black">Fade to Black</option>
                  </select>
                  {/* HTML drag and drop doesn't work with touch, so phones get move buttons */}
                  <span className="playlist-item-move">
                    <button type="button" className="btn-icon" ref={moveButtonRef(item.key, -1)} aria-label={`Move ${label} up`} disabled={idx === 0} onClick={() => move(item.key, -1)}>↑</button>
                    <button type="button" className="btn-icon" ref={moveButtonRef(item.key, 1)} aria-label={`Move ${label} down`} disabled={idx === items.length - 1} onClick={() => move(item.key, 1)}>↓</button>
                  </span>
                  <button className="btn-icon" style={{ padding: '0.2rem', color: 'var(--danger-color)' }} title="Remove" aria-label={`Remove ${label}`} onClick={() => editor.removeItem(item.key)}>
                    {trashIcon(14)}
                  </button>
                </div>
                );
              })}
              <div className="playlist-total">
                {editor.mode === 'random' ? 'One round of every item' : 'Total'} <strong>{formatSeconds(editor.totalSeconds)}</strong>
              </div>
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-header"><h3 className="card-title">Add Design or Playlist</h3></div>
          <table className="table saved-designs-table">
            <tbody>
              {designs.map((design) => (
                <tr key={design.id} style={{ cursor: 'pointer' }} onClick={() => editor.addDesign(design.id)}>
                  <td>
                    <button
                      type="button"
                      className="saved-item-button"
                      aria-label={`Add ${design.name} (${design.type}) to playlist`}
                      onClick={(e) => { e.stopPropagation(); editor.addDesign(design.id); }}
                    >
                      {design.name} <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginLeft: '0.5rem' }}>{design.type}</span>
                    </button>
                  </td>
                  <td style={{ width: '1px' }}><span style={{ color: 'var(--primary-color)', fontSize: '1.2rem', fontWeight: 600 }} aria-hidden="true">+</span></td>
                </tr>
              ))}
              {editor.addablePlaylists.map((playlist) => (
                <tr key={playlist.id} style={{ cursor: 'pointer' }} onClick={() => editor.addPlaylist(playlist.id)}>
                  <td>
                    <button
                      type="button"
                      className="saved-item-button"
                      aria-label={`Add playlist ${playlist.name} to playlist`}
                      onClick={(e) => { e.stopPropagation(); editor.addPlaylist(playlist.id); }}
                    >
                      {playlist.name} <span className="playlist-tag" style={{ marginLeft: '0.5rem' }}>Playlist</span>
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginLeft: '0.5rem' }}>
                        {playlist.items.length} items{playlist.totalSeconds ? ` · ${formatSeconds(playlist.totalSeconds)}` : ''}
                      </span>
                    </button>
                  </td>
                  <td style={{ width: '1px' }}><span style={{ color: 'var(--primary-color)', fontSize: '1.2rem', fontWeight: 600 }} aria-hidden="true">+</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
