export interface RGBW {
  r: number;
  g: number;
  b: number;
  w: number;
}

export interface Light {
  id: string;
  wall_id: string;
  matrix_x: number;
  matrix_y: number;
  light_id: number;
  light_type: 'RGB' | 'RGBW';
  dmx_start_channel: number;
}

export interface Wall {
  id: string;
  name: string;
  width: number;
  height: number;
  position: number;
  connects_to_next: boolean;
  lights?: Light[];
  matrix?: Light[][];
}

export interface Design {
  id: string;
  name: string;
  type: 'static' | 'motion';
  data: StaticDesignData | MotionDesignData;
  created_at?: string;
  updated_at?: string;
}

export interface StaticDesignData {
  colors: Record<number, RGBW>;
}

export interface MotionDesignData {
  type: string;
  colors: RGBW[];
  speed: number;
  scope: 'wall' | 'all';
  wallIds?: string[];
  params?: Record<string, unknown>;
}

export interface EffectType {
  type: string;
  name: string;
  description: string;
  defaultColors: RGBW[];
  params: Record<string, EffectParam>;
}

export interface EffectParam {
  type: 'number' | 'boolean';
  default: number | boolean;
  min?: number;
  max?: number;
  step?: number;
}

export interface Playlist {
  id: string;
  name: string;
  play_mode: 'sequence' | 'random';
  items: PlaylistItem[];
  created_at?: string;
  updated_at?: string;
}

export interface PlaylistItem {
  id: string;
  playlist_id: string;
  design_id: string;
  design_name?: string;
  design_type?: string;
  duration: number;
  position: number;
}

export interface Schedule {
  id: string;
  design_id: string | null;
  playlist_id: string | null;
  design_type: 'static' | 'motion' | 'playlist';
  design_name?: string;
  playlist_name?: string;
  is_default: boolean;
  start_date: string | null;
  end_date: string | null;
  priority: number;
}

export interface ArtNetConfig {
  mode: 'multicast' | 'unicast';
  unicastAddress?: string;
  universe: number;
}

export interface LayoutData {
  walls: Wall[];
  totalLights: number;
  totalDMXChannels: number;
}

export interface WSMessage {
  type: 'frame' | 'layout';
  data: unknown;
}
