/**
 * Re-runs classification over every stored article. Use after changing the
 * scoring or relevance rules in classify.js — no re-fetching required.
 *
 *   node server/rescore.js          apply
 *   node server/rescore.js --dry    report what would change, write nothing
 */
require('dotenv').config();
const db = require('./db');
const { classify } = require('./classify');
const { blastRadius, proximityLabel } = require('./impact');

const dryRun = process.argv.includes('--dry');

const updateStmt = db.prepare(`
  UPDATE articles
  SET categories = @categories,
      severity_score = @severity_score,
      severity_tier = @severity_tier,
      relevant = @relevant,
      reject_reason = @reject_reason,
      dedupe_key = @dedupe_key,
      blast_radius = @blast_radius,
      impact_stated = @impact_stated,
      impact_kind = @impact_kind,
      impact_label = @impact_label,
      label_headline = @label_headline,
      label_fact = @label_fact
  WHERE id = @id
`);

const rows = db.prepare('SELECT * FROM articles').all();
const reasons = {};
let changed = 0;
let filtered = 0;

const apply = db.transaction((items) => {
  for (const { row, result } of items) {
    if (!dryRun) {
      const article = {
        title: row.title,
        summary: row.summary,
        categories: result.categories,
        severityScore: result.severityScore,
        severity_tier: result.severityTier,
      };
      const impact = blastRadius(article);
      const label = proximityLabel(article, impact);

      updateStmt.run({
        id: row.id,
        categories: result.categories,
        severity_score: result.severityScore,
        severity_tier: result.severityTier,
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
    }
  }
});

const work = rows.map((row) => {
  const result = classify({
    source: row.source,
    title: row.title,
    summary: row.summary,
    publishedAt: row.published_at,
  });
  if (result.severityScore !== row.severity_score || result.relevant !== row.relevant) changed += 1;
  if (!result.relevant) {
    filtered += 1;
    reasons[result.rejectReason] = (reasons[result.rejectReason] || 0) + 1;
  }
  return { row, result };
});

apply(work);

console.log(`${dryRun ? '[dry run] ' : ''}rescored ${rows.length} article(s)`);
console.log(`  changed:  ${changed}`);
console.log(`  relevant: ${rows.length - filtered}`);
console.log(`  filtered: ${filtered}`);
Object.entries(reasons)
  .sort((a, b) => b[1] - a[1])
  .forEach(([reason, count]) => console.log(`      ${String(count).padStart(4)}  ${reason}`));
