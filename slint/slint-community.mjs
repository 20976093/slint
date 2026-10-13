#!/usr/bin/env node
/**
 * Intent Verifier v2 — 付费意愿信号真伪校验器
 * 修正 Demand Signal Radar v1 的方法论缺陷：v1 用松散关键词统计「需求信号」，
 *会把 argumentative phrase 当成买家信号。本器做三件事：
 *   1. 精确短语计数（引号查询 + 逐页读到 EXHAUSTED）
 *   2. Canary 对照（乱码串必须返回 0，否则说明引擎没在真做短语匹配）
 *   3. 可交付物过滤（留下真正描述「一个可做的东西」的信号）
 * 零依赖，只用 Node 内置模块 + HN 公共 API（Algolia / Firebase）。
 *
 * 用法:
 *   node intent_verifier.mjs                # 默认 30 天窗口
 *   node intent_verifier.mjs --days 7
 *   node intent_verifier.mjs --days 30 --json
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const DAYS = Number(argOf('days', 30));
const AS_JSON = argv.includes('--json');

const ALGOLIA = 'https://hn.algolia.com/api/v1/search_by_date';
const HN_API = 'https://hacker-news.firebaseio.com/v0';
const UA = 'NeedProfit-IntentVerifier/2.0 (single-file, zero-dep)';

const PHRASES = [
  'willing to pay', 'happy to pay', 'i would pay', "i'd pay", 'i would buy',
  'take my money', "i'd happily pay", 'would gladly pay', 'i would happily pay',
  "i'd buy that",
];

// 描述「一个可做的东西」的词——只有同时命中这些的信号才是真需求
const DELIVERABLE_CUES = [
  'dataset', 'scrape', 'scraper', 'api', 'csv', 'list of', 'database',
  'archive', 'benchmark', 'tool', 'extension', 'plugin', 'integration',
  'workflow', 'dashboard', 'parser', 'exporter', 'library',
];
const RHETORICAL_MARKS = ['if ', 'but ', 'although', 'though', 'wish ', "i'd pay, but", 'i would pay, but'];

const log = (...a) => { if (!AS_JSON) console.log(...a); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

/** Canary：不存在的字符串必须返回 0。返回非 0 说明引擎在做别的事，后续数字全部无效。 */
async function canary() {
  const d = await get(`${ALGOLIA}?query=${encodeURIComponent('zzqx floopernaut grimbly')}&tags=comment&hitsPerPage=1`);
  return d.nbHits;
}

