const express = require('express');
const db = require('../db');
const { selectVisible, LOOKBACK_HOURS, CANDIDATE_LIMIT } = require('../ranking');

const router = express.Router();

const pinnedStmt = db.prepare('SELECT * FROM articles WHERE pinned = 1 ORDER BY published_at DESC');
const candidatesStmt = db.prepare(`
  SELECT * FROM articles
  WHERE pinned = 0 AND relevant = 1 AND published_at >= ?
  ORDER BY published_at DESC
  LIMIT ?
`);
const getStmt = db.prepare('SELECT * FROM articles WHERE id = ?');
const togglePinStmt = db.prepare('UPDATE articles SET pinned = ? WHERE id = ?');
const toggleSaveStmt = db.prepare('UPDATE articles SET saved = ? WHERE id = ?');

function withAgeHours(row) {
  const ageHours = (Date.now() - new Date(row.published_at).getTime()) / 3_600_000;
  return { ...row, age_hours: Math.max(0, ageHours) };
}

router.get('/', (req, res) => {
  // filter is accepted in the query string for API symmetry with section 8, but slot
  // selection is filter-independent — the frontend dims non-matching planets in place
  // rather than re-fetching, so the scene stays spatially stable when the filter changes.
  const slots = Math.max(0, parseInt(req.query.slots, 10) || 20);
  const now = Date.now();

  const pinned = pinnedStmt.all();
  const remaining = Math.max(0, slots - pinned.length);

  const cutoff = new Date(now - LOOKBACK_HOURS * 3_600_000).toISOString();
  const candidates = candidatesStmt.all(cutoff, CANDIDATE_LIMIT);
  const visible = selectVisible(candidates, remaining, now);

  const articles = [...pinned, ...visible].map(withAgeHours);
  res.json(articles);
});

router.post('/:id/pin', (req, res) => {
  const row = getStmt.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'article not found' });

  const nextPinned = row.pinned ? 0 : 1;
  togglePinStmt.run(nextPinned, req.params.id);
  res.json(withAgeHours(getStmt.get(req.params.id)));
});

router.post('/:id/save', (req, res) => {
  const row = getStmt.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'article not found' });

  const nextSaved = row.saved ? 0 : 1;
  toggleSaveStmt.run(nextSaved, req.params.id);
  res.json(withAgeHours(getStmt.get(req.params.id)));
});

module.exports = router;
