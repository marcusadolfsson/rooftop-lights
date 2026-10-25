import type { ReactNode } from 'react';
import type { Design, Playlist } from '../../types';
import SavedList, { trashIcon } from './SavedList';
import type { PlaylistEditor } from './editors';

interface PlaylistPanelProps {
  editor: PlaylistEditor;
  designs: Design[];
  playlists: Playlist[];
  sidebarHeader: ReactNode;
  onSave: () => void;
}

export default function PlaylistPanel({ editor, designs, playlists, sidebarHeader, onSave }: PlaylistPanelProps) {
  const { selectedPlaylist, items, dragKey } = editor;

  return (
    <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
      <div className="design-sidebar">
        {sidebarHeader}
        <SavedList
          title="Saved Playlists"
          items={playlists.map((p) => ({
            id: p.id,
            name: p.name,
            meta: <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{p.items.length} items</span>,
          }))}
          selectedId={selectedPlaylist?.id}
          onSelect={(id) => { const p = playlists.find((x) => x.id === id); if (p) editor.load(p); }}
          onRename={editor.rename}
          onDelete={editor.remove}
        />
        <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={editor.startNew}>New Playlist</button>
      </div>

      {/* Right: Playlist Editor */}
      <div style={{ flex: 1 }}>
        <div className="card">
          <div className="card-header">
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
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '1.5rem 0' }}>Add designs from the list below to build your playlist.</p>
          ) : (
            <div className="playlist-items">
              {items.map((item, idx) => (
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
                    aria-label={`Reorder ${item.design_name ?? 'item'}, position ${idx + 1} of ${items.length}. Use up and down arrow keys to move.`}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowUp') { e.preventDefault(); editor.moveItem(item.key, -1); }
                      if (e.key === 'ArrowDown') { e.preventDefault(); editor.moveItem(item.key, 1); }
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>
                  </span>
                  <span className="playlist-item-name">{item.design_name} <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>({item.design_type})</span></span>
                  <input type="number" className="form-input playlist-item-duration" aria-label="Duration in seconds" value={item.duration} min="1" onChange={(e) => editor.updateItem(item.key, 'duration', Math.max(1, parseInt(e.target.value) || 1))} />
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>sec</span>
                  <select className="form-select" aria-label="Transition" style={{ width: 'auto', padding: '0.4rem 0.5rem', fontSize: '0.8rem' }} value={item.transition} onChange={(e) => editor.updateItem(item.key, 'transition', e.target.value)}>
                    <option value="cut">Cut</option>
                    <option value="fade">Fade</option>
                    <option value="fade_black">Fade to Black</option>
                  </select>
                  <button className="btn-icon" style={{ padding: '0.2rem', color: 'var(--danger-color)' }} title="Remove" aria-label={`Remove ${item.design_name ?? 'item'}`} onClick={() => editor.removeItem(item.key)}>
                    {trashIcon(14)}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-header"><h3 className="card-title">Add Design</h3></div>
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
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
