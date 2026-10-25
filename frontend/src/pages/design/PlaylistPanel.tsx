import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { Design, Playlist, PlaylistKind } from '../../types';
import SavedList, { trashIcon } from './SavedList';
import { FolderHeaderRow, type FolderControls } from './Folders';
import { groupByFolder, groupKey, hasFolders, useCollapsedGroups } from '../../utils/folders';
import { formatSeconds, KIND_LABEL, MAX_REPEAT_COUNT, playlistKind, type EditingPlaylistItem, type PlaylistEditor } from './editors';

interface PlaylistPanelProps {
  // A scene editor or a playlist editor (editor.kind)
  editor: PlaylistEditor;
  designs: Design[];
  // Every playlist and scene
  playlists: Playlist[];
  sidebarHeader: ReactNode;
  onSave: () => void;
  // Turn a saved scene into a playlist or the other way round
  onConvert: (id: string, to: PlaylistKind) => void;
  onMove: (id: string, folder: string | null) => Promise<void>;
  folders: FolderControls;
  // Playback of the editor's current items in the preview; playingIndex is the item playing now
  isPlaying: boolean;
  playingIndex: number | null;
  onPlay: (startIndex: number) => void;
  onStop: () => void;
}

type PickerType = 'static' | 'motion' | 'scene' | 'playlist';
const PICKER_TYPES: { type: PickerType; label: string }[] = [
  { type: 'static', label: 'Static' },
  { type: 'motion', label: 'Motion' },
  { type: 'scene', label: 'Scenes' },
  { type: 'playlist', label: 'Playlists' },
];

/** One row of the Add picker: a design, scene or playlist that can go into the editor. */
interface PickerEntry {
  id: string;
  name: string;
  folder?: string | null;
  type: PickerType;
  meta?: string;
  add: (at?: number) => void;
}

const PLAY_ICON = <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"/></svg>;
const STOP_ICON = <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>;

const CONVERT_ICON = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>;

