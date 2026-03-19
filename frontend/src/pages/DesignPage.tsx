import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react';
import { useLocation } from 'react-router-dom';
import { RgbColorPicker } from 'react-colorful';
import { layoutAPI, designsAPI, playlistsAPI, previewAPI, aiAPI } from '../utils/api';
import { useWebSocket } from '../hooks/useWebSocket';
const Preview3D = lazy(() => import('../components/Preview3D'));
import type {
  Design,
  EffectType,
  Playlist,
  RGBW,
  Wall,
  LayoutData,
  StaticDesignData,
  MotionDesignData,
} from '../types';

type TabType = 'static' | 'motion' | 'playlist';

function DesignPage() {
  const { frameData } = useWebSocket();
  const location = useLocation();
  const isVisible = location.pathname === '/';
  const [activeTab, setActiveTab] = useState<TabType>('static');
  const [layout, setLayout] = useState<LayoutData | null>(null);
  const [designs, setDesigns] = useState<Design[]>([]);
  const [effectTypes, setEffectTypes] = useState<EffectType[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Static mode state
  const [selectedDesign, setSelectedDesign] = useState<Design | null>(null);
  const [currentColors, setCurrentColors] = useState<Record<number, RGBW>>({});
  const [currentColor, setCurrentColor] = useState<RGBW>({ r: 255, g: 255, b: 255, w: 255 });
  const [colorTool, setColorTool] = useState<'apply' | 'pickup'>('apply');
  const [isDragging, setIsDragging] = useState(false);
  const [isEditingStatic, setIsEditingStatic] = useState(true);
  const [staticPrompt, setStaticPrompt] = useState<string>('');
  const savedColorsRef = useRef<string>('{}');
  const [selectedLights, setSelectedLights] = useState<Set<number>>(new Set());
  const previewStripRef = useRef<HTMLDivElement>(null);

  // Motion mode state
  const [selectedEffect, setSelectedEffect] = useState<EffectType | null>(null);
  const [motionColors, setMotionColors] = useState<RGBW[]>([]);
  const [motionSpeed, setMotionSpeed] = useState<number>(1);
  const [motionParams, setMotionParams] = useState<Record<string, number | boolean | string>>({});
  const [selectedMotionColorIdx, setSelectedMotionColorIdx] = useState<number>(0);
  const [motionScope, setMotionScope] = useState<'all' | 'wall' | 'group'>('all');
  const savedMotionRef = useRef<string>('{}');

  // Playlist mode state
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [playlistName, setPlaylistName] = useState('');
  const [playlistMode, setPlaylistMode] = useState<'sequence' | 'random'>('sequence');
  const [editingPlaylistItems, setEditingPlaylistItems] = useState<Array<{ design_id: string; design_name?: string; design_type?: string; duration: number; transition: string }>>([]);
  const [editingPlaylistMode, setEditingPlaylistMode] = useState<'sequence' | 'random'>('sequence');
  const [renamingPlaylistId, setRenamingPlaylistId] = useState<string | null>(null);
  const [renamePlaylistValue, setRenamePlaylistValue] = useState('');
  const [dragPlaylistIdx, setDragPlaylistIdx] = useState<number | null>(null);

  // Preview state
  const [isLivePreview, setIsLivePreview] = useState(false);
  const isLivePreviewRef = useRef(false);
  const [previewMode, setPreviewMode] = useState<'2d' | '3d'>('2d');
  const [showDefective, setShowDefective] = useState(() => localStorage.getItem('showDefective') === 'true');

  // Keep ref in sync
  useEffect(() => { isLivePreviewRef.current = isLivePreview; }, [isLivePreview]);

  // Modal state
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveAsName, setSaveAsName] = useState('');
  const [showPlaylistSaveModal, setShowPlaylistSaveModal] = useState(false);
  const [playlistSaveName, setPlaylistSaveName] = useState('');

  // Rename state
  const [renamingDesignId, setRenamingDesignId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // AI Designer state
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiDescription, setAiDescription] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [aiBaseDesignId, setAiBaseDesignId] = useState<string>('');
  const [aiMode, setAiMode] = useState<'create' | 'modify' | 'derivative'>('create');
  const [showAiEditPanel, setShowAiEditPanel] = useState(false);
  const [aiEditDescription, setAiEditDescription] = useState('');

  // Sync live preview status from backend on mount
  useEffect(() => {
    previewAPI.getStatus().then(status => {
      setIsLivePreview(status.isLivePreview);
    }).catch(() => {});
  }, []);

  // Handle page visibility changes
  useEffect(() => {
    if (isVisible) {
      // Refresh data when page becomes visible
      loadData();
    } else {
      // Navigating away — clear WS-only preview so schedule shows through
      // (live preview continues unaffected on ArtNet + WS)
      previewAPI.clearSoft().catch(() => {});
    }
  }, [isVisible]);

  const loadData = async () => {
    try {
      setLoading(true);
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
  };

  // Derive dirty state
  const hasChanges = JSON.stringify(currentColors) !== savedColorsRef.current;
  const motionSnapshot = JSON.stringify({ effect: selectedEffect?.type, colors: motionColors, speed: motionSpeed, params: motionParams, scope: motionScope });
  const hasMotionChanges = motionSnapshot !== savedMotionRef.current;

  // Derive whether any light uses RGBW
  const hasRGBW = layout?.walls.some(w => w.lights?.some(l => l.light_type === 'RGBW') || w.matrix?.some(row => row?.some(l => l?.light_type === 'RGBW'))) ?? true;

  // Set of light IDs that have defective channels
  const defectiveLightIds = useMemo(() => {
    const ids = new Set<number>();
    if (!layout) return ids;
    for (const wall of layout.walls) {
      if (!wall.matrix) continue;
      for (const row of wall.matrix) {
        for (const light of row) {
          if (light?.defective_channels) ids.add(light.light_id);
        }
      }
    }
    return ids;
  }, [layout]);

  // Static mode functions
  const loadDesign = async (design: Design) => {
    setSelectedDesign(design);
    if (design.type === 'static') {
      setIsEditingStatic(true);
      const data = design.data as StaticDesignData;
      const colors = data.colors || {};
      setCurrentColors(colors);
      setStaticPrompt(data.prompt || '');
      savedColorsRef.current = JSON.stringify(colors);
      // Start soft preview (WebSocket only, no ArtNet)
      try {
        await previewAPI.start({ designType: 'static', designData: { colors }, live: false });
      } catch {
        // Preview failed silently
      }
    }
  };

  const pickupColor = (lightId: number) => {
    const color = currentColors[lightId];
    if (color) {
      setCurrentColor({ ...color });
    }
  };

  const applyColor = (lightId: number) => {
    setCurrentColors((prev) => ({
      ...prev,
      [lightId]: { ...currentColor },
    }));
  };

  const handleLightClick = (lightId: number) => {
    if (colorTool === 'pickup') {
      pickupColor(lightId);
    } else {
      applyColor(lightId);
      setSelectedLights(prev => {
        const next = new Set(prev);
        next.add(lightId);
        return next;
      });
    }
  };

  const handleLightMouseDown = (lightId: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (colorTool === 'apply') {
      setIsDragging(true);
      applyColor(lightId);
      setSelectedLights(prev => {
        const next = new Set(prev);
        next.add(lightId);
        return next;
      });
    } else {
      pickupColor(lightId);
    }
  };

  const handleLightMouseEnter = (lightId: number) => {
    if (isDragging && colorTool === 'apply') {
      applyColor(lightId);
      setSelectedLights(prev => {
        const next = new Set(prev);
        next.add(lightId);
        return next;
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Click outside light grid clears selection
  const handleDeselectLights = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.light-cell') && !target.closest('.color-window')) {
      setSelectedLights(new Set());
    }
  };

  useEffect(() => {
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousedown', handleDeselectLights);
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleDeselectLights);
    };
  }, []);

  // Track preview strip bottom for sticky color picker
  useEffect(() => {
    const el = previewStripRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const bottom = rect.bottom + window.scrollY;
      document.documentElement.style.setProperty('--preview-strip-bottom', `${rect.bottom}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener('scroll', update, { passive: true });
    return () => { observer.disconnect(); window.removeEventListener('scroll', update); };
  }, [layout]);

  // Auto-update static preview when colors change (always sends to WS; ArtNet only if live)
  // Uses isLivePreviewRef to avoid re-firing when live toggle changes (toggle handles that directly)
  // Auto-update preview when design content changes.
  // Reads live state from ref at call time so the toggle doesn't cause re-fires.
  // Skips if live preview is on — the toggle handles that path directly.
  useEffect(() => {
    if (!isVisible || activeTab !== 'static' || !isEditingStatic) return;
    if (Object.keys(currentColors).length === 0) return;
    const timeout = setTimeout(async () => {
      const live = isLivePreviewRef.current;
      try {
        await previewAPI.start({
          designType: 'static',
          designData: { colors: currentColors },
          live,
        });
      } catch {
        // silently fail
      }
    }, 200);
    return () => clearTimeout(timeout);
  }, [isVisible, activeTab, isEditingStatic, currentColors]);

  useEffect(() => {
    if (!isVisible || activeTab !== 'motion' || !selectedEffect) return;
    const timeout = setTimeout(async () => {
      const live = isLivePreviewRef.current;
      try {
        await previewAPI.previewEffect({
          effectType: selectedEffect.type,
          colors: motionColors,
          params: motionParams,
          speed: motionSpeed,
          scope: motionScope,
          live,
        });
      } catch {
        // silently fail
      }
    }, 200);
    return () => clearTimeout(timeout);
  }, [isVisible, activeTab, selectedEffect, motionColors, motionParams, motionSpeed, motionScope]);

  const copyWallDesign = (fromWall: Wall, toWall: Wall) => {
    if (!layout) return;

    const fromMatrix = fromWall.matrix;
    const toMatrix = toWall.matrix;

    if (!fromMatrix || !toMatrix) return;

    setCurrentColors((prev) => {
      const newColors = { ...prev };

      // Copy colors based on relative position
      for (let y = 0; y < Math.min(fromWall.height, toWall.height); y++) {
        for (let x = 0; x < Math.min(fromWall.width, toWall.width); x++) {
          const fromLight = fromMatrix[y]?.[x];
          const toLight = toMatrix[y]?.[x];

          if (fromLight && toLight && prev[fromLight.light_id]) {
            newColors[toLight.light_id] = { ...prev[fromLight.light_id] };
          }
        }
      }

      return newColors;
    });
  };

  const handleSaveDesign = async () => {
    if (!selectedDesign) {
      setShowSaveModal(true);
      return;
    }

    try {
      if (activeTab === 'static') {
        await designsAPI.update(selectedDesign.id, {
          name: selectedDesign.name,
          data: { colors: currentColors, ...(staticPrompt ? { prompt: staticPrompt } : {}) },
        });
        savedColorsRef.current = JSON.stringify(currentColors);
      } else if (activeTab === 'motion' && selectedEffect) {
        await designsAPI.update(selectedDesign.id, {
          name: selectedDesign.name,
          data: {
            type: selectedEffect.type,
            colors: motionColors,
            params: motionParams,
            speed: motionSpeed,
            scope: motionScope,
          },
        });
        savedMotionRef.current = JSON.stringify({ effect: selectedEffect.type, colors: motionColors, speed: motionSpeed, params: motionParams, scope: motionScope });
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save design');
    }
  };

  const handleSaveAs = async () => {
    if (!saveAsName.trim()) return;

    try {
      if (activeTab === 'static') {
        await designsAPI.create({
          name: saveAsName,
          type: 'static',
          data: { colors: currentColors, ...(staticPrompt ? { prompt: staticPrompt } : {}) },
        });
        savedColorsRef.current = JSON.stringify(currentColors);
      } else if (activeTab === 'motion' && selectedEffect) {
        await designsAPI.create({
          name: saveAsName,
          type: 'motion',
          data: {
            type: selectedEffect.type,
            colors: motionColors,
            params: motionParams,
            speed: motionSpeed,
            scope: motionScope,
          },
        });
        savedMotionRef.current = JSON.stringify({ effect: selectedEffect.type, colors: motionColors, speed: motionSpeed, params: motionParams, scope: motionScope });
      }
      await loadData();
      setShowSaveModal(false);
      setSaveAsName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save design');
    }
  };

  const handleDeleteDesign = async (designId: string) => {
    if (!confirm('Are you sure you want to delete this design?')) return;

    try {
      await designsAPI.delete(designId);
      if (selectedDesign?.id === designId) {
        setSelectedDesign(null);
        setCurrentColors({});
        setIsEditingStatic(false);
        try {
          await previewAPI.stop();
          setIsLivePreview(false);
        } catch {
          // silently fail
        }
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete design');
    }
  };

  const handleRenameDesign = async (designId: string) => {
    if (!renameValue.trim()) return;
    try {
      const design = designs.find(d => d.id === designId);
      if (!design) return;
      await designsAPI.update(designId, { name: renameValue.trim(), data: design.data });
      if (selectedDesign?.id === designId) {
        setSelectedDesign({ ...selectedDesign, name: renameValue.trim() });
      }
      setRenamingDesignId(null);
      setRenameValue('');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename design');
    }
  };

  // Motion mode functions
  const selectEffect = async (effect: EffectType) => {
    setSelectedEffect(effect);
    setSelectedDesign(null);
    setMotionColors([...effect.defaultColors]);
    setMotionSpeed(1);
    setMotionScope('all');
    setSelectedMotionColorIdx(0);
    if (effect.defaultColors.length > 0) {
      setCurrentColor({ ...effect.defaultColors[0] });
    }
    const params: Record<string, number | boolean | string> = {};
    Object.entries(effect.params).forEach(([key, param]) => {
      params[key] = param.default;
    });
    setMotionParams(params);
    savedMotionRef.current = JSON.stringify({ effect: effect.type, colors: effect.defaultColors, speed: 1, params, scope: 'all' });
    // Start soft preview (WebSocket only, no ArtNet)
    try {
      await previewAPI.previewEffect({
        effectType: effect.type,
        colors: effect.defaultColors,
        params,
        speed: 1,
        scope: 'all',
        live: false,
      });
    } catch {
      // silently fail
    }
  };

  const loadMotionDesign = async (design: Design) => {
    setSelectedDesign(design);
    const data = design.data as MotionDesignData;
    const effect = effectTypes.find((e) => e.type === data.type);
    if (effect) {
      setSelectedEffect(effect);
      const colors = data.colors || effect.defaultColors;
      const speed = data.speed || 1;
      const scope = data.scope || 'all';
      const params = (data.params as Record<string, number | boolean | string>) || {};
      setMotionColors(colors);
      setMotionSpeed(speed);
      setMotionScope(scope);
      setMotionParams(params);
      setSelectedMotionColorIdx(0);
      if (colors.length > 0) {
        setCurrentColor({ ...colors[0] });
      }
      savedMotionRef.current = JSON.stringify({ effect: effect.type, colors, speed, params, scope });
      // Start soft preview (WebSocket only, no ArtNet)
      try {
        await previewAPI.previewEffect({
          effectType: effect.type,
          colors,
          params,
          speed,
          scope,
          live: false,
        });
      } catch {
        // Preview failed silently
      }
    }
  };

  // Playlist mode functions
  const startNewPlaylist = () => {
    setSelectedPlaylist(null);
    setEditingPlaylistItems([]);
    setEditingPlaylistMode('sequence');
    setPlaylistName('');
  };

  const loadPlaylist = (playlist: Playlist) => {
    setSelectedPlaylist(playlist);
    setEditingPlaylistItems(playlist.items.map(i => ({
      design_id: i.design_id,
      design_name: i.design_name,
      design_type: i.design_type,
      duration: i.duration,
      transition: i.transition || 'cut',
    })));
    setEditingPlaylistMode(playlist.play_mode);
    setPlaylistName(playlist.name);
  };

  const addDesignToEditor = (designId: string) => {
    const design = designs.find(d => d.id === designId);
    if (!design) return;
    setEditingPlaylistItems(prev => [...prev, {
      design_id: designId,
      design_name: design.name,
      design_type: design.type,
      duration: 10,
      transition: 'cut',
    }]);
  };

  const removeItemFromEditor = (index: number) => {
    setEditingPlaylistItems(prev => prev.filter((_, i) => i !== index));
  };

  const updateEditorItem = (index: number, field: string, value: number | string) => {
    setEditingPlaylistItems(prev => prev.map((item, i) =>
      i === index ? { ...item, [field]: value } : item
    ));
  };

  const savePlaylist = async (nameOverride?: string) => {
    if (editingPlaylistItems.length === 0) return;

    try {
      if (selectedPlaylist) {
        // Update existing
        await playlistsAPI.update(selectedPlaylist.id, {
          name: playlistName || selectedPlaylist.name,
          play_mode: editingPlaylistMode,
          items: editingPlaylistItems.map(i => ({ design_id: i.design_id, duration: i.duration, transition: i.transition })),
        });
      } else {
        // New playlist — need a name
        const name = nameOverride?.trim();
        if (!name) {
          setShowPlaylistSaveModal(true);
          return;
        }
        const created = await playlistsAPI.create({
          name,
          play_mode: editingPlaylistMode,
          items: editingPlaylistItems.map(i => ({ design_id: i.design_id, duration: i.duration, transition: i.transition })),
        });
        setSelectedPlaylist(created);
        setPlaylistName(name);
        setShowPlaylistSaveModal(false);
        setPlaylistSaveName('');
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save playlist');
    }
  };

  const deletePlaylist = async (playlistId: string) => {
    if (!confirm('Are you sure you want to delete this playlist?')) return;

    try {
      await playlistsAPI.delete(playlistId);
      if (selectedPlaylist?.id === playlistId) {
        startNewPlaylist();
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete playlist');
    }
  };

  const handleRenamePlaylist = async (playlistId: string) => {
    if (!renamePlaylistValue.trim()) { setRenamingPlaylistId(null); return; }
    try {
      const playlist = playlists.find(p => p.id === playlistId);
      if (!playlist) return;
      await playlistsAPI.update(playlistId, {
        name: renamePlaylistValue.trim(),
        play_mode: playlist.play_mode,
      });
      if (selectedPlaylist?.id === playlistId) {
        setSelectedPlaylist({ ...selectedPlaylist, name: renamePlaylistValue.trim() });
        setPlaylistName(renamePlaylistValue.trim());
      }
      setRenamingPlaylistId(null);
      setRenamePlaylistValue('');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename playlist');
    }
  };

  const handleDragStart = (idx: number) => {
    setDragPlaylistIdx(idx);
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragPlaylistIdx === null || dragPlaylistIdx === idx) return;
    setEditingPlaylistItems(prev => {
      const items = [...prev];
      const [dragged] = items.splice(dragPlaylistIdx, 1);
      items.splice(idx, 0, dragged);
      return items;
    });
    setDragPlaylistIdx(idx);
  };

  const handleDragEnd = () => {
    setDragPlaylistIdx(null);
  };

  // Preview functions
  const toggleLivePreview = async () => {
    try {
      if (isLivePreview) {
        isLivePreviewRef.current = false;
        setIsLivePreview(false);
        await previewAPI.stop();
      } else {
        isLivePreviewRef.current = true;
        setIsLivePreview(true);
        // Make direct fetch to ensure the call goes through
        let body: Record<string, unknown> = {};
        let endpoint = '/api/preview/start';
        if (activeTab === 'static') {
          body = { designType: 'static', designData: { colors: currentColors }, live: true };
        } else if (activeTab === 'motion' && selectedEffect) {
          endpoint = '/api/preview/effect';
          body = { effectType: selectedEffect.type, colors: motionColors, params: motionParams, speed: motionSpeed, scope: motionScope, live: true };
        } else if (activeTab === 'playlist' && selectedPlaylist) {
          endpoint = '/api/preview/playlist';
          body = { playlistId: selectedPlaylist.id };
        }
        const resp = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!resp.ok) console.error('[LivePreview] HTTP error:', resp.status, await resp.text());
      }
    } catch (err) {
      console.error('[LivePreview] fetch error:', err);
      isLivePreviewRef.current = false;
      setIsLivePreview(false);
      setError(err instanceof Error ? err.message : 'Failed to toggle preview');
    }
  };

  // AI generation function
  const generateAIDesign = async () => {
    if (!aiDescription.trim()) return;

    setAiLoading(true);
    setAiError(null);

    try {
      const result = await aiAPI.generate({
        description: aiDescription,
        mode: 'create',
      });

      if (result.success && result.design) {
        const design = result.design;

        if (design.type === 'static') {
          setActiveTab('static');
          setSelectedDesign(null);
          setIsEditingStatic(true);
          if (design.colors) {
            const colorMap: Record<number, RGBW> = {};
            design.colors.forEach((color: RGBW, idx: number) => {
              colorMap[idx + 1] = color;
            });
            setCurrentColors(colorMap);
            setStaticPrompt(aiDescription);
            savedColorsRef.current = '{}';
            // Start soft preview
            try {
              await previewAPI.start({ designType: 'static', designData: { colors: colorMap }, live: false });
            } catch {}
          }
        } else {
          setActiveTab('motion');
          setSelectedDesign(null);
          const effect = effectTypes.find((e) => e.type === design.effect);
          if (effect) {
            setSelectedEffect(effect);
            setMotionColors(design.colors || effect.defaultColors);
            setMotionSpeed(design.speed || 1);
            setMotionScope((design.scope as 'all' | 'wall' | 'group') || 'all');
            setMotionParams((design.params as Record<string, number | boolean | string>) || {});
            setSelectedMotionColorIdx(0);
            savedMotionRef.current = '{}';
            try {
              await previewAPI.previewEffect({
                effectType: effect.type,
                colors: design.colors || effect.defaultColors,
                params: design.params || {},
                speed: design.speed || 1,
                scope: design.scope || 'all',
                live: false,
              });
            } catch {}
          }
        }

        // Prepopulate save name with AI-generated name
        setSaveAsName(design.name || '');
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

  // AI edit function — sends current design data + edit instructions
  const editAIDesign = async () => {
    if (!aiEditDescription.trim()) return;

    // Determine what we're editing
    const isStaticEdit = activeTab === 'static';
    if (!isStaticEdit && !selectedEffect) return;

    setAiLoading(true);
    setAiError(null);

    try {
      let currentData: Record<string, unknown>;
      if (isStaticEdit) {
        currentData = {
          type: 'static',
          colors: currentColors,
        };
      } else {
        currentData = {
          type: 'motion',
          effect: selectedEffect!.type,
          colors: motionColors,
          speed: motionSpeed,
          scope: motionScope,
          params: motionParams,
        };
      }

      const result = await aiAPI.generate({
        description: aiEditDescription,
        currentDesignData: currentData as any,
        mode: 'modify',
      });

      if (result.success && result.design) {
        const design = result.design;

        if (design.type === 'static' && isStaticEdit) {
          if (design.colors) {
            const colorMap: Record<number, RGBW> = {};
            design.colors.forEach((color: RGBW, idx: number) => {
              colorMap[idx + 1] = color;
            });
            setCurrentColors(colorMap);
            setStaticPrompt((staticPrompt ? staticPrompt + ' | Edit: ' : '') + aiEditDescription);
            try {
              await previewAPI.start({ designType: 'static', designData: { colors: colorMap }, live: isLivePreview });
            } catch {}
          }
        } else if (design.type === 'motion' && !isStaticEdit) {
          const effect = effectTypes.find((e) => e.type === design.effect);
          if (effect) {
            setSelectedEffect(effect);
            setMotionColors(design.colors || effect.defaultColors);
            setMotionSpeed(design.speed || 1);
            setMotionScope((design.scope as 'all' | 'wall' | 'group') || 'all');
            // Preserve the original prompt, append edit history
            const originalPrompt = (motionParams.prompt as string) || '';
            const newParams = (design.params as Record<string, number | boolean | string>) || {};
            newParams.prompt = originalPrompt + ' | Edit: ' + aiEditDescription;
            setMotionParams(newParams);
            setSelectedMotionColorIdx(0);
            try {
              await previewAPI.previewEffect({
                effectType: effect.type,
                colors: design.colors || effect.defaultColors,
                params: newParams,
                speed: design.speed || 1,
                scope: design.scope || 'all',
                live: isLivePreview,
              });
            } catch {}
          }
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

  // Helper functions
  const rgbwToHex = (color: RGBW): string => {
    const r = Math.round(color.r);
    const g = Math.round(color.g);
    const b = Math.round(color.b);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  };

  const hexToRgbw = (hex: string, w: number = 0): RGBW => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16),
          w,
        }
      : { r: 0, g: 0, b: 0, w: 0 };
  };

  // Get simulated color with defective channels zeroed out, or null if no conflict
  const getDefectiveSimulation = (lightId: number, defectiveChannels: string): string | null => {
    if (!defectiveChannels) return null;
    const color = frameData[lightId] ? frameData[lightId] : currentColors[lightId];
    if (!color) return null;
    const channels = defectiveChannels.split(',');
    const hasConflict = channels.some(ch =>
      (ch === 'r' && color.r > 0) || (ch === 'g' && color.g > 0) ||
      (ch === 'b' && color.b > 0) || (ch === 'w' && color.w > 0)
    );
    if (!hasConflict) return null;
    // Simulate actual output: zero defective channels, then combine
    let { r, g, b, w } = color;
    for (const ch of channels) {
      if (ch === 'r') r = 0;
      if (ch === 'g') g = 0;
      if (ch === 'b') b = 0;
      if (ch === 'w') w = 0;
    }
    return `rgb(${Math.min(255, r + w)}, ${Math.min(255, g + w)}, ${Math.min(255, b + w)})`;
  };

  const getLightColor = (lightId: number): string => {
    // Use frame data from WS if available (soft or live preview), otherwise design colors.
    // Frame data is raw (unmasked) — defective simulation is handled separately.
    const color = frameData[lightId] ? frameData[lightId] : currentColors[lightId];

    if (!color) return '#222';

    // Combine RGB and W for display
    const r = Math.min(255, color.r + color.w);
    const g = Math.min(255, color.g + color.w);
    const b = Math.min(255, color.b + color.w);

    return `rgb(${r}, ${g}, ${b})`;
  };

  // Always show intended design color (ignores live preview / defective masking)
  const getDesignColor = (lightId: number): string => {
    const color = currentColors[lightId];
    if (!color) return '#222';
    const r = Math.min(255, color.r + color.w);
    const g = Math.min(255, color.g + color.w);
    const b = Math.min(255, color.b + color.w);
    return `rgb(${r}, ${g}, ${b})`;
  };

  const renderColorPicker = (showTools: boolean) => (
    <div className="color-window">
      <div className="color-window-titlebar">
        {showTools && (
          <div className="color-toolbar-tools" style={{ flexDirection: 'row' }}>
            <button
              className={`btn btn-sm color-toolbar-tool ${colorTool === 'apply' ? 'active' : ''}`}
              onClick={() => setColorTool('apply')}
              title="Paint (apply color)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 7h14a1 1 0 011 1v11a2 2 0 01-2 2H6a2 2 0 01-2-2V8a1 1 0 011-1z"/>
                <ellipse cx="12" cy="7" rx="8" ry="3"/>
                <path d="M19 10c1.5 1 2.5 2.5 2.5 4 0 1.5-1.5 2-2.5 1"/>
              </svg>
            </button>
            <button
              className={`btn btn-sm color-toolbar-tool ${colorTool === 'pickup' ? 'active' : ''}`}
              onClick={() => setColorTool('pickup')}
              title="Pickup (copy color)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
        <div
          className="color-toolbar-swatch"
          style={{
            backgroundColor: `rgb(${Math.min(255, currentColor.r + currentColor.w)}, ${Math.min(255, currentColor.g + currentColor.w)}, ${Math.min(255, currentColor.b + currentColor.w)})`,
          }}
        />
      </div>
      <div className="color-window-body">
        <div className="color-window-picker">
          <RgbColorPicker
            color={hasRGBW ? {
              r: Math.min(255, currentColor.r + currentColor.w),
              g: Math.min(255, currentColor.g + currentColor.w),
              b: Math.min(255, currentColor.b + currentColor.w),
            } : {
              r: currentColor.r,
              g: currentColor.g,
              b: currentColor.b,
            }}
            onChange={(rgb) => {
              let newColor: RGBW;
              if (hasRGBW) {
                const w = Math.min(rgb.r, rgb.g, rgb.b);
                newColor = { r: rgb.r - w, g: rgb.g - w, b: rgb.b - w, w };
              } else {
                newColor = { r: rgb.r, g: rgb.g, b: rgb.b, w: 0 };
              }
              setCurrentColor(newColor);
              if (activeTab === 'static' && selectedLights.size > 0) {
                setCurrentColors(prev => {
                  const next = { ...prev };
                  for (const id of selectedLights) {
                    next[id] = { ...newColor };
                  }
                  return next;
                });
              }
              if (activeTab === 'motion' && selectedMotionColorIdx < motionColors.length) {
                setMotionColors(prev => {
                  const next = [...prev];
                  next[selectedMotionColorIdx] = newColor;
                  return next;
                });
              }
            }}
          />
        </div>
        <div className="color-toolbar-values">
          {(hasRGBW ? ['r', 'g', 'b', 'w'] as const : ['r', 'g', 'b'] as const).map((ch) => {
            const labels: Record<string, string> = { r: 'R', g: 'G', b: 'B', w: 'W' };
            const clrs: Record<string, string> = { r: '#f87171', g: '#4ade80', b: '#60a5fa', w: '#e2e8f0' };
            return (
              <div key={ch} className="color-toolbar-channel">
                <span style={{ color: clrs[ch], fontSize: '0.625rem', fontWeight: 600 }}>{labels[ch]}</span>
                <input
                  type="number"
                  className="color-toolbar-input"
                  value={currentColor[ch]}
                  min={0}
                  max={255}
                  onChange={(e) => {
                    const newColor = { ...currentColor, [ch]: Math.max(0, Math.min(255, parseInt(e.target.value) || 0)) };
                    setCurrentColor(newColor);
                    if (activeTab === 'static' && selectedLights.size > 0) {
                      setCurrentColors(prev => {
                        const next = { ...prev };
                        for (const id of selectedLights) {
                          next[id] = { ...newColor };
                        }
                        return next;
                      });
                    }
                    if (activeTab === 'motion' && selectedMotionColorIdx < motionColors.length) {
                      setMotionColors(prev => {
                        const next = [...prev];
                        next[selectedMotionColorIdx] = newColor;
                        return next;
                      });
                    }
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  if (loading) {
    return <div className="page-header"><h1>Loading...</h1></div>;
  }

  return (
    <div>
      {/* Preview Strip */}
      {layout && (() => {
        // Build continuous row of lights: West → North → East → South
        const totalCols = layout.walls.reduce((sum, w) => sum + w.width, 0);
        const maxRows = Math.max(...layout.walls.map(w => w.height));
        const wallOffsets: { wall: typeof layout.walls[0]; startCol: number }[] = [];
        let col = 0;
        for (const wall of layout.walls) {
          wallOffsets.push({ wall, startCol: col });
          col += wall.width;
        }

        return (
          <div className="preview-strip" ref={previewStripRef}>
            <div className="preview-strip-header">
              <div className="preview-strip-title">Preview</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <div className="preview-mode-toggle">
                  <button
                    className={previewMode === '2d' ? 'active' : ''}
                    onClick={() => setPreviewMode('2d')}
                  >
                    2D
                  </button>
                  <button
                    className={previewMode === '3d' ? 'active' : ''}
                    onClick={() => setPreviewMode('3d')}
                  >
                    3D
                  </button>
                </div>
                <div className="live-preview-toggle">
                  <span>Show Defective</span>
                  <div
                    className={`toggle-switch ${showDefective ? 'active' : ''}`}
                    onClick={() => { setShowDefective(d => { localStorage.setItem('showDefective', String(!d)); return !d; }); }}
                  />
                </div>
                <div className="live-preview-toggle">
                  <span>Live Preview</span>
                  <div
                    className={`toggle-switch ${isLivePreview ? 'active' : ''}`}
                    onClick={toggleLivePreview}
                  />
                </div>
              </div>
            </div>
            {previewMode === '2d' ? (
            <div className="preview-strip-grid-wrapper">
              <div
                className="preview-strip-grid"
                style={{ gridTemplateColumns: layout.walls.map(w => `repeat(${w.width}, 1fr)`).join(' 6px ') }}
              >
                {Array.from({ length: maxRows }, (_, rowIdx) => {
                  const y = maxRows - 1 - rowIdx;
                  return layout.walls.flatMap((wall, wallIdx) => {
                    const cells = Array.from({ length: wall.width }, (_, x) => {
                      const light = wall.matrix?.[y]?.[x];
                      if (!light || y >= wall.height) {
                        return (
                          <div
                            key={`${wall.id}-${y}-${x}`}
                            className="preview-strip-cell"
                            style={{ backgroundColor: '#111' }}
                          />
                        );
                      }
                      const isDefective = showDefective && !!light.defective_channels;
                      const simColor = isDefective ? getDefectiveSimulation(light.light_id, light.defective_channels!) : null;
                      return (
                        <div
                          key={light.id}
                          className={`preview-strip-cell${isDefective ? ' preview-strip-cell-defective' : ''}`}
                          style={{ backgroundColor: simColor || getLightColor(light.light_id) }}
                          title={`#${light.light_id} (${wall.name})${isDefective ? ' — defective: ' + light.defective_channels!.toUpperCase() : ''}`}
                        />
                      );
                    });
                    // Add spacer column between walls
                    if (wallIdx < layout.walls.length - 1) {
                      cells.push(<div key={`spacer-${wall.id}-${y}`} className="preview-strip-spacer" />);
                    }
                    return cells;
                  });
                })}
              </div>
              {/* Wall labels */}
              <div
                className="preview-strip-labels"
                style={{ gridTemplateColumns: layout.walls.map(w => `${w.width}fr`).join(' 6px ') }}
              >
                {layout.walls.map((wall, wallIdx) => (
                  <>{wallIdx > 0 && <div key={`spacer-label-${wall.id}`} />}<div key={wall.id} className="preview-strip-label">{wall.name}</div></>
                ))}
              </div>
            </div>
            ) : (
              <Suspense fallback={<div className="preview-3d-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>Loading 3D view...</div>}>
                <Preview3D
                  walls={layout.walls}
                  getLightColor={getLightColor}
                  getDefectiveSimulation={getDefectiveSimulation}
                  showDefective={showDefective}
                />
              </Suspense>
            )}
          </div>
        );
      })()}

      {/* Static AI prompt display */}
      {activeTab === 'static' && staticPrompt && (
        <div style={{ marginBottom: '0.75rem', padding: '0.5rem 0.75rem', background: 'var(--bg-tertiary)', borderRadius: '4px', fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
          <span style={{ fontStyle: 'italic', flex: 1 }}>{staticPrompt}</span>
          {aiEnabled && (
            <button
              className="btn btn-secondary"
              style={{ padding: '0.15rem 0.5rem', fontSize: '0.75rem', flexShrink: 0 }}
              onClick={() => { setAiEditDescription(''); setAiError(null); setShowAiEditPanel(true); }}
            >
              Edit
            </button>
          )}
        </div>
      )}

      {/* AI Designer Modal */}
      {showAiPanel && aiEnabled && (
        <div className="modal-overlay" onClick={() => { if (!aiLoading) setShowAiPanel(false); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div className="modal-header">
              <h3 className="modal-title">AI Design Generator</h3>
              <button className="modal-close" onClick={() => { if (!aiLoading) setShowAiPanel(false); }}>
                &times;
              </button>
            </div>

            <p style={{ marginBottom: '1rem', color: 'var(--text-secondary)' }}>
              Describe the light show you want and AI will generate it for you.
            </p>

            <div className="form-group">
              <label className="form-label">
                Describe your design
              </label>
              <textarea
                className="form-input"
                rows={3}
                value={aiDescription}
                onChange={(e) => setAiDescription(e.target.value)}
                placeholder={activeTab === 'static'
                  ? "e.g., 'A warm sunset gradient from orange on the west to purple on the east'"
                  : "e.g., 'Christmas candy cane stripes in red and green moving slowly'"
                }
                disabled={aiLoading}
                style={{ resize: 'vertical' }}
                autoFocus
              />
            </div>
            {aiError && (
              <div style={{ color: 'var(--error)', marginBottom: '1rem' }}>
                {aiError}
              </div>
            )}

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { if (!aiLoading) setShowAiPanel(false); }}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={generateAIDesign}
                disabled={aiLoading || !aiDescription.trim()}
              >
                {aiLoading ? 'Generating...' : 'Generate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI Edit Modal */}
      {showAiEditPanel && aiEnabled && (
        <div className="modal-overlay" onClick={() => { if (!aiLoading) setShowAiEditPanel(false); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div className="modal-header">
              <h3 className="modal-title">Edit AI Design</h3>
              <button className="modal-close" onClick={() => { if (!aiLoading) setShowAiEditPanel(false); }}>
                &times;
              </button>
            </div>

            <div style={{ marginBottom: '1rem', padding: '0.5rem 0.75rem', background: 'var(--bg-tertiary)', borderRadius: '4px', fontSize: '0.8rem' }}>
              <div style={{ color: 'var(--text-secondary)', marginBottom: '0.25rem', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Current prompt</div>
              <div style={{ color: 'var(--text-primary)', fontStyle: 'italic' }}>{activeTab === 'static' ? staticPrompt : (motionParams.prompt as string)}</div>
            </div>

            <div className="form-group">
              <label className="form-label">What would you like to change?</label>
              <textarea
                className="form-input"
                rows={3}
                value={aiEditDescription}
                onChange={(e) => setAiEditDescription(e.target.value)}
                placeholder="e.g., 'Make it faster', 'Add a sparkle effect on top', 'Change the direction to right-to-left'"
                disabled={aiLoading}
                style={{ resize: 'vertical' }}
                autoFocus
              />
            </div>
            {aiError && (
              <div style={{ color: 'var(--error)', marginBottom: '1rem' }}>
                {aiError}
              </div>
            )}

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { if (!aiLoading) setShowAiEditPanel(false); }}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={editAIDesign}
                disabled={aiLoading || !aiEditDescription.trim()}
              >
                {aiLoading ? 'Applying...' : 'Apply Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="card" style={{ backgroundColor: 'var(--error)', marginBottom: '1rem' }}>
          {error}
          <button className="btn btn-sm" onClick={() => setError(null)} style={{ marginLeft: '1rem' }}>
            Dismiss
          </button>
        </div>
      )}

      {/* Static Mode */}
      {activeTab === 'static' && (
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
          <div className="design-sidebar">
            <div className="tabs" style={{ marginBottom: 0 }}>
              <button className={`tab ${activeTab === 'static' ? 'active' : ''}`} onClick={() => setActiveTab('static')}>Static</button>
              <button className={`tab ${activeTab === 'motion' ? 'active' : ''}`} onClick={() => setActiveTab('motion')}>Motion</button>
              <button className={`tab ${activeTab === 'playlist' ? 'active' : ''}`} onClick={() => setActiveTab('playlist')}>Playlist</button>
            </div>
            {aiEnabled && (
              <button className={`btn btn-sm ${showAiPanel ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setShowAiPanel(!showAiPanel)} style={{ width: '100%' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>
                AI Designer
              </button>
            )}
            <div className="card">
              <div className="card-header" style={{ marginBottom: '0.375rem', paddingBottom: '0.375rem' }}>
                <h3 className="card-title">Saved Designs</h3>
              </div>
              <div className="saved-designs-scroll" style={{ maxHeight: 'none' }}>
                <table className="table saved-designs-table">
                  <tbody>
                    {designs.filter((d) => d.type === 'static').map((design) => (
                      <tr key={design.id} style={{ cursor: 'pointer', backgroundColor: selectedDesign?.id === design.id ? 'var(--bg-tertiary)' : undefined, borderLeft: selectedDesign?.id === design.id ? '3px solid var(--primary-color)' : '3px solid transparent' }} onClick={() => loadDesign(design)}>
                        <td style={{ fontWeight: selectedDesign?.id === design.id ? 600 : 400 }}>
                          {renamingDesignId === design.id ? (
                            <input className="form-input" style={{ padding: '0.2rem 0.4rem', fontSize: '0.8rem', width: '100%' }} value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleRenameDesign(design.id); if (e.key === 'Escape') setRenamingDesignId(null); }} onBlur={() => handleRenameDesign(design.id)} onClick={(e) => e.stopPropagation()} autoFocus />
                          ) : design.name}
                        </td>
                        <td style={{ width: '1px', whiteSpace: 'nowrap' }}>
                          <button className="btn-icon" style={{ padding: '0.2rem' }} title="Rename" onClick={(e) => { e.stopPropagation(); setRenamingDesignId(design.id); setRenameValue(design.name); }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
                          </button>
                          <button className="btn-icon" style={{ padding: '0.2rem', color: 'var(--danger-color)' }} title="Delete" onClick={(e) => { e.stopPropagation(); handleDeleteDesign(design.id); }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Center: Light Matrix */}
          <div style={{ flex: 1 }}>
            {isEditingStatic && layout && (
              <>
                <div className="btn-group" style={{ marginBottom: '0.5rem' }}>
                  {selectedDesign ? (
                    <button className="btn btn-primary btn-sm" onClick={async () => { setSelectedDesign(null); setCurrentColors({}); setStaticPrompt(''); savedColorsRef.current = '{}'; setIsEditingStatic(true); try { await previewAPI.start({ designType: 'static', designData: { colors: {} }, live: false }); } catch {} }}>New</button>
                  ) : (
                    hasChanges && <button className="btn btn-secondary btn-sm" onClick={async () => { setCurrentColors({}); setStaticPrompt(''); savedColorsRef.current = '{}'; try { await previewAPI.start({ designType: 'static', designData: { colors: {} }, live: false }); } catch {} }}>Clear</button>
                  )}
                  {hasChanges && selectedDesign && <button className="btn btn-primary btn-sm" onClick={handleSaveDesign}>Save</button>}
                  {hasChanges && selectedDesign && <button className="btn btn-secondary btn-sm" onClick={() => setShowSaveModal(true)}>Save As</button>}
                  {hasChanges && !selectedDesign && <button className="btn btn-primary btn-sm" onClick={() => setShowSaveModal(true)}>Save</button>}
                  {selectedDesign && hasChanges && <button className="btn btn-secondary btn-sm" onClick={async () => { const savedColors = JSON.parse(savedColorsRef.current); setCurrentColors(savedColors); try { await previewAPI.start({ designType: 'static', designData: { colors: savedColors }, live: false }); } catch {} }}>Cancel</button>}
                </div>
                <div className="matrix-walls-wrap">
                  {layout.walls.map((wall) => (
                    <div key={wall.id} className="wall-group" style={{ flex: `${wall.width} 0 0`, minWidth: `${wall.width * 4}%` }}>
                      <div className="wall-group-label">
                        <span>{wall.name}</span>
                        {wall.name === 'West' && layout.walls.find((w) => w.name === 'East') && <button className="btn btn-secondary btn-sm" style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem' }} onClick={() => copyWallDesign(wall, layout.walls.find((w) => w.name === 'East')!)}>Copy to East</button>}
                        {wall.name === 'North' && layout.walls.find((w) => w.name === 'South') && <button className="btn btn-secondary btn-sm" style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem' }} onClick={() => copyWallDesign(wall, layout.walls.find((w) => w.name === 'South')!)}>Copy to South</button>}
                      </div>
                      <div className="light-grid" style={{ gridTemplateColumns: `repeat(${wall.width}, 1fr)` }}>
                        {Array.from({ length: wall.height }, (_, rowIdx) => {
                          const y = wall.height - 1 - rowIdx;
                          return Array.from({ length: wall.width }, (_, x) => {
                            const light = wall.matrix?.[y]?.[x];
                            if (!light) return <div key={`${y}-${x}`} className="light-cell" />;
                            return (
                              <div key={light.id} className={`light-cell${selectedLights.has(light.light_id) ? ' selected' : ''}`} style={{ backgroundColor: getDesignColor(light.light_id), cursor: colorTool === 'pickup' ? 'crosshair' : 'pointer' }} onMouseDown={(e) => handleLightMouseDown(light.light_id, e)} onMouseEnter={() => handleLightMouseEnter(light.light_id)} onClick={() => handleLightClick(light.light_id)}>
                                {light.light_id}
                              </div>
                            );
                          });
                        }).flat()}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Right Column: Color Picker */}
          <div className="color-picker-column">
            {renderColorPicker(true)}
          </div>
        </div>
      )}

      {/* Motion Mode */}
      {activeTab === 'motion' && (
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
          <div className="design-sidebar">
            <div className="tabs" style={{ marginBottom: 0 }}>
              <button className={`tab ${activeTab === 'static' ? 'active' : ''}`} onClick={() => setActiveTab('static')}>Static</button>
              <button className={`tab ${activeTab === 'motion' ? 'active' : ''}`} onClick={() => setActiveTab('motion')}>Motion</button>
              <button className={`tab ${activeTab === 'playlist' ? 'active' : ''}`} onClick={() => setActiveTab('playlist')}>Playlist</button>
            </div>
            {aiEnabled && (
              <button className={`btn btn-sm ${showAiPanel ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setShowAiPanel(!showAiPanel)} style={{ width: '100%' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>
                AI Designer
              </button>
            )}
            <div className="card">
              <div className="card-header" style={{ marginBottom: '0.375rem', paddingBottom: '0.375rem' }}>
                <h3 className="card-title">Saved Designs</h3>
              </div>
              <div className="saved-designs-scroll" style={{ maxHeight: 'none' }}>
                <table className="table saved-designs-table">
                  <tbody>
                    {designs.filter((d) => d.type === 'motion').map((design) => (
                      <tr key={design.id} style={{ cursor: 'pointer', backgroundColor: selectedDesign?.id === design.id ? 'var(--bg-tertiary)' : undefined, borderLeft: selectedDesign?.id === design.id ? '3px solid var(--primary-color)' : '3px solid transparent' }} onClick={() => loadMotionDesign(design)}>
                        <td style={{ fontWeight: selectedDesign?.id === design.id ? 600 : 400 }}>
                          {renamingDesignId === design.id ? (
                            <input className="form-input" style={{ padding: '0.2rem 0.4rem', fontSize: '0.8rem', width: '100%' }} value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleRenameDesign(design.id); if (e.key === 'Escape') setRenamingDesignId(null); }} onBlur={() => handleRenameDesign(design.id)} onClick={(e) => e.stopPropagation()} autoFocus />
                          ) : design.name}
                        </td>
                        <td style={{ width: '1px', whiteSpace: 'nowrap' }}>
                          <button className="btn-icon" style={{ padding: '0.2rem' }} title="Rename" onClick={(e) => { e.stopPropagation(); setRenamingDesignId(design.id); setRenameValue(design.name); }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
                          </button>
                          <button className="btn-icon" style={{ padding: '0.2rem', color: 'var(--danger-color)' }} title="Delete" onClick={(e) => { e.stopPropagation(); handleDeleteDesign(design.id); }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Center: Action buttons + Effect Config */}
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
              {selectedDesign ? (
                <button className="btn btn-primary btn-sm" onClick={() => { setSelectedDesign(null); setSelectedEffect(null); setMotionColors([]); setMotionSpeed(1); setMotionScope('all'); setMotionParams({}); savedMotionRef.current = '{}'; }}>New</button>
              ) : (
                selectedEffect && <button className="btn btn-secondary btn-sm" onClick={async () => { setSelectedEffect(null); setMotionColors([]); setMotionSpeed(1); setMotionScope('all'); setMotionParams({}); savedMotionRef.current = '{}'; try { await previewAPI.stop(); setIsLivePreview(false); } catch {} }}>Clear</button>
              )}
              {hasMotionChanges && selectedDesign && <button className="btn btn-primary btn-sm" onClick={handleSaveDesign}>Save</button>}
              {hasMotionChanges && selectedDesign && <button className="btn btn-secondary btn-sm" onClick={() => setShowSaveModal(true)}>Save As</button>}
              {!selectedDesign && selectedEffect && <button className="btn btn-primary btn-sm" onClick={() => setShowSaveModal(true)}>Save</button>}
              {selectedDesign && hasMotionChanges && <button className="btn btn-secondary btn-sm" onClick={async () => { const saved = JSON.parse(savedMotionRef.current); if (saved.effect) { const effect = effectTypes.find(e => e.type === saved.effect); if (effect) { setSelectedEffect(effect); setMotionColors(saved.colors || effect.defaultColors); setMotionSpeed(saved.speed || 1); setMotionScope(saved.scope || 'all'); setMotionParams(saved.params || {}); try { await previewAPI.previewEffect({ effectType: effect.type, colors: saved.colors || effect.defaultColors, params: saved.params || {}, speed: saved.speed || 1, scope: saved.scope || 'all', live: false }); } catch {} } } }}>Cancel</button>}
            </div>
            {!selectedDesign && (
            <div className="card">
              <div className="card-header"><h3 className="card-title">Effect Type</h3></div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {effectTypes.map((effect) => (
                  <button key={effect.type} className={`btn btn-sm ${selectedEffect?.type === effect.type ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { if (effect.type === 'ai' && selectedEffect?.type !== 'ai') { setShowAiPanel(true); } else { selectEffect(effect); } }} title={effect.description}>{effect.name}</button>
                ))}
              </div>
            </div>
            )}
            {selectedEffect && (
              <div className="card">
                <div className="card-header"><h3 className="card-title">{selectedEffect.name}</h3></div>
                {selectedEffect.type === 'ai' && motionParams.prompt && (
                  <div style={{ marginBottom: '0.75rem', padding: '0.5rem 0.75rem', background: 'var(--bg-tertiary)', borderRadius: '4px', fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <span style={{ fontStyle: 'italic', flex: 1 }}>{motionParams.prompt as string}</span>
                    <button
                      className="btn btn-secondary"
                      style={{ padding: '0.15rem 0.5rem', fontSize: '0.75rem', flexShrink: 0 }}
                      onClick={() => { setAiEditDescription(''); setAiError(null); setShowAiEditPanel(true); }}
                    >
                      Edit
                    </button>
                  </div>
                )}
                <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  {selectedEffect.defaultColors.length > 0 && (
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">Colors (click to edit)</label>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        {motionColors.map((color, idx) => (
                          <div key={idx} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
                            <div style={{ width: '40px', height: '40px', borderRadius: '4px', backgroundColor: `rgb(${Math.min(255, color.r + color.w)}, ${Math.min(255, color.g + color.w)}, ${Math.min(255, color.b + color.w)})`, border: selectedMotionColorIdx === idx ? '3px solid var(--primary-color)' : '2px solid var(--border-color)', cursor: 'pointer', boxShadow: selectedMotionColorIdx === idx ? '0 0 0 2px rgba(37, 99, 235, 0.3)' : 'none' }} onClick={() => { setSelectedMotionColorIdx(idx); setCurrentColor({ ...color }); }} title={selectedEffect?.type === 'ai' ? (idx === 0 ? 'Base Color' : `Pattern Color ${idx}`) : `Color ${idx + 1}`} />
                            {selectedEffect?.type === 'ai' && <span style={{ fontSize: '0.6rem', color: 'var(--text-secondary)' }}>{idx === 0 ? 'Base' : 'Pattern'}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="form-group" style={{ marginBottom: 0, minWidth: '120px' }}>
                    <label className="form-label">Speed: {motionSpeed.toFixed(1)}x</label>
                    <input type="range" className="form-input" min={0.1} max={2} step={0.1} value={motionSpeed} onChange={(e) => setMotionSpeed(parseFloat(e.target.value))} style={{ padding: 0 }} />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Scope</label>
                    <div className="preview-mode-toggle">
                      <button className={motionScope === 'all' ? 'active' : ''} onClick={() => setMotionScope('all')}>Continuous</button>
                      <button className={motionScope === 'wall' ? 'active' : ''} onClick={() => setMotionScope('wall')}>Per Wall</button>
                      <button className={motionScope === 'group' ? 'active' : ''} onClick={() => setMotionScope('group')}>Per Group</button>
                    </div>
                  </div>
                </div>
                {Object.entries(selectedEffect.params).length > 0 && (
                  <div className="form-group">
                    <label className="form-label">Parameters</label>
                    <div className="form-row">
                      {Object.entries(selectedEffect.params).map(([key, param]) => (
                        <div key={key} className="form-group">
                          <label className="form-label">{key}</label>
                          {param.type === 'number' ? <><input type="range" className="form-input" min={param.min} max={param.max} step={param.step || 1} value={motionParams[key] as number} onChange={(e) => setMotionParams({ ...motionParams, [key]: parseFloat(e.target.value) })} /><span style={{ marginLeft: '0.5rem' }}>{motionParams[key]?.toString()}</span></> : param.type === 'string' ? <input type="text" className="form-input" style={{ maxWidth: '200px' }} value={(motionParams[key] as string) || ''} onChange={(e) => setMotionParams({ ...motionParams, [key]: e.target.value })} /> : <><input type="checkbox" checked={motionParams[key] as boolean} onChange={(e) => setMotionParams({ ...motionParams, [key]: e.target.checked })} /><span style={{ marginLeft: '0.5rem' }}>{motionParams[key]?.toString()}</span></>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right Column: Color Picker */}
          <div className="color-picker-column">
            {selectedEffect && renderColorPicker(false)}
          </div>
        </div>
      )}

      {/* Playlist Mode */}
      {activeTab === 'playlist' && (
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
          <div className="design-sidebar">
            <div className="tabs" style={{ marginBottom: 0 }}>
              <button className={`tab ${activeTab === 'static' ? 'active' : ''}`} onClick={() => setActiveTab('static')}>Static</button>
              <button className={`tab ${activeTab === 'motion' ? 'active' : ''}`} onClick={() => setActiveTab('motion')}>Motion</button>
              <button className={`tab ${activeTab === 'playlist' ? 'active' : ''}`} onClick={() => setActiveTab('playlist')}>Playlist</button>
            </div>
            <div className="card">
              <div className="card-header" style={{ marginBottom: '0.375rem', paddingBottom: '0.375rem' }}>
                <h3 className="card-title">Saved Playlists</h3>
              </div>
              <div className="saved-designs-scroll" style={{ maxHeight: 'none' }}>
                <table className="table saved-designs-table">
                  <tbody>
                    {playlists.map((playlist) => (
                      <tr key={playlist.id} style={{ cursor: 'pointer', backgroundColor: selectedPlaylist?.id === playlist.id ? 'var(--bg-tertiary)' : undefined, borderLeft: selectedPlaylist?.id === playlist.id ? '3px solid var(--primary-color)' : '3px solid transparent' }} onClick={() => loadPlaylist(playlist)}>
                        <td style={{ fontWeight: selectedPlaylist?.id === playlist.id ? 600 : 400 }}>
                          {renamingPlaylistId === playlist.id ? (
                            <input className="form-input" style={{ padding: '0.2rem 0.4rem', fontSize: '0.8rem', width: '100%' }} value={renamePlaylistValue} onChange={(e) => setRenamePlaylistValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleRenamePlaylist(playlist.id); if (e.key === 'Escape') setRenamingPlaylistId(null); }} onBlur={() => handleRenamePlaylist(playlist.id)} onClick={(e) => e.stopPropagation()} autoFocus />
                          ) : (
                            <>{playlist.name} <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{playlist.items.length} items</span></>
                          )}
                        </td>
                        <td style={{ width: '1px', whiteSpace: 'nowrap' }}>
                          <button className="btn-icon" style={{ padding: '0.2rem' }} title="Rename" onClick={(e) => { e.stopPropagation(); setRenamingPlaylistId(playlist.id); setRenamePlaylistValue(playlist.name); }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
                          </button>
                          <button className="btn-icon" style={{ padding: '0.2rem', color: 'var(--danger-color)' }} title="Delete" onClick={(e) => { e.stopPropagation(); deletePlaylist(playlist.id); }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={startNewPlaylist}>New Playlist</button>
          </div>

          {/* Right: Playlist Editor */}
          <div style={{ flex: 1 }}>
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">
                  {selectedPlaylist ? (
                    <input className="form-input" style={{ padding: '0.2rem 0.4rem', fontSize: '0.9rem', fontWeight: 600, background: 'transparent', border: '1px solid transparent', width: '200px' }} value={playlistName} onChange={(e) => setPlaylistName(e.target.value)} onFocus={(e) => e.target.style.borderColor = 'var(--border-color)'} onBlur={(e) => e.target.style.borderColor = 'transparent'} />
                  ) : 'New Playlist'}
                </h3>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <select className="form-select" style={{ width: 'auto', padding: '0.4rem 0.6rem', fontSize: '0.8rem' }} value={editingPlaylistMode} onChange={(e) => setEditingPlaylistMode(e.target.value as 'sequence' | 'random')}>
                    <option value="sequence">Sequential</option>
                    <option value="random">Random</option>
                  </select>
                  <button className="btn btn-primary btn-sm" onClick={() => savePlaylist()} disabled={editingPlaylistItems.length === 0}>Save</button>
                </div>
              </div>
              {editingPlaylistItems.length === 0 ? (
                <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '1.5rem 0' }}>Add designs from the list below to build your playlist.</p>
              ) : (
                <div className="playlist-items">
                  {editingPlaylistItems.map((item, idx) => (
                    <div key={idx} className={`playlist-item${dragPlaylistIdx === idx ? ' dragging' : ''}`} draggable onDragStart={() => handleDragStart(idx)} onDragOver={(e) => handleDragOver(e, idx)} onDragEnd={handleDragEnd}>
                      <span className="playlist-item-drag" title="Drag to reorder">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>
                      </span>
                      <span className="playlist-item-name">{item.design_name} <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>({item.design_type})</span></span>
                      <input type="number" className="form-input playlist-item-duration" value={item.duration} min="1" onChange={(e) => updateEditorItem(idx, 'duration', parseInt(e.target.value) || 1)} />
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>sec</span>
                      <select className="form-select" style={{ width: 'auto', padding: '0.4rem 0.5rem', fontSize: '0.8rem' }} value={item.transition} onChange={(e) => updateEditorItem(idx, 'transition', e.target.value)}>
                        <option value="cut">Cut</option>
                        <option value="fade">Fade</option>
                        <option value="fade_black">Fade to Black</option>
                      </select>
                      <button className="btn-icon" style={{ padding: '0.2rem', color: 'var(--danger-color)' }} title="Remove" onClick={() => removeItemFromEditor(idx)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="card">
              <div className="card-header"><h3 className="card-title">Add Design</h3></div>
              <table className="table saved-designs-table">
                <tbody>
                  {designs.map((design) => (
                    <tr key={design.id} style={{ cursor: 'pointer' }} onClick={() => addDesignToEditor(design.id)}>
                      <td>{design.name} <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginLeft: '0.5rem' }}>{design.type}</span></td>
                      <td style={{ width: '1px' }}><span style={{ color: 'var(--primary-color)', fontSize: '1.2rem', fontWeight: 600 }}>+</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}


      {/* Save As Modal */}
      {showSaveModal && (
        <div className="modal-overlay" onClick={() => setShowSaveModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Save Design</h3>
              <button className="modal-close" onClick={() => setShowSaveModal(false)}>
                &times;
              </button>
            </div>

            <div className="form-group">
              <label className="form-label">Design Name</label>
              <input
                type="text"
                className="form-input"
                value={saveAsName}
                onChange={(e) => setSaveAsName(e.target.value)}
                placeholder="Enter design name"
                autoFocus
              />
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowSaveModal(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleSaveAs}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Playlist Save Modal */}
      {showPlaylistSaveModal && (
        <div className="modal-overlay" onClick={() => setShowPlaylistSaveModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Save Playlist</h3>
              <button className="modal-close" onClick={() => setShowPlaylistSaveModal(false)}>
                &times;
              </button>
            </div>

            <div className="form-group">
              <label className="form-label">Playlist Name</label>
              <input
                type="text"
                className="form-input"
                value={playlistSaveName}
                onChange={(e) => setPlaylistSaveName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && playlistSaveName.trim()) savePlaylist(playlistSaveName); }}
                placeholder="Enter playlist name"
                autoFocus
              />
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowPlaylistSaveModal(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => savePlaylist(playlistSaveName)}
                disabled={!playlistSaveName.trim()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DesignPage;
