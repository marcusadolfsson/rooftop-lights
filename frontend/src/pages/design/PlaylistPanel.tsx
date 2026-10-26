import { Fragment, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { Cue, Design, Playlist, PlaylistKind } from '../../types';
import SavedList, { trashIcon } from './SavedList';
import { FolderHeaderRow, type FolderControls } from './Folders';
import { canonicalFolder, groupByFolder, groupKey, hasFolders, MAX_FOLDER_LENGTH, normalizeFolder, sameFolder, useCollapsedGroups } from '../../utils/folders';
import { DEFAULT_CUE, formatSeconds, KIND_LABEL, MAX_REPEAT_COUNT, playlistKind, type EditingPlaylistItem, type PlaylistEditor } from './editors';
import InlineDesignEditor, { type DesignType, type InlineEditContext, type InlineSaveResult } from './InlineDesignEditor';

interface PlaylistPanelProps {
  // A scene editor or a playlist editor (editor.kind)
  editor: PlaylistEditor;
  designs: Design[];
  // Every playlist and scene
  playlists: Playlist[];
  sidebarHeader: ReactNode;
  onSave: () => void;
  onMove: (id: string, folder: string | null) => Promise<void>;
  folders: FolderControls;
  // Playback of the editor's current items in the preview; playingIndex is the item playing now
  isPlaying: boolean;
  playingIndex: number | null;
  onPlay: (startIndex: number) => void;
  onStop: () => void;
  // Edit designs in place (pencil on each design row, + New static / motion); scenes only
  inline?: InlineEditContext;
}

// The design open in the inline editor: a row's, or a new one (shown as a draft row at the end)
type InlineTarget = { kind: 'item'; key: string } | { kind: 'new'; type: DesignType; id: number };
let nextDraftId = 0;

type PickerType = 'static' | 'motion' | 'scene' | 'playlist';
const PICKER_TYPES: { type: PickerType; label: string }[] = [
  { type: 'static', label: 'Static' },
  { type: 'motion', label: 'Effects' },
  { type: 'scene', label: 'Scenes' },
  { type: 'playlist', label: 'Shows' },
];

/** One row of the Add picker: a design, scene or playlist that can go into the editor. */
interface PickerEntry {
  id: string;
  name: string;
  folder?: string | null;
  type: PickerType;
  meta?: string;
  // With a cue, adds it as a timed event instead of to the loop
  add: (at?: number, cue?: Cue) => void;
}

const PLAY_ICON = <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"/></svg>;
const STOP_ICON = <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>;

export default function PlaylistPanel({
  editor, designs, playlists, sidebarHeader, onSave, onMove, folders, isPlaying, playingIndex, onPlay, onStop, inline,
}: PlaylistPanelProps) {
  const { selectedPlaylist, items, dragKey, isScene, noun } = editor;
  const kindLabel = KIND_LABEL[editor.kind];
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
    const item = items.find((i) => i.key === moved.key);
    if (!item) return;
    const list = items.filter((i) => !i.cue === !item.cue);
    const idx = list.indexOf(item);
    const atEnd = moved.delta === -1 ? idx === 0 : idx === list.length - 1;
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

  // --- inline design editing (one editor open at a time) ---

  const [inlineTarget, setInlineTarget] = useState<InlineTarget | null>(null);
  const inlineOpenRef = useRef(false);
  inlineOpenRef.current = inlineTarget !== null;
  const inlineEnd = inline?.onEditEnd;
  const inlineEndRef = useRef(inlineEnd);
  inlineEndRef.current = inlineEnd;
  // Leaving the tab with an editor open still hands the preview back
  useEffect(() => () => { if (inlineOpenRef.current) inlineEndRef.current?.(); }, []);

  // True when nothing unsaved would be lost, or the user agrees to lose it
  const confirmDiscard = () =>
    !inline?.dirtyRef.current || confirm('Discard the unsaved changes to the design you are editing?');

  const openInline = (target: InlineTarget) => {
    if (!inline || !confirmDiscard()) return;
    if (!inlineTarget) inline.onEditStart();
    inline.dirtyRef.current = false;
    setInlineTarget(target);
  };
  const closeInline = (force = false): boolean => {
    if (!inline || !inlineTarget) return true;
    if (!force && !confirmDiscard()) return false;
    inline.dirtyRef.current = false;
    setInlineTarget(null);
    inline.onEditEnd();
    return true;
  };
  const toggleInline = (key: string) => {
    if (inlineTarget?.kind === 'item' && inlineTarget.key === key) closeInline();
    else openInline({ kind: 'item', key });
  };

  // The edited row went away (another scene loaded, row removed): close without asking
  useEffect(() => {
    if (inlineTarget?.kind === 'item' && !items.some((i) => i.key === inlineTarget.key)) closeInline(true);
  });

  // New designs and copies are filed with the scene: in its folder, or (an unfiled scene) in a new
  // folder named after it, which the scene then moves into too. Unsaved scenes have no name yet.
  const savedScene = selectedPlaylist ? playlists.find((p) => p.id === selectedPlaylist.id) ?? selectedPlaylist : null;
  const sceneFolder = normalizeFolder(savedScene?.folder);
  const sceneNamedFolder = savedScene
    ? canonicalFolder((normalizeFolder(savedScene.name) ?? '').slice(0, MAX_FOLDER_LENGTH).trim(), inline?.folders ?? [])
    : null;
  const newDesignFolder = sceneFolder ?? (sceneNamedFolder || null);
  const cantCreate = savedScene ? undefined : `Save the ${noun} first; new designs are filed in a folder with it`;

  const onInlineSaved = (key: string | null, result: InlineSaveResult) => {
    if (result.as === 'copy' && key) editor.replaceItemDesign(key, result.design);
    if (result.as === 'new') editor.addNewDesign(result.design);
    if (result.as !== 'update' && savedScene && !sceneFolder && result.folder && sceneNamedFolder && sameFolder(result.folder, sceneNamedFolder)) {
      void onMove(savedScene.id, result.folder);
    }
    closeInline(true);
  };

  // Other scenes / playlists and other rows of this one that play the design
  const usageOf = (designId: string) => ({
    lists: playlists.filter((p) => p.id !== selectedPlaylist?.id && p.items.some((i) => i.design_id === designId)).length,
    rows: items.filter((i) => i.design_id === designId).length - 1,
  });

  const renderInlineEditor = (key: string, design: Design | null, type: DesignType) => inline && (
    <InlineDesignEditor
      key={key}
      ctx={inline}
      design={design}
      type={type}
      usage={design ? usageOf(design.id) : { lists: 0, rows: 0 }}
      defaultFolder={newDesignFolder}
      cantCreate={cantCreate}
      noun={noun}
      onSaved={(result) => onInlineSaved(inlineTarget?.kind === 'item' ? inlineTarget.key : null, result)}
      onCancel={() => closeInline(true)}
    />
  );

  // Guarded versions of actions that would drop the open inline editor
  const guarded = (action: () => void) => () => { if (closeInline()) action(); };
  const removeItem = (key: string) => {
    if (inlineTarget?.kind === 'item' && inlineTarget.key === key && !closeInline()) return;
    editor.removeItem(key);
  };

  // --- Add picker: grouped by folder, then type; rows can be dragged into the item list ---

  const [search, setSearch] = useState('');
  const query = search.trim().toLocaleLowerCase();
  const pickerGroups = useCollapsedGroups(`picker-${editor.kind}`);
  const entries: PickerEntry[] = [
    ...designs.map((d): PickerEntry => ({
      id: d.id, name: d.name, folder: d.folder, type: d.type,
      add: (at, cue) => editor.addDesign(d.id, at, cue),
    })),
    ...[...addableScenes, ...addablePlaylists].map((p): PickerEntry => ({
      id: p.id, name: p.name, folder: p.folder, type: playlistKind(p),
      meta: `${p.items.length} items${p.totalSeconds ? ` · ${formatSeconds(p.totalSeconds)}` : ''}`,
      add: (at, cue) => editor.addPlaylist(p.id, at, cue),
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
  // Dropped on the Timed events list: added as an event
  const [eventDrop, setEventDrop] = useState(false);
  const onEventsDragOver = (e: DragEvent<HTMLElement>) => {
    if (!pickerDrag) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (dropIndex !== null) setDropIndex(null);
    if (!eventDrop) setEventDrop(true);
  };
  const onEventsDragLeave = (e: DragEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setEventDrop(false);
  };
  const onEventsDrop = (e: DragEvent<HTMLElement>) => {
    if (!pickerDrag) return;
    e.preventDefault();
    e.stopPropagation();
    pickerDrag.add(undefined, DEFAULT_CUE);
    setEventDrop(false);
    endPickerDrag();
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
    const label = isList ? `Add ${entry.type === 'playlist' ? 'show' : entry.type} ${entry.name} to ${noun}` : `Add ${entry.name} (${entry.type === 'motion' ? 'effect' : entry.type}) to ${noun}`;
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

  // Start a new design right in the scene; it's added at the end when saved
  const addNewButtons = inline && (
    <div className="playlist-add-new" role="group" aria-label={`New design for this ${noun}`}>
      {(['static', 'motion'] as const).map((type) => (
        <button
          key={type}
          type="button"
          className={`btn btn-sm ${inlineTarget?.kind === 'new' && inlineTarget.type === type ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => openInline({ kind: 'new', type, id: ++nextDraftId })}
          disabled={!!cantCreate}
          title={cantCreate}
        >
          + New {type === 'motion' ? 'effect' : type}
        </button>
      ))}
      {cantCreate && <span className="playlist-add-new-hint">Save the {noun} to make new designs here.</span>}
    </div>
  );

  const loopItems = items.filter((i) => !i.cue);
  const eventItems = items.filter((i) => i.cue);

  // One item row (and its inline editor); `list` is the list it sits in (the loop or the events)
  const renderRow = (item: EditingPlaylistItem, list: EditingPlaylistItem[]) => {
      const idx = items.indexOf(item);
    const isEvent = item.cue !== null;
    const mode = editor.effectiveMode(item);
      const noTimes = noTimesReason(item);
      const label = itemLabel(item);
      const itemDesign = item.design_id ? designs.find((d) => d.id === item.design_id) : undefined;
      const editing = inlineTarget?.kind === 'item' && inlineTarget.key === item.key;
      return (
      <Fragment key={item.key}>
      <div
        data-item-index={isEvent ? undefined : idx}
        className={[
          'playlist-item',
          editing ? 'editing' : '',
          dragKey === item.key ? 'dragging' : '',
          isPlaying && playingIndex === idx ? 'playing' : '',
          !isEvent && dropIndex === idx ? 'drop-before' : '',
          !isEvent && dropIndex === items.length && item === list[list.length - 1] ? 'drop-after' : '',
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
          aria-label={`Reorder ${label}, position ${list.indexOf(item) + 1} of ${list.length}. Use up and down arrow keys to move.`}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') { e.preventDefault(); editor.moveItem(item.key, -1); }
            if (e.key === 'ArrowDown') { e.preventDefault(); editor.moveItem(item.key, 1); }
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>
        </span>
        {inline && item.design_id && (
          // Disclosure triangle: shows the design's details (its editor) under the row
          <button
            type="button"
            className={`btn-icon playlist-item-disclosure${editing ? ' open' : ''}`}
            title={!itemDesign?.data ? 'This design can\'t be edited (missing or corrupt)' : editing ? 'Hide details' : 'Show details'}
            aria-label={`${editing ? 'Hide' : 'Show'} details for ${label}`}
            aria-expanded={editing}
            disabled={!itemDesign?.data}
            onClick={() => toggleInline(item.key)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5l10 7-10 7z"/></svg>
          </button>
        )}
        <span className="playlist-item-name">
          {label}{' '}
          {item.child_playlist_id
            ? <span className={`playlist-tag${childKind(item.child_playlist_id) === 'scene' ? ' scene-tag' : ''}`}>{KIND_LABEL[childKind(item.child_playlist_id)]}</span>
            : <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>({item.design_type === 'motion' ? 'effect' : item.design_type})</span>}
        </span>
        {item.cue && <CueEditor cue={item.cue} label={label} onChange={(cue) => editor.updateCue(item.key, cue)} />}
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
          <button type="button" className="btn-icon" ref={moveButtonRef(item.key, -1)} aria-label={`Move ${label} up`} disabled={list[0] === item} onClick={() => move(item.key, -1)}>↑</button>
          <button type="button" className="btn-icon" ref={moveButtonRef(item.key, 1)} aria-label={`Move ${label} down`} disabled={list[list.length - 1] === item} onClick={() => move(item.key, 1)}>↓</button>
        </span>
        <button className="btn-icon playlist-item-play" style={{ padding: '0.2rem' }} title={isEvent ? 'Play this event now, then the loop' : 'Play from here'} aria-label={isEvent ? `Play event ${label} now` : `Play from ${label}`} onClick={() => onPlay(idx)}>
          {PLAY_ICON}
        </button>
        <button className="btn-icon" style={{ padding: '0.2rem', color: 'var(--danger-color)' }} title="Remove" aria-label={`Remove ${label}`} onClick={() => removeItem(item.key)}>
          {trashIcon(14)}
        </button>
      </div>
      {editing && itemDesign && renderInlineEditor(item.key, itemDesign, itemDesign.type)}
      </Fragment>
      );
  };

  return (
    <div className="design-layout">
      <div className="design-sidebar">
        {sidebarHeader}
        <SavedList
          title={isScene ? 'Saved Scenes' : 'Saved Shows'}
          items={editor.saved.map((p) => ({
            id: p.id,
            name: p.name,
            folder: p.folder,
            meta: (
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
              {p.items.length} items{p.totalSeconds ? ` · ${formatSeconds(p.totalSeconds)}` : ''}
            </span>
          ),
          }))}
          selectedId={selectedPlaylist?.id}
          onSelect={(id) => { const p = playlists.find((x) => x.id === id); if (p) guarded(() => editor.load(p))(); }}
          onRename={editor.rename}
          onDelete={editor.remove}
          scope={editor.kind}
          folders={folders}
          onMove={onMove}
        />
        <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={guarded(editor.startNew)}>New {kindLabel}</button>
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
              {/* Only offered when there is something new to save */}
              {items.length > 0 && editor.hasChanges && (
                <button className="btn btn-primary btn-sm" onClick={onSave}>Save</button>
              )}
            </div>
          </div>
          <div className="playlist-drop-zone" onDragOver={onEditorDragOver} onDragLeave={onEditorDragLeave} onDrop={onEditorDrop}>
          {loopItems.length === 0 && inlineTarget?.kind !== 'new' ? (
            <>
              <p className={`playlist-empty${pickerDrag ? ' drop-active' : ''}`}>
                {isScene
                  ? `Add designs from the list below${inline ? ', or make a new one here,' : ''} to build your scene. It plays them in order, then starts again.`
                  : 'Add designs, scenes or other shows from the list below to build your show.'}
                <span className="drag-hint"> You can also drag them in.</span>
              </p>
              {addNewButtons}
            </>
          ) : (
            <div className="playlist-items">
              {loopItems.map((item) => renderRow(item, loopItems))}
              {inlineTarget?.kind === 'new' && (
                <>
                  <div className="playlist-item editing playlist-item-draft">
                    <span className="playlist-item-name">
                      New {inlineTarget.type === 'motion' ? 'effect' : 'static design'}{' '}
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>(not saved yet; added here when you save)</span>
                    </span>
                  </div>
                  {renderInlineEditor(`new-${inlineTarget.id}`, null, inlineTarget.type)}
                </>
              )}
              {(() => {
                const total = loopItems.length > 0 && (
                  <div className="playlist-total">
                    {editor.mode === 'random' ? 'One round of every item' : eventItems.length > 0 ? 'Loop' : 'Total'} <strong>{formatSeconds(editor.totalSeconds)}</strong>
                  </div>
                );
                return inline ? <div className="playlist-footer">{addNewButtons}{total}</div> : total;
              })()}
            </div>
          )}
          </div>
          {!isScene && (
            <div
              className={`playlist-events${eventDrop ? ' drop-active' : ''}`}
              onDragOver={onEventsDragOver}
              onDragLeave={onEventsDragLeave}
              onDrop={onEventsDrop}
            >
              <div className="playlist-events-header">
                <h4>Timed events</h4>
                <select
                  className="form-select playlist-events-add"
                  aria-label="Add a timed event"
                  value=""
                  onChange={(e) => {
                    const entry = entries.find((x) => `${x.type}:${x.id}` === e.target.value);
                    entry?.add(undefined, DEFAULT_CUE);
                  }}
                >
                  <option value="">+ Add event…</option>
                  {PICKER_TYPES.map(({ type, label }) => {
                    const ofType = entries.filter((x) => x.type === type);
                    return ofType.length === 0 ? null : (
                      <optgroup key={type} label={label}>
                        {ofType.map((x) => <option key={x.id} value={`${x.type}:${x.id}`}>{x.name}</option>)}
                      </optgroup>
                    );
                  })}
                </select>
              </div>
              {eventItems.length === 0 ? (
                <p className="playlist-events-empty">
                  Play something at set times, like a show at 21:00 or every 30 minutes. It interrupts the loop, plays for its seconds or times, then the loop carries on where it left off.
                  <span className="drag-hint"> You can drag designs here too.</span>
                </p>
              ) : (
                <>
                  <div className="playlist-items">{eventItems.map((item) => renderRow(item, eventItems))}</div>
                  <p className="playlist-events-note">Times are the controller's local time. When two events are due at once, the higher one plays; one that comes due while another is playing is skipped. The transition is used going in and coming back out.</p>
                </>
              )}
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-header picker-header">
            <h3 className="card-title">{isScene ? 'Add Design' : 'Add Design, Scene or Show'}</h3>
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

/** When a timed event plays: at a time of day, or every N minutes (optionally only between two times). */
function CueEditor({ cue, label, onChange }: { cue: Cue; label: string; onChange: (cue: Cue) => void }) {
  return (
    <span className="cue-editor">
      <select
        className="form-select"
        aria-label={`When ${label} plays`}
        value={cue.type}
        onChange={(e) => onChange(e.target.value === 'every'
          ? { type: 'every', minutes: 30, from: null, until: null }
          : { type: 'at', time: cue.type === 'every' && cue.from ? cue.from : '21:00' })}
      >
        <option value="at">At</option>
        <option value="every">Every</option>
      </select>
      {cue.type === 'at' ? (
        <input type="time" className="form-input cue-time" aria-label={`Time ${label} plays`} value={cue.time} required
          onChange={(e) => { if (e.target.value) onChange({ ...cue, time: e.target.value }); }} />
      ) : (
        <>
          <input type="number" className="form-input cue-minutes" aria-label={`Minutes between plays of ${label}`} min="1" max="1440" value={cue.minutes}
            onChange={(e) => onChange({ ...cue, minutes: Math.min(1440, Math.max(1, parseInt(e.target.value) || 1)) })} />
          <span className="cue-unit">min</span>
          <span className="cue-unit">from</span>
          <input type="time" className="form-input cue-time" aria-label={`Start of the window for ${label} (empty = midnight)`} value={cue.from ?? ''}
            onChange={(e) => onChange({ ...cue, from: e.target.value || null })} />
          <span className="cue-unit">to</span>
          <input type="time" className="form-input cue-time" aria-label={`End of the window for ${label} (empty = all day)`} value={cue.until ?? ''}
            onChange={(e) => onChange({ ...cue, until: e.target.value || null })} />
        </>
      )}
    </span>
  );
}
