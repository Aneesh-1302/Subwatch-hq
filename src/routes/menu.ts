import { Hono } from 'hono';
import { reddit } from '@devvit/web/server';

export const menu = new Hono();

menu.post('/create-dashboard', async (c) => {
  try {
    const subreddit = await reddit.getCurrentSubreddit();

    await reddit.submitCustomPost({
      subredditName: subreddit.name,
      title: 'SubWatch HQ — AutoMod Observability Dashboard',
      textFallback: { text: 'SubWatch HQ — AutoMod false positive analytics.' },
    });

    return c.json({ status: 'success' }, 200);
  } catch (e) {
    console.error('Failed to create dashboard post', e);
    return c.json({ status: 'error' }, 500);
  }
});