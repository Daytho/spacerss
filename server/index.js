// quiet: true suppresses dotenv's startup banner. It prints on every run even
// when there is no .env file at all, and its text rotates through promotional
// tips — noise that reads like a warning to anyone running this for the first
// time.
require('dotenv').config({ quiet: true });
const os = require('os');
const path = require('path');
const express = require('express');

const scheduler = require('./scheduler');
const articlesRouter = require('./routes/articles');
const savedRouter = require('./routes/saved');

const app = express();
const PORT = process.env.PORT || 4000;

// Page assets must revalidate on every request. Safari in particular will hold
// on to a cached module and keep running old code after a fix has shipped,
// which is indistinguishable from the fix not working.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, filePath) {
    if (/\.(?:html|m?js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));
// The three.js bundle is large and only changes when the dependency does.
app.use('/vendor/three', express.static(
  path.join(__dirname, '..', 'node_modules', 'three'),
  { maxAge: '7d' },
));

app.use('/api/articles', articlesRouter);
app.use('/api/saved', savedRouter);

app.post('/api/refresh', async (req, res) => {
  try {
    const result = await scheduler.refreshNow();
    res.json(result);
  } catch (err) {
    console.error('[api/refresh] failed:', err);
    res.status(500).json({ error: 'refresh failed' });
  }
});

// Tailscale addresses live in its CGNAT range, 100.64.0.0/10 (100.64.x.x -
// 100.127.x.x). Detecting it at startup rather than hardcoding it means this
// keeps working if the tailnet ever reassigns the address.
function findTailscaleAddress() {
  const nets = os.networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const net of addrs) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const [a, b] = net.address.split('.').map(Number);
      if (a === 100 && b >= 64 && b <= 127) return net.address;
    }
  }
  return null;
}

// Bind explicitly to loopback, plus this machine's Tailscale address when one
// is present. Never 0.0.0.0: without a host argument Express listens on every
// interface, which puts this dashboard on every network the machine joins
// (home wifi, campus wifi, a coffee shop) for anyone who can reach the port.
// Binding the Tailscale address instead reaches the same goal — access from
// another device the operator owns — without that exposure, since Tailscale
// traffic is only reachable by devices already authenticated on that tailnet.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`SpaceRSS listening on http://127.0.0.1:${PORT}`);
  scheduler.start();
});

// Announced only when a tailnet is actually present. Having no Tailscale
// interface is the normal case, not a condition worth reporting — saying so on
// every startup just raises a question for anyone who has never heard of it.
const tailscaleAddress = findTailscaleAddress();
if (tailscaleAddress) {
  app.listen(PORT, tailscaleAddress, () => {
    console.log(`SpaceRSS also listening on Tailscale at http://${tailscaleAddress}:${PORT}`);
  });
}
