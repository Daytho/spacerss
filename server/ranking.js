const {
  titleSimilarity, titleTokens, leadingTokens, entityTokens,
} = require('./classify');

// Impact halves every 24h, so a critical story holds prime slots for a day or
// two and then yields to fresher material rather than camping forever.
const HALF_LIFE_HOURS = 24;
// How far back the candidate pool reaches. Anything older has decayed past the
// point of competing for a slot anyway.
const LOOKBACK_HOURS = 24 * 7;
const CANDIDATE_LIMIT = 300;
// Fraction of a screen one source may occupy, so a 49-advisory ZDI batch dump
// or a same-day run of CISA ICS advisories can't crowd out everything else.
const SOURCE_SHARE = 0.2;
const MIN_PER_SOURCE = 2;
// Token overlap above which two headlines are treated as the same story.
const SIMILARITY_THRESHOLD = 0.6;
// Two outlets rewriting the same story often share little vocabulary — "…Nutex
// says patient data stolen in ransomware attack" vs "Ransomware Gang Claims
// Nutex Health Data Breach" overlap only 43%. But they share a rare token
// ("nutex"), which is far stronger evidence than the raw overlap suggests, so a
// shared distinctive token lowers the bar.
const DISTINCTIVE_MAX_DF = 3;
const DISTINCTIVE_MIN_LEN = 4;
/**
 * Words that must never count as a distinctive entity, however rare they happen
 * to be in the current pool. Document frequency alone is not enough: across only
 * a few hundred headlines an ordinary word like "health" can sit at df <= 3 and
 * masquerade as a company name. That merged two unrelated healthcare breaches
 * (Aesto Health and Nutex Health) into one story on the strength of
 * "health" + "data" + "breach".
 */
const NEVER_DISTINCTIVE = new Set([
  // security vocabulary
  'attack', 'attacks', 'attackers', 'breach', 'breaches', 'breached', 'hacker',
  'hackers', 'hacked', 'malware', 'ransomware', 'phishing', 'spyware', 'botnet',
  'exploit', 'exploits', 'exploited', 'vulnerability', 'vulnerabilities', 'flaw',
  'flaws', 'patch', 'patches', 'patched', 'threat', 'threats', 'actor', 'actors',
  'campaign', 'security', 'cyber', 'cyberattack', 'infostealer', 'backdoor',
  'zero', 'critical', 'advisory', 'advisories', 'severity', 'compromise',
  'compromised', 'leak', 'leaked', 'stolen', 'exposed', 'victim', 'victims',
  'intrusion', 'extortion', 'credentials', 'password', 'passwords',
  // generic nouns that recur in headlines
  'health', 'healthcare', 'data', 'records', 'record', 'users', 'user',
  'customers', 'customer', 'patients', 'patient', 'accounts', 'account',
  'employee', 'employees', 'million', 'billion', 'thousands', 'hundreds',
  'company', 'companies', 'firm', 'firms', 'agency', 'agencies', 'government',
  'federal', 'court', 'group', 'groups', 'gang', 'claims', 'report', 'reports',
  'warns', 'warning', 'update', 'updates', 'tool', 'tools', 'service',
  'services', 'platform', 'system', 'systems', 'network', 'networks', 'server',
  'servers', 'software', 'file', 'files', 'email', 'cloud', 'access', 'remote',
  'execution', 'escalation', 'bypass', 'injection', 'operator', 'operators',
  'incident', 'incidents',
  // generic headline verbs and modifiers — these carry no identity, but are
  // rare enough in a few-hundred-item pool to look like entity names.
  // "affects" alone merged the Aesto Health and Novocure breaches.
  'affects', 'affected', 'affecting', 'impacts', 'impacted', 'impacting',
  'hits', 'targets', 'targeted', 'targeting', 'exposes', 'exposing',
  'reveals', 'revealed', 'discloses', 'disclosed', 'confirms', 'confirmed',
  'announces', 'announced', 'adds', 'added', 'faces', 'facing', 'says', 'said',
  'uses', 'used', 'using', 'pushes', 'pushed', 'turns', 'turned', 'gives',
  'allows', 'allowed', 'enables', 'enabled', 'causes', 'caused', 'forces',
  'urges', 'urged', 'plans', 'seeks', 'wants', 'needs', 'offers', 'provides',
  'includes', 'contains', 'involves', 'related', 'linked', 'following',
  'launches', 'launched', 'claimed', 'claim', 'takes', 'taken', 'makes',
  'made', 'finds', 'found', 'shows', 'gets', 'still', 'again', 'amid',
  'despite', 'across', 'against', 'without', 'behind', 'among', 'nearly',
  'thousands', 'dozens', 'several', 'multiple', 'other', 'others', 'many',
  // generic hardware/product descriptors — advisory prose capitalizes part
  // names mid-sentence ("the Redundancy Module", "the Configuration Tool"),
  // which the entity detector reads as a proper noun. "module" alone merged
  // two unrelated Rockwell Automation advisories — Redundancy Module
  // Configuration Tool and 1756-ENBT Module are different products.
  'module', 'modules', 'controller', 'controllers', 'manager', 'managers',
  'device', 'devices', 'series', 'unit', 'units', 'component', 'components',
  'communications', 'communication', 'activation', 'redundancy', 'classic',
  'advanced', 'professional', 'standard', 'enterprise', 'edition', 'version',
  'product', 'products', 'firmware', 'driver', 'drivers', 'application',
  'applications', 'hardware', 'interface', 'configuration',
]);
const DISTINCTIVE_SIMILARITY_THRESHOLD = 0.25;
// Guard on the relaxed path: a short headline can reach the similarity
// threshold on a single shared word, which is not enough to call it the same
// story. Require real overlap as well as the rare token.
const DISTINCTIVE_MIN_SHARED = 2;
// Two items can only be the same story if they were published near each other.
// Some headlines recur verbatim on a schedule — CISA posts "CISA Adds Two Known
// Exploited Vulnerabilities to Catalog" most weeks, naming different CVEs each
// time — and without this bound, months of separate advisories merge into one.
const MERGE_WINDOW_HOURS = 72;
// Each additional source corroborating a story adds this much impact.
const CORROBORATION_BONUS = 1;
const MAX_CORROBORATION_BONUS = 3;