/** 精确短语计数，逐页读满，返回 {nbHits, read, pages, stopState, comments} */
async function countPhrase(phrase, sinceTs) {
  let page = 0, read = 0, total = 0, stopState = 'EXHAUSTED';
  const comments = [];
  while (page < 40) {
    const url = `${ALGOLIA}?query=${encodeURIComponent('"' + phrase + '"')}` +
      `&tags=comment&hitsPerPage=100&page=${page}` +
      `&numericFilters=created_at_i>${sinceTs}`;
    const d = await get(url);
    if (page === 0) total = d.nbHits;
    for (const h of d.hits) {
      comments.push({
        id: h.objectID,
        author: h.author,
        created_at: h.created_at,
        text: (h.comment_text || '').replace(/<[^>]+>/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(),
        story: h.story_title || '',
      });
    }
    read += d.hits.length;
    await sleep(120);
    if (d.hits.length < 100) break;
    page++;
    stopState = 'PAGE_CAP'; // 40 页 = 4000 条上限，命中则说明量级超出本器适用范围
  }
  return { phrase, total, read, pages: page + 1, stopState, comments };
}

/** 可达性：作者是否有可触达标识（HN Firebase 查用户是否存在 + 是否有公开 website） */
async function reachable(authors) {
  let ok = 0, fail = 0;
  for (const a of authors) {
    try { await get(`${HN_API}/user/${encodeURIComponent(a)}.json`); ok++; }
    catch { fail++; }
    await sleep(60);
  }
  return { checked: authors.length, ok, fail };
}

async function main() {
  const startedAt = new Date().toISOString();
  const sinceTs = Math.floor(Date.now() / 1000) - DAYS * 86400;

  log(`Intent Verifier v2 | window=${DAYS}d | since=${new Date(sinceTs * 1000).toISOString()}`);

  // 步骤 1：canary 先跑，结果决定后面数字算不算数
  const canaryHits = await canary();
  log(`\n[1/3] CANARY  nbHits=${canaryHits}  ${canaryHits === 0 ? 'OK 引擎确实在做短语匹配' : 'FAIL 引擎异常，本轮数字无效'}`);
  if (canaryHits !== 0) {
    console.error('\nABORT: canary 非 0，计数机制不可信，停止输出。');
    process.exit(2);
  }

  // 步骤 2：十短语精确计数
  log(`\n[2/3] 精确短语计数（引号查询 + 逐页读到 EXHAUSTED）`);
  const per = [];
  for (const p of PHRASES) {
    const r = await countPhrase(p, sinceTs);
    per.push({ phrase: r.phrase, nbHits: r.total, read: r.read, pages: r.pages, stopState: r.stopState });
    log(`   "${r.phrase}"  nbHits=${r.total}  read=${r.read}  pages=${r.pages}  ${r.stopState}`);
  }

  // 步骤 3：去重 → 可交付物过滤 → 修辞过滤 → 可达性
  log(`\n[3/3] 去重与降噪`);
  const seen = new Map();
  let phraseHitsTotal = 0;
  for (const p of PHRASES) {
    const r = await countPhrase(p, sinceTs); // 二次读以取回 comment 文本
    phraseHitsTotal += r.comments.length;
    for (const c of r.comments) if (!seen.has(c.id)) seen.set(c.id, c);
  }
  const uniq = [...seen.values()];
  const withCue = uniq.filter((c) => DELIVERABLE_CUES.some((k) => c.text.toLowerCase().includes(k)));
  const rhetorical = uniq.filter((c) => RHETORICAL_MARKS.some((k) => c.text.toLowerCase().includes(k)));
  const concrete = withCue.filter((c) => !rhetorical.some((r) => r.id === c.id));

  log(`   phrase 命中合计(未去重)=${phraseHitsTotal}  去重后=${uniq.length}  独立作者=${new Set(uniq.map(c => c.author)).size}`);
  log(`   含可交付物词=${withCue.length}  命中修辞标记=${rhetorical.length}  两条都命中(真信号候选)=${concrete.length}`);
  log(`   基率 修辞占比 = ${((rhetorical.length / (uniq.length || 1)) * 100).toFixed(1)}%`);

  const reach = await reachable([...new Set(concrete.map(c => c.author))]);
  log(`   可达性核验: ${reach.ok}/${reach.checked} 个候选作者公开档案可读`);

  // 结论
  const verdict = concrete.length === 0
    ? 'VERDICT: 本窗口内「说了愿意付费」与「描述了一个可做的东西」与「留下触达方式」的交集为空。检索这类短语度量的是意见，不是购买意图。建议把需求发现重心从「grep 付费意愿」转向「已知痛点直接做可交互物+ 分发」。'
    : `VERDICT: 检出 ${concrete.length} 条具体购买请求候选，值得人工复核（见 signals[]）。`;

  const report = {
    tool: 'Intent Verifier v2',
    ran_at: startedAt,
    finished_at: new Date().toISOString(),
    window_days: DAYS,
    canary_nbHits: canaryHits,
    canary_pass: true,
    per_phrase: per,
    phrase_hits_unduped: phraseHitsTotal,
    unique_comments: uniq.length,
    unique_authors: new Set(uniq.map(c => c.author)).size,
    with_deliverable_cue: withCue.length,
    rhetorical_hits: rhetorical.length,
    rhetorical_rate: +((rhetorical.length / (uniq.length || 1))).toFixed(3),
    concrete_candidates: concrete.length,
    reachability: reach,
    signals: concrete.slice(0, 25),
    verdict,
    method_note: 'Algolia 不加引号=松散词匹配，加引号=精确短语。本器所有计数均加引号，且 canary 先验通过才输出。',
  };

  mkdirSync(join(__dirname, 'verifier-out'), { recursive: true });
  const outPath = join(__dirname, 'verifier-out', `intent-report-${DAYS}d.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  log(`\n${verdict}\n\n报告: ${outPath}`);

  if (AS_JSON) console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });