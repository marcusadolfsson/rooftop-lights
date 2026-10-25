// Single source of truth for "which schedule is active right now". Used by the
// render loop (scheduler.ts) and by GET /api/schedules/active so the UI always
// shows exactly what the lights are doing.
//
// Times are compared in the process's local time zone, which comes from the TZ
// environment variable (docker-compose defaults it to America/New_York).

import type Database from 'better-sqlite3';
import { getDatabase } from '../models/database.js';

export interface ScheduleRow {
  id: string;
  design_id: string | null;
  playlist_id: string | null;
  design_type: 'static' | 'motion' | 'playlist';
  is_default: number;
  start_date: string | null;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  priority: number;
  created_at?: string;
  design_name?: string | null;
  playlist_name?: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD HH:MM' in the process's local time zone. */
export function localDateTimeString(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function serverTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || 'UTC';
  } catch {
    return process.env.TZ || 'UTC';
  }
}

interface Statements {
  dated: Database.Statement;
  fallback: Database.Statement;
}

const stmtCache = new WeakMap<Database.Database, Statements>();

function statements(db: Database.Database): Statements {
  let s = stmtCache.get(db);
  if (!s) {
    s = {
      dated: db.prepare(`
        SELECT s.*, d.name AS design_name, p.name AS playlist_name
        FROM schedules s
        LEFT JOIN designs d ON s.design_id = d.id
        LEFT JOIN playlists p ON s.playlist_id = p.id
        WHERE s.is_default = 0
          AND datetime(s.start_date || ' ' || COALESCE(s.start_time, '16:00')) <= datetime(?)
          AND datetime(s.end_date || ' ' || COALESCE(s.end_time, '16:00')) >= datetime(?)
        ORDER BY s.priority DESC
        LIMIT 1
      `),
      fallback: db.prepare(`
        SELECT s.*, d.name AS design_name, p.name AS playlist_name
        FROM schedules s
        LEFT JOIN designs d ON s.design_id = d.id
        LEFT JOIN playlists p ON s.playlist_id = p.id
        WHERE s.is_default = 1
        LIMIT 1
      `),
    };
    stmtCache.set(db, s);
  }
  return s;
}

/** Date-specific schedule (highest priority) if one covers `now`, else the default schedule. */
export function findActiveSchedule(now: Date = new Date()): ScheduleRow | null {
  const db = getDatabase();
  const s = statements(db);
  const localDateTime = localDateTimeString(now);
  const dated = s.dated.get(localDateTime, localDateTime) as ScheduleRow | undefined;
  if (dated) return dated;
  return (s.fallback.get() as ScheduleRow | undefined) ?? null;
}