function ageHoursOf(row, now) {
  return Math.max(0, (now - new Date(row.published_at).getTime()) / 3_600_000);
}

function decay(ageHours) {
  return 0.5 ** (ageHours / HALF_LIFE_HOURS);
}

/**
 * Document frequency across the candidate pool, used to find tokens rare enough
 * to identify a specific story (a company or product name) rather than the
 * subject matter generally ("ransomware", "critical", "microsoft").
 */
function analyzeTokens(rows) {
  const df = new Map();
  const perRow = rows.map((row) => {
    const tokens = titleTokens(row.title);
    for (const t of tokens) df.set(t, (df.get(t) || 0) + 1);
    return tokens;
  });

  // A token identifies *this* story only if it is both entity-like (a name) and
  // rare in the pool. Requiring both is what keeps "affects" and "infrastructure"
  // out while keeping "nutex" and "langflow" in.
  const distinctive = rows.map((row, i) => {
    const entities = entityTokens(row.title, row.summary);
    const rare = new Set();
    for (const t of perRow[i]) {
      if (
        t.length >= DISTINCTIVE_MIN_LEN
        && df.get(t) <= DISTINCTIVE_MAX_DF
        && !NEVER_DISTINCTIVE.has(t)
        && entities.has(t)
      ) rare.add(t);
    }
    return rare;
  });

  return { tokens: perRow, distinctive };
}

