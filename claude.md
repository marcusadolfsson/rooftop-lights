# Rooftop Lights

Web application for controlling architectural RGBW lights via ArtNet/DMX protocol. Replaces QLC+ with a custom solution tailored for a rooftop LED installation.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   React SPA     │────▶│  Express API    │────▶│  ArtNet/DMX     │
│   (Frontend)    │     │  (Backend)      │     │  (UDP:6454)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │
        │ WebSocket             │ SQLite
        ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│  Live Preview   │     │  Database       │
│  (Real-time)    │     │  (Persistent)   │
└─────────────────┘     └─────────────────┘
```

## Tech Stack

- **Backend**: Node.js, TypeScript, Express, better-sqlite3
- **Frontend**: React, TypeScript, Vite, react-colorful
- **Protocol**: ArtNet (UDP port 6454) for DMX512 control
- **Database**: SQLite with persistent Docker volume
- **AI**: Anthropic Claude API for design generation (optional)

## Directory Structure

```
rooftop-lights/
├── backend/
│   ├── src/
│   │   ├── index.ts              # Express server, WebSocket setup
│   │   ├── artnet/
│   │   │   └── artnet.ts         # ArtNet UDP controller
│   │   ├── models/
│   │   │   └── database.ts       # SQLite schema and initialization
│   │   ├── routes/
│   │   │   ├── layout.ts         # Walls and lights configuration
│   │   │   ├── designs.ts        # Static/motion designs, AI generation
│   │   │   ├── playlists.ts      # Design playlists
│   │   │   ├── schedules.ts      # Scheduling system
│   │   │   ├── artnet.ts         # ArtNet configuration
│   │   │   └── preview.ts        # Live preview control
│   │   ├── scheduler/
│   │   │   └── scheduler.ts      # Runs scheduled designs
│   │   └── services/
│   │       ├── effectEngine.ts   # Motion effect calculations
│   │       └── aiDesigner.ts     # Claude AI integration
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── LayoutPage.tsx    # Configure walls, lights, ArtNet
│   │   │   ├── DesignPage.tsx    # Create static/motion designs
│   │   │   └── SchedulerPage.tsx # Schedule designs
│   │   ├── hooks/
│   │   │   └── useWebSocket.ts   # Real-time preview updates
│   │   ├── utils/
│   │   │   └── api.ts            # API client functions
│   │   └── types/index.ts        # TypeScript interfaces
│   └── package.json
├── docker-compose.yml
├── Dockerfile
└── claude.md                     # This file
```

## Light Layout

96 RGBW LED fixtures arranged on 4 walls forming a rectangular perimeter:

```
              North (3x3)
         ┌─────────────────┐
         │  51  50  49     │
         │  68  69  70     │
         │  84  85  86     │
    ┌────┴─────────────────┴────┐
    │ W                       E │
    │ e  52 53 54...67        a │
    │ s  ...                  s │
    │ t  71 72 73...83        t │
    └────┬─────────────────┬────┘
         │  28  29  30     │
         │  12  13  14     │
         │   1   2   3     │
         └─────────────────┘
              South (3x3)
```

- **West**: 13x3 matrix (39 lights)
- **North**: 3x3 matrix (9 lights)
- **East**: 13x3 matrix (39 lights)
- **South**: 3x3 matrix (9 lights)

Each light: 4 DMX channels (R, G, B, W). DMX address = `((light_id - 1) * 4) + 1`

## Database Schema

```sql
-- Wall sections
walls (id, name, width, height, position, connects_to_next)

-- Individual lights with DMX mapping
lights (id, wall_id, matrix_x, matrix_y, light_id, light_type, dmx_start_channel)

-- ArtNet configuration
artnet_config (id, mode, unicast_address, universe, refresh_rate)

-- Saved designs (static colors or motion effects)
designs (id, name, type, data, created_at, updated_at)
  -- type: 'static' | 'motion'
  -- data: JSON with colors array or effect parameters

-- Playlists of designs
playlists (id, name, play_mode, created_at, updated_at)
playlist_items (id, playlist_id, design_id, duration, position)

