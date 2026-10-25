# Rooftop Lights Control System

Web-based application for designing and controlling RGBW architectural lights via ArtNet/DMX protocol.

## Tech Stack

- **Backend**: Node.js, Express, TypeScript, better-sqlite3, WebSocket (ws)
- **Frontend**: React 18, TypeScript, Vite, react-colorful
- **Protocol**: ArtNet/DMX over UDP (port 6454)
- **Database**: SQLite with WAL mode

## Project Structure

```
backend/
├── src/
│   ├── index.ts           # Express server entry, WebSocket setup
│   ├── models/database.ts # SQLite schema & initialization
│   ├── artnet/artnet.ts   # ArtNet UDP controller (singleton)
│   ├── scheduler/scheduler.ts  # Main render loop (~30 FPS)
│   ├── services/effectEngine.ts # Motion effect generators
│   └── routes/            # API endpoints
│       ├── layout.ts      # Walls & lights
│       ├── designs.ts     # Design CRUD
│       ├── playlists.ts   # Playlist management
│       ├── schedules.ts   # Date-based scheduling
│       ├── artnet.ts      # ArtNet config
│       └── preview.ts     # Live preview control
frontend/
├── src/
│   ├── App.tsx            # Router & navigation
│   ├── pages/
│   │   ├── DesignPage.tsx    # Static & motion design editor
│   │   ├── LayoutPage.tsx    # Wall/light configuration
│   │   └── SchedulerPage.tsx # Scheduling interface
│   ├── hooks/useWebSocket.ts # Real-time frame updates
│   ├── utils/api.ts       # Typed API client
│   └── types/index.ts     # TypeScript interfaces
```

## Quick Reference

### Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 3030 | HTTP/WS  | Web UI & API |
| 6454 | UDP      | ArtNet/DMX |

### Production URL

https://rooftop.onestpete.com (Caddy reverse proxy to :3030)

### Commands

```bash
# Production (GIT_COMMIT is shown with version/build date on the Layout page)
GIT_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build

# Development (hot reload, same port as production)
docker compose -f docker-compose.dev.yml up --build

# Local dev (without Docker)
cd backend && npm run dev   # Start backend on :3030
cd frontend && npm run dev  # Start frontend on :5173 (proxies to backend)
```

**Note**: Dev and production use the same port (3030) - only run one at a time.

### API Endpoints

| Route | Purpose |
|-------|---------|
| GET /api/layout/layout | Full wall & light layout |
| GET/POST/PUT/DELETE /api/designs | Design CRUD |
| GET/POST/PUT/DELETE /api/playlists | Playlist management |
| GET/POST/DELETE /api/schedules | Schedule management |
| POST /api/schedules/default | Set default schedule |
| GET/PUT /api/artnet/config | ArtNet configuration |
| POST /api/preview/start | Start live preview |
| POST /api/preview/stop | Stop live preview |

### WebSocket

Connect to `/ws` for real-time light frames:
- Message type `frame`: Array of {lightId, color: {r,g,b,w}}
- Message type `layout`: Initial wall/light configuration

## Architecture Notes

### Light Layout

Default 96-light configuration across 4 walls:
- West: 13x3, North: 3x3, East: 13x3, South: 3x3
- DMX channels: RGBW = `((light_id - 1) * 4) + 1`

### Effect Engine

8 built-in motion effects in `effectEngine.ts`:
1. Candy Cane, 2. Checkerboard, 3. Comet, 4. Sparkle
5. Rainbow, 6. Wave, 7. Chase, 8. Breathe

### Scheduler Priority

1. Date-specific schedules (by priority field)
2. Default schedule (is_default=1)

### Database

SQLite at `/app/data/rooftop-lights.db`. Tables: walls, lights, designs, playlists, playlist_items, schedules, artnet_config.

## Development Notes

- Backend uses tsx watch for hot reloading
- Frontend Vite proxies `/api` and `/ws` to backend
- ArtNet singleton in `artnet.ts` - single instance manages UDP socket
- Scheduler runs continuous ~30 FPS loop, broadcasts every 3rd frame to WebSocket clients
