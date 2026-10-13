// geoprobe_headless.mjs — Node port of the 8 checks in solo_tools_hub/geoprobe/index.html
// Purpose: run the SAME checks against external pages so the tool is not validated only on our own pages.
// Fidelity rule: every check below is a line-by-line port. If you change one, change the HTML too (and note it).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));

const UA = 'Mozilla/5.0 (compatible; NeedProfitBot/1.0)';

function stripTags(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/g, '/')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');
}

function run(html, robotsTxt) {
  const res = [];
  const text = stripTags(html || '');

  // 1. Server-rendered body text
  const visibleLen = text.trim().length;
  res.push({
    n: 1, name: 'Body text is server-rendered', src: 'arxiv-2510.11560',
    st: !html ? 'warn' : (visibleLen >= 600 ? 'pass' : 'fail'),
    msg: !html ? 'No HTML supplied.'
      : visibleLen >= 600
        ? visibleLen.toLocaleString('en-US') + ' characters of text are present in the served HTML.'
        : 'Only ' + visibleLen + ' characters of text found in the HTML. Target 600+.'
  });

  // 2. Structured data
  const hasLd = /<script[^>]+application\/ld\+json/i.test(html || '');
  const hasMicro = /itemscope|itemtype\s*=|schema\.org/i.test(html || '');
  res.push({
    n: 2, name: 'Structured data present', src: 'writeso-2026-07',
    st: !html ? 'warn' : (hasLd ? 'pass' : (hasMicro ? 'pass' : 'fail')),
    msg: !html ? 'No HTML supplied.'
      : hasLd ? 'JSON-LD or microdata schema detected.'
        : hasMicro ? 'Microdata detected but no JSON-LD block.'
          : 'No JSON-LD or microdata found.'
  });

  // 3. Extractable list form
  const listItems = html ? (html.match(/<li[\s>]/gi) || []).length : 0;
  const paras = html ? (html.match(/<p[\s>]/gi) || []).length : 0;
  const listRatio = (listItems + paras) > 0 ? listItems / (listItems + paras) : 0;
  res.push({
    n: 3, name: 'Content in extractable list form', src: 'wellows-2026',
    st: !html ? 'warn' : (listRatio >= 0.25 ? 'pass' : 'fail'),
    msg: !html ? 'No HTML supplied.'
      : listItems + ' <li> vs ' + paras + ' <p> (' + Math.round(listRatio * 100) + '% list-shaped).'
  });

  // 4. Numbers + attribution
  const numHits = html ? (text.match(/\d[\d,\.]*\s*(?:%|usd|\$|days?|hours?|minutes?|months?|orders?|users?|customers?|subscribers?|views?|ms|x\b|天|小时|分钟|个|单|次|美元)/gi) || []).length : 0;
  const hasCiteish = /(according to|source:|study|survey|preprint|arxiv|et al\.|研究|来源|数据来自|\[\d+\])/i.test(text);
  res.push({
    n: 4, name: 'Precise figures that name their source', src: 'ahrefs-12pct',
    st: !html ? 'warn' : ((numHits >= 3 && hasCiteish) ? 'pass' : ((numHits >= 3 || hasCiteish) ? 'warn' : 'fail')),
    msg: numHits + ' quantified claim(s) detected; attribution marker ' + (hasCiteish ? 'present' : 'absent') + '.'
  });

  // 5. Topic cluster / internal links
  const internalLinks = html ? (html.match(/href\s*=\s*["'][^"'#:\/]*(?:\.html|\/)/gi) || []).length : 0;
  res.push({
    n: 5, name: 'Part of a topic cluster', src: 'writeso-2026-07',
    st: !html ? 'warn' : (internalLinks >= 3 ? 'pass' : 'fail'),
    msg: internalLinks + ' internal page link(s) found.'
  });

  // 6. Absolute canonical
  const canon = html ? ((html.match(/<link[^>]+rel\s*=\s*["']canonical["'][^>]*>/i) || [])[0] || '') : '';
  const canonAbs = /href\s*=\s*["']https?:\/\//i.test(canon);
  res.push({
    n: 6, name: 'Absolute canonical URL', src: 'writeso-2026-07',
    st: !html ? 'warn' : (canonAbs ? 'pass' : 'fail'),
    msg: canonAbs ? 'Canonical points at an absolute URL.'
      : (canon ? 'Canonical found but it is relative.' : 'No canonical link tag found.')
  });

  // 7. Visible date
  const hasDate = /(20\d\d-\d\d-\d\d|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+20\d\d)/i.test(text);
  res.push({
    n: 7, name: 'A visible last-updated date', src: 'writeso-2026-07',
    st: hasDate ? 'pass' : 'warn',
    msg: hasDate ? 'A human-readable date is present in the text.' : 'No readable date found in the visible text.'
  });

  // 8. AI crawler access
  const robotsSeen = !!robotsTxt;
  const robotsBlocked = robotsSeen && /(gptbot|claudebot|perplexitybot|google-extended|ccbot)[\s\S]{0,80}disallow/i.test(robotsTxt);
  res.push({
    n: 8, name: 'AI crawlers not blocked by robots.txt', src: 'arxiv-2510.11560',
    st: !robotsSeen ? 'warn' : (robotsBlocked ? 'fail' : 'pass'),
    msg: !robotsSeen ? 'robots.txt not available for this run, so this check is unverified.'
      : robotsBlocked ? 'robots.txt appears to Disallow a major AI crawler.'
        : 'robots.txt was checked and does not block the major AI crawlers.'
  });

  return res;
}

async function fetchOne(url) {
  const base = new URL(url).origin;
  let html = null, robots = null, note = '';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    if (!r.ok) note = 'page HTTP ' + r.status;
    html = await r.text();
  } catch (e) { note = 'page fetch failed: ' + e.message; }
  try {
    const r2 = await fetch(base + '/robots.txt', { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (r2.ok) robots = await r2.text();
  } catch (e) { /* robots missing is reported as unverified by check 8 */ }

  const checks = run(html, robots);
  const pass = checks.filter(c => c.st === 'pass').length;
  const warn = checks.filter(c => c.st === 'warn').length;
  const fail = checks.filter(c => c.st === 'fail').length;
  const title = (html ? (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] : null) || '(no title)';
  return {
    url, fetched: new Date().toISOString().slice(0, 19) + 'Z',
    bytes: html ? html.length : 0, title: title.replace(/\s+/g, ' ').trim().slice(0, 110),
    robots_fetched: robots !== null, fetch_note: note || '',
    score_pass: pass, unverified: warn, failing: fail, total_checks: checks.length, checks
  };
}

const TARGETS = process.argv.slice(2);
if (!TARGETS.length) { console.error('usage: node geoprobe_headless.mjs <url> [url...]'); process.exit(1); }

const out = [];
for (const u of TARGETS) {
  process.stdout.write('fetching ' + u + ' ... ');
  const r = await fetchOne(u);
  out.push(r);
  console.log(r.score_pass + '/' + r.total_checks + ' pass, ' + r.unverified + ' unverified, ' + r.failing + ' fail' + (r.fetch_note ? '  [' + r.fetch_note + ']' : ''));
}
mkdirSync(join(__dirname, 'out'), { recursive: true });
const OUT = join(__dirname, 'out', 'page-report.json');
writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString(),
  method: 'Node port of the 8 checks in the browser version. Same thresholds.',
  caveat: 'Scores a page\'s own served HTML. It does NOT prove any engine actually cites that page. Readiness is a precondition, not an outcome.',
  results: out
}, null, 1));
console.log('\nwrote ' + OUT);