import { Router, Request, Response } from 'express';
import { getDatabase } from '../models/database.js';
import { getArtNetController, initArtNet, ArtNetConfig } from '../artnet/artnet.js';

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
  const { mode, unicastAddress, universe, refreshRate } = req.body;

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

  // Validate universe
  if (universe < 0 || universe > 32767) {
    res.status(400).json({ error: 'Universe must be between 0 and 32767' });
    return;
  }

  // Validate refresh rate
  const fps = Math.max(1, Math.min(44, refreshRate || 40));

  db.prepare(`
    UPDATE artnet_config
    SET mode = ?, unicast_address = ?, universe = ?, refresh_rate = ?
    WHERE id = 1
  `).run(mode, unicastAddress || null, universe, fps);

  // Update ArtNet controller with new config
  const controller = getArtNetController();
  const config: ArtNetConfig = {
    mode,
    unicastAddress,
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
  });
});

// Test ArtNet connection (send a brief flash)
router.post('/test', (req: Request, res: Response) => {
  const controller = getArtNetController();

  if (!controller) {
    res.status(500).json({ error: 'ArtNet controller not running' });
    return;
  }

  // Store current data
  const currentData = controller.getDMXData();

  // Set all channels to white
  for (let i = 1; i <= 512; i += 4) {
    controller.setRGBW(i, 255, 255, 255, 255);
  }

  // After 500ms, restore
  setTimeout(() => {
    controller.setAllChannels(Array.from(currentData));
  }, 500);

  res.json({ success: true, message: 'Test flash sent' });
});

export default router;
