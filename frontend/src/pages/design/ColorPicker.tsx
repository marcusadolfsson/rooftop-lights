import { RgbColorPicker } from 'react-colorful';
import type { RGBW } from '../../types';
import { rgbwToCss } from '../../utils/color';

export type ColorTool = 'apply' | 'pickup';

interface ColorPickerProps {
  color: RGBW;
  // Called with the new color from either the picker or the channel inputs
  onChange: (color: RGBW) => void;
  hasRGBW: boolean;
  // Paint / pickup tool buttons (static mode only)
  tool?: ColorTool;
  onToolChange?: (tool: ColorTool) => void;
}

const CHANNEL_LABELS: Record<string, string> = { r: 'R', g: 'G', b: 'B', w: 'W' };
const CHANNEL_COLORS: Record<string, string> = { r: '#f87171', g: '#4ade80', b: '#60a5fa', w: '#e2e8f0' };

export default function ColorPicker({ color, onChange, hasRGBW, tool, onToolChange }: ColorPickerProps) {
  const channels = hasRGBW ? (['r', 'g', 'b', 'w'] as const) : (['r', 'g', 'b'] as const);

  return (
    <div className="color-window">
      <div className="color-window-titlebar">
        {tool && onToolChange && (
          <div className="color-toolbar-tools" style={{ flexDirection: 'row' }} role="group" aria-label="Color tool">
            <button
              className={`btn btn-sm color-toolbar-tool ${tool === 'apply' ? 'active' : ''}`}
              onClick={() => onToolChange('apply')}
              title="Paint (apply color)"
              aria-label="Paint (apply color)"
              aria-pressed={tool === 'apply'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 7h14a1 1 0 011 1v11a2 2 0 01-2 2H6a2 2 0 01-2-2V8a1 1 0 011-1z"/>
                <ellipse cx="12" cy="7" rx="8" ry="3"/>
                <path d="M19 10c1.5 1 2.5 2.5 2.5 4 0 1.5-1.5 2-2.5 1"/>
              </svg>
            </button>
            <button
              className={`btn btn-sm color-toolbar-tool ${tool === 'pickup' ? 'active' : ''}`}
              onClick={() => onToolChange('pickup')}
              title="Pickup (copy color)"
              aria-label="Pickup (copy color)"
              aria-pressed={tool === 'pickup'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <ellipse cx="12" cy="4" rx="3" ry="2.5"/>
                <path d="M10 6.5v2"/>
                <path d="M14 6.5v2"/>
                <path d="M10 8.5h4"/>
                <path d="M11 8.5l-1 10"/>
                <path d="M13 8.5l1 10"/>
                <path d="M10 18.5h4"/>
                <path d="M12 21l-1-2.5h2z"/>
              </svg>
            </button>
          </div>
        )}
        <div className="color-toolbar-swatch" style={{ backgroundColor: rgbwToCss(color) }} />
      </div>
      <div className="color-window-body">
        <div className="color-window-picker">
          <RgbColorPicker
            color={hasRGBW ? {
              r: Math.min(255, color.r + color.w),
              g: Math.min(255, color.g + color.w),
              b: Math.min(255, color.b + color.w),
            } : {
              r: color.r,
              g: color.g,
              b: color.b,
            }}
            onChange={(rgb) => {
              if (hasRGBW) {
                // Pull the common component into the white channel
                const w = Math.min(rgb.r, rgb.g, rgb.b);
                onChange({ r: rgb.r - w, g: rgb.g - w, b: rgb.b - w, w });
              } else {
                onChange({ r: rgb.r, g: rgb.g, b: rgb.b, w: 0 });
              }
            }}
          />
        </div>
        <div className="color-toolbar-values">
          {channels.map((ch) => (
            <div key={ch} className="color-toolbar-channel">
              <span style={{ color: CHANNEL_COLORS[ch], fontSize: '0.625rem', fontWeight: 600 }} aria-hidden="true">{CHANNEL_LABELS[ch]}</span>
              <input
                type="number"
                className="color-toolbar-input"
                aria-label={`${CHANNEL_LABELS[ch]} channel`}
                value={color[ch]}
                min={0}
                max={255}
                onChange={(e) => {
                  onChange({ ...color, [ch]: Math.max(0, Math.min(255, parseInt(e.target.value) || 0)) });
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
