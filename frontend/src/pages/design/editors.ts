import { useEffect, useState, type DragEvent } from 'react';
import { designsAPI, playlistsAPI } from '../../utils/api';
import type { PreviewControls } from '../../hooks/usePreview';
import type { Design, EffectType, MotionDesignData, Playlist, PlaylistItemInput, PlaylistKind, RepeatMode, RGBW, StaticDesignData, Wall } from '../../types';
import type { ColorTool } from './ColorPicker';

export interface EditorDeps {
  preview: PreviewControls;
  reload: () => Promise<void>;
  setError: (message: string) => void;
  // Auto-preview edits (debounced) only while this editor's tab is visible
  autoPreview: boolean;
}

const errorMessage = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

// ---------------------------------------------------------------------------
// Static designs
// ---------------------------------------------------------------------------

export function useStaticEditor({ preview, reload, setError, autoPreview }: EditorDeps) {
  const [selectedDesign, setSelectedDesign] = useState<Design | null>(null);
  const [colors, setColors] = useState<Record<number, RGBW>>({});
  const [prompt, setPrompt] = useState('');
  const [savedJson, setSavedJson] = useState('{}');
  const [colorTool, setColorTool] = useState<ColorTool>('apply');

  const hasChanges = JSON.stringify(colors) !== savedJson;

  // Debounced auto-preview of edits (always WS; ArtNet too when live preview is on).
  // Empty designs are skipped so just opening the page doesn't blank the preview;
  // New/Clear send their blank frame explicitly.
  const { send } = preview;
  useEffect(() => {
    if (!autoPreview || Object.keys(colors).length === 0) return;
    const timeout = setTimeout(() => send({ kind: 'static', colors }), 200);
    return () => clearTimeout(timeout);
  }, [autoPreview, colors, send]);

  const load = (design: Design) => {
    if (!design.data) {
      setError(`Design "${design.name}" can't be loaded: ${design.dataError || 'its data is corrupt'}`);
      return;
    }
    const data = design.data as StaticDesignData;
    const next = data.colors || {};
    setSelectedDesign(design);
    setColors(next);
    setPrompt(data.prompt || '');
    setSavedJson(JSON.stringify(next));
    send({ kind: 'static', colors: next });
  };

  // New (deselect) and Clear: blank the editor and the preview — including the
  // physical lights when live preview is on
  const reset = () => {
    setSelectedDesign(null);
    setColors({});
    setPrompt('');
    setSavedJson('{}');
  };
  const startNew = () => {
    reset();
    send({ kind: 'static', colors: {} });
  };

  const cancel = () => {
    const saved = JSON.parse(savedJson) as Record<number, RGBW>;
    setColors(saved);
    send({ kind: 'static', colors: saved });
  };

  const designData = (): StaticDesignData => ({ colors, ...(prompt ? { prompt } : {}) });

  const save = async () => {
    if (!selectedDesign) return;
    try {
      await designsAPI.update(selectedDesign.id, { name: selectedDesign.name, data: designData() });
      setSavedJson(JSON.stringify(colors));
      await reload();
    } catch (err) {
      setError(errorMessage(err, 'Failed to save design'));
    }
  };

  const saveAs = async (name: string): Promise<boolean> => {
    try {
      const created = await designsAPI.create({ name, type: 'static', data: designData() });
      // Select the copy so the next Save updates it, not the original
      setSelectedDesign(created);
      setSavedJson(JSON.stringify(colors));
      await reload();
      return true;
    } catch (err) {
      setError(errorMessage(err, 'Failed to save design'));
      return false;
    }
  };

  // Paint one or more lights
  const paint = (lightIds: Iterable<number>, color: RGBW) => {
    setColors((prev) => {
      const next = { ...prev };
      for (const id of lightIds) next[id] = { ...color };
      return next;
    });
  };

  const copyWall = (fromWall: Wall, toWall: Wall) => {
    const fromMatrix = fromWall.matrix;
    const toMatrix = toWall.matrix;
    if (!fromMatrix || !toMatrix) return;
    setColors((prev) => {
      const next = { ...prev };
      // Copy colors based on relative position
      for (let y = 0; y < Math.min(fromWall.height, toWall.height); y++) {
        for (let x = 0; x < Math.min(fromWall.width, toWall.width); x++) {
          const fromLight = fromMatrix[y]?.[x];
          const toLight = toMatrix[y]?.[x];
          if (fromLight && toLight && prev[fromLight.light_id]) {
            next[toLight.light_id] = { ...prev[fromLight.light_id] };
          }
        }
      }
      return next;
    });
  };

  // AI result. asNew: a freshly generated (unsaved) design rather than an edit.
  const applyGenerated = (next: Record<number, RGBW>, nextPrompt: string, asNew: boolean) => {
    if (asNew) {
      setSelectedDesign(null);
      setSavedJson('{}');
    }
    setColors(next);
    setPrompt(nextPrompt);
    send({ kind: 'static', colors: next });
  };

  return {
    selectedDesign, setSelectedDesign, colors, prompt, hasChanges, colorTool, setColorTool,
    load, reset, startNew, cancel, save, saveAs, paint, copyWall, applyGenerated,
  };
}

