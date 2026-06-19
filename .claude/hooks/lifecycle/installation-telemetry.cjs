// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';

/**
 * installation-telemetry.cjs — universal lifecycle subscriber (A4.5).
 *
 * Listens to ALL 5 lifecycle events and appends one structured JSON line per
 * event to <claudeDir>/telemetry/install-events.jsonl. Provides a local
 * audit trail for install/update/rollback activity that doctor and triage
 * tooling can grep.
 *
 * Why JSONL (not SQLite):
 *   - Zero deps — Node fs.appendFileSync only
 *   - Cross-platform safe (no native bindings to compile per OS)
 *   - Mirrors the existing pending-skill-updates.jsonl pattern
 *   - Easy to grep / jq / consume from any tool
 *
 * Idempotency contract: declared `idempotent: true` in lifecycle.json. The
 * append is naturally append-only; same event firing twice would write two
 * rows. Subscribers downstream of the JSONL (tooling, telemetry workers)
 * can de-dup via lifecycleRunId + event type if needed. The hub does NOT
 * de-dup runtime invocations per Q4.
 *
 * Fail-open: any I/O error swallowed via try/catch — telemetry failure must
 * NEVER block the lifecycle hub or the SessionStart hook.
 *
 * Spec: plans/260422-1905-safety-addendum-implementation/artifacts/a4-design-decisions.md §Q3
 */

const fs = require('fs');
const path = require('path');

const ALL_EVENTS = ['preInstall', 'postInstall', 'preUpdate', 'postUpdate', 'rollback'];

/**
 * Resolve the .claude dir that owns this subscriber file. Walks up from
 * __dirname which is always `<claudeDir>/hooks/lifecycle/` for installed
 * subscribers. Returns null if the directory walk fails (treat as no-op).
 */
function resolveClaudeDir() {
  // __dirname = <claudeDir>/hooks/lifecycle  →  parent.parent = <claudeDir>
  try {
    const claudeDir = path.resolve(__dirname, '..', '..');
    if (path.basename(claudeDir) === '.claude') return claudeDir;
    // Defensive — directory layout differs from expected. Bail out.
    return null;
  } catch {
    return null;
  }
}

/**
 * Append one JSON line per event. Includes the event type, ISO timestamp,
 * and the entire payload (no field stripping — the schema in
 * schemas/lifecycle-payload.schema.json already excludes PII).
 */
function appendEventRow(claudeDir, eventType, payload) {
  try {
    const telemetryDir = path.join(claudeDir, 'telemetry');
    if (!fs.existsSync(telemetryDir)) {
      fs.mkdirSync(telemetryDir, { recursive: true });
    }
    const filePath = path.join(telemetryDir, 'install-events.jsonl');
    const row = {
      ts: new Date().toISOString(),
      event: eventType,
      payload: payload || {},
    };
    fs.appendFileSync(filePath, JSON.stringify(row) + '\n', { mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch { /* non-critical */ }
  } catch {
    // fail-open per A3 contract — telemetry failure must NEVER block hooks
  }
}

/**
 * Subscriber registration entry point. The hook-runner loader calls this
 * once per matching lifecycle.json entry (A4.5 contract). The loader passes
 * (lifecycle, entry) — we register ONE handler for the specific entry.event.
 *
 * To listen to multiple events, the registry must contain one entry per event
 * (each with a unique subscriberId per the schema). Five entries → five
 * registrations of this same handler logic.
 */
module.exports = function register(lifecycle, entry) {
  const claudeDir = resolveClaudeDir();
  if (!claudeDir) return;
  if (!entry || !ALL_EVENTS.includes(entry.event)) return;
  lifecycle.subscribe(
    entry.event,
    (payload) => appendEventRow(claudeDir, entry.event, payload),
    {
      priority: typeof entry.priority === 'number' ? entry.priority : 100,
      subscriberId: typeof entry.subscriberId === 'string' ? entry.subscriberId : 'installation-telemetry',
    }
  );
};

// Exported for unit tests — implementation detail, not public API.
module.exports._appendEventRow = appendEventRow;
module.exports._resolveClaudeDir = resolveClaudeDir;
