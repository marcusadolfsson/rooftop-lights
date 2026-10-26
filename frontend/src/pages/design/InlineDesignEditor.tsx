import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { PreviewControls } from '../../hooks/usePreview';
import type { Design, EffectType, LayoutData, RGBW } from '../../types';
import { StaticDesignEditor } from './StaticPanel';
import { MotionDesignEditor } from './MotionPanel';
import { NameModal } from './Modals';
import { useMotionEditor, useStaticEditor } from './editors';

export type DesignType = Design['type'];

/** What the scene editor needs from the page to edit designs in place. */
export interface InlineEditContext {
  preview: PreviewControls;
  reload: () => Promise<void>;
  setError: (message: string) => void;
  // The page is showing (edits only auto-preview then)
  active: boolean;
  layout: LayoutData;
  effectTypes: EffectType[];
  hasRGBW: boolean;
  currentColor: RGBW;
  setCurrentColor: (color: RGBW) => void;
  // Every folder name, for the name prompt of a new design or a copy
  folders: string[];
  // True while the open inline editor has unsaved changes (read by the guards)
  dirtyRef: RefObject<boolean>;
  // An inline editor opened / the last one closed (the preview switches to the design and back)
  onEditStart: () => void;
  onEditEnd: () => void;
}

export type InlineSaveResult =
  | { as: 'update' }
  // A copy for this row only, or a brand-new design for the scene
  // (`folder` is the one picked in the name prompt)
  | { as: 'copy' | 'new'; design: Design; folder: string | null };

interface InlineDesignEditorProps {
  ctx: InlineEditContext;
  // The design to edit, or null for a new one of `type`
  design: Design | null;
  type: DesignType;
  // Other scenes / playlists, and other rows of this one, that play the same design
  usage: { lists: number; rows: number };
  // Folder a new design or a copy is saved into by default (the scene's, or one named after it)
  defaultFolder: string | null;
  // Why new designs / copies can't be made yet (an unsaved scene has no name to file them under)
  cantCreate?: string;
  noun: string;
  onSaved: (result: InlineSaveResult) => void;
  onCancel: () => void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * A static painter or motion editor opened under a scene row. It has its own editor state (the
 * Static / Motion tabs keep theirs); edits preview in the browser, and on the lights only with
 * Live Preview on, just as they do in those tabs.
 */
export default function InlineDesignEditor({ ctx, design, type, usage, defaultFolder, cantCreate, noun, onSaved, onCancel }: InlineDesignEditorProps) {
  const { preview, reload, setError, active, layout, effectTypes, hasRGBW, currentColor, setCurrentColor, folders, dirtyRef } = ctx;
  const staticEditor = useStaticEditor({ preview, reload, setError, autoPreview: active && type === 'static' });
  const motionEditor = useMotionEditor({ preview, reload, setError, autoPreview: active && type === 'motion', effectTypes });
  const [nameModal, setNameModal] = useState<'copy' | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const isNew = design === null;
  const isStatic = type === 'static';

  // A new motion design counts as changed once an effect is picked
  const dirty = isStatic ? staticEditor.hasChanges : motionEditor.hasChanges || (isNew && !!motionEditor.effect);
  const canSave = isNew ? (isStatic ? staticEditor.hasChanges : !!motionEditor.effect) : dirty;
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty, dirtyRef]);
  useEffect(() => () => { dirtyRef.current = false; }, [dirtyRef]);

  // Open on the saved design (which also previews it), or on a blank frame for a new one
  useEffect(() => {
    if (design) {
      if (isStatic) staticEditor.load(design);
      else {
        const first = motionEditor.load(design);
        if (first) setCurrentColor({ ...first });
      }
    } else {
      preview.send({ kind: 'static', colors: {} });
    }
    // Only on open: the editor is remounted for another row
  }, []);

  const save = async () => {
    if (isNew) {
      setNameModal('new');
      return;
    }
    setSaving(true);
    const ok = isStatic ? await staticEditor.save() : await motionEditor.save();
    setSaving(false);
    if (ok) onSaved({ as: 'update' });
  };

  const saveNamed = async (name: string, folder: string | null) => {
    const as = nameModal;
    if (!as) return;
    setSaving(true);
    const created = isStatic ? await staticEditor.saveAs(name, folder) : await motionEditor.saveAs(name, folder);
    setSaving(false);
    if (!created) return;
    setNameModal(null);
    onSaved({ as, design: created, folder });
  };

  const shared = !isNew && (usage.lists > 0 || usage.rows > 0);
  const sharedWhere = [
    usage.lists > 0 ? plural(usage.lists, 'other scene/show', 'other scenes/shows') : '',
    usage.rows > 0 ? plural(usage.rows, `more row of this ${noun}`, `more rows of this ${noun}`) : '',
  ].filter(Boolean).join(' and ');

  return (
    <div className="inline-editor" role="region" aria-label={isNew ? `New ${type} design` : `Edit ${design.name}`}>
      <div className="inline-editor-head">
        <span className="inline-editor-title">
          {isNew ? `New ${type} design` : <>Editing <strong>{design.name}</strong></>}
          <span className="inline-editor-type">({type})</span>
        </span>
        <div className="btn-group inline-editor-actions">
          <button className="btn btn-primary btn-sm" onClick={save} disabled={!canSave || saving}>{isNew ? 'Save…' : 'Save'}</button>
          {!isNew && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setNameModal('copy')}
              disabled={saving || !!cantCreate || (!isStatic && !motionEditor.effect)}
              title={cantCreate ?? 'Save the edits as a new design and use it in this row only; the original stays as it is'}
            >
              Save as copy (only this {noun})
            </button>
          )}
          <button className="btn btn-secondary btn-sm" onClick={onCancel} disabled={saving}>Cancel</button>
        </div>
      </div>
      {shared && (
        <p className="inline-editor-usage" role="note">
          Also used in {sharedWhere}. <strong>Save</strong> changes it there too; <strong>Save as copy</strong> changes only this row.
        </p>
      )}
      <div className="design-layout inline-editor-layout">
        {isStatic ? (
          <StaticDesignEditor
            editor={staticEditor}
            layout={layout}
            currentColor={currentColor}
            setCurrentColor={setCurrentColor}
            hasRGBW={hasRGBW}
          />
        ) : (
          <MotionDesignEditor
            editor={motionEditor}
            // AI effects are generated from a prompt in the Motion tab
            effectTypes={effectTypes.filter((fx) => fx.type !== 'ai')}
            walls={layout.walls}
            currentColor={currentColor}
            setCurrentColor={setCurrentColor}
            hasRGBW={hasRGBW}
          />
        )}
      </div>

      {/* On <body>: the scene card around the editor is transformed on hover, which would trap a fixed overlay */}
      {nameModal && createPortal(
        <NameModal
          title={nameModal === 'copy' ? 'Save as Copy' : 'Save Design'}
          label="Design Name"
          placeholder="Enter design name"
          initialName={nameModal === 'copy' && design ? `${design.name} (copy)` : ''}
          folders={folders}
          initialFolder={defaultFolder}
          onSave={saveNamed}
          onClose={() => setNameModal(null)}
        />,
        document.body,
      )}
    </div>
  );
}
