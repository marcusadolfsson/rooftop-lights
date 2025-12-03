import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

import { getDatabase, closeDatabase } from './models/database.js';
import { initArtNet, stopArtNet, ArtNetConfig } from './artnet/artnet.js';
import { getScheduler } from './scheduler/scheduler.js';
import { getEffectEngine } from './services/effectEngine.js';

import layoutRoutes from './routes/layout.js';
import designsRoutes from './routes/designs.js';
import playlistsRoutes from './routes/playlists.js';
import schedulesRoutes from './routes/schedules.js';
import artnetRoutes from './routes/artnet.js';
import previewRoutes from './routes/preview.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3030;

// Middleware
app.use(cors());
app.use(express.json());

// API Routes
app.use('/api/layout', layoutRoutes);
app.use('/api/designs', designsRoutes);
app.use('/api/playlists', playlistsRoutes);
app.use('/api/schedules', schedulesRoutes);
app.use('/api/artnet', artnetRoutes);
app.use('/api/preview', previewRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static files from the public directory (built frontend)
const publicPath = path.join(__dirname, '..', 'public');
app.use(express.static(publicPath));

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Create HTTP server
const server = http.createServer(app);

// WebSocket server for real-time preview
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws: WebSocket) => {
  console.log('WebSocket client connected');

  const scheduler = getScheduler();
  scheduler.addWSClient(ws as unknown as globalThis.WebSocket);

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    scheduler.removeWSClient(ws as unknown as globalThis.WebSocket);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  // Send initial layout data
  const engine = getEffectEngine();
  const walls = engine.getWalls();
  const lights = engine.getLights();

  ws.send(JSON.stringify({
    type: 'layout',
    data: { walls, lights },
  }));
});

// Initialize application
async function initialize(): Promise<void> {
  console.log('Initializing Rooftop Lights application...');

  // Initialize database
  console.log('Connecting to database...');
  const db = getDatabase();
  console.log('Database connected');

  // Load ArtNet configuration and start controller
  console.log('Starting ArtNet controller...');
  const artnetConfig = db.prepare('SELECT * FROM artnet_config WHERE id = 1').get() as any;

  const config: ArtNetConfig = {
    mode: artnetConfig.mode,
    unicastAddress: artnetConfig.unicast_address,
    universe: artnetConfig.universe,
    refreshRate: artnetConfig.refresh_rate || 40,
  };

  initArtNet(config);
  console.log(`ArtNet started in ${config.mode} mode, universe ${config.universe}, ${config.refreshRate} FPS`);

  // Initialize effect engine
  console.log('Initializing effect engine...');
  getEffectEngine();

  // Start scheduler
  console.log('Starting scheduler...');
  getScheduler().start();

  console.log('Initialization complete');
}

// Graceful shutdown
function shutdown(): void {
  console.log('\nShutting down...');

  getScheduler().stop();
  stopArtNet();
  closeDatabase();

  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start server
initialize().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
  });
}).catch((error) => {
  console.error('Failed to initialize:', error);
  process.exit(1);
});
