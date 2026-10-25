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
  // "Account for defective lights" switch (shown when onConsiderDefectiveChange is given)
  considerDefective?: boolean;
  onConsiderDefectiveChange?: (value: boolean) => void;
  // Example prompts; clicking one fills the textarea
  examples?: string[];
  // Shown under the spinner while generating (e.g. how long it usually takes)
  loadingNote?: string;
  // Extra fields under the description (e.g. a folder picker)
  children?: ReactNode;
}

const SPINNER = <svg className="spinning" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M21 12a9 9 0 11-6.2-8.56"/></svg>;

/** Prompt modal used for both "generate" and "edit" AI requests. */
export function AiPromptModal({
  title, intro, label, placeholder, value, onChange, loading, error, submitLabel, loadingLabel, onSubmit, onClose,
  considerDefective, onConsiderDefectiveChange, examples, loadingNote, children,
}: AiPromptModalProps) {
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
        {examples && examples.length > 0 && (
          <div className="ai-examples" role="group" aria-label="Example prompts">
            <span className="ai-examples-label">Try:</span>
            {examples.map((example) => (
              <button key={example} type="button" className="ai-example" onClick={() => onChange(example)} disabled={loading}>
                {example}
              </button>
            ))}
          </div>
        )}
        {children}
        {onConsiderDefectiveChange && (
          <div className="form-group ai-defective-toggle">
            <div className="live-preview-toggle">
              <button
                type="button"
                role="switch"
                aria-checked={considerDefective !== false}
                aria-labelledby="ai-consider-defective"
                className={`toggle-switch ${considerDefective !== false ? 'active' : ''}`}
                onClick={() => onConsiderDefectiveChange(considerDefective === false)}
                disabled={loading}
              />
              <span id="ai-consider-defective">Account for defective lights</span>
            </div>
            <p className="ai-defective-hint">
              {considerDefective !== false
                ? 'Colors are picked to read well on the channels that still work.'
                : 'Every channel is treated as working; colors may look different on lights with dead channels.'}
            </p>
          </div>
        )}
        {loading && loadingNote && <p className="ai-loading-note" role="status">{SPINNER} {loadingNote}</p>}
        {error && (
          <div style={{ color: 'var(--error)', marginBottom: '1rem' }} role="alert">
            {error}
          </div>
        )}

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={close}>Cancel</button>
          <button className="btn btn-primary" onClick={onSubmit} disabled={loading || !value.trim()}>
            {loading ? <>{SPINNER} {loadingLabel}</> : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
