const Parser = require('rss-parser');

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'SpaceRSS/1.0 (local news aggregator)' },
});

const SOURCES = [
  { name: 'Krebs on Security', url: 'https://krebsonsecurity.com/feed/' },
  { name: 'The Hacker News', url: 'https://feeds.feedburner.com/TheHackersNews' },
  { name: 'BleepingComputer', url: 'https://www.bleepingcomputer.com/feed/' },
  { name: 'Dark Reading', url: 'https://www.darkreading.com/rss.xml' },
  { name: 'The Record', url: 'https://therecord.media/feed/' },
  { name: 'SecurityWeek', url: 'https://www.securityweek.com/feed/' },
  { name: 'SANS Internet Storm Center', url: 'https://isc.sans.edu/rssfeed_full.xml' },
  { name: 'Schneier on Security', url: 'https://www.schneier.com/feed/atom/' },
  { name: 'CISA Cybersecurity Advisories', url: 'https://www.cisa.gov/cybersecurity-advisories/all.xml' },
  { name: 'CISA Current Activity', url: 'https://us-cert.cisa.gov/ncas/current-activity.xml' },
  { name: 'Zero Day Initiative', url: 'https://www.zerodayinitiative.com/rss/published/' },
  { name: 'Malwarebytes Labs', url: 'https://www.malwarebytes.com/blog/feed/index.xml' },
];

function normalizeItem(source, item) {
  const guid = item.guid || item.id || item.link;
  const publishedAt = item.isoDate || (item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString());
  return {
    source,
    title: (item.title || '').trim(),
    link: item.link || '',
    summary: (item.contentSnippet || item.summary || item.content || '').trim(),
    published_at: publishedAt,
    guid,
  };
}

async function fetchSource({ name, url }) {
  try {
    const feed = await parser.parseURL(url);
    return (feed.items || [])
      .filter((item) => item.link || item.guid || item.id)
      .map((item) => normalizeItem(name, item));
  } catch (err) {
    console.error(`[feeds] failed to fetch "${name}" (${url}): ${err.message}`);
    return [];
  }
}

async function fetchAllFeeds() {
  const results = await Promise.all(SOURCES.map(fetchSource));
  return results.flat();
}

module.exports = { SOURCES, fetchAllFeeds, fetchSource };
