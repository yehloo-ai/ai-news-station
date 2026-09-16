const API = 'https://api.rss2json.com/v1/api.json';
const AIHOT = 'https://aihot.virxact.com/api/public';

// 静态数据层：资讯频道只读取 GitHub Actions 预生成的同源 JSON。
// 公共 CORS 代理经常限流或失效，不再作为浏览器端数据链路。
const STATIC_BASE = 'data';
const STATIC_TABS = new Set(['daily', 'featured', 'all']);
const stationData = Station.createDataClient();
let dailyRequest = 0;
let viewRequest = 0;
const tabScroll = {};
function showDataStatus(message = '') {
  const el = document.getElementById('dataStatus');
  el.textContent = message;
  el.hidden = !message;
}
function updateRoute(values, replace = false) {
  const url = new URL(location.href);
  Object.entries(values).forEach(([key, value]) => value ? url.searchParams.set(key, value) : url.searchParams.delete(key));
  if (url.href !== location.href) history[replace ? 'replaceState' : 'pushState']({}, '', url);
}

async function fetchStaticData(tabId, force = false) {
  if (!STATIC_TABS.has(tabId)) return null;
  try {
    const result = await stationData.get(`${STATIC_BASE}/${tabId}.json`, {force,
      validate: data => !!data?.updated && Array.isArray(data.items) && data.items.length > 0});
    const data = result.data;
    const items = data.items.map(Station.normalizeItem).filter(Boolean).sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0));
    if (!items.length) return null;
    return {...data, items, stale: result.stale};
  } catch { return null; }
}

// 代理记忆：记住每个 feed 上次成功的代理，下次直接命中，跳过无效路径
const PROXY_MEM = (() => { try { return JSON.parse(localStorage.getItem('ai_proxy_mem') || '{}'); } catch { return {}; } })();
function saveProxyHit(url, proxy) {
  if (PROXY_MEM[url] === proxy) return;
  PROXY_MEM[url] = proxy;
  try { localStorage.setItem('ai_proxy_mem', JSON.stringify(PROXY_MEM)); } catch {}
}

// Feed 持久缓存：把拉取结果存入 localStorage，刷新页面后可秒显示
const LS_FEED_KEY = 'ai_station_feeds_v2';
function saveFeedCache(key, data) {
  try {
    const store = JSON.parse(localStorage.getItem(LS_FEED_KEY) || '{}');
    store[key] = { items: data.items, feedErrors: data.feedErrors, ts: data.ts, updated: data.updated };
    localStorage.setItem(LS_FEED_KEY, JSON.stringify(store));
  } catch {}
}
function loadFeedStore() {
  try { return JSON.parse(localStorage.getItem(LS_FEED_KEY) || '{}'); } catch { return {}; }
}

function timeoutSignal(ms) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

// ── 自动翻译（Google Translate 免费接口，英文标题→中文）──────
function isEnglish(text) {
  if (!text || text.length < 8) return false;
  return (text.match(/[a-zA-Z]/g) || []).length / text.length > 0.5;
}

async function fetchJsonSafe(url) {
  try {
    const r = await fetch(url, { signal: timeoutSignal(6000) });
    if (r.ok) return await r.json();
  } catch {}
  return null;
}

async function xlatText(text) {
  try {
    const r = await fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`,
      { signal: timeoutSignal(5000) }
    );
    if (r.ok) {
      const d = await r.json();
      return d?.[0]?.map(p => p?.[0]).filter(Boolean).join('') || '';
    }
  } catch {}
  return '';
}

async function translateBuilderTweets(builders) {
  const CHUNK = 4;

  // 翻译最热推文
  const tweetTargets = builders.map(b => {
    const top = [...(b.tweets||[])].sort((a,z) => (z.likes||0)-(a.likes||0))[0];
    return top && isEnglish(top.text) && !top._translated ? top : null;
  }).filter(Boolean);
  for (let i = 0; i < tweetTargets.length; i += CHUNK) {
    await Promise.all(tweetTargets.slice(i, i + CHUNK).map(async t => {
      const zh = await xlatText(t.text);
      if (zh) t._translated = zh;
    }));
    if (i + CHUNK < tweetTargets.length) await new Promise(r => setTimeout(r, 200));
  }

  // 翻译个人简介（≤20汉字）
  const bioTargets = builders.filter(b => !b._bioZh && b.bio);
  for (let i = 0; i < bioTargets.length; i += CHUNK) {
    await Promise.all(bioTargets.slice(i, i + CHUNK).map(async b => {
      const rawBio = (b.bio || '').split('\n')[0].trim().substring(0, 120);
      const zh = await xlatText(rawBio);
      if (zh) b._bioZh = zh.substring(0, 50);
    }));
    if (i + CHUNK < bioTargets.length) await new Promise(r => setTimeout(r, 200));
  }
}

async function translateItems(items) {
  const CHUNK = 3;       // 每批3条，减少并发压力
  const CHUNK_DELAY = 250; // 批次间间隔250ms，避免触发频率限制

  async function xlat(text) {
    // 主：Google Translate（2次重试）
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(
          `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`,
          { signal: timeoutSignal(5000) }
        );
        if (!r.ok) throw new Error('http ' + r.status);
        const d = await r.json();
        const result = d?.[0]?.map(p => p?.[0]).filter(Boolean).join('') || '';
        if (result && result !== text) return result;
      } catch {}
      if (attempt === 0) await new Promise(r => setTimeout(r, 500));
    }
    // 备：MyMemory（Google 失败时兜底）
    try {
      const r = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|zh-CN`,
        { signal: timeoutSignal(8000) }
      );
      if (r.ok) {
        const d = await r.json();
        const result = d?.responseData?.translatedText || '';
        if (result && result !== text && !result.includes('MYMEMORY WARNING')) return result;
      }
    } catch {}
    return '';
  }

  // 翻译标题
  const titleTargets = items.filter(i => isEnglish(i.title) && !i._translated);
  for (let i = 0; i < titleTargets.length; i += CHUNK) {
    await Promise.all(
      titleTargets.slice(i, i + CHUNK).map(async item => {
        try {
          const zh = await xlat(item.title);
          if (zh) { item.titleOriginal = item.title; item.title = zh; item._translated = true; }
        } catch {}
      })
    );
    if (i + CHUNK < titleTargets.length) await new Promise(r => setTimeout(r, CHUNK_DELAY));
  }

  // 翻译摘要（英文 description 取前150字）
  const descTargets = items.filter(i => {
    const d = String(i.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
    return d.length > 20 && isEnglish(d) && !i._descTranslated;
  });
  for (let i = 0; i < descTargets.length; i += CHUNK) {
    await Promise.all(
      descTargets.slice(i, i + CHUNK).map(async item => {
        try {
          const raw = String(item.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
          const zh = await xlat(raw);
          if (zh) { item.description = zh; item._descTranslated = true; }
        } catch {}
      })
    );
    if (i + CHUNK < descTargets.length) await new Promise(r => setTimeout(r, CHUNK_DELAY));
  }
  return items;
}

// ── AI HOT API ────────────────────────────────────────
async function fetchAiHot(path) {
  const url = `${AIHOT}${path}`;
  // 直连（AI HOT 支持 CORS）
  try {
    const res = await fetch(url, { signal: timeoutSignal(6000), headers: { 'Accept': 'application/json' } });
    if (res.ok) return await res.json();
  } catch (_) {}
  // Fallback: allorigins raw 代理（直接返回原始 JSON，/get 模式有 500 问题）
  try {
    const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, { signal: timeoutSignal(8000) });
    if (res.ok) return await res.json();
  } catch (_) {}
  return null;
}

function aiHotToCard(item) {
  const CAT_COLOR = { 'ai-models':'#bc8cff','ai-products':'#3fb950','industry':'#ffa657','paper':'#58a6ff','tip':'#d29922','opensource':'#3fb9b9' };
  return {
    title:       item.title || '',
    link:        item.url || '',
    description: item.summary || '',
    pubDate:     item.publishedAt || '',
    thumbnail:   '',
    enclosure:   null,
    _aiCat:      item.category || '',
    _feed: { name: item.source || 'AI HOT', color: CAT_COLOR[item.category] || '#8b949e' }
  };
}

function genRecReason(item) {
  const raw = item.titleOriginal || item.title || '';
  const desc = String(item.description || '').replace(/<[^>]*>/g, ' ').slice(0, 200);
  const full = raw + ' ' + desc;

  const modelRe = /\b(GPT-[\w.]+|o\d[\w.-]*|Claude[\s\w.-]{0,12}|Gemini[\s\w.-]{0,8}|Llama[\s\w.-]{0,8}|Mistral[\w.-]+|Sora|DALL-E[\s\d]*|Stable Diffusion|Midjourney|Runway|Kling|Veo[\s\d]*|Grok[\s\d]*)\b/i;
  const model = (raw.match(modelRe) || [])[0]?.trim();
  const numRe = /\$[\d,.]+\s*[BMK]?(?:\s*(?:billion|million))?|\b\d+(?:\.\d+)?[xX]|\b\d+(?:\.\d+)?%|\b\d+[BMK]\s*(?:tokens?|params?)/i;
  const num = (raw.match(numRe) || [])[0]?.trim();
  const is = re => re.test(full);
  const isTitle = re => re.test(raw);
  const candidates = [];
  function add(re, w, gen) {
    if (is(re)) candidates.push({ w: isTitle(re) ? w + 2 : w, gen });
  }

  add(/\bfund|invest|融资|raise|valuat|估值/i, 10, () => {
    const who = model || (raw.match(/\b(OpenAI|Anthropic|DeepMind|Meta|Google|Microsoft|Baidu|ByteDance|Mistral|xAI)\b/i) || [])[0] || '该公司';
    return num
      ? `${who} 完成 ${num} 融资，资本持续押注 AI 赛道的核心信号。`
      : `${who} 最新融资动态，折射当前 AI 赛道的资本走向与竞争格局。`;
  });
  add(/\bacquir|merger|收购|并购/i, 9, () => model
    ? `涉及 ${model} 的并购整合，AI 产业链重组的重要节点。`
    : '重大并购动态，AI 行业格局调整的关键信号。');
  add(/\bregulat|policy|法规|监管|compliance|ban|禁止/i, 8, () =>
    '监管政策收紧，对 AI 产品合规路径与出海策略有直接影响。');
  add(/\bopen.?source|开源|open.?weight/i, 7, () => {
    const who = model || 'AI 开源项目';
    return `${who} 开源发布，降低使用门槛，值得关注其生态影响力。`;
  });
  add(/\bbenchmark|leaderboard|MMLU|HumanEval|评测|排行/i, 7, () => model
    ? `${model} 评测结果出炉，能力边界与竞品差距值得深入对比。`
    : '最新能力评测出炉，横向对比各模型真实表现的重要参考。');
  add(/\breasoning|chain.of.thought|思维链|思考模式/i, 6, () => model
    ? `${model} 推理能力升级，复杂问题求解与逻辑链路有显著提升。`
    : '推理能力突破，AI 处理复杂任务的关键技术进展。');
  add(/\bmultimodal|多模态|vision|视觉理解/i, 6, () => model
    ? `${model} 多模态能力更新，图文理解与跨模态交互的重要进展。`
    : '多模态技术进展，视觉与语言融合应用的新可能。');
  add(/\bagent|agentic|autonomous|自主|工作流/i, 6, () => model
    ? `${model} Agent 能力强化，自动化工作流落地又近一步。`
    : 'AI Agent 最新进展，自主任务执行能力的重要演进节点。');
  add(/\bvideo.?gen|视频生成|text.to.video/i, 5, () => model
    ? `${model} 视频生成能力发布，创作工具链的重要补充。`
    : '视频生成新突破，AI 创作工具链的能力边界再次扩展。');
  add(/\bimage.gen|生图|text.to.image|文生图/i, 5, () => model
    ? `${model} 生图效果更新，设计师与创作者值得上手体验。`
    : 'AI 生图新进展，视觉创作工具的能力与易用性持续提升。');
  add(/\bcode|coding|编程|develope|developer/i, 4, () => model
    ? `${model} 代码生成能力提升，开发效率与辅助编程场景的重要参考。`
    : 'AI 编程能力新进展，开发者工具链的重要动态。');
  add(/\bpricing|price|cost|定价|收费|付费/i, 5, () => model
    ? `${model} 定价策略调整，直接影响开发者成本与产品商业化节奏。`
    : '定价策略变动，对 AI 产品的商业模式与用户选择有直接影响。');
  add(/\bsafety|alignment|对齐|安全|risk|风险/i, 5, () => model
    ? `${model} 安全对齐进展，AI 可信度与部署边界的关键参考。`
    : 'AI 安全对齐动态，影响模型部署策略与行业信任基础。');

  if (candidates.length) {
    candidates.sort((a, b) => b.w - a.w);
    return candidates[0].gen();
  }

  if (model) {
    const cat = item._aiCat || '';
    if (cat === 'paper' || is(/\bresearch|论文|study|experiment/i))
      return `${model} 最新研究成果，技术演进方向的前沿信号。`;
    return `${model} 重要动态，关注其能力进展与行业影响。`;
  }

  const cat = item._aiCat || '';
  if (cat === 'ai-models') return '大模型能力演进的关键节点，值得持续跟踪。';
  if (cat === 'ai-products') return 'AI 产品落地新进展，设计与工程实践的参考样本。';
  if (cat === 'paper')      return '前沿学术成果，把握 AI 技术走向的重要一手信号。';
  if (cat === 'industry')   return '行业资本与战略动向，AI 商业化进程的观察窗口。';
  if (cat === 'design')     return 'AI 与设计的交叉前沿，创作者与设计师值得关注。';
  return '精选内容，覆盖 AI 行业核心进展，值得深度阅读。';
}

// 日报 / 精选 共享同一份数据源（并集）；顶部「来源」展示因此一致
const SHARED_FEEDS = [
  { url: 'https://export.arxiv.org/rss/cs.AI',     name: 'ArXiv AI',  color: '#e67e22' },
  { url: 'https://export.arxiv.org/rss/cs.LG',     name: 'ArXiv ML',  color: '#e74c3c' },
  { url: 'https://export.arxiv.org/rss/cs.CL',     name: 'ArXiv NLP', color: '#1abc9c' },
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCXZCJLdBC09xxGZ6gcdrc6A', name: 'OpenAI YT',    color: '#10a37f' },
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCP7jMXSY2xbc3KCAE0MHQ-A', name: 'DeepMind YT',  color: '#4285f4' },
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCrDwWp7EBBv4NwvScIpBDOA', name: 'Anthropic YT', color: '#c75b39' },
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCbfYPyITQ-7l4upoX8nvctg', name: 'Two Minute Papers', color: '#ef4444' },
  { url: 'https://www.theverge.com/ai-artificial-intelligence/rss', name: 'The Verge AI', color: '#e40045' },
  { url: 'https://www.qbitai.com/feed',            name: '量子位',    color: '#bc8cff' },
  { url: 'https://www.ifanr.com/feed',             name: '爱范儿',    color: '#3fb950' },
  { url: 'https://www.jiqizhixin.com/rss',         name: '机器之心',  color: '#58a6ff' },
  { url: 'https://www.geekpark.net/rss',           name: '极客公园',  color: '#ffa657' },
  { url: 'https://sspai.com/feed',                 name: '少数派',    color: '#8b949e' },
  { url: 'https://36kr.com/feed',                  name: '36Kr',     color: '#1677ff' },
  { url: 'https://www.huxiu.com/rss/0.xml',        name: '虎嗅',     color: '#e67e22' },
  { url: 'https://xinzhiyuan.com/feed',             name: '新智元',   color: '#8b5cf6' },
];

