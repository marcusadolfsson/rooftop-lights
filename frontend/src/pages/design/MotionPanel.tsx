import type { CSSProperties, ReactNode } from 'react';
import type { Design, EffectType, RGBW, Wall } from '../../types';
import { rgbwToCss } from '../../utils/color';
import { useIsMobile } from '../../hooks/useMediaQuery';
import ColorPicker from './ColorPicker';
import SavedList from './SavedList';
import { isPaletteEffect, MAX_PALETTE_COLORS, MIN_PALETTE_COLORS, type MotionEditor } from './editors';

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

const SPEED_MIN = 0.1;
const SPEED_MAX = 2;

export default function MotionPanel({
  editor, designs, effectTypes, walls, sidebarHeader, currentColor, setCurrentColor, hasRGBW,
  onSaveAs, onRenameDesign, onDeleteDesign, onOpenAiGenerator, onOpenAiEditor,
}: MotionPanelProps) {
  const { selectedDesign, effect, colors, speed, scope, params, selectedColorIdx, hasChanges } = editor;
  const isAi = effect?.type === 'ai';
  const isMobile = useIsMobile();
  const hasColors = !!effect && effect.defaultColors.length > 0;
  const isPalette = !!effect && isPaletteEffect(effect);

  const pickColor = (first: RGBW | undefined) => { if (first) setCurrentColor({ ...first }); };

  // Picker changes recolor the selected palette entry
  const handleColorChange = (color: RGBW) => {
    setCurrentColor(color);
    editor.setColorAt(selectedColorIdx, color);
  };

  return (
    <div className="design-layout">
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
      <div className="design-main">
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
          {selectedDesign ? (
            <button className="btn btn-primary btn-sm" onClick={editor.clear}>New</button>
          ) : (
            effect && <button className="btn btn-secondary btn-sm" onClick={editor.clear}>Clear</button>
          )}
          {hasChanges && selectedDesign && <button className="btn btn-primary btn-sm" onClick={editor.save}>Save</button>}
          {hasChanges && selectedDesign && <button className="btn btn-secondary btn-sm" onClick={onSaveAs}>Save As</button>}
          {!selectedDesign && effect && <button className="btn btn-primary btn-sm" onClick={onSaveAs}>Save</button>}
          {selectedDesign && hasChanges && <button className="btn btn-secondary btn-sm" onClick={() => pickColor(editor.cancel())}>Cancel</button>}
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
            <div className="fx-settings">
              {hasColors && (
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <span className="form-label" id="motion-colors-label">Colors (click to edit)</span>
                  {effect.colorHint && <p className="fx-color-hint">{effect.colorHint}</p>}
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }} role="group" aria-labelledby="motion-colors-label">
                    {colors.map((color, idx) => {
                      const selected = selectedColorIdx === idx;
                      const named = effect.colorLabels?.[Math.min(idx, effect.colorLabels.length - 1)];
                      // AI palettes repeat "Pattern" for every extra color; palettes without names are numbered
                      const short = named ?? `${idx + 1}`;
                      const label = named ? `${named} color` : `Color ${idx + 1}`;
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
                          <span className="fx-color-label">{short}</span>
                        </div>
                      );
                    })}
                    {isPalette && (
                      <div className="fx-palette-actions">
                        <button
                          type="button"
                          className="btn btn-secondary fx-palette-btn"
                          onClick={() => pickColor(editor.addColor())}
                          disabled={colors.length >= MAX_PALETTE_COLORS}
                          title="Add a color"
                          aria-label="Add a color"
                        >+</button>
                        <button
                          type="button"
                          className="btn btn-secondary fx-palette-btn"
                          onClick={() => pickColor(editor.removeColor())}
                          disabled={colors.length <= MIN_PALETTE_COLORS}
                          title={`Remove color ${selectedColorIdx + 1}`}
                          aria-label={`Remove color ${selectedColorIdx + 1}`}
                        >−</button>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {/* Phones get the picker right under the swatches it edits */}
              {isMobile && hasColors && (
                <ColorPicker color={currentColor} onChange={handleColorChange} hasRGBW={hasRGBW} />
              )}
              <div className="form-group" style={{ marginBottom: 0, minWidth: '160px' }}>
                <div className="fx-param-head">
                  <label className="form-label" htmlFor="motion-speed" style={{ marginBottom: 0 }}>Speed</label>
                  <span className="fx-value">{clamp(speed, SPEED_MIN, SPEED_MAX).toFixed(1)}×</span>
                </div>
                <Slider id="motion-speed" min={SPEED_MIN} max={SPEED_MAX} step={0.1} value={speed} onChange={editor.setSpeed} />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <span className="form-label">Scope</span>
                <div className="preview-mode-toggle" role="group" aria-label="Scope" style={{ width: 'fit-content' }}>
                  {SCOPES.map((s) => (
                    <button key={s.value} className={scope === s.value ? 'active' : ''} aria-pressed={scope === s.value} onClick={() => editor.setScope(s.value)}>{s.label}</button>
                  ))}
                </div>
                {scope === 'wall' && walls.length > 0 && (
                  <WallChecklist walls={walls} wallIds={params.wallIds} onChange={(ids) => editor.setParam('wallIds', ids)} />
                )}
              </div>
            </div>
            {Object.entries(effect.params).length > 0 && (
              <div className="form-group" style={{ marginTop: '1.25rem' }}>
                <span className="form-label">Parameters</span>
                <div className="fx-params">
                  {Object.entries(effect.params).map(([key, param]) => {
                    const inputId = `motion-param-${key}`;
                    const label = param.label || humanize(key);
                    if (param.type === 'boolean') {
                      const on = !!params[key];
                      return (
                        <div key={key} className="fx-param fx-param-row">
                          <span className="fx-param-label" id={`${inputId}-label`}>{label}</span>
                          <button
                            type="button"
                            id={inputId}
                            role="switch"
                            aria-checked={on}
                            aria-labelledby={`${inputId}-label`}
                            className={`toggle-switch toggle-switch-sm ${on ? 'active' : ''}`}
                            onClick={() => editor.setParam(key, !on)}
                          />
                        </div>
                      );
                    }
                    if (param.type === 'string') {
                      return (
                        <div key={key} className="fx-param">
                          <label className="fx-param-label" htmlFor={inputId}>{label}</label>
                          <input id={inputId} type="text" className="form-input" value={(params[key] as string) || ''} onChange={(e) => editor.setParam(key, e.target.value)} />
                        </div>
                      );
                    }
                    // Shown clamped to the slider's range so the value matches the thumb
                    const min = param.min ?? 0;
                    const max = param.max ?? 100;
                    const value = clamp(Number(params[key] ?? param.default), min, max);
                    return (
                      <div key={key} className="fx-param">
                        <div className="fx-param-head">
                          <label className="fx-param-label" htmlFor={inputId}>{label}</label>
                          <span className="fx-value">{formatNumber(value)}{param.unit || ''}</span>
                        </div>
                        <Slider id={inputId} min={min} max={max} step={param.step || 1} value={value} onChange={(v) => editor.setParam(key, v)} />
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
        {hasColors && !isMobile && <ColorPicker color={currentColor} onChange={handleColorChange} hasRGBW={hasRGBW} />}
      </div>
    </div>
  );
}

// "tailLength" -> "Tail length", "width1" -> "Width 1"
function humanize(key: string): string {
  const words = key.replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function clamp(v: number, min: number, max: number): number {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;
}

function formatNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

// Range input whose filled part tracks the value (styled in index.css as .fx-slider)
function Slider({ id, min, max, step, value, onChange }: { id: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      id={id}
      type="range"
      className="fx-slider"
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ '--fill': `${Math.max(0, Math.min(100, pct))}%` } as CSSProperties}
      onChange={(e) => onChange(parseFloat(e.target.value))}
    />
  );
}

// Per Wall wall selection; an empty list means every wall
function WallChecklist({ walls, wallIds, onChange }: { walls: Wall[]; wallIds: unknown; onChange: (ids: string[]) => void }) {
  // Ids of deleted walls are ignored, so they can't leave every box unchecked
  const chosen = Array.isArray(wallIds) ? (wallIds as string[]).filter((id) => walls.some((w) => w.id === id)) : [];
  const isOn = (id: string) => chosen.length === 0 || chosen.includes(id);
  const toggle = (id: string) => {
    const current = walls.filter((w) => isOn(w.id)).map((w) => w.id);
    const next = isOn(id) ? current.filter((x) => x !== id) : [...current, id];
    if (next.length === 0) return; // keep at least one wall lit
    onChange(next.length === walls.length ? [] : next);
  };
  return (
    <div className="fx-checklist" role="group" aria-label="Walls">
      {walls.map((w) => (
        <button key={w.id} type="button" role="checkbox" aria-checked={isOn(w.id)} className={`fx-check ${isOn(w.id) ? 'checked' : ''}`} onClick={() => toggle(w.id)}>
          <span className="fx-check-box" aria-hidden="true" />
          {w.name}
        </button>
      ))}
    </div>
  );
}
