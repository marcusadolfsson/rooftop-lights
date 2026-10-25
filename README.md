# Rooftop Lights

A web app for designing, previewing and scheduling shows on architectural RGBW lights over ArtNet/DMX. It was built to replace QLC+ for a rooftop installation of 96 fixtures on four walls, but walls, lights and DMX mapping are all configurable.

<p align="center">
  <a href="docs/video/rooftop.mp4"><img src="docs/video/rooftop-preview.webp" alt="The rooftop lights running a red chase on the building at night" width="640"></a>
  <br>
  <em>The installation running on the roof. Click for the full clip.</em>
</p>

> [!WARNING]
> **There is no built-in authentication.** Anyone who can reach the web UI can control your lights, and AI effects run generated JavaScript on the server. Never expose it directly to the internet. Run it on a private network behind your own authentication, such as a reverse proxy with Authelia, Authentik, OAuth2 Proxy, Cloudflare Access or HTTP basic auth. See [Security](#security).

![Design page with a static design](docs/screenshots/design-static.png)

## Features

### Design

**Static designs.** Click or drag to paint lights with an RGBW color picker, pick up colors from existing lights, and copy one wall onto its opposite (West to East, North to South).

**Motion effects.** Each effect has its own colors, speed and parameters, and a scope: continuous around the whole perimeter, per wall, or per wall group. Per Wall can be limited to chosen walls. Comet, Rainbow and Wave take an angle (0° along the walls, 90° bottom to top), and Candy Cane takes a stripe angle. Comet can let its tail run fully out of frame before it loops.

| Effect | What it does |
|---|---|
| Candy Cane | Diagonal stripes scrolling around the perimeter |
| Checkerboard | Alternating squares that shift |
| Comet & Chase | Bright head (adjustable size) with a fading tail; Tail length 0 makes it a chase |
| Sparkle | Random lights twinkling over a base color |
| Rainbow | Smooth rainbow cycling across the display |
| Wave | Sinusoidal brightness wave |
| Meet in the Middle | Two groups start at opposite ends and meet in the middle, with an optional comet tail |
| Breathe | All lights pulsing together |
| Text | Scrolling text |
| Twinkle | Lights fade in and out at random in the palette colors |
| Color Fade | The whole roof crossfades through the palette |
| Lightning | Random strikes of quick white flickers over a background color |
| Fireworks | Bursts that expand from a random point and fade |
| Fire | Flickering flames, hotter along the bottom row |
| Strobe | Fast on/off flashing that cycles through the palette |
| Ripple | Rings spreading outward from a chosen point |
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

Each RGBW light uses 4 DMX channels (R, G, B, W), starting at `((light_id - 1) * 4) + 1`, so the default layout fills 384 channels of one universe. Lights can be patched past channel 512: channel `N` goes to universe `base + floor((N - 1) / 512)`, for up to 16 universes. A light can't straddle a universe boundary.

## Tech stack

- **Backend:** Node.js 24, Express, TypeScript, better-sqlite3, ws
- **Frontend:** React 19, TypeScript, Vite 8, React Router 7, react-colorful, three.js via @react-three/fiber 9
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
GIT_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build
open http://localhost:3030
```

`GIT_COMMIT` is optional. It's shown, together with the version and build time, at the bottom of the Light Layout page's summary and in `GET /health`.

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
| `ANTHROPIC_MODEL` | Claude model for the AI designer | `claude-sonnet-5-5` |
| `TZ` | Timezone used to evaluate schedule times | `America/New_York` (set in the compose files) |
| `CORS_ORIGINS` | Extra origins allowed to call the API, comma-separated | same origin only |
| `AI_CODE_TIMEOUT_MS` | Time budget per frame for AI effect code | `20` |
| `NODE_ENV` | `production` or `development` | `production` |

Schedule times are evaluated in the container's `TZ`, and the Schedule page shows which zone that is. Local development without Docker needs Node 20.19+ or 22.12+; the images use Node 24.

### Health check

`GET /health` checks the database and returns `{ "status": "healthy", "uptime": "..." }`. The Docker images use it as their `HEALTHCHECK`, so a hung process gets restarted.

## Security

The app has **no authentication**. Anyone who can reach port 3030 can change the lights. Keep it on a private network and put it behind an authenticating reverse proxy.

These protections are built in:

- **AI effect code runs in a sandbox.** It runs in a separate `node:vm` context with no `require`, `process`, `eval` or `Function`, and gets a read-only copy of its inputs. Each frame has a time budget of 20 ms by default. Code that throws or runs too long is switched off for 10 seconds, and its lights go dark. A `vm` context isn't a hard security boundary, so the reverse proxy is still needed.
- **Writes from other sites are rejected.** Cross-origin requests that change data (POST, PUT, DELETE) are refused unless the origin is listed in `CORS_ORIGINS`. That stops other web pages from controlling the lights through a visitor's browser.
- **Invalid input gets a 400.** Bad designs, playlists, schedules and light settings are rejected with a clear error. A broken design that is already stored can't crash the render loop.

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
