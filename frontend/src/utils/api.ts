import type {
  Wall,
  WallGroup,
  Light,
  Design,
  Playlist,
  PlaylistItemInput,
  PlaylistKind,
  Schedule,
  ArtNetConfig,
  LayoutData,
  EffectType,
  StaticDesignData,
  MotionDesignData,
  RGBW,
  FolderSummary,
  AiSceneResult,
} from '../types';

const API_BASE = '/api';

/** Where a playing playlist is: top-level item index, frames into it, and the design showing. */
export interface PlaylistPosition {
  itemIndex: number;
  itemFrame: number;
  itemFrames: number;
  designId: string;
  designFrame: number;
}

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

// Layout API
export const layoutAPI = {
  getWalls: () => fetchJSON<Wall[]>('/layout/walls'),

  getLayout: () => fetchJSON<LayoutData>('/layout/layout'),

  updateWall: (id: string, data: Partial<Wall>) =>
    fetchJSON<{ success: boolean }>(`/layout/walls/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  createWall: (data: Omit<Wall, 'id'>) =>
    fetchJSON<Wall>('/layout/walls', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deleteWall: (id: string) =>
    fetchJSON<{ success: boolean }>(`/layout/walls/${id}`, {
      method: 'DELETE',
    }),

  updateLight: (id: string, data: Partial<Light>) =>
    fetchJSON<{ success: boolean }>(`/layout/lights/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  createLight: (data: Omit<Light, 'id'>) =>
    fetchJSON<Light>('/layout/lights', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deleteLight: (id: string) =>
    fetchJSON<{ success: boolean }>(`/layout/lights/${id}`, {
      method: 'DELETE',
    }),

  reorderWalls: (wallIds: string[]) =>
    fetchJSON<{ success: boolean }>('/layout/walls/reorder', {
      method: 'POST',
      body: JSON.stringify({ wallIds }),
    }),

  getGroups: () => fetchJSON<WallGroup[]>('/layout/groups'),

  createGroup: (data: { name: string }) =>
    fetchJSON<WallGroup>('/layout/groups', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateGroup: (id: string, data: { name: string }) =>
    fetchJSON<{ success: boolean }>(`/layout/groups/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deleteGroup: (id: string) =>
    fetchJSON<{ success: boolean }>(`/layout/groups/${id}`, {
      method: 'DELETE',
    }),
};

// Designs API
export const designsAPI = {
  getAll: (type?: string) =>
    fetchJSON<Design[]>(`/designs${type ? `?type=${type}` : ''}`),

  get: (id: string) => fetchJSON<Design>(`/designs/${id}`),

  create: (data: { name: string; type: string; data: StaticDesignData | MotionDesignData; folder?: string | null }) =>
    fetchJSON<Design>('/designs', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: { name: string; data: StaticDesignData | MotionDesignData; folder?: string | null }) =>
    fetchJSON<{ success: boolean }>(`/designs/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  // Only changes the folder (null: unfiled)
  move: (id: string, folder: string | null) =>
    fetchJSON<{ success: boolean; folder: string | null }>(`/designs/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ folder }),
    }),

  copy: (id: string, name?: string) =>
    fetchJSON<Design>(`/designs/${id}/copy`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  delete: (id: string) =>
    fetchJSON<{ success: boolean }>(`/designs/${id}`, {
      method: 'DELETE',
    }),

  getEffectTypes: () => fetchJSON<EffectType[]>('/designs/effects/types'),
};

// Playlists API
export const playlistsAPI = {
  // Playlists and scenes; pass a kind for only one of them
  getAll: (kind?: PlaylistKind) => fetchJSON<Playlist[]>(kind ? `/playlists?kind=${kind}` : '/playlists'),

  get: (id: string) => fetchJSON<Playlist>(`/playlists/${id}`),

  create: (data: { name: string; play_mode?: string; kind?: PlaylistKind; items?: PlaylistItemInput[]; folder?: string | null }) =>
    fetchJSON<Playlist>('/playlists', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: { name: string; play_mode: string; kind?: PlaylistKind; items?: PlaylistItemInput[]; folder?: string | null }) =>
    fetchJSON<{ success: boolean }>(`/playlists/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  // Only changes the folder (null: unfiled)
  move: (id: string, folder: string | null) =>
    fetchJSON<{ success: boolean; folder: string | null }>(`/playlists/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ folder }),
    }),

  // AI Scene Creator: plans and saves a scene (and its new designs) in `folder`, or in a folder
  // named after the scene
  aiGenerate: (data: { description: string; folder?: string | null; considerDefective?: boolean }) =>
    fetchJSON<AiSceneResult>('/playlists/ai/generate', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Discards a generated scene and the designs it created (those nothing else uses)
  aiUndo: (id: string, designIds: string[]) =>
    fetchJSON<{ success: boolean; deletedDesignIds: string[]; keptDesignIds: string[] }>(`/playlists/${id}/ai-undo`, {
      method: 'POST',
      body: JSON.stringify({ designIds }),
    }),

  // Items stay; a playlist can only become a scene when it holds designs only
  convert: (id: string, kind: PlaylistKind) =>
    fetchJSON<Playlist>(`/playlists/${id}/convert`, {
      method: 'POST',
      body: JSON.stringify({ kind }),
    }),

  delete: (id: string) =>
    fetchJSON<{ success: boolean }>(`/playlists/${id}`, {
      method: 'DELETE',
    }),

  addItem: (playlistId: string, data: PlaylistItemInput) =>
    fetchJSON(`/playlists/${playlistId}/items`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  removeItem: (playlistId: string, itemId: string) =>
    fetchJSON<{ success: boolean }>(`/playlists/${playlistId}/items/${itemId}`, {
      method: 'DELETE',
    }),

  reorder: (playlistId: string, itemIds: string[]) =>
    fetchJSON<{ success: boolean }>(`/playlists/${playlistId}/reorder`, {
      method: 'POST',
      body: JSON.stringify({ itemIds }),
    }),
};

// Folders: labels shared by designs, scenes and playlists
export const foldersAPI = {
  getAll: () => fetchJSON<FolderSummary[]>('/folders'),

  // Renaming onto an existing folder merges the two
  rename: (name: string, newName: string) =>
    fetchJSON<{ name: string; merged: boolean; moved: number }>(`/folders/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ name: newName }),
    }),

  // Everything in it becomes unfiled
  delete: (name: string) =>
    fetchJSON<{ success: boolean; moved: number }>(`/folders/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
};

// Schedules API
export const schedulesAPI = {
  getAll: () => fetchJSON<Schedule[]>('/schedules'),

  getDefault: () => fetchJSON<Schedule | null>('/schedules/default'),

  getActive: () => fetchJSON<Schedule | null>('/schedules/active'),

  setDefault: (data: { design_id?: string; playlist_id?: string; design_type: string }) =>
    fetchJSON<Schedule>('/schedules/default', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  create: (data: {
    design_id?: string;
    playlist_id?: string;
    design_type: string;
    start_date: string;
    end_date: string;
    start_time?: string;
    end_time?: string;
    priority?: number;
  }) =>
    fetchJSON<Schedule>('/schedules', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Partial<Schedule>) =>
    fetchJSON<{ success: boolean }>(`/schedules/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    fetchJSON<{ success: boolean }>(`/schedules/${id}`, {
      method: 'DELETE',
    }),
};

// ArtNet API
export const artnetAPI = {
  getConfig: () => fetchJSON<ArtNetConfig>('/artnet/config'),

  updateConfig: (config: ArtNetConfig) =>
    fetchJSON<{ success: boolean }>('/artnet/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  getStatus: () => fetchJSON<{ running: boolean; dmxData: number[] | null }>('/artnet/status'),

  test: () =>
    fetchJSON<{ success: boolean; message: string }>('/artnet/test', {
      method: 'POST',
    }),
};

// AI Designer API
export const aiAPI = {
  getStatus: () => fetchJSON<{ enabled: boolean }>('/designs/ai/status'),

  generate: (options: {
    description: string;
    // Design around dead channels (default true); false treats every channel as working
    considerDefective?: boolean;
    baseDesignId?: string;
    mode?: 'create' | 'modify' | 'derivative';
    currentDesignData?: {
      type: string;
      effect?: string;
      colors?: RGBW[] | Record<number, RGBW>;
      speed?: number;
      scope?: string;
      params?: Record<string, unknown>;
    };
  }) =>
    fetchJSON<{
      success: boolean;
      design?: {
        type: 'static' | 'motion';
        name: string;
        // Static: array indexed by light_id - 1, or a map keyed by light_id. Motion: palette array.
        colors?: RGBW[] | Record<number, RGBW>;
        effect?: string;
        speed?: number;
        scope?: string;
        params?: Record<string, unknown>;
      };
      designId?: string;
      error?: string;
    }>('/designs/ai/generate', {
      method: 'POST',
      body: JSON.stringify(options),
    }),
};

// Preview API
export const previewAPI = {
  // previewInfo (newer backends): what the preview shows, live or WebSocket-only
  getStatus: () => fetchJSON<{
    isLivePreview: boolean;
    hasPreview: boolean;
    livePreviewInfo: { type: string; effectType?: string; playlist?: PlaylistPosition | null } | null;
    previewInfo?: { type: string; live: boolean; playlist?: PlaylistPosition | null } | null;
  }>('/preview/status'),

  start: (data: { designId?: string; designType?: string; designData?: unknown; live?: boolean }) =>
    fetchJSON<{ success: boolean }>('/preview/start', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // A saved playlist (playlistId), or the editor's unsaved items; startIndex starts at that item.
  // live=false previews on the WebSocket only.
  startPlaylist: (data: { playlistId?: string; items?: PlaylistItemInput[]; play_mode?: string; startIndex?: number; live: boolean }) =>
    fetchJSON<{ success: boolean }>('/preview/playlist', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  stop: () =>
    fetchJSON<{ success: boolean }>('/preview/stop', {
      method: 'POST',
    }),

  clearSoft: () =>
    fetchJSON<{ success: boolean }>('/preview/clear-soft', {
      method: 'POST',
    }),

  previewLights: (lights: { light_id: number; r: number; g: number; b: number; w: number }[]) =>
    fetchJSON<{ success: boolean }>('/preview/lights', {
      method: 'POST',
      body: JSON.stringify({ lights }),
    }),

  previewEffect: (data: { effectType: string; colors: RGBW[]; params?: Record<string, unknown>; speed?: number; scope?: string; live?: boolean }) =>
    fetchJSON<{ success: boolean }>('/preview/effect', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// Health (served outside /api). timeZone is optional: newer backends report the
// zone schedules are evaluated in.
export const healthAPI = {
  get: async (): Promise<{ status: string; version?: string; commit?: string; builtAt?: string | null; uptime?: string; timeZone?: string }> => {
    const response = await fetch('/health');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },
};
