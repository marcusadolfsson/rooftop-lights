import { useRef, useState, type ReactNode } from 'react';
import { useIsMobile } from '../../hooks/useMediaQuery';

export interface SavedListItem {
  id: string;
  name: string;
  // Extra text after the name (e.g. "3 items")
  meta?: ReactNode;
  // Extra row buttons, shown before rename/delete
  actions?: ReactNode;
}

interface SavedListProps {
  title: string;
  items: SavedListItem[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => void;
}

const EDIT_ICON = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5z"/></svg>;
export const trashIcon = (size = 13) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>;

/** Saved designs / playlists sidebar card: select, inline rename, delete. */
export default function SavedList({ title, items, selectedId, onSelect, onRename, onDelete }: SavedListProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Enter and the blur that follows it would otherwise both submit
  const submittingRef = useRef(false);
  // On phones the list sits above the editor, so it starts collapsed and folds
  // away again after a pick to bring the editor back into view
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(true);
  const hidden = isMobile && collapsed && renamingId === null;
  const selectedName = items.find((i) => i.id === selectedId)?.name;
  const select = (id: string) => {
    onSelect(id);
    if (isMobile) setCollapsed(true);
  };

  const finishRename = async (id: string) => {
    if (submittingRef.current) return;
    const name = renameValue.trim();
    const original = items.find((i) => i.id === id)?.name;
    if (!name || name === original) {
      setRenamingId(null);
      return;
    }
    submittingRef.current = true;
    try {
      await onRename(id, name);
      setRenamingId(null);
      setRenameValue('');
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <div className="card">
      {isMobile ? (
        <button
          type="button"
          className="saved-list-toggle"
          aria-expanded={!hidden}
          onClick={() => setCollapsed(!collapsed)}
        >
          <span className="card-title">{title} <span className="saved-list-count">({items.length})</span></span>
          {hidden && selectedName && <span className="saved-list-current">{selectedName}</span>}
          <svg className="saved-list-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      ) : (
        <div className="card-header" style={{ marginBottom: '0.375rem', paddingBottom: '0.375rem' }}>
          <h3 className="card-title">{title}</h3>
        </div>
      )}
      <div className="saved-designs-scroll" style={{ maxHeight: 'none' }} hidden={hidden}>
        <table className="table saved-designs-table">
          <tbody>
            {items.map((item) => {
              const selected = selectedId === item.id;
              return (
                <tr
                  key={item.id}
                  style={{ cursor: 'pointer', backgroundColor: selected ? 'var(--bg-tertiary)' : undefined, borderLeft: selected ? '3px solid var(--primary-color)' : '3px solid transparent' }}
                  onClick={() => select(item.id)}
                >
                  <td style={{ fontWeight: selected ? 600 : 400 }}>
                    {renamingId === item.id ? (
                      <input
                        className="form-input"
                        style={{ padding: '0.2rem 0.4rem', fontSize: '0.8rem', width: '100%' }}
                        aria-label={`Rename ${item.name}`}
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') finishRename(item.id);
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        onBlur={() => finishRename(item.id)}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                      />
                    ) : (
                      // Real button so the row is reachable and activatable from the keyboard;
                      // the row's onClick still handles mouse clicks anywhere in the row
                      <button
                        type="button"
                        className="saved-item-button"
                        aria-current={selected ? 'true' : undefined}
                        onClick={(e) => { e.stopPropagation(); select(item.id); }}
                      >
                        {item.name}{item.meta && <> {item.meta}</>}
                      </button>
                    )}
                  </td>
                  <td style={{ width: '1px', whiteSpace: 'nowrap' }}>
                    {item.actions}
                    <button className="btn-icon" style={{ padding: '0.2rem' }} title="Rename" aria-label={`Rename ${item.name}`} onClick={(e) => { e.stopPropagation(); setRenamingId(item.id); setRenameValue(item.name); }}>
                      {EDIT_ICON}
                    </button>
                    <button className="btn-icon" style={{ padding: '0.2rem', color: 'var(--danger-color)' }} title="Delete" aria-label={`Delete ${item.name}`} onClick={(e) => { e.stopPropagation(); onDelete(item.id); }}>
                      {trashIcon()}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
