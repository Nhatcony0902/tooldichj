// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';

/**
 * lifecycle-detect.cjs — A4.2 detection helpers for the lifecycle hub.
 *
 * Locked design: plans/260422-1905-safety-addendum-implementation/artifacts/a4-design-decisions.md §Q1
 * Schema:        schemas/lifecycle-payload.schema.json
 * Spec:          docs/lifecycle-events.md
 *
 * Scope (A4.2 + A4.3 + A4.4): all 5 events — preInstall, postInstall,
 * preUpdate, postUpdate, rollback.
 *
 * Detection inputs:
 *   - PENDING marker:  <stagingRoot>/PENDING.json — written by CLI before staging
 *   - Current state:   <claudeDir>/metadata.json (kit name + version + installedAt)
 *   - Previous state:  <claudeDir>/.t1k-session-state.json (snapshot from prior SessionStart)
 *   - Snapshot dir:    <claudeDir>/.t1k-snapshots/<id>/RESTORED-AT marker — written by CLI
 *                      after `t1k install --reset` or `t1k doctor --nuke` restores
 *
 * Detection outputs (returned, NOT emitted): array of `{ type, payload }` events.
 * The caller (hook-runner.cjs) is responsible for actually calling
 * lifecycle.emit(...) — keeps this module side-effect-free for testability.
 *
 * Fail-open contract: any I/O / parse error returns `[]` and logs to telemetry
 * (caller-supplied logger). Detection NEVER throws.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PENDING_MARKER_NAME = 'PENDING.json';
const SESSION_STATE_FILE = '.t1k-session-state.json';

/**
 * Resolve the CLI's staging root: $T1K_STAGE_ROOT (test override) or
 * `~/.t1k-stage` (production default).
 */
function stagingRoot() {
  if (process.env.T1K_STAGE_ROOT) return process.env.T1K_STAGE_ROOT;
  return path.join(os.homedir(), '.t1k-stage');
}

/**
 * Read the CLI-written pending marker, if present.
 * Returns the parsed object, or null on absence/parse failure.
 */
function readPendingMarker(stageRoot, logErr) {
  const markerPath = path.join(stageRoot, PENDING_MARKER_NAME);
  if (!fs.existsSync(markerPath)) return null;
  try {
    const raw = fs.readFileSync(markerPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    safeLog(logErr, 'readPendingMarker', `parse failed: ${err.message}`);
    return null;
  }
}

/**
 * Read the previous-session snapshot. Returns the default empty shape if
 * missing (first run after install) so post* events still fire on initial install.
 *
 * Snapshot shape:
 *   { kits: { <name>: { version, installedAt } }, lastSeenSnapshotMtime: number }
 */
function readPreviousState(claudeDir, logErr) {
  const empty = { kits: {}, lastSeenSnapshotMtime: 0 };
  const statePath = path.join(claudeDir, SESSION_STATE_FILE);
  if (!fs.existsSync(statePath)) return empty;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return empty;
    return {
      kits: parsed.kits && typeof parsed.kits === 'object' ? parsed.kits : {},
      lastSeenSnapshotMtime: typeof parsed.lastSeenSnapshotMtime === 'number'
        ? parsed.lastSeenSnapshotMtime
        : 0,
    };
  } catch (err) {
    safeLog(logErr, 'readPreviousState', `parse failed: ${err.message}`);
    return empty;
  }
}

/**
 * Build the current-state snapshot from `<claudeDir>/metadata.json` and the
 * snapshot directory's most recent RESTORED-AT marker mtime.
 *
 * Shape:
 *   {
 *     kits: { <kitName>: { version, installedAt } },
 *     latestSnapshotMtime: number,          // 0 when no snapshots present
 *     latestSnapshotPath: string|null,      // absolute path to the snapshot dir
 *     latestRestoredAtPath: string|null     // absolute path to RESTORED-AT marker
 *   }
 *
 * metadata.json schema (per docs/architecture.md): top-level kit info plus
 * `installedModules[]`. We snapshot the kit name, version, and installedAt
 * for diff purposes; modules are out of A4 scope.
 */
