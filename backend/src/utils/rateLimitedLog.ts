// Log each distinct message at most once per window, so a per-frame failure
// (30 FPS) produces one log line instead of thousands.

const WINDOW_MS = 60_000;
const MAX_TRACKED = 500;

const seen = new Map<string, { last: number; suppressed: number }>();

export function logRateLimited(message: string, err?: unknown): void {
  const now = Date.now();
  const entry = seen.get(message);
  if (entry && now - entry.last < WINDOW_MS) {
    entry.suppressed++;
    return;
  }
  const suffix = entry && entry.suppressed > 0 ? ` (repeated ${entry.suppressed}x in the last ${WINDOW_MS / 1000}s)` : '';
  if (err !== undefined) console.error(message + suffix, err);
  else console.error(message + suffix);

  seen.delete(message);
  seen.set(message, { last: now, suppressed: 0 });
  while (seen.size > MAX_TRACKED) {
    seen.delete(seen.keys().next().value as string);
  }
}
