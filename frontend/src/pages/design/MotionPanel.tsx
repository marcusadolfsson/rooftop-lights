import type { ReactNode } from 'react';
import type { Design, EffectType, RGBW, Wall } from '../../types';
import { rgbwToCss } from '../../utils/color';
import ColorPicker from './ColorPicker';
import SavedList from './SavedList';
import type { MotionEditor } from './editors';

interface MotionPanelProps {
  editor: MotionEditor;
  designs: Design[];
  effectTypes: EffectType[];
  walls: Wall[];
  sidebarHeader: ReactNode;
  currentColor: RGBW;
  setCurrentColor: (color: RGBW) => void;
  hasRGBW: boolean;
  onSaveAs: () => void;
  onRenameDesign: (id: string, name: string) => Promise<void>;
  onDeleteDesign: (id: string) => void;
  onOpenAiGenerator: () => void;
  onOpenAiEditor: () => void;
}

const SCOPES = [
  { value: 'all', label: 'Continuous' },
  { value: 'wall', label: 'Per Wall' },
  { value: 'group', label: 'Per Group' },
] as const;

export default function MotionPanel({
  editor, designs, effectTypes, walls, sidebarHeader, currentColor, setCurrentColor, hasRGBW,
  onSaveAs, onRenameDesign, onDeleteDesign, onOpenAiGenerator, onOpenAiEditor,
}: MotionPanelProps) {
  const { selectedDesign, effect, colors, speed, scope, params, selectedColorIdx, hasChanges } = editor;
  const isAi = effect?.type === 'ai';

  const pickColor = (first: RGBW | undefined) => { if (first) setCurrentColor({ ...first }); };

  // Picker changes recolor the selected palette entry
  const handleColorChange = (color: RGBW) => {
    setCurrentColor(color);
    editor.setColorAt(selectedColorIdx, color);
  };

  return (
    <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
      <div className="design-sidebar">
        {sidebarHeader}
        <SavedList
          title="Saved Designs"
          items={designs.filter((d) => d.type === 'motion')}
          selectedId={selectedDesign?.id}
          onSelect={(id) => { const d = designs.find((x) => x.id === id); if (d) pickColor(editor.load(d)); }}
          onRename={onRenameDesign}
          onDelete={onDeleteDesign}
        />
      </div>

      {/* Center: Action buttons + Effect Config */}
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
          {selectedDesign ? (
            <button className="btn btn-primary btn-sm" onClick={editor.clear}>New</button>
          ) : (
            effect && <button className="btn btn-secondary btn-sm" onClick={editor.clear}>Clear</button>
          )}
          {hasChanges && selectedDesign && <button className="btn btn-primary btn-sm" onClick={editor.save}>Save</button>}
          {hasChanges && selectedDesign && <button className="btn btn-secondary btn-sm" onClick={onSaveAs}>Save As</button>}
          {!selectedDesign && effect && <button className="btn btn-primary btn-sm" onClick={onSaveAs}>Save</button>}
          {selectedDesign && hasChanges && <button className="btn btn-secondary btn-sm" onClick={editor.cancel}>Cancel</button>}
        </div>
        {!selectedDesign && (
          <div className="card">
            <div className="card-header"><h3 className="card-title">Effect Type</h3></div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              {effectTypes.map((fx) => (
                <button
                  key={fx.type}
                  className={`btn btn-sm ${effect?.type === fx.type ? 'btn-primary' : 'btn-secondary'}`}
                  aria-pressed={effect?.type === fx.type}
                  onClick={() => {
                    if (fx.type === 'ai' && !isAi) onOpenAiGenerator();
                    else pickColor(editor.selectEffect(fx));
                  }}
                  title={fx.description}
                >
                  {fx.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {effect && (
          <div className="card">
            <div className="card-header"><h3 className="card-title">{effect.name}</h3></div>
            {isAi && params.prompt && (
              <div style={{ marginBottom: '0.75rem', padding: '0.5rem 0.75rem', background: 'var(--bg-tertiary)', borderRadius: '4px', fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                <span style={{ fontStyle: 'italic', flex: 1 }}>{params.prompt as string}</span>
                <button
                  className="btn btn-secondary"
                  style={{ padding: '0.15rem 0.5rem', fontSize: '0.75rem', flexShrink: 0 }}
                  onClick={onOpenAiEditor}
                >
                  Edit
                </button>
              </div>
            )}
            <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {effect.defaultColors.length > 0 && (
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <span className="form-label" id="motion-colors-label">Colors (click to edit)</span>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }} role="group" aria-labelledby="motion-colors-label">
                    {colors.map((color, idx) => {
                      const selected = selectedColorIdx === idx;
                      const label = isAi ? (idx === 0 ? 'Base Color' : `Pattern Color ${idx}`) : `Color ${idx + 1}`;
                      return (
                        // Palette entries are positional, so the index is their identity
                        <div key={idx} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
                          <button
                            type="button"
                            style={{ width: '40px', height: '40px', padding: 0, borderRadius: '4px', backgroundColor: rgbwToCss(color), border: selected ? '3px solid var(--primary-color)' : '2px solid var(--border-color)', cursor: 'pointer', boxShadow: selected ? '0 0 0 2px rgba(37, 99, 235, 0.3)' : 'none' }}
                            onClick={() => { editor.setSelectedColorIdx(idx); setCurrentColor({ ...color }); }}
                            title={label}
                            aria-label={`Edit ${label}`}
                            aria-pressed={selected}
                          />
                          {isAi && <span style={{ fontSize: '0.6rem', color: 'var(--text-secondary)' }}>{idx === 0 ? 'Base' : 'Pattern'}</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="form-group" style={{ marginBottom: 0, minWidth: '120px' }}>
                <label className="form-label" htmlFor="motion-speed">Speed: {speed.toFixed(1)}x</label>
                <input id="motion-speed" type="range" className="form-input" min={0.1} max={2} step={0.1} value={speed} onChange={(e) => editor.setSpeed(parseFloat(e.target.value))} style={{ padding: 0 }} />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <span className="form-label">Scope</span>
                <div className="preview-mode-toggle" role="group" aria-label="Scope">
                  {SCOPES.map((s) => (
                    <button key={s.value} className={scope === s.value ? 'active' : ''} aria-pressed={scope === s.value} onClick={() => editor.setScope(s.value)}>{s.label}</button>
                  ))}
                </div>
              </div>
              {scope === 'wall' && walls.length > 0 && (() => {
                // params.wallIds limits Per Wall to some walls; empty/missing means all of them
                const chosen = Array.isArray(params.wallIds) ? (params.wallIds as string[]) : [];
                const isOn = (id: string) => chosen.length === 0 || chosen.includes(id);
                const toggle = (id: string) => {
                  const current = walls.filter((w) => isOn(w.id)).map((w) => w.id);
                  const next = isOn(id) ? current.filter((x) => x !== id) : [...current, id];
                  if (next.length === 0) return; // keep at least one wall lit
                  editor.setParam('wallIds', next.length === walls.length ? [] : next);
                };
                return (
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <span className="form-label">Walls</span>
                    <div className="preview-mode-toggle" role="group" aria-label="Walls">
                      {walls.map((w) => (
                        <button key={w.id} className={isOn(w.id) ? 'active' : ''} aria-pressed={isOn(w.id)} onClick={() => toggle(w.id)}>{w.name}</button>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
            {Object.entries(effect.params).length > 0 && (
              <div className="form-group">
                <span className="form-label">Parameters</span>
                <div className="form-row">
                  {Object.entries(effect.params).map(([key, param]) => {
                    const inputId = `motion-param-${key}`;
                    return (
                      <div key={key} className="form-group">
                        <label className="form-label" htmlFor={inputId}>{param.label || key}</label>
                        {param.type === 'number' ? (
                          <>
                            <input id={inputId} type="range" className="form-input" min={param.min} max={param.max} step={param.step || 1} value={params[key] as number} onChange={(e) => editor.setParam(key, parseFloat(e.target.value))} />
                            <span style={{ marginLeft: '0.5rem' }}>{params[key]?.toString()}</span>
                          </>
                        ) : param.type === 'string' ? (
                          <input id={inputId} type="text" className="form-input" style={{ maxWidth: '200px' }} value={(params[key] as string) || ''} onChange={(e) => editor.setParam(key, e.target.value)} />
                        ) : (
                          <>
                            <input id={inputId} type="checkbox" checked={params[key] as boolean} onChange={(e) => editor.setParam(key, e.target.checked)} />
                            <span style={{ marginLeft: '0.5rem' }}>{params[key]?.toString()}</span>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right Column: Color Picker */}
      <div className="color-picker-column">
        {effect && <ColorPicker color={currentColor} onChange={handleColorChange} hasRGBW={hasRGBW} />}
      </div>
    </div>
  );
}
