import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { layoutAPI, designsAPI, playlistsAPI, aiAPI } from '../utils/api';
import { usePreview, type PreviewRequest } from '../hooks/usePreview';
import LiveLightPreview from '../components/LiveLightPreview';
import StaticPanel from './design/StaticPanel';
import MotionPanel from './design/MotionPanel';
import PlaylistPanel from './design/PlaylistPanel';
import { AiPromptModal, NameModal } from './design/Modals';
import { useMotionEditor, usePlaylistEditor, useStaticEditor } from './design/editors';
import type { Design, EffectType, Playlist, RGBW, LayoutData } from '../types';

type TabType = 'static' | 'motion' | 'playlist';

const TABS: { id: TabType; label: string }[] = [
  { id: 'static', label: 'Static' },
  { id: 'motion', label: 'Motion' },
  { id: 'playlist', label: 'Playlist' },
];

function readShowDefective(): boolean {
  try { return localStorage.getItem('showDefective') === 'true'; } catch { return false; }
}

/**
 * AI static designs come back as an array indexed by light_id - 1, or (newer
 * backends) as a map keyed by light_id. Either way, keep only lights that exist.
 */
function aiColorsToMap(colors: RGBW[] | Record<number, RGBW> | undefined, lightIds: Set<number>): Record<number, RGBW> {
  const map: Record<number, RGBW> = {};
  if (!colors) return map;
  const entries: [number, RGBW][] = Array.isArray(colors)
    ? colors.map((c, idx) => [idx + 1, c])
    : Object.entries(colors).map(([k, c]) => [Number(k), c]);
  for (const [id, color] of entries) {
    if (color && (lightIds.size === 0 || lightIds.has(id))) map[id] = color;
  }
  return map;
}

