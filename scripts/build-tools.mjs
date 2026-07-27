// 从 data/tools.json 生成「AI 工具库 / AI 工具导航」静态页（SEO / GEO 抓取层）
// 站内「AI 工具库」频道读取同一份 JSON，双端内容一致

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SITE = 'https://yehloolau-afk.github.io/ai-news-station';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const { updatedAt, categories = [] } = JSON.parse(readFileSync('data/tools.json', 'utf8'));
const total = categories.reduce((n, c) => n + (c.tools?.length || 0), 0);

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function toolCard(t) {
  const tags = (t.tags || []).map((x) => `<span class="tag">${esc(x)}</span>`).join('');
  const free = t.free ? '<span class="free">免费</span>' : '';
  return `<article class="tool">
<div class="thead"><a class="tname" href="${esc(t.url)}" rel="noopener" target="_blank">${esc(t.name)}</a>${free}</div>
${t.by ? `<div class="by">${esc(t.by)}</div>` : ''}
<p>${esc(t.desc || '')}</p>
<div class="tfoot"><span class="tags">${tags}</span><a class="host" href="${esc(t.url)}" rel="noopener" target="_blank">${esc(host(t.url))} →</a></div>
</article>`;
}

const catNav = categories.map((c) => `<a href="#cat-${esc(c.id)}">${c.icon || ''} ${esc(c.name)}</a>`).join('');
const sections = categories.map((c) => `<section class="cat" id="cat-${esc(c.id)}">
<h2>${c.icon || ''} ${esc(c.name)}<span class="cn">${c.tools?.length || 0}</span></h2>
<div class="grid">${(c.tools || []).map(toolCard).join('\n')}</div>
</section>`).join('\n');

const description = `AI 工具库 / AI 工具导航：精选 ${total} 款好用的 AI 工具，覆盖对话大模型、AI 编程、图像/视频/音频生成、AI 搜索、办公与智能体等 ${categories.length} 大场景，含国内外工具与官网直达，持续更新。`;

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  name: 'AI 工具库',
  description,
  inLanguage: 'zh-CN',
  url: `${SITE}/tools/`,
  numberOfItems: total,
  itemListElement: categories.flatMap((c) => c.tools || []).slice(0, 60).map((t, i) => ({
    '@type': 'ListItem', position: i + 1, name: t.name, url: t.url,
  })),
};

mkdirSync('tools', { recursive: true });
writeFileSync('tools/index.html', `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI 工具库 — AI 工具导航大全，${total}+ 款精选 AI 工具 | 飞翔的AI资讯站</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}/tools/">
<meta property="og:title" content="AI 工具库 · AI 工具导航 | 飞翔的AI资讯站">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif;
    background:#f4f6f8; color:#111827; line-height:1.7; }
  .wrap { max-width:920px; margin:0 auto; padding:28px 18px 60px; }
  .top { font-size:13px; margin-bottom:18px; }
  .top a { color:#6b7280; text-decoration:none; }
  .top a:hover { color:#d92b2b; }
  h1 { font-size:24px; margin-bottom:6px; }
  .sub { font-size:13px; color:#6b7280; margin-bottom:20px; }
  .catnav { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:26px; }
  .catnav a { font-size:12px; color:#6b7280; text-decoration:none; padding:4px 12px; border-radius:999px; background:#fff; border:1px solid #e5e7eb; }
  .catnav a:hover { color:#d92b2b; border-color:rgba(217,43,43,0.35); }
  .cat { margin-bottom:30px; scroll-margin-top:14px; }
  .cat h2 { font-size:18px; margin-bottom:12px; display:flex; align-items:center; gap:8px; }
  .cn { font-size:12px; font-weight:500; color:#6b7280; background:#f4f6f8; border-radius:999px; padding:1px 9px; }
  .grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); }
  .tool { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:14px 16px; display:flex; flex-direction:column; gap:6px; }
  .thead { display:flex; align-items:center; gap:8px; }
  .tname { font-size:15px; font-weight:700; color:#111827; text-decoration:none; }
  .tname:hover { color:#d92b2b; }
  .free { font-size:10px; font-weight:600; color:#16a34a; border:1px solid rgba(22,163,74,0.3); background:rgba(22,163,74,0.08); border-radius:999px; padding:1px 7px; }
  .by { font-size:11px; color:#6b7280; margin-top:-2px; }
  .tool p { font-size:12.5px; color:#4b5563; line-height:1.55; flex:1; }
  .tfoot { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:4px; }
  .tags { display:flex; flex-wrap:wrap; gap:5px; }
  .tag { font-size:10px; color:#6b7280; border:1px solid #e5e7eb; border-radius:999px; padding:1px 8px; }
  .host { font-size:11px; color:#d92b2b; font-weight:600; text-decoration:none; white-space:nowrap; }
  footer { margin-top:40px; font-size:12px; color:#9ca3af; text-align:center; }
  footer a { color:#6b7280; }
</style>
</head>
<body>
<div class="wrap">
<div class="top"><a href="${SITE}/">← 飞翔的AI资讯站</a> · <a href="${SITE}/daily/">日报速览存档</a> · <a href="${SITE}/timeline/">模型发布时间线</a></div>
<h1>AI 工具库 · AI 工具导航</h1>
<div class="sub">精选 ${total} 款好用的 AI 工具，按场景分类，点击直达官网 · 更新于 ${updatedAt}</div>
<nav class="catnav">${catNav}</nav>
${sections}
<footer>由 <a href="${SITE}/">飞翔的AI资讯站</a> 维护 · 收录建议欢迎反馈 · 工具链接归各官方所有</footer>
</div>
</body>
</html>
`);

console.log(`tools/index.html generated: ${total} tools, ${categories.length} categories`);
