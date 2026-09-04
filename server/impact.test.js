/**
 * Impact-extraction tests. Run: node server/impact.test.js
 *
 * Cases marked [real] come from actual feed items; [synthetic] cover units that
 * no article in the current corpus happens to use (data volumes especially), so
 * they are still guaranteed to work when such an article arrives.
 */
const { extractImpact, blastRadius } = require('./impact');

let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

function expectImpact(name, title, summary, expected) {
  const got = extractImpact(title, summary);
  if (expected === null) {
    check(name, got === null, `expected no figure, got ${got && JSON.stringify(got.label)}`);
    return;
  }
  check(
    name,
    got && got.kind === expected.kind && Math.abs(got.value - expected.value) < expected.value * 0.01,
    got
      ? `got ${got.kind} ${got.value} ("${got.label}"), expected ${expected.kind} ${expected.value}`
      : 'got null',
  );
}

// --- [real] counts that must be found ---
expectImpact('9.5 million patients',
  'Aesto Health says data breach affects over 9.5 million patients', '',
  { kind: 'people', value: 9.5e6 });

expectImpact('153 million licences',
  'FBI Probes Service Selling 153M+ Drivers Licenses',
  'selling digital scans of more than 153 million drivers licenses', { kind: 'people', value: 153e6 });

expectImpact('22,000 servers',
  'Nearly 22,000 Microsoft Exchange servers vulnerable to attack', '',
  { kind: 'machines', value: 22000 });

expectImpact('31 orgs',
  'ClickFix Campaign Compromises 31 Orgs, Abuses Polygon Blockchain', '',
  { kind: 'orgs', value: 31 });

expectImpact('1,400 patients',
  'Novocure data breach affects more than 1,400 cancer patients', '',
  { kind: 'people', value: 1400 });

// --- [real] traps that must NOT be read as impact ---
expectImpact('CVSS score is not a count',
  'Applied Systems Engineering ASE2000 V2 Communications Test Set',
  'CVSS v4 9.8 applied systems engineering has released a fix.', null);

expectImpact('version number is not a count',
  'Rockwell Automation RSLinx Classic',
  'Users should update to version 4.60. Mitigation guidance is available for customers.', null);

expectImpact('dotted version is not a count',
  'Rockwell Automation Redundancy Module Configuration Tool',
  'Update to 10.01.00 for users of affected systems.', null);

expectImpact('CVE identifier digits are not a quantity',
  'Rockwell Automation RSLinx Classic',
  'RSLinx Classic <=4.50 (CVE-2026-9621, CVE-2026-9622, CVE-2026-9624) CVSS vendor equipment.',
  null);

expectImpact('a following word starting with m/b is not a multiplier',
  'Attackers Steal METR API Key and Consume AI Credits Worth About $600,000',
  'METR (short for Model Evaluation and Threat Research) disclosed the incident.',
  { kind: 'money', value: 600000 });

expectImpact('advisory boilerplate "vendor" is not a counted org',
  'Bendix EC80 Brake ECU',
  'The vendor recommends users update. Bendix EC80 controller, model 286000 series.',
  null);

expectImpact('product-name digits with a singular noun are ignored',
  'ZDI-26-444: 7-Zip XZ Decompression Heap-based Buffer Overflow',
  'User interaction is required to exploit this vulnerability.', null);

expectImpact('product model numbers are not counts',
  'ZDI-26-516: Phoenix Contact CHARX SEC-3000 Command Injection',
  'Affected devices include the CHARX SEC-3150 and SEC-3000 charging controllers.',
  null);

expectImpact('CWE identifier digits are not a count',
  'Rently Smart Home',
  'CWE-522 Insufficiently Protected Credentials. CWE-798 Use of Hard-coded Credentials.',
  null);

expectImpact('implausible magnitudes are rejected',
  'Is Cyber Facing an Affordability Crisis?',
  'Security spending across 240 billion businesses worldwide is forecast to rise.',
  null);

expectImpact('market-size money is not an impact figure',
  'Is Cyber Facing an Affordability Crisis?',
  'Global security spending is forecast to reach $240 billion across the market.', null);

expectImpact('no figure at all',
  'Attackers Pounce on Critical Artifactory Flaw Following Disclosure',
  'An authentication bypass flaw enables admin-level access.', null);

// --- [synthetic] data volumes: absent from the current corpus, required by spec ---
expectImpact('25GB stolen',
  'Ransomware gang leaks 25GB of data stolen from manufacturer', '',
  { kind: 'data', value: 25e9 });

expectImpact('1.2 TB spelled out',
  'Attackers exfiltrated 1.2 terabytes of internal documents', '',
  { kind: 'data', value: 1.2e12 });

expectImpact('800 MB',
  'Leak site publishes 800 MB of stolen records', '',
  { kind: 'data', value: 800e6 });

// --- [synthetic + real] money ---
expectImpact('$600,000 in credits',
  'Attackers Steal METR API Key and Consume AI Credits Worth About $600,000', '',
  { kind: 'money', value: 600000 });

expectImpact('$74 million',
  'Crypto exchange loses $74 million in exploit', '',
  { kind: 'money', value: 74e6 });

// --- widest figure wins when several are present ---
{
  const got = extractImpact(
    'Breach hits 12 organizations, exposing 4.2 million customer records', '',
  );
  check(
    'picks the widest-reaching figure among several',
    got && got.kind === 'people' && got.value === 4.2e6,
    got ? `got ${got.kind} ${got.value}` : 'got null',
  );
}

// --- blast radius behaviour ---
{
  const mega = blastRadius({
    title: 'Breach affects 153 million people', summary: '', categories: 'breach', severityScore: 5,
  });
  const niche = blastRadius({
    title: 'Rockwell Automation Logix Platform', summary: 'CVSS v4 7.5 industrial controller advisory.', categories: 'cve', severityScore: 7,
  });
  const ubiquitous = blastRadius({
    title: 'Actively exploited zero-day in Microsoft Windows', summary: 'CVSS 9.8 remote code execution.', categories: 'cve', severityScore: 9,
  });

  check('stated mega-breach outranks estimates', mega.radius > ubiquitous.radius,
    `mega=${mega.radius.toFixed(2)} ubiquitous=${ubiquitous.radius.toFixed(2)}`);
  check('ubiquitous software outranks niche OT', ubiquitous.radius > niche.radius,
    `ubiquitous=${ubiquitous.radius.toFixed(2)} niche=${niche.radius.toFixed(2)}`);
  check('stated flag is set correctly', mega.stated === true && niche.stated === false);
  check('all radii are within 0..1',
    [mega, niche, ubiquitous].every((r) => r.radius >= 0 && r.radius <= 1));
}

// --- size and colour are genuinely independent ---
{
  // Low severity, enormous reach.
  const bigMild = blastRadius({
    title: 'Old marketing database with 40 million email addresses found exposed',
    summary: '', categories: 'breach', severityScore: 2,
  });
  // Maximum severity, tiny reach.
  const smallSevere = blastRadius({
    title: 'Critical actively exploited flaw in niche PLC firmware',
    summary: 'CVSS 9.9', categories: 'cve', severityScore: 10,
  });
  check('a low-severity mega-breach is larger than a critical niche flaw',
    bigMild.radius > smallSevere.radius,
    `bigMild=${bigMild.radius.toFixed(2)} smallSevere=${smallSevere.radius.toFixed(2)}`);
}

console.log(`\nimpact: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
