const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Category tagging
// ---------------------------------------------------------------------------

const CATEGORY_PATTERNS = [
  ['cve', /cve-\d{4}-\d+|vulnerability|vulnerabilit|patch|flaw|rce\b|privilege escalation|auth(?:entication)? bypass|out-of-bounds|use-after-free|deserializ/],
  ['ransomware', /ransomware|extortion|encrypted files|double extortion|leak site/],
  ['breach', /breach|data leak|exposed|stolen data|records (?:were )?(?:exposed|stolen|leaked)|leaked database/],
  ['malware', /malware|trojan|backdoor|spyware|botnet|infostealer|info-stealer|stealer|loader|rootkit|wiper/],
  ['phishing', /phishing|smishing|business email compromise|\bbec\b|credential harvest|fake login/],
];

/**
 * Feeds publish typographic punctuation — curly quotes, en/em dashes, ellipses —
 * and HTML entities. Left as-is, a pattern like /\bwhat'?s\b/ silently fails to
 * match "What’s the Scam?". Normalize to ASCII before any matching.
 */
function normalize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/&#x27;|&apos;|&#39;/g, "'")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#x3f;/g, '?')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pull the CVSS base score out of text.
 *
 * Advisories write the metric version before the score ("CVSS v4 9.8",
 * "CVSS v3.1 7.5") and also embed vector strings ("CVSS:3.1/AV:N/AC:L/..."),
 * so a naive "first number after CVSS" reads the *version* as the score — which
 * both mislabels the planet and corrupts its severity colour.
 */
function extractCvss(text) {
  // After "cvss": optionally a metric version ("v4", "v3.1"), then up to a few
  // non-digit words ("rating of", "base score:"), then the score itself.
  const re = /cvss\s*:?\s*(?:v\s*\d+(?:\.\d+)?)?[^\d]{0,18}?(\d{1,2}(?:\.\d+)?)/g;
  let best = null;
  for (const m of text.matchAll(re)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 1);
    if (after === '/') continue; // inside a vector string, e.g. "CVSS:3.1/AV:N"
    const score = parseFloat(m[1]);
    if (!Number.isFinite(score) || score < 0 || score > 10) continue;
    if (best === null || score > best) best = score;
  }
  return best;
}

const CISA_SOURCES = new Set(['CISA Cybersecurity Advisories', 'CISA Current Activity']);
// Feeds that publish nothing but vulnerability advisories — they clear the
// relevance gate on source alone, since their titles are bare product names.
const ADVISORY_SOURCES = new Set([...CISA_SOURCES, 'Zero Day Initiative']);

// ---------------------------------------------------------------------------
// Relevance gate — is this a concrete security event at all?
//
// Tuned for "threat intel + notable incidents": real events, campaigns,
// advisories, research findings and law-enforcement action are kept; webinars,
// vendor/business announcements and pure commentary are not.
// ---------------------------------------------------------------------------

