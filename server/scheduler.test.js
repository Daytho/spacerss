/**
 * Regression test for a race condition in the manual-refresh cooldown.
 *
 * refreshNow() is meant to collapse concurrent triggers (the stated case is
 * "dashboard open in two tabs") into a single network fetch. The guard used to
 * read the last-ingest timestamp, then only write a new one once the whole
 * fetch-and-insert cycle finished — so two overlapping calls both read the
 * stale timestamp, both passed the cooldown check, and both fired real
 * requests at all twelve feeds. This stubs the network layer and fires two
 * concurrent calls to prove only one fetch happens.
 *
 * Run: node server/scheduler.test.js
 */
const path = require('path');
const Module = require('module');

let fetchCount = 0;
let releaseFetch = null;

// Intercept ./feeds before scheduler.js (or db.js) can require the real thing —
// the real module opens network sockets, which has no place in a unit test.
const feedsPath = require.resolve('./feeds');
require.cache[feedsPath] = new Module(feedsPath);
require.cache[feedsPath].exports = {
  SOURCES: [],
  fetchAllFeeds: () => {
    fetchCount += 1;
    // Held open deliberately: a call that resolved instantly would never
    // overlap with a second call in the first place, defeating the test.
    return new Promise((resolve) => { releaseFetch = () => resolve([]); });
  },
};

// db.js resolves DB_PATH relative to process.cwd() and would touch the real
// project database; point it at a throwaway file for this test instead.
const os = require('os');
const fs = require('fs');
const tmpDbPath = path.join(os.tmpdir(), `spacerss-scheduler-test-${Date.now()}.db`);
process.env.DB_PATH = tmpDbPath;
process.on('exit', () => {
  // Windows refuses to delete a file that is still open, so the SQLite handle
  // has to be closed before unlinking — on Linux the unlink would succeed
  // regardless, which is why this only ever failed on Windows. Every step is
  // best-effort: leaving a stray temp file behind is a far better outcome than
  // a cleanup error crashing an otherwise-passing test run.
  try {
    require('./db').close();
  } catch { /* not open, or already closed */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(tmpDbPath + suffix, { force: true });
    } catch { /* the OS still holds it; it lives in the temp dir anyway */ }
  }
});

const { refreshNow } = require('./scheduler');

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

async function main() {
  // Fire two "tabs" clicking refresh at the same instant.
  const callA = refreshNow();
  const callB = refreshNow();

  // Give both a tick to reach their network call (or skip) before releasing it.
  await new Promise((r) => setTimeout(r, 20));
  check('exactly one fetch was started by two concurrent calls', fetchCount === 1,
    `fetchCount = ${fetchCount}`);

  releaseFetch();
  const [resultA, resultB] = await Promise.all([callA, callB]);
  const skipped = [resultA, resultB].filter((r) => r.skipped);
  check('exactly one of the two calls actually ran (the other was skipped)',
    skipped.length === 1,
    `resultA.skipped=${resultA.skipped} resultB.skipped=${resultB.skipped}`);

  console.log(`\nscheduler concurrency: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