// 官方厂商博客（「全部动态」里的「官方动态」筛选用；带 official 标记）
const OFFICIAL_FEEDS = [
  { url: 'https://openai.com/blog/rss.xml',        name: 'OpenAI',      color: '#10a37f', official: true },
  { url: 'https://www.anthropic.com/rss',          name: 'Anthropic',   color: '#d97706', official: true },
  { url: 'https://deepmind.google/blog/rss/',      name: 'DeepMind',    color: '#4285f4', official: true },
  { url: 'https://huggingface.co/blog/feed.xml',   name: 'HuggingFace', color: '#ff9d00', official: true },
  { url: 'https://ai.meta.com/blog/rss/',          name: 'Meta AI',     color: '#1877f2', official: true },
  { url: 'https://blogs.microsoft.com/ai/feed/',   name: 'Microsoft AI',color: '#00a1f1', official: true },
  { url: 'https://blog.google/technology/ai/rss/', name: 'Google AI',   color: '#ea4335', official: true },
];
// 全部动态 = 共享源 + 官方博客（产品/设计走 _aiCat 分类，视频靠 YouTube URL 识别）
const ALL_FEEDS = [...SHARED_FEEDS, ...OFFICIAL_FEEDS];

const TABS = [
  {
    id: 'featured',
    name: '精选',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
    layout: 'featured',
    desc: '按来源与相关性自动汇总',
    translate: true,
    aiHotPath: '/items?mode=selected&take=30',
    feeds: SHARED_FEEDS
  },
  {
    id: 'all',
    name: '全部动态',
    mob: '动态',
    translate: true,
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    layout: 'list',
    desc: '全网全量 · 可按来源与分类筛选',
    aiHotPath: '/items?mode=all&take=80',
    feeds: ALL_FEEDS
  },
  {
    id: 'daily',
    name: '日报速览',
    mob: '日报',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="12" y2="15"/></svg>',
    layout: 'daily',
    desc: '每日 AI 资讯速览',
    aiHotPath: '/daily',
    feeds: SHARED_FEEDS
  },
  {
    id: 'timeline',
    name: '模型发布',
    mob: '大事记',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    layout: 'timeline',
    desc: 'AI 模型发布时间线：哪家、什么模型、哪天发布、关键规格',
    aiHotPath: null,
    feeds: []
  },
  {
    id: 'funding',
    name: '资本动态',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    layout: 'funding',
    desc: 'AI 融资时间线：谁、什么轮次、多少钱、什么估值',
    aiHotPath: null,
    feeds: []
  },
  {
    id: 'tools',
    name: 'AI 工具库',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    layout: 'tools',
    desc: '精选好用的 AI 工具，按场景分类，收藏即用',
    aiHotPath: null,
    feeds: []
  },
];

// 移动端产品组：这三个 tab 在移动端合并为第5个 tab
const MOB_GROUP_IDS = ['tools']; // 移动端「更多」浮层收纳：AI 工具库
// 移动端固定5个 tab 的顺序（日报 | 大事记 | 精选 | 全部 | 更多）
const MOB_NAV_ORDER = ['daily', 'featured', 'all', 'timeline']; // 日报 | 精选 | 动态 | 模型发布 | 更多
// PC 侧边栏分组（数组顺序 = 展示顺序；后续大事记子栏目加到 '大事记' 组的 ids 里）
const NAV_GROUPS = [
  { label: '每日速览', ids: ['daily', 'featured', 'all'] },
  { label: '大事记',   ids: ['timeline', 'funding'] },
  { label: '工具库',   ids: ['tools'] },
];
const DEFAULT_TAB = 'daily'; // 默认落地页 = 日报（回访锚点）

// State
let activeTab = DEFAULT_TAB;
let mobGroupActiveId = null; // 「更多」组当前选中的 sub-tab
let jobsRegion = 'global';   // 'global' | 'domestic'
let allCatFilter = 'all';    // 右排（类）：'all' | 'ai-products' | 'design' | 'video'
let allSrcFilter = 'all';    // 左排（源）：'all' | 'official'
const cache = {};          // { tabId: { items, feedErrors, ts } }
const counts = {};         // { tabId: count }
let refreshTimer = null;
let countdownTimer = null;
let nextRefreshAt = 0;
const REFRESH_INTERVAL = 30 * 60 * 1000; // 30 min
const IS_MOBILE = window.innerWidth <= 768;

// ── Archive panel ─────────────────────────────────────
let archiveList = null;      // array of { date, headline }
let archiveLoading = false;  // 防止并发重复触发
let archiveActiveDate = null;
const dailyCache = {};       // { 'YYYY-MM-DD': aiHotData }
const STATIC_DAILY_DATES = new Set(); // 已生成永久静态存档的日期（data/daily-index.json）

function initArchive(force = false) {
  if (archiveList && !force) return;
  archiveList ||= [];
  stationData.get('data/daily-index.json', {force, validate: data => Array.isArray(data) && data.length > 0 && data.every(d => d && Station.validDate(d.date))}).then(({data}) => {
    archiveList = data.slice().sort((a, b) => b.date.localeCompare(a.date));
    data.forEach(e => STATIC_DAILY_DATES.add(e.date));
    renderArchivePanel();
  }).catch(() => { archiveList = null; });
}

function renderArchiveInCol() {
  const col = document.getElementById('archiveCol');
  if (!col) return;
  initArchive();
  renderArchivePanel();
}

