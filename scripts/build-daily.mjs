// 生成 AI 日报静态页 + 站点 sitemap，供搜索引擎与 AI 引擎抓取
// 数据源：AI HOT API（与站内日报频道同源）；历史数据缓存在 data/daily/*.json，
// 即使 API 只保留近 10 天，已生成的日报页也会永久存档。

import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';

const SITE = 'https://yehloo-ai.github.io/ai-news-station';
const AIHOT = 'https://aihot.virxact.com/api/public';
const FETCH_DAYS = 10;
const HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
};

// 北京时间日期（UTC+8）
function bjDate(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function fetchDaily(date) {
  const path = date === bjDate(0) ? '/daily' : `/daily/${date}`;
  try {
    const res = await fetch(`${AIHOT}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.sections?.length ? data : null;
  } catch {
    return null;
  }
}

// ── 1. 拉取近 N 天数据，缓存到 data/daily/ ──
mkdirSync('data/daily', { recursive: true });
const today = bjDate(0);
for (let i = 0; i < FETCH_DAYS; i++) {
  const date = bjDate(-i);
  const cachePath = `data/daily/${date}.json`;
  // 历史日期已有缓存就不重拉；今天的每次都刷新（当日内容会增长）
  if (date !== today && existsSync(cachePath)) continue;
  const data = await fetchDaily(date);
  if (data) {
    writeFileSync(cachePath, JSON.stringify(data, null, 2) + '\n');
    console.log(`fetched ${date}: ${data.sections.reduce((n, s) => n + (s.items?.length || 0), 0)} items`);
  } else {
    console.log(`skip ${date}: no data`);
  }
}

// ── 2. 从缓存渲染所有日报页 ──
const dates = readdirSync('data/daily').filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map((f) => f.slice(0, 10)).sort().reverse();

const PAGE_CSS = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif;
    background:#f4f6f8; color:#111827; line-height:1.7; }
  .wrap { max-width:760px; margin:0 auto; padding:28px 18px 60px; }
  .top { font-size:13px; margin-bottom:18px; }
  .top a { color:#6b7280; text-decoration:none; }
  .top a:hover { color:#d92b2b; }
  h1 { font-size:24px; margin-bottom:6px; }
  .sub { font-size:13px; color:#6b7280; margin-bottom:24px; }
  h2 { font-size:16px; margin:28px 0 12px; padding-left:10px; border-left:3px solid #d92b2b; }
  article { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:14px 16px; margin-bottom:10px; }
  article h3 { font-size:15px; margin-bottom:6px; }
  article h3 a { color:#111827; text-decoration:none; }
  article h3 a:hover { color:#d92b2b; }
  article p { font-size:13.5px; color:#4b5563; }
  .src { font-size:12px; color:#9ca3af; margin-top:6px; }
  .nav { display:flex; justify-content:space-between; margin-top:32px; font-size:13px; }
  .nav a { color:#d92b2b; text-decoration:none; }
  ul.archive { list-style:none; }
  ul.archive li { background:#fff; border:1px solid #e5e7eb; border-radius:10px; margin-bottom:8px; }
  ul.archive a { display:block; padding:12px 16px; color:#111827; text-decoration:none; font-size:14px; }
  ul.archive a:hover { color:#d92b2b; }
  ul.archive .count { color:#9ca3af; font-size:12px; margin-left:8px; }
  footer { margin-top:40px; font-size:12px; color:#9ca3af; text-align:center; }
  footer a { color:#6b7280; }
`;

function pageShell({ title, description, canonical, body, jsonLd }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="article">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
<div class="top"><a href="${SITE}/">← 飞翔的AI资讯站</a> · <a href="${SITE}/daily/">日报存档</a></div>
${body}
<footer>由 <a href="${SITE}/">飞翔的AI资讯站</a> 自动生成 · 聚合国内外主流 AI 媒体 · 内容版权归原出处所有</footer>
</div>
</body>
</html>
`;
}

function renderDay(date, data, prev, next) {
  const items = data.sections.flatMap((s) => s.items || []);
  const description = `${date} AI日报（${items.length} 条）：` +
    items.slice(0, 3).map((i) => i.title).join('；').slice(0, 130);

  let body = `<h1>AI 日报速览 · ${date}</h1>
<div class="sub">共 ${items.length} 条 · 覆盖产品发布、行业动态、论文研究等 · 每日自动汇总</div>`;

  if (data.lead) body += `<p style="font-size:14px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:8px;">${esc(data.lead)}</p>`;

  for (const sec of data.sections) {
    if (!sec.items?.length) continue;
    body += `<h2>${esc(sec.label)}</h2>`;
    for (const it of sec.items) {
      body += `<article>
<h3>${it.sourceUrl ? `<a href="${esc(it.sourceUrl)}" rel="noopener" target="_blank">${esc(it.title)}</a>` : esc(it.title)}</h3>
<p>${esc(it.summary)}</p>
<div class="src">来源：${esc(it.sourceName || '未知')}</div>
</article>`;
    }
  }

  for (const fl of data.flashes || []) {
    const t = typeof fl === 'string' ? fl : fl.title || fl.text || '';
    if (t) body += `<article><p>⚡ ${esc(t)}</p></article>`;
  }

  body += `<div class="nav">
<span>${prev ? `<a href="${prev}.html">← ${prev}</a>` : ''}</span>
<span>${next ? `<a href="${next}.html">${next} →</a>` : ''}</span>
</div>`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: `AI 日报 ${date}`,
    datePublished: date,
    inLanguage: 'zh-CN',
    description,
    author: { '@type': 'Organization', name: '飞翔的AI资讯站', url: `${SITE}/` },
    mainEntityOfPage: `${SITE}/daily/${date}.html`,
  };

  return pageShell({
    title: `AI日报 ${date}：今日AI行业大事汇总 | 飞翔的AI资讯站`,
    description,
    canonical: `${SITE}/daily/${date}.html`,
    body,
    jsonLd,
  });
}

mkdirSync('daily', { recursive: true });
dates.forEach((date, i) => {
  const data = JSON.parse(readFileSync(`data/daily/${date}.json`, 'utf8'));
  const prev = dates[i + 1] || null; // 更早一天
  const next = dates[i - 1] || null; // 更晚一天
  writeFileSync(`daily/${date}.html`, renderDay(date, data, prev, next));
});

// ── 3. 存档索引页 ──
const archiveItems = dates.map((date) => {
  const data = JSON.parse(readFileSync(`data/daily/${date}.json`, 'utf8'));
  const n = data.sections.reduce((s, x) => s + (x.items?.length || 0), 0);
  return `<li><a href="${date}.html">AI 日报 · ${date}<span class="count">${n} 条</span></a></li>`;
}).join('\n');

writeFileSync('daily/index.html', pageShell({
  title: 'AI 日报存档 — 每日 AI 行业大事汇总 | 飞翔的AI资讯站',
  description: '飞翔的AI资讯站每日自动汇总 AI 行业重要动态：产品发布、行业新闻、论文研究、技巧观点，按日期存档，可追溯查阅。',
  canonical: `${SITE}/daily/`,
  body: `<h1>AI 日报存档</h1>
<div class="sub">每日自动汇总 AI 行业大事，持续更新 · 共 ${dates.length} 期</div>
<ul class="archive">
${archiveItems}
</ul>`,
  jsonLd: {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'AI 日报存档',
    inLanguage: 'zh-CN',
    url: `${SITE}/daily/`,
  },
}));

// ── 3.5 日期索引：站内日报频道用它发现永久存档 ──
writeFileSync('data/daily-index.json', JSON.stringify(
  dates.map((date) => {
    const data = JSON.parse(readFileSync(`data/daily/${date}.json`, 'utf8'));
    return { date, count: data.sections.reduce((s, x) => s + (x.items?.length || 0), 0) };
  })
) + '\n');

// ── 4. sitemap.xml + robots.txt ──
const urls = [
  { loc: `${SITE}/`, freq: 'hourly', pri: '1.0' },
  { loc: `${SITE}/daily/`, freq: 'daily', pri: '0.9' },
  { loc: `${SITE}/timeline/`, freq: 'weekly', pri: '0.9' },
  { loc: `${SITE}/funding/`, freq: 'weekly', pri: '0.9' },
  { loc: `${SITE}/tools/`, freq: 'weekly', pri: '0.9' },
  ...dates.map((d) => ({ loc: `${SITE}/daily/${d}.html`, freq: d === today ? 'daily' : 'monthly', pri: '0.7', date: d })),
];
writeFileSync('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc}</loc>${u.date ? `<lastmod>${u.date}</lastmod>` : `<lastmod>${today}</lastmod>`}<changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n')}
</urlset>
`);

writeFileSync('robots.txt', `User-agent: *
Allow: /

Sitemap: ${SITE}/sitemap.xml
`);

console.log(`generated: ${dates.length} 日报页 + 存档页 + sitemap（${urls.length} URL）`);
