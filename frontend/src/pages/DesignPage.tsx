import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { layoutAPI, designsAPI, playlistsAPI, aiAPI, foldersAPI, previewAPI } from '../utils/api';
import { usePreview, type PreviewRequest } from '../hooks/usePreview';
import LiveLightPreview from '../components/LiveLightPreview';
import StaticPanel from './design/StaticPanel';
import MotionPanel from './design/MotionPanel';
import PlaylistPanel from './design/PlaylistPanel';
import { AiPromptModal, NameModal } from './design/Modals';
import { useMotionEditor, usePlaylistEditor, useStaticEditor } from './design/editors';
import type { FolderControls } from './design/Folders';
import type { InlineEditContext } from './design/InlineDesignEditor';
import { canonicalFolder, folderNames, renameCollapsedFolder, sameFolder } from '../utils/folders';
import type { Design, EffectType, Playlist, PlaylistKind, RGBW, LayoutData } from '../types';

type TabType = 'static' | 'motion' | 'scenes' | 'playlist';

// How often the scene / playlist editor asks which item is playing
const PLAYBACK_POLL_MS = 500;
const PLAYBACK_START_GRACE_MS = 2000;

const TABS: { id: TabType; label: string }[] = [
  { id: 'static', label: 'Static' },
  { id: 'motion', label: 'Motion' },
  { id: 'scenes', label: 'Scenes' },
  { id: 'playlist', label: 'Playlist' },
];

function readShowDefective(): boolean {
  try { return localStorage.getItem('showDefective') === 'true'; } catch { return false; }
}

// "Account for defective lights" in the AI prompts; on unless turned off in this browser
const AI_DEFECTIVE_KEY = 'aiConsiderDefective';
function readAiConsiderDefective(): boolean {
  try { return localStorage.getItem(AI_DEFECTIVE_KEY) !== 'false'; } catch { return true; }
}

const SPARKLE_ICON = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>;

const SCENE_AI_EXAMPLES = [
  'Spooky Halloween intro',
  'Calm sunset, then stars',
  'Upbeat party: chases, then fireworks',
  'Christmas: candy cane, then twinkling snow',
];

// The scene the AI Scene Creator just made, until it is kept, undone, or another scene is opened
interface AiSceneOutcome {
  sceneId: string;
  name: string;
  designIds: string[];
  summary: string;
  warnings: string[];
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
  const [saveModal, setSaveModal] = useState<{ initialName: string; initialFolder: string | null } | null>(null);
  // Name prompt for a new scene / playlist
  const [playlistSaveModal, setPlaylistSaveModal] = useState<PlaylistKind | null>(null);
  const [pendingSaveName, setPendingSaveName] = useState(''); // prefilled from AI-generated names

  // AI Designer
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiDescription, setAiDescription] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [showAiEditPanel, setShowAiEditPanel] = useState(false);
  const [aiEditDescription, setAiEditDescription] = useState('');
  const [aiConsiderDefective, setAiConsiderDefectiveState] = useState(readAiConsiderDefective);
  const setAiConsiderDefective = (value: boolean) => {
    setAiConsiderDefectiveState(value);
    try { localStorage.setItem(AI_DEFECTIVE_KEY, String(value)); } catch { /* storage unavailable */ }
  };

  // AI Scene Creator
  const [showSceneAi, setShowSceneAi] = useState(false);
  const [sceneAiDescription, setSceneAiDescription] = useState('');
  const [sceneAiFolder, setSceneAiFolder] = useState(''); // '' = a folder named after the scene
  const [sceneAiLoading, setSceneAiLoading] = useState(false);
  const [sceneAiError, setSceneAiError] = useState<string | null>(null);
  const [sceneAiOutcome, setSceneAiOutcome] = useState<AiSceneOutcome | null>(null);
  // Bumped to remount the scene panel (closing any inline editor) when a generated scene opens
  const [scenePanelEpoch, setScenePanelEpoch] = useState(0);

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
  const sceneEditor = usePlaylistEditor({ reload: loadData, setError, designs, playlists, kind: 'scene' });
  const playlistEditor = usePlaylistEditor({ reload: loadData, setError, designs, playlists, kind: 'playlist' });
  const editorFor = (kind: PlaylistKind) => (kind === 'scene' ? sceneEditor : playlistEditor);

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

  // Save As starts in the open design's folder
  const openSaveAs = () => {
    const editor = activeTab === 'static' ? staticEditor : motionEditor;
    const current = designs.find((d) => d.id === editor.selectedDesign?.id);
    setSaveModal({ initialName: pendingSaveName, initialFolder: current?.folder ?? null });
  };

  const handleSaveAs = async (name: string, folder: string | null) => {
    const ok = activeTab === 'static'
      ? await staticEditor.saveAs(name, folder)
      : activeTab === 'motion' ? await motionEditor.saveAs(name, folder) : false;
    if (ok) {
      setSaveModal(null);
      setPendingSaveName('');
    }
  };

  // --- folders (labels shared by designs, scenes and playlists) ---

  const allFolders = useMemo(() => folderNames(designs, playlists), [designs, playlists]);

  const handleMoveDesign = async (designId: string, folder: string | null) => {
    try {
      await designsAPI.move(designId, folder);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to move design');
    }
  };

  const handleMovePlaylist = async (playlistId: string, folder: string | null) => {
    try {
      await playlistsAPI.move(playlistId, folder);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to move to folder');
    }
  };

  const folderControls: FolderControls = {
    names: allFolders,
    rename: async (from, to) => {
      const target = canonicalFolder(to, allFolders.filter((f) => !sameFolder(f, from)));
      const merging = allFolders.some((f) => !sameFolder(f, from) && sameFolder(f, to));
      if (merging && !confirm(`A folder named "${target}" already exists. Merge "${from}" into it?`)) return;
      try {
        const result = await foldersAPI.rename(from, to);
        renameCollapsedFolder(from, result.name);
        await loadData();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to rename folder');
      }
    },
    remove: async (name) => {
      const count = [...designs, ...playlists].filter((x) => x.folder && sameFolder(x.folder, name)).length;
      if (!confirm(`Delete the folder "${name}"? Its ${count} item${count === 1 ? '' : 's'} (in every tab) move to Unfiled; nothing is deleted.`)) return;
      try {
        await foldersAPI.delete(name);
        await loadData();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete folder');
      }
    },
  };

  // --- scene / playlist playback in the preview ---

  // What the scene / playlist editor is playing: the editor's current items from startIndex on.
  // playingIndex is the item playing now (from the preview status).
  // startedAt: until the play request has surely landed, a status without it isn't "stopped"
  const [playback, setPlayback] = useState<{ kind: PlaylistKind; startIndex: number; startedAt: number } | null>(null);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const listKind: PlaylistKind | null = activeTab === 'scenes' ? 'scene' : activeTab === 'playlist' ? 'playlist' : null;

  const playlistItemsRequest = (kind: PlaylistKind, startIndex: number): PreviewRequest | null => {
    const editor = editorFor(kind);
    if (editor.items.length === 0) return null;
    return {
      kind: 'playlistItems',
      items: editor.payloadItems(),
      playMode: kind === 'scene' ? 'sequence' : editor.mode,
      startIndex,
      playlistId: editor.selectedPlaylist?.id,
    };
  };

  // Soft preview (WebSocket only) unless Live Preview is on, then on the lights too
  const handlePlay = (kind: PlaylistKind, startIndex: number) => {
    const req = playlistItemsRequest(kind, startIndex);
    if (!req) return;
    preview.send(req);
    setPlayback({ kind, startIndex, startedAt: Date.now() });
    setPlayingIndex(startIndex);
  };

  const handleStopPlayback = () => {
    setPlayback(null);
    setPlayingIndex(null);
    if (preview.isLiveRef.current) preview.stop();
    else preview.clearSoft();
  };

  // Leaving the tab or the page ends the editor's playback (live preview keeps running)
  useEffect(() => {
    if (!playback) return;
    if (!isVisible || listKind !== playback.kind) {
      if (!preview.isLiveRef.current) preview.clearSoft();
      setPlayback(null);
      setPlayingIndex(null);
    }
  }, [isVisible, listKind, playback, preview]);

  // Follow which item is playing; stop showing playback once the preview is gone
  useEffect(() => {
    if (!playback) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await previewAPI.getStatus();
        if (cancelled) return;
        const info = status.previewInfo ?? (status.livePreviewInfo ? { ...status.livePreviewInfo, live: true } : null);
        if (!info || info.type !== 'playlist') {
          if (Date.now() - playback.startedAt < PLAYBACK_START_GRACE_MS) return;
          setPlayback(null);
          setPlayingIndex(null);
          return;
        }
        if (info.playlist) setPlayingIndex(info.playlist.itemIndex);
      } catch {
        /* transient; try again on the next tick */
      }
    };
    const interval = setInterval(poll, PLAYBACK_POLL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [playback]);

  // --- designs edited inline in the scene editor ---

  // Unsaved changes in the open inline editor (guards switching tabs)
  const inlineDirtyRef = useRef(false);
  // The scene item that was playing when the inline editor opened, to carry on from on close
  const inlineResumeRef = useRef<number | null>(null);
  const [inlineEnded, setInlineEnded] = useState<{ resume: number | null } | null>(null);

  // The preview shows the design being edited instead of the scene
  const handleInlineEditStart = () => {
    inlineResumeRef.current = playback?.kind === 'scene' ? (playingIndex ?? playback.startIndex) : null;
    setPlayback(null);
    setPlayingIndex(null);
  };
  // Runs after the render that applied the save (a copy swapped in, a new design added),
  // so the resumed playback has the scene's current items
  const handleInlineEditEnd = () => setInlineEnded({ resume: inlineResumeRef.current });
  useEffect(() => {
    if (!inlineEnded) return;
    setInlineEnded(null);
    inlineResumeRef.current = null;
    if (playback) return; // Play was pressed while editing
    const items = sceneEditor.items;
    // Back to the scene where it was playing; with Live Preview on the lights go back to the scene too
    if (listKind === 'scene' && items.length > 0 && (inlineEnded.resume !== null || preview.isLiveRef.current)) {
      handlePlay('scene', Math.min(inlineEnded.resume ?? 0, items.length - 1));
    } else if (!preview.isLiveRef.current) {
      preview.clearSoft();
    }
  }, [inlineEnded]);

  const confirmLeaveInline = () =>
    !inlineDirtyRef.current || confirm('Discard the unsaved changes to the design you are editing?');

  const inlineContext: InlineEditContext | undefined = layout ? {
    preview,
    reload: loadData,
    setError,
    active: isVisible,
    layout,
    effectTypes,
    hasRGBW,
    currentColor,
    setCurrentColor,
    folders: allFolders,
    dirtyRef: inlineDirtyRef,
    onEditStart: handleInlineEditStart,
    onEditEnd: handleInlineEditEnd,
  } : undefined;

  const handleSavePlaylist = async (kind: PlaylistKind, name?: string, folder: string | null = null) => {
    const result = await editorFor(kind).save(name, folder);
    if (result === 'needs-name') setPlaylistSaveModal(kind);
    if (result === 'saved') setPlaylistSaveModal(null);
  };

  // --- live preview ---

  const currentPreviewRequest = (): PreviewRequest | null => {
    if (activeTab === 'static') return { kind: 'static', colors: staticEditor.colors };
    if (activeTab === 'motion' && motionEditor.effect) {
      const { effect, colors, params, speed, scope } = motionEditor;
      return { kind: 'effect', effectType: effect.type, colors, params, speed, scope };
    }
    // Scenes / playlists: what the editor holds now (unsaved edits included), from where it's playing
    if (listKind) return playlistItemsRequest(listKind, playback?.kind === listKind ? playback.startIndex : 0);
    return null;
  };

  // Turning Live Preview on in the scene / playlist editor plays its contents; off stops them
  const handleToggleLive = async () => {
    const wasLive = preview.isLiveRef.current;
    const req = currentPreviewRequest();
    await preview.toggleLive(req);
    if (!listKind) return;
    if (wasLive) {
      setPlayback(null);
      setPlayingIndex(null);
    } else if (req && preview.isLiveRef.current) {
      const startIndex = req.kind === 'playlistItems' ? req.startIndex : 0;
      setPlayback({ kind: listKind, startIndex, startedAt: Date.now() });
      setPlayingIndex(startIndex);
    }
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
      const result = await aiAPI.generate({ description: aiDescription, mode: 'create', considerDefective: aiConsiderDefective });
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
      const result = await aiAPI.generate({ description: aiEditDescription, currentDesignData, mode: 'modify', considerDefective: aiConsiderDefective });

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

  // --- AI Scene Creator ---

  const openSceneAi = () => { setSceneAiError(null); setShowSceneAi(true); };

  const generateAIScene = async () => {
    const description = sceneAiDescription.trim();
    if (!description) return;
    // The new scene replaces what the scene editor holds
    if (sceneEditor.hasChanges && sceneEditor.items.length > 0 && !confirm('Discard the unsaved changes to the scene you are editing?')) return;
    if (!confirmLeaveInline()) return;
    setSceneAiLoading(true);
    setSceneAiError(null);
    try {
      const result = await playlistsAPI.aiGenerate({
        description,
        folder: sceneAiFolder || undefined,
        considerDefective: aiConsiderDefective,
      });
      inlineDirtyRef.current = false;
      if (playback?.kind === 'scene') handleStopPlayback();
      await loadData();
      setScenePanelEpoch((n) => n + 1);
      sceneEditor.load(result.scene);
      setActiveTab('scenes');
      setSceneAiOutcome({
        sceneId: result.scene.id,
        name: result.scene.name,
        designIds: result.designIds,
        summary: result.summary,
        warnings: result.warnings ?? [],
      });
      setSceneAiDescription('');
      setShowSceneAi(false);
      setError(null);
    } catch (err) {
      setSceneAiError(err instanceof Error ? err.message : 'Failed to generate scene');
    } finally {
      setSceneAiLoading(false);
    }
  };

  // The outcome banner belongs to the generated scene; opening another one dismisses it
  const shownSceneAiOutcome = sceneAiOutcome && activeTab === 'scenes' && sceneEditor.selectedPlaylist?.id === sceneAiOutcome.sceneId
    ? sceneAiOutcome : null;
  useEffect(() => {
    if (sceneAiOutcome && sceneEditor.selectedPlaylist?.id !== sceneAiOutcome.sceneId) setSceneAiOutcome(null);
  }, [sceneAiOutcome, sceneEditor.selectedPlaylist]);

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
            onClick={() => { if (tab.id === activeTab || confirmLeaveInline()) setActiveTab(tab.id); }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {aiEnabled && (activeTab === 'static' || activeTab === 'motion') && (
        <button className={`btn btn-sm ${showAiPanel ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setShowAiPanel(!showAiPanel)} style={{ width: '100%' }}>
          {SPARKLE_ICON}
          AI Designer
        </button>
      )}
      {aiEnabled && activeTab === 'scenes' && (
        <button className={`btn btn-sm ${showSceneAi ? 'btn-primary' : 'btn-secondary'}`} onClick={openSceneAi} style={{ width: '100%' }}>
          {SPARKLE_ICON}
          AI Scene Creator
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
            <div className="preview-strip-controls">
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
                  onClick={handleToggleLive}
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
            previewOnly
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
          considerDefective={aiConsiderDefective}
          onConsiderDefectiveChange={setAiConsiderDefective}
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
          considerDefective={aiConsiderDefective}
          onConsiderDefectiveChange={setAiConsiderDefective}
        />
      )}

      {showSceneAi && aiEnabled && (
        <AiPromptModal
          title="AI Scene Creator"
          intro={
            <p style={{ marginBottom: '1rem', color: 'var(--text-secondary)' }}>
              Describe a scene and AI will plan it: a sequence of designs (built-in effects, still looks, or your saved designs) with timing and transitions. New designs and the scene are saved together in a folder.
            </p>
          }
          label="Describe your scene"
          placeholder="e.g., 'A calm sunset fading to deep blue, then twinkling stars'"
          value={sceneAiDescription}
          onChange={setSceneAiDescription}
          loading={sceneAiLoading}
          error={sceneAiError}
          submitLabel="Create Scene"
          loadingLabel="Creating..."
          loadingNote="Planning the scene and its designs. This usually takes 20-60 seconds."
          onSubmit={generateAIScene}
          onClose={() => setShowSceneAi(false)}
          examples={SCENE_AI_EXAMPLES}
          considerDefective={aiConsiderDefective}
          onConsiderDefectiveChange={setAiConsiderDefective}
        >
          <div className="form-group">
            <label className="form-label" htmlFor="scene-ai-folder">Folder</label>
            <select id="scene-ai-folder" className="form-select" value={sceneAiFolder} onChange={(e) => setSceneAiFolder(e.target.value)} disabled={sceneAiLoading}>
              <option value="">New folder named after the scene</option>
              {allFolders.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        </AiPromptModal>
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
          onMoveDesign={handleMoveDesign}
          folders={folderControls}
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
          onMoveDesign={handleMoveDesign}
          folders={folderControls}
          onOpenAiGenerator={() => setShowAiPanel(true)}
          onOpenAiEditor={openAiEditor}
        />
      )}

      {shownSceneAiOutcome && (
        <div className="card ai-scene-result" role="status" aria-label="AI Scene Creator result">
          <div className="ai-scene-result-body">
            <div className="ai-scene-result-title">{SPARKLE_ICON} Created “{shownSceneAiOutcome.name}”</div>
            {shownSceneAiOutcome.summary && <p className="ai-scene-result-summary">{shownSceneAiOutcome.summary}</p>}
            {shownSceneAiOutcome.warnings.length > 0 && (
              <details className="ai-scene-result-warnings">
                <summary>{shownSceneAiOutcome.warnings.length} adjustment{shownSceneAiOutcome.warnings.length === 1 ? '' : 's'} to the AI's plan</summary>
                <ul>{shownSceneAiOutcome.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </details>
            )}
          </div>
          {/* The scene is already saved, so all that's left is to dismiss the note */}
          <button className="btn-icon ai-scene-result-close" onClick={() => setSceneAiOutcome(null)} title="Hide this message" aria-label="Hide this message">×</button>
        </div>
      )}

      {(activeTab === 'scenes' || activeTab === 'playlist') && (
        <PlaylistPanel
          // Separate instances so per-panel state (focus, collapsed list) doesn't carry over
          key={activeTab === 'scenes' ? `scenes-${scenePanelEpoch}` : activeTab}
          editor={activeTab === 'scenes' ? sceneEditor : playlistEditor}
          designs={designs}
          playlists={playlists}
          sidebarHeader={sidebarHeader}
          onSave={() => handleSavePlaylist(activeTab === 'scenes' ? 'scene' : 'playlist')}
          onMove={handleMovePlaylist}
          folders={folderControls}
          isPlaying={playback?.kind === listKind}
          playingIndex={playback?.kind === listKind ? playingIndex : null}
          onPlay={(startIndex) => handlePlay(activeTab === 'scenes' ? 'scene' : 'playlist', startIndex)}
          onStop={handleStopPlayback}
          inline={activeTab === 'scenes' ? inlineContext : undefined}
        />
      )}

      {saveModal && (
        <NameModal
          title="Save Design"
          label="Design Name"
          placeholder="Enter design name"
          initialName={saveModal.initialName}
          folders={allFolders}
          initialFolder={saveModal.initialFolder}
          onSave={handleSaveAs}
          onClose={() => setSaveModal(null)}
        />
      )}

      {playlistSaveModal && (
        <NameModal
          title={playlistSaveModal === 'scene' ? 'Save Scene' : 'Save Playlist'}
          label={playlistSaveModal === 'scene' ? 'Scene Name' : 'Playlist Name'}
          placeholder={`Enter ${playlistSaveModal} name`}
          folders={allFolders}
          onSave={(name, folder) => handleSavePlaylist(playlistSaveModal, name, folder)}
          onClose={() => setPlaylistSaveModal(null)}
        />
      )}
    </div>
  );
}

export default DesignPage;