export type StaticEditor = ReturnType<typeof useStaticEditor>;

// ---------------------------------------------------------------------------
// Motion designs
// ---------------------------------------------------------------------------

type MotionParams = Record<string, number | boolean | string | string[] | number[]>;
type MotionScope = 'all' | 'wall' | 'group';

interface MotionState {
  effect: EffectType | null;
  colors: RGBW[];
  speed: number;
  scope: MotionScope;
  params: MotionParams;
}

const EMPTY_MOTION: MotionState = { effect: null, colors: [], speed: 1, scope: 'all', params: {} };

// Per Wall wall ids only mean something with the Per Wall scope. They stay in the editor state
// (so flipping the scope away and back keeps the selection) but aren't compared, previewed or saved.
const withoutStaleWallIds = (scope: MotionScope, params: MotionParams): MotionParams => {
  if (scope === 'wall' || !('wallIds' in params)) return params;
  const rest = { ...params };
  delete rest.wallIds;
  return rest;
};

const motionSnapshot = (s: MotionState) =>
  JSON.stringify({ effect: s.effect?.type, colors: s.colors, speed: s.speed, params: withoutStaleWallIds(s.scope, s.params), scope: s.scope });

/** Effects whose colors are a free-length palette (a hint but no per-swatch names) */
export const isPaletteEffect = (fx: EffectType) => !fx.colorLabels && !!fx.colorHint;
export const MIN_PALETTE_COLORS = 1;
export const MAX_PALETTE_COLORS = 16;

const WHITE: RGBW = { r: 0, g: 0, b: 0, w: 255 };

const effectDefaults = (fx: EffectType): MotionParams => {
  const defaults: MotionParams = {};
  Object.entries(fx.params).forEach(([key, param]) => { defaults[key] = param.default; });
  return defaults;
};

// Saved colors, padded with the effect's defaults for swatches added after the design was saved
// (e.g. Meet in the Middle's Meet color). Palettes keep whatever length was saved.
const withDefaultColors = (fx: EffectType, saved: RGBW[] | undefined): RGBW[] => {
  const base = saved && saved.length > 0 ? saved : fx.defaultColors;
  if (isPaletteEffect(fx)) return [...base];
  return [...base, ...fx.defaultColors.slice(base.length)];
};

// Builds editor state from saved/generated data, filling in anything the effect gained since
const buildMotionState = (fx: EffectType, data: { colors?: RGBW[]; speed?: number; scope?: string; params?: MotionParams }): MotionState => ({
  effect: fx,
  colors: withDefaultColors(fx, data.colors),
  speed: data.speed || 1,
  scope: (data.scope as MotionScope) || 'all',
  params: { ...effectDefaults(fx), ...(data.params || {}) },
});