-- Schedule entries
schedules (id, design_id, playlist_id, design_type, is_default, start_date, end_date, priority)
```

## API Endpoints

### Layout
- `GET /api/layout/layout` - Full layout with walls and light matrices
- `GET /api/layout/walls` - List walls
- `PUT /api/layout/walls/:id` - Update wall
- `PUT /api/layout/lights/:id` - Update light DMX mapping

### Designs
- `GET /api/designs` - List all designs
- `GET /api/designs/:id` - Get single design
- `POST /api/designs` - Create design
- `PUT /api/designs/:id` - Update design
- `DELETE /api/designs/:id` - Delete design
- `GET /api/designs/effects/types` - Available motion effects

### AI Designer
- `GET /api/designs/ai/status` - Check if AI is enabled
- `POST /api/designs/ai/generate` - Generate design from description
  ```json
  {
    "description": "sunset gradient from orange to purple",
    "baseDesignId": "optional-uuid",
    "mode": "create" | "modify" | "derivative"
  }
  ```

### Playlists
- `GET /api/playlists` - List playlists
- `POST /api/playlists` - Create playlist
- `POST /api/playlists/:id/items` - Add design to playlist
- `DELETE /api/playlists/:id/items/:itemId` - Remove from playlist

### Schedules
- `GET /api/schedules` - List schedules
- `GET /api/schedules/active` - Currently active schedule
- `POST /api/schedules/default` - Set default design
- `POST /api/schedules` - Create date-specific schedule

### ArtNet
- `GET /api/artnet/config` - Get ArtNet settings
- `PUT /api/artnet/config` - Update settings (mode, universe, refresh rate)
- `POST /api/artnet/test` - Send test pattern

### Preview
- `POST /api/preview/start` - Start live preview
- `POST /api/preview/stop` - Stop preview
- `POST /api/preview/effect` - Preview motion effect

### WebSocket
- `ws://host:3030/ws` - Real-time frame data for preview
  - Receives: `{ type: 'frame', data: { [lightId]: { r, g, b, w } } }`
  - Receives: `{ type: 'layout', data: { walls, lights } }`

## Motion Effects

Available effect types in `effectEngine.ts`:

| Effect | Description | Key Parameters |
|--------|-------------|----------------|
| `candyCane` | Alternating stripes moving around perimeter | color1, color2, stripeWidth, speed, direction |
| `checkerboard` | Animated checkerboard pattern | color1, color2, speed |
| `comet` | Moving light with fading tail | color, tailLength, speed, direction |
| `sparkle` | Random twinkling lights | baseColor, sparkleColor, density, speed |
| `wave` | Sine wave color animation | color1, color2, wavelength, speed |
| `rainbow` | Smooth rainbow cycle | saturation, brightness, speed |
| `chase` | Group of lights chasing around | color, backgroundColor, groupSize, speed |
| `breathe` | Smooth fade in/out | color, minBrightness, speed |
| `fire` | Flickering fire effect | intensity, speed |
| `twinkle` | Holiday twinkle | baseColor, twinkleColor, density, speed |

## Running the Application

### Development
```bash
# Backend
cd backend && npm install && npm run dev

# Frontend
cd frontend && npm install && npm run dev
```

### Production (Docker)
```bash
# Without AI
docker compose up --build

# With AI features
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up --build
```

Access at `http://localhost:3030`

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | 3030 |
| `DATABASE_PATH` | SQLite database location | `/app/data/rooftop-lights.db` |
| `ANTHROPIC_API_KEY` | Claude API key (optional) | - |
| `NODE_ENV` | Environment mode | production |

## AI Design Generation

When `ANTHROPIC_API_KEY` is set, users can describe light shows in natural language:

**Creating new designs:**
- "A warm sunset gradient from orange on the west to purple on the east"
- "Christmas candy cane with red and green stripes moving clockwise"
- "Calm ocean waves with blue and teal pulsing gently"

**Modifying existing designs:**
- Select base design → "Make it faster and add more sparkle"
- Select base design → "Change the colors to blue and gold"

The AI receives full context about:
- Light layout (96 lights, 4 walls, positions)
- Available motion effects and their parameters
- All existing designs (for reference and modification)

## ArtNet Configuration

- **Multicast mode**: Broadcasts to `239.255.0.0` (default)
- **Unicast mode**: Sends to specific IP address
- **Universe**: 0-15 (default: 0)
- **Refresh rate**: 1-44 FPS (default: 40)

DMX packet structure follows ArtNet protocol specification (Art-Net 4).

## Common Tasks

### Add a new motion effect
1. Add effect function in `backend/src/services/effectEngine.ts`
2. Add to effect types list in `backend/src/routes/designs.ts`
3. Update AI context in `backend/src/services/aiDesigner.ts`

### Modify light layout
1. Update `initializeDefaultLayout()` in `backend/src/models/database.ts`
2. Or use the Layout page in the UI to modify walls/lights

### Change ArtNet settings
1. Use Layout page → ArtNet Configuration section
2. Or directly via `PUT /api/artnet/config`
