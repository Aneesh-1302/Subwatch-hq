import { Hono } from 'hono';
import { redis } from '@devvit/web/server';

export const api = new Hono();

// Total false positives
api.get('/friction/total', async (c) => {
  const total = await redis.get('friction:total');
  return c.json({ total: Number(total ?? 0) });
});

// By flair
api.get('/friction/by-flair', async (c) => {
  const result = await redis.hGetAll('friction:flairs');
  const parsed: Record<string, number> = {};
  for (const [key, val] of Object.entries(result ?? {})) {
    parsed[key] = Number(val);
  }
  return c.json(parsed);
});

// By hour (0-23)
api.get('/friction/by-hour', async (c) => {
  const result: Record<string, number> = {};
  for (let i = 0; i < 24; i++) {
    const val = await redis.get(`friction:hour:${i}`);
    result[i] = Number(val ?? 0);
  }
  return c.json(result);
});

// By day (0=Sun, 6=Sat)
api.get('/friction/by-day', async (c) => {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
  const result: Record<string, number> = {};
  for (let i = 0; i < 7; i++) {
    const val = await redis.get(`friction:day:${i}`);
    const dayName = days[i as 0|1|2|3|4|5|6];
    result[dayName] = Number(val ?? 0);
  }
  return c.json(result);
});