export function useMotionEditor({ preview, reload, setError, autoPreview, effectTypes }: EditorDeps & { effectTypes: EffectType[] }) {
  const [selectedDesign, setSelectedDesign] = useState<Design | null>(null);
  const [state, setState] = useState<MotionState>(EMPTY_MOTION);
  const [selectedColorIdx, setSelectedColorIdx] = useState(0);
  const [savedJson, setSavedJson] = useState('{}');

  const { effect, colors, speed, scope, params } = state;
  const hasChanges = motionSnapshot(state) !== savedJson;

  const { send } = preview;
  const sendState = (s: MotionState) => {
    if (!s.effect) return;
    send({ kind: 'effect', effectType: s.effect.type, colors: s.colors, params: withoutStaleWallIds(s.scope, s.params), speed: s.speed, scope: s.scope });
  };

  // Debounced auto-preview of edits
  useEffect(() => {
    if (!autoPreview || !effect) return;
    const timeout = setTimeout(() => {
      send({ kind: 'effect', effectType: effect.type, colors, params: withoutStaleWallIds(scope, params), speed, scope });
    }, 200);
    return () => clearTimeout(timeout);
  }, [autoPreview, effect, colors, params, speed, scope, send]);

  // Replace the whole editor state; returns the first palette color (for the picker)
  const replace = (next: MotionState, saved: boolean): RGBW | undefined => {
    setState(next);
    setSelectedColorIdx(0);
    setSavedJson(saved ? motionSnapshot(next) : '{}');
    sendState(next);
    return next.colors[0];
  };

  const selectEffect = (fx: EffectType) => {
    setSelectedDesign(null);
    return replace({ effect: fx, colors: [...fx.defaultColors], speed: fx.defaultSpeed ?? 1, scope: 'all', params: effectDefaults(fx) }, true);
  };

  // Fills in params and colors added to the effect after the design was saved, so the controls match what renders
  const fromDesignData = (data: MotionDesignData): MotionState | null => {
    const fx = effectTypes.find((e) => e.type === data.type);
    if (!fx) return null;
    return buildMotionState(fx, { ...data, params: data.params as MotionParams | undefined });
  };

  const load = (design: Design) => {
    if (!design.data) {
      setError(`Design "${design.name}" can't be loaded: ${design.dataError || 'its data is corrupt'}`);
      return undefined;
    }
    setSelectedDesign(design);
    const next = fromDesignData(design.data as MotionDesignData);
    return next ? replace(next, true) : undefined;
  };

  // New / Clear: empty editor and stop the preview (also ends live preview)
  const clear = () => {
    setSelectedDesign(null);
    setState(EMPTY_MOTION);
    setSavedJson('{}');
    preview.stop();
  };

  // Back to the last saved state; returns the restored selected color (for the picker)
  const cancel = (): RGBW | undefined => {
    const saved = JSON.parse(savedJson) as { effect?: string; colors?: RGBW[]; speed?: number; scope?: MotionScope; params?: MotionParams };
    const fx = saved.effect ? effectTypes.find((e) => e.type === saved.effect) : undefined;
    if (!fx) return undefined;
    const next: MotionState = {
      effect: fx,
      colors: saved.colors || fx.defaultColors,
      speed: saved.speed || 1,
      scope: saved.scope || 'all',
      params: saved.params || {},
    };
    // A palette may have been longer before the cancelled edits
    const idx = Math.min(selectedColorIdx, Math.max(0, next.colors.length - 1));
    setState(next);
    setSelectedColorIdx(idx);
    sendState(next);
    return next.colors[idx];
  };

  const designData = (): MotionDesignData | null =>
    effect ? { type: effect.type, colors, params: withoutStaleWallIds(scope, params), speed, scope } : null;

  const save = async () => {
    const data = designData();
    if (!selectedDesign || !data) return;
    try {
      await designsAPI.update(selectedDesign.id, { name: selectedDesign.name, data });
      setSavedJson(motionSnapshot(state));
      await reload();
    } catch (err) {
      setError(errorMessage(err, 'Failed to save design'));
    }
  };

  const saveAs = async (name: string): Promise<boolean> => {
    const data = designData();
    if (!data) return false;
    try {
      const created = await designsAPI.create({ name, type: 'motion', data });
      // Select the copy so the next Save updates it, not the original
      setSelectedDesign(created);
      setSavedJson(motionSnapshot(state));
      await reload();
      return true;
    } catch (err) {
      setError(errorMessage(err, 'Failed to save design'));
      return false;
    }
  };

  const setColorAt = (idx: number, color: RGBW) => {
    setState((s) => {
      if (idx >= s.colors.length) return s;
      const next = [...s.colors];
      next[idx] = color;
      return { ...s, colors: next };
    });
  };

  // Palette effects: append a copy of the last color and select it; returns it (for the picker)
  const addColor = (): RGBW | undefined => {
    if (!effect || !isPaletteEffect(effect) || colors.length >= MAX_PALETTE_COLORS) return undefined;
    const added = { ...(colors[colors.length - 1] ?? WHITE) };
    setState((s) => ({ ...s, colors: [...s.colors, added] }));
    setSelectedColorIdx(colors.length);
    return added;
  };

  // Palette effects: remove the selected color; returns the newly selected one (for the picker)
  const removeColor = (): RGBW | undefined => {
    if (!effect || !isPaletteEffect(effect) || colors.length <= MIN_PALETTE_COLORS) return undefined;
    const idx = Math.min(selectedColorIdx, colors.length - 1);
    const next = colors.filter((_, i) => i !== idx);
    const nextIdx = Math.min(idx, next.length - 1);
    setState((s) => ({ ...s, colors: next }));
    setSelectedColorIdx(nextIdx);
    return next[nextIdx];
  };

  const setSpeed = (v: number) => setState((s) => ({ ...s, speed: v }));
  const setScope = (v: MotionScope) => setState((s) => ({ ...s, scope: v }));
  const setParam = (key: string, v: number | boolean | string | string[] | number[]) => setState((s) => ({ ...s, params: { ...s.params, [key]: v } }));

  // AI result. asNew: freshly generated (unsaved) rather than an edit of the current design.
  const applyGenerated = (data: { effect?: string; colors?: RGBW[]; speed?: number; scope?: string; params?: MotionParams }, asNew: boolean) => {
    const fx = effectTypes.find((e) => e.type === data.effect);
    if (!fx) return undefined;
    if (asNew) setSelectedDesign(null);
    const next = buildMotionState(fx, data);
    setState(next);
    setSelectedColorIdx(0);
    if (asNew) setSavedJson('{}');
    sendState(next);
    return next.colors[0];
  };

  return {
    selectedDesign, setSelectedDesign, effect, colors, speed, scope, params, selectedColorIdx, setSelectedColorIdx, hasChanges,
    selectEffect, load, clear, cancel, save, saveAs, setColorAt, addColor, removeColor, setSpeed, setScope, setParam, applyGenerated,
  };
}

