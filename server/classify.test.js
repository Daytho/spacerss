/**
 * Relevance-gate regression cases, drawn from real feed items that the first
 * version of the gate got wrong. Run: node server/classify.test.js
 */
const db = require('./db');
const { assessRelevance, extractCvss, classify } = require('./classify');

// [title fragment to look up in the DB, expected relevance, why]
const CASES = [
  // --- must be KEPT ---
  ['Fire Ant hackers turn Cisco routers', true, 'major espionage campaign'],
  ['FBI Probes Service Selling 153M', true, 'notable incident + mass data exposure'],
  ['ClickFix Campaign Compromises 31 Orgs', true, 'active campaign'],
  ['Attackers Steal METR API Key', true, 'active intrusion'],
  ['Aesto Health says data breach', true, 'breach, 9.5M records'],
  ['Critical Langflow flaw exploited', true, 'actively exploited critical flaw'],
  ['PaperCut Zero-Day Exploited', true, 'exploited zero-day'],
  ['CISA Adds Two Known Exploited', true, 'KEV addition'],
  ['Rockwell Automation Logix Platform', true, 'CISA ICS advisory'],
  ['Infostealers are hijacking Claude accounts', true, 'active infostealer campaign'],
  ['Hackers push malicious Virtualizor update', true, 'supply-chain attack'],
  ['OpenAI Bans Russian ChatGPT Accounts', true, 'influence-op takedown'],
  ['Hiding Prompt Injection in Legal Filing', true, 'new attack technique'],
  ['Leaked Russian Cyber-Operations Training', true, 'leaked materials'],
  ['Fake GTA 6 leaked copy drains', true, 'active crypto-drainer campaign'],
  ['Hackers abuse Faronics Deploy', true, 'active abuse of admin tooling'],

  // --- must be CUT ---
  ['[Virtual Event] What Every Enterprise', false, 'webinar promo'],
  ['[Virtual Event] Building a Secure AI', false, 'webinar promo'],
  ['ISC Stormcast For Tuesday', false, 'daily podcast'],
  ['Palo Alto Networks Acquires', false, 'business/M&A news'],
  ['Coast Guard Establishes Office', false, 'org announcement'],
  ['Threat Actors Don', false, 'opinion piece'],
  ['Sevii Targets AI-Speed Attacks', false, 'vendor product pitch'],
  ['What', false, 'commentary (Schneier "What’s the Scam?")'],
  ['A week in security', false, 'weekly roundup'],
  ['Friday Squid Blogging', false, 'off-topic filler'],
  ['YARA-X 1.20.0 Release', false, 'tooling release note'],
  ['Key Reasons Why Identity Fabric', false, 'listicle/commentary'],
];

const findStmt = db.prepare('SELECT * FROM articles WHERE title LIKE ? LIMIT 1');
let pass = 0;
let fail = 0;
const failures = [];

for (const [fragment, expected, why] of CASES) {
  const row = fragment === 'What'
    ? db.prepare("SELECT * FROM articles WHERE title LIKE 'What%Scam%' LIMIT 1").get()
    : findStmt.get(`%${fragment}%`);

  if (!row) {
    console.log(`  SKIP  (not in db) "${fragment}"`);
    continue;
  }

  const { relevant, reason } = assessRelevance({
    source: row.source,
    title: row.title,
    summary: row.summary,
    publishedAt: row.published_at,
  });

  if (relevant === expected) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(
      `  FAIL  expected ${expected ? 'KEEP' : 'CUT '} but got ${relevant ? 'KEEP' : 'CUT '}`
      + ` [${reason || 'relevant'}]\n        "${row.title.slice(0, 72)}"\n        (${why})`,
    );
  }
}

failures.forEach((f) => console.log(f));
console.log(`\nrelevance gate: ${pass} passed, ${fail} failed`);

// --- CVSS score extraction -------------------------------------------------
// Advisories put the metric version before the score, and embed vector strings.
// Reading the version as the score corrupts both the label and the severity
// colour, so these cases are pinned.
const CVSS_CASES = [
  ['CVSS v4 9.8', 9.8],
  ['CVSS v3.1 7.5', 7.5],
  ['CVSS 9.8', 9.8],
  ['CVSS v3.1: 6.5', 6.5],
  ['CVSS:3.1/AV:N/AC:L/PR:N', null], // vector string, not a score
  ['The ZDI has assigned a CVSS rating of 7.8', 7.8], // words between label and score
  ['CVSS base score: 8.1', 8.1],
  ['no score mentioned', null],
  ['CVSS v3.1 5.3 and CVSS v4 8.7', 8.7], // worst score wins
];

let cvssPass = 0;
let cvssFail = 0;
for (const [text, expected] of CVSS_CASES) {
  const got = extractCvss(text.toLowerCase());
  if (got === expected) cvssPass += 1;
  else {
    cvssFail += 1;
    console.log(`  FAIL  extractCvss(${JSON.stringify(text)}) -> ${got}, expected ${expected}`);
  }
}
console.log(`cvss extraction: ${cvssPass} passed, ${cvssFail} failed`);

// --- severity damping is headline-only ------------------------------------
// Nearly every CISA/ICS-CERT advisory summary ends with generic mitigation
// boilerplate ("CISA recommends users follow best practices...", "...describes
// how to disable the affected service..."). Matching the commentary-damping
// patterns against the full text silently docked 2 points off real
// vulnerability advisories for having a mitigation section — enough to drop
// several a full colour tier. The check must only fire on the headline.
// Each pair holds the summary constant except for the one trigger phrase, so
// any score difference is attributable to that phrase alone rather than to
// other legitimate signals ("denial-of-service", "emergency patch") the
// summary also happens to carry.
const DAMPING_CASES = [
  {
    title: 'Rockwell Automation RSLinx Classic',
    withTrigger: 'Successful exploitation could cause a denial-of-service. '
      + 'CISA recommends users follow best practices and defense-in-depth strategies.',
    withoutTrigger: 'Successful exploitation could cause a denial-of-service. '
      + 'CISA recommends users follow standard guidance and defense-in-depth strategies.',
    reason: 'CISA advisory boilerplate mentions "best practices" in the mitigation section',
  },
  {
    title: 'CISA Urges SharePoint Hardening After New Exploitations',
    withTrigger: 'This advisory describes how to disable the affected service and '
      + 'apply the emergency patch immediately.',
    withoutTrigger: 'This advisory describes steps to disable the affected service and '
      + 'apply the emergency patch immediately.',
    reason: 'mitigation guidance says "how to", not the headline',
  },
];

let dampPass = 0;
let dampFail = 0;
for (const {
  title, withTrigger, withoutTrigger, reason,
} of DAMPING_CASES) {
  const source = 'CISA Cybersecurity Advisories';
  const scoreWith = classify({ source, title, summary: withTrigger }).severityScore;
  const scoreWithout = classify({ source, title, summary: withoutTrigger }).severityScore;
  if (scoreWith === scoreWithout) {
    dampPass += 1;
  } else {
    dampFail += 1;
    console.log(
      `  FAIL  damping leaked from body text: score ${scoreWithout} (phrase removed) `
      + `-> ${scoreWith} (phrase present)\n        "${title}" (${reason})`,
    );
  }
}
console.log(`severity damping is headline-only: ${dampPass} passed, ${dampFail} failed`);

process.exit(fail === 0 && cvssFail === 0 && dampFail === 0 ? 0 : 1);
