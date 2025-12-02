import type {
  Wall,
  Light,
  Design,
  Playlist,
  Schedule,
  ArtNetConfig,
  LayoutData,
  EffectType,
  StaticDesignData,
  MotionDesignData,
  RGBW,
} from '../types';

const API_BASE = '/api';

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
};

// Designs API
export const designsAPI = {
  getAll: (type?: string) =>
    fetchJSON<Design[]>(`/designs${type ? `?type=${type}` : ''}`),

  get: (id: string) => fetchJSON<Design>(`/designs/${id}`),

  create: (data: { name: string; type: string; data: StaticDesignData | MotionDesignData }) =>
    fetchJSON<Design>('/designs', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: { name: string; data: StaticDesignData | MotionDesignData }) =>
    fetchJSON<{ success: boolean }>(`/designs/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
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
  getAll: () => fetchJSON<Playlist[]>('/playlists'),

  get: (id: string) => fetchJSON<Playlist>(`/playlists/${id}`),

  create: (data: { name: string; play_mode?: string; items?: { design_id: string; duration: number }[] }) =>
    fetchJSON<Playlist>('/playlists', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: { name: string; play_mode: string; items?: { design_id: string; duration: number }[] }) =>
    fetchJSON<{ success: boolean }>(`/playlists/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    fetchJSON<{ success: boolean }>(`/playlists/${id}`, {
      method: 'DELETE',
    }),

  addItem: (playlistId: string, data: { design_id: string; duration: number }) =>
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

// Preview API
export const previewAPI = {
  getStatus: () => fetchJSON<{ isLivePreview: boolean }>('/preview/status'),

  start: (data: { designId?: string; designType?: string; designData?: unknown }) =>
    fetchJSON<{ success: boolean }>('/preview/start', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  startPlaylist: (playlistId: string) =>
    fetchJSON<{ success: boolean }>('/preview/playlist', {
      method: 'POST',
      body: JSON.stringify({ playlistId }),
    }),

  stop: () =>
    fetchJSON<{ success: boolean }>('/preview/stop', {
      method: 'POST',
    }),

  previewLights: (lights: { light_id: number; r: number; g: number; b: number; w: number }[]) =>
    fetchJSON<{ success: boolean }>('/preview/lights', {
      method: 'POST',
      body: JSON.stringify({ lights }),
    }),

  previewEffect: (data: { effectType: string; colors: RGBW[]; params?: Record<string, unknown>; speed?: number; scope?: string }) =>
    fetchJSON<{ success: boolean }>('/preview/effect', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};
