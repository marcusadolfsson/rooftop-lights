# Rooftop Lights

A web app for designing, previewing and scheduling shows on architectural RGBW lights over ArtNet/DMX. It was built to replace QLC+ for a rooftop installation of 96 fixtures on four walls, but walls, lights and DMX mapping are all configurable.

> [!WARNING]
> **There is no built-in authentication.** Anyone who can reach the web UI can control your lights, and AI effects run generated JavaScript on the server. Never expose it directly to the internet. Run it on a private network behind your own authentication, such as a reverse proxy with Authelia, Authentik, OAuth2 Proxy, Cloudflare Access or HTTP basic auth. See [Security](#security).

![Design page with a static design](docs/screenshots/design-static.png)

## Features

### Design

**Static designs.** Click or drag to paint lights with an RGBW color picker, pick up colors from existing lights, and copy one wall onto its opposite (West to East, North to South).

**Motion effects.** Each effect has its own colors, speed and parameters, and a scope: continuous around the whole perimeter, per wall, or per wall group.

| Effect | What it does |
|---|---|
| Candy Cane | Diagonal stripes scrolling around the perimeter |
| Checkerboard | Alternating squares that shift |
| Comet | Bright head with a fading tail |
| Sparkle | Random lights twinkling over a base color |
| Rainbow | Smooth rainbow cycling across the display |
| Wave | Sinusoidal brightness wave |
| Chase | A group of lights chasing around |
| Breathe | All lights pulsing together |
| Text | Scrolling text |
| AI | Custom JavaScript animation written by the AI designer |

![Motion effect editor](docs/screenshots/design-motion.png)

**Playlists.** Chain designs with a duration each, played in sequence or at random.

**AI designer.** Describe a show in plain language ("a warm sunset from orange in the west to purple in the east") and Claude creates a new design, modifies an existing one, or writes a custom animation. It knows the layout, the available effects and your saved designs. This feature is optional and only appears when `ANTHROPIC_API_KEY` is set.

![AI design generator](docs/screenshots/ai-designer.png)

### Preview

Every page has a live preview fed over WebSocket, in 2D (the walls unrolled into one strip) or 3D (an orbitable model of the walls). Editing a design previews it in the browser only. Turning on **Live Preview** also sends it to the real lights until you turn it off. **Show Defective** simulates what lights with broken channels will actually show.

![3D preview](docs/screenshots/design-3d.png)

### Schedule

- A **default** design or playlist plays whenever nothing else is scheduled.
- **Date schedules** override it between a start date and time and an end date and time, and a priority decides between overlapping schedules.
- The ArtNet output strip at the top shows exactly what is being sent to the lights right now.

![Schedule page](docs/screenshots/schedule.png)

### Light Layout

- Walls with custom width and height, ordered around the perimeter and grouped (for example West+South) for per-group effects.
- For each light: its ID, type (RGB or RGBW), DMX start channel and any defective channels (R, G, B or W) to mask out.
- A **Light IDs** preview labels every fixture with its ID, in 2D or 3D, seen from **Outside** or from **Inside** (standing in the middle looking out). Clicking a light opens its settings.
- ArtNet settings: unicast or broadcast, universe, refresh rate (1–44 FPS), plus a test flash.

![Light Layout page](docs/screenshots/layout.png)

![Inside view of the light IDs in 3D](docs/screenshots/layout-inside-3d.png)

## Default layout

On first start the database is seeded with 96 RGBW lights:

| Wall | Size | Lights |
|---|---|---|
| West | 13 × 3 | 39 |
| South | 3 × 3 | 9 |
| East | 13 × 3 | 39 |
| North | 3 × 3 | 9 |

Each RGBW light uses 4 DMX channels (R, G, B, W), starting at `((light_id - 1) * 4) + 1`, so the default layout fills 384 channels of a single universe.

## Tech stack

- **Backend:** Node.js 20, Express, TypeScript, better-sqlite3, ws
- **Frontend:** React 18, TypeScript, Vite, react-colorful, three.js via @react-three/fiber
- **Protocol:** ArtNet (ArtDMX over UDP 6454)
- **Database:** SQLite (WAL mode)
- **AI (optional):** Anthropic Claude API

A scheduler loop runs at about 30 FPS. It renders the active schedule (or live preview), sends DMX only when the frame changes or the content is animated, and pushes every third frame to browsers over `/ws`.

## Running it

Everything is served on port **3030** (web UI, API and WebSocket). ArtNet goes out on UDP **6454**.

Data lives in an external Docker volume, so create it once:

```bash
docker volume create rooftop-data
```

To enable the AI designer, put your key in a `.env` file next to `docker-compose.yml`. It is gitignored.

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

### Production

```bash
docker compose up -d --build
open http://localhost:3030
```

### Development (hot reload)

```bash
docker compose -f docker-compose.dev.yml up --build
```

This runs Vite on 3030 with the backend on 3031 behind it, and mounts `backend/src` and `frontend/src` so edits apply immediately. Dev and production use the same ports, so run only one at a time.

### Without Docker

```bash
cd backend && npm install && npm run dev     # API on :3030
cd frontend && npm install && npm run dev    # UI on :5173, proxies /api and /ws to the backend
```

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `3030` |
| `DATABASE_PATH` | SQLite file | `/app/data/rooftop-lights.db` |
| `ANTHROPIC_API_KEY` | Enables the AI designer | unset |
| `TZ` | Timezone used to evaluate schedule times | container default (UTC) |
| `NODE_ENV` | `production` or `development` | `production` |

Set `TZ` (for example `TZ=America/New_York`) if your schedules should follow local time.

### Health check

`GET /health` checks the database and returns `{ "status": "healthy", "uptime": "..." }`. The Docker images use it as their `HEALTHCHECK`, so a hung process gets restarted.

## Security

The app has **no authentication**. Anyone who can reach port 3030 can change the lights, and AI effects run their generated JavaScript inside the server process. Keep it on a private network or put it behind an authenticating reverse proxy.

## API

| Area | Endpoints |
|---|---|
| Layout | `GET /api/layout/layout`, `GET/POST /api/layout/walls`, `PUT/DELETE /api/layout/walls/:id`, `POST /api/layout/walls/reorder`, `POST /api/layout/lights`, `PUT/DELETE /api/layout/lights/:id`, `GET/POST /api/layout/groups`, `PUT/DELETE /api/layout/groups/:id` |
| Designs | `GET/POST /api/designs`, `GET/PUT/DELETE /api/designs/:id`, `POST /api/designs/:id/copy`, `GET /api/designs/effects/types` |
| AI | `GET /api/designs/ai/status`, `POST /api/designs/ai/generate` |
| Playlists | `GET/POST /api/playlists`, `GET/PUT/DELETE /api/playlists/:id`, `POST /api/playlists/:id/items`, `PUT/DELETE /api/playlists/:id/items/:itemId`, `POST /api/playlists/:id/reorder` |
| Schedules | `GET/POST /api/schedules`, `PUT/DELETE /api/schedules/:id`, `GET/POST /api/schedules/default`, `GET /api/schedules/active` |
| Preview | `GET /api/preview/status`, `POST /api/preview/start`, `/effect`, `/playlist`, `/lights`, `/stop`, `/clear-soft` |
| ArtNet | `GET/PUT /api/artnet/config`, `GET /api/artnet/status`, `POST /api/artnet/test` |

### WebSocket

Connect to `/ws` to receive:

- `{ type: "layout", data: { walls, lights } }` once on connect
- `{ type: "frame", data: { [lightId]: { r, g, b, w } }, dmxRate }` about 10 times per second

```javascript
const ws = new WebSocket(`ws://${location.host}/ws`);
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'frame') console.log(msg.data[1]); // color of light 1
};
```

## Project structure

```
backend/src/
  index.ts                 Express server, WebSocket, /health
  artnet/artnet.ts         ArtNet UDP sender
  scheduler/scheduler.ts   Render loop, schedules, playlists, preview
  services/effectEngine.ts Motion effects
  services/aiDesigner.ts   Claude integration
  models/database.ts       SQLite schema, migrations, default layout
  routes/                  REST API
frontend/src/
  pages/                   Design, Schedule, Light Layout
  components/              3D preview, light ID preview
  hooks/useWebSocket.ts    Live frames
docs/screenshots/          Images used in this README
```

## License

MIT
