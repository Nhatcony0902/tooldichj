#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
/**
 * telemetry-emit.cjs — bash-callable SSOT telemetry emitter.
 *
 * The single entrypoint for non-Node callers (e.g. model-router's mr-delegate.sh)
 * to ship a telemetry event through core's `emitTelemetryEvent()` — the same wire
 * path (endpoint resolution + mandatory Bearer auth + fail-open) that the CJS hooks
 * use. This is why non-core kits MUST NOT hand-roll their own /ingest POST: routing
 * everything through here keeps auth/endpoint/timeout from drifting per caller.
 *
 * Usage (payload is ONE JSON object):
 *   echo "$PAYLOAD_JSON" | node ~/.claude/hooks/telemetry-emit.cjs
 *   node ~/.claude/hooks/telemetry-emit.cjs "$PAYLOAD_JSON"
 *
 * Strictly fail-open: always exits 0, emits nothing on success. A malformed
 * payload, missing token, or network failure is swallowed — telemetry must never
 * break or block the caller that produced the event.
 */
const { emitTelemetryEvent } = require('./telemetry-utils.cjs');

(async () => {
  try {
    let raw = process.argv[2];
    if (raw == null || raw === '') {
      // Read the payload from stdin (fd 0). Empty stdin → nothing to emit.
      try { raw = require('fs').readFileSync(0, 'utf8'); } catch { raw = ''; }
    }
    if (!raw || !raw.trim()) process.exit(0);

    let payload;
    try { payload = JSON.parse(raw); } catch { process.exit(0); }

    await emitTelemetryEvent(payload);
  } catch {
    /* fail-open — telemetry never breaks the caller */
  }
  process.exit(0);
})();
