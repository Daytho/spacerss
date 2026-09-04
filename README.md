# SpaceRSS

A locally-hosted cybersecurity news dashboard that renders current threat
reporting as a 3D solar system. Articles are pulled from twelve public security
feeds, scored for severity and blast radius, and drawn as planets whose size and
colour encode reach and seriousness.

---

## Running it, from scratch

Follow these in order. The whole thing takes about two minutes, and the only
thing you need installed is Node.js.

### 1. Unzip the project

Unzip the download somewhere you can find again — the Desktop or Downloads
folder is fine. You should end up with a folder named `spacerss` containing
`package.json`, `README.md`, and folders called `server`, `public`, and `data`.

### 2. Open a terminal

Open your terminal application (Terminal on macOS, Command Prompt or PowerShell
on Windows).

### 3. Move the terminal into the project folder

**This step matters, and it is the most common thing to get wrong.** A terminal
window always starts in some folder — usually your home folder — and the
commands below only work when it is sitting *inside* the `spacerss` folder.
Running them from anywhere else fails with a confusing error about a missing
`package.json`.

The easiest way to get there without typing a path:

- **Windows** — open the `spacerss` folder in File Explorer, click the address
  bar at the top, type `cmd`, and press Enter. A terminal opens already in that
  folder.
- **macOS** — right-click the `spacerss` folder and choose
  *New Terminal at Folder*. (If you don't see that option, open Terminal and
  type `cd ` — with a space after it — then drag the `spacerss` folder onto the
  Terminal window and press Enter.)

Or type it yourself, using wherever you actually put the folder:

```
cd Downloads/spacerss
```

To confirm you're in the right place, run `dir` on Windows or `ls` on macOS.
You should see `package.json` listed. If you don't, you are not in the right
folder yet.

### 4. Check that Node.js is installed

```
node --version
```

This should print a version number of **v22 or higher** (for example `v22.14.0`).

If it prints a version below v22, or says something like *command not found*,
install the current LTS release from <https://nodejs.org>, then **close the
terminal and open a new one** and try again. A terminal that was already open
won't know about a program you just installed.

### 5. Install the project's dependencies

```
npm ci --ignore-scripts
```

This downloads the libraries the project needs into a new `node_modules` folder.
It takes 30–60 seconds and prints a line like `added 78 packages` when it's
done. You only need to do this once.

### 6. Start the app

```
npm start
```

### 7. Open it in a browser

Go to <http://localhost:4000>.

---

## What you should see

After `npm start`, the terminal will print something close to this:

```
> spacerss@1.0.0 start
> node server/index.js

SpaceRSS listening on http://127.0.0.1:4000
[scheduler] ingest complete: 97 new (78 relevant, 19 filtered) from 440 fetched
```

The line that matters is `SpaceRSS listening on http://127.0.0.1:4000` — that
means it worked. The two lines above it are just npm repeating the command it
ran.

The last line is the app fetching current news in the background. The numbers
will differ every time and depend on how much has been published since the
project was packaged.

You may also see lines like `[feeds] failed to fetch "..."`. That means one of
the twelve news sources didn't respond. It is handled deliberately: that source
is skipped and the other eleven carry on.

**Leave this terminal window open.** The app runs inside it. Closing the window,
or pressing `Ctrl+C`, stops the app and the web page will stop loading.

To stop the app when you're finished, click the terminal window and press
`Ctrl+C`.

The project ships with a seeded database (`data/spacerss.db`), so the dashboard
has content the moment it opens and works with no internet connection at all.
On startup it also fetches current articles from all twelve feeds in the
background and merges in anything new; that step needs internet and is skipped
harmlessly without it.

---

## If something goes wrong

**`Could not read package.json` / `npm error code ENOENT`**

The terminal isn't inside the project folder. Go back to step 3. You can check
where you currently are by running `cd` on Windows or `pwd` on macOS.

**`npm: command not found`, or `'npm' is not recognized`**

Node.js either isn't installed, or the terminal was already open when you
installed it. Install it from <https://nodejs.org>, then close the terminal,
open a new one, navigate back to the folder (step 3), and try again.

**An error mentioning `EADDRINUSE` or "address already in use"**

Something else on your machine is already using port 4000 — most often a second
copy of this app still running in another terminal window. Either close that
window, or start this one on a different port:

```
PORT=5000 npm start
```

On Windows Command Prompt, that syntax is:

```
set PORT=5000 && npm start
```

Then open <http://localhost:5000> instead.

**The page loads but stays on "Establishing uplink…"**

The browser couldn't reach the server. Confirm the terminal still shows
`SpaceRSS listening on...` and hasn't been closed or interrupted.

---

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
or set the variable inline as shown in the troubleshooting section above.

## Tests

Run from inside the project folder, same as everything else:

```
npm test
```

Runs the classification, ranking, impact-scoring, and scheduler-concurrency
suites (87 cases). Verified passing on both Linux and Windows.

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
data/             SQLite database (seeded)
```

`restart.sh` is a Linux/macOS development helper and is not needed to run the
project; use `npm start`.