export type MotionEditor = ReturnType<typeof useMotionEditor>;

// ---------------------------------------------------------------------------
// Playlists and scenes
// ---------------------------------------------------------------------------

// Scenes and playlists share one editor. A scene holds designs only and always plays in order;
// a playlist can also hold scenes and other playlists.
export const playlistKind = (p: Pick<Playlist, 'kind'>): PlaylistKind => p.kind ?? 'playlist';
export const KIND_LABEL: Record<PlaylistKind, string> = { playlist: 'Playlist', scene: 'Scene' };

export interface EditingPlaylistItem {
  key: string; // stable client-side identity (for React keys during drag reorder)
  // Exactly one of these is set: the item plays a design or a nested playlist
  design_id: string | null;
  child_playlist_id: string | null;
  name?: string;
  design_type?: string;
  duration: number;
  repeat_mode: RepeatMode;
  repeat_count: number;
  transition: string;
}

let nextItemKey = 0;
const newItemKey = () => `item-${++nextItemKey}`;

export const MAX_REPEAT_COUNT = 1000;

/** "≈ 12.5 s", "≈ 2 min 5 s", "≈ 1 h 10 min" */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `≈ ${Math.round(seconds * 10) / 10} s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60), sec = Math.round(seconds - m * 60);
    return sec ? `≈ ${m} min ${sec} s` : `≈ ${m} min`;
  }
  const h = Math.floor(seconds / 3600), m = Math.round((seconds - h * 3600) / 60);
  return m ? `≈ ${h} h ${m} min` : `≈ ${h} h`;
}

/** True when `childId` is `parentId` or contains it at any depth (so it can't be added to it). */
function containsPlaylist(playlists: Playlist[], childId: string, parentId: string): boolean {
  const seen = new Set<string>();
  const todo = [childId];
  while (todo.length > 0) {
    const id = todo.pop()!;
    if (id === parentId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const item of playlists.find((p) => p.id === id)?.items ?? []) {
      if (item.child_playlist_id) todo.push(item.child_playlist_id);
    }
  }
  return false;
}

/**
 * Editor for one kind. `playlists` is every playlist and scene (nested lengths and loop checks
 * need them all); the editor's own saved list is `saved`.
 */
export function usePlaylistEditor({ reload, setError, designs, playlists, kind }: Omit<EditorDeps, 'preview' | 'autoPreview'> & { designs: Design[]; playlists: Playlist[]; kind: PlaylistKind }) {
  const isScene = kind === 'scene';
  const noun = isScene ? 'scene' : 'playlist';
  const saved = playlists.filter((p) => playlistKind(p) === kind);
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [name, setName] = useState('');
  const [items, setItems] = useState<EditingPlaylistItem[]>([]);
  const [mode, setMode] = useState<'sequence' | 'random'>('sequence');
  const [dragKey, setDragKey] = useState<string | null>(null);

  const startNew = () => {
    setSelectedPlaylist(null);
    setItems([]);
    setMode('sequence');
    setName('');
  };

  const load = (playlist: Playlist) => {
    setSelectedPlaylist(playlist);
    setItems(playlist.items.map((i) => ({
      key: i.id || newItemKey(),
      design_id: i.design_id,
      child_playlist_id: i.child_playlist_id ?? null,
      name: (i.child_playlist_id ? i.child_playlist_name : i.design_name) ?? undefined,
      design_type: i.design_type ?? undefined,
      duration: i.duration,
      repeat_mode: i.repeat_mode === 'times' ? 'times' : 'seconds',
      repeat_count: i.repeat_count || 1,
      transition: i.transition || 'cut',
    })));
    setMode(isScene ? 'sequence' : playlist.play_mode);
    setName(playlist.name);
  };

  const designCycle = (designId: string | null): number | null => {
    const design = designs.find((d) => d.id === designId);
    return design?.type === 'motion' && design.cycleSeconds ? design.cycleSeconds : null;
  };

  // In a scene a design plays one complete cycle when it has one; otherwise (and in playlists)
  // it plays for 10 seconds
  const addDesign = (designId: string) => {
    const design = designs.find((d) => d.id === designId);
    if (!design) return;
    const once = isScene && designCycle(designId) !== null;
    setItems((prev) => [...prev, {
      key: newItemKey(),
      design_id: designId,
      child_playlist_id: null,
      name: design.name,
      design_type: design.type,
      duration: 10,
      repeat_mode: once ? 'times' : 'seconds',
      repeat_count: 1,
      transition: 'cut',
    }]);
  };

  // Nested playlists and scenes default to playing through once
  const addPlaylist = (playlistId: string) => {
    const playlist = playlists.find((p) => p.id === playlistId);
    if (!playlist || !canAddPlaylist(playlistId)) return;
    setItems((prev) => [...prev, {
      key: newItemKey(),
      design_id: null,
      child_playlist_id: playlistId,
      name: playlist.name,
      duration: 10,
      repeat_mode: 'times',
      repeat_count: 1,
      transition: 'cut',
    }]);
  };

  /**
   * Saved playlists and scenes that can go into this one: not itself, and none that already
   * contain it. Scenes take designs only.
   */
  const canAddPlaylist = (playlistId: string) =>
    !isScene && (!selectedPlaylist || !containsPlaylist(playlists, playlistId, selectedPlaylist.id));
  const addablePlaylists = playlists.filter((p) => canAddPlaylist(p.id));

  /**
   * Seconds one "time" of an item takes: a motion design's effect cycle, or a nested playlist's
   * total. null when the item can only play for seconds (static designs, effects with no cycle).
   */
  const cycleSeconds = (item: EditingPlaylistItem): number | null => {
    if (item.child_playlist_id) {
      const total = playlists.find((p) => p.id === item.child_playlist_id)?.totalSeconds;
      return total && total > 0 ? total : null;
    }
    return designCycle(item.design_id);
  };
  // Times mode only counts when there's a cycle to count; otherwise the item plays its seconds
  const effectiveMode = (item: EditingPlaylistItem): RepeatMode =>
    item.repeat_mode === 'times' && cycleSeconds(item) !== null ? 'times' : 'seconds';
  const itemSeconds = (item: EditingPlaylistItem): number => {
    const cycle = cycleSeconds(item);
    return effectiveMode(item) === 'times' && cycle !== null ? cycle * item.repeat_count : Math.max(1, item.duration);
  };
  const totalSeconds = items.reduce((sum, i) => sum + itemSeconds(i), 0);

  const removeItem = (key: string) => setItems((prev) => prev.filter((i) => i.key !== key));

  const updateItem = (key: string, field: 'duration' | 'transition' | 'repeat_mode' | 'repeat_count', value: number | string) => {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, [field]: value } : i)));
  };

  const payloadItems = (): PlaylistItemInput[] => items.map((i) => ({
    design_id: i.design_id,
    child_playlist_id: i.child_playlist_id,
    duration: i.duration,
    repeat_mode: effectiveMode(i),
    repeat_count: i.repeat_count,
    transition: i.transition,
  }));

  /** Saves; returns 'needs-name' for a new playlist/scene without a name. */
  const save = async (nameOverride?: string): Promise<'saved' | 'needs-name' | 'failed'> => {
    if (items.length === 0) return 'failed';
    try {
      if (selectedPlaylist) {
        await playlistsAPI.update(selectedPlaylist.id, {
          name: name || selectedPlaylist.name,
          play_mode: isScene ? 'sequence' : mode,
          kind,
          items: payloadItems(),
        });
      } else {
        const newName = nameOverride?.trim();
        if (!newName) return 'needs-name';
        const created = await playlistsAPI.create({ name: newName, play_mode: isScene ? 'sequence' : mode, kind, items: payloadItems() });
        setSelectedPlaylist(created);
        setName(newName);
      }
      await reload();
      return 'saved';
    } catch (err) {
      setError(errorMessage(err, `Failed to save ${noun}`));
      return 'failed';
    }
  };

  const remove = async (playlistId: string) => {
    if (!confirm(`Are you sure you want to delete this ${noun}?`)) return;
    try {
      await playlistsAPI.delete(playlistId);
      if (selectedPlaylist?.id === playlistId) startNew();
      await reload();
    } catch (err) {
      setError(errorMessage(err, `Failed to delete ${noun}`));
    }
  };

  const rename = async (playlistId: string, newName: string) => {
    try {
      const playlist = playlists.find((p) => p.id === playlistId);
      if (!playlist) return;
      await playlistsAPI.update(playlistId, { name: newName, play_mode: playlist.play_mode });
      if (selectedPlaylist?.id === playlistId) {
        setSelectedPlaylist({ ...selectedPlaylist, name: newName });
        setName(newName);
      }
      await reload();
    } catch (err) {
      setError(errorMessage(err, `Failed to rename ${noun}`));
    }
  };

  // Drag reorder: items move live while dragging over others
  const dragStart = (key: string) => setDragKey(key);
  const dragOver = (e: DragEvent, overKey: string) => {
    e.preventDefault();
    if (dragKey === null || dragKey === overKey) return;
    setItems((prev) => {
      const from = prev.findIndex((i) => i.key === dragKey);
      const to = prev.findIndex((i) => i.key === overKey);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [dragged] = next.splice(from, 1);
      next.splice(to, 0, dragged);
      return next;
    });
  };
  const dragEnd = () => setDragKey(null);

  // Keyboard alternative to drag reorder
  const moveItem = (key: string, delta: -1 | 1) => {
    setItems((prev) => {
      const from = prev.findIndex((i) => i.key === key);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  return {
    kind, isScene, noun, saved,
    selectedPlaylist, name, setName, items, mode, setMode, dragKey,
    addablePlaylists, cycleSeconds, effectiveMode, itemSeconds, totalSeconds,
    startNew, load, addDesign, addPlaylist, removeItem, updateItem, save, remove, rename, dragStart, dragOver, dragEnd, moveItem,
  };
}

export type PlaylistEditor = ReturnType<typeof usePlaylistEditor>;
