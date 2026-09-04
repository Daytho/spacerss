# SpaceRSS

A locally-hosted cybersecurity news dashboard that renders current threat
reporting as a 3D solar system. Articles are pulled from twelve public security
feeds, scored for severity and blast radius, and drawn as planets whose size and
colour encode reach and seriousness.

## Requirements

**Node.js 22 or newer** is the only prerequisite. Check with:

```
node --version
```

If it prints anything below v22, install the current LTS from https://nodejs.org.

## Setup

```
npm ci --ignore-scripts
npm start
```

Then open <http://localhost:4000> in a browser.

The project ships with a seeded database (`data/spacerss.db`, 485 articles), so
the dashboard has content the moment it opens and works with no network
connection. On startup the app also fetches current articles from all twelve
feeds in the background and merges anything new; that step needs internet, and
is skipped harmlessly if there is none.

To stop the app, press `Ctrl+C` in the terminal.

## What the install does and does not do

`npm ci` installs the exact dependency versions recorded in
`package-lock.json` and verifies each package against the SHA-512 hash pinned
there, so the install is reproducible and tamper-evident.

`--ignore-scripts` blocks dependency lifecycle scripts from executing during
install. It is enabled by default for this project via `.npmrc`, so a plain
`npm ci` behaves the same way; the flag is written out above to make the
behaviour visible. Nothing in this project needs those scripts to run — the one
native dependency, `better-sqlite3`, ships precompiled binaries for macOS,
Windows and Linux.

To review the tree before running any of it:

```
npm audit          # reported 0 vulnerabilities at time of submission
npm ls --all       # full dependency tree (78 packages)
```

## Security posture

- The server binds to `127.0.0.1`, and — only when a Tailscale interface is
  present at startup — to this machine's Tailscale address as well. It never
  binds `0.0.0.0`, so it is not reachable from other devices on whatever local
  network (home wifi, campus wifi) the machine happens to join; the only way
  to reach it from a second device is over the operator's own Tailscale
  network, which requires that device to already be authenticated onto the
  tailnet. Without Tailscale running, the server is loopback-only exactly as
  before.
- No inbound network services beyond that, no authentication of its own, no
  secrets, and no API keys. Outbound traffic goes only to the twelve RSS
  endpoints listed in `server/feeds.js`.
- Feed content is untrusted input and is treated as such: every article field
  reaches the DOM through `textContent`, never `innerHTML`, so a malicious feed
  cannot inject script into the page.
- All database access uses prepared statements with bound parameters.
- Data is written only to `./data/`, inside the project directory.

## Configuration

None required. To change the port, copy `.env.example` to `.env` and edit it,
or set the variable inline:

```
PORT=5000 npm start
```

## Tests

```
npm test
```

Runs the classification, ranking, and impact-scoring suites (78 cases).

Note that the ranking suite asserts against the seeded database rather than
against fixtures — several cases select known article groups by name to check
cross-source deduplication. It therefore depends on `data/spacerss.db` as
shipped, and cases will fail if that file is deleted and the database is rebuilt
from scratch on a later news cycle. Coupling those tests to fixtures instead of
live data is a known shortcoming.

## Layout

```
server/           Express server, feed ingestion, scoring
  index.js        entry point
  feeds.js        the twelve RSS sources
  classify.js     categorisation and severity scoring
  impact.js       blast-radius scoring
  ranking.js      orbital placement
  scheduler.js    ingest on boot, then every 6 hours
  db.js           SQLite schema and migrations
public/           browser client (three.js scene)
data/             SQLite database (seeded, 485 articles)
```

`restart.sh` is a Linux/macOS development helper and is not needed to run the
project; use `npm start`.
