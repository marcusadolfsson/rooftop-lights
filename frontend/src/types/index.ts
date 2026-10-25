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
  defective_channels: string;
}

export interface Wall {
  id: string;
  name: string;
  width: number;
  height: number;
  position: number;
  connects_to_next: boolean;
  group_id?: string | null;
  lights?: Light[];
  matrix?: Light[][];
}

export interface WallGroup {
  id: string;
  name: string;
  position: number;
}

export interface Design {
  id: string;
  name: string;
  type: 'static' | 'motion';
  // null when the stored row is corrupt (the backend then sets dataError)
  data: StaticDesignData | MotionDesignData | null;
  dataError?: string;
  // Motion designs: seconds per complete effect cycle ("play X times" counts these); null when
  // the effect has no natural cycle (random effects, AI code)
  cycleSeconds?: number | null;
  // Folder label it's grouped under (null/missing: unfiled). Shared with playlists and scenes.
  folder?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface StaticDesignData {
  colors: Record<number, RGBW>;
  prompt?: string;
}

export interface MotionDesignData {
  type: string;
  colors: RGBW[];
  speed: number;
  scope: 'wall' | 'all' | 'group';
  wallIds?: string[];
  params?: Record<string, unknown>;
}

export interface EffectType {
  type: string;
  name: string;
  description: string;
  defaultColors: RGBW[];
  params: Record<string, EffectParam>;
  // Per-swatch names (e.g. Head, Tail), or a hint when the colors are a palette
  colorLabels?: string[];
  colorHint?: string;
  // Stepped effects move one light every stepFrames frames at 1x; realTime effects ignore Speed
  stepFrames?: number;
  realTime?: boolean;
  // Speed a new design of this effect starts at (1 when absent)
  defaultSpeed?: number;
}

export interface EffectParam {
  // 'range' is a [min, max] pair; the effect picks a random value inside it each time
  type: 'number' | 'boolean' | 'string' | 'range';
  default: number | boolean | string | [number, number];
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  unit?: string;
}

/** A scene is a short piece of designs only, played in order; a playlist can also hold scenes and playlists. */
export type PlaylistKind = 'playlist' | 'scene';

export interface Playlist {
  id: string;
  name: string;
  play_mode: 'sequence' | 'random';
  // Missing from older backends, which only had playlists
  kind?: PlaylistKind;
  items: PlaylistItem[];
  // One pass in order (sequence) or one round of every item (random)
  totalSeconds?: number;
  // Folder label it's grouped under (null/missing: unfiled). Shared with designs.
  folder?: string | null;
  created_at?: string;
  updated_at?: string;
}

/** A folder and how many of each kind it holds (GET /api/folders). */
export interface FolderSummary {
  name: string;
  counts: { static: number; motion: number; scene: number; playlist: number };
  total: number;
}

export type RepeatMode = 'seconds' | 'times';

/** A playlist item plays a design or another playlist (exactly one of the two ids is set). */
export interface PlaylistItem {
  id: string;
  playlist_id: string;
  design_id: string | null;
  child_playlist_id: string | null;
  design_name?: string | null;
  design_type?: string | null;
  child_playlist_name?: string | null;
  child_playlist_kind?: PlaylistKind | null;
  is_playlist?: boolean;
  // Seconds mode plays for `duration`; times mode plays the design's cycle / the child playlist
  // `repeat_count` times (duration is then only the fallback)
  duration: number;
  repeat_mode: RepeatMode;
  repeat_count: number;
  // How long the item lasts, as the server computes it
  seconds?: number;
  position: number;
  transition: 'cut' | 'fade' | 'fade_black';
}

/** What the API accepts for a playlist item. Older clients send only design_id + duration. */
export interface PlaylistItemInput {
  design_id?: string | null;
  child_playlist_id?: string | null;
  duration: number;
  transition?: string;
  repeat_mode?: RepeatMode;
  repeat_count?: number;
}

export interface Schedule {
  id: string;
  design_id: string | null;
  playlist_id: string | null;
  design_type: 'static' | 'motion' | 'playlist';
  design_name?: string;
  playlist_name?: string;
  // 'scene' when playlist_id is a scene
  playlist_kind?: PlaylistKind | null;
  is_default: boolean;
  start_date: string | null;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  priority: number;
}

export interface ArtNetConfig {
  mode: 'multicast' | 'unicast';
  unicastAddress?: string;
  universe: number;
  refreshRate: number;
}

export interface LayoutData {
  walls: Wall[];
  groups: WallGroup[];
  totalLights: number;
  totalDMXChannels: number;
}

export interface WSMessage {
  type: 'frame' | 'layout';
  data: unknown;
}