function readCurrentState(claudeDir, logErr) {
  const out = { kits: {}, latestSnapshotMtime: 0, latestSnapshotPath: null, latestRestoredAtPath: null };

  const metaPath = path.join(claudeDir, 'metadata.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta && typeof meta === 'object') {
        const kitName = typeof meta.name === 'string' && meta.name.length > 0 ? meta.name : null;
        if (kitName) {
          out.kits[kitName] = {
            version: typeof meta.version === 'string' ? meta.version : null,
            installedAt: typeof meta.installedAt === 'string' ? meta.installedAt : null,
          };
        }
      }
    } catch (err) {
      safeLog(logErr, 'readCurrentState', `metadata parse failed: ${err.message}`);
    }
  }

  // Scan .t1k-snapshots/<id>/RESTORED-AT for the newest mtime — basis for rollback detection.
  const snapshotsDir = path.join(claudeDir, '.t1k-snapshots');
  if (fs.existsSync(snapshotsDir)) {
    try {
      for (const snapId of fs.readdirSync(snapshotsDir)) {
        const markerPath = path.join(snapshotsDir, snapId, 'RESTORED-AT');
        if (!fs.existsSync(markerPath)) continue;
        try {
          const stat = fs.statSync(markerPath);
          if (stat.mtimeMs > out.latestSnapshotMtime) {
            out.latestSnapshotMtime = stat.mtimeMs;
            out.latestSnapshotPath = path.join(snapshotsDir, snapId);
            out.latestRestoredAtPath = markerPath;
          }
        } catch (err) {
          safeLog(logErr, 'readCurrentState', `snapshot stat failed for ${snapId}: ${err.message}`);
        }
      }
    } catch (err) {
      safeLog(logErr, 'readCurrentState', `snapshot scan failed: ${err.message}`);
    }
  }

  return out;
}

/**
 * Persist the current state snapshot for the next SessionStart.
 * Stores only the diffable subset: `kits` and `lastSeenSnapshotMtime`
 * (so future runs can re-detect rollback from the same moment).
 * Best-effort: any I/O failure is logged but never thrown.
 */
function writeCurrentState(claudeDir, state, logErr) {
  try {
    const statePath = path.join(claudeDir, SESSION_STATE_FILE);
    const persisted = {
      kits: state.kits || {},
      lastSeenSnapshotMtime: state.latestSnapshotMtime || 0,
    };
    fs.writeFileSync(statePath, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  } catch (err) {
    safeLog(logErr, 'writeCurrentState', `write failed: ${err.message}`);
  }
}

/**
 * Generate one lifecycleRunId per detection pass. Subscribers correlate pre/post
 * pairs via this id.
 */
function newLifecycleRunId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Read and parse a RESTORED-AT marker. Marker format (one JSON object):
 *   { takenAt: ISO-8601, restoredAt: ISO-8601, reason: enum }
 * Missing fields default conservatively. Returns null if file unreadable.
 */
function readRestoredAtMarker(markerPath, logErr) {
  if (!markerPath || !fs.existsSync(markerPath)) return null;
  try {
    const raw = fs.readFileSync(markerPath, 'utf8');
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { takenAt: null, restoredAt: null, reason: 'manual' };
    // Allow either JSON or a plain ISO timestamp on first line for forward-compat.
    if (trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed);
      return {
        takenAt: typeof parsed.takenAt === 'string' ? parsed.takenAt : null,
        restoredAt: typeof parsed.restoredAt === 'string' ? parsed.restoredAt : null,
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'manual',
      };
    }
    return { takenAt: null, restoredAt: trimmed.split('\n')[0], reason: 'manual' };
  } catch (err) {
    safeLog(logErr, 'readRestoredAtMarker', `parse failed: ${err.message}`);
    return null;
  }
}

/**
 * Detect lifecycle events covering A4.2 + A4.3 + A4.4 — all 5 events.
 *
 * @param {object} prevState      — `{ kits, lastSeenSnapshotMtime }` from readPreviousState()
 * @param {object} currState      — `{ kits, latestSnapshotMtime, latestSnapshotPath, latestRestoredAtPath }` from readCurrentState()
 * @param {object|null} pending   — parsed PENDING.json or null
 * @param {string} installRoot    — absolute path to the .claude/ being installed into
 * @param {function} logErr       — telemetry logger; receives `{phase, error, ...}`
 * @returns {Array<{type: string, payload: object}>}
 */
