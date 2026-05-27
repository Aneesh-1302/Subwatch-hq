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
      title: 'SubWatch — AutoMod Observability Dashboard',
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

