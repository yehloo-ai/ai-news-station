// 拉取 Umami 与百度统计数据，生成 data/stats.json 供 admin.html 渲染
// 密钥通过环境变量传入（GitHub Secrets）：UMAMI_SHARE_ID、BAIDU_API_KEY、BAIDU_SECRET_KEY、BAIDU_REFRESH_TOKEN
// Umami 走分享链接的只读接口（免费版没有 API key）：先用 share id 换临时 token，再带
// x-umami-share-token + x-umami-share-context 两个头访问数据接口

import { writeFileSync, mkdirSync } from 'node:fs';

const UMAMI_GATEWAY = 'https://gateway-us.umami.is/api';
const SITE_DOMAIN = 'yehloo-ai.github.io';
const DAYS = 30;

// 北京时间固定 UTC+8，无夏令时
function dayStartMs(offsetDays = 0) {
  const sh = new Date(Date.now() + 8 * 3600e3);
  const start = Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate()) - 8 * 3600e3;
  return start + offsetDays * 86400e3;
}

function ymd(ms) {
  return new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('?')[0]}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function fetchUmami() {
  const shareId = process.env.UMAMI_SHARE_ID;
  if (!shareId) return { error: '未配置 UMAMI_SHARE_ID' };
  const share = await getJson(`${UMAMI_GATEWAY}/share/${shareId}`);
  if (!share.token) throw new Error('Umami 分享 token 获取失败，检查分享链接是否被删除');
  const headers = { 'x-umami-share-token': share.token, 'x-umami-share-context': '1' };
  const api = (path, params) =>
    getJson(`${UMAMI_GATEWAY}/websites/${share.websiteId}${path}?${new URLSearchParams(params)}`, headers);

  const now = Date.now();
  const rangeStart = dayStartMs(-(DAYS - 1));
  const range = { startAt: rangeStart, endAt: now };

  const [statsToday, stats30d, pageviews, countries, referrers] = await Promise.all([
    api('/stats', { startAt: dayStartMs(0), endAt: now }),
    api('/stats', range),
    api('/pageviews', { ...range, unit: 'day', timezone: 'Asia/Shanghai' }),
    api('/metrics', { ...range, type: 'country', limit: 15 }),
    api('/metrics', { ...range, type: 'referrer', limit: 15 }),
  ]);

  // /stats 的字段在不同版本里可能是数字或 {value}，统一取值
  const num = (v) => (v && typeof v === 'object' ? v.value : v) ?? 0;

  // 合并 pageviews/sessions 两条序列，按天补零
  const byDate = {};
  for (let i = 0; i < DAYS; i++) byDate[ymd(dayStartMs(-(DAYS - 1 - i)))] = { pageviews: 0, visitors: 0 };
  for (const p of pageviews.pageviews ?? []) {
    const d = String(p.x).slice(0, 10);
    if (byDate[d]) byDate[d].pageviews = p.y;
  }
  for (const s of pageviews.sessions ?? []) {
    const d = String(s.x).slice(0, 10);
    if (byDate[d]) byDate[d].visitors = s.y;
  }

  return {
    error: null,
    today: { visitors: num(statsToday.visitors), pageviews: num(statsToday.pageviews) },
    last30d: { visitors: num(stats30d.visitors), pageviews: num(stats30d.pageviews), visits: num(stats30d.visits) },
    series: Object.entries(byDate).map(([date, v]) => ({ date, ...v })),
    countries: (countries ?? []).map((c) => ({ code: c.x || '未知', visitors: c.y })),
    referrers: (referrers ?? []).map((r) => ({ domain: r.x || '直接访问', visitors: r.y })),
  };
}

async function fetchBaidu() {
  const ak = process.env.BAIDU_API_KEY;
  const sk = process.env.BAIDU_SECRET_KEY;
  const rt = process.env.BAIDU_REFRESH_TOKEN;
  if (!ak || !sk || !rt) return { error: '未配置百度统计密钥' };

  const token = await getJson(
    `https://openapi.baidu.com/oauth/2.0/token?${new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: rt, client_id: ak, client_secret: sk,
    })}`
  );
  if (!token.access_token) throw new Error(`百度 token 刷新失败: ${JSON.stringify(token).slice(0, 200)}`);

  const sites = await getJson(
    `https://openapi.baidu.com/rest/2.0/tongji/config/getSiteList?access_token=${token.access_token}`
  );
  const list = sites?.list ?? [];
  const site = list.find((s) => (s.domain || '').includes(SITE_DOMAIN)) ?? list[0];
  if (!site) throw new Error('百度统计账号下没有找到站点');

  const report = (method, extra = {}) =>
    getJson(
      `https://openapi.baidu.com/rest/2.0/tongji/report/getData?${new URLSearchParams({
        access_token: token.access_token,
        site_id: site.site_id,
        method,
        start_date: ymd(dayStartMs(-(DAYS - 1))).replaceAll('-', ''),
        end_date: ymd(dayStartMs(0)).replaceAll('-', ''),
        metrics: 'pv_count,visitor_count',
        ...extra,
      })}`
    );

  const [trend, sources] = await Promise.all([
    report('overview/getTimeTrendRpt'),
    report('source/all/a', { viewType: 'type' }),
  ]);

  const toNum = (v) => (v === '--' || v == null ? 0 : Number(v));
  const parseItems = (rpt) => rpt?.body?.data?.[0]?.result?.items ?? [[], []];

  const [trendKeys, trendVals] = parseItems(trend);
  const series = trendKeys.map((k, i) => ({
    date: String(Array.isArray(k) ? k[0] : k).replaceAll('/', '-'),
    pageviews: toNum(trendVals[i]?.[0]),
    visitors: toNum(trendVals[i]?.[1]),
  }));

  const [srcKeys, srcVals] = parseItems(sources);
  const sourceTypes = srcKeys.map((k, i) => {
    const item = Array.isArray(k) ? k[0] : k;
    return {
      name: typeof item === 'object' ? item.name : String(item),
      pageviews: toNum(srcVals[i]?.[0]),
      visitors: toNum(srcVals[i]?.[1]),
    };
  });

  return { error: null, siteId: site.site_id, series, sourceTypes };
}

async function safe(fn) {
  try {
    return await fn();
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

const stats = {
  generatedAt: new Date().toISOString(),
  umami: await safe(fetchUmami),
  baidu: await safe(fetchBaidu),
};

mkdirSync('data', { recursive: true });
writeFileSync('data/stats.json', JSON.stringify(stats, null, 2) + '\n');
console.log('umami:', stats.umami.error ?? 'ok', '| baidu:', stats.baidu.error ?? 'ok');