function renderArchivePanel() {
  const panel = document.getElementById('archiveCol') || document.getElementById('archivePanel');
  if (!archiveList?.length || !panel) return;

  const activeDate = archiveActiveDate || archiveList[0]?.date;
  const thisYear = String(new Date().getFullYear());

  // 扁平单行结构：月份小徽标 + 日期块，全部日期在一条横向滚动条里，PC/移动统一
  const byMonth = {};
  archiveList.forEach(d => { const k = d.date.slice(0, 7); (byMonth[k] = byMonth[k] || []).push(d); });

  panel.innerHTML = Object.entries(byMonth).map(([ym, days]) => {
    const [y, m] = ym.split('-');
    const label = `${y === thisYear ? '' : y + '年'}${parseInt(m)}月`;
    return `<span class="archive-month-chip">${label}</span>` + days.map(d =>
      `<button type="button" class="archive-day-row${d.date === activeDate ? ' active' : ''}" aria-label="${d.date} 日报" aria-pressed="${d.date === activeDate}" onclick="loadDailyDate('${d.date}')">${parseInt(d.date.slice(8))} 日</button>`
    ).join('');
  }).join('');

  // 选中日期滚动到可视区域中间
  panel.querySelector('.archive-day-row.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

async function prefetchDailyDates() {
  const today = new Date();
  const dates = [];
  for (let i = 0; i < 10; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  dates.forEach((date, i) => {
    setTimeout(async () => {
      if (dailyCache[date]) return;
      const version = Math.floor(Date.now() / 300000);
      const data = await fetch(`data/daily/${date}.json?v=${version}`, { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null).catch(() => null);
      if (data?.sections) dailyCache[date] = data;
    }, i * 300);
  });
}

function getDailyBody() {
  return document.getElementById('dailyBody') || (() => {
    const col = document.getElementById('dailyContentCol');
    if (!col) return null;
    const div = document.createElement('div');
    div.id = 'dailyBody';
    col.appendChild(div);
    return div;
  })();
}

// 日报「先显示后翻译」：ArXiv 等英文源条目后台翻成中文，翻完若仍在看这天则重渲染（不阻塞加载）
let _dailyShownKey = '';
async function translateDailyData(data) {
  const items = [];
  (data.sections || []).forEach(s => (s.items || []).forEach(it => items.push(it)));
  const need = items.some(i => (isEnglish(i.title) && !i._translated) || (i.summary && !i._descTranslated && isEnglish(String(i.summary))));
  if (!need) return false;
  // translateItems 翻摘要读的是 description 字段，日报用 summary → 临时映射
  items.forEach(it => { if (it.summary != null && it.description == null) it.description = it.summary; });
  await translateItems(items);
  items.forEach(it => { if (it._descTranslated && it.description) it.summary = it.description; });
  return true;
}
function afterDailyPaint(data, key) {
  _dailyShownKey = key;
  requestAnimationFrame(applyReadState);
}
// 报纸兜底路径（AI HOT 无 sections 时走 RSS items）：同样先显示后翻译
function afterNewspaperPaint(items, key) {
  _dailyShownKey = key;
  const need = (items || []).some(i => (isEnglish(i.title) && !i._translated) || (i.description && !i._descTranslated && isEnglish(String(i.description).replace(/<[^>]*>/g, ' ').slice(0, 80))));
  if (!need) return;
  translateItems(items).then(() => {
    if (_dailyShownKey === key && activeTab === 'daily') {
      const b = document.getElementById('dailyBody');
      if (b) b.innerHTML = renderDailyNewspaper(items);
    }
  }).catch(() => {});
}

async function loadDailyDate(date, options = {}) {
  if (options.force) initArchive(true);
  const request = ++dailyRequest;
  if (date && !Station.validDate(date)) date = 'invalid';
  if (options.history !== false) updateRoute({tab:'daily', date});
  const main = document.getElementById('main');
  main.setAttribute('aria-busy', 'true');
  showDataStatus('正在检查日报…');
  try {
    if (date === 'invalid') throw new Error('Invalid date');
    const url = date ? `data/daily/${date}.json` : 'data/daily-latest.json';
    const result = await stationData.get(url, {force:!!options.force, validate:data => Station.validSnapshot(data, date)});
    if (request !== dailyRequest || activeTab !== 'daily') return;
    const data = result.data;
    dailyCache[data.date] = data;
    archiveActiveDate = data.date;
    STATIC_DAILY_DATES.add(data.date);
    counts.daily = data.sections.reduce((n, section) => n + section.items.length, 0);
    cache.daily = {aiHotData:data, ts:Date.now(), updated:data.generatedAt};
    renderNav();
    renderTab(TABS.find(t => t.id === 'daily'), [], [], data);
    showDataStatus(result.stale ? '暂时无法连接，正在显示上次保存的日报。' : data.date !== Station.beijingDate() && !date ? `最近一期：${data.date}；今日日报尚未发布。` : '');
  } catch {
    if (request !== dailyRequest || activeTab !== 'daily') return;
    main.innerHTML = `<div class="empty-state"><h1>本期日报暂不可用</h1><p>${esc(date || '')}</p><a href="?tab=daily">查看最近一期</a> · <a href="daily/">日报存档</a></div>`;
    showDataStatus('未找到日期一致的有效日报，请稍后重试。');
  } finally {
    if (request === dailyRequest && activeTab === 'daily') main.removeAttribute('aria-busy');
  }
}

function setArchivePanel(visible) {
  // 存档列表现在在主内容区，此处仅占位
}

// ── 关键词条面板 ──────────────────────────────────────
const KW_DEF = [
  { kw: 'GPT / OpenAI',  terms: ['openai','gpt-4','gpt-5','chatgpt','o3','o4'] },
  { kw: 'Claude / Anthropic', terms: ['anthropic','claude','claude-4','claude-3'] },
  { kw: 'Gemini / Google', terms: ['gemini','google deepmind','google ai','bard'] },
  { kw: 'AI Agent',      terms: ['agent','manus','agentic','autonomous ai','multi-agent'] },
  { kw: 'AI 图像/视频',  terms: ['sora','runway','midjourney','flux','kling','image generation','video generation','文生图','文生视频'] },
  { kw: 'AI 编程',       terms: ['cursor','copilot','devin','codegen','code generation','ai coding'] },
  { kw: '开源模型',      terms: ['llama','mistral','qwen','deepseek','open source model','开源'] },
  { kw: 'AI 硬件/算力',  terms: ['nvidia','gpu','h100','tpu','inference chip','算力'] },
  { kw: 'AI 安全/监管',  terms: ['ai safety','alignment','regulation','eu ai act','监管','安全'] },
  { kw: 'Vibe Coding',   terms: ['vibe coding','no-code ai','low-code','bolt.new','lovable'] },
  { kw: 'RAG / 知识库',  terms: ['rag','retrieval','knowledge base','知识库','向量数据库'] },
  { kw: '多模态',        terms: ['multimodal','vision model','audio model','多模态'] },
  { kw: 'AI 设计工具',   terms: ['figma ai','adobe firefly','galileo','uizard','设计工具'] },
  { kw: '大模型融资',    terms: ['funding','valuation','investment','融资','估值'] },
  { kw: 'AI 产品发布',   terms: ['launch','release','announced','发布','上线','推出'] },
];

let kwData = [];    // [{ kw, terms, items: [...] }]  ≤6 entries
let kwActive = 0;
let kwBuiltAt = 0;

function kwGetItems() {
  const seen = new Set();
  const all = [];
  const cutoff = Date.now() - 15 * 24 * 60 * 60 * 1000;
  for (const entry of Object.values(cache)) {
    if (!entry?.items) continue;
    for (const item of entry.items) {
      if (seen.has(item.link)) continue;
      const ts = new Date(item.pubDate).getTime();
      if (!isNaN(ts) && ts < cutoff) continue;
      seen.add(item.link);
      all.push(item);
    }
  }
  return all;
}

function kwBuild(extraItems = []) {
  if (Date.now() - kwBuiltAt < 5 * 60 * 1000 && kwData.length) return;
  const cached = kwGetItems();
  const seen = new Set(cached.map(i => i.link));
  const all = [...cached, ...extraItems.filter(i => i.link && !seen.has(i.link))];
  if (!all.length) return;
  const results = [];
  for (const def of KW_DEF) {
    const matched = all.filter(item => {
      const haystack = ((item.title || '') + ' ' + (item.description || '')).toLowerCase();
      return def.terms.some(t => haystack.includes(t.toLowerCase()));
    });
    if (matched.length >= 1) results.push({ kw: def.kw, count: matched.length, items: matched.slice(0, 4) });
  }
  results.sort((a, b) => b.count - a.count);
  kwData = results.slice(0, 6);
  kwActive = 0;
  kwBuiltAt = Date.now();
}

function kwItemHtml(item) {
  const ts = new Date(item.pubDate);
  const ago = isNaN(ts) ? '' : (() => {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
    return Math.floor(diff / 86400) + '天前';
  })();
  return `<a class="kw-item" href="${esc(Station.safeURL(item.link || '#') || '#')}" target="_blank" rel="noopener">
    <span class="kw-item-meta">${ago}</span>
    <span class="kw-item-sep">｜</span>
    <span class="kw-item-title">${esc(item.title || '')}</span>
  </a>`;
}

function kwHtml() {
  if (!kwData.length) return '';
  const btns = kwData.map((d, i) => `
    <button type="button" class="kw-btn${i === kwActive ? ' active' : ''}" aria-pressed="${i === kwActive}" onclick="kwSelect(${i})">${esc(d.kw)}</button>`).join('');
  const rightItems = (kwData[kwActive]?.items || []).map(kwItemHtml).join('');
  return `
    <div class="kw-row">
      <div class="kw-wrap">
        <div class="kw-left">${btns}</div>
        <div class="kw-right" id="kwRight">${rightItems}</div>
      </div>
    </div>`;
}

function kwSelect(idx) {
  kwActive = idx;
  document.querySelectorAll('.kw-btn').forEach((b, i) => {b.classList.toggle('active', i === idx);b.setAttribute('aria-pressed',i===idx);});
  const right = document.getElementById('kwRight');
  if (right) right.innerHTML = (kwData[idx]?.items || []).map(kwItemHtml).join('');
}

// ── Init ──────────────────────────────────────────────
// 精选首次渲染完成后才触发其他 tab 预取，避免争带宽
let _featuredPaintResolve = null;
const featuredPainted = new Promise(res => { _featuredPaintResolve = res; });

function init() {
  // 从 localStorage 恢复上次缓存，让 switchTab 直接命中缓存秒显示
  const store = loadFeedStore();
  Object.entries(store).forEach(([key, data]) => {
    if (data?.items?.length) cache[key] = {...data, items:data.items.map(Station.normalizeItem).filter(Boolean)};
  });

  renderNav();
  restoreRoute();
  scheduleAutoRefresh();
  window.addEventListener('popstate', restoreRoute);
}
function restoreRoute() {
  const params = new URL(location.href).searchParams;
  const tab = params.get('tab') || DEFAULT_TAB;
  allCatFilter = ['all','ai-products','design','video'].includes(params.get('category')) ? params.get('category') : 'all';
  allSrcFilter = params.get('source') === 'official' ? 'official' : 'all';
  toolFil = {cat:params.get('toolCategory') || 'all', region:['国产','海外'].includes(params.get('region')) ? params.get('region') : 'all', free:params.get('free') === '1'};
  switchTab(TABS.some(t => t.id === tab && !t.hidden) ? tab : DEFAULT_TAB, {history:false});
}

// ── Navigation ────────────────────────────────────────
function renderNav() {
  const tabs = TABS.filter(t => !t.hidden);

  // PC 侧边栏
  const nav = document.getElementById('tabNav');
  const makeBtn = t => `
    <button class="tab-btn ${t.id === activeTab ? 'active' : ''}"
            id="btn-${t.id}"
            aria-pressed="${t.id === activeTab}"
            onclick="switchTab('${t.id}')"
            onmouseenter="prefetchTab('${t.id}')">
      <span class="tab-icon">${t.icon}</span>
      <span>${t.name}</span>
      ${counts[t.id] != null ? `<span class="tab-count">${counts[t.id]}</span>` : ''}
    </button>`;
  const byId = Object.fromEntries(tabs.map(t => [t.id, t]));
  nav.innerHTML = NAV_GROUPS.map((g, gi) => {
    const btns = g.ids.map(id => byId[id]).filter(Boolean).map(makeBtn).join('');
    if (!btns) return '';
    const mt = gi === 0 ? '' : ' style="margin-top:12px"';
    return `<div class="tab-group-label"${mt}>${g.label}</div>` + btns;
  }).join('');

  // 移动端底部导航（固定5个）
  const mobileNav = document.getElementById('mobileNav');
  if (mobileNav) {
    const isGroupActive = MOB_GROUP_IDS.includes(activeTab);
    const isChronicleActive = activeTab === 'timeline' || activeTab === 'funding';
    if (isGroupActive) mobGroupActiveId = activeTab;
    const toolsTab = TABS.find(t => t.id === 'tools');

    mobileNav.innerHTML = MOB_NAV_ORDER.map(id => {
      const t = TABS.find(t => t.id === id);
      if (!t) return '';
      const isActive = t.id === activeTab || (t.id === 'timeline' && isChronicleActive);
      return `<button class="mob-tab-btn ${isActive ? 'active' : ''}"
              aria-pressed="${isActive}" onclick="switchTab('${t.id}')">
        <span class="mob-tab-icon">${t.icon}</span>
        <span class="mob-tab-label">${t.mob || t.name.replace(/^AI\s/, '')}</span>
      </button>`;
    }).join('') + (toolsTab ? `
    <button class="mob-tab-btn ${isGroupActive ? 'active' : ''}"
            aria-pressed="${isGroupActive}" onclick="switchTab('tools')">
      <span class="mob-tab-icon">${toolsTab.icon}</span>
      <span class="mob-tab-label">工具库</span>
    </button>` : '');
  }
}

// 将已翻译的内容从旧数组继承到新数组（按 link 匹配），避免 Phase 2 重新渲染时丢失 Phase 1 翻译
function inheritTranslations(newItems, fromItems) {
  if (!fromItems || !fromItems.length) return;
  const byLink = new Map(fromItems.filter(i => i.link).map(i => [i.link, i]));
  newItems.forEach(item => {
    if (!item.link) return;
    const prev = byLink.get(item.link);
    if (!prev) return;
    if (prev._translated) {
      item.title = prev.title;
      item.titleOriginal = prev.titleOriginal;
      item._translated = true;
    }
    if (prev._descTranslated) {
      item.description = prev.description;
      item._descTranslated = true;
    }
  });
}

// ── Phase 2 full load（第一阶段10条展示后，后台补充完整数量）───
function scheduleFullLoad(id, tab, activeFeedList, cacheKey, prevErrors, aiHotItems = []) {
  if (tab.layout === 'daily' || tab.layout === 'jobs' || !activeFeedList.length) return;
  setTimeout(async () => {
    if (activeTab !== id) return;
    const results = await Promise.allSettled(activeFeedList.map(f => fetchFeed(f))); // 默认 full limit
    if (activeTab !== id) return;
    let rssArr = [];
    const feedErrors = [...prevErrors];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.length)
        rssArr = rssArr.concat(r.value.map(item => ({ ...item, _feed: activeFeedList[i] })));
    });
    if (!rssArr.length) return;
    let items = mergeItems([...aiHotItems, ...rssArr], tab);
    // 继承 Phase 1 已翻译的内容
    inheritTranslations(items, cache[cacheKey]?.items);
    // 移动端先渲染再延迟翻译，避免翻译阻塞首屏
    if (tab.translate) {
      if (IS_MOBILE) {
        setTimeout(() => translateItems(items).then(() => { if (activeTab === id) renderTab(tab, items, feedErrors); }), 3000);
      } else {
        await translateItems(items);
      }
    }
    if (activeTab !== id) return;
    cache[cacheKey] = { items, feedErrors, aiHotData: null, ts: Date.now() };
    saveFeedCache(cacheKey, cache[cacheKey]);
    counts[id] = items.length;
    renderNav();
    renderTab(tab, items, feedErrors);
  }, 1500);
}

// ── 移动端产品组浮层 ─────────────────────────────────────
function toggleMobMore() {
  const panel = document.getElementById('mobMorePanel');
  const backdrop = document.getElementById('mobMoreBackdrop');
  if (!panel) return;
  if (panel.classList.contains('open')) {
    closeMobMore();
  } else {
    renderMobMorePanel();
    panel.classList.add('open');
    backdrop?.classList.add('open');
  }
}
function renderMobMorePanel() {
  const panel = document.getElementById('mobMorePanel');
  if (!panel) return;
  panel.innerHTML = '<div class="mob-more-handle"></div>' +
    MOB_GROUP_IDS.map(id => {
      const t = TABS.find(t => t.id === id);
      if (!t) return '';
      return `<button class="mob-more-opt ${activeTab === id ? 'active' : ''}" onclick="selectMobMore('${id}')">
        <span class="mob-more-opt-icon">${t.icon}</span>
        <span class="mob-more-opt-label">${t.name}</span>
      </button>`;
    }).join('');
}
function selectMobMore(id) {
  closeMobMore();
  mobGroupActiveId = id;
  switchTab(id);
}
function closeMobMore() {
  document.getElementById('mobMorePanel')?.classList.remove('open');
  document.getElementById('mobMoreBackdrop')?.classList.remove('open');
}

document.addEventListener('click', event => {
  document.querySelectorAll('details.source-info[open]').forEach(details => {
    if (!details.contains(event.target)) details.removeAttribute('open');
  });
});

// ── Tab switch ────────────────────────────────────────
function prefetchTab(id) {
  if (id === activeTab || !['featured', 'all'].includes(id)) return;
  fetchStaticData(id).then(data => {
    if (!data) return;
    cache[id] = {items:data.items, updated:data.updated, stale:data.stale, ts:Date.now()};
    saveFeedCache(id, cache[id]);
  });
}

// ── AI Builder tab: fetch from Follow Builders feeds ──────────────────────
const BUILDERS_FEED_X       = 'https://yehloo-ai.github.io/ai-news-station/data/builders-x.json';
const BUILDERS_FEED_PODCAST = 'https://yehloo-ai.github.io/ai-news-station/data/builders-podcasts.json';
const AV_COLORS = ['#d01922','#7c3aed','#0891b2','#16a34a','#ea580c','#1677ff','#c026d3','#0f766e'];
function builderAvColor(name = '') { return AV_COLORS[name.charCodeAt(0) % AV_COLORS.length]; }
function fmtBigNum(n) { if (!n) return '0'; return n >= 1000 ? (n/1000).toFixed(1)+'k' : String(n); }
function fmtPodDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('zh-CN', { month:'long', day:'numeric' }); } catch { return ''; }
}

// ── Render: AI 大事记（模型发布时间线）──────────────────
const TL_MOD_CLASS = { '语言':'m-lang', '视频':'m-video', '图像':'m-image', '语音':'m-audio', '多模态':'m-multi', '专用':'m-special' };
const TL_LINK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
function tlTypeParts(type) {
  const p = (type || '').split('·').map(s => s.trim()).filter(Boolean);
  return { mod: p[0] || '', attrs: p.slice(1), cls: TL_MOD_CLASS[p[0]] || 'm-special' };
}
function tlModelLink(e) {
  return e.sourceUrl
    ? `<a href="${esc(Station.safeURL(e.sourceUrl) || '#')}" target="_blank" rel="noopener">${esc(e.model)}</a>`
    : esc(e.model);
}
function tlSource(e, cls) {
  if (!e.sourceUrl) return '';
  if (cls === 'tl-source') {
    const name = esc(e.sourceName || '原始信源');
    const date = esc(e.date || '');
    return `<span class="tl-source-line"><span class="tl-source-main"><span class="tl-source-label">信源：</span><a class="${cls}" href="${esc(Station.safeURL(e.sourceUrl) || '#')}" target="_blank" rel="noopener">${name}</a></span>${date ? `<span class="tl-source-date">${date}</span>` : ''}</span>`;
  }
  return `<a class="${cls}" href="${esc(Station.safeURL(e.sourceUrl) || '#')}" target="_blank" rel="noopener">${TL_LINK_ICON}</a>`;
}
function tlCard(e) {
  const { mod, attrs, cls } = tlTypeParts(e.type);
  const catPill = mod ? `<span class="tl-cat">${esc(mod)}</span>` : '';
  const attrPills = attrs.map(a => `<span class="tl-attr">${esc(a)}</span>`).join('');

  if (e.tier === 'minor') {
    return `<div class="tl-card minor ${cls}">
      <div class="tl-minor-row">
        <span class="tl-company">${esc(e.company)}</span>
        ${catPill}
        <span class="tl-model">${tlModelLink(e)}</span>
        <span class="tl-minor-desc">${esc(e.highlight || '')}</span>
        ${tlSource(e, 'tl-minor-src')}
      </div>
    </div>`;
  }

  const isMile = e.tier === 'milestone' && !e.auto;
  const mileTag = isMile ? `<span class="tl-mile-tag">★ 里程碑</span>` : '';
  const impact = (isMile && e.impact) ? `<div class="tl-impact"><b>意味着 </b>${esc(e.impact)}</div>` : '';
  return `<div class="tl-card ${isMile ? 'milestone' : ''} ${cls}">
    <div class="tl-meta">
      <span class="tl-company">${esc(e.company)}</span>
      ${catPill}${attrPills}${mileTag}
    </div>
    <div class="tl-model">${tlModelLink(e)}</div>
    <div class="tl-highlight">${esc(e.highlight || '')}</div>
    ${e.specs?.length ? `<div class="tl-specs">${e.specs.map(s => `<span>${esc(s)}</span>`).join('')}</div>` : ''}
    ${impact}
    <div class="tl-foot">${tlSource(e, 'tl-source')}${e.auto ? '<span class="review-label">历史自动整理 · 待复核</span>' : ''}</div>
  </div>`;
}
function renderModelTimeline(data) {
  const main = document.getElementById('main');
  const entries = [...data.entries].sort((a, b) => b.date.localeCompare(a.date));

  const byYear = {};
  entries.forEach(e => { const y = e.date.slice(0, 4); (byYear[y] = byYear[y] || []).push(e); });

  const yearsHtml = Object.entries(byYear).sort((a, b) => b[0].localeCompare(a[0])).map(([year, list]) => {
    const byDate = {};
    list.forEach(e => { (byDate[e.date] = byDate[e.date] || []).push(e); });
    const dateRows = Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0])).map(([date, items]) => `
      <div class="tl-row">
        <div class="tl-time" title="${date}">
          <span class="tl-time-label">${date.slice(5)}</span>
          <span class="tl-time-dot"></span>
          ${items.length > 1 ? `<span class="tl-time-n">${items.length} 条</span>` : ''}
        </div>
        <div class="tl-daycards">${items.map(tlCard).join('')}</div>
      </div>`).join('');
    return `
      <div class="tl-year-node">
        <span class="tl-year-dot"></span>
        <span class="tl-year-text">${year} 年<span class="tl-year-count">${list.length} 条</span></span>
      </div>
      <div class="tl-list">${dateRows}</div>`;
  }).join('');

  main.innerHTML = `
    <div class="chronicle-top">
      <div class="section-header chronicle-header">
        <div>
          <div class="section-title"><span class="desktop-only">AI 大事记 · 模型发布时间线</span><span class="mobile-only chronicle-mobile-title"><span class="chronicle-title-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>大事记</span></div>
          <div class="section-tagline mobile-only">模型与资本动态</div>
        </div>
        <div class="section-sub">${entries.length} 条 · 更新于 ${data.updatedAt}</div>
      </div>
      ${chronicleTabs('timeline')}
    </div>
    <div class="source-pills chronicle-subtitle">哪家 · 什么模型 · 哪天发布 · 关键规格 —— 条目附原始来源，自动整理内容仍需核实，<a href="timeline/" target="_blank" rel="noopener" style="color:var(--accent);">网页版（可分享）</a></div>
    <div class="tl-wrap chronicle-timeline">${yearsHtml}</div>`;
}

