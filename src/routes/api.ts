import { Hono } from 'hono';
import { redis, reddit } from '@devvit/web/server';
import { getWhitelistedFlairs } from './triggers';

export const api = new Hono();

// Enforce moderator-only security
api.use('/friction/*', async (c, next) => {
  try {
    const subreddit = await reddit.getCurrentSubreddit();
    const username = await reddit.getCurrentUsername();
    if (!username) {
      return c.json({ error: 'Unauthorized: Missing user context' }, 401);
    }

    // Check if the current user is a moderator of the current subreddit
    const mods = await reddit.getModerators({ subredditName: subreddit.name, username }).all();
    const isMod = mods.length > 0;

    if (!isMod) {
      console.warn(`[ModOps] Access denied to non-moderator: ${username}`);
      return c.json({ error: 'Forbidden: Moderator eyes only' }, 403);
    }
  } catch (error) {
    console.error('[ModOps] Error in moderator security check:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
  await next();
});

// Total false positives & AutoMod removals count
api.get('/friction/total', async (c) => {
  const subreddit = await reddit.getCurrentSubreddit();
  const whitelist = await getWhitelistedFlairs(subreddit.name);
  const whitelistLower = whitelist.map(item => item.toLowerCase());

  const [total, removals, flairsResult] = await Promise.all([
    redis.get('friction:total'),
    redis.get('friction:removals'),
    redis.hGetAll('friction:flairs'),
  ]);

  // Sum up all false positive counts of resolved/whitelisted flairs
  let resolvedCount = 0;
  for (const [key, val] of Object.entries(flairsResult ?? {})) {
    if (whitelistLower.includes(key.toLowerCase())) {
      resolvedCount += Number(val);
    }
  }

  // Deduct resolved false positives from the active friction totals live!
  const adjustedTotal = Math.max(0, Number(total ?? 0) - resolvedCount);

  return c.json({ 
    total: adjustedTotal,
    removals: Number(removals ?? 0),
  });
});

// By flair
api.get('/friction/by-flair', async (c) => {
  const subreddit = await reddit.getCurrentSubreddit();
  const whitelist = await getWhitelistedFlairs(subreddit.name);
  const whitelistLower = whitelist.map(item => item.toLowerCase());

  const result = await redis.hGetAll('friction:flairs');
  const parsed: Record<string, number> = {};
  for (const [key, val] of Object.entries(result ?? {})) {
    // Dynamically exclude whitelisted flairs from active offenders
    if (!whitelistLower.includes(key.toLowerCase())) {
      parsed[key] = Number(val);
    }
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
    const dayName = days[i as 0 | 1 | 2 | 3 | 4 | 5 | 6];
    result[dayName] = Number(val ?? 0);
  }
  return c.json(result);
});