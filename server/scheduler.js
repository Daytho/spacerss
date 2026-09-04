const cron = require('node-cron');
const db = require('./db');
const { fetchAllFeeds } = require('./feeds');
const { classify, hashId, orbitSeedFromId } = require('./classify');
const { blastRadius, proximityLabel } = require('./impact');

const insertStmt = db.prepare(`
  INSERT INTO articles
    (id, source, title, link, summary, published_at, fetched_at, categories,
     severity_score, severity_tier, pinned, saved, orbit_seed,
     relevant, reject_reason, dedupe_key,
     blast_radius, impact_stated, impact_kind, impact_label, label_headline, label_fact)
  VALUES
    (@id, @source, @title, @link, @summary, @published_at, @fetched_at, @categories,
     @severity_score, @severity_tier, 0, 0, @orbit_seed,
     @relevant, @reject_reason, @dedupe_key,
     @blast_radius, @impact_stated, @impact_kind, @impact_label, @label_headline, @label_fact)
`);
const existsStmt = db.prepare('SELECT 1 FROM articles WHERE id = ?');

// Floor between manual refreshes actually hitting the network. The twelve
// feeds do not publish faster than this, so a click sooner than that just
// re-reads what ingest() already put in the database instead of re-fetching
// it — that's also what protects the feeds if someone mashes the button or
// has the dashboard open in two tabs.
const MIN_MANUAL_REFRESH_MS = 2 * 60 * 1000;
let lastIngestAt = 0;

async function ingest() {
  const items = await fetchAllFeeds();
  const fetchedAt = new Date().toISOString();
  let inserted = 0;
  let rejected = 0;

  for (const item of items) {
    if (!item.guid) continue;
    const id = hashId(item.guid);
    if (existsStmt.get(id)) continue;

    const result = classify({
      source: item.source,
      title: item.title,
      summary: item.summary,
      publishedAt: item.published_at,
    });

    const article = {
      title: item.title,
      summary: item.summary,
      categories: result.categories,
      severityScore: result.severityScore,
      severity_tier: result.severityTier,
    };
    const impact = blastRadius(article);
    const label = proximityLabel(article, impact);

    insertStmt.run({
      id,
      source: item.source,
      title: item.title,
      link: item.link,
      summary: item.summary,
      published_at: item.published_at,
      fetched_at: fetchedAt,
      categories: result.categories,
      severity_score: result.severityScore,
      severity_tier: result.severityTier,
      orbit_seed: orbitSeedFromId(id),
      relevant: result.relevant,
      reject_reason: result.rejectReason,
      dedupe_key: result.dedupeKey,
      blast_radius: impact.radius,
      impact_stated: impact.stated ? 1 : 0,
      impact_kind: impact.kind,
      impact_label: impact.label,
      label_headline: label.headline,
      label_fact: label.fact,
    });
    inserted += 1;
    if (!result.relevant) rejected += 1;
  }

  console.log(
    `[scheduler] ingest complete: ${inserted} new (${inserted - rejected} relevant, `
    + `${rejected} filtered) from ${items.length} fetched`,
  );
  lastIngestAt = Date.now();
  return inserted;
}

/**
 * Entry point for the manual refresh button. Within the cooldown window this
 * skips the network fetch entirely and reports 0 new — the caller still
 * re-reads /api/articles afterward, which is enough to pick up anything a
 * concurrent ingest (the boot fetch, the cron, another tab) already inserted.
 */
async function refreshNow() {
  const sinceLast = Date.now() - lastIngestAt;
  if (sinceLast < MIN_MANUAL_REFRESH_MS) {
    return { inserted: 0, skipped: true, retryAfterMs: MIN_MANUAL_REFRESH_MS - sinceLast };
  }
  const inserted = await ingest();
  return { inserted, skipped: false };
}

function start() {
  // Run once on boot so the feed isn't empty on first load.
  ingest().catch((err) => console.error('[scheduler] startup ingest failed:', err));

  // Every 6 hours.
  cron.schedule('0 */6 * * *', () => {
    ingest().catch((err) => console.error('[scheduler] scheduled ingest failed:', err));
  });
}

module.exports = {
  start, ingest, refreshNow,
};
