import Database from 'better-sqlite3';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'rooftop-lights.db');

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initializeTables();
  }
  return db;
}

function initializeTables(): void {
  const database = db!;

  // Walls table - defines each wall section
  database.exec(`
    CREATE TABLE IF NOT EXISTS walls (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      position INTEGER NOT NULL,
      connects_to_next INTEGER DEFAULT 1
    )
  `);

  // Lights table - each light in a wall matrix
  database.exec(`
    CREATE TABLE IF NOT EXISTS lights (
      id TEXT PRIMARY KEY,
      wall_id TEXT NOT NULL,
      matrix_x INTEGER NOT NULL,
      matrix_y INTEGER NOT NULL,
      light_id INTEGER NOT NULL,
      light_type TEXT DEFAULT 'RGBW',
      dmx_start_channel INTEGER NOT NULL,
      defective_channels TEXT DEFAULT '',
      FOREIGN KEY (wall_id) REFERENCES walls(id) ON DELETE CASCADE
    )
  `);

  // ArtNet configuration
  database.exec(`
    CREATE TABLE IF NOT EXISTS artnet_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mode TEXT DEFAULT 'multicast',
      unicast_address TEXT,
      universe INTEGER DEFAULT 0,
      refresh_rate INTEGER DEFAULT 40
    )
  `);

  // Migration: Add refresh_rate column if it doesn't exist
  const columns = database.prepare("PRAGMA table_info(artnet_config)").all() as { name: string }[];
  if (!columns.some(col => col.name === 'refresh_rate')) {
    database.exec('ALTER TABLE artnet_config ADD COLUMN refresh_rate INTEGER DEFAULT 40');
  }

  // Migration: Add defective_channels column if it doesn't exist
  const lightColumns = database.prepare("PRAGMA table_info(lights)").all() as { name: string }[];
  if (!lightColumns.some(col => col.name === 'defective_channels')) {
    database.exec("ALTER TABLE lights ADD COLUMN defective_channels TEXT DEFAULT ''");
  }

  // Wall groups table
  database.exec(`
    CREATE TABLE IF NOT EXISTS wall_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER NOT NULL
    )
  `);

  // Migration: Add group_id column to walls if it doesn't exist
  const wallColumns = database.prepare("PRAGMA table_info(walls)").all() as { name: string }[];
  if (!wallColumns.some(col => col.name === 'group_id')) {
    database.exec('ALTER TABLE walls ADD COLUMN group_id TEXT DEFAULT NULL');
  }

  // Designs table
  database.exec(`
    CREATE TABLE IF NOT EXISTS designs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Playlists table
  database.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      play_mode TEXT DEFAULT 'sequence',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Playlist items
  database.exec(`
    CREATE TABLE IF NOT EXISTS playlist_items (
      id TEXT PRIMARY KEY,
      playlist_id TEXT NOT NULL,
      design_id TEXT NOT NULL,
      duration INTEGER NOT NULL,
      position INTEGER NOT NULL,
      transition TEXT DEFAULT 'cut',
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (design_id) REFERENCES designs(id) ON DELETE CASCADE
    )
  `);

  // Migration: Add transition column to playlist_items if it doesn't exist
  const piColumns = database.prepare("PRAGMA table_info(playlist_items)").all() as { name: string }[];
  if (!piColumns.some(col => col.name === 'transition')) {
    database.exec("ALTER TABLE playlist_items ADD COLUMN transition TEXT DEFAULT 'cut'");
  }

  // Schedule table
  database.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      design_id TEXT,
      playlist_id TEXT,
      design_type TEXT NOT NULL,
      is_default INTEGER DEFAULT 0,
      start_date TEXT,
      end_date TEXT,
      priority INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (design_id) REFERENCES designs(id) ON DELETE SET NULL,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE SET NULL
    )
  `);

  // Migration: Add start_time and end_time columns to schedules if they don't exist
  const scheduleColumns = database.prepare("PRAGMA table_info(schedules)").all() as { name: string }[];
  if (!scheduleColumns.some(col => col.name === 'start_time')) {
    database.exec("ALTER TABLE schedules ADD COLUMN start_time TEXT DEFAULT '16:00'");
  }
  if (!scheduleColumns.some(col => col.name === 'end_time')) {
    database.exec("ALTER TABLE schedules ADD COLUMN end_time TEXT DEFAULT '16:00'");
  }

  // Initialize default ArtNet config if not exists
  const artnetConfig = database.prepare('SELECT id FROM artnet_config WHERE id = 1').get();
  if (!artnetConfig) {
    database.prepare('INSERT INTO artnet_config (id, mode, universe, refresh_rate) VALUES (1, ?, ?, ?)').run('multicast', 0, 40);
  }

  // Initialize default walls if not exists
  const wallCount = database.prepare('SELECT COUNT(*) as count FROM walls').get() as { count: number };
  if (wallCount.count === 0) {
    initializeDefaultLayout(database);
  }
}

function initializeDefaultLayout(database: Database.Database): void {
  // Default wall configuration based on the specification
  const walls = [
    { id: uuidv4(), name: 'West', width: 13, height: 3, position: 0, connects_to_next: 1 },
    { id: uuidv4(), name: 'North', width: 3, height: 3, position: 1, connects_to_next: 1 },
    { id: uuidv4(), name: 'East', width: 13, height: 3, position: 2, connects_to_next: 1 },
    { id: uuidv4(), name: 'South', width: 3, height: 3, position: 3, connects_to_next: 1 },
  ];

  // Light mapping from the specification (viewed from outside)
  // Row 3 (top), Row 2 (middle), Row 1 (bottom) - indexed as y=2, y=1, y=0
  const lightRows = [
    // Row 1 (bottom, y=0)
    [71,72,73,74,75,76,77,78,79,80,81,82,83, 84,85,86, 43,42,41,40,39,38,37,36,35,34,33,32,31, 30,29,28],
    // Row 2 (middle, y=1)
    [55,56,57,58,59,60,61,62,63,64,65,66,67, 68,69,70, 27,26,25,24,23,22,21,20,19,18,17,16,15, 14,13,12],
    // Row 3 (top, y=2)
    [87,88,89,90,91,92,93,94,95,96,54,53,52, 51,50,49, 48,47,46,45,44,11,10,9,8,7,6,5,4, 3,2,1],
  ];

  // Wall column offsets in the combined row
  const wallOffsets = [
    { wall: 0, start: 0, end: 13 },   // West: columns 0-12
    { wall: 1, start: 13, end: 16 },  // North: columns 13-15
    { wall: 2, start: 16, end: 29 },  // East: columns 16-28
    { wall: 3, start: 29, end: 32 },  // South: columns 29-31
  ];

  const insertWall = database.prepare(
    'INSERT INTO walls (id, name, width, height, position, connects_to_next) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertLight = database.prepare(
    'INSERT INTO lights (id, wall_id, matrix_x, matrix_y, light_id, light_type, dmx_start_channel) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  for (const wall of walls) {
    insertWall.run(wall.id, wall.name, wall.width, wall.height, wall.position, wall.connects_to_next);

    const offset = wallOffsets[wall.position];
    for (let y = 0; y < wall.height; y++) {
      for (let x = 0; x < wall.width; x++) {
        const globalX = offset.start + x;
        const lightId = lightRows[y][globalX];
        const dmxStart = ((lightId - 1) * 4) + 1;

        insertLight.run(
          uuidv4(),
          wall.id,
          x,
          y,
          lightId,
          'RGBW',
          dmxStart
        );
      }
    }
  }

  // Create default designs
  const insertDesign = database.prepare(
    'INSERT INTO designs (id, name, type, data) VALUES (?, ?, ?, ?)'
  );

  // All White
  insertDesign.run(uuidv4(), 'All White', 'static', JSON.stringify({
    colors: Array(96).fill({ r: 0, g: 0, b: 0, w: 255 })
  }));

  // All Red
  insertDesign.run(uuidv4(), 'All Red', 'static', JSON.stringify({
    colors: Array(96).fill({ r: 255, g: 0, b: 0, w: 0 })
  }));

  // All Green
  insertDesign.run(uuidv4(), 'All Green', 'static', JSON.stringify({
    colors: Array(96).fill({ r: 0, g: 255, b: 0, w: 0 })
  }));

  // All Blue
  insertDesign.run(uuidv4(), 'All Blue', 'static', JSON.stringify({
    colors: Array(96).fill({ r: 0, g: 0, b: 255, w: 0 })
  }));
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