function sharesDistinctiveToken(a, b) {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

function sharedTokenCount(a, b) {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared;
}

/**
 * True when every word of a leading-tokens phrase is generic vocabulary
 * (NEVER_DISTINCTIVE) rather than a name. "rockwell automation" identifies a
 * vendor; "hackers exploit" is just how headlines start a sentence and
 * identifies nothing. Shared prefixes of the second kind must not be treated
 * as evidence of a common vendor/product line.
 */
function isGenericPhrase(prefix) {
  return prefix.split(' ').every((word) => NEVER_DISTINCTIVE.has(word));
}

/**
 * Title similarity, but blind to a shared vendor/product-line prefix.
 *
 * Advisory titles are "<Vendor> <Product>" — two titles from the same vendor
 * trivially share those leading words, which inflates raw overlap on short
 * titles: "Rockwell Automation RSLinx Classic" vs "Rockwell Automation
 * ControlFLASH" are two unrelated advisories, but "rockwell"+"automation" is
 * 2 of ControlFLASH's 3 tokens — 67% overlap, past the 60% threshold, despite
 * naming completely different products. Stripping the prefix both titles
 * share before comparing means the match has to come from the part that
 * actually distinguishes one story from another.
 *
 * The prefix must itself be a name and not generic phrasing — "Hackers
 * Exploit X" vs "Hackers Exploit Y" share only journalistic boilerplate, so
 * stripping it is skipped and the titles compare on their full, unstripped
 * token sets instead.
 */
function significantSimilarity(aTitle, bTitle) {
  const prefix = leadingTokens(aTitle);
  if (!prefix || prefix !== leadingTokens(bTitle) || isGenericPhrase(prefix)) {
    return titleSimilarity(aTitle, bTitle);
  }
  const strip = (title) => {
    const t = titleTokens(title);
    prefix.split(' ').forEach((word) => t.delete(word));
    return t;
  };
  const ta = strip(aTitle);
  const tb = strip(bTitle);
  if (ta.size === 0 || tb.size === 0) return 0;
  return sharedTokenCount(ta, tb) / Math.min(ta.size, tb.size);
}

/**
 * Collapse retellings of one story into a single entry. Three things count as
 * the same story: a shared CVE id, high headline overlap, or a shared rare token
 * plus moderate overlap. A vendor's same-day advisory batch is collapsed too, so
 * six Rockwell ICS advisories occupy one slot instead of six.
 *
 * Corroboration is itself an importance signal, so the survivor is boosted
 * rather than merely deduplicated, and records who else carried it.
 */
function collapseDuplicates(rows) {
  const { tokens, distinctive } = analyzeTokens(rows);
  const leads = rows.map((row) => leadingTokens(row.title));
  const publishedMs = rows.map((row) => new Date(row.published_at).getTime());

  // Content match only — the time bound is enforced separately, at the group
  // level, below. A pairwise-only check here is not enough: single-linkage
  // clustering joins a new row to a group if it matches *any* member, so a
  // chain of daily posts (each within 72h of the previous one) can walk the
  // group's total span arbitrarily far past MERGE_WINDOW_HOURS even though no
  // single pair in the chain violates it. CISA's recurring "Adds Known
  // Exploited Vulnerabilities" headline did exactly this — nine posts each
  // ~24h from a neighbor chained into one group spanning 96 hours.
  function isSameStoryContent(i, j) {
    const a = rows[i];
    const b = rows[j];

    if (a.dedupe_key && b.dedupe_key && a.dedupe_key === b.dedupe_key) return true;

    const similarity = significantSimilarity(a.title, b.title);
    if (similarity >= SIMILARITY_THRESHOLD) return true;

    if (
      similarity >= DISTINCTIVE_SIMILARITY_THRESHOLD
      && sharedTokenCount(tokens[i], tokens[j]) >= DISTINCTIVE_MIN_SHARED
      && sharesDistinctiveToken(distinctive[i], distinctive[j])
    ) return true;

    // Same publisher, same day, same vendor/product prefix -> one advisory batch.
    // Only trustworthy when that shared prefix is an actual name ("Rockwell
    // Automation") rather than generic headline phrasing: two unrelated
    // BleepingComputer stories both titled "Hackers exploit <product> flaw..."
    // share the leading words "hackers exploit" and are neither the same
    // vendor nor the same story.
    if (
      a.source === b.source
      && a.published_at.slice(0, 10) === b.published_at.slice(0, 10)
      && leads[i].length > 0
      && leads[i] === leads[j]
      && !isGenericPhrase(leads[i])
    ) return true;

    return false;
  }

  const groups = [];
  rows.forEach((row, i) => {
    const match = groups.find((group) => {
      // Compare against every member, not just the group head: an outlet's
      // retelling may resemble a later member of a group without resembling
      // whichever item happened to open it.
      const contentMatch = group.some(({ index }) => isSameStoryContent(i, index));
      if (!contentMatch) return false;

      // Group-level time bound: joining must not stretch the group's total
      // span past MERGE_WINDOW_HOURS, even though the content match above
      // only had to hold against one member.
      const times = group.map(({ index }) => publishedMs[index]);
      const span = Math.max(publishedMs[i], ...times) - Math.min(publishedMs[i], ...times);
      return span / 3_600_000 <= MERGE_WINDOW_HOURS;
    });
    if (match) match.push({ row, index: i });
    else groups.push([{ row, index: i }]);
  });

  return groups.map((group) => {
    const members = group.map((g) => g.row);
    // Keep the highest-scoring telling of the story.
    const best = members.reduce((a, b) => (b.severity_score > a.severity_score ? b : a));
    const otherSources = [...new Set(
      members.filter((r) => r.source !== best.source).map((r) => r.source),
    )];
    return {
      ...best,
      corroboration: otherSources.length + 1,
      also_reported_by: otherSources,
      grouped_count: members.length,
    };
  });
}

function scoreOf(row, now) {
  const bonus = Math.min(
    (row.corroboration - 1) * CORROBORATION_BONUS,
    MAX_CORROBORATION_BONUS,
  );
  const impact = row.severity_score + bonus + 1; // +1 so a score-0 item still decays rather than pinning at zero
  return impact * decay(ageHoursOf(row, now));
}

/**
 * Choose which unpinned articles get the remaining visible slots: rank by
 * severity-weighted recency, then enforce per-source diversity.
 */
function selectVisible(candidates, limit, now = Date.now()) {
  if (limit <= 0) return [];

  const collapsed = collapseDuplicates(candidates);
  const ranked = collapsed
    .map((row) => ({ row, score: scoreOf(row, now) }))
    .sort((a, b) => b.score - a.score);

  const perSourceCap = Math.max(MIN_PER_SOURCE, Math.ceil(limit * SOURCE_SHARE));
  const counts = new Map();
  const picked = [];
  const overflow = [];

  for (const { row } of ranked) {
    if (picked.length >= limit) break;
    const used = counts.get(row.source) || 0;
    if (used >= perSourceCap) {
      overflow.push(row);
      continue;
    }
    counts.set(row.source, used + 1);
    picked.push(row);
  }

  // If diversity caps left slots unfilled, backfill with the best of what they excluded.
  for (const row of overflow) {
    if (picked.length >= limit) break;
    picked.push(row);
  }

  return picked;
}

module.exports = { selectVisible, scoreOf, collapseDuplicates, LOOKBACK_HOURS, CANDIDATE_LIMIT };
