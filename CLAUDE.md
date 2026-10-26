# Rooftop Lights Control System

Web app for designing, previewing and scheduling shows on RGBW architectural lights over ArtNet/DMX. It runs a 96-fixture rooftop (4 walls), with AI design and scene generation and live audio input.

## Tech Stack

- **Backend**: Node.js 24, Express 4, TypeScript, better-sqlite3 (WAL), ws, @anthropic-ai/sdk
- **Frontend**: React 19, TypeScript, Vite 8, React Router 7, react-colorful, three.js via @react-three/fiber 9 / drei 10
- **Protocol**: ArtNet (ArtDMX over UDP 6454), multi-universe
- **Audio input**: UDP JSON on port 7000, HTTP, or WebSocket (browser mic)
- **Database**: SQLite at `/app/data/rooftop-lights.db` in the external Docker volume `rooftop-data`

## Project Structure

```
backend/src/
├── index.ts                  # Express server, /health, /ws (frames + browser audio), origin/CSRF guard
├── models/database.ts        # Schema, idempotent migrations, default layout
├── artnet/artnet.ts          # ArtNet sender (singleton), dirty-frame detection, multi-universe
├── scheduler/
│   ├── scheduler.ts          # ~30 FPS render loop, playlist player, transitions, preview
│   └── activeSchedule.ts     # Which schedule is active (local time, TZ)
├── services/
│   ├── effectEngine.ts       # All motion effects, sub-pixel blending, sync walls, cycle lengths
│   ├── effectTypes.ts        # Built-in effect catalogue (params, labels, color labels, speed info)
│   ├── layoutDefaults.ts     # Effect defaults tuned to the layout and dead channels
│   ├── designValidation.ts   # Design/param validation (400s)
│   ├── playlistTimeline.ts   # Flattens nested playlists/scenes into a frame timeline
│   ├── aiDesigner.ts         # Claude: static/motion design generation
│   ├── aiSceneCreator.ts     # Claude: whole-scene generation
│   ├── aiSandbox.ts          # node:vm sandbox for AI effect code (per-frame timeout)
│   ├── audioInput.ts         # UDP/HTTP/WS audio levels, smoothing, auto-gain
│   └── folders.ts            # Folder name normalisation
├── routes/                   # layout, designs, playlists (+ scenes, AI), schedules, artnet,
│                             # preview, folders, audio
└── utils/rateLimitedLog.ts
backend/test/                 # node:test suites (npm test, needs TEST_DB=<copy of a db>)

frontend/src/
├── App.tsx, main.tsx         # Router, single WebSocket provider
├── pages/
│   ├── DesignPage.tsx        # Tabs: Static, Motion, Scenes, Playlist
│   ├── design/               # StaticPanel, MotionPanel, PlaylistPanel, InlineDesignEditor,
│   │                         # SavedList, Folders, Modals, ColorPicker, editors.ts (editor state)
│   ├── LayoutPage.tsx        # Walls/lights, Light IDs preview, ArtNet, audio inputs, version
│   └── SchedulerPage.tsx
├── components/               # PreviewStrip (2D), Preview3D, LiveLightPreview, LightIdPreview,
│                             # AudioInputsCard, BrowserMicControl
├── hooks/                    # lightSocket/useLightSocket (WS store), usePreview, useMediaQuery
├── utils/                    # api.ts (typed client), color, folders, browserMic
└── types/index.ts
```

## Quick Reference

### Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 3030 | HTTP/WS | Web UI, API, `/ws` |
| 6454 | UDP | ArtNet/DMX out |
| 7000 | UDP | Audio level input (`AUDIO_UDP_PORT`) |

### Production

https://rooftop.onestpete.com: Caddy reverse proxy to :3030, LAN only. The app has no built-in auth.

### Commands

```bash
# Production (GIT_COMMIT shows on the Light Layout page and in /health)
GIT_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build

# Development (hot reload on :3030, backend on :3031 behind Vite)
docker compose -f docker-compose.dev.yml up --build

# Local dev (without Docker)
cd backend && npm run dev     # :3030
cd frontend && npm run dev    # :5173, proxies /api, /ws, /health

# Checks
cd backend && npx tsc --noEmit && TEST_DB=/path/to/copy.db npm test
cd frontend && npm run build  # tsc + vite build
```

Dev and production share port 3030, so run only one at a time. To test changes safely, clone the repo elsewhere and run a side container on another port with a copy of the DB whose `artnet_config` is set to unicast `127.0.0.1`. Then nothing reaches the real lights.

