// 从 data/funding.json 生成「AI 资本动态 / 融资时间线」静态页（GEO 抓取层）
// 站内「大事记 · 资本动态」频道读取同一份 JSON，双端内容一致

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SITE = 'https://yehloo-ai.github.io/ai-news-station';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const { updatedAt, entries } = JSON.parse(readFileSync('data/funding.json', 'utf8'));
const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date));

const slug = (e) => `${e.date}-${String(e.company).toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-|-$/g, '')}`;

// 赛道色映射（分类=彩色胶囊）
const SECTOR = {
  '大模型':       { m: '#185FA5', mb: '#E6F1FB', mbd: '#9FC3EA' },
  '芯片算力':     { m: '#B4610F', mb: '#FAEEDA', mbd: '#EAC07A' },
  '应用':         { m: '#4B41A8', mb: '#EEEDFE', mbd: '#C3BEF0' },
  '具身智能':     { m: '#0F6E56', mb: '#E1F5EE', mbd: '#8ED9BF' },
  '数据基础设施': { m: '#993556', mb: '#FBEAF0', mbd: '#EBAEC5' },
  '其他':         { m: '#5F5E5A', mb: '#F1EFE8', mbd: '#CFCCC0' },
};

function amountHtml(e) {
  return `<span class="amt">${esc(e.amount || '')}</span>${e.valuation ? `<span class="val"> · ${esc(e.valuation)}</span>` : ''}`;
}
function renderArticle(e) {
  const c = SECTOR[e.sector] || SECTOR['其他'];
  const catPill = e.sector ? `<span class="cat" style="color:${c.m};background:${c.mb};border:1px solid ${c.mbd}">${esc(e.sector)}</span>` : '';
  const roundPill = e.round ? `<span class="attr">${esc(e.round)}</span>` : '';
  const src = e.sourceName ? `<div class="src">信源：${e.sourceUrl ? `<a href="${esc(e.sourceUrl)}" rel="noopener" target="_blank">${esc(e.sourceName)}</a>` : esc(e.sourceName)} · ${e.date}</div>` : '';
  if (e.tier === 'minor') {
    return `<article class="minor" id="${esc(slug(e))}">
<div class="minor-row"><span class="company">${esc(e.company)}</span>${catPill}<span class="mtitle">${amountHtml(e)}</span><span class="minor-desc">${esc(e.highlight || '')}</span></div>
</article>`;
  }
  const isMile = e.tier === 'milestone';
  const mileTag = isMile ? `<span class="mile-tag" style="color:${c.m};background:${c.mb}">★ 里程碑</span>` : '';
  const impact = (isMile && e.impact) ? `<div class="impact" style="color:${c.m};border-color:${c.mbd}"><b>意味着 </b>${esc(e.impact)}</div>` : '';
  return `<article${isMile ? ` class="milestone" style="box-shadow:inset 3px 0 0 ${c.m}"` : ''} id="${esc(slug(e))}">
<div class="meta"><span class="company">${esc(e.company)}</span>${catPill}${roundPill}${mileTag}</div>
<h3>${amountHtml(e)}</h3>
<p>${esc(e.highlight || '')}</p>
${e.specs?.length ? `<ul class="specs">${e.specs.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
${impact}
${src}
</article>`;
}

// 按年分组
const byYear = {};
sorted.forEach((e) => { const y = e.date.slice(0, 4); (byYear[y] = byYear[y] || []).push(e); });

const body = `<h1>AI 资本动态 · 融资时间线</h1>
<div class="sub">谁 · 什么轮次 · 多少钱 · 什么估值 —— 持续维护的结构化档案，共 ${sorted.length} 条 · 更新于 ${updatedAt}</div>
${Object.entries(byYear).sort((a, b) => b[0].localeCompare(a[0])).map(([year, list]) => {
  const byDate = {};
  list.forEach((e) => { (byDate[e.date] = byDate[e.date] || []).push(e); });
  const rows = Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0])).map(([date, items]) => `<div class="tl-row">
<div class="tl-time" title="${date}"><span class="tl-time-label">${date.slice(5)}</span><span class="tl-time-dot"></span>${items.length > 1 ? `<span class="tl-time-n">${items.length} 条</span>` : ''}</div>
<div class="daycards">${items.map(renderArticle).join('\n')}</div>
</div>`).join('\n');
  return `<div class="year-node" id="y${year}"><span class="year-dot"></span><h2>${year} 年<span class="year-count">${list.length} 条</span></h2></div>
<div class="tl-list">
${rows}
</div>`;
}).join('\n')}`;

const description = `AI 资本动态 / 融资时间线：${sorted.length} 条主流 AI 融资档案（${sorted[sorted.length - 1].date.slice(0, 7)} 至 ${sorted[0].date.slice(0, 7)}），含公司、轮次、金额、估值与信源，持续更新。`;

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  name: 'AI 资本动态 / 融资时间线',
  description,
  inLanguage: 'zh-CN',
  url: `${SITE}/funding/`,
  numberOfItems: sorted.length,
  itemListElement: sorted.slice(0, 30).map((e, i) => ({
    '@type': 'ListItem', position: i + 1,
    name: `${e.company} ${e.amount}${e.round ? ' ' + e.round : ''}（${e.date}）`,
    url: `${SITE}/funding/#${slug(e)}`,
  })),
};