// Always rejected, regardless of what else the text contains. Matched against
// the headline only — see the note on NOISE below.
const HARD_NOISE = [
  [/\[virtual event\]|\bwebinar\b|\[sponsored\]|\bsponsored (?:content|post)\b/, 'promotional'],
  [/\bstormcast\b|\bpodcast\b|\(lock and code|\bs\d+e\d+\b|\bepisode \d+/, 'podcast'],
  [/\b(?:conference|summit|expo|roadshow)\b.*\b(?:agenda|register|keynote)\b|\bcall for papers\b/, 'event-promo'],
  [/^a week in security|\bweekly (?:roundup|recap|digest)\b|\bfriday squid blogging\b/, 'roundup'],
];

// Rejected unless the item also carries DEFINITE_EVENT evidence.
//
// IMPORTANT: these are matched against the HEADLINE ONLY. They describe the
// *shape* of a piece ("How to…", "…, Explained", "5 Ways to…"), and those words
// are format markers in a title but ordinary vocabulary in body prose. Matching
// them against the summary rejected a major espionage campaign because the
// article said a tunnel "could not be explained by a running configuration".
const NOISE = [
  [/\bacquires?\b|\bacquisition\b|\bmerger\b|\bto buy\b|\braises \$|\bfunding round\b|\bseries [a-e]\b|\bipo\b|\bvaluation\b/, 'business-news'],
  [/\bappoints?\b|\bnames? new\b|\bhires?\b|\bjoins as\b|\bsteps down\b|\bpromoted to\b|\bboard of directors\b/, 'personnel-news'],
  [/\blaunches?\b|\bunveils?\b|\bintroduces?\b|\bdebuts?\b|\brolls out\b|\badds controls\b|\bannounces?\b|\bnow available\b|\bpartners? with\b|\bteams up with\b|\bintegration with\b|\btargets? .* with\b|\bnew (?:security )?(?:blueprint|framework|platform|offering|suite)\b/, 'product-announcement'],
  [
    /\bhow to\b|\bhere'?s (?:how|why|what)\b|\bwhy (?:you|we|it|they)\b|\bwhat'?s\b|\bwhat (?:is|are|the)\b|\b\d+ (?:ways|tips|steps|things|lessons|reasons)\b|\bkey reasons\b|\bbest practices\b|\bpredictions?\b|\bthe case for\b|\bguide to\b|,\s*explained\b|\bexplained$|\bq&a\b|\binterview with\b|\bopinion\b|\bis hard\b|\bmatters\b|\bdon'?t want\b|\bhere to stay\b|\bwhat the data says\b|\bat least not yet\b/,
    'commentary',
  ],
  [/\bsurvey (?:finds|shows|reveals)\b|\breport (?:finds|shows|reveals)\b|\bstud(?:y|ies) (?:finds|shows)\b|\bmarket (?:size|share|forecast)\b|\bstate of \w+ (?:report|security)\b|\binvestments? surge\b/, 'industry-report'],
  [/\bestablishes? (?:new )?office\b|\bcreates? (?:new )?(?:office|division|task force)\b|\bhiring\b|\bcareer\b|\bcertification\b|\btraining course\b|\blooks to\b|\bcalling on\b/, 'org-announcement'],
  [/\boutage\b|\bservice (?:disruption|degradation)\b|\bdowntime\b/, 'outage'],
  [/\b(?:release[ds]?|version) \d+\.\d+|\bv\d+\.\d+\.\d+\b/, 'tooling-release'],
];

// Concrete proof that something actually happened: an exploited flaw, an
// intrusion, a disclosure, a takedown, a new attack technique. Overrides NOISE,
// so it must stay specific — a bare mention of "attack" or "threat actor" is a
// topic, not an event, and would otherwise grant vendor pitches immunity.
const DEFINITE_EVENT = new RegExp([
  'cve-\\d{4}-\\d+',
  'zero-?day|0-?day',
  'actively exploited|exploited in the wild|under active (?:attack|exploitation)|exploitation (?:observed|attempts|underway)|attacks? exploiting|being exploited|exploited (?:to|in|as|following)',
  'known exploited vulnerabilit|kev catalog',
  '(?:critical|high[- ]severity|severe|serious) (?:flaw|vulnerabilit|bug|weakness|issue)',
  'emergency (?:patch|update|directive)|out-of-band (?:patch|update)|patch tuesday',
  'data breach|breached|data leak|leaked (?:database|records|data|materials|documents)|records (?:were )?(?:exposed|stolen|leaked)|exposed \\d|affects? (?:over |more than )?[\\d,.]+ (?:million |billion )?(?:people|users|patients|customers|individuals|records)',
  'ransomware (?:attack|group|gang|operation|strain|payment)|extortion',
  // an actor doing something concrete
  '(?:hackers?|attackers?|threat actors?|cybercriminals?|scammers?|hacktivists?|operators?)\\s+(?:\\w+\\s+){0,3}?(?:abus|exploit|hijack|compromis|breach|steal|stole|stolen|deploy|target|turn|use[sd]?|using|push|infect|weaponiz|impersonat|bypass|drain|siphon|plant|inject|spoof|extort|hit\\b|claim)',
  '(?:malware|trojan|backdoor|spyware|botnet|infostealer|info-stealer|stealer|rootkit|wiper|loader|ransomware)\\b[^.]{0,60}?(?:campaign|infection|distribut|deliver|target|discovered|drop|found in|spread)',
  'phishing (?:campaign|attack|kit)|smishing|business email compromise',
  'supply[- ]chain (?:attack|compromise)|malicious (?:package|npm|pypi|extension|vsix|repo)|typosquat',
  'espionage|spying (?:platform|campaign|tool)|state-?sponsored|nation-?state|apt\\s?\\d+',
  'prompt injection|jailbreak(?:ing)?|model poisoning',
  'proof[- ]of[- ]concept|exploit code (?:released|public|available)',
  'researchers? (?:found|discovered|revealed|demonstrated|disclosed|uncovered)|new (?:attack|technique|method|vector|tactic)',
  '(?:arrest|indict|charge|sentenc|takedown|seiz|sanction|ban)(?:s|ed|ment)?\\b[^.]{0,60}?(?:hacker|cybercrim|ransomware|fraud|operator|market|account|operation|network)',
  'vulnerabilit(?:y|ies) (?:in|affect|allow|let|enable|disclos|patch|fix)',
  'patch(?:es|ed)? (?:a |the |two |three |multiple )?(?:critical|high|actively|zero-day|vulnerabilit|flaw|bug)',
  'security (?:update|advisory|advisories|bulletin)s? (?:for|address|fix|releas)',
  'warns? (?:of|about|that)|urges? (?:users|admins|organizations)',
].join('|'));

// Topical but not proof of an event — accepted only when nothing in NOISE hit.
const TOPICAL = new RegExp([
  'attack(?:s|ers|ed)?|hacker(?:s)?|breach|exploit',
  'security (?:flaw|issue|risk|researcher)|vulnerabilit',
  'patch(?:es|ed)?|malware|phishing|ransomware|spyware|botnet',
  'fraud|scam|theft|stolen|steal(?:s|ing)?|leak',
  'arrest|indict|takedown|seized|sanctions|law enforcement|\\bfbi\\b|europol|\\bdoj\\b',
  'exposed|compromis|hijack|intrusion|backdoor',
].join('|'));

function assessRelevance({ source, title, summary, publishedAt, now = Date.now() }) {
  const headline = normalize(title);
  const full = normalize(`${title} ${summary || ''}`);

  // Feeds like Dark Reading list future-dated promo items; they would otherwise
  // sort above every real story forever and never age out.
  if (publishedAt && new Date(publishedAt).getTime() > now + 60 * 60 * 1000) {
    return { relevant: false, reason: 'future-dated' };
  }

  for (const [pattern, reason] of HARD_NOISE) {
    if (pattern.test(headline)) return { relevant: false, reason };
  }

  // Advisory-only feeds clear the gate on source alone; their titles are bare
  // product names ("Rockwell Automation Logix Platform") with no event verbs.
  if (ADVISORY_SOURCES.has(source)) return { relevant: true, reason: null };

  if (DEFINITE_EVENT.test(full)) return { relevant: true, reason: null };

  for (const [pattern, reason] of NOISE) {
    if (pattern.test(headline)) return { relevant: false, reason };
  }

  if (TOPICAL.test(full)) return { relevant: true, reason: null };

  return { relevant: false, reason: 'no-event-signal' };
}

// ---------------------------------------------------------------------------
// Severity scoring
// ---------------------------------------------------------------------------

function scaleBonus(text) {
  // "9.5 million patients", "153M+ drivers licenses", "31 orgs compromised"
  let bonus = 0;

  const millions = text.match(/(\d+(?:\.\d+)?)\s*(?:million|m\+|m\b)\s+(?:\w+\s+){0,3}?(?:records|users|customers|patients|accounts|people|individuals|licenses|credentials|rows)/);
  const billions = text.match(/(\d+(?:\.\d+)?)\s*billion\s+(?:\w+\s+){0,3}?(?:records|users|customers|accounts|people|credentials)/);
  if (billions) bonus = Math.max(bonus, 3);
  else if (millions) {
    const n = parseFloat(millions[1]);
    if (n >= 10) bonus = Math.max(bonus, 3);
    else if (n >= 1) bonus = Math.max(bonus, 2);
  }

  const orgs = text.match(/(\d+)\s+(?:organizations|orgs|companies|firms|agencies|victims|entities)\b/);
  if (orgs && parseInt(orgs[1], 10) >= 10) bonus = Math.max(bonus, 2);

  return bonus;
}

function classify({ source, title, summary, publishedAt, now = Date.now() }) {
  const text = normalize(`${title} ${summary || ''}`);

  const categories = CATEGORY_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
  if (categories.length === 0) categories.push('news');

  let score = 0;

  // --- exploitation status: the strongest urgency signal ---
  if (/actively exploited|exploited in the wild|under active (?:attack|exploitation)|exploitation (?:observed|attempts|underway)|attacks? exploiting|being exploited|exploited to steal|exploited in attacks/.test(text)) {
    score += 4;
  }
  if (/known exploited vulnerabilit|kev catalog/.test(text)) score += 3;
  if (/zero-?day|0-?day/.test(text)) score += 3;
  if (/\bcritical\b/.test(text)) score += 2;
  if (/high[- ]severity|\burgent\b|emergency (?:patch|update|directive)|out-of-band (?:patch|update)|patch (?:now|immediately)/.test(text)) score += 2;
  if (/proof[- ]of[- ]concept|\bpoc\b (?:released|available|published)|exploit code (?:released|public)/.test(text)) score += 2;

  // --- CVSS ---
  const cvss = extractCvss(text);
  if (cvss !== null) {
    if (cvss >= 9) score += 2;
    else if (cvss >= 7) score += 1;
  }

  // --- source authority ---
  if (CISA_SOURCES.has(source)) score += 2;

  // --- impact scale ---
  score += scaleBonus(text);

  // --- actor sophistication ---
  if (/apt\s?\d+|nation-?state|state-?sponsored|espionage|advanced persistent threat/.test(text)) score += 2;
  if (/supply[- ]chain (?:attack|compromise)|malicious (?:package|npm|pypi|extension)|typosquat/.test(text)) score += 2;

  // --- category weighting ---
  if (categories.includes('ransomware') || categories.includes('breach')) score += 2;
  if (categories.includes('cve') || categories.includes('malware')) score += 1;

  // --- damping: analysis pieces that survived the gate shouldn't outrank events ---
  if (/\bhow to\b|\bwhy you\b|\blessons\b|\bbest practices\b|\bpredictions?\b|\bopinion\b/.test(text)) {
    score -= 2;
  }

  score = Math.max(0, Math.min(score, 10));

  let tier;
  if (score >= 8) tier = 5;
  else if (score >= 6) tier = 4;
  else if (score >= 4) tier = 3;
  else if (score >= 2) tier = 2;
  else tier = 1;

  const { relevant, reason } = assessRelevance({ source, title, summary, publishedAt, now });

  return {
    categories: categories.join(','),
    severityScore: score,
    severityTier: tier,
    relevant: relevant ? 1 : 0,
    rejectReason: reason,
    dedupeKey: buildDedupeKey(title, summary),
  };
}

// ---------------------------------------------------------------------------
// Cross-source duplicate detection
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'as', 'at', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'it',
  'its', 'that', 'this', 'these', 'those', 'new', 'says', 'said', 'after',
  'over', 'into', 'via', 'amid', 'up', 'out', 'more', 'than', 'has', 'have',
]);

// Advisory feeds prefix titles with their own tracking id ("ZDI-26-615: (0Day)
// pdfforge PDF Architect ..."), which is unique per item and would defeat any
// attempt to spot a vendor's batch of advisories as related.
function stripAdvisoryPrefix(title) {
  return normalize(title)
    .replace(/^zdi-\d+-\d+:?\s*/, '')
    .replace(/^\(0day\)\s*/, '')
    .replace(/\(update [a-z]\)\s*$/, '');
}

function titleTokens(title) {
  return new Set(
    stripAdvisoryPrefix(title)
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

/**
 * Entity-like tokens: the company, product and threat-actor names that identify
 * *which* story this is, as opposed to vocabulary shared by every story of its
 * kind.
 *
 * Headlines are title case, so capitalization there says nothing. Summaries are
 * ordinary sentence case, so a word capitalized away from a sentence start is a
 * proper noun — "Nutex", "Langflow", "Fire Ant". Titles still contribute tokens
 * whose *internal* shape marks them as names (NovaCookies, TeamPCP, ZDI-26-615),
 * since those survive title casing.
 *
 * This replaces judging rarity alone, which cannot tell "Novocure" from
 * "affects" in a pool of a few hundred headlines.
 */
function entityTokens(title, summary) {
  const found = new Set();

  // Internal capitals, all-caps runs, or letter+digit mixes in the title.
  for (const raw of (title || '').split(/\s+/)) {
    const word = raw.replace(/^[^\w]+|[^\w]+$/g, '');
    if (word.length < 3) continue;
    const hasInnerCap = /^[A-Za-z][a-z]*[A-Z]/.test(word);
    const isAllCaps = /^[A-Z]{3,}$/.test(word);
    const hasDigitMix = /^(?=.*[A-Za-z])(?=.*\d)[\w-]+$/.test(word);
    if (hasInnerCap || isAllCaps || hasDigitMix) found.add(word.toLowerCase());
  }

  // Proper nouns in the summary: capitalized, but not at a sentence start.
  const text = (summary || '').replace(/\s+/g, ' ');
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const words = sentence.split(' ');
    words.slice(1).forEach((raw) => {
      const word = raw.replace(/^[^\w]+|[^\w']+$/g, '').replace(/'s$/, '');
      if (word.length < 3) return;
      if (!/^[A-Z][A-Za-z0-9-]*$/.test(word)) return;
      found.add(word.toLowerCase());
    });
  }

  return found;
}

// Ordered (not set) significant tokens — used to spot a vendor's same-day batch
// by shared leading tokens, e.g. "Rockwell Automation <product>" x6.
function leadingTokens(title, count = 2) {
  return stripAdvisoryPrefix(title)
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .slice(0, count)
    .join(' ');
}

// A CVE id shared between two stories is a near-certain match; otherwise we fall
// back to token overlap, compared at query time.
function buildDedupeKey(title, summary) {
  const cves = normalize(`${title} ${summary || ''}`).match(/cve-\d{4}-\d+/g);
  if (cves && cves.length > 0) {
    return [...new Set(cves)].sort().join('+');
  }
  return '';
}

function titleSimilarity(a, b) {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / Math.min(ta.size, tb.size);
}

function hashId(guid) {
  return crypto.createHash('sha256').update(guid).digest('hex').slice(0, 32);
}

function orbitSeedFromId(id) {
  // First 8 hex chars -> uint32 -> normalize to [0, 1)
  const n = parseInt(id.slice(0, 8), 16);
  return n / 0xffffffff;
}

module.exports = {
  classify,
  assessRelevance,
  hashId,
  orbitSeedFromId,
  titleSimilarity,
  titleTokens,
  leadingTokens,
  entityTokens,
  extractCvss,
  buildDedupeKey,
  normalize,
};
