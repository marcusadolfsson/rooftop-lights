import { useRef, useState } from 'react';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { canonicalFolder, MAX_FOLDER_LENGTH, normalizeFolder, sameFolder, UNFILED_LABEL } from '../../utils/folders';
import { trashIcon } from './SavedList';

/** Folder names in use plus the folder-wide actions (shared by every tab). */
export interface FolderControls {
  names: string[];
  // Renames the folder everywhere; onto an existing name it merges the two
  rename: (from: string, to: string) => Promise<void>;
  // Moves its items to Unfiled (asks first)
  remove: (name: string) => void;
}

export const FOLDER_ICON = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>;
export const MOVE_ICON = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><polyline points="11 10 14 13 11 16"/><line x1="7" y1="13" x2="14" y2="13"/></svg>;
const EDIT_ICON = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5z"/></svg>;
export const CHEVRON_ICON = <svg className="folder-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>;

const NEW_FOLDER = '\u0000new';

interface FolderSelectProps {
  id: string;
  // '' is Unfiled; anything else is a folder name (possibly a new one being typed)
  value: string;
  onChange: (value: string) => void;
  folders: string[];
  onEnter?: () => void;
}

/** Pick Unfiled, an existing folder, or "New folder…" (then type its name). */
export function FolderSelect({ id, value, onChange, folders, onEnter }: FolderSelectProps) {
  const [creating, setCreating] = useState(() => !!normalizeFolder(value) && !folders.some((f) => sameFolder(f, value.trim())));
  const typed = normalizeFolder(value);
  const existing = creating && typed ? folders.find((f) => sameFolder(f, typed)) : undefined;

  return (
    <>
      <select
        id={id}
        className="form-select"
        value={creating ? NEW_FOLDER : (typed ? canonicalFolder(typed, folders) : '')}
        onChange={(e) => {
          if (e.target.value === NEW_FOLDER) {
            setCreating(true);
            onChange('');
          } else {
            setCreating(false);
            onChange(e.target.value);
          }
        }}
      >
        <option value="">{UNFILED_LABEL}</option>
        {folders.map((f) => <option key={f} value={f}>{f}</option>)}
        <option value={NEW_FOLDER}>New folder…</option>
      </select>
      {creating && (
        <>
          <input
            type="text"
            className="form-input folder-new-input"
            aria-label="New folder name"
            placeholder="New folder name"
            maxLength={MAX_FOLDER_LENGTH}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onEnter?.(); }}
            autoFocus
          />
          {existing && <div className="folder-hint">Goes into the existing folder “{existing}”</div>}
        </>
      )}
    </>
  );
}

/** The folder to save: null for Unfiled, else the existing spelling or the new trimmed name. */
export const folderToSave = (value: string, folders: string[]): string | null => {
  const name = normalizeFolder(value);
  return name ? canonicalFolder(name, folders) : null;
};

interface MoveToFolderModalProps {
  itemName: string;
  current: string | null | undefined;
  folders: string[];
  onMove: (folder: string | null) => Promise<void> | void;
  onClose: () => void;
}

/** "Move to folder" for one saved design, scene or playlist (Unfiled included). */
export function MoveToFolderModal({ itemName, current, folders, onMove, onClose }: MoveToFolderModalProps) {
  const [value, setValue] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  useEscapeKey(true, onClose);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onMove(folderToSave(value, folders));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Move ${itemName} to folder`} style={{ maxWidth: '420px' }}>
        <div className="modal-header">
          <h3 className="modal-title">Move to Folder</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <p className="folder-modal-item">{itemName}</p>
        <div className="form-group">
          <label className="form-label" htmlFor="move-folder-select">Folder</label>
          <FolderSelect id="move-folder-select" value={value} onChange={setValue} folders={folders} onEnter={submit} />
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>Move</button>
        </div>
      </div>
    </div>
  );
}

interface FolderHeaderRowProps {
  // null: the Unfiled group
  folder: string | null;
  // Shown instead of the folder name (sub-groups such as "Motion")
  label?: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  colSpan: number;
  // A sub-group heading inside a folder
  sub?: boolean;
  // Rename / delete buttons (real folders only)
  controls?: FolderControls;
}

/** Collapsible group heading row for the saved lists and pickers. */
export function FolderHeaderRow({ folder, label, count, collapsed, onToggle, colSpan, sub, controls }: FolderHeaderRowProps) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  // Enter and the blur that follows it would otherwise both submit
  const submittingRef = useRef(false);
  const name = label ?? folder ?? UNFILED_LABEL;

  const finishRename = async () => {
    if (submittingRef.current || folder === null || !controls) return;
    const next = normalizeFolder(renameValue);
    if (!next || next === folder) {
      setRenaming(false);
      return;
    }
    submittingRef.current = true;
    try {
      await controls.rename(folder, next);
      setRenaming(false);
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <tr className={`folder-row${sub ? ' folder-row-sub' : ''}${folder === null && !sub ? ' folder-row-unfiled' : ''}`}>
      <td colSpan={colSpan}>
        <div className="folder-row-inner">
          {renaming ? (
            <input
              className="form-input folder-rename-input"
              aria-label={`Rename folder ${name}`}
              maxLength={MAX_FOLDER_LENGTH}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') finishRename();
                if (e.key === 'Escape') { e.preventDefault(); setRenaming(false); }
              }}
              onBlur={finishRename}
              autoFocus
            />
          ) : (
            <button type="button" className="folder-toggle" aria-expanded={!collapsed} onClick={onToggle}>
              {CHEVRON_ICON}
              {!sub && <span className="folder-icon">{FOLDER_ICON}</span>}
              <span className="folder-name">{name}</span>
              <span className="folder-count">{count}</span>
            </button>
          )}
          {controls && folder !== null && !renaming && (
            <span className="folder-actions">
              <button type="button" className="btn-icon" title="Rename folder" aria-label={`Rename folder ${folder}`} onClick={() => { setRenameValue(folder); setRenaming(true); }}>
                {EDIT_ICON}
              </button>
              <button type="button" className="btn-icon folder-delete" title="Delete folder (items move to Unfiled)" aria-label={`Delete folder ${folder}`} onClick={() => controls.remove(folder)}>
                {trashIcon(12)}
              </button>
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}
