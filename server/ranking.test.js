/**
 * Ranking / dedupe regression cases. Run: node server/ranking.test.js
 */
const db = require('./db');
const { collapseDuplicates, selectVisible } = require('./ranking');

let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

const all = db.prepare('SELECT * FROM articles WHERE relevant = 1').all();

// --- cross-source: two outlets, same breach, low word overlap, shared rare name ---
{
  const rows = db.prepare("SELECT * FROM articles WHERE title LIKE '%Nutex%'").all();
  const groups = collapseDuplicates(rows);
  check(
    'cross-source merge (Nutex breach: The Record + SecurityWeek)',
    rows.length === 2 && groups.length === 1,
    `${rows.length} rows -> ${groups.length} group(s)`,
  );
}

// --- must NOT merge: two unrelated breaches sharing only generic vocabulary ---
// Aesto Health and Nutex Health are different companies and different incidents;
// they share "health", "data" and "breach" and nothing else.
{
  const rows = db.prepare(
    "SELECT * FROM articles WHERE title LIKE '%Aesto%' OR title LIKE '%Nutex%'",
  ).all();
  const groups = collapseDuplicates(rows);
  const aesto = groups.filter((g) => /Aesto/i.test(g.title));
  const nutex = groups.filter((g) => /Nutex/i.test(g.title));
  // Each company's own coverage may merge across outlets; the two companies
  // must not merge with each other (that would show up as a single group).
  check(
    'unrelated healthcare breaches stay separate (Aesto vs Nutex)',
    groups.length === 2 && aesto.length === 1 && nutex.length === 1,
    `${rows.length} rows -> ${groups.length} group(s): `
      + groups.map((g) => `${g.grouped_count}x "${g.title.slice(0, 34)}"`).join(' | '),
  );
}

// --- must NOT merge: different companies, near-identical headline shape ---
// "Aesto Health says data breach affects over 9.5 million patients" vs
// "Novocure data breach affects more than 1,400 cancer patients" share only
// generic vocabulary; the company names differ, so these are separate events.
{
  const rows = db.prepare(
    "SELECT * FROM articles WHERE title LIKE '%Aesto%' OR title LIKE '%Novocure%'",
  ).all();
  const groups = collapseDuplicates(rows);
  const hasAesto = groups.filter((g) => /Aesto/i.test(g.title)).length;
  const hasNovocure = groups.filter((g) => /Novocure/i.test(g.title)).length;
  check(
    'different companies with similar headline shape stay separate (Aesto vs Novocure)',
    hasAesto === 1 && hasNovocure === 1,
    `${rows.length} rows -> ${groups.length} group(s): `
      + groups.map((g) => `${g.grouped_count}x "${g.title.slice(0, 40)}"`).join(' | '),
  );
}

// --- same-source batch: one vendor's advisories published the same day ---
{
  const rows = db.prepare(
    "SELECT * FROM articles WHERE source LIKE 'CISA%' AND title LIKE 'Rockwell Automation%'"
    + " AND published_at LIKE '2026-09-01%'",
  ).all();
  const groups = collapseDuplicates(rows);
  check(
    'same-day vendor batch collapses (Rockwell advisories)',
    rows.length > 3 && groups.length === 1,
    `${rows.length} rows -> ${groups.length} group(s)`,
  );
}

// --- a vendor's advisories on *different* days are separate events ---
{
  const rows = db.prepare(
    "SELECT * FROM articles WHERE source LIKE 'CISA%' AND title LIKE 'Rockwell Automation%'",
  ).all();
  const days = new Set(rows.map((r) => r.published_at.slice(0, 10)));
  const groups = collapseDuplicates(rows);
  check(
    'vendor batches on different days stay separate',
    days.size > 1 && groups.length === days.size,
    `${rows.length} rows across ${days.size} day(s) -> ${groups.length} group(s)`,
  );
}

// --- recurring headline: same title, different events, weeks apart ---
{
  const rows = db.prepare(
    "SELECT * FROM articles WHERE title LIKE 'CISA Adds%Known Exploited%' ORDER BY published_at",
  ).all();
  const groups = collapseDuplicates(rows);
  const span = rows.length > 1
    ? (new Date(rows[rows.length - 1].published_at) - new Date(rows[0].published_at)) / 86400000
    : 0;
  check(
    'recurring KEV headline does not merge across weeks',
    rows.length > 5 && groups.length > 1,
    `${rows.length} KEV posts spanning ${span.toFixed(0)} days -> ${groups.length} group(s), expected > 1`,
  );
}

