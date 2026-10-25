import { Router, Request, Response } from 'express';
import { getDatabase } from '../models/database.js';
import net from 'net';
import {
  getArtNetController, initArtNet, ArtNetConfig,
  MAX_UNIVERSE, MIN_REFRESH_RATE, MAX_REFRESH_RATE,
} from '../artnet/artnet.js';
import { getScheduler } from '../scheduler/scheduler.js';

const router = Router();

// Get ArtNet configuration
router.get('/config', (req: Request, res: Response) => {
  const db = getDatabase();

  const config = db.prepare('SELECT * FROM artnet_config WHERE id = 1').get() as any;

  res.json({
    mode: config.mode,
    unicastAddress: config.unicast_address,
    universe: config.universe,
    refreshRate: config.refresh_rate || 40,
  });
});

// Update ArtNet configuration
router.put('/config', (req: Request, res: Response) => {
  const db = getDatabase();
  const { mode, unicastAddress, universe, refreshRate = 40 } = req.body ?? {};

  // Validate mode
  if (mode !== 'multicast' && mode !== 'unicast') {
    res.status(400).json({ error: 'Mode must be "multicast" or "unicast"' });
    return;
  }

  // Validate unicast address if mode is unicast
  if (mode === 'unicast' && !unicastAddress) {
    res.status(400).json({ error: 'Unicast address is required when mode is unicast' });
    return;
  }
  if (unicastAddress != null && unicastAddress !== '' && (typeof unicastAddress !== 'string' ||
      !(net.isIPv4(unicastAddress.trim()) || /^[A-Za-z0-9.-]{1,253}$/.test(unicastAddress.trim())))) {
    res.status(400).json({ error: 'Unicast address must be an IPv4 address or hostname' });
    return;
  }

  // Validate universe
  if (!Number.isInteger(universe) || universe < 0 || universe > MAX_UNIVERSE) {
    res.status(400).json({ error: `Universe must be an integer between 0 and ${MAX_UNIVERSE}` });
    return;
  }

  // Validate refresh rate
  if (typeof refreshRate !== 'number' || !Number.isFinite(refreshRate) || refreshRate < MIN_REFRESH_RATE || refreshRate > MAX_REFRESH_RATE) {
    res.status(400).json({ error: `Refresh rate must be between ${MIN_REFRESH_RATE} and ${MAX_REFRESH_RATE} FPS` });
    return;
  }
  const fps = Math.round(refreshRate);
  const address = typeof unicastAddress === 'string' && unicastAddress.trim() ? unicastAddress.trim() : undefined;

  db.prepare(`
    UPDATE artnet_config
    SET mode = ?, unicast_address = ?, universe = ?, refresh_rate = ?
    WHERE id = 1
  `).run(mode, address ?? null, universe, fps);

  // Update ArtNet controller with new config
  const controller = getArtNetController();
  const config: ArtNetConfig = {
    mode,
    unicastAddress: address,
    universe,
    refreshRate: fps,
  };

  if (controller) {
    controller.updateConfig(config);
  } else {
    initArtNet(config);
  }

  res.json({ success: true });
});

// Get ArtNet status
router.get('/status', (req: Request, res: Response) => {
  const controller = getArtNetController();

  res.json({
    running: controller !== null,
    dmxData: controller ? Array.from(controller.getDMXData()) : null,
    universes: controller ? controller.getAllDMXData() : null,
    sendRate: controller ? controller.getSendRate() : 0,
  });
});

// Test ArtNet connection (send a brief flash)
router.post('/test', (req: Request, res: Response) => {
  const controller = getArtNetController();

  if (!controller) {
    res.status(500).json({ error: 'ArtNet controller not running' });
    return;
  }

  // The scheduler owns the DMX buffer (it rewrites it every tick), so the flash
  // is an override inside the render loop: full white for 500ms, then resume.
  getScheduler().flash(500);
  controller.markDirty();

  res.json({ success: true, message: 'Test flash sent' });
});

export default router;