// ── Render: AI 大事记（资本动态 / 融资时间线）——复用模型发布的时间轴视觉语言 ──
const FUND_SECTOR_CLASS = { '大模型':'m-lang', '芯片算力':'m-video', '应用':'m-image', '具身智能':'m-audio', '数据基础设施':'m-multi', '其他':'m-special' };
function fundAmount(e) {
  return `<span class="fund-amt">${esc(e.amount || '')}${e.currency ? ' ' + esc(e.currency) : ''}</span>${e.valuation ? `<span class="fund-val"> · ${esc(e.valuation)}</span>` : ''}`;
}
function fundCard(e) {
  const cls = FUND_SECTOR_CLASS[e.sector] || 'm-special';
  const catPill = e.sector ? `<span class="tl-cat">${esc(e.sector)}</span>` : '';
  const roundPill = e.round ? `<span class="tl-attr">${esc(e.round)}</span>` : '';
  if (e.tier === 'minor') {
    return `<div class="tl-card minor ${cls}">
      <div class="tl-minor-row">
        <span class="tl-company">${esc(e.company)}</span>
        ${catPill}
        <span class="tl-model">${fundAmount(e)}</span>
        <span class="tl-minor-desc">${esc(e.highlight || '')}</span>
      </div>
    </div>`;
  }
  const isMile = e.tier === 'milestone';
  const mileTag = isMile ? `<span class="tl-mile-tag">★ 里程碑</span>` : '';
  const impact = (isMile && e.impact) ? `<div class="tl-impact"><b>意味着 </b>${esc(e.impact)}</div>` : '';
  return `<div class="tl-card ${isMile ? 'milestone' : ''} ${cls}">
    <div class="tl-meta">
      <span class="tl-company">${esc(e.company)}</span>
      ${catPill}${roundPill}${mileTag}
    </div>
    <div class="tl-model">${fundAmount(e)}</div>
    <div class="tl-highlight">${esc(e.highlight || '')}</div>
    ${e.specs?.length ? `<div class="tl-specs">${e.specs.map(s => `<span>${esc(s)}</span>`).join('')}</div>` : ''}
    ${impact}
    <div class="tl-foot">${tlSource(e, 'tl-source')}</div>
  </div>`;
}
function renderFundingTimeline(data) {
  const main = document.getElementById('main');
  const entries = [...data.entries].sort((a, b) => b.date.localeCompare(a.date));
  const byYear = {};
  entries.forEach(e => { const y = e.date.slice(0, 4); (byYear[y] = byYear[y] || []).push(e); });
  const yearsHtml = Object.entries(byYear).sort((a, b) => b[0].localeCompare(a[0])).map(([year, list]) => {
    const byDate = {};
    list.forEach(e => { (byDate[e.date] = byDate[e.date] || []).push(e); });
    const dateRows = Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0])).map(([date, items]) => `
      <div class="tl-row">
        <div class="tl-time" title="${date}">
          <span class="tl-time-label">${date.slice(5)}</span>
          <span class="tl-time-dot"></span>
          ${items.length > 1 ? `<span class="tl-time-n">${items.length} 条</span>` : ''}
        </div>
        <div class="tl-daycards">${items.map(fundCard).join('')}</div>
      </div>`).join('');
    return `
      <div class="tl-year-node">
        <span class="tl-year-dot"></span>
        <span class="tl-year-text">${year} 年<span class="tl-year-count">${list.length} 条</span></span>
      </div>
      <div class="tl-list">${dateRows}</div>`;
  }).join('');
  main.innerHTML = `
    <div class="chronicle-top">
      <div class="section-header chronicle-header">
        <div>
          <div class="section-title"><span class="desktop-only">AI 大事记 · 资本动态时间线</span><span class="mobile-only chronicle-mobile-title"><span class="chronicle-title-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>大事记</span></div>
          <div class="section-tagline mobile-only">模型与资本动态</div>
        </div>
        <div class="section-sub">${entries.length} 条 · 更新于 ${data.updatedAt}</div>
      </div>
      ${chronicleTabs('funding')}
    </div>
    <div class="source-pills chronicle-subtitle">谁 · 什么轮次 · 多少钱 · 什么估值 —— 条目均附信源</div>
    <div class="tl-wrap chronicle-timeline">${yearsHtml}</div>`;
}

function chronicleTabs(current) {
  return `<div class="chronicle-tabs" role="group" aria-label="大事记分类">
    <button class="chronicle-tab ${current === 'timeline' ? 'active' : ''}" type="button" aria-pressed="${current === 'timeline'}" onclick="switchTab('timeline')">模型发布</button>
    <button class="chronicle-tab ${current === 'funding' ? 'active' : ''}" type="button" aria-pressed="${current === 'funding'}" onclick="switchTab('funding')">资本动态</button>
  </div>`;
}

// ── Render: AI 工具库（按场景分类的工具导航）──
let TOOLS_NEW_MONTH = null; // 本月新增标记（有更早月份的工具作基线时才启用，避免首月全标 NEW）
const TOOLS_SUGGEST_URL = 'https://github.com/yehloo-ai/ai-news-station/issues/new?title=' +
  encodeURIComponent('【工具收录建议】') + '&body=' + encodeURIComponent('工具名称：\n官网链接：\n所属分类：\n一句话简介：');
function toolCard(t, cat, catName) {
  let host = '';
  try { host = new URL(t.url).hostname.replace(/^www\./, ''); } catch (e) {}
  const tags = (t.tags || []).map(x => `<span class="tool-tag">${esc(x)}</span>`).join('');
  const priceCls = t.pricing === '付费' ? 'paid' : (t.pricing === '免费额度' ? 'trial' : 'free');
  const priceBadge = t.pricing ? `<span class="tool-price ${priceCls}">${esc(t.pricing)}</span>` : '';
  const newBadge = (TOOLS_NEW_MONTH && t.added === TOOLS_NEW_MONTH) ? `<span class="tool-new">NEW</span>` : '';
  const meta = [t.platform, t.zh ? '中文' : '', t.region].filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('');
  const initial = esc(((t.name || '?').trim().slice(0, 2) || '?').toUpperCase());
  const logo = `<span class="tool-logo" aria-hidden="true" style="background:${builderAvColor(t.name || '')}">${initial}</span>`;
  const free = t.pricing === '免费';
  const search = esc(`${t.name} ${t.by || ''} ${t.desc || ''} ${(t.tags || []).join(' ')} ${catName || ''}`.toLowerCase());
  return `<a class="tool-card" data-cat="${esc(cat || '')}" data-region="${esc(t.region || '')}" data-free="${free ? 1 : 0}" data-search="${search}" href="${esc(Station.safeURL(t.url) || '#')}" target="_blank" rel="noopener">
    <div class="tool-card-head">
      ${logo}
      <div class="tool-card-head-main">
        <div class="tool-name-row"><span class="tool-name">${esc(t.name)}</span>${newBadge}</div>
        ${t.by ? `<div class="tool-by">${esc(t.by)}</div>` : ''}
      </div>
      ${priceBadge}
    </div>
    <div class="tool-desc">${esc(t.desc || '')}</div>
    ${meta ? `<div class="tool-meta">${meta}</div>` : ''}
    <div class="tool-foot">
      <span class="tool-tags">${tags}</span>
      <span class="tool-host">${esc(host)} →</span>
    </div>
  </a>`;
}
function renderTools(data) {
  const main = document.getElementById('main');
  const toolTab = TABS.find(tab => tab.id === 'tools');
  const cats = data.categories || [];
  const total = cats.reduce((n, c) => n + (c.tools?.length || 0), 0);
  const curMonth = new Date().toISOString().slice(0, 7);
  const months = cats.flatMap(c => c.tools || []).map(t => t.added).filter(Boolean);
  TOOLS_NEW_MONTH = months.some(m => m < curMonth) ? curMonth : null;
  const newCount = TOOLS_NEW_MONTH ? months.filter(m => m === TOOLS_NEW_MONTH).length : 0;
  if (toolFil.cat !== 'all' && !cats.some(c => c.id === toolFil.cat)) toolFil.cat = 'all';

  const filters = `<button class="tool-fil on" data-cat="all" onclick="filterToolsCat('all')">全部</button>` +
    cats.map(c => `<button class="tool-fil" data-cat="${c.id}" onclick="filterToolsCat('${c.id}')">${esc(c.name)}</button>`).join('');
  const sections = cats.map(c => `
    <div class="tool-cat" data-cat="${c.id}">
      <div class="tool-cat-title">${esc(c.name)}<span class="tool-cat-n">${c.tools?.length || 0}</span></div>
      <div class="tool-grid">${(c.tools || []).map(tt => toolCard(tt, c.id, c.name)).join('')}</div>
    </div>`).join('');
  main.innerHTML = `
    <div class="section-header tools-header">
      <div class="section-title" style="display:flex;align-items:center;gap:8px"><span style="width:20px;height:20px;display:flex;align-items:center;justify-content:center;flex-shrink:0">${toolTab?.icon || ''}</span>AI 工具库</div>
      <div class="section-sub">${total} 款精选工具 · ${cats.length} 个场景${newCount ? ` · 本月新增 ${newCount}` : ''} · 更新于 ${data.updatedAt || ''}</div>
    </div>
    <div class="tool-controls">
      <div class="source-pills tools-intro">按场景挑选好用的 AI 工具，点击直达官网 · <a href="${TOOLS_SUGGEST_URL}" target="_blank" rel="noopener" style="color:var(--accent);">推荐收录 →</a> · <a href="tools/" target="_blank" rel="noopener" style="color:var(--accent);">网页版（可分享）</a></div>
      <div class="tool-search"><label class="sr-only" for="toolSearch">搜索工具名称、厂商、用途</label><input type="search" id="toolSearch" value="${esc(new URL(location.href).searchParams.get('q') || '')}" placeholder="搜索工具名称、厂商、用途…" oninput="filterToolsRun()"></div>
      <div class="tool-filter"><span class="tool-sub-label">类型</span><div class="tool-filter-options">${filters}</div></div>
      <div class="tool-subfilter">
        <span class="tool-sub-label">地区</span>
        <div class="tool-filter-options">
          <button class="tool-chip on" data-region="all" onclick="filterToolsRegion('all')">全部</button>
          <button class="tool-chip" data-region="国产" onclick="filterToolsRegion('国产')">国产</button>
          <button class="tool-chip" data-region="海外" onclick="filterToolsRegion('海外')">海外</button>
          <span class="tool-sub-sep"></span>
          <button class="tool-chip" id="toolFreeChip" onclick="filterToolsFree()">仅看免费</button>
        </div>
      </div>
    </div>
    <div id="toolSections">${sections}</div>
    <div class="tool-empty" id="toolEmpty" style="display:none">没有匹配的工具，换个关键词或筛选试试。</div>`;
  filterToolsRun();
}
let toolFil = { cat: 'all', region: 'all', free: false };
function filterToolsCat(cat) {
  toolFil.cat = cat;
  document.querySelectorAll('.tool-fil').forEach(b => b.classList.toggle('on', b.dataset.cat === cat));
  filterToolsRun();
}
function filterToolsRegion(r) {
  toolFil.region = r;
  document.querySelectorAll('.tool-chip[data-region]').forEach(b => b.classList.toggle('on', b.dataset.region === r));
  filterToolsRun();
}
function filterToolsFree() {
  toolFil.free = !toolFil.free;
  document.getElementById('toolFreeChip')?.classList.toggle('on', toolFil.free);
  filterToolsRun();
}
function filterToolsRun() {
  const q = (document.getElementById('toolSearch')?.value || '').trim().toLowerCase();
  const { cat, region, free } = toolFil;
  updateRoute({toolCategory:cat === 'all' ? null : cat, region:region === 'all' ? null : region, free:free ? '1' : null, q:q || null}, true);
  document.querySelectorAll('.tool-fil').forEach(button => { const on = button.dataset.cat === cat; button.classList.toggle('on', on); button.setAttribute('aria-pressed', on); });
  document.querySelectorAll('.tool-chip[data-region]').forEach(button => { const on = button.dataset.region === region; button.classList.toggle('on', on); button.setAttribute('aria-pressed', on); });
  const freeButton = document.getElementById('toolFreeChip');
  freeButton?.classList.toggle('on', free);
  freeButton?.setAttribute('aria-pressed', free);
  let anyShown = false;
  document.querySelectorAll('#toolSections .tool-cat').forEach(sec => {
    let shown = 0;
    sec.querySelectorAll('.tool-card').forEach(card => {
      const ok = (cat === 'all' || card.dataset.cat === cat)
        && (region === 'all' || card.dataset.region === region)
        && (!free || card.dataset.free === '1')
        && (!q || (card.dataset.search || '').includes(q));
      card.style.display = ok ? '' : 'none';
      if (ok) shown++;
    });
    sec.style.display = shown ? '' : 'none';
    const n = sec.querySelector('.tool-cat-n'); if (n) n.textContent = shown;
    if (shown) anyShown = true;
  });
  const empty = document.getElementById('toolEmpty');
  if (empty) empty.style.display = anyShown ? 'none' : '';
}

