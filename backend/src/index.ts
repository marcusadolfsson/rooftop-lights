import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';

import { getDatabase, closeDatabase } from './models/database.js';
import { initArtNet, stopArtNet, ArtNetConfig } from './artnet/artnet.js';
import { getScheduler } from './scheduler/scheduler.js';
import { getEffectEngine } from './services/effectEngine.js';
import { serverTimeZone, localDateTimeString } from './scheduler/activeSchedule.js';
import { logRateLimited } from './utils/rateLimitedLog.js';
import { getAudioInput, audioUdpPortFromEnv } from './services/audioInput.js';

import layoutRoutes from './routes/layout.js';
import designsRoutes from './routes/designs.js';
import playlistsRoutes from './routes/playlists.js';
import schedulesRoutes from './routes/schedules.js';
import artnetRoutes from './routes/artnet.js';
import previewRoutes from './routes/preview.js';
import foldersRoutes from './routes/folders.js';
import audioRoutes from './routes/audio.js';

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

/** Whether a browser Origin is this server (by the request's Host / X-Forwarded-Host) or an allowed CORS origin. */
function isSameOrAllowedOrigin(origin: string, headers: http.IncomingHttpHeaders): boolean {
  if (corsOrigins.has(origin)) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const hosts = [headers.host, headers['x-forwarded-host']]
    .flatMap(h => (Array.isArray(h) ? h : [h]))
    .filter((h): h is string => typeof h === 'string')
    .flatMap(h => h.split(',').map(x => x.trim()));
  return hosts.includes(originHost);
}

// CSRF guard: a browser on another site can still fire "simple" cross-origin
// POSTs without a preflight, so reject state-changing requests whose Origin is
// neither this host nor an allowed CORS origin. Skipped in development, where
// the Vite proxy rewrites Host (changeOrigin).
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (!origin || SAFE_METHODS.has(req.method) || process.env.NODE_ENV === 'development') return next();
  if (isSameOrAllowedOrigin(origin, req.headers)) return next();
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
app.use('/api/folders', foldersRoutes);
app.use('/api/audio', audioRoutes);

// Health check (unauthenticated, fast, checks DB)
const startTime = Date.now();
// Version from package.json; commit and build time from build-info.json written by the Dockerfile
// (absent in dev, where the build is reported as "dev")
function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
const appVersion = String(readJson(path.join(__dirname, '..', 'package.json')).version ?? 'unknown');
const buildInfo = readJson(path.join(__dirname, '..', 'build-info.json'));
const buildCommit = typeof buildInfo.commit === 'string' && buildInfo.commit ? buildInfo.commit : 'dev';
const builtAt = typeof buildInfo.builtAt === 'string' ? buildInfo.builtAt : null;

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
    version: appVersion,
    commit: buildCommit,
    builtAt,
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
// The only thing clients send is audio levels from the browser microphone (tiny JSON), so keep
// the inbound payload limit small
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  console.log('WebSocket client connected');

  // Browser microphone levels: {"type":"audio","id":"browser-chrome-mac","level":42.5,"peak":71,"seq":12}.
  // Only from pages served by this server (same check as the CSRF guard; skipped in development,
  // where the Vite proxy rewrites Host)
  const origin = req.headers.origin;
  const audioAllowed = process.env.NODE_ENV === 'development' || !origin || isSameOrAllowedOrigin(origin, req.headers);
  const address = req.socket.remoteAddress ?? null;
  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary || !audioAllowed) return;
    try {
      const text = data.toString();
      if (text.length > 1024) return;
      const message = JSON.parse(text);
      if (message && typeof message === 'object' && message.type === 'audio') {
        getAudioInput().handleWebSocket(message, address);
      }
    } catch {
      logRateLimited('WebSocket: ignored a message that is not valid JSON');
    }
  });

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

  // Live audio levels for the Audio Level effect (AUDIO_UDP_PORT, 0 disables)
  getAudioInput().start(audioUdpPortFromEnv());

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
  getAudioInput().stop();

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
