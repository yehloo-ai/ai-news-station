// 从 data/tools.json 生成「AI 工具库 / AI 工具导航」静态页（SEO / GEO 抓取层）
// 站内「AI 工具库」频道读取同一份 JSON，双端内容一致

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SITE = 'https://yehloo-ai.github.io/ai-news-station';
const SUGGEST = 'https://github.com/yehloo-ai/ai-news-station/issues/new?title=' +
  encodeURIComponent('【工具收录建议】') + '&body=' + encodeURIComponent('工具名称：\n官网链接：\n所属分类：\n一句话简介：');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const AV_COLORS = ['#d01922', '#7c3aed', '#0891b2', '#16a34a', '#ea580c', '#1677ff', '#c026d3', '#0f766e'];
const avColor = (name = '') => AV_COLORS[(name.charCodeAt(0) || 0) % AV_COLORS.length];

const { updatedAt, categories = [] } = JSON.parse(readFileSync('data/tools.json', 'utf8'));
const total = categories.reduce((n, c) => n + (c.tools?.length || 0), 0);

// 本月新增标记（有更早月份工具作基线时才启用）
const curMonth = new Date().toISOString().slice(0, 7);
const months = categories.flatMap((c) => c.tools || []).map((t) => t.added).filter(Boolean);
const NEW_MONTH = months.some((m) => m < curMonth) ? curMonth : null;
const newCount = NEW_MONTH ? months.filter((m) => m === NEW_MONTH).length : 0;

function host(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
const slug = (t) => (t.name || '').toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-|-$/g, '');

function toolCard(t, catId, catName) {
  const h = host(t.url);
  const tags = (t.tags || []).map((x) => `<span class="tag">${esc(x)}</span>`).join('');
  const priceCls = t.pricing === '付费' ? 'paid' : (t.pricing === '免费额度' ? 'trial' : 'free');
  const price = t.pricing ? `<span class="price ${priceCls}">${esc(t.pricing)}</span>` : '';
  const isNew = NEW_MONTH && t.added === NEW_MONTH ? '<span class="new">NEW</span>' : '';
  const meta = [t.platform, t.zh ? '中文' : '', t.region].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('');
  const initial = esc(((t.name || '?').trim()[0] || '?').toUpperCase());
  const logo = `<span class="logo" style="background:${avColor(t.name || '')}"><img src="https://${esc(h)}/favicon.ico" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">${initial}</span>`;
  const free = t.pricing !== '付费';
  const search = esc(`${t.name} ${t.by || ''} ${t.desc || ''} ${(t.tags || []).join(' ')} ${catName || ''}`.toLowerCase());
  return `<article class="tool" id="tool-${esc(slug(t))}" data-cat="${esc(catId)}" data-region="${esc(t.region || '')}" data-free="${free ? 1 : 0}" data-search="${search}">
<div class="thead">${logo}<div class="thead-main"><div class="tname-row"><a class="tname" href="${esc(t.url)}" rel="noopener" target="_blank">${esc(t.name)}</a>${isNew}</div>${t.by ? `<div class="by">${esc(t.by)}</div>` : ''}</div>${price}</div>
<p>${esc(t.desc || '')}</p>
${meta ? `<div class="meta">${meta}</div>` : ''}
<div class="tfoot"><span class="tags">${tags}</span><a class="host" href="${esc(t.url)}" rel="noopener" target="_blank">${esc(h)} →</a></div>
</article>`;
}

const catNav = `<button class="fil on" data-cat="all">全部</button>` +
  categories.map((c) => `<button class="fil" data-cat="${esc(c.id)}">${esc(c.name)}</button>`).join('');
const sections = categories.map((c) => `<section class="cat" id="cat-${esc(c.id)}" data-cat="${esc(c.id)}">
<h2>${c.icon || ''} ${esc(c.name)}<span class="cn">${c.tools?.length || 0}</span></h2>
<div class="grid">${(c.tools || []).map((t) => toolCard(t, c.id, c.name)).join('\n')}</div>
</section>`).join('\n');