export default function PlaylistPanel({
  editor, designs, playlists, sidebarHeader, onSave, onConvert, onMove, folders, isPlaying, playingIndex, onPlay, onStop,
}: PlaylistPanelProps) {
  const { selectedPlaylist, items, dragKey, isScene, noun } = editor;
  const kindLabel = KIND_LABEL[editor.kind];
  const otherKind: PlaylistKind = isScene ? 'playlist' : 'scene';
  const childKind = (id: string | null): PlaylistKind => {
    const child = playlists.find((p) => p.id === id);
    return child ? playlistKind(child) : 'playlist';
  };
  const addableScenes = editor.addablePlaylists.filter((p) => playlistKind(p) === 'scene');
  const addablePlaylists = editor.addablePlaylists.filter((p) => playlistKind(p) === 'playlist');

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
    if (item.child_playlist_id) return `This ${childKind(item.child_playlist_id)} is empty, so it can only play for a number of seconds`;
    if (item.design_type === 'static') return 'Static designs have no cycle to repeat; set how many seconds to show it';
    return 'This effect has no fixed cycle (it is random or custom code), so it can only play for a number of seconds';
  };
  const itemLabel = (item: EditingPlaylistItem) => item.name ?? 'item';

  // --- Add picker: grouped by folder, then type; rows can be dragged into the item list ---

  const [search, setSearch] = useState('');
  const query = search.trim().toLocaleLowerCase();
  const pickerGroups = useCollapsedGroups(`picker-${editor.kind}`);
  const entries: PickerEntry[] = [
    ...designs.map((d): PickerEntry => ({
      id: d.id, name: d.name, folder: d.folder, type: d.type,
      add: (at) => editor.addDesign(d.id, at),
    })),
    ...[...addableScenes, ...addablePlaylists].map((p): PickerEntry => ({
      id: p.id, name: p.name, folder: p.folder, type: playlistKind(p),
      meta: `${p.items.length} items${p.totalSeconds ? ` · ${formatSeconds(p.totalSeconds)}` : ''}`,
      add: (at) => editor.addPlaylist(p.id, at),
    })),
  ];
  const showPickerFolders = hasFolders(entries);
  // A search matches the name or the folder; while searching every group is open
  const shown = query
    ? entries.filter((e) => e.name.toLocaleLowerCase().includes(query) || (e.folder ?? '').toLocaleLowerCase().includes(query))
    : entries;
  const isPickerCollapsed = (key: string) => !query && pickerGroups.isCollapsed(key);

  // Picker row being dragged, and where in the item list it would land (0..items.length)
  const [pickerDrag, setPickerDrag] = useState<PickerEntry | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const endPickerDrag = () => { setPickerDrag(null); setDropIndex(null); };

  // Insertion point from the pointer: before the first item whose middle is below it
  const dropIndexAt = (container: HTMLElement, clientY: number) => {
    const rows = container.querySelectorAll<HTMLElement>('[data-item-index]');
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return Number(row.dataset.itemIndex);
    }
    return items.length;
  };
  const onEditorDragOver = (e: DragEvent<HTMLElement>) => {
    if (!pickerDrag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const at = dropIndexAt(e.currentTarget, e.clientY);
    if (at !== dropIndex) setDropIndex(at);
  };
  const onEditorDragLeave = (e: DragEvent<HTMLElement>) => {
    if (pickerDrag && !e.currentTarget.contains(e.relatedTarget as Node | null)) setDropIndex(null);
  };
  const onEditorDrop = (e: DragEvent<HTMLElement>) => {
    if (!pickerDrag) return;
    e.preventDefault();
    pickerDrag.add(dropIndex ?? items.length);
    endPickerDrag();
  };

  const renderPickerRow = (entry: PickerEntry) => {
    const isList = entry.type === 'scene' || entry.type === 'playlist';
    const label = isList ? `Add ${entry.type} ${entry.name} to ${noun}` : `Add ${entry.name} (${entry.type}) to ${noun}`;
    return (
      <tr
        key={entry.id}
        className={`picker-row${pickerDrag?.id === entry.id ? ' dragging' : ''}`}
        style={{ cursor: 'pointer' }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'copy';
          e.dataTransfer.setData('text/plain', entry.name);
          setPickerDrag(entry);
        }}
        onDragEnd={endPickerDrag}
        onClick={() => entry.add()}
        title="Click to add at the end, or drag into the list"
      >
        <td>
          <button
            type="button"
            className="saved-item-button"
            aria-label={label}
            onClick={(e) => { e.stopPropagation(); entry.add(); }}
          >
            {entry.name}
            {entry.meta && <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginLeft: '0.5rem' }}>{entry.meta}</span>}
          </button>
        </td>
        <td style={{ width: '1px' }}><span style={{ color: 'var(--primary-color)', fontSize: '1.2rem', fontWeight: 600 }} aria-hidden="true">+</span></td>
      </tr>
    );
  };

  // Folder groups (headers only once something is in a folder), each split by type
  const pickerBody = (groups: ReturnType<typeof groupByFolder<PickerEntry>>) => groups.map((group) => {
    const folderKey = groupKey(group.folder);
    const folderCollapsed = showPickerFolders && isPickerCollapsed(folderKey);
    return (
      <tbody key={folderKey} className={showPickerFolders && group.folder !== null ? 'folder-group' : undefined}>
        {showPickerFolders && (
          <FolderHeaderRow
            folder={group.folder}
            count={group.items.length}
            collapsed={folderCollapsed}
            onToggle={() => pickerGroups.toggle(folderKey)}
            colSpan={2}
          />
        )}
        {!folderCollapsed && PICKER_TYPES.map(({ type, label }) => {
          const ofType = group.items.filter((e) => e.type === type);
          if (ofType.length === 0) return null;
          const typeKey = groupKey(group.folder, type);
          const typeCollapsed = isPickerCollapsed(typeKey);
          return [
            <FolderHeaderRow
              key={`type-${type}`}
              folder={group.folder}
              label={label}
              count={ofType.length}
              collapsed={typeCollapsed}
              onToggle={() => pickerGroups.toggle(typeKey)}
              colSpan={2}
              sub
            />,
            ...(typeCollapsed ? [] : ofType.map(renderPickerRow)),
          ];
        })}
      </tbody>
    );
  });

  return (
    <div className="design-layout">
      <div className="design-sidebar">
        {sidebarHeader}
        <SavedList
          title={isScene ? 'Saved Scenes' : 'Saved Playlists'}
          items={editor.saved.map((p) => ({
            id: p.id,
            name: p.name,
            folder: p.folder,
            meta: (
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
              {p.items.length} items{p.totalSeconds ? ` · ${formatSeconds(p.totalSeconds)}` : ''}
            </span>
          ),
            actions: (
              <button
                className="btn-icon"
                style={{ padding: '0.2rem' }}
                title={isScene ? 'Convert to playlist' : 'Convert to scene (designs only)'}
                aria-label={`Convert ${p.name} to ${otherKind}`}
                onClick={(e) => { e.stopPropagation(); onConvert(p.id, otherKind); }}
              >
                {CONVERT_ICON}
              </button>
            ),
          }))}
          selectedId={selectedPlaylist?.id}
          onSelect={(id) => { const p = playlists.find((x) => x.id === id); if (p) editor.load(p); }}
          onRename={editor.rename}
          onDelete={editor.remove}
          scope={editor.kind}
          folders={folders}
          onMove={onMove}
        />
        <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={editor.startNew}>New {kindLabel}</button>
      </div>

      {/* Right: Playlist / Scene Editor */}
      <div className="design-main">
        <div className="card">
          <div className="card-header playlist-editor-header">
            <h3 className="card-title">
              {selectedPlaylist ? (
                <input
                  className="form-input"
                  aria-label={`${kindLabel} name`}
                  style={{ padding: '0.2rem 0.4rem', fontSize: '0.9rem', fontWeight: 600, background: 'transparent', border: '1px solid transparent', width: '200px' }}
                  value={editor.name}
                  onChange={(e) => editor.setName(e.target.value)}
                  onFocus={(e) => { e.target.style.borderColor = 'var(--border-color)'; }}
                  onBlur={(e) => { e.target.style.borderColor = 'transparent'; }}
                />
              ) : `New ${kindLabel}`}
            </h3>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              {/* Scenes always play in order */}
              {!isScene && (
                <select className="form-select" aria-label="Play mode" style={{ width: 'auto', padding: '0.4rem 0.6rem', fontSize: '0.8rem' }} value={editor.mode} onChange={(e) => editor.setMode(e.target.value as 'sequence' | 'random')}>
                  <option value="sequence">Sequential</option>
                  <option value="random">Random</option>
                </select>
              )}
              {/* Plays what's in the editor now, unsaved edits included (on the lights only with Live Preview on) */}
              <button
                className={`btn btn-sm ${isPlaying ? 'btn-primary' : 'btn-secondary'}`}
                onClick={isPlaying ? onStop : () => onPlay(0)}
                disabled={!isPlaying && items.length === 0}
                title={isPlaying ? 'Stop playing' : `Play this ${noun} in the preview`}
              >
                {isPlaying ? STOP_ICON : PLAY_ICON} {isPlaying ? 'Stop' : 'Play'}
              </button>
              <button className="btn btn-primary btn-sm" onClick={onSave} disabled={items.length === 0}>Save</button>
            </div>
          </div>
          <div className="playlist-drop-zone" onDragOver={onEditorDragOver} onDragLeave={onEditorDragLeave} onDrop={onEditorDrop}>
          {items.length === 0 ? (
            <p className={`playlist-empty${pickerDrag ? ' drop-active' : ''}`}>
              {isScene
                ? 'Add designs from the list below to build your scene. It plays them in order, then starts again.'
                : 'Add designs, scenes or playlists from the list below to build your playlist.'}
              <span className="drag-hint"> You can also drag them in.</span>
            </p>
          ) : (
            <div className="playlist-items">
              {items.map((item, idx) => {
                const mode = editor.effectiveMode(item);
                const noTimes = noTimesReason(item);
                const label = itemLabel(item);
                return (
                <div
                  key={item.key}
                  data-item-index={idx}
                  className={[
                    'playlist-item',
                    dragKey === item.key ? 'dragging' : '',
                    isPlaying && playingIndex === idx ? 'playing' : '',
                    dropIndex === idx ? 'drop-before' : '',
                    dropIndex === items.length && idx === items.length - 1 ? 'drop-after' : '',
                  ].filter(Boolean).join(' ')}
                  aria-current={isPlaying && playingIndex === idx ? 'true' : undefined}
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
                      ? <span className={`playlist-tag${childKind(item.child_playlist_id) === 'scene' ? ' scene-tag' : ''}`}>{KIND_LABEL[childKind(item.child_playlist_id)]}</span>
                      : <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>({item.design_type})</span>}
                  </span>
                  <span className="playlist-item-timing">
                    {/* Play for X seconds, or X complete cycles (designs) / times through (playlists) */}
                    <span className="preview-mode-toggle playlist-item-mode" role="group" aria-label={`How long ${label} plays`}>
                      <button type="button" className={mode === 'seconds' ? 'active' : ''} aria-pressed={mode === 'seconds'} onClick={() => editor.updateItem(item.key, 'repeat_mode', 'seconds')}>sec</button>
                      <span title={noTimes ?? (item.child_playlist_id ? `Play the whole ${childKind(item.child_playlist_id)} this many times` : 'Play this many complete cycles of the effect')}>
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
                  <button className="btn-icon playlist-item-play" style={{ padding: '0.2rem' }} title="Play from here" aria-label={`Play from ${label}`} onClick={() => onPlay(idx)}>
                    {PLAY_ICON}
                  </button>
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
        </div>
        <div className="card">
          <div className="card-header picker-header">
            <h3 className="card-title">{isScene ? 'Add Design' : 'Add Design, Scene or Playlist'}</h3>
            <input
              type="search"
              className="form-input picker-search"
              aria-label="Search designs to add"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {shown.length === 0 ? (
            <p className="picker-empty">{query ? `Nothing matches “${search.trim()}”.` : 'Nothing saved yet.'}</p>
          ) : (
            <table className="table saved-designs-table picker-table">
              {pickerBody(showPickerFolders ? groupByFolder(shown) : [{ folder: null, items: shown }])}
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
