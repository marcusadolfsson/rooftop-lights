# Rooftop Lights Control System

A web application for designing and controlling architectural RGBW lights via ArtNet/DMX. Built to replace QLC+ with a modern, web-based interface.

## Features

### Light Layout Section
- Configure wall sections with custom dimensions
- Define light matrix positions for each wall
- Set light type (RGB or RGBW) and DMX channel mapping
- Support for continuous wall connections for seamless motion effects
- ArtNet configuration (Multicast or Unicast)

### Design Section

#### Static Mode
- Click and drag to paint colors on the light matrix
- RGBW color picker with individual channel control
- Copy designs between walls (West to East, North to South)
- Save, load, and manage design presets
- Pre-built designs: All White, All Red, All Green, All Blue

#### Motion Mode
Built-in effects:
- **Candy Cane**: Red and white diagonal stripes scrolling
- **Checkerboard**: Alternating squares that shift
- **Comet Wave**: Bright head with fading tail, sweeps back and forth
- **Sparkles**: Random lights twinkling
- **Rainbow**: Smooth color transition across the display
- **Wave**: Sinusoidal brightness wave
- **Chase**: Group of lights chasing around the perimeter
- **Breathe**: All lights pulsing together

Each effect has customizable colors and parameters.

#### Playlist Mode
- Create playlists of designs
- Set duration for each design
- Sequential or random playback modes

### Schedule Section
- Set a default design/playlist that always plays
- Create date-specific schedules with start and end dates
- Priority system for overlapping schedules

### Live Preview
- Real-time WebSocket connection for instant feedback
- Toggle live preview to see designs on actual lights
- Preview automatically disabled when returning to schedule

## Default Light Layout

The system comes pre-configured with a rooftop layout:
- **West Wall**: 13 wide x 3 tall
- **North Wall**: 3 wide x 3 tall
- **East Wall**: 13 wide x 3 tall
- **South Wall**: 3 wide x 3 tall

All walls connect to form a continuous 32-light wide perimeter.

## Tech Stack

- **Backend**: Node.js, Express, TypeScript, better-sqlite3
- **Frontend**: React, TypeScript, Vite
- **Real-time**: WebSocket for live preview
- **Protocol**: ArtNet (DMX over UDP)
- **Database**: SQLite with persistent volume

## Quick Start

### Production (Docker)

```bash
# Build and run
docker-compose up -d

# Access the application
open http://localhost:3000
```

### Development

```bash
# Install dependencies
cd backend && npm install
cd ../frontend && npm install

# Start backend (from backend directory)
npm run dev

# Start frontend (from frontend directory, in another terminal)
npm run dev

# Access the application
open http://localhost:5173
```

### Development with Docker

```bash
docker-compose -f docker-compose.dev.yml up
```

## Configuration

### ArtNet Settings
Configure in the Light Layout section:
- **Mode**: Multicast (broadcast) or Unicast (specific IP)
- **Unicast Address**: IP address of ArtNet node (when using unicast)
- **Universe**: ArtNet universe number (0-32767)

### DMX Channel Mapping
Each light's DMX channels are calculated as:
- Start channel: `((Light ID - 1) * 4) + 1` for RGBW
- Start channel: `((Light ID - 1) * 3) + 1` for RGB

Channels are: R, G, B, W (in order)

## API Endpoints

### Layout
- `GET /api/layout/layout` - Get complete layout with walls and lights
- `GET /api/layout/walls` - Get all walls
- `PUT /api/layout/walls/:id` - Update a wall
- `PUT /api/layout/lights/:id` - Update a light

### Designs
- `GET /api/designs` - Get all designs
- `POST /api/designs` - Create a design
- `PUT /api/designs/:id` - Update a design
- `DELETE /api/designs/:id` - Delete a design
- `GET /api/designs/effects/types` - Get available effect types

### Playlists
- `GET /api/playlists` - Get all playlists
- `POST /api/playlists` - Create a playlist
- `PUT /api/playlists/:id` - Update a playlist
- `DELETE /api/playlists/:id` - Delete a playlist

### Schedules
- `GET /api/schedules` - Get all schedules
- `GET /api/schedules/active` - Get currently active schedule
- `POST /api/schedules/default` - Set default schedule
- `POST /api/schedules` - Create a date-specific schedule
- `DELETE /api/schedules/:id` - Delete a schedule

### Preview
- `POST /api/preview/start` - Start live preview
- `POST /api/preview/stop` - Stop live preview
- `POST /api/preview/effect` - Preview a motion effect

### ArtNet
- `GET /api/artnet/config` - Get ArtNet configuration
- `PUT /api/artnet/config` - Update ArtNet configuration
- `POST /api/artnet/test` - Send test flash

## WebSocket

Connect to `/ws` for real-time frame updates:
```javascript
const ws = new WebSocket('ws://localhost:3000/ws');
ws.onmessage = (event) => {
  const { type, data } = JSON.parse(event.data);
  if (type === 'frame') {
    // data contains { light_id: { r, g, b, w }, ... }
  }
};
```

## Persistent Data

All data is stored in SQLite at `/app/data/rooftop-lights.db`. Mount this directory as a volume to persist data:

```yaml
volumes:
  - ./data:/app/data
```

## License

MIT