const description = `AI 工具库 / AI 工具导航：精选 ${total} 款好用的 AI 工具，覆盖对话大模型、AI 编程、图像/视频/音频生成、AI 搜索、办公与智能体等 ${categories.length} 大场景，含国内外工具、支持端、定价与官网直达，可按分类/地区/免费筛选与搜索，持续更新。`;

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  name: 'AI 工具库',
  description,
  inLanguage: 'zh-CN',
  url: `${SITE}/tools/`,
  numberOfItems: total,
  itemListElement: categories.flatMap((c) => c.tools || []).slice(0, 60).map((t, i) => ({
    '@type': 'ListItem', position: i + 1, url: `${SITE}/tools/#tool-${slug(t)}`,
    item: { '@type': 'SoftwareApplication', name: t.name, applicationCategory: 'AI', description: t.desc, url: t.url },
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
  .sub { font-size:13px; color:#6b7280; margin-bottom:16px; }
  .sub a { color:#d92b2b; text-decoration:none; }
  .search { position:relative; margin-bottom:14px; }
  .search input { width:100%; box-sizing:border-box; padding:9px 14px 9px 34px; font-size:13px; color:#111827; background:#fff; border:1px solid #e5e7eb; border-radius:999px; outline:none; }
  .search input:focus { border-color:rgba(217,43,43,0.35); }
  .search::before { content:'🔍'; position:absolute; left:13px; top:50%; transform:translateY(-50%); font-size:12px; opacity:.55; }
  .catnav { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:10px; }
  .catnav .fil { font-size:12.5px; color:#6b7280; cursor:pointer; padding:5px 14px; border-radius:999px; background:#fff; border:1px solid #e5e7eb; white-space:nowrap; transition:all .15s; }
  .catnav .fil:hover { color:#d92b2b; border-color:rgba(217,43,43,0.35); }
  .catnav .fil.on { background:#d92b2b; border-color:#d92b2b; color:#fff; font-weight:600; }
  .subfilter { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:26px; }
  .sub-label { font-size:11px; color:#6b7280; }
  .chip { font-size:12px; color:#6b7280; cursor:pointer; padding:4px 12px; border-radius:999px; background:#fff; border:1px solid #e5e7eb; white-space:nowrap; transition:all .15s; }
  .chip:hover { color:#d92b2b; border-color:rgba(217,43,43,0.35); }
  .chip.on { background:rgba(208,25,34,0.08); border-color:rgba(217,43,43,0.35); color:#d92b2b; font-weight:600; }
  .sub-sep { width:1px; height:16px; background:#e5e7eb; }
  .cat { margin-bottom:30px; scroll-margin-top:14px; }
  .cat h2 { font-size:18px; margin-bottom:12px; display:flex; align-items:center; gap:8px; }
  .cn { font-size:12px; font-weight:500; color:#6b7280; background:#f4f6f8; border-radius:999px; padding:1px 9px; }
  .grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); }
  .tool { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:14px 16px; display:flex; flex-direction:column; gap:6px; scroll-margin-top:14px; }
  .thead { display:flex; align-items:flex-start; gap:10px; }
  .logo { position:relative; width:34px; height:34px; flex-shrink:0; border-radius:8px; overflow:hidden; display:inline-flex; align-items:center; justify-content:center; color:#fff; font-weight:700; font-size:15px; line-height:1; }
  .logo img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; background:#fff; }
  .thead-main { flex:1; min-width:0; }
  .tname-row { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .tname { font-size:15px; font-weight:700; color:#111827; text-decoration:none; }
  .tname:hover { color:#d92b2b; }
  .new { font-size:9px; font-weight:700; color:#fff; background:#d92b2b; border-radius:4px; padding:1px 5px; letter-spacing:.04em; }
  .price { font-size:10px; font-weight:600; border-radius:999px; padding:1px 8px; flex-shrink:0; white-space:nowrap; }
  .price.free { color:#16a34a; border:1px solid rgba(22,163,74,0.3); background:rgba(22,163,74,0.08); }
  .price.trial { color:#d97706; border:1px solid rgba(217,119,6,0.3); background:rgba(217,119,6,0.08); }
  .price.paid { color:#6b7280; border:1px solid #e5e7eb; }
  .by { font-size:11px; color:#6b7280; margin-top:1px; }
  .tool p { font-size:12.5px; color:#4b5563; line-height:1.55; flex:1; }
  .meta { display:flex; flex-wrap:wrap; gap:6px; margin-top:2px; }
  .meta span { font-size:10px; color:#6b7280; background:#f4f6f8; border:1px solid #e5e7eb; border-radius:4px; padding:1px 7px; }
  .tfoot { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:4px; }
  .tags { display:flex; flex-wrap:wrap; gap:5px; }
  .tag { font-size:10px; color:#6b7280; border:1px solid #e5e7eb; border-radius:999px; padding:1px 8px; }
  .host { font-size:11px; color:#d92b2b; font-weight:600; text-decoration:none; white-space:nowrap; }
  .empty { text-align:center; color:#6b7280; font-size:13px; padding:40px 0; display:none; }
  footer { margin-top:40px; font-size:12px; color:#9ca3af; text-align:center; }
  footer a { color:#6b7280; }
  @media (max-width:768px) {
    .grid { grid-template-columns:1fr; }
    .search input { font-size:16px; } /* 规避 iOS Safari 输入框自动放大 */
  }
</style>
</head>
<body>
<div class="wrap">
<div class="top"><a href="${SITE}/">← 飞翔的AI资讯站</a> · <a href="${SITE}/daily/">日报速览存档</a> · <a href="${SITE}/timeline/">模型发布时间线</a></div>
<h1>AI 工具库 · AI 工具导航</h1>
<div class="sub">精选 ${total} 款好用的 AI 工具，按场景分类，点击直达官网${newCount ? ` · 本月新增 ${newCount}` : ''} · 更新于 ${updatedAt} · <a href="${SUGGEST}" rel="noopener" target="_blank">推荐收录 →</a></div>
<div class="search"><input type="search" id="q" placeholder="搜索工具名称、厂商、用途…"></div>
<nav class="catnav"><span class="sub-label">类型</span>${catNav}</nav>
<div class="subfilter">
<span class="sub-label">地区</span>
<button class="chip on" data-region="all">全部</button>
<button class="chip" data-region="国产">国产</button>
<button class="chip" data-region="海外">海外</button>
<span class="sub-sep"></span>
<button class="chip" id="freeChip">仅看免费</button>
</div>
${sections}
<div class="empty" id="empty">没有匹配的工具，换个关键词或筛选试试。</div>
<footer>由 <a href="${SITE}/">飞翔的AI资讯站</a> 维护 · <a href="${SUGGEST}" rel="noopener" target="_blank">推荐收录</a> · 工具链接归各官方所有</footer>
</div>
<script>
(function(){
  var st = { cat:'all', region:'all', free:false };
  function run(){
    var q = (document.getElementById('q').value || '').trim().toLowerCase();
    var any = false;
    document.querySelectorAll('.cat').forEach(function(sec){
      var shown = 0;
      sec.querySelectorAll('.tool').forEach(function(card){
        var ok = (st.cat==='all' || card.dataset.cat===st.cat)
          && (st.region==='all' || card.dataset.region===st.region)
          && (!st.free || card.dataset.free==='1')
          && (!q || (card.dataset.search||'').indexOf(q) !== -1);
        card.style.display = ok ? '' : 'none';
        if (ok) shown++;
      });
      sec.style.display = shown ? '' : 'none';
      var n = sec.querySelector('.cn'); if (n) n.textContent = shown;
      if (shown) any = true;
    });
    document.getElementById('empty').style.display = any ? 'none' : 'block';
  }
  document.querySelectorAll('.catnav .fil').forEach(function(b){ b.addEventListener('click', function(){ st.cat=b.dataset.cat; document.querySelectorAll('.catnav .fil').forEach(function(x){ x.classList.toggle('on', x===b); }); run(); }); });
  document.querySelectorAll('.chip[data-region]').forEach(function(b){ b.addEventListener('click', function(){ st.region=b.dataset.region; document.querySelectorAll('.chip[data-region]').forEach(function(x){ x.classList.toggle('on', x===b); }); run(); }); });
  document.getElementById('freeChip').addEventListener('click', function(){ st.free=!st.free; this.classList.toggle('on', st.free); run(); });
  document.getElementById('q').addEventListener('input', run);
})();
</script>
</body>
</html>
`);

console.log(`tools/index.html generated: ${total} tools, ${categories.length} categories, new=${newCount}`);