// --- must NOT merge: different vendors, same source and day ---
{
  const rows = db.prepare(
    "SELECT * FROM articles WHERE source LIKE 'CISA%' AND (title LIKE 'Rockwell%' OR title LIKE 'Mitsubishi%')",
  ).all();
  const groups = collapseDuplicates(rows);
  check(
    'different vendors stay separate (Rockwell vs Mitsubishi)',
    groups.length >= 2,
    `${rows.length} rows -> ${groups.length} group(s), expected >= 2`,
  );
}

// --- must NOT merge: same source, same day, shared prefix is generic
// journalistic phrasing rather than a vendor/product name ---
// "Hackers exploit critical JFrog Artifactory flaw..." and "Hackers exploit
// Sangoma Switchvox flaw..." are both BleepingComputer, published the same
// day, and share the leading words "hackers exploit" — but that phrase
// identifies no vendor, and the two stories are unrelated products.
{
  const rows = db.prepare(
    "SELECT * FROM articles WHERE source = 'BleepingComputer' "
    + "AND (title LIKE '%JFrog Artifactory flaw to forge%' OR title LIKE '%Sangoma Switchvox%')",
  ).all();
  const groups = collapseDuplicates(rows);
  check(
    'shared generic headline phrasing does not imply a shared vendor (JFrog vs Sangoma)',
    rows.length === 2 && groups.length === 2,
    `${rows.length} rows -> ${groups.length} group(s), expected 2`,
  );
}

// --- must NOT over-merge editorial sources ---
// Advisory feeds (ZDI, CISA) legitimately collapse hard: they publish same-day
// batches of near-identical entries for one product. Editorial outlets write one
// story per event, so heavy collapse there would mean the matcher is too loose.
{
  const EDITORIAL = ['Dark Reading', 'The Hacker News', 'Krebs on Security', 'Malwarebytes Labs'];
  const offenders = [];
  for (const source of EDITORIAL) {
    const rows = all.filter((r) => r.source === source);
    if (rows.length < 5) continue;
    const ratio = collapseDuplicates(rows).length / rows.length;
    if (ratio <= 0.7) offenders.push(`${source} retained ${(ratio * 100).toFixed(0)}%`);
  }
  check(
    'editorial sources are not over-merged',
    offenders.length === 0,
    offenders.join('; '),
  );
}

// --- ranking: severity beats raw recency ---
{
  const now = Date.now();
  const fresh = {
    id: 'fresh', source: 'A', title: 'Minor security note about a thing', summary: '',
    published_at: new Date(now - 10 * 60 * 1000).toISOString(),
    severity_score: 0, severity_tier: 1, dedupe_key: '', categories: 'news',
  };
  const critical = {
    id: 'crit', source: 'B', title: 'Actively exploited zero-day in widespread product', summary: '',
    published_at: new Date(now - 12 * 3600 * 1000).toISOString(),
    severity_score: 9, severity_tier: 5, dedupe_key: '', categories: 'cve',
  };
  const picked = selectVisible([fresh, critical], 2, now);
  check(
    '12h-old critical outranks 10min-old trivia',
    picked[0].id === 'crit',
    `got order: ${picked.map((p) => p.id).join(', ')}`,
  );
}

// --- ranking: stale critical eventually yields to fresh moderate ---
{
  const now = Date.now();
  const stale = {
    id: 'stale', source: 'A', title: 'Old critical issue', summary: '',
    published_at: new Date(now - 96 * 3600 * 1000).toISOString(),
    severity_score: 9, severity_tier: 5, dedupe_key: '', categories: 'cve',
  };
  const recent = {
    id: 'recent', source: 'B', title: 'New moderate issue', summary: '',
    published_at: new Date(now - 1 * 3600 * 1000).toISOString(),
    severity_score: 5, severity_tier: 3, dedupe_key: '', categories: 'cve',
  };
  const picked = selectVisible([stale, recent], 2, now);
  check(
    '4-day-old critical yields to 1h-old moderate',
    picked[0].id === 'recent',
    `got order: ${picked.map((p) => p.id).join(', ')}`,
  );
}

// --- diversity: no source may dominate the visible set ---
{
  const picked = selectVisible(all, 20);
  const counts = {};
  picked.forEach((p) => { counts[p.source] = (counts[p.source] || 0) + 1; });
  const max = Math.max(...Object.values(counts));
  check(
    'per-source cap holds on a full slate',
    picked.length === 20 && max <= 4,
    `${picked.length} picked, max per source = ${max} (${JSON.stringify(counts)})`,
  );
}

// --- filtered-out articles never reach the visible set ---
{
  const picked = selectVisible(all, 20);
  check(
    'no irrelevant article is selected',
    picked.every((p) => p.relevant === 1),
    'an article with relevant=0 was selected',
  );
}

console.log(`\nranking: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