mkdirSync('funding', { recursive: true });
writeFileSync('funding/index.html', `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI 资本动态 / 融资时间线 — 谁、什么轮次、多少钱、什么估值 | 飞翔的AI资讯站</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}/funding/">
<meta property="og:title" content="AI 资本动态 / 融资时间线 | 飞翔的AI资讯站">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="article">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif;
    background:#f4f6f8; color:#111827; line-height:1.7; }
  .wrap { max-width:760px; margin:0 auto; padding:28px 18px 60px; }
  .top { font-size:13px; margin-bottom:18px; }
  .top a { color:#6b7280; text-decoration:none; }
  .top a:hover { color:#d92b2b; }
  h1 { font-size:24px; margin-bottom:6px; }
  .sub { font-size:13px; color:#6b7280; margin-bottom:24px; }
  .year-node { display:grid; grid-template-columns:64px 1fr; align-items:center; margin:28px 0 10px; }
  .year-dot { justify-self:center; width:13px; height:13px; border-radius:50%; background:#16a34a; box-shadow:0 0 0 4px rgba(63,185,80,0.2); }
  .year-node h2 { font-size:19px; display:flex; align-items:baseline; gap:10px; }
  .year-count { font-size:12px; font-weight:500; color:#6b7280; }
  .tl-list { display:flex; flex-direction:column; gap:10px; position:relative; }
  .tl-list::after { content:''; position:absolute; left:32px; top:0; bottom:0; width:1px; background:#e5e7eb; pointer-events:none; }
  .tl-row { display:grid; grid-template-columns:64px 1fr; align-items:start; position:relative; z-index:1; }
  .tl-time { display:flex; flex-direction:column; align-items:center; justify-content:flex-start; gap:5px; padding-top:14px; }
  .tl-time-label { font-size:12px; font-weight:600; font-variant-numeric:tabular-nums; white-space:nowrap; line-height:1; }
  .tl-time-dot { width:9px; height:9px; border-radius:50%; background:#16a34a; box-shadow:0 0 0 3px rgba(63,185,80,0.2); }
  .tl-time-n { font-size:10px; color:#9ca3af; margin-top:2px; white-space:nowrap; }
  .daycards { display:flex; flex-direction:column; gap:10px; }
  article { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:14px 16px; }
  .meta { display:flex; gap:8px; align-items:center; font-size:12px; margin-bottom:6px; flex-wrap:wrap; }
  .company { color:#111827; font-weight:600; }
  .cat { padding:1px 9px; border-radius:999px; font-weight:600; }
  .attr { color:#6b7280; background:transparent; border:1px solid #e5e7eb; padding:1px 9px; border-radius:999px; }
  article h3 { font-size:17px; margin-bottom:4px; color:#d92b2b; }
  article h3 .val { color:#6b7280; font-size:13px; font-weight:400; }
  article p { font-size:13.5px; color:#4b5563; }
  .specs { list-style:none; display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
  .specs li { font-size:12px; color:#4b5563; background:#f4f6f8; border:1px solid #e5e7eb; padding:2px 8px; border-radius:6px; }
  .impact { font-size:13px; line-height:1.55; margin-top:9px; padding-left:10px; border-left:2px solid; }
  .impact b { font-weight:600; color:#6b7280; }
  .mile-tag { font-size:11px; font-weight:700; padding:1px 8px; border-radius:999px; }
  .src { font-size:12px; color:#9ca3af; margin-top:8px; }
  .src a { color:#6b7280; }
  article.minor { padding:10px 16px; }
  .minor-row { display:flex; align-items:center; gap:8px; font-size:13px; flex-wrap:wrap; }
  .minor-row .mtitle { font-weight:700; color:#d92b2b; }
  .minor-desc { color:#6b7280; }
  footer { margin-top:40px; font-size:12px; color:#9ca3af; text-align:center; }
  footer a { color:#6b7280; }
</style>
</head>
<body>
<div class="wrap">
<div class="top"><a href="${SITE}/">← 飞翔的AI资讯站</a> · <a href="${SITE}/timeline/">模型发布时间线</a> · <a href="${SITE}/daily/">日报存档</a></div>
${body}
<footer>由 <a href="${SITE}/">飞翔的AI资讯站</a> 维护 · 金额/估值为公开报道口径，条目附信源 · 发现错漏欢迎指正</footer>
</div>
</body>
</html>
`);

console.log(`funding/index.html generated: ${sorted.length} entries, ${Object.keys(byYear).length} years`);
