import { Hono } from 'hono';
import type { OnModActionRequest, TriggerResponse } from '@devvit/web/shared';
import { redis } from '@devvit/web/server';

export const triggers = new Hono();

triggers.post('/on-mod-action', async (c) => {
  const input = await c.req.json<OnModActionRequest>();

  // Only care about approve actions
  if (
    input.action !== 'approvelink' &&
    input.action !== 'approvecomment'
  ) {
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }

  const targetPost = input.targetPost;
  const targetComment = input.targetComment;
  const subredditName = input.subreddit?.name;

  const targetId = targetPost?.id ?? targetComment?.id;
  const flair = targetPost?.linkFlair?.text ?? 'no-flair';

  if (!targetId || !subredditName) {
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }

  // TODO Day 2 part 2: verify AutoMod was previous actor via mod log
  // For now increment on every approve to confirm Redis is working

  const now = new Date();
  const hour = now.getUTCHours();
  const day = now.getUTCDay();

  await Promise.all([
    redis.incrBy('friction:total', 1),
    redis.incrBy(`friction:flair:${flair}`, 1),
    redis.incrBy(`friction:hour:${hour}`, 1),
    redis.incrBy(`friction:day:${day}`, 1),
  ]);

  console.log(`False positive recorded — id: ${targetId}, flair: ${flair}, hour: ${hour}, day: ${day}`);

  return c.json<TriggerResponse>({ status: 'success' }, 200);
});