### Environment

`DATABASE_PATH`, `ANTHROPIC_API_KEY` (in `.env`, gitignored), `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`), `TZ` (compose default `America/New_York`), `CORS_ORIGINS`, `AUDIO_UDP_PORT`, `AI_CODE_TIMEOUT_MS`, `NODE_ENV`.

### API (main routes)

| Route | Purpose |
|-------|---------|
| GET /api/layout/layout | Walls, lights, groups |
| /api/designs (CRUD), GET /api/designs/effects/types | Designs; effect catalogue with layout-aware defaults |
| POST /api/designs/ai/generate | AI static/motion design (`considerDefective`) |
| /api/playlists (CRUD, `?kind=scene\|playlist`) | Scenes and playlists, nested items, seconds/times, transitions |
| POST /api/playlists/ai/generate | AI Scene Creator |
| /api/folders | List / rename / delete (unfile) folders |
| /api/schedules, POST /api/schedules/default | Scheduling |
| /api/preview/* | Browser-only or live preview (effects, inline playlists, startIndex) |
| /api/artnet/config, /status, /test | ArtNet |
| POST /api/audio/level, GET /api/audio/sources, /status | Audio input |
| GET /health | Status, version, commit, build time, time zone |

### WebSocket `/ws`

- **Server sends:** `layout` (walls/lights) once, then `frame` about 10/s (`{ [lightId]: {r,g,b,w} }`, `dmxRate`).
- **Client may send:** `{type:"audio", id, level, peak, seq}` (browser mic).

## Architecture Notes

### Layout and DMX

- 96 RGBW lights: West 13×3, South 3×3, East 13×3, North 3×3. The matrix is stored as viewed from outside.
- DMX start = `((light_id - 1) * 4) + 1`; channels above 512 go to the next universe.
- `defective_channels` per light are zeroed at output, shown with "Show Defective", fed to the AI, and used by layout defaults.

### Effects

- **Built-in effects** (`effectEngine.ts`, catalogue in `effectTypes.ts`): Candy Cane, Checkerboard, Comet & Chase, Sparkles, Rainbow, Wave, Sine Wave, Meet in the Middle, Expand, Breathe, Text Scroll, Twinkle, Color Fade, Lightning, Fireworks, Fire, Strobe, Ripple, Audio Level, plus AI code effects.
- **Shared params:** scope (all / per wall with wall picker / per group), angle, pause before looping, sub-pixel blending, sync walls, min–max range params, select params with `showIf`.
- **Timing:** `frameNum` passed to effects is speed-scaled. Real-time effects (e.g. Fireworks, Audio Level) use the real frame instead.
- **Loops:** `effectCycleFrames` gives each effect's loop length, which drives "times" in playlists.

### Scenes, Playlists, Schedules

- Scenes and playlists share the `playlists` table (`kind`). Scenes hold designs only. The UI calls playlists **Shows** and motion designs **Effects**; code, API and DB keep `playlist` / `motion`.
- Playlists can nest scenes and playlists; cycles are rejected.
- Each item plays for X seconds or X times, with a cut, fade or fade-to-black transition.
- Timed events (playlists only): items with a `cue` (JSON: `at` a time, or `every` N minutes with an optional from/until window) are left out of the loop; the player interrupts the loop when one comes due (local time, checked per minute), plays it once, then resumes the loop where it paused.
- Schedule priority: date-specific schedules (by priority), then the default schedule.

### Database

- **Tables:** walls, lights, wall_groups, designs (folder), playlists (kind, folder), playlist_items (design_id | child_playlist_id, repeat_mode, repeat_count, transition, cue), schedules, artnet_config.
- **Migrations:** run at startup and are idempotent.
- **Backups:** back up before risky changes (`docker exec … better-sqlite3 backup`).

## Development Notes

- The scheduler renders at ~30 FPS and broadcasts every 3rd frame over WebSocket. ArtNet sends only on change, plus a 1 s keepalive.
- AI effect code runs in `node:vm` with a per-frame timeout. It is not a hard security boundary, so keep the app behind auth.
- Cross-origin POST/PUT/DELETE are rejected unless the origin is in `CORS_ORIGINS`; requests with no Origin (curl, ESP32) are allowed.
- The frontend opens one WebSocket. Frames go to an external store so hidden pages don't re-render.
