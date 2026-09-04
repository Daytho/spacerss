const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || './data/spacerss.db';
const resolvedPath = path.resolve(process.cwd(), dbPath);
fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

const db = new Database(resolvedPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id             TEXT PRIMARY KEY,
    source         TEXT NOT NULL,
    title          TEXT NOT NULL,
    link           TEXT NOT NULL,
    summary        TEXT,
    published_at   TEXT NOT NULL,
    fetched_at     TEXT NOT NULL,
    categories     TEXT NOT NULL,
    severity_score INTEGER NOT NULL,
    severity_tier  INTEGER NOT NULL,
    pinned         INTEGER NOT NULL DEFAULT 0,
    saved          INTEGER NOT NULL DEFAULT 0,
    orbit_seed     REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
`);

// --- migrations: additive columns, safe to run on an existing database ---
const existingColumns = new Set(db.pragma('table_info(articles)').map((c) => c.name));
const MIGRATIONS = [
  ['relevant', 'ALTER TABLE articles ADD COLUMN relevant INTEGER NOT NULL DEFAULT 1'],
  ['reject_reason', 'ALTER TABLE articles ADD COLUMN reject_reason TEXT'],
  ['dedupe_key', "ALTER TABLE articles ADD COLUMN dedupe_key TEXT NOT NULL DEFAULT ''"],
  // Reach ("how far does this go") is stored separately from severity ("how bad
  // is it"), because planet size and planet colour encode the two independently.
  ['blast_radius', 'ALTER TABLE articles ADD COLUMN blast_radius REAL NOT NULL DEFAULT 0.2'],
  ['impact_stated', 'ALTER TABLE articles ADD COLUMN impact_stated INTEGER NOT NULL DEFAULT 0'],
  ['impact_kind', 'ALTER TABLE articles ADD COLUMN impact_kind TEXT'],
  ['impact_label', 'ALTER TABLE articles ADD COLUMN impact_label TEXT'],
  ['label_headline', 'ALTER TABLE articles ADD COLUMN label_headline TEXT'],
  ['label_fact', 'ALTER TABLE articles ADD COLUMN label_fact TEXT'],
];
for (const [column, sql] of MIGRATIONS) {
  if (!existingColumns.has(column)) db.exec(sql);
}

db.exec('CREATE INDEX IF NOT EXISTS idx_articles_relevant ON articles(relevant, published_at DESC)');

module.exports = db;