function renderBuilders(xData, podData) {
  const builders = ((xData && xData.x) || []).filter(b => b.tweets && b.tweets.length);
  const podcasts = (podData && podData.podcasts) || [];
  const main = document.getElementById('main');
  const now = new Date().toLocaleDateString('zh-CN', { month:'long', day:'numeric' });
  // 数据新鲜度：X 源若长时间未更新（>36h），展示上次内容并诚实标注日期，而非谎称「最新」
  const xGenAt = (xData && xData.generatedAt) ? new Date(xData.generatedAt) : null;
  const xStale = xGenAt ? (Date.now() - xGenAt.getTime() > 36 * 3600 * 1000) : false;
  const xDateStr = xGenAt ? `${xGenAt.getMonth() + 1}月${xGenAt.getDate()}日` : '';

  const builderHtml = builders.map(b => {
    const bio = (b.bio || '').split('\n')[0].trim().substring(0, 50);
    const top = [...b.tweets].sort((a, z) => (z.likes||0) - (a.likes||0))[0];
    if (!top) return '';
    const translated = top._translated || '';
    const bioTag = b._bioZh ? `<div class="builder-bio-tag">${esc(b._bioZh)}</div>` : '';
    return `
      <div class="builder-card">
        ${bioTag}
        <div class="builder-head">
          <div class="builder-av" style="background:${builderAvColor(b.name||b.handle)}">${esc((b.name||b.handle||'?')[0].toUpperCase())}</div>
          <div>
            <div class="builder-name">${esc(b.name||b.handle)}</div>
            <div class="builder-handle">@${esc(b.handle)}</div>
          </div>
        </div>
        <div class="builder-tweet-text" style="margin-bottom:10px">${esc(translated || top.text)}</div>
        <div class="builder-tweet-foot">
          <span class="builder-tweet-stat">♥ ${fmtBigNum(top.likes)}</span>
          <span class="builder-tweet-stat">↺ ${fmtBigNum(top.retweets)}</span>
          ${top.url ? `<a href="${esc(Station.safeURL(top.url) || '#')}" target="_blank" class="builder-tweet-link">原文 →</a>` : ''}
        </div>
      </div>`;
  }).join('');

  const podcastHtml = podcasts.map(p => {
    const preview = (p.transcript || '')
      .replace(/Speaker \d+ \| [\d:]+ - [\d:]+\n/g, '').trim().substring(0, 500);
    return `
      <div class="podcast-card-b">
        <div class="podcast-head-b">
          <div class="podcast-icon-b">🎙</div>
          <div>
            <div class="podcast-name-b">${esc(p.name)}</div>
            <div class="podcast-title-b">${esc(p.title||'')}</div>
            ${p.publishedAt ? `<div class="podcast-date-b">${fmtPodDate(p.publishedAt)}</div>` : ''}
          </div>
        </div>
        ${preview ? `<div class="podcast-preview-b">${esc(preview)}…</div>` : ''}
        ${p.url ? `<a href="${esc(Station.safeURL(p.url) || '#')}" target="_blank" class="podcast-link-b">🎧 收听 →</a>` : ''}
      </div>`;
  }).join('');

  const xDown = builders.length === 0; // X 数据源为空（上游 402/维护中）
  const empty = (!builders.length && !podcasts.length)
    ? `<div class="empty-state"><div class="empty-icon">📭</div><p>建造者数据源维护中，暂无更新</p></div>` : '';

  main.innerHTML = `
    <div class="section-header">
      <div class="section-title" style="display:flex;align-items:center;gap:8px">
        <span style="width:20px;height:20px;display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        </span>AI Builder
      </div>
      <div class="section-meta">${xDown ? '播客更新' : builders.length + ' 位有更新'} · ${(!xDown && xStale) ? xDateStr + ' 抓取' : nowStr() + ' 更新'}</div>
    </div>
    <div class="builders-banner">
      <div class="builders-banner-left">${xDown
        ? 'X · 建造者动态数据源维护中 · 播客精华照常更新'
        : (xStale
          ? `追踪 <b>26 位</b> AI 顶尖建造者 · 数据源维护中，展示上次抓取（${xDateStr}）`
          : '追踪 <b>26 位</b> AI 顶尖建造者 · 研究员、创始人、工程师的最新动态')}</div>
      <div class="builders-banner-pill">Follow Builders</div>
    </div>
    <div class="builders-wrap">
      ${builders.length > 0 ? `
        <div class="builders-section-label builders-section-label-row">X · 建造者动态${xStale ? `（上次抓取 · ${xDateStr}）` : ''}</div>
        ${builderHtml}` : (podcasts.length > 0 ? `
        <div class="builders-section-label builders-section-label-row" style="grid-column:1/-1;opacity:.7">X · 建造者动态（数据源维护中，暂无更新）</div>` : '')}
      ${podcasts.length > 0 ? `
        <div class="builders-section-label builders-section-label-row" style="grid-column:1/-1">播客精华</div>
        ${podcastHtml}` : ''}
      ${empty}
    </div>`;
}

async function switchTab(id, options = {}) {
  const tab = TABS.find(t => t.id === id && !t.hidden);
  if (!tab) return;
  const main = document.getElementById('main');
  tabScroll[activeTab] = window.innerWidth <= 768 ? window.scrollY : (document.getElementById('dailyContentCol') || main).scrollTop;
  const previousTab = activeTab;
  activeTab = id;
  const request = ++viewRequest;
  ++dailyRequest;
  closeMobMore();
  if (options.history !== false) updateRoute({tab:id, date:id === 'daily' ? archiveActiveDate : null});
  showDataStatus();
  renderNav();
  if (previousTab !== id || !main.querySelector('.card,.tl-card,.tool-card')) {
    main.classList.remove('daily-mode');
    showLoading();
  }
  if (id === 'daily') {
      const date = new URL(location.href).searchParams.get('date');
    await loadDailyDate(date, {force:options.force, history:false});
    return;
  }
  try {
    if (STATIC_TABS.has(id)) {
      const previous = cache[id];
      if (previous?.items?.length) renderTab(tab, previous.items, []);
      const data = await fetchStaticData(id, options.force);
      if (request !== viewRequest) return;
      if (!data) {
        if (previous?.items?.length) {
          showDataStatus('暂时无法连接，正在显示上次保存的资讯。');
          return;
        }
        throw new Error('Feed unavailable');
      }
      data.items.forEach(autoCat);
      cache[id] = {items:data.items, updated:data.updated, stale:data.stale, ts:Date.now()};
      saveFeedCache(id, cache[id]);
      counts[id] = data.items.length;
      renderNav();
      renderTab(tab, data.items, []);
      if (data.stale) showDataStatus('暂时无法连接，正在显示上次保存的资讯。');
      else if (data.degradedSources?.length) showDataStatus('部分来源本次采集异常，已保留可用内容；详情见“来源与纠错”。');
      else if (Date.now() - Date.parse(data.updated) > 6 * 3600000) showDataStatus('资讯更新延迟，当前显示最近一次有效数据。');
    } else if (['tools','timeline','funding'].includes(id)) {
      const file = id === 'timeline' ? 'models' : id;
      const result = await stationData.get(`data/${file}.json`, {force:!!options.force, validate:data => id === 'tools' ? Array.isArray(data?.categories) : Array.isArray(data?.entries)});
      if (request !== viewRequest) return;
      const data = result.data;
      cache[id] = {data, ts:Date.now()};
      counts[id] = id === 'tools' ? data.categories.reduce((n, c) => n + (c.tools?.length || 0), 0) : data.entries.length;
      renderNav();
      if (id === 'tools') renderTools(data);
      else if (id === 'timeline') renderModelTimeline(data);
      else renderFundingTimeline(data);
      if (result.stale) showDataStatus('暂时无法连接，正在显示上次保存的数据。');
      else if (id === 'tools') showDataStatus(`工具资料收录于 ${data.updatedAt || '未记录'}，价格与可用性以官网为准。`);
      else if (id === 'funding') showDataStatus(`档案更新于 ${data.updatedAt || '未记录'}，新增候选经核验后发布。`);
    }
    requestAnimationFrame(() => {
      if (request !== viewRequest) return;
      const top = tabScroll[id] || 0;
      if (window.innerWidth <= 768) window.scrollTo(0, top);
      else main.scrollTop = top;
      applyReadState();
    });
  } catch {
    if (request !== viewRequest) return;
    main.innerHTML = '<div class="empty-state"><h1>数据暂时无法加载</h1><button type="button" onclick="manualRefresh()">重新加载</button></div>';
    showDataStatus('请检查网络，或稍后重试。');
  }
}
function renderTitle(item, cls = '') {
  const title = esc(item.title || '');
  const orig = item.titleOriginal ? ` title="${esc(item.titleOriginal)}"` : '';
  const badge = item._translated ? `<span style="font-size:9px;font-weight:600;color:var(--muted);margin-left:4px;vertical-align:middle;opacity:0.6">译</span>` : '';
  return `<span class="${cls}"${orig}>${title}${badge}</span>`;
}

// 提取关键词标签（来自分类、标题、原文）
function extractTags(item) {
  const tags = [];
  const CAT_ZH = { 'ai-models': '大模型', 'ai-products': 'AI产品', 'industry': '行业', 'paper': '论文', 'design': '设计', 'funding': '融资', 'tip': '技巧', 'opensource': '开源' };
  if (item._aiCat && CAT_ZH[item._aiCat]) tags.push(CAT_ZH[item._aiCat]);
  const t = (item.title || '') + ' ' + (item.titleOriginal || '');
  [['GPT','GPT'],['Claude','Claude'],['Gemini','Gemini'],['Llama','Llama'],
   ['DeepSeek','DeepSeek'],['Grok','Grok'],['Kimi','Kimi'],['Sora','Sora'],
   ['Midjourney','MJ'],['Stable Diffusion','SD'],['文心','文心'],['通义','通义'],['混元','混元'],['Qwen','Qwen']
  ].forEach(([pat, label]) => { if (new RegExp(pat, 'i').test(t)) tags.push(label); });
  if (/开源|open.?source/i.test(t)) tags.push('开源');
  if (/多模态|multimodal/i.test(t)) tags.push('多模态');
  if (/推理|reasoning/i.test(t)) tags.push('推理');
  if (/融资|投资|funding|invest/i.test(t)) tags.push('融资');
  if (/安全|safety|alignment/i.test(t)) tags.push('安全');
  if (/视频|video/i.test(t)) tags.push('视频');
  if (/代码|code|coding/i.test(t)) tags.push('代码');
  if (/语音|audio|speech/i.test(t)) tags.push('语音');
  if (/智能体|agent/i.test(t)) tags.push('智能体');
  return [...new Set(tags)].slice(0, 3);
}

function autoCat(item) {
  // tip 直接继承 AI HOT 分类，不重新细分；industry/ai-products 允许细分
  if (item._aiCat && !['industry', 'ai-products'].includes(item._aiCat)) return;
  const feedName = item._feed?.name || '';
  if (/arxiv/i.test(feedName)) { item._aiCat = 'paper'; return; }
  const t = (item.title || '') + ' ' + (item.description || '');
  if (/融资|领投|跟投|估值|\bfunding\b|\binvestment\b/i.test(t)) { item._aiCat = 'funding'; return; }
  if (/\bCFO\b|财务官|任命|人事|财报|营收|领导层|裁员/i.test(t)) { item._aiCat = 'industry'; return; }
  const designRx = /设计|界面|交互|原型|组件|生图|绘图|图像生成|AI绘画|AI作图|文生图|文生视频|图生视频|ux|ui\b|midjourney|stable.diffusion|dall.e|firefly|canva|ideogram|flux\b|kling|runway|pika|sora|design|creative|illustration|figma|sketch\b/i;
  if (item._aiCat === 'ai-products') {
    if (designRx.test(t)) item._aiCat = 'design';
    return;
  }
  // 开源优先于模型：避免"开源 Llama"被归入模型而非开源
  if (/开源|开放.*权重|开放.*代码|开放.*模型|权重.*发布|open.?source|open.*weight|release.*weight|apache.*licen|mit.*licen/i.test(t))
    { item._aiCat = 'opensource'; return; }
  if (/模型|大模型|llm|gpt|claude|gemini|grok|llama|deepseek|minimax|kimi|文心|通义|混元|spark|mistral|qwen|发布.*版|更新.*版/i.test(t))
    { item._aiCat = 'ai-models'; return; }
  if (/论文|研究|实验|突破|学术|arXiv|preprint|paper|research|study|benchmark|dataset|评测|评估|性能对比/i.test(t))
    { item._aiCat = 'paper'; return; }
  if (/融资|投资|收购|估值|IPO|亿美元|亿元|上市|fund|invest|acqui|billion|million/i.test(t))
    { item._aiCat = 'funding'; return; }
  if (/教程|技巧|提示词|玩法|攻略|入门|指南|实战|速成|手册|秘籍|用法|最佳实践|如何.*使用|怎么用|操作方法|tutorial|guide|tips?\b|how.?to|prompt.*engineer|cheat.?sheet|workflow/i.test(t))
    { item._aiCat = 'tip'; return; }
  if (designRx.test(t)) { item._aiCat = 'design'; return; }
  if (/工具|产品|应用|上线|功能|插件|推出|上架|内测|公测|接入|搭载|集成|开放.*使用|plugin|app|feature|launch|release|update|introduc|announc/i.test(t))
    { item._aiCat = 'ai-products'; return; }
  item._aiCat = 'industry';
}

