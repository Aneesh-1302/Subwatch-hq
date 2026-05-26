import { Hono } from 'hono';
import type { OnModActionRequest, TriggerResponse } from '@devvit/web/shared';
import { redis, reddit } from '@devvit/web/server';

export const triggers = new Hono();

/**
 * AutoMod False Positive Detection Pipeline
 *
 * Logic:
 *   1. Trigger fires on every mod action in the subreddit.
 *   2. We only care about approve actions (approvelink / approvecomment).
 *   3. When a human mod approves, we look up the mod log for the same target
 *      to see if AutoModerator previously removed it.
 *   4. If AutoMod was the prior remover → it's a false positive → increment counters.
 *   5. If not → it was a regular approval → skip silently.
 */

const AUTOMOD_USERNAME = 'AutoModerator';

triggers.post('/on-mod-action', async (c) => {
  const input = await c.req.json<OnModActionRequest>();

  const targetPost = input.targetPost;
  const targetComment = input.targetComment;
  const subredditName = input.subreddit?.name;
  const targetId = targetPost?.id ?? targetComment?.id;

  // Step 1: Check if this is an AutoMod removal action to count total removals (Friction Index Approach A)
  const isAutoModActor = input.moderator?.name === AUTOMOD_USERNAME;
  if (
    isAutoModActor &&
    (input.action === 'removelink' || input.action === 'removecomment')
  ) {
    await redis.incrBy('friction:removals', 1);
    console.log(`[SubWatch] AutoMod removal tracked: ${targetId}`);

    // Core Auto-Remediation System:
    // If the post was removed by AutoMod, we check if it has the whitelisted flair.
    // Since Reddit's desktop client has a minor race condition, we wait 1.5 seconds, then query the post state.
    if (input.action === 'removelink' && targetId) {
      try {
        console.log(`[SubWatch] Waiting 1.5s for flair synchronization on ${targetId}...`);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        
        console.log(`[SubWatch] Fetching fresh details for post ${targetId}...`);
        const post = await reddit.getPostById(targetId as `t3_${string}`);
        const postFlair = post.flair?.text?.trim();
        
        // Fetch all active whitelisted flairs from the live AutoMod wiki configurations
        const whitelist = await getWhitelistedFlairs(subredditName || '');
        const isWhitelisted = postFlair && whitelist.some(item => item.toLowerCase() === postFlair.toLowerCase());
        
        // If the post carries a whitelisted flair, auto-approve and restore it!
        if (isWhitelisted) {
          console.log(`[SubWatch] ⚡ Auto-Remediation Triggered! Post ${targetId} carries whitelisted flair "${postFlair}". Restoring...`);
          await reddit.approve(targetId as `t3_${string}`);
          console.log(`[SubWatch] ✓ Post ${targetId} successfully auto-remediated and approved!`);
        } else {
          console.log(`[SubWatch] Post ${targetId} flair is "${postFlair || 'none'}". No auto-remediation exception matched in [${whitelist.join(', ')}].`);
        }
      } catch (err) {
        console.error('[SubWatch] Auto-remediation failed:', err);
      }
    }

    return c.json<TriggerResponse>({}, 200);
  }

  // Step 2: Only care about approve actions beyond this point
  if (
    input.action !== 'approvelink' &&
    input.action !== 'approvecomment'
  ) {
    return c.json<TriggerResponse>({}, 200);
  }

  const flair = targetPost?.linkFlair?.text || 'no-flair';

  if (!targetId || !subredditName) {
    console.log(`[ModOps] Skipping: missing targetId or subredditName`);
    return c.json<TriggerResponse>({}, 200);
  }

  // Step 2: Check if this target was already processed (deduplication)
  const dedupeKey = `modops:processed:${targetId}`;
  const alreadyProcessed = await redis.get(dedupeKey);
  if (alreadyProcessed) {
    console.log(`[ModOps] Skipping duplicate: ${targetId} already processed`);
    return c.json<TriggerResponse>({}, 200);
  }

  // Step 3: Query mod log to verify AutoMod was the previous actor
  const isAutoModFalsePositive = await checkAutoModRemoval(
    subredditName,
    targetId,
    input.action === 'approvelink' ? 'removelink' : 'removecomment'
  );

  if (!isAutoModFalsePositive) {
    console.log(`[ModOps] Not an AutoMod false positive — skipping (target: ${targetId})`);
    return c.json<TriggerResponse>({}, 200);
  }

  // Step 4: It's a confirmed AutoMod false positive — increment all counters
  const now = new Date();
  const hour = now.getUTCHours();
  const day = now.getUTCDay();

  await Promise.all([
    redis.incrBy('friction:total', 1),
    redis.hIncrBy('friction:flairs', flair, 1),
    redis.incrBy(`friction:hour:${hour}`, 1),
    redis.incrBy(`friction:day:${day}`, 1),
    // Mark as processed (expire after 7 days to prevent unbounded growth)
    redis.set(dedupeKey, '1', { expiration: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }),
  ]);

  console.log(
    `[ModOps] ✓ AutoMod false positive confirmed — id: ${targetId}, flair: "${flair}", hour: ${hour}, day: ${day}`
  );

  return c.json<TriggerResponse>({}, 200);
});

