import { useState, type ReactNode } from 'react';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { FolderSelect, folderToSave } from './Folders';

interface NameModalProps {
  title: string;
  label: string;
  placeholder: string;
  initialName?: string;
  // Folder names to pick from; with them the modal also asks which folder to save into
  folders?: string[];
  initialFolder?: string | null;
  onSave: (name: string, folder: string | null) => void;
  onClose: () => void;
}

/** "Save As" style modal asking for a name (and, given `folders`, a folder). */
export function NameModal({ title, label, placeholder, initialName = '', folders, initialFolder, onSave, onClose }: NameModalProps) {
  const [name, setName] = useState(initialName);
  const [folder, setFolder] = useState(initialFolder ?? '');
  const submit = () => { if (name.trim()) onSave(name.trim(), folders ? folderToSave(folder, folders) : null); };
  useEscapeKey(true, onClose);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h3 className="modal-title">{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="name-modal-input">{label}</label>
          <input
            id="name-modal-input"
            type="text"
            className="form-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder={placeholder}
            autoFocus
          />
        </div>

        {folders && (
          <div className="form-group">
            <label className="form-label" htmlFor="name-modal-folder">Folder</label>
            <FolderSelect id="name-modal-folder" value={folder} onChange={setFolder} folders={folders} onEnter={submit} />
          </div>
        )}

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={!name.trim()}>Save</button>
        </div>
      </div>
    </div>
  );
}

interface AiPromptModalProps {
  title: string;
  intro?: ReactNode;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  loading: boolean;
  error: string | null;
  submitLabel: string;
  loadingLabel: string;
  onSubmit: () => void;
  onClose: () => void;
}

/** Prompt modal used for both "generate" and "edit" AI requests. */
export function AiPromptModal({ title, intro, label, placeholder, value, onChange, loading, error, submitLabel, loadingLabel, onSubmit, onClose }: AiPromptModalProps) {
  const close = () => { if (!loading) onClose(); };
  useEscapeKey(true, close);
  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h3 className="modal-title">{title}</h3>
          <button className="modal-close" onClick={close} aria-label="Close">&times;</button>
        </div>

        {intro}

        <div className="form-group">
          <label className="form-label" htmlFor="ai-prompt-input">{label}</label>
          <textarea
            id="ai-prompt-input"
            className="form-input"
            rows={3}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            disabled={loading}
            style={{ resize: 'vertical' }}
            autoFocus
          />
        </div>
        {error && (
          <div style={{ color: 'var(--error)', marginBottom: '1rem' }} role="alert">
            {error}
          </div>
        )}

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={close}>Cancel</button>
          <button className="btn btn-primary" onClick={onSubmit} disabled={loading || !value.trim()}>
            {loading ? loadingLabel : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