function mergeItems(items, tab) {
  if (tab.layout === 'jobs') {
    items = items.filter(item => {
      const t = (item.title || '').toLowerCase();
      return /\bai\b|design|product|ux|ui|llm|machine.learning|generative|diffusion|creative|vision|nlp|prompt/.test(t);
    });
  }
  // 全部动态 或 filterCat 分类 tab：运行 autoCat 打标
  if (tab.id === 'all' || tab.filterCat) items.forEach(autoCat);
  // filterCat tab 只保留对应分类的条目
  if (tab.filterCat) items = items.filter(i => i._aiCat === tab.filterCat);
  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  const seen = new Set();
  return items.filter(item => {
    const k = (item.title || '').slice(0, 60).toLowerCase().trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── Fetch ─────────────────────────────────────────────
// quick=true → 10条快速预览；full → arxiv 15 / 其他 30
function feedLimit(url, quick = false) {
  if (quick) return IS_MOBILE ? 5 : 10;
  if (IS_MOBILE) return 8;
  return url.includes('arxiv.org') ? 15 : 30;
}

async function tryProxy(proxy, encoded, url, limit) {
  if (proxy === 'rss2json') {
    const r = await fetch(`${API}?rss_url=${encoded}`, { signal: timeoutSignal(4000) });
    const d = await r.json();
    if (d.status === 'ok' && d.items?.length) return d.items.slice(0, limit);
    throw new Error('empty');
  }
  if (proxy === 'allorigins') {
    const r = await fetch(`https://api.allorigins.win/get?url=${encoded}`, { signal: timeoutSignal(6000) });
    const d = await r.json();
    const items = parseRssXml(d?.contents || '', limit);
    if (items.length) return items;
    throw new Error('empty');
  }
  if (proxy === 'allorigins_raw') {
    const r = await fetch(`https://api.allorigins.win/raw?url=${encoded}`, { signal: timeoutSignal(8000) });
    const xml = await r.text();
    const items = parseRssXml(xml, limit);
    if (items.length) return items;
    throw new Error('empty');
  }
  if (proxy === 'corsproxy') {
    const r = await fetch(`https://corsproxy.io/?url=${encoded}`, { signal: timeoutSignal(6000) });
    const xml = await r.text();
    const items = parseRssXml(xml, limit);
    if (items.length) return items;
    throw new Error('empty');
  }
  if (proxy === 'codetabs') {
    const r = await fetch(`https://api.codetabs.com/v1/proxy?quest=${encoded}`, { signal: timeoutSignal(8000) });
    const xml = await r.text();
    const items = parseRssXml(xml, limit);
    if (items.length) return items;
    throw new Error('empty');
  }
  throw new Error('unknown proxy');
}

async function fetchFeed(feed, limitOverride) {
  const encoded = encodeURIComponent(feed.url);
  const limit = limitOverride !== undefined ? limitOverride : feedLimit(feed.url);
  const remembered = PROXY_MEM[feed.url];

  // 优先走上次成功的代理（命中率高时近乎零等待）
  if (remembered) {
    try {
      const items = await tryProxy(remembered, encoded, feed.url, limit);
      return items;
    } catch {}
  }

  // 五路竞速，第一个成功的记住代理名
  const proxies = ['rss2json', 'allorigins', 'allorigins_raw', 'corsproxy', 'codetabs'].filter(p => p !== remembered);
  try {
    return await Promise.any(proxies.map(p =>
      tryProxy(p, encoded, feed.url, limit).then(items => { saveProxyHit(feed.url, p); return items; })
    ));
  } catch {
    return [];
  }
}

function parseRssXml(xmlStr, limit = 30) {
  try {
    const xml = new DOMParser().parseFromString(xmlStr, 'text/xml');

    // RSS
    const rssItems = Array.from(xml.querySelectorAll('channel > item'));
    if (rssItems.length) {
      return rssItems.slice(0, limit).map(el => {
        const encEl = el.querySelector('enclosure');
        const mediaEl = el.getElementsByTagNameNS('*', 'content')[0]
                     || el.getElementsByTagNameNS('*', 'thumbnail')[0];
        return {
          title:       xmlText(el, 'title'),
          link:        xmlLink(el),
          description: xmlText(el, 'description') || xmlText(el, 'summary'),
          pubDate:     xmlText(el, 'pubDate') || xmlText(el, 'published'),
          thumbnail:   mediaEl?.getAttribute('url') || '',
          enclosure:   encEl ? { link: encEl.getAttribute('url'), type: encEl.getAttribute('type') } : null,
          content:     xmlNsText(el, 'encoded') || ''
        };
      });
    }

    // Atom
    const entries = Array.from(xml.querySelectorAll('feed > entry'));
    if (entries.length) {
      return entries.slice(0, limit).map(el => ({
        title:       xmlText(el, 'title'),
        link:        el.querySelector('link[rel="alternate"]')?.getAttribute('href')
                  || el.querySelector('link')?.getAttribute('href') || '',
        description: xmlText(el, 'summary') || xmlText(el, 'content'),
        pubDate:     xmlText(el, 'updated') || xmlText(el, 'published'),
        thumbnail:   '',
        enclosure:   null,
        content:     ''
      }));
    }
  } catch (_) {}
  return [];
}

function xmlText(el, tag) {
  return el.querySelector(tag)?.textContent?.trim() || '';
}
function xmlLink(el) {
  for (const c of el.children) {
    if (c.localName === 'link') return c.textContent?.trim() || c.getAttribute('href') || '';
  }
  return '';
}
function xmlNsText(el, localName) {
  for (const c of el.children) {
    if (c.localName === localName) return c.textContent?.trim() || '';
  }
  return '';
}

// ── Render ────────────────────────────────────────────
function renderTab(tab, items, feedErrors = [], aiHotData = null) {
  const main = document.getElementById('main');

  // 只在完全没有内容时才显示错误（有部分内容时静默忽略失败的源）
  const errorBanner = (feedErrors.length && !items.length)
    ? `<div class="error-pill">⚠ ${feedErrors.join('、')} 加载失败</div>`
    : '';

  const sourcePills = '来源：' + tab.feeds.map(f => f.name).join(' | ');
  const actualSources = [...new Map(items.map(item => [item._feed?.name, item._feed])).values()].filter(Boolean);
  const sourceLine = feedSourceLine(actualSources);

  // 日报：三列布局（侧边栏 | 存档列表 | 内容）
  if (tab.layout === 'daily') {
    main.classList.add('daily-mode');
    const newsHtml = aiHotData?.sections
      ? renderAiHotDaily(aiHotData)
      : `${errorBanner}${renderDailyNewspaper(items)}`;
    const dailySourceLine = feedSourceLine(Station.snapshotSources(aiHotData), 'daily-source-desktop');
    main.innerHTML = `
      <div class="daily-archive-col" id="archiveCol"></div>
      <div class="daily-content-col" id="dailyContentCol">${dailySourceLine}<div id="dailyBody">${newsHtml}</div></div>`;
    renderArchiveInCol();
    const _dkey = aiHotData?.date || new Date().toISOString().slice(0, 10);
    if (aiHotData?.sections) afterDailyPaint(aiHotData, _dkey);
    else afterNewspaperPaint(items, _dkey);
    return;
  }
  main.classList.remove('daily-mode');

  // 岗位 tab：独立布局（标题+切换栏固定，内容区单独更新）
  if (tab.layout === 'jobs') {
    const regionBar = `
      <div class="jobs-region-bar">
        <button class="jobs-region-btn${jobsRegion==='global'?' active':''}" onclick="switchJobsRegion('global')">🌐 国外</button>
        <button class="jobs-region-btn${jobsRegion!=='global'?' active':''}" onclick="switchJobsRegion('domestic')">国内</button>
      </div>`;
    // 只在首次渲染时重建整体结构，避免切换地区时抖动
    const jobsContainer = document.getElementById('jobsContent');
    if (!jobsContainer) {
      main.innerHTML = `
        <div class="section-header">
          <div class="section-title" style="display:flex;align-items:center;gap:8px"><span style="width:20px;height:20px;display:flex;align-items:center;justify-content:center;flex-shrink:0">${tab.icon}</span>${tab.name}</div>
          <div class="section-meta" id="jobsMeta">${items.length} 条 · ${nowStr()} 更新</div>
        </div>
        ${regionBar}
        <div id="jobsContent"></div>`;
    } else {
      // 更新按钮状态和计数
      main.querySelectorAll('.jobs-region-btn').forEach((btn, i) => {
        btn.classList.toggle('active', i === (jobsRegion === 'global' ? 0 : 1));
      });
      const meta = document.getElementById('jobsMeta');
      if (meta) meta.textContent = `${items.length} 条 · ${nowStr()} 更新`;
    }
    document.getElementById('jobsContent').innerHTML = renderJobsContent(items, feedErrors);
    return;
  }

  // 全部动态：双排交叉筛选 —— 左排（源）× 右排（类）
  // 全部动态：双维度分段滑块 —— 来源(全部/官方) × 分类(全部/产品/设计/视频)
  const catPillsHtml = tab.id === 'all' ? `
    <div class="cat-filter-bar">
      <div class="seg-field"><span class="seg-label">来源</span>${segHtml('segSrc', SRC_PILLS, allSrcFilter, 'switchAllSrc')}</div>
      <div class="seg-field"><span class="seg-label">分类</span>${segHtml('segCat', CAT_PILLS, allCatFilter, 'switchAllCat')}</div>
    </div>` : '';

  // 交叉筛选（兼容静态数据原始字段与实时 RSS 的 _feed）
  let displayItems = tab.id === 'all' ? filterAllItems(items) : items;

  let content = '';
  if (!displayItems.length) {
    content = `<div class="empty-state"><div class="empty-icon">📭</div><p>暂无内容，请稍后刷新</p></div>`;
  } else if (tab.layout === 'featured') {
    content = renderFeaturedTimeline(displayItems);
  } else {
    content = renderTimeline(displayItems);
  }

  const totalLabel = tab.id === 'all' && (allCatFilter !== 'all' || allSrcFilter !== 'all')
    ? `${displayItems.length} / ${items.length} 条`
    : `${items.length} 条`;

  if (tab.id === 'featured') kwBuild(items);
  const kwInline = tab.id === 'featured' ? kwHtml() : '';

  main.innerHTML = `
    <div class="section-header">
      <div>
        <div class="section-title" style="display:flex;align-items:center;gap:8px"><span style="width:20px;height:20px;display:flex;align-items:center;justify-content:center;flex-shrink:0">${tab.icon}</span>${tab.name}</div>
        ${(tab.id === 'all' || tab.id === 'featured') && tab.desc ? `<div class="section-tagline">${esc(tab.desc)}</div>` : ''}
      </div>
      <div class="section-meta">${totalLabel} · 数据更新 ${Station.formatUpdated(cache[tab.id]?.updated)}</div>
    </div>
    ${errorBanner}
    ${sourceLine}
    ${kwInline}
    ${catPillsHtml}
    ${tab.id === 'all' ? `<div id="allListWrap">${content}</div>` : content}`;
}

function feedSourceLine(feeds, extraClass = '') {
  const list = feeds || [];
  const sourceText = '来源：' + list.map(feed => feed.name).join(' | ');
  const sourceItems = list.map(feed => `
    <div class="source-popover-item">
      <span class="source-popover-dot" style="background:${esc(feed.color || '#8b949e')}"></span>
      <span>${esc(feed.name)}</span>
    </div>`).join('');
  return `<div class="source-pills feed-source-line${extraClass ? ` ${extraClass}` : ''}">
    <span class="feed-source-text">${esc(sourceText)}</span>
    <details class="source-info">
      <summary aria-label="查看全部数据源" title="查看全部数据源"><span aria-hidden="true">i</span></summary>
      <div class="source-popover">
        <div class="source-popover-title">全部数据源 · ${list.length} 个</div>
        <div class="source-popover-list">${sourceItems}</div>
      </div>
    </details>
  </div>`;
}

// ── Render: featured timeline (精选专用，富卡片) ────────
function renderFeaturedTimeline(items) {
  if (!items.length) return '<div class="empty-state"><div class="empty-icon">📭</div><p>暂无内容，请稍后刷新</p></div>';

  const byDate = {};
  items.forEach(item => {
    const d = new Date(item.pubDate || NaN);
    const key = Station.beijingDate(item.pubDate || NaN) || 'other';
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(item);
  });

  return `<div class="tl-wrap">` + Object.entries(byDate).map(([dateKey, dayItems]) => {
    const rows = dayItems.map(item => {
      const t = new Date(item.pubDate || NaN);
      const timeLabel = isNaN(t) ? '' : new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai', hour:'2-digit', minute:'2-digit',hour12:false}).format(t);
      const desc = strip(item.description || '').slice(0, 200);
      const videoInfo = getVideoInfo(item);
      const img = !videoInfo ? getImg(item) : null;
      const imgEl = img ? `<img class="feat-tl-img" src="${esc(img)}" onerror="this.remove()" alt="" loading="lazy">` : '';
      const _tags = extractTags(item);
      const _tagsHtml = _tags.length ? `<div class="card-tags">${_tags.map(t => `<span class="card-tag">${esc(t)}</span>`).join('')}</div>` : '';
      const videoEl = videoInfo ? `
        <div class="feat-video-wrap">
          ${videoInfo.thumb
            ? `<img src="${esc(videoInfo.thumb)}" onerror="this.closest('.feat-video-wrap').remove()" alt="" loading="lazy">`
            : `<div style="height:90px;background:var(--border);display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px">视频</div>`
          }
          <div class="feat-video-play">
            <svg viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>
          </div>
          <span class="feat-video-badge">${videoInfo.source}</span>
        </div>` : '';
      return `
        <div class="dnp-row">
          <div class="dnp-time">
            <span class="dnp-time-label">${timeLabel}</span>
            <span class="dnp-time-dot"></span>
          </div>
          <a class="card feat-tl-card" href="${esc(Station.safeURL(videoInfo?.videoUrl || item.link || '#') || '#')}" target="_blank" rel="noopener">
            <div class="card-body">
              <div class="card-source">
                <span class="src-dot" style="background:${item._feed?.color||'#8b949e'}"></span>
                ${esc(item._feed?.name || '')}
                <span>·</span>
                ${timeAgo(item.pubDate)}
                <span class="badge badge-featured">精选</span>
              </div>
              <div class="feat-tl-title">${renderTitle(item)}</div>
              ${desc ? `<div class="feat-tl-desc">${esc(desc)}</div>` : ''}
              ${videoEl}
              ${imgEl}
              ${_tagsHtml}
              ${item.selectionReason ? `<div class="rec-tip"><span class="rec-tip-label">入选依据</span><span class="rec-tip-text">${esc(item.selectionReason)}</span></div>` : ''}
            </div>
          </a>
        </div>`;
    }).join('');
    return `
      <div class="tl-group">
        <div class="tl-date-divider">
          <span class="tl-date-label">${fmtDate(dateKey)}</span>
          <span class="tl-date-count">${dayItems.length} 条</span>
          <span class="tl-date-line"></span>
        </div>
        <div class="dnp-card-list">${rows}</div>
      </div>`;
  }).join('') + `</div>`;
}

// ── Render: timeline (所有非日报频道) ─────────────────
function renderTimeline(items) {
  if (!items.length) return '<div class="empty-state"><div class="empty-icon">📭</div><p>暂无内容，请稍后刷新</p></div>';

  // 按日期分组
  const byDate = {};
  items.forEach(item => {
    const d = new Date(item.pubDate || NaN);
    const key = Station.beijingDate(item.pubDate || NaN) || 'other';
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(item);
  });

  return `<div class="tl-wrap">` + Object.entries(byDate).map(([dateKey, dayItems]) => {
    const rows = dayItems.map(item => {
      const t = new Date(item.pubDate || NaN);
      const timeLabel = isNaN(t) ? '' : new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai', hour:'2-digit', minute:'2-digit',hour12:false}).format(t);
      return `
        <div class="dnp-row">
          <div class="dnp-time">
            <span class="dnp-time-label">${timeLabel}</span>
            <span class="dnp-time-dot"></span>
          </div>
          ${cardHtml(item)}
        </div>`;
    }).join('');
    return `
      <div class="tl-group">
        <div class="tl-date-divider">
          <span class="tl-date-label">${fmtDate(dateKey)}</span>
          <span class="tl-date-count">${dayItems.length} 条</span>
          <span class="tl-date-line"></span>
        </div>
        <div class="dnp-card-list">${rows}</div>
      </div>`;
  }).join('') + `</div>`;
}

// ── Render: AI HOT daily (structured sections) ────────
function renderAiHotDaily(data) {
  const { date, sections = [] } = data;
  const now = new Date(date + 'T12:00:00+08:00');
  const ZH = '〇一二三四五六七八九';
  const toZh = n => String(n).split('').map(d => ZH[+d]).join('');
  const WEEKS = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
  const zhDate = `${toZh(now.getFullYear())}年${toZh(now.getMonth()+1)}月${toZh(now.getDate())}日`;
  const vol = `VOL ${date || `${now.getFullYear()}.${pad(now.getMonth()+1)}.${pad(now.getDate())}`}`;
  const total = sections.reduce((s, sec) => s + (sec.items?.length || 0), 0);

  let num = 0;
  const sectionsHtml = sections.map(sec => {
    if (!sec.items?.length) return '';
    num++;
    const rows = sec.items.map(item => {
      const _tags = extractTags(item);
      const _tagsHtml = _tags.length ? `<div class="card-tags">${_tags.map(t => `<span class="card-tag">${esc(t)}</span>`).join('')}</div>` : '';
      return `
      <div class="dnp-row">
        <div class="dnp-time">
          <span class="dnp-time-label"></span>
          <span class="dnp-time-dot"></span>
        </div>
        <a class="card" href="${esc(Station.safeURL(item.sourceUrl) || '#')}" target="_blank" rel="noopener">
          <div class="card-body">
            <div class="card-source">
              <span class="src-dot" style="background:#58a6ff"></span>
              ${esc(item.sourceName||'来源未标注')}
            </div>
            <div class="card-title">${renderTitle(item)}</div>
            <div class="card-desc">${esc((item.summary||'').slice(0,180))}</div>
            ${_tagsHtml}
          </div>
        </a>
      </div>`;
    }).join('');
    return `
      <div class="dnp-section">
        <div class="dnp-section-head">
          <span class="dnp-num">${pad(num)}</span>
          <div class="dnp-cat-labels">
            <h2 class="dnp-cat-zh">${esc(sec.label)}</h2>
          </div>
          <span class="dnp-cat-count">${sec.items.length} 条</span>
        </div>
        <div class="dnp-card-list">${rows}</div>
      </div>`;
  }).join('');

  return `
    <div class="dnp-hero">
      <h1 class="dnp-title">AI <span>日报速览</span></h1>
      <div class="dnp-dateline">
        <span>${Station.formatDate(date)}</span>
        <span class="dnp-dateline-sep">｜</span>
        <span class="dnp-summary">${total} 条 · 自动整理</span>
        <span class="dnp-actions">
          <a class="dnp-tag share-poster" href="daily-share/?date=${date}" target="_blank" rel="noopener" style="text-decoration:none;cursor:pointer;" title="打开适合朋友圈和小红书的日报长图版">分享长图</a>
          ${STATIC_DAILY_DATES.has(date) ? `<a class="dnp-tag" href="daily/${date}.html" target="_blank" rel="noopener" style="text-decoration:none;cursor:pointer;" title="本期固定网址，秒开、可转发分享">分享网页版</a>` : ''}
        </span>
      </div>
    </div>
    ${feedSourceLine(Station.snapshotSources(data), 'daily-source-mobile')}
    ${sectionsHtml||'<div class="empty-state"><div class="empty-icon">📭</div><p>暂无内容</p></div>'}`;
}

// ── Categories ────────────────────────────────────────
const CATEGORIES = [
  { key: '模型发布', en: 'MODEL RELEASES',
    test: t => /模型|大模型|llm|gpt|claude|gemini|grok|llama|deepseek|minimax|kimi|文心|通义|spark|mistral|qwen|发布.*版|更新.*版/i.test(t) },
  { key: '工具产品', en: 'TOOLS & PRODUCTS',
    test: t => /工具|应用|产品|上线|功能|插件|api|plugin|app|tool|feature|launch/i.test(t) },
  { key: '研究前沿', en: 'RESEARCH',
    test: t => /研究|论文|实验|发现|技术|突破|进展|学术|paper|research|study|benchmark/i.test(t) },
  { key: '商业动态', en: 'BUSINESS',
    test: t => /融资|投资|收购|估值|上市|财报|营收|合作|战略|funding|invest|acqui|billion|million/i.test(t) },
  { key: '行业动态', en: 'INDUSTRY', test: () => true },
];

// ── Render: daily newspaper ────────────────────────
function renderDailyNewspaper(items) {
  if (!items.length) return '<div class="empty-state"><div class="empty-icon">📭</div><p>暂无内容</p></div>';

  const now = new Date();
  const date = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const ZH = '〇一二三四五六七八九';
  const toZh = n => String(n).split('').map(d => ZH[+d]).join('');
  const WEEKS = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
  const zhDate = `${toZh(now.getFullYear())}年${toZh(now.getMonth()+1)}月${toZh(now.getDate())}日`;
  const vol = `VOL ${now.getFullYear()}.${pad(now.getMonth()+1)}.${pad(now.getDate())}`;

  // Categorize
  const buckets = {};
  CATEGORIES.forEach(c => buckets[c.key] = []);
  items.forEach(item => {
    const text = (item.title || '') + ' ' + (item.description || '');
    for (const cat of CATEGORIES) {
      if (cat.test(text)) { buckets[cat.key].push(item); break; }
    }
  });

  let num = 0;
  const sectionsHtml = CATEGORIES.map(cat => {
    const list = buckets[cat.key];
    if (!list.length) return '';
    num++;
    const rows = list.map((item, idx, arr) => {
      const t = new Date(item.pubDate || NaN);
      const timeLabel = isNaN(t) ? '' : new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai', hour:'2-digit', minute:'2-digit',hour12:false}).format(t);
      return `
        <div class="dnp-row">
          <div class="dnp-time">
            <span class="dnp-time-label">${timeLabel}</span>
            <span class="dnp-time-dot"></span>
          </div>
          ${cardHtml(item)}
        </div>`;
    }).join('');
    return `
      <div class="dnp-section">
        <div class="dnp-section-head">
          <span class="dnp-num">${pad(num)}</span>
          <div class="dnp-cat-labels">
            <span class="dnp-cat-zh">${cat.key}</span>
            <span class="dnp-cat-en">${cat.en}</span>
          </div>
          <span class="dnp-cat-count">${list.length} 条</span>
        </div>
        <div class="dnp-card-list">${rows}</div>
      </div>`;
  }).join('');

  return `
    <div class="dnp-hero">
      <div class="dnp-title">AI <span>日报速览</span></div>
      <div class="dnp-dateline">
        <span>${zhDate} ${WEEKS[now.getDay()]}</span>
        <span class="dnp-dateline-sep">｜</span>
        <span class="dnp-summary">${items.length} 条 · 2 分钟读懂今天的 AI</span>
        <span class="dnp-actions">
          <a class="dnp-tag share-poster" href="daily-share/?date=${date}" target="_blank" rel="noopener" style="text-decoration:none;cursor:pointer;" title="打开适合朋友圈和小红书的日报长图版">分享长图</a>
        </span>
      </div>
    </div>
    ${feedSourceLine(SHARED_FEEDS, 'daily-source-mobile')}
    ${sectionsHtml}`;
}

// ── Render: jobs ──────────────────────────────────────
function renderJobsContent(items, feedErrors) {
  if (jobsRegion !== 'global') {
    return items.length
      ? `<div class="jobs-section-title">拉勾 · 在招岗位</div><div class="card-list">${renderJobs(items)}</div>
         <div class="jobs-section-title" style="margin-top:24px">搜索更多</div>
         ${renderDomesticJobLinks()}`
      : `<div class="jobs-domestic-hint">⏳ 正在拉取拉勾岗位数据，如无法加载可直接搜索</div>${renderDomesticJobLinks()}`;
  }

  // 国外：WWR 真实岗位卡片
  return items.length
    ? `<div class="card-list">${items.slice(0, 50).map(item => {
        const raw = item.title || '';
        const m = raw.match(/^(.+?)[\:\-–]\s*(.+)$/);
        const company = m ? m[1].trim() : '';
        const jobTitle = m ? m[2].replace(/\[.*?\]/g, '').trim() : raw;
        const desc = strip(item.description || '').slice(0, 200);
        return `
          <a class="job-card" href="${esc(Station.safeURL(item.link || '#') || '#')}" target="_blank" rel="noopener">
            <div class="job-title">${esc(jobTitle)}</div>
            <div class="job-meta">
              ${company ? `<span>🏢 ${esc(company)}</span>` : ''}
              <span>
                <span class="src-dot" style="background:${item._feed?.color||'#8b949e'};width:5px;height:5px;border-radius:50%;display:inline-block"></span>
                ${esc(item._feed?.name || '')}
              </span>
              <span>${timeAgo(item.pubDate)}</span>
              <span class="badge badge-job">招聘中</span>
            </div>
            ${desc ? `<div class="job-desc">${esc(desc)}</div>` : ''}
          </a>`;
      }).join('')}</div>`
    : `<div class="empty-state"><div class="empty-icon" style="font-size:28px">💼</div><p>岗位加载中…</p></div>`;
}

function renderDomesticJobLinks() {
  const links = [
    { kw: 'AI产品经理', url: 'https://www.zhipin.com/web/geek/job?query=AI%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86', platform: 'BOSS直聘' },
    { kw: 'AI产品设计师', url: 'https://www.zhipin.com/web/geek/job?query=AI%E4%BA%A7%E5%93%81%E8%AE%BE%E8%AE%A1', platform: 'BOSS直聘' },
    { kw: 'AI交互设计', url: 'https://www.zhipin.com/web/geek/job?query=AI%E4%BA%A4%E4%BA%92%E8%AE%BE%E8%AE%A1', platform: 'BOSS直聘' },
    { kw: 'AI产品经理', url: 'https://www.lagou.com/wn/jobs?kd=AI%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86', platform: '拉勾' },
    { kw: 'AI设计师', url: 'https://www.lagou.com/wn/jobs?kd=AI%E8%AE%BE%E8%AE%A1%E5%B8%88', platform: '拉勾' },
    { kw: 'AI产品', url: 'https://www.liepin.com/zhaopin/?key=AI%E4%BA%A7%E5%93%81', platform: '猎聘' },
  ];
  return `
    <div class="jobs-domestic-hint">搜索直达 · 点击跳转各平台对应职位</div>
    <div class="jobs-search-links">
      ${links.map(l => `
        <a href="${l.url}" target="_blank" rel="noopener" class="jobs-search-link">
          <span class="src-dot" style="background:var(--accent);width:6px;height:6px;border-radius:50%;flex-shrink:0"></span>
          <span class="jobs-search-keyword">${l.kw}</span>
          <span class="jobs-search-platform">${l.platform}</span>
        </a>`).join('')}
    </div>`;
}

async function switchJobsRegion(region) {
  if (jobsRegion === region) return;
  jobsRegion = region;

  // 更新按钮状态，内容区显示加载中
  document.querySelectorAll('.jobs-region-btn').forEach((btn, i) => {
    btn.classList.toggle('active', i === (region === 'global' ? 0 : 1));
  });
  const contentEl = document.getElementById('jobsContent');
  if (contentEl) contentEl.innerHTML = `<div class="empty-state"><div class="empty-icon" style="font-size:28px">💼</div><p>加载中…</p></div>`;

  // 读缓存或重新拉取
  const cacheKey = `jobs_${region}`;
  const cached = cache[cacheKey];
  const tab = TABS.find(t => t.id === 'jobs');
  if (cached && Date.now() - cached.ts < REFRESH_INTERVAL) {
    if (contentEl) contentEl.innerHTML = renderJobsContent(cached.items, cached.feedErrors || []);
    const meta = document.getElementById('jobsMeta');
    if (meta) meta.textContent = `${cached.items.length} 条 · ${nowStr()} 更新`;
    return;
  }

  // 重新拉取该地区数据
  const feedList = region === 'global' ? (tab?.feedsGlobal || []) : (tab?.feedsDomestic || []);
  const results = await Promise.allSettled(feedList.map(f => fetchFeed(f)));
  let items = [];
  const feedErrors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.length)
      items = items.concat(r.value.map(item => ({ ...item, _feed: feedList[i] })));
    else feedErrors.push(feedList[i]?.name || '');
  });
  items = mergeItems(items, tab);
  cache[cacheKey] = { items, feedErrors, aiHotData: null, ts: Date.now() };
  if (contentEl) contentEl.innerHTML = renderJobsContent(items, feedErrors);
  const meta = document.getElementById('jobsMeta');
  if (meta) meta.textContent = `${items.length} 条 · ${nowStr()} 更新`;
}

// 全部动态双维度筛选：来源(全部/官方) × 分类(全部/产品/设计/视频)
const SRC_PILLS = [{ label: '全部', val: 'all' }, { label: '官方', val: 'official' }];
const CAT_PILLS = [{ label: '全部', val: 'all' }, { label: '产品', val: 'ai-products' }, { label: '设计', val: 'design' }, { label: '视频', val: 'video' }];

// 分段滑块 HTML：等宽选项 + 一个可滑动的 thumb（初始 transform 内联，切换时原地移动即产生滑动动画）
function segHtml(id, pills, active, fn) {
  const idx = Math.max(0, pills.findIndex(p => p.val === active));
  return `<div class="seg" id="${id}">
    <span class="seg-thumb" style="width:calc((100% - 6px) / ${pills.length});transform:translateX(${idx * 100}%)"></span>
    ${pills.map(p => `<button class="seg-opt${p.val === active ? ' on' : ''}" aria-pressed="${p.val === active}" data-val="${p.val}" onclick="${fn}('${p.val}')">${p.label}</button>`).join('')}
  </div>`;
}

function filterAllItems(items) {
  const isOfficial = i => i.official === true || i._feed?.official === true;
  const isVideo = i => i.category === 'video' || i._aiCat === 'video'
    || /youtube\.com/.test(i._feed?.url || '') || /youtube\.com/.test(i.link || '');
  return items.filter(i => {
    const srcOk = allSrcFilter === 'all' || (allSrcFilter === 'official' && isOfficial(i));
    let catOk = true;
    if (allCatFilter === 'video') catOk = isVideo(i);
    else if (allCatFilter !== 'all') catOk = i._aiCat === allCatFilter;
    return srcOk && catOk;
  });
}

// 移动分段滑块 + 切换高亮（原地，不重建）
function moveSeg(segId, pills, val) {
  const seg = document.getElementById(segId);
  if (!seg) return;
  const idx = Math.max(0, pills.findIndex(p => p.val === val));
  const thumb = seg.querySelector('.seg-thumb');
  if (thumb) thumb.style.transform = `translateX(${idx * 100}%)`;
  seg.querySelectorAll('.seg-opt').forEach(b => { b.classList.toggle('on', b.dataset.val === val); b.setAttribute('aria-pressed', b.dataset.val === val); });
}

// 原地重筛：只更新列表与计数，保留分段滑块以产生滑动动画
function refilterAll() {
  const cached = cache['all'];
  const wrap = document.getElementById('allListWrap');
  const tab = TABS.find(t => t.id === 'all');
  if (!cached || !wrap || !tab) { if (tab && cached) renderTab(tab, cached.items, cached.feedErrors || [], cached.aiHotData); return; }
  cached.items.forEach(autoCat);
  const displayItems = filterAllItems(cached.items);
  wrap.innerHTML = displayItems.length ? renderTimeline(displayItems)
    : '<div class="empty-state"><div class="empty-icon">📭</div><p>暂无内容，请稍后刷新</p></div>';
  const meta = document.querySelector('.section-meta');
  if (meta) {
    const label = (allCatFilter !== 'all' || allSrcFilter !== 'all') ? `${displayItems.length} / ${cached.items.length} 条` : `${cached.items.length} 条`;
    meta.textContent = `${label} · 数据更新 ${Station.formatUpdated(cached.updated)}`;
  }
  applyReadState();
}

function switchAllCat(cat) {
  if (allCatFilter === cat) return;
  allCatFilter = cat;
  updateRoute({category:cat === 'all' ? null : cat}, true);
  moveSeg('segCat', CAT_PILLS, cat);
  refilterAll();
}

function switchAllSrc(src) {
  if (allSrcFilter === src) return;
  allSrcFilter = src;
  updateRoute({source:src === 'all' ? null : src}, true);
  moveSeg('segSrc', SRC_PILLS, src);
  refilterAll();
}

function renderJobs(items) {
  if (!items.length) return '<div class="empty-state"><div class="empty-icon">💼</div><p>暂无岗位信息</p></div>';
  return items.slice(0, 40).map(item => `
    <a class="job-card" href="${esc(Station.safeURL(item.link || '#') || '#')}" target="_blank" rel="noopener">
      <div class="job-title">${renderTitle(item)}</div>
      <div class="job-meta">
        <span>
          <span class="src-dot" style="background:${item._feed?.color||'#8b949e'};width:5px;height:5px;border-radius:50%;display:inline-block"></span>
          ${esc(item._feed?.name || '')}
        </span>
        <span>${timeAgo(item.pubDate)}</span>
        <span class="badge badge-job">岗位</span>
      </div>
      <div class="job-desc">${strip(item.description || item.content || '').slice(0,300)}</div>
    </a>`).join('');
}

// ── Featured card (带推荐理由) ─────────────────────────
function featCardHtml(item) {
  const videoInfo = getVideoInfo(item);
  const img = !videoInfo ? getImg(item) : null;
  const videoEl = videoInfo ? `
    <div class="feat-video-wrap">
      ${videoInfo.thumb
        ? `<img src="${esc(videoInfo.thumb)}" onerror="this.closest('.feat-video-wrap').remove()" alt="" loading="lazy">`
        : `<div style="height:90px;background:var(--border);display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px">视频</div>`
      }
      <div class="feat-video-play"><svg viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg></div>
      <span class="feat-video-badge">${videoInfo.source}</span>
    </div>` : '';
  const imgEl = img ? `<img class="feat-tl-img" src="${esc(img)}" onerror="this.remove()" alt="" loading="lazy">` : '';
  const desc = strip(item.description || '').slice(0, 120);
  const tags = extractTags(item);
  const tagsHtml = tags.length ? `<div class="card-tags">${tags.map(t => `<span class="card-tag">${esc(t)}</span>`).join('')}</div>` : '';
  return `
    <a class="card" href="${esc(Station.safeURL(videoInfo?.videoUrl || item.link || '#') || '#')}" target="_blank" rel="noopener">
      <div class="card-body">
        <div class="card-source">
          <span class="src-dot" style="background:${item._feed?.color||'#8b949e'}"></span>
          ${esc(item._feed?.name || '')}
          <span>·</span>
          ${timeAgo(item.pubDate)}
          <span class="badge badge-featured">精选</span>
        </div>
        <div class="card-title">${renderTitle(item)}</div>
        ${desc ? `<div class="card-desc">${esc(desc)}</div>` : ''}
        ${videoEl}
        ${imgEl}
        ${tagsHtml}
        <div class="rec-tip">
          <span class="rec-tip-label">💡 推荐理由</span>
          <span class="rec-tip-text">${genRecReason(item)}</span>
        </div>
      </div>
    </a>`;
}

// ── Card HTML ─────────────────────────────────────────
function cardHtml(item, badgeClass = '') {
  const videoInfo = getVideoInfo(item);
  const img = !videoInfo ? getImg(item) : null;
  let thumbEl = '';
  if (videoInfo && videoInfo.thumb) {
    thumbEl = `<div class="card-video-thumb">
        <img src="${esc(videoInfo.thumb)}" onerror="this.closest('.card-video-thumb').remove()" alt="" loading="lazy">
        <div class="card-video-play"><svg viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg></div>
      </div>`;
  } else if (img) {
    thumbEl = `<img class="card-thumb" src="${esc(img)}" onerror="this.remove()" alt="" loading="lazy">`;
  }
  const desc = strip(item.description || '').slice(0, 180);
  const tags = extractTags(item);
  const tagsHtml = tags.length ? `<div class="card-tags">${tags.map(t => `<span class="card-tag">${esc(t)}</span>`).join('')}</div>` : '';
  return `
    <a class="card" href="${esc(Station.safeURL(videoInfo?.videoUrl || item.link || '#') || '#')}" target="_blank" rel="noopener">
      <div class="card-body">
        <div class="card-source">
          <span class="src-dot" style="background:${item._feed?.color||'#8b949e'}"></span>
          ${esc(item._feed?.name || '')}
          <span>·</span>
          ${timeAgo(item.pubDate)}
          ${badgeClass ? `<span class="badge ${badgeClass}">${badgeLabel(badgeClass)}</span>` : ''}
        </div>
        <div class="card-title">${renderTitle(item)}</div>
        ${desc
          ? `<div class="card-desc">${esc(desc)}</div>`
          : `<div class="card-desc card-desc-empty">阅读原文 →</div>`}
        ${tagsHtml}
      </div>
      ${thumbEl}
    </a>`;
}

function badgeLabel(cls) {
  if (cls === 'badge-featured') return '精选';
  if (cls === 'badge-design')   return '设计';
  if (cls === 'badge-job')      return '岗位';
  return '';
}

// ── Loading state ─────────────────────────────────────
function showLoading() {
  document.getElementById('main').innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <span style="color:var(--muted);font-size:13px">正在拉取最新资讯...</span>
    </div>`;
}

// ── Auto refresh ──────────────────────────────────────
function isUpdateHour() {
  const h = new Date().getHours();
  return h >= 8 && h < 22;
}

function scheduleAutoRefresh() {
  clearInterval(refreshTimer);
  clearInterval(countdownTimer);

  function scheduleNext() {
    clearInterval(refreshTimer);
    if (!isUpdateHour()) {
      nextRefreshAt = 0;
      // 计算距明天 8:00 的毫秒数
      const now = new Date();
      const next8 = new Date(now);
      next8.setHours(8, 0, 0, 0);
      if (next8 <= now) next8.setDate(next8.getDate() + 1);
      refreshTimer = setTimeout(() => {
        switchTab(activeTab, {force:true, history:false});
        scheduleAutoRefresh();
      }, next8.getTime() - now.getTime());
      return;
    }
    nextRefreshAt = Date.now() + REFRESH_INTERVAL;
    refreshTimer = setInterval(() => {
      if (!isUpdateHour()) { scheduleNext(); return; }
      switchTab(activeTab, {force:true, history:false});
      nextRefreshAt = Date.now() + REFRESH_INTERVAL;
    }, REFRESH_INTERVAL);
  }

  scheduleNext();

  countdownTimer = setInterval(() => {
    const el = document.getElementById('countdown');
    if (!el) return;
    if (!isUpdateHour()) { el.textContent = '休眠'; return; }
    const left = Math.max(0, nextRefreshAt - Date.now());
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    el.textContent = `${m}:${pad(s)}`;
  }, 1000);
}

function manualRefresh() {
  const btn = document.getElementById('refreshBtn');
  const mobBtn = document.querySelector('.mobile-refresh-btn');
  if (btn) { btn.classList.add('loading'); btn.textContent = '刷新中…'; }
  if (mobBtn) { mobBtn.style.opacity = '0.4'; mobBtn.style.pointerEvents = 'none'; }
  switchTab(activeTab, {force:true, history:false}).finally(() => {
    if (btn) {
      btn.classList.remove('loading');
      btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
      </svg> 立即刷新`;
    }
    if (mobBtn) { mobBtn.style.opacity = ''; mobBtn.style.pointerEvents = ''; }
    if (isUpdateHour()) nextRefreshAt = Date.now() + REFRESH_INTERVAL;
  });
}

// ── Utils ─────────────────────────────────────────────
function getImg(item) {
  return item.thumbnail
    || (item.enclosure?.type?.startsWith('image/') ? item.enclosure.link : null)
    || null;
}

// 检测条目是否含视频，返回 { thumb, videoUrl, source } 或 null
function getVideoInfo(item) {
  const link = item.link || '';
  const desc  = item.description || '';

  // YouTube 主链接
  const ytLink = link.match(/(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (ytLink) {
    return { thumb: `https://img.youtube.com/vi/${ytLink[1]}/hqdefault.jpg`, videoUrl: link, source: 'YouTube' };
  }
  // YouTube 嵌入（在 description 里）
  const ytDesc = desc.match(/youtube\.com\/(?:embed|watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})|youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (ytDesc) {
    const vid = ytDesc[1] || ytDesc[2];
    return { thumb: `https://img.youtube.com/vi/${vid}/hqdefault.jpg`, videoUrl: `https://youtube.com/watch?v=${vid}`, source: 'YouTube' };
  }
  // B站
  const bvLink = link.match(/bilibili\.com\/video\/(BV[A-Za-z0-9]+|av\d+)/i);
  if (bvLink) {
    return { thumb: null, videoUrl: link, source: 'B站' };
  }
  // video enclosure（RSS 附件为视频）
  if (item.enclosure?.type?.startsWith('video/') && item.enclosure?.link) {
    return { thumb: item.thumbnail || null, videoUrl: item.enclosure.link, source: 'VIDEO' };
  }
  return null;
}

function esc(s) {
  return Station.escapeHTML(s);
}

function strip(html) {
  return String(html || '').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
}

function pad(n) { return String(n).padStart(2,'0'); }

function timeAgo(dateStr) {
  if (!dateStr || !Number.isFinite(Date.parse(dateStr))) return '日期未标注';
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return '刚刚';
  const m = Math.floor(diff / 60000);
  if (m < 1)  return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 7)  return `${d} 天前`;
  return fmtDate(dateStr.slice(0, 10));
}

function fmtDate(dateStr) {
  if (dateStr === 'other') return '日期未标注';
  const parts = dateStr.split('-');
  if (parts.length < 3) return dateStr;
  const d = new Date(dateStr);
  const today = new Date(); today.setHours(0,0,0,0);
  const target = new Date(dateStr); target.setHours(0,0,0,0);
  const diff = Math.round((today - target) / 86400000);
  if (diff === 0) return '今日';
  if (diff === 1) return '昨日';
  if (diff === 2) return '前日';
  return `${parseInt(parts[1])} 月 ${parseInt(parts[2])} 日`;
}

function nowStr() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── 回到顶部 ─────────────────────────────────────────
function scrollBackToTop() {
  const scroller = window.innerWidth <= 768 ? window : document.getElementById('dailyContentCol') || document.getElementById('main');
  scroller.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

// ── 已读状态 ─────────────────────────────────────────
const LS_READ_KEY = 'ai_station_read_v1';
const readLinks = (() => {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_READ_KEY) || '[]');
    return new Set(arr);
  } catch { return new Set(); }
})();

function markAsRead(link) {
  if (!link || link === '#') return;
  readLinks.add(link);
  const trimmed = [...readLinks].slice(-500);
  try { localStorage.setItem(LS_READ_KEY, JSON.stringify(trimmed)); } catch {}
  const escaped = window.CSS && typeof CSS.escape === 'function'
    ? CSS.escape(link)
    : String(link).replace(/["\\]/g, '\\$&');
  document.querySelectorAll(`a.card[href="${escaped}"]`).forEach(el => el.classList.add('is-read'));
}

function applyReadState() {
  document.querySelectorAll('a.card[href]').forEach(el => {
    const href = el.getAttribute('href');
    if (href && readLinks.has(href)) el.classList.add('is-read');
    if (!el._readBound) {
      el.addEventListener('click', () => markAsRead(href));
      el._readBound = true;
    }
  });
}

function shouldFallbackOpenOnMobile(anchor) {
  if (!IS_MOBILE || !anchor || anchor.target !== '_blank') return false;
  const href = anchor.getAttribute('href') || '';
  return !!href && href !== '#' && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:');
}

function openMobileLink(anchor) {
  const opened = window.open(anchor.href, '_blank');
  if (opened) {
    try { opened.opener = null; } catch {}
  } else {
    window.location.href = anchor.href;
  }
}

document.addEventListener('click', event => {
  const anchor = event.target.closest?.('a[href]');
  if (!shouldFallbackOpenOnMobile(anchor) || event.defaultPrevented) return;
  event.preventDefault();
  markAsRead(anchor.getAttribute('href'));
  openMobileLink(anchor);
});

const _origRenderTab = renderTab;
renderTab = function(...args) {
  _origRenderTab.apply(this, args);
  requestAnimationFrame(applyReadState);
};
const _origRenderBuilders = renderBuilders;
renderBuilders = function(...args) {
  _origRenderBuilders.apply(this, args);
  requestAnimationFrame(applyReadState);
};

// 回到顶部按钮滚动监听（在 init 前注册）
document.addEventListener('DOMContentLoaded', () => {
  const btt = document.getElementById('backToTop');
  function checkScroll() {
    const mainEl = document.getElementById('dailyContentCol') || document.getElementById('main');
    const scrollY = window.innerWidth <= 768 ? window.scrollY : (mainEl?.scrollTop || 0);
    btt?.classList.toggle('visible', scrollY > 400);
  }
  document.getElementById('main')?.addEventListener('scroll', checkScroll, { passive: true, capture: true });
  window.addEventListener('scroll', checkScroll, { passive: true });
});

new MutationObserver(() => {
  const main = document.getElementById('main');
  main.querySelectorAll('div.section-title,div.tool-cat-title').forEach(node => {
    const heading = document.createElement(node.classList.contains('section-title') ? 'h1' : 'h2');
    for (const attribute of node.attributes) heading.setAttribute(attribute.name, attribute.value);
    heading.append(...node.childNodes);
    node.replaceWith(heading);
  });
}).observe(document.getElementById('main'), {childList:true, subtree:true});
init();
