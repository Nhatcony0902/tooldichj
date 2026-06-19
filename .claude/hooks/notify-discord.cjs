#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
// notify-discord.cjs — Stop hook: sends Discord webhook notification on session end
// Reads DISCORD_WEBHOOK_URL env var. Silent no-op if not configured. Fail-open.
'use strict';
try {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL || process.env.T1K_DISCORD_WEBHOOK;
  if (!webhookUrl) process.exit(0); // not configured — silent skip

  const { parseHookStdin, resolveProjectDir } = require('./telemetry-utils.cjs');
  const input = parseHookStdin() || {};
  const stopReason = input.stop_reason || 'session_end';

  // Only notify on meaningful stop events
  const notifyEvents = (process.env.T1K_NOTIFY_EVENTS || 'session-end').split(',').map(s => s.trim());
  const eventMap = { end_turn: 'session-end', stop_sequence: 'session-end', tool_use: null };
  const mappedEvent = eventMap[stopReason] || 'session-end';
  if (!notifyEvents.includes(mappedEvent)) process.exit(0);

  const projectName = process.env.T1K_PROJECT_NAME
    || resolveProjectDir().projectName
    || 'unknown-project';

  const payload = JSON.stringify({
    username: 'TheOneKit',
    embeds: [{
      title: `Session ended — ${projectName}`,
      description: `Stop reason: \`${stopReason}\``,
      color: 0x5865F2,
      timestamp: new Date().toISOString(),
      footer: { text: 'theonekit-core notify-discord' },
    }],
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    signal: controller.signal,
  })
    .catch(() => {}) // fail-open — never block on network error
    .finally(() => { clearTimeout(timeout); process.exit(0); });

  setTimeout(() => process.exit(0), 4000);
} catch (e) {
  process.exit(0); // fail-open
}
