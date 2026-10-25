import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

import { getDatabase, closeDatabase } from './models/database.js';
import { initArtNet, stopArtNet, ArtNetConfig } from './artnet/artnet.js';
import { getScheduler } from './scheduler/scheduler.js';
import { getEffectEngine } from './services/effectEngine.js';
import { serverTimeZone, localDateTimeString } from './scheduler/activeSchedule.js';
import { logRateLimited } from './utils/rateLimitedLog.js';

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

// Process-level safety net: log instead of dying silently. Repeated uncaught
// exceptions in a short window still exit so Docker restarts a wedged process.
let recentUncaught: number[] = [];
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  const now = Date.now();
  recentUncaught = recentUncaught.filter(t => now - t < 60_000);
  recentUncaught.push(now);
  if (recentUncaught.length > 10) {
    console.error('Too many uncaught exceptions in 60s, exiting');
    process.exit(1);
  }
});
process.on('unhandledRejection', (reason) => {
  logRateLimited(`Unhandled promise rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    reason instanceof Error ? reason.stack : undefined);
});

// CORS: same-origin only by default. Set CORS_ORIGINS to a comma-separated list
// of origins (e.g. "https://dashboard.example.com,http://localhost:5173") to allow others.
const corsOrigins = new Set(
  (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean)
);
app.use(cors({
  origin: (origin, cb) => cb(null, !!origin && corsOrigins.has(origin)),
}));

// CSRF guard: a browser on another site can still fire "simple" cross-origin
// POSTs without a preflight, so reject state-changing requests whose Origin is
// neither this host nor an allowed CORS origin. Skipped in development, where
// the Vite proxy rewrites Host (changeOrigin).
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (!origin || SAFE_METHODS.has(req.method) || process.env.NODE_ENV === 'development') return next();
  if (corsOrigins.has(origin)) return next();
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    res.status(403).json({ error: 'Cross-origin request rejected' });
    return;
  }
  const hosts = [req.headers.host, req.headers['x-forwarded-host']]
    .flatMap(h => (Array.isArray(h) ? h : [h]))
    .filter((h): h is string => typeof h === 'string')
    .flatMap(h => h.split(',').map(x => x.trim()));
  if (hosts.includes(originHost)) return next();
  res.status(403).json({ error: 'Cross-origin request rejected' });
});

app.use(express.json({ limit: '1mb' }));

// API Routes
app.use('/api/layout', layoutRoutes);
app.use('/api/designs', designsRoutes);
app.use('/api/playlists', playlistsRoutes);
app.use('/api/schedules', schedulesRoutes);
app.use('/api/artnet', artnetRoutes);
app.use('/api/preview', previewRoutes);

// Health check (unauthenticated, fast, checks DB)
const startTime = Date.now();
app.get('/health', (req, res) => {
  try {
    const db = getDatabase();
    db.prepare('SELECT 1').get();
  } catch {
    return res.status(503).json({ status: 'unhealthy' });
  }

  const uptimeMs = Date.now() - startTime;
  const days = Math.floor(uptimeMs / 86400000);
  const hours = Math.floor((uptimeMs % 86400000) / 3600000);
  const minutes = Math.floor((uptimeMs % 3600000) / 60000);
  const uptime = `${days}d ${hours}h ${minutes}m`;

  res.json({
    status: 'healthy',
    version: '1.0.0',
    uptime,
    timeZone: serverTimeZone(),
    serverTime: localDateTimeString(),
  });
});

// Serve static files from the public directory (built frontend)
const publicPath = path.join(__dirname, '..', 'public');
app.use(express.static(publicPath));

// Fallback to index.html for SPA routing
// Unknown /api routes get a JSON 404 rather than index.html
app.use('/api', (req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// JSON error handler (bad JSON bodies, constraint violations, unexpected errors)
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body is not valid JSON' });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body too large' });
    return;
  }
  if (typeof err?.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
    res.status(400).json({ error: `Database constraint failed: ${err.message}` });
    return;
  }
  console.error(`Error handling ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Internal server error' });
});

// Create HTTP server
const server = http.createServer(app);

// WebSocket server for real-time preview
// Clients never send anything meaningful, so keep the inbound payload limit small
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws: WebSocket) => {
  console.log('WebSocket client connected');

  const scheduler = getScheduler();
  scheduler.addWSClient(ws);

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    scheduler.removeWSClient(ws);
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
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down...');

  // Hard stop if something keeps the event loop alive
  setTimeout(() => {
    console.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, 5000).unref();

  getScheduler().stop();

  // Open WebSockets would otherwise keep server.close() waiting forever
  for (const client of wss.clients) {
    client.terminate();
  }
  wss.close();

  server.close(() => {
    console.log('Server closed');
    stopArtNet();
    closeDatabase();
    process.exit(0);
  });
  // Drop idle keep-alive HTTP connections so close() can complete
  server.closeIdleConnections?.();
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