function detectLifecycleEvents(prevState, currState, pending, installRoot, logErr) {
  const events = [];
  const runId = newLifecycleRunId();

  // ─── PRE* — CLI-written pending markers ───────────────────────────────
  if (pending && pending.action === 'install') {
    const payload = {
      kit: typeof pending.kit === 'string' ? pending.kit : 'unknown',
      version: typeof pending.version === 'string' ? pending.version : '0.0.0',
      installRoot,
      lifecycleRunId: runId,
    };
    if (typeof pending.module === 'string' && pending.module.length > 0) {
      payload.module = pending.module;
    }
    events.push({ type: 'preInstall', payload });
  } else if (pending && pending.action === 'update') {
    const target = typeof pending.target === 'string' && ['cli', 'kit', 'module'].includes(pending.target)
      ? pending.target
      : 'kit';
    const payload = {
      fromVersion: typeof pending.fromVersion === 'string' ? pending.fromVersion : '0.0.0',
      toVersion: typeof pending.toVersion === 'string' ? pending.toVersion : '0.0.0',
      target,
      installRoot,
      lifecycleRunId: runId,
    };
    if (target !== 'cli' && typeof pending.kit === 'string' && pending.kit.length > 0) {
      payload.kit = pending.kit;
    }
    if (typeof pending.module === 'string' && pending.module.length > 0) {
      payload.module = pending.module;
    }
    events.push({ type: 'preUpdate', payload });
  }

  // ─── POST* — state diff between prev snapshot and current metadata ────
  for (const [kitName, currMeta] of Object.entries(currState.kits || {})) {
    if (!currMeta) continue;
    const prevMeta = prevState.kits ? prevState.kits[kitName] : null;

    // postInstall: installedAt advanced (covers first-install AND re-install)
    if (currMeta.installedAt) {
      const installedAtAdvanced =
        !prevMeta ||
        !prevMeta.installedAt ||
        new Date(currMeta.installedAt).getTime() > new Date(prevMeta.installedAt).getTime();
      if (installedAtAdvanced) {
        const durationMs = pending && typeof pending.startedAt === 'string'
          ? Math.max(0, new Date(currMeta.installedAt).getTime() - new Date(pending.startedAt).getTime())
          : 0;
        events.push({
          type: 'postInstall',
          payload: {
            kit: kitName,
            version: currMeta.version || '0.0.0',
            installRoot,
            lifecycleRunId: runId,
            installedAt: currMeta.installedAt,
            durationMs,
            success: true,
          },
        });
        // installedAt advance also implies version may have changed, but this is
        // an install (not an update); skip the postUpdate branch below for this kit.
        continue;
      }
    }

    // postUpdate: same kit, version changed without installedAt advancing
    if (prevMeta && prevMeta.version && currMeta.version && currMeta.version !== prevMeta.version) {
      const durationMs = pending && typeof pending.startedAt === 'string'
        ? Math.max(0, Date.now() - new Date(pending.startedAt).getTime())
        : 0;
      events.push({
        type: 'postUpdate',
        payload: {
          kit: kitName,
          fromVersion: prevMeta.version,
          toVersion: currMeta.version,
          target: 'kit',
          installRoot,
          lifecycleRunId: runId,
          completedAt: new Date().toISOString(),
          durationMs,
          success: true,
        },
      });
    }
  }

  // ─── ROLLBACK — RESTORED-AT marker newer than last seen mtime ─────────
  if (currState.latestSnapshotMtime > (prevState.lastSeenSnapshotMtime || 0)) {
    const marker = readRestoredAtMarker(currState.latestRestoredAtPath, logErr);
    const validReasons = new Set(['doctor-nuke', 'install-reset', 'manual', 'auto-rollback-failed-update']);
    const reason = marker && validReasons.has(marker.reason) ? marker.reason : 'manual';
    events.push({
      type: 'rollback',
      payload: {
        snapshotPath: currState.latestSnapshotPath || '',
        snapshotTakenAt: (marker && marker.takenAt) || new Date(currState.latestSnapshotMtime).toISOString(),
        restoredAt: (marker && marker.restoredAt) || new Date(currState.latestSnapshotMtime).toISOString(),
        reason,
        lifecycleRunId: runId,
      },
    });
  }

  return events;
}

/**
 * Wrap caller-supplied logger so detection never throws when the logger does.
 */
function safeLog(logFn, phase, message) {
  if (typeof logFn !== 'function') return;
  try {
    logFn({ phase: `lifecycle-detect:${phase}`, error: message });
  } catch { /* never let telemetry failure affect detection */ }
}

module.exports = {
  detectLifecycleEvents,
  readPendingMarker,
  readPreviousState,
  readCurrentState,
  writeCurrentState,
  stagingRoot,
};
