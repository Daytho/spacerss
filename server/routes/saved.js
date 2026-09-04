const express = require('express');
const db = require('../db');

const router = express.Router();

const savedStmt = db.prepare('SELECT * FROM articles WHERE saved = 1 ORDER BY published_at DESC');

function withAgeHours(row) {
  const ageHours = (Date.now() - new Date(row.published_at).getTime()) / 3_600_000;
  return { ...row, age_hours: Math.max(0, ageHours) };
}

router.get('/', (req, res) => {
  res.json(savedStmt.all().map(withAgeHours));
});

module.exports = router;