function DesignPage() {
  const location = useLocation();
  const isVisible = location.pathname === '/';
  const [activeTab, setActiveTab] = useState<TabType>('static');
  const [layout, setLayout] = useState<LayoutData | null>(null);
  const [designs, setDesigns] = useState<Design[]>([]);
  const [effectTypes, setEffectTypes] = useState<EffectType[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Picker color, shared by the static and motion editors
  const [currentColor, setCurrentColor] = useState<RGBW>({ r: 255, g: 255, b: 255, w: 255 });

  const [previewMode, setPreviewMode] = useState<'2d' | '3d'>('2d');
  const [showDefective, setShowDefective] = useState(readShowDefective);
  const previewStripRef = useRef<HTMLDivElement>(null);

  // Modals
  const [saveModal, setSaveModal] = useState<{ initialName: string } | null>(null);
  const [showPlaylistSaveModal, setShowPlaylistSaveModal] = useState(false);
  const [pendingSaveName, setPendingSaveName] = useState(''); // prefilled from AI-generated names

  // AI Designer
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiDescription, setAiDescription] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [showAiEditPanel, setShowAiEditPanel] = useState(false);
  const [aiEditDescription, setAiEditDescription] = useState('');

  // Only the first load shows the loading screen; later refreshes keep the page
  // (and the 3D canvas) mounted and update in the background
  const loadData = useCallback(async () => {
    try {
      const [layoutData, designsData, effectsData, playlistsData, aiStatus] = await Promise.all([
        layoutAPI.getLayout(),
        designsAPI.getAll(),
        designsAPI.getEffectTypes(),
        playlistsAPI.getAll(),
        aiAPI.getStatus().catch(() => ({ enabled: false })),
      ]);
      setLayout(layoutData);
      setDesigns(designsData);
      setEffectTypes(effectsData);
      setPlaylists(playlistsData);
      setAiEnabled(aiStatus.enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  // Refresh data whenever the page becomes visible
  useEffect(() => {
    if (isVisible) loadData();
  }, [isVisible, loadData]);

  const preview = usePreview({ isVisible, onError: setError });

  const editorDeps = { preview, reload: loadData, setError };
  const staticEditor = useStaticEditor({ ...editorDeps, autoPreview: isVisible && activeTab === 'static' });
  const motionEditor = useMotionEditor({ ...editorDeps, autoPreview: isVisible && activeTab === 'motion', effectTypes });
  const playlistEditor = usePlaylistEditor({ reload: loadData, setError, designs, playlists });

  // Derive whether any light uses RGBW
  const hasRGBW = layout?.walls.some(w => w.lights?.some(l => l.light_type === 'RGBW') || w.matrix?.some(row => row?.some(l => l?.light_type === 'RGBW'))) ?? true;

  const lightIds = useMemo(() => {
    const ids = new Set<number>();
    for (const wall of layout?.walls ?? []) {
      for (const row of wall.matrix ?? []) {
        for (const light of row ?? []) if (light) ids.add(light.light_id);
      }
    }
    return ids;
  }, [layout]);

  // Track preview strip bottom for sticky color picker
  useEffect(() => {
    const el = previewStripRef.current;
    if (!el) return;
    const update = () => {
      document.documentElement.style.setProperty('--preview-strip-bottom', `${el.getBoundingClientRect().bottom}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener('scroll', update, { passive: true });
    return () => { observer.disconnect(); window.removeEventListener('scroll', update); };
  }, [layout, loading]);

  // --- design list actions shared by static & motion ---

  const handleDeleteDesign = async (designId: string) => {
    if (!confirm('Are you sure you want to delete this design?')) return;
    try {
      await designsAPI.delete(designId);
      if (staticEditor.selectedDesign?.id === designId) {
        staticEditor.reset();
        preview.stop();
      }
      if (motionEditor.selectedDesign?.id === designId) motionEditor.clear();
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete design');
    }
  };

  const handleRenameDesign = async (designId: string, name: string) => {
    try {
      const design = designs.find(d => d.id === designId);
      if (!design) return;
      if (!design.data) throw new Error(`can't rename a design whose data is corrupt (${design.dataError || 'unknown error'})`);
      await designsAPI.update(designId, { name, data: design.data });
      for (const editor of [staticEditor, motionEditor]) {
        if (editor.selectedDesign?.id === designId) editor.setSelectedDesign({ ...editor.selectedDesign, name });
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename design');
    }
  };

  const openSaveAs = () => setSaveModal({ initialName: pendingSaveName });

  const handleSaveAs = async (name: string) => {
    const ok = activeTab === 'static'
      ? await staticEditor.saveAs(name)
      : activeTab === 'motion' ? await motionEditor.saveAs(name) : false;
    if (ok) {
      setSaveModal(null);
      setPendingSaveName('');
    }
  };

  const handleSavePlaylist = async (name?: string) => {
    const result = await playlistEditor.save(name);
    if (result === 'needs-name') setShowPlaylistSaveModal(true);
    if (result === 'saved') setShowPlaylistSaveModal(false);
  };

  // --- live preview ---

  const currentPreviewRequest = (): PreviewRequest | null => {
    if (activeTab === 'static') return { kind: 'static', colors: staticEditor.colors };
    if (activeTab === 'motion' && motionEditor.effect) {
      const { effect, colors, params, speed, scope } = motionEditor;
      return { kind: 'effect', effectType: effect.type, colors, params, speed, scope };
    }
    if (activeTab === 'playlist' && playlistEditor.selectedPlaylist) {
      return { kind: 'playlist', playlistId: playlistEditor.selectedPlaylist.id };
    }
    return null;
  };

  const toggleShowDefective = () => {
    setShowDefective(d => {
      try { localStorage.setItem('showDefective', String(!d)); } catch { /* storage unavailable */ }
      return !d;
    });
  };

  // --- AI ---

  const openAiEditor = () => { setAiEditDescription(''); setAiError(null); setShowAiEditPanel(true); };

  const generateAIDesign = async () => {
    if (!aiDescription.trim()) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const result = await aiAPI.generate({ description: aiDescription, mode: 'create' });
      if (result.success && result.design) {
        const design = result.design;
        if (design.type === 'static') {
          setActiveTab('static');
          if (design.colors) {
            staticEditor.applyGenerated(aiColorsToMap(design.colors, lightIds), aiDescription, true);
          } else {
            staticEditor.setSelectedDesign(null);
          }
        } else {
          setActiveTab('motion');
          motionEditor.setSelectedDesign(null);
          motionEditor.applyGenerated({
            effect: design.effect,
            colors: Array.isArray(design.colors) ? design.colors : undefined,
            speed: design.speed,
            scope: design.scope,
            params: design.params as Record<string, number | boolean | string> | undefined,
          }, true);
        }
        // Prepopulate save name with AI-generated name
        setPendingSaveName(design.name || '');
        setAiDescription('');
        setShowAiPanel(false);
      } else {
        setAiError(result.error || 'Failed to generate design');
      }
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Failed to generate design');
    } finally {
      setAiLoading(false);
    }
  };

  // Sends the current design + edit instructions
  const editAIDesign = async () => {
    if (!aiEditDescription.trim()) return;
    const isStaticEdit = activeTab === 'static';
    if (!isStaticEdit && !motionEditor.effect) return;

    setAiLoading(true);
    setAiError(null);
    try {
      const currentDesignData = isStaticEdit
        ? { type: 'static', colors: staticEditor.colors }
        : {
            type: 'motion',
            effect: motionEditor.effect!.type,
            colors: motionEditor.colors,
            speed: motionEditor.speed,
            scope: motionEditor.scope,
            params: motionEditor.params,
          };
      const result = await aiAPI.generate({ description: aiEditDescription, currentDesignData, mode: 'modify' });

      if (result.success && result.design) {
        const design = result.design;
        if (design.type === 'static' && isStaticEdit) {
          if (design.colors) {
            const prompt = (staticEditor.prompt ? staticEditor.prompt + ' | Edit: ' : '') + aiEditDescription;
            staticEditor.applyGenerated(aiColorsToMap(design.colors, lightIds), prompt, false);
          }
        } else if (design.type === 'motion' && !isStaticEdit) {
          // Preserve the original prompt, append edit history
          const originalPrompt = (motionEditor.params.prompt as string) || '';
          const newParams = { ...((design.params as Record<string, number | boolean | string>) || {}) };
          newParams.prompt = originalPrompt + ' | Edit: ' + aiEditDescription;
          motionEditor.applyGenerated({
            effect: design.effect,
            colors: Array.isArray(design.colors) ? design.colors : undefined,
            speed: design.speed,
            scope: design.scope,
            params: newParams,
          }, false);
        }
        setAiEditDescription('');
        setShowAiEditPanel(false);
      } else {
        setAiError(result.error || 'Failed to edit design');
      }
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Failed to edit design');
    } finally {
      setAiLoading(false);
    }
  };

  if (loading) {
    return <div className="page-header"><h1>Loading...</h1></div>;
  }

  // One tab bar, shown at the top of whichever panel's sidebar is active
  const sidebarHeader = (
    <>
      <div className="tabs" style={{ marginBottom: 0 }} role="tablist" aria-label="Design type">
        {TABS.map(tab => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {aiEnabled && activeTab !== 'playlist' && (
        <button className={`btn btn-sm ${showAiPanel ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setShowAiPanel(!showAiPanel)} style={{ width: '100%' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>
          AI Designer
        </button>
      )}
    </>
  );

  return (
    <div>
      {/* Preview Strip */}
      {layout && (
        <div className="preview-strip" ref={previewStripRef}>
          <div className="preview-strip-header">
            <div className="preview-strip-title">Preview</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div className="preview-mode-toggle" role="group" aria-label="Preview mode">
                <button className={previewMode === '2d' ? 'active' : ''} aria-pressed={previewMode === '2d'} onClick={() => setPreviewMode('2d')}>
                  2D
                </button>
                <button className={previewMode === '3d' ? 'active' : ''} aria-pressed={previewMode === '3d'} onClick={() => setPreviewMode('3d')}>
                  3D
                </button>
              </div>
              <div className="live-preview-toggle">
                <span id="toggle-show-defective">Show Defective</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={showDefective}
                  aria-labelledby="toggle-show-defective"
                  className={`toggle-switch ${showDefective ? 'active' : ''}`}
                  onClick={toggleShowDefective}
                />
              </div>
              <div className="live-preview-toggle">
                <span id="toggle-live-preview">Live Preview</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={preview.isLive}
                  aria-labelledby="toggle-live-preview"
                  className={`toggle-switch ${preview.isLive ? 'active' : ''}`}
                  onClick={() => preview.toggleLive(currentPreviewRequest())}
                />
              </div>
            </div>
          </div>
          <LiveLightPreview
            walls={layout.walls}
            mode={previewMode}
            active={isVisible}
            fallbackColors={staticEditor.colors}
            showDefective={showDefective}
          />
        </div>
      )}

      {/* Static AI prompt display */}
      {activeTab === 'static' && staticEditor.prompt && (
        <div style={{ marginBottom: '0.75rem', padding: '0.5rem 0.75rem', background: 'var(--bg-tertiary)', borderRadius: '4px', fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
          <span style={{ fontStyle: 'italic', flex: 1 }}>{staticEditor.prompt}</span>
          {aiEnabled && (
            <button
              className="btn btn-secondary"
              style={{ padding: '0.15rem 0.5rem', fontSize: '0.75rem', flexShrink: 0 }}
              onClick={openAiEditor}
            >
              Edit
            </button>
          )}
        </div>
      )}

      {showAiPanel && aiEnabled && (
        <AiPromptModal
          title="AI Design Generator"
          intro={
            <p style={{ marginBottom: '1rem', color: 'var(--text-secondary)' }}>
              Describe the light show you want and AI will generate it for you.
            </p>
          }
          label="Describe your design"
          placeholder={activeTab === 'static'
            ? "e.g., 'A warm sunset gradient from orange on the west to purple on the east'"
            : "e.g., 'Christmas candy cane stripes in red and green moving slowly'"}
          value={aiDescription}
          onChange={setAiDescription}
          loading={aiLoading}
          error={aiError}
          submitLabel="Generate"
          loadingLabel="Generating..."
          onSubmit={generateAIDesign}
          onClose={() => setShowAiPanel(false)}
        />
      )}

      {showAiEditPanel && aiEnabled && (
        <AiPromptModal
          title="Edit AI Design"
          intro={
            <div style={{ marginBottom: '1rem', padding: '0.5rem 0.75rem', background: 'var(--bg-tertiary)', borderRadius: '4px', fontSize: '0.8rem' }}>
              <div style={{ color: 'var(--text-secondary)', marginBottom: '0.25rem', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Current prompt</div>
              <div style={{ color: 'var(--text-primary)', fontStyle: 'italic' }}>{activeTab === 'static' ? staticEditor.prompt : (motionEditor.params.prompt as string)}</div>
            </div>
          }
          label="What would you like to change?"
          placeholder="e.g., 'Make it faster', 'Add a sparkle effect on top', 'Change the direction to right-to-left'"
          value={aiEditDescription}
          onChange={setAiEditDescription}
          loading={aiLoading}
          error={aiError}
          submitLabel="Apply Changes"
          loadingLabel="Applying..."
          onSubmit={editAIDesign}
          onClose={() => setShowAiEditPanel(false)}
        />
      )}

      {error && (
        <div className="card" style={{ backgroundColor: 'var(--error)', marginBottom: '1rem' }} role="alert">
          {error}
          <button className="btn btn-sm" onClick={() => setError(null)} style={{ marginLeft: '1rem' }}>
            Dismiss
          </button>
        </div>
      )}

      {layout && activeTab === 'static' && (
        <StaticPanel
          editor={staticEditor}
          layout={layout}
          designs={designs}
          sidebarHeader={sidebarHeader}
          currentColor={currentColor}
          setCurrentColor={setCurrentColor}
          hasRGBW={hasRGBW}
          onSaveAs={openSaveAs}
          onRenameDesign={handleRenameDesign}
          onDeleteDesign={handleDeleteDesign}
        />
      )}

      {activeTab === 'motion' && (
        <MotionPanel
          editor={motionEditor}
          designs={designs}
          effectTypes={effectTypes}
          walls={layout?.walls ?? []}
          sidebarHeader={sidebarHeader}
          currentColor={currentColor}
          setCurrentColor={setCurrentColor}
          hasRGBW={hasRGBW}
          onSaveAs={openSaveAs}
          onRenameDesign={handleRenameDesign}
          onDeleteDesign={handleDeleteDesign}
          onOpenAiGenerator={() => setShowAiPanel(true)}
          onOpenAiEditor={openAiEditor}
        />
      )}

      {activeTab === 'playlist' && (
        <PlaylistPanel
          editor={playlistEditor}
          designs={designs}
          playlists={playlists}
          sidebarHeader={sidebarHeader}
          onSave={() => handleSavePlaylist()}
        />
      )}

      {saveModal && (
        <NameModal
          title="Save Design"
          label="Design Name"
          placeholder="Enter design name"
          initialName={saveModal.initialName}
          onSave={handleSaveAs}
          onClose={() => setSaveModal(null)}
        />
      )}

      {showPlaylistSaveModal && (
        <NameModal
          title="Save Playlist"
          label="Playlist Name"
          placeholder="Enter playlist name"
          onSave={(name) => handleSavePlaylist(name)}
          onClose={() => setShowPlaylistSaveModal(false)}
        />
      )}
    </div>
  );
}

export default DesignPage;
