import type { CSSProperties, ReactNode } from 'react';
import type { Design, EffectType, RGBW, Wall } from '../../types';
import { rgbwToCss } from '../../utils/color';
import { useIsMobile } from '../../hooks/useMediaQuery';
import ColorPicker from './ColorPicker';
import SavedList from './SavedList';
import type { FolderControls } from './Folders';
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
  onMoveDesign: (id: string, folder: string | null) => Promise<void>;
  folders: FolderControls;
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
  onSaveAs, onRenameDesign, onDeleteDesign, onMoveDesign, folders, onOpenAiGenerator, onOpenAiEditor,
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
          scope="motion"
          folders={folders}
          onMove={onMoveDesign}
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
              {effect.realTime ? (
                <div className="form-group" style={{ marginBottom: 0, minWidth: '160px' }}>
                  <span className="form-label">Speed</span>
                  <p className="fx-speed-note">Timing is set in seconds below; Speed doesn't apply.</p>
                </div>
              ) : (
                <div className="form-group" style={{ marginBottom: 0, minWidth: '160px' }}>
                  <div className="fx-param-head">
                    <label className="form-label" htmlFor="motion-speed" style={{ marginBottom: 0 }}>Speed</label>
                    <span className="fx-value">{clamp(speed, SPEED_MIN, SPEED_MAX).toFixed(1)}×</span>
                  </div>
                  <Slider id="motion-speed" min={SPEED_MIN} max={SPEED_MAX} step={0.1} value={speed} onChange={editor.setSpeed} />
                  <SpeedNote stepFrames={effect.stepFrames} blended={params.smooth === true} speed={clamp(speed, SPEED_MIN, SPEED_MAX)} />
                </div>
              )}
              <div className="form-group" style={{ marginBottom: 0 }}>
                <span className="form-label">Scope</span>
                <div className="preview-mode-toggle" role="group" aria-label="Scope" style={{ width: 'fit-content' }}>
                  {SCOPES.map((s) => (
                    <button key={s.value} className={scope === s.value ? 'active' : ''} aria-pressed={scope === s.value} onClick={() => editor.setScope(s.value)}>{s.label}</button>
                  ))}
                </div>
                {(scope === 'wall' || (scope === 'group' && 'syncWalls' in effect.params)) && walls.length > 0 && (
                  <div className="fx-checklist" role="group" aria-label={scope === 'wall' ? 'Walls' : 'Group options'}>
                    {scope === 'wall' && (
                      <WallChecklist walls={walls} wallIds={params.wallIds} onChange={(ids) => editor.setParam('wallIds', ids)} />
                    )}
                    {'syncWalls' in effect.params && (
                      // Lives with the wall choice: it only matters when walls run separately
                      <label className="fx-sync">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={params.syncWalls === true}
                          className={`toggle-switch toggle-switch-sm ${params.syncWalls === true ? 'active' : ''}`}
                          onClick={() => editor.setParam('syncWalls', params.syncWalls !== true)}
                        />
                        Sync walls
                        <span className="fx-sync-hint">short walls keep pace with the longest</span>
                      </label>
                    )}
                  </div>
                )}
              </div>
            </div>
            {Object.entries(effect.params).length > 0 && (
              <div className="form-group" style={{ marginTop: '1.25rem' }}>
                <span className="form-label">Parameters</span>
                <div className="fx-params">
                  {Object.entries(effect.params).filter(([key]) => key !== 'syncWalls').map(([key, param]) => {
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
                    const min = param.min ?? 0;
                    const max = param.max ?? 100;
                    if (param.type === 'range') {
                      // Older designs may hold a single number: treat it as a fixed value (lo = hi)
                      const raw = params[key] ?? param.default;
                      const pair = Array.isArray(raw) ? raw.map(Number) : [Number(raw), Number(raw)];
                      const lo = clamp(Math.min(pair[0], pair[1]), min, max);
                      const hi = clamp(Math.max(pair[0], pair[1]), min, max);
                      return (
                        <div key={key} className="fx-param">
                          <div className="fx-param-head">
                            <span className="fx-param-label" id={`${inputId}-label`}>{label}</span>
                            <span className="fx-value">{lo === hi ? formatNumber(lo) : `${formatNumber(lo)}–${formatNumber(hi)}`}{param.unit || ''}</span>
                          </div>
                          <RangeSlider id={inputId} labelId={`${inputId}-label`} min={min} max={max} step={param.step || 1} lo={lo} hi={hi} onChange={(a, b) => editor.setParam(key, [a, b])} />
                        </div>
                      );
                    }
                    // Shown clamped to the slider's range so the value matches the thumb
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

// Lights can only jump a whole light at a time, so a stepped effect looks like a smooth glide only
// when it steps often enough. Around 10 steps per second reads as motion rather than single jumps.
const RENDER_FPS = 30;
const SMOOTH_STEPS_PER_SECOND = 10;
function SpeedNote({ stepFrames, blended, speed }: { stepFrames?: number; blended: boolean; speed: number }) {
  if (!stepFrames) return <p className="fx-speed-note">Smooth at any speed</p>;
  if (blended) {
    return <p className="fx-speed-note">{formatNumber(Math.round(((RENDER_FPS * speed) / stepFrames) * 10) / 10)} lights/s · smooth at any speed (blending on)</p>;
  }
  const stepsPerSecond = (RENDER_FPS * speed) / stepFrames;
  const minSmooth = (SMOOTH_STEPS_PER_SECOND * stepFrames) / RENDER_FPS;
  const smooth = speed >= minSmooth - 1e-9;
  return (
    <p className={`fx-speed-note${smooth ? '' : ' fx-speed-note-warn'}`}>
      {formatNumber(Math.round(stepsPerSecond * 10) / 10)} lights/s · smooth from {formatNumber(Math.round(minSmooth * 10) / 10)}×
      {minSmooth > SPEED_MAX && ' (above max)'}
    </p>
  );
}

// Two-thumb slider for a random min-max range; dragging one thumb past the other pushes it along
function RangeSlider({ id, labelId, min, max, step, lo, hi, onChange }: {
  id: string; labelId: string; min: number; max: number; step: number; lo: number; hi: number;
  onChange: (lo: number, hi: number) => void;
}) {
  const pct = (v: number) => (max > min ? ((v - min) / (max - min)) * 100 : 0);
  return (
    <div className="fx-range" style={{ '--lo': `${pct(lo)}%`, '--hi': `${pct(hi)}%` } as CSSProperties}>
      <input
        id={`${id}-min`}
        type="range"
        className="fx-range-input"
        aria-labelledby={labelId}
        aria-label="Minimum"
        min={min}
        max={max}
        step={step}
        value={lo}
        onChange={(e) => { const v = parseFloat(e.target.value); onChange(v, Math.max(v, hi)); }}
      />
      <input
        id={`${id}-max`}
        type="range"
        className="fx-range-input"
        aria-labelledby={labelId}
        aria-label="Maximum"
        min={min}
        max={max}
        step={step}
        value={hi}
        onChange={(e) => { const v = parseFloat(e.target.value); onChange(Math.min(lo, v), v); }}
      />
    </div>
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
    <div className="fx-checklist-walls">
      {walls.map((w) => (
        <button key={w.id} type="button" role="checkbox" aria-checked={isOn(w.id)} className={`fx-check ${isOn(w.id) ? 'checked' : ''}`} onClick={() => toggle(w.id)}>
          <span className="fx-check-box" aria-hidden="true" />
          {w.name}
        </button>
      ))}
    </div>
  );
}
