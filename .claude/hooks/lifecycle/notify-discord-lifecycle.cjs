// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';

/**
 * notify-discord-lifecycle.cjs — A4.5 lifecycle subscriber.
 *
 * Subscribes to: postInstall, postUpdate
 *
 * Purpose: send a Discord webhook notification when a kit/module install or
 * update completes. One embed per lifecycle event, NOT per hook fire — cuts
 * Discord notification noise vs. ad-hoc per-hook posting in the CLI.
 *
 * Configuration: webhook URL from DISCORD_WEBHOOK_URL or T1K_DISCORD_WEBHOOK
 * env vars (matches existing notify-discord.cjs pattern). Silent no-op if
 * neither is set — Discord notifications are opt-in by env, not by registry.
 *
 * Coexists with the existing notify-discord.cjs (Stop hook for session-end
 * notifications). They fire on different events so there's no double-firing.
 *
 * Idempotency: declared `idempotent: true`. Discord webhook POSTs are
 * naturally idempotent at the webhook level — the same payload posted twice
 * results in two separate messages (a noisy doubling, not data corruption).
 * Subscribers downstream that care about strict once-only delivery should
 * include the lifecycleRunId in their de-dup key. The hub does NOT runtime-
 * dedup per Q4.
 *
 * Fail-open: every step in try/catch. Network failure must NEVER block the
 * lifecycle hub or block subsequent subscribers from firing.
 *
 * Spec: plans/260422-1905-safety-addendum-implementation/artifacts/a4-design-decisions.md §Q3
 */

const TARGET_EVENTS = new Set(['postInstall', 'postUpdate']);

function resolveWebhookUrl() {
  return process.env.DISCORD_WEBHOOK_URL || process.env.T1K_DISCORD_WEBHOOK || null;
}

/**
 * Build the embed object for a given event + payload. Pure — no I/O.
 * Exported for tests.
 */
function buildEmbed(eventType, payload) {
  if (!payload || typeof payload !== 'object') {
    payload = {};
  }
  const fields = [];
  if (typeof payload.kit === 'string') fields.push({ name: 'Kit', value: payload.kit, inline: true });
  if (typeof payload.module === 'string') fields.push({ name: 'Module', value: payload.module, inline: true });
  if (typeof payload.target === 'string') fields.push({ name: 'Target', value: payload.target, inline: true });
  if (eventType === 'postInstall' && typeof payload.version === 'string') {
    fields.push({ name: 'Version', value: payload.version, inline: true });
  }
  if (eventType === 'postUpdate') {
    if (typeof payload.fromVersion === 'string') fields.push({ name: 'From', value: payload.fromVersion, inline: true });
    if (typeof payload.toVersion === 'string') fields.push({ name: 'To', value: payload.toVersion, inline: true });
  }
  if (typeof payload.durationMs === 'number') {
    fields.push({ name: 'Duration', value: `${payload.durationMs} ms`, inline: true });
  }
  if (typeof payload.success === 'boolean') {
    fields.push({ name: 'Success', value: payload.success ? '✓' : '✗', inline: true });
  }
  const titleByEvent = {
    postInstall: 'TheOneKit — install completed',
    postUpdate: 'TheOneKit — update completed',
  };
  const colorByEvent = {
    postInstall: 0x57F287, // Discord green
    postUpdate: 0x5865F2,  // Discord blurple
  };
  return {
    title: titleByEvent[eventType] || `TheOneKit — ${eventType}`,
    color: colorByEvent[eventType] || 0x5865F2,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: 'theonekit-core notify-discord-lifecycle' },
  };
}

/**
 * POST the embed to Discord. Returns a Promise resolving when done; rejects
 * are swallowed by the caller's try/catch. Uses native fetch (Node 18+).
 */
function postToDiscord(webhookUrl, embed) {
  if (typeof fetch !== 'function') return Promise.resolve(); // older Node — no-op
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);
  return fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'TheOneKit',
      embeds: [embed],
    }),
    signal: controller.signal,
  })
    .catch(() => { /* fail-open — never block on network error */ })
    .finally(() => clearTimeout(timeoutId));
}

/**
 * Subscriber registration entry point per A4.5 loader contract.
 * Registers exactly one handler for entry.event (postInstall or postUpdate).
 */
module.exports = function register(lifecycle, entry) {
  if (!entry || !TARGET_EVENTS.has(entry.event)) return;
  lifecycle.subscribe(
    entry.event,
    (payload) => {
      try {
        const webhookUrl = resolveWebhookUrl();
        if (!webhookUrl) return; // not configured — silent skip (opt-in by env)
        const embed = buildEmbed(entry.event, payload);
        postToDiscord(webhookUrl, embed).catch(() => { /* fail-open */ });
      } catch {
        // fail-open per A3 contract
      }
    },
    {
      priority: typeof entry.priority === 'number' ? entry.priority : 100,
      subscriberId: typeof entry.subscriberId === 'string' ? entry.subscriberId : 'notify-discord-lifecycle',
    }
  );
};

// Test exports — implementation detail, not public API.
module.exports._buildEmbed = buildEmbed;
module.exports._resolveWebhookUrl = resolveWebhookUrl;
module.exports._TARGET_EVENTS = Array.from(TARGET_EVENTS);
