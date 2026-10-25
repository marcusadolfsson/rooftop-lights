import { Router, Request, Response } from 'express';
import { getAudioInput } from '../services/audioInput.js';

const router = Router();

// Live audio levels for the Audio Level effect. The UDP listener (AUDIO_UDP_PORT, default 7000)
// is the main input; this is the HTTP fallback for senders that can't do UDP. Requests without an
// Origin header (curl, an ESP32) pass the CSRF guard in index.ts.

// Send one reading or an array: {"id":"mic-1","level":42.5,"peak":71,"seq":1234}
router.post('/level', (req: Request, res: Response) => {
  const result = getAudioInput().handleHttp(req.body, req.ip ?? null);
  if ('error' in result) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result);
});

// Sources heard from in the last 10 minutes, most recent first
router.get('/sources', (req: Request, res: Response) => {
  res.json(getAudioInput().list());
});

// Listener settings, so the Light Layout page can show senders where to send
router.get('/status', (req: Request, res: Response) => {
  res.json(getAudioInput().status());
});

export default router;