/**
 * Queries the subreddit mod log to check if AutoModerator previously
 * removed the target post/comment.
 *
 * Strategy: Fetch recent removal actions by AutoModerator and check
 * if any target the same content ID.
 */
async function checkAutoModRemoval(
  subredditName: string,
  targetId: string,
  removalAction: 'removelink' | 'removecomment'
): Promise<boolean> {
  try {
    const modLog = reddit.getModerationLog({
      subredditName,
      moderatorUsernames: [AUTOMOD_USERNAME],
      type: removalAction,
      limit: 100,
      pageSize: 100,
    });

    // Iterate through AutoMod's recent removals to find a match
    const actions = await modLog.all();

    for (const action of actions) {
      const actionTargetId = action.target?.id;

      if (!actionTargetId) continue;

      // The target IDs in mod log may or may not include the t1_/t3_ prefix.
      // Normalize both for comparison.
      const normalizedActionTarget = stripPrefix(actionTargetId);
      const normalizedTarget = stripPrefix(targetId);

      if (normalizedActionTarget === normalizedTarget) {
        console.log(
          `[ModOps] AutoMod removal confirmed — target: ${targetId}, action: ${action.type}, mod: ${action.moderatorName}`
        );
        return true;
      }
    }

    console.log(
      `[ModOps] No AutoMod removal found for target: ${targetId} (checked ${actions.length} actions)`
    );
    return false;
  } catch (error) {
    console.error(`[ModOps] Error querying mod log for AutoMod verification:`, error);
    // On error, fail open — don't count as false positive
    return false;
  }
}

/**
 * Strips the Reddit type prefix (t1_, t3_, etc.) from an ID for comparison.
 */
function stripPrefix(id: string): string {
  return id.replace(/^t\d_/, '');
}

/**
 * Dynamically parses the AutoModerator wiki configuration to extract whitelisted flairs.
 * Falls back to a default sandbox list if the wiki page does not exist or is inaccessible.
 */
export async function getWhitelistedFlairs(subredditName: string): Promise<string[]> {
  try {
    console.log(`[SubWatch] Fetching config/automoderator wiki page for r/${subredditName}...`);
    const wikiPage = await reddit.getWikiPage(subredditName, 'config/automoderator');
    
    const content = wikiPage.content || '';
    const whitelisted: string[] = [];
    
    // Regular expression to extract elements from flair whitelists, e.g.:
    // ~flair_text: ["News", "Discussion"] or ~flair_text (includes): ["News"]
    const regex = /~flair_text(?:\s*\(includes\))?:\s*\[([^\]]+)\]/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      if (match[1]) {
        // Split by comma and clean up quotes/whitespace
        const flairs = match[1]
          .split(',')
          .map(f => f.replace(/['" ]/g, '').trim())
          .filter(Boolean);
        whitelisted.push(...flairs);
      }
    }
    
    console.log(`[SubWatch] Live parsed whitelisted flairs from AutoMod wiki: ${JSON.stringify(whitelisted)}`);
    return whitelisted;
  } catch (e) {
    console.warn(`[SubWatch] Wiki page config/automoderator not accessible, using sandbox fallback:`, e);
    // High-fidelity sandbox demo fallback:
    return ['News', 'Discussion', 'Meme', 'Questions', 'Feedback', 'Meta'];
  }
}