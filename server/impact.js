/**
 * Impact extraction and blast-radius scoring.
 *
 * Planet COLOR encodes how dangerous a story is (severity tier). Planet SIZE
 * encodes how far it reaches — how many people, organizations, machines, dollars
 * or bytes are involved. Those are different questions: a critical RCE in
 * niche industrial software is deep red but small; a breach of 153 million
 * driver's licences is enormous even though nothing is being actively exploited.
 *
 * Only about 1 article in 10 states a figure outright, so `blastRadius` falls
 * back to estimating reach from CVSS, exploitation status and how widely the
 * affected product is deployed. `impact.stated` records which of the two it was.
 */
const { normalize, extractCvss } = require('./classify');

const MULTIPLIERS = {
  hundred: 1e2,
  thousand: 1e3,
  k: 1e3,
  million: 1e6,
  m: 1e6,
  billion: 1e9,
  b: 1e9,
  trillion: 1e12,
};

const BYTE_UNITS = {
  kb: 1e3, kilobyte: 1e3, kilobytes: 1e3,
  mb: 1e6, megabyte: 1e6, megabytes: 1e6,
  gb: 1e9, gigabyte: 1e9, gigabytes: 1e9,
  tb: 1e12, terabyte: 1e12, terabytes: 1e12,
  pb: 1e15, petabyte: 1e15, petabytes: 1e15,
};

// Unit nouns grouped by what a single unit is "worth" in reach terms.
const UNIT_KINDS = [
  ['people', /^(?:records?|users?|customers?|patients?|accounts?|people|persons?|individuals?|licen[cs]es?|credentials?|subscribers?|employees?|citizens?|residents?|members?|profiles?|passwords?|identities|victims?|players?|students?|addresses|emails?|ssns?|clients?|applicants?|voters?|drivers?)$/],
  // "vendor" and "provider" are deliberately absent: advisory boilerplate says
  // "the vendor recommends..." constantly, next to model and version numbers.
  ['orgs', /^(?:organi[sz]ations?|orgs?|companies|firms?|agencies|entities|businesses|hospitals?|schools?|banks?|universities|municipalities|governments?)$/],
  ['machines', /^(?:servers?|devices?|systems?|endpoints?|instances?|routers?|hosts?|machines?|computers?|websites?|domains?|apps?|applications?|packages?|repositories|repos?|extensions?|plugins?|installations?|installs?|downloads?|containers?|databases?|cameras?)$/],
];

// Words that are already plural without an -s, and so are valid unit nouns.
const INHERENTLY_PLURAL = new Set(['people', 'personnel', 'staff', 'data']);

// Money is only an impact figure when something was lost, stolen or extorted —
// otherwise it is market sizing or funding, which says nothing about blast radius.
const MONETARY_LOSS_CONTEXT = /\b(?:stolen|steal|stole|theft|lost|lose[sd]?|losing|loss(?:es)?|ransom|extort(?:ed|ion)?|demand(?:ed|s)?|paid|pay(?:ment)?|damages|fraud|scam|defraud|drain(?:ed)?|siphon|worth|consume[ds]?|cost)\b/;

/**
 * Upper bounds on what each unit can plausibly count. A figure above these is
 * being read out of context — "$240 billion across the market" is not
 * 240 billion compromised businesses; there are not that many on Earth.
 */
const MAX_PLAUSIBLE = {
  people: 9e9,
  orgs: 4e8,
  machines: 5e10,
  money: 1e12,
  data: 1e18,
};

// Words that, immediately before a number, mean it is not a count of anything.
const DISQUALIFYING_PREFIX = /(?:cvss|score(?:d|s)?|rating|rated|version|versions?|v|release|build|patch|firmware|prior to|before|through|up to|severity)\s*[:v]?\s*$/;

function parseNumber(raw) {
  const cleaned = raw.replace(/,/g, '');
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * A dotted number with more than one decimal group (4.60.1, 10.01.00) is a
 * version string, never a quantity.
 */
function looksLikeVersion(raw, following) {
  if (/\d+\.\d+\.\d/.test(raw)) return true;
  // "4.60. mitigation" — a decimal immediately followed by a sentence break.
  if (/^\d+\.\d+$/.test(raw) && /^\s*\./.test(following)) return true;
  return false;
}

function formatCount(value) {
  if (value >= 1e9) return `${+(value / 1e9).toFixed(value >= 1e10 ? 0 : 1)}B`;
  if (value >= 1e6) return `${+(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
  if (value >= 1e3) return `${+(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(value));
}

function formatBytes(value) {
  for (const [suffix, factor] of [['PB', 1e15], ['TB', 1e12], ['GB', 1e9], ['MB', 1e6]]) {
    if (value >= factor) return `${+(value / factor).toFixed(value / factor >= 10 ? 0 : 1)}${suffix}`;
  }
  return `${Math.round(value / 1e3)}KB`;
}

function formatMoney(value) {
  if (value >= 1e9) return `$${+(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${+(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${+(value / 1e3).toFixed(0)}K`;
  return `$${Math.round(value)}`;
}

/**
 * Blank out identifiers whose digits are not quantities. Advisory text is dense
 * with them, and "cve-2026-9621, ... cvss vendor" otherwise reads as "9,621
 * vendors".
 */
function stripTechnicalIdentifiers(text) {
  return text
    .replace(/cve-\d{4}-\d+/g, ' ')
    .replace(/cwe-\d+/g, ' ') // CWE-798 is "Hard-coded Credentials", not 798 credentials
    .replace(/zdi-(?:can-)?\d+-?\d*/g, ' ')
    .replace(/\bicsa?-\d{2}-\d+-\d+/g, ' ') // ICS advisory ids
    .replace(/\b(?:ms|kb|apsb|rhsa|usn)-?\d{3,}/g, ' ')
    .replace(/cvss[:\s]*v?\d+(?:\.\d+)*/g, ' ')
    .replace(/\b(?:av|ac|pr|ui|[csi]):[a-z](?:\/[a-z]+:[a-z])*/g, ' ') // CVSS vectors
    .replace(/[<>]=?\s*v?\d+(?:\.\d+)*/g, ' ') // "<=4.50"
    .replace(/\bv\d+(?:\.\d+)*/g, ' ')
    // Product model numbers, letter-prefix: letters followed by digits,
    // optionally hyphenated (SEC-3000, DS925+, Galaxy S25, IoT2050, EC80).
    // Their digits are part of a name, and sit right next to words like
    // "devices" in advisory text.
    .replace(/\b[a-z]{1,10}-?\d{2,}\+?\b/g, ' ')
    // Product model numbers, digit-prefix: digits, a hyphen, then letters
    // (1756-EN4TR, 1756-ENBT — Rockwell's own catalog-number format). Natural
    // prose never hyphenates a count directly onto its unit ("1756-users"
    // does not occur; "1,756 users" does), so this is a safe, precise
    // signal. Without it, "upgrade to 1756-EN2T or 1756-EN4TR. Users who are
    // not able to..." reads as "1756 users".
    .replace(/\b\d{2,}-[a-z][a-z0-9]*\b/g, ' ');
}

/**
 * Find the widest-reaching concrete impact figure stated in the text.
 * Returns null when the article states none.
 */
function extractImpact(title, summary) {
  const text = normalize(`${title} ${summary || ''}`);
  const scanText = stripTechnicalIdentifiers(text);
  const candidates = [];

  // --- data volumes: "25GB of data stolen", "1.2 TB of records" ---
  const byteRe = /(\d[\d,]*(?:\.\d+)?)\s*(kb|mb|gb|tb|pb|kilobytes?|megabytes?|gigabytes?|terabytes?|petabytes?)\b/g;
  for (const m of text.matchAll(byteRe)) {
    const n = parseNumber(m[1]);
    if (n === null) continue;
    const bytes = n * BYTE_UNITS[m[2]];
    candidates.push({ kind: 'data', value: bytes, label: `${formatBytes(bytes)} of data` });
  }

  // --- money: "$600,000 in AI credits", "$74 million" ---
  // The trailing \b matters: without it the "m" of a following word ("$600,000
  // metr...") is read as the million multiplier, inflating $600K to $600B.
  const moneyRe = /[$£€](\d[\d,]*(?:\.\d+)?)\s*(million|billion|thousand|k|m|b)?\b/g;
  for (const m of text.matchAll(moneyRe)) {
    const n = parseNumber(m[1]);
    if (n === null) continue;
    const value = n * (m[2] ? MULTIPLIERS[m[2]] || 1 : 1);
    const around = text.slice(Math.max(0, m.index - 70), m.index + m[0].length + 70);
    if (!MONETARY_LOSS_CONTEXT.test(around)) continue;
    candidates.push({ kind: 'money', value, label: formatMoney(value) });
  }

  // --- counted things: "9.5 million patients", "22,000 Exchange servers" ---
  // Match the quantity, then scan the next few words for the unit noun. A single
  // regex with a lazy filler group only ever tests the first following word, so
  // "153 million drivers licenses" would test "drivers", miss, and give up.
  // Leading \b matters: without it the regex can start a match on a digit
  // embedded at the *end* of a preceding word — "TPDIN-Monitor-WEB3" (a
  // single trailing digit, too short for the model-number stripper's \d{2,}
  // threshold) otherwise contributes a bare "3" with nothing before it to
  // disqualify.
  const quantityRe = /\b(\d[\d,]*(?:\.\d+)?)\s*(hundred|thousand|million|billion|trillion|k|m|b)?\b/g;
  for (const m of scanText.matchAll(quantityRe)) {
    const [, rawNum, multiplier] = m;
    const before = scanText.slice(Math.max(0, m.index - 24), m.index);
    // Anywhere near "CVSS" the number is a score, not a quantity — the vector
    // string form ("CVSS v4 9.8") puts a version between the two.
    if (/cvss/.test(before)) continue;
    if (DISQUALIFYING_PREFIX.test(before)) continue;
    // A slash immediately before means this is one half of an "X/Y" enumerated
    // pair — a hardware/firmware variant code ("6s/6m"), not a quantity. Prose
    // never writes a real count this way. Without this guard, once the
    // adjacent variant code is stripped as an identifier, "...6s/6m: Z266494
    // users should update..." collapses to "6m" sitting directly next to
    // "users" and reads as "6 million users".
    if (before.endsWith('/')) continue;
    // A three-part version "7.1.5" is two regex matches, not one — the decimal
    // group only allows a single dot, so this regex first matches "7.1" (which
    // looksLikeVersion catches by checking what follows), then resumes and
    // matches "5" on its own. Nothing about "5" in isolation looks like a
    // version, so it survived as a bare quantity. Catch it from the other
    // direction: a number directly preceded by "<digit>." is the tail of a
    // version string someone already matched, not a fresh count.
    if (/\d\.$/.test(before)) continue;
    if (looksLikeVersion(rawNum, scanText.slice(m.index + rawNum.length))) continue;

    const n = parseNumber(rawNum);
    if (n === null) continue;
    const value = n * (multiplier ? MULTIPLIERS[multiplier] : 1);
    if (value < 2) continue;
    // You cannot have 9.8 servers. A small fractional count is a score or a
    // version that slipped through; only large scaled figures may be fractional.
    if (!Number.isInteger(value) && value < 1000) continue;

    const after = scanText.slice(m.index + m[0].length, m.index + m[0].length + 70);
    const words = after.split(/[^a-z0-9'-]+/).filter(Boolean).slice(0, 4);

    for (const word of words) {
      // A clause boundary means the noun no longer belongs to this quantity.
      if (/^(?:and|or|but|that|which|with|from|after|before|said|says|in|on|to|for|of|the|a|an)$/.test(word)) {
        if (word === 'of' || word === 'the') continue; // "9.5 million of the records"
        break;
      }
      // A quantity is followed by a plural noun. Requiring one rejects
      // "7-Zip ... user interaction" and "pcid64 driver", where the digits
      // belong to a product name rather than to the noun that follows.
      const isPlural = word.endsWith('s') || INHERENTLY_PLURAL.has(word);
      if (!isPlural) continue;

      const kindEntry = UNIT_KINDS.find(([, re]) => re.test(word));
      if (kindEntry) {
        candidates.push({ kind: kindEntry[0], value, label: `${formatCount(value)} ${word}` });
        break;
      }
    }
  }

  const plausible = candidates.filter((c) => c.value <= (MAX_PLAUSIBLE[c.kind] ?? Infinity));
  if (plausible.length === 0) return null;

  // Prefer the figure representing the widest reach, comparing across kinds by
  // their normalized reach rather than raw magnitude (1 TB should not beat
  // 9.5 million patients purely because 1e12 > 9.5e6).
  return plausible.reduce((best, c) => (reachOf(c) > reachOf(best) ? c : best));
}

// --- reach normalization -----------------------------------------------------

// Each kind maps a log-scaled magnitude onto 0..1. The ranges encode that one
// compromised organization or server represents far more reach than one record.
const REACH_RANGES = {
  people: [2, 9], // 100 .. 1,000,000,000
  orgs: [0, 4], // 1 .. 10,000
  machines: [0, 7], // 1 .. 10,000,000
  data: [6, 15], // 1 MB .. 1 PB
  money: [3, 10], // $1K .. $10B
};

function reachOf(impact) {
  const range = REACH_RANGES[impact.kind];
  if (!range) return 0;
  const [lo, hi] = range;
  const magnitude = Math.log10(Math.max(impact.value, 1));
  return Math.max(0, Math.min(1, (magnitude - lo) / (hi - lo)));
}

// --- estimated reach, for the ~90% of articles with no stated figure ---------

// Software whose compromise implies very broad exposure.
const UBIQUITOUS = /\b(?:windows|microsoft|office|exchange|outlook|azure|active directory|chrome|chromium|firefox|safari|android|ios|apple|macos|linux|kernel|openssh|openssl|apache|nginx|log4j|java|python|node\.?js|npm|wordpress|cisco|fortinet|palo alto|vmware|citrix|sap|oracle|aws|google cloud|cloudflare|docker|kubernetes|zoom|slack|salesforce)\b/;
const ENTERPRISE = /\b(?:jfrog|artifactory|gitlab|github|jenkins|atlassian|confluence|jira|sonicwall|watchguard|sophos|trend micro|veeam|solarwinds|papercut|moveit|ivanti|zimbra|roundcube|langflow|rails|django|laravel|drupal|joomla|magento)\b/;
const NICHE_OT = /\b(?:rockwell|siemens|schneider|mitsubishi|honeywell|abb\b|scada|plc\b|hmi\b|ics\b|modbus|profinet)\b/;

function estimateReach({ title, summary, categories, severityScore }) {
  const text = normalize(`${title} ${summary || ''}`);
  let reach = 0.18;

  const cvss = extractCvss(text);
  if (cvss !== null) reach = Math.max(reach, 0.16 + (cvss / 10) * 0.28);

  if (UBIQUITOUS.test(text)) reach += 0.3;
  else if (ENTERPRISE.test(text)) reach += 0.16;
  else if (NICHE_OT.test(text)) reach -= 0.04;

  if (/actively exploited|exploited in the wild|under active attack|being exploited|exploitation observed/.test(text)) reach += 0.14;
  if (/known exploited vulnerabilit|kev catalog/.test(text)) reach += 0.08;
  if (/supply[- ]chain|malicious (?:package|npm|pypi|extension)/.test(text)) reach += 0.12;
  if (/worldwide|globally|global campaign|multiple countries|international/.test(text)) reach += 0.08;

  const cats = (categories || '').split(',');
  if (cats.includes('breach')) reach += 0.1;
  if (cats.includes('ransomware')) reach += 0.08;
  if (cats.includes('news')) reach -= 0.05;

  reach += Math.min(severityScore || 0, 10) * 0.012;

  // An estimate never claims the reach of a confirmed mega-incident.
  return Math.max(0.06, Math.min(0.82, reach));
}

/**
 * Continuous 0..1 reach used to drive planet size.
 */
function blastRadius(article) {
  const stated = extractImpact(article.title, article.summary);
  if (stated) {
    return {
      radius: Math.max(0.1, reachOf(stated)),
      stated: true,
      kind: stated.kind,
      value: stated.value,
      label: stated.label,
    };
  }
  return {
    radius: estimateReach(article),
    stated: false,
    kind: null,
    value: null,
    label: null,
  };
}

// --- proximity-label text ----------------------------------------------------

const SEVERITY_WORD = {
  5: 'critical', 4: 'high', 3: 'moderate', 2: 'low', 1: 'info',
};

const CATEGORY_WORD = {
  cve: 'vulnerability',
  ransomware: 'ransomware',
  breach: 'breach',
  malware: 'malware',
  phishing: 'phishing',
  news: 'incident',
};

/**
 * The second line of a planet's proximity label: the most useful concrete fact
 * available, preferring a stated impact figure and falling back through
 * exploitation status, CVSS and campaign shape.
 */
function impactFact(article, impact) {
  if (impact && impact.stated && impact.label) {
    const verb = {
      people: 'affected', orgs: 'compromised', machines: 'exposed', data: 'stolen', money: 'lost',
    }[impact.kind];
    return `${impact.label} ${verb}`;
  }

  const text = normalize(`${article.title} ${article.summary || ''}`);
  const cvss = extractCvss(text);
  const exploited = /actively exploited|exploited in the wild|under active (?:attack|exploitation)|being exploited|exploitation (?:observed|underway)/.test(text);
  const kev = /known exploited vulnerabilit|kev catalog/.test(text);

  if (kev) return 'added to CISA KEV';
  if (exploited && cvss !== null) return `CVSS ${cvss}, exploited in the wild`;
  if (exploited) return 'exploited in the wild';
  if (/zero-?day|0-?day/.test(text)) return 'zero-day disclosed';
  if (cvss !== null) return `CVSS ${cvss}`;
  if (/supply[- ]chain|malicious (?:package|npm|pypi|extension)/.test(text)) return 'supply-chain compromise';
  if (/ransomware/.test(text)) return 'ransomware activity';
  if (/data breach|breached|leaked/.test(text)) return 'breach disclosed';
  if (/arrest|indict|charge|takedown|seiz|sanction/.test(text)) return 'law enforcement action';
  if (/patch|update|advisory/.test(text)) return 'patch available';
  if (/campaign/.test(text)) return 'active campaign';

  // No figure and no status signal — say what kind of thing it is rather than
  // reporting an absence, which tells the reader nothing.
  const cats = (article.categories || 'news').split(',');
  if (cats.includes('ransomware')) return 'ransomware reported';
  if (cats.includes('breach')) return 'breach reported';
  if (cats.includes('malware')) return 'malware activity';
  if (cats.includes('phishing')) return 'phishing activity';
  if (cats.includes('cve')) return 'vulnerability disclosed';
  return 'incident reported';
}

/**
 * Two-line proximity label: "<CATEGORY> · <SEVERITY>" over the strongest fact.
 */
function proximityLabel(article, impact) {
  const categories = (article.categories || 'news').split(',');
  const primary = ['ransomware', 'breach', 'cve', 'malware', 'phishing', 'news']
    .find((c) => categories.includes(c)) || 'news';

  return {
    headline: `${CATEGORY_WORD[primary]} · ${SEVERITY_WORD[article.severity_tier] || 'info'}`,
    fact: impactFact(article, impact),
  };
}

module.exports = {
  extractImpact,
  blastRadius,
  reachOf,
  estimateReach,
  impactFact,
  proximityLabel,
  formatCount,
  formatBytes,
  formatMoney,
};
