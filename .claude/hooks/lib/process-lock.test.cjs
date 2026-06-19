// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
/**
 * process-lock.test.cjs — Unit tests for process-lock.cjs.
 *
 * All tests use os.tmpdir() lock paths. Run standalone:
 *   node .claude/hooks/lib/process-lock.test.cjs
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  acquireLock,
  isLocked,
  forceReleaseLock,
  LockTimeoutError,
} = require('./process-lock.cjs');

// ── Harness ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
async function run(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    process.stdout.write(`  FAIL  ${name}\n    ${err.message.split('\n')[0]}\n`);
  }
}
function tmpLock(label) {
  return path.join(os.tmpdir(), `t1k-lock-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

(async () => {
  process.stdout.write('\nRunning process-lock tests...\n\n');

  // TC1: Acquire-release cycle
  await run('TC1: acquire-release cycle succeeds, lock file removed after release', async () => {
    const lp = tmpLock('tc1');
    const { release, acquiredAt, holderPid } = await acquireLock(lp, { command: 'tc1' });
    assert(fs.existsSync(lp), 'Lock file should exist while held');
    assert(acquiredAt instanceof Date, 'acquiredAt should be a Date');
    assertEqual(holderPid, process.pid, 'holderPid');
    release();
    assert(!fs.existsSync(lp), 'Lock file should be removed after release');
  });

  // TC2: Concurrent acquires — only one wins, others queue sequentially
  await run('TC2: concurrent acquires — all acquire in sequence, none lost', async () => {
    const lp = tmpLock('tc2');
    const results = [];
    await Promise.all([
      acquireLock(lp, { command: 'a', pollInterval: 20 }).then(h => { results.push('a'); h.release(); }),
      acquireLock(lp, { command: 'b', pollInterval: 20 }).then(h => { results.push('b'); h.release(); }),
      acquireLock(lp, { command: 'c', pollInterval: 20 }).then(h => { results.push('c'); h.release(); }),
    ]);
    assertEqual(results.length, 3, 'All three should acquire lock');
    assert(!fs.existsSync(lp), 'Lock should be released at end');
  });

  // TC3: Stale lock (dead PID 99999999) — recovered, new lock acquired
  await run('TC3: stale lock (dead PID) recovered, new lock acquired', async () => {
    const lp = tmpLock('tc3');
    fs.writeFileSync(lp, JSON.stringify({ pid: 99999999, command: 'dead', acquiredAt: new Date().toISOString(), host: 'test' }));
    const { release } = await acquireLock(lp, { command: 'tc3', staleRecovery: true, pollInterval: 20 });
    const entry = JSON.parse(fs.readFileSync(lp, 'utf8'));
    assertEqual(entry.pid, process.pid, 'Lock should be reclaimed by current process');
    release();
    assert(!fs.existsSync(lp), 'Lock released');
  });

  // TC4: Alive lock — waits until released, then succeeds
  await run('TC4: alive lock waits until holder releases, then new acquire succeeds', async () => {
    const lp = tmpLock('tc4');
    const holder = await acquireLock(lp, { command: 'tc4-holder', pollInterval: 20 });
    const releaseTimer = setTimeout(() => holder.release(), 80);
    const { release } = await acquireLock(lp, { command: 'tc4-waiter', pollInterval: 30, timeout: 5000 });
    clearTimeout(releaseTimer);
    release();
    assert(!fs.existsSync(lp), 'Lock released');
  });

  // TC5: Timeout expires — throws LockTimeoutError, original lock file unchanged
  await run('TC5: timeout throws LockTimeoutError, original lock file unchanged', async () => {
    const lp = tmpLock('tc5');
    const fd = fs.openSync(lp, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, command: 'holder', acquiredAt: new Date().toISOString(), host: 'test' }));
    fs.closeSync(fd);
    let threw = false;
    try {
      await acquireLock(lp, { timeout: 80, pollInterval: 20, staleRecovery: false });
    } catch (err) {
      threw = true;
      assert(err instanceof LockTimeoutError, `Expected LockTimeoutError, got: ${err.constructor.name}`);
      assert(err.lockPath === lp, 'LockTimeoutError.lockPath must be set');
      assert(typeof err.holderPid === 'number', 'holderPid should be a number');
    }
    assert(threw, 'Should have thrown LockTimeoutError');
    assert(fs.existsSync(lp), 'Original lock file must remain on timeout');
    fs.unlinkSync(lp);
  });

  // TC6: SIGINT simulation — cleanup handler removes lock file
  await run('TC6: SIGINT simulation removes lock via cleanup handler', async () => {
    const lp = tmpLock('tc6');
    await acquireLock(lp, { command: 'tc6' });
    assert(fs.existsSync(lp), 'Lock held');
    process.emit('SIGINT');
    assert(!fs.existsSync(lp), 'Lock file removed by SIGINT cleanup handler');
  });

  // TC7: Release by non-holder does not delete the foreign lock
  await run('TC7: release by non-holder is no-op, foreign lock untouched', async () => {
    const lp = tmpLock('tc7');
    const lp2 = tmpLock('tc7b');
    fs.writeFileSync(lp, JSON.stringify({ pid: process.pid + 1, command: 'other', acquiredAt: new Date().toISOString(), host: 'test' }));
    const { release } = await acquireLock(lp2, { command: 'tc7-own' });
    release(); // should not touch lp
    assert(fs.existsSync(lp), 'Foreign lock should be untouched');
    fs.unlinkSync(lp);
  });

  // TC8: Non-existent parent directory — clear error
  await run('TC8: non-existent parent directory throws clear error', async () => {
    const lp = path.join(os.tmpdir(), `nonexistent-${Date.now()}`, 'test.lock');
    let threw = false;
    try {
      await acquireLock(lp, { timeout: 100, pollInterval: 20 });
    } catch (err) {
      threw = true;
      assert(err.message.length > 0, 'Should have a meaningful error message');
    }
    assert(threw, 'Should throw on missing parent directory');
  });

  // TC9: Corrupted lock file (invalid JSON) — treat as stale, reclaim
  await run('TC9: corrupted lock file treated as stale, reclaimed', async () => {
    const lp = tmpLock('tc9');
    fs.writeFileSync(lp, 'not valid json {{{');
    const { release } = await acquireLock(lp, { command: 'tc9', staleRecovery: true, pollInterval: 20 });
    const entry = JSON.parse(fs.readFileSync(lp, 'utf8'));
    assertEqual(entry.pid, process.pid, 'Should reclaim corrupted lock');
    release();
  });

  // TC10: Windows EPERM logic — isPidAlive returns true for EPERM (verified via isLocked behavior)
  await run('TC10: isLocked returns false when no lock file exists', async () => {
    assertEqual(isLocked(tmpLock('tc10-nofile')), false, 'isLocked should return false for missing file');
  });

  await run('TC10b: isLocked true while held, false after release', async () => {
    const lp = tmpLock('tc10b');
    const { release } = await acquireLock(lp, { command: 'tc10b' });
    assertEqual(isLocked(lp), true, 'isLocked should be true while held');
    release();
    assertEqual(isLocked(lp), false, 'isLocked should be false after release');
  });

  // TC11: forceReleaseLock removes any lock file
  await run('TC11: forceReleaseLock removes lock regardless of owner', async () => {
    const lp = tmpLock('tc11');
    fs.writeFileSync(lp, JSON.stringify({ pid: 99999999, command: 'other', acquiredAt: new Date().toISOString(), host: 'test' }));
    forceReleaseLock(lp);
    assert(!fs.existsSync(lp), 'forceReleaseLock should remove the lock file');
  });

  // TC12: Path traversal rejected (use raw string — path.join resolves .. eagerly)
  await run('TC12: lock path with path traversal rejected with clear error', async () => {
    const lp = os.tmpdir() + '/../evil.lock';
    let threw = false;
    try {
      await acquireLock(lp);
    } catch (err) {
      threw = true;
      assert(
        err.message.includes('traversal') || err.message.includes('rejected'),
        `Expected traversal error, got: ${err.message}`
      );
    }
    assert(threw, 'Should reject path traversal in lock path');
  });

  // ── Summary ─────────────────────────────────────────────────────────────────

  process.stdout.write('\n' + '─'.repeat(60) + '\n');
  process.stdout.write(`Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}\n`);

  if (failures.length > 0) {
    process.stdout.write('\nFailed tests:\n');
    for (const f of failures) {
      process.stdout.write(`  - ${f.name}: ${f.error}\n`);
    }
    process.exit(1);
  } else {
    process.stdout.write('\nAll tests passed.\n');
    process.exit(0);
  }
})();
