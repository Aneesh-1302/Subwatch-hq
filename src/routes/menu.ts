import { Hono } from 'hono';
import { reddit, redis } from '@devvit/web/server';
import type { UiResponse } from '@devvit/web/shared';

export const menu = new Hono();

// ─── Create Dashboard Post ─────────────────────────────────────────

menu.post('/create-dashboard', async (c) => {
  try {
    const subreddit = await reddit.getCurrentSubreddit();

    await reddit.submitCustomPost({
      subredditName: subreddit.name,
      title: '📊 SubWatch — AutoMod Observability Dashboard',
      textFallback: { text: 'SubWatch — AutoMod false positive analytics for this subreddit.' },
    });

    return c.json<UiResponse>(
      {
        showToast: 'SubWatch Dashboard created! Check the new post in your subreddit.',
      },
      200
    );
  } catch (e) {
    console.error('Failed to create dashboard post:', e);
    return c.json<UiResponse>(
      {
        showToast: 'Failed to create dashboard. Please try again.',
      },
      200
    );
  }
});

// ─── Seed Demo Data ─────────────────────────────────────────────────

/**
 * Populates Redis with realistic demo data for the hackathon presentation.
 * Designed to make the dashboard look populated and professional.
 *
 * Data profile:
 *   - 47 total false positives
 *   - 6 flair categories with realistic distribution
 *   - Hourly distribution peaking in US afternoon (UTC 14-20)
 *   - Daily distribution peaking on weekdays
 */
menu.post('/seed-demo-data', async (c) => {
  try {
    // ── Flair breakdown (sum = 47) ──
    const flairData: Record<string, number> = {
      'News':       15,
      'Discussion': 12,
      'Meme':        8,
      'Question':    6,
      'Meta':        4,
      'no-flair':    2,
    };

    // ── Hourly breakdown (sum = 47, peak at UTC 15-18) ──
    const hourData: Record<number, number> = {
      0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0,
      6: 1, 7: 1, 8: 2, 9: 2, 10: 3, 11: 3,
      12: 4, 13: 4, 14: 5, 15: 6, 16: 5, 17: 4,
      18: 3, 19: 2, 20: 1, 21: 1, 22: 0, 23: 0,
    };

    // ── Daily breakdown (sum = 47, peak on weekdays) ──
    // 0=Sun, 1=Mon, ..., 6=Sat
    const dayData: Record<number, number> = {
      0: 4,  // Sun
      1: 8,  // Mon
      2: 9,  // Tue
      3: 8,  // Wed
      4: 7,  // Thu
      5: 6,  // Fri
      6: 5,  // Sat
    };

    // ── Clear existing data first ──
    const keysToDelete = [
      'friction:total',
      'friction:removals',
      'friction:flairs',
      ...Array.from({ length: 24 }, (_, i) => `friction:hour:${i}`),
      ...Array.from({ length: 7 }, (_, i) => `friction:day:${i}`),
    ];

    for (const key of keysToDelete) {
      await redis.del(key);
    }

    // ── Write seed data ──
    const total = Object.values(flairData).reduce((sum, v) => sum + v, 0);

    const writes: Promise<unknown>[] = [
      redis.incrBy('friction:total', total),
      redis.incrBy('friction:removals', 470),
    ];

    // Flair hash
    for (const [flair, count] of Object.entries(flairData)) {
      writes.push(redis.hIncrBy('friction:flairs', flair, count));
    }

    // Hourly counters
    for (const [hour, count] of Object.entries(hourData)) {
      if (count > 0) {
        writes.push(redis.incrBy(`friction:hour:${hour}`, count));
      }
    }

    // Daily counters
    for (const [day, count] of Object.entries(dayData)) {
      if (count > 0) {
        writes.push(redis.incrBy(`friction:day:${day}`, count));
      }
    }

    await Promise.all(writes);

    console.log(`[ModOps] Demo data seeded: ${total} total false positives`);

    return c.json<UiResponse>(
      {
        showToast: `Demo data seeded! ${total} false positives across 6 flairs. Refresh the dashboard to see it.`,
      },
      200
    );
  } catch (e) {
    console.error('[ModOps] Failed to seed demo data:', e);
    return c.json<UiResponse>(
      {
        showToast: 'Failed to seed demo data. Check console for errors.',
      },
      200
    );
  }
});