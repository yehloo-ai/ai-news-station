"""
飞翔的AI资讯站 — 数据生成脚本
每 2 小时运行，生成各频道 JSON + 全站 feed.xml
输出：data/featured.json, data/official.json, data/videos.json,
      data/products.json, data/design.json, data/all.json, feed.xml
"""

import requests
import feedparser
import json
import os
import re
import hashlib
from urllib.parse import urlparse
from datetime import datetime, timezone
from email.utils import format_datetime, parsedate_to_datetime
from xml.sax.saxutils import escape

# ── 路径 ──────────────────────────────────────────────
ROOT = os.path.dirname(os.path.dirname(__file__))
DATA_DIR = os.path.join(ROOT, 'data')
os.makedirs(DATA_DIR, exist_ok=True)

def read_json(filename, fallback):
    try:
        with open(os.path.join(DATA_DIR, filename), encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return fallback

SOURCE_CACHE = read_json('source-cache.json', {})
TRANSLATIONS = read_json('translations.json', {})
SOURCE_HEALTH = {}
RUN_CACHE = {}

# ── 翻译（Google Translate 免费接口，GitHub Actions 服务器可用）──
import urllib.parse
import time

def is_english(text):
    if not text or len(text) < 8:
        return False
    alpha = sum(1 for c in text if c.isalpha())
    if alpha == 0:
        return False
    latin = sum(1 for c in text if c.isascii() and c.isalpha())
    return latin / alpha > 0.7

def translate_one(text):
    """Only use an explicitly configured endpoint; never delay the browser."""
    key = hashlib.sha256(text.encode('utf-8')).hexdigest()
    if key in TRANSLATIONS:
        return TRANSLATIONS[key]
    endpoint = os.environ.get('TRANSLATE_ENDPOINT')
    if not endpoint:
        return ''
    try:
        r = requests.get(endpoint, params={'client': 'gtx', 'sl': 'en', 'tl': 'zh-CN', 'dt': 't', 'q': text}, timeout=8, headers=HEADERS)
        if r.ok:
            data = r.json()
            result = ''.join(p[0] for p in data[0] if p and p[0])
            if result and result != text:
                TRANSLATIONS[key] = result
                return result
    except Exception:
        pass
    return ''

def translate_items_en(items):
    """翻译 items 中的英文标题（原地修改）"""
    targets = [it for it in items if is_english(it.get('title', '')) and not it.get('_translated')]
    if not targets:
        return
    translated = 0
    for it in targets:
        zh = translate_one(it['title'])
        if zh:
            it['titleOriginal'] = it['title']
            it['title'] = zh
            it['_translated'] = True
            translated += 1
    print(f'  ✓ 翻译 {translated}/{len(targets)} 条')

# ── 常量 ──────────────────────────────────────────────
SITE_URL  = 'https://yehloo-ai.github.io/ai-news-station/'
FEED_URL  = 'https://yehloo-ai.github.io/ai-news-station/feed.xml'
TIMEOUT   = 12
HEADERS   = {'User-Agent': 'Mozilla/5.0 (compatible; FeixiangBot/1.0)'}

# ── 数据源定义 ────────────────────────────────────────
OFFICIAL_SOURCES = [
    ('OpenAI',       'https://openai.com/blog/rss.xml',          '#10a37f'),
    ('Anthropic',    'https://www.anthropic.com/rss',            '#d97706'),
    ('DeepMind',     'https://deepmind.google/blog/rss.xml',      '#4285f4'),
    ('HuggingFace',  'https://huggingface.co/blog/feed.xml',     '#ff9d00'),
    ('Meta AI',      'https://ai.meta.com/blog/rss/',            '#1877f2'),
    ('Microsoft Cloud', 'https://www.microsoft.com/en-us/microsoft-cloud/blog/feed/', '#00a1f1'),
    ('Google AI',    'https://blog.google/technology/ai/rss/',   '#ea4335'),
]

VIDEO_SOURCES = [
    ('OpenAI',           'https://www.youtube.com/feeds/videos.xml?channel_id=UCXZCJLdBC09xxGZ6gcdrc6A', '#10a37f'),
    ('DeepMind',         'https://www.youtube.com/feeds/videos.xml?channel_id=UCP7jMXSY2xbc3KCAE0MHQ-A', '#4285f4'),
    ('Anthropic',        'https://www.youtube.com/feeds/videos.xml?channel_id=UCrDwWp7EBBv4NwvScIpBDOA', '#c75b39'),
    ('Two Minute Papers','https://www.youtube.com/feeds/videos.xml?channel_id=UCbfYPyITQ-7l4upoX8nvctg', '#ef4444'),
]

DESIGN_YT_SOURCES = [
    ('Matt Wolfe',       'https://www.youtube.com/feeds/videos.xml?channel_id=UChpleBmo18P08aKCIgti38g', '#f59e0b'),
    ('AI Explained',     'https://www.youtube.com/feeds/videos.xml?channel_id=UC_HhOkzorAO4_rRsTiiHZ_w', '#8b5cf6'),
    ('Runway',           'https://www.youtube.com/feeds/videos.xml?channel_id=UCUBqu_z5uP0AZhYtuyFZB3g', '#06b6d4'),
    ('Two Minute Papers','https://www.youtube.com/feeds/videos.xml?channel_id=UCbfYPyITQ-7l4upoX8nvctg', '#ef4444'),
]

ARXIV_SOURCES = [
    ('ArXiv AI',  'https://export.arxiv.org/rss/cs.AI',  '#e67e22'),
    ('ArXiv ML',  'https://export.arxiv.org/rss/cs.LG',  '#e74c3c'),
    ('ArXiv NLP', 'https://export.arxiv.org/rss/cs.CL',  '#1abc9c'),
]

CHINESE_SOURCES = [
    ('The Verge AI', 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', '#e40045'),
    ('量子位',       'https://www.qbitai.com/feed',             '#bc8cff'),
    ('爱范儿',       'https://www.ifanr.com/feed',              '#3fb950'),
    ('机器之心',     'https://www.jiqizhixin.com/rss',          '#58a6ff'),
    ('极客公园',     'https://www.geekpark.net/rss',            '#ffa657'),
    ('少数派',       'https://sspai.com/feed',                  '#8b949e'),
    ('36Kr',         'https://36kr.com/feed',                   '#1677ff'),
    ('虎嗅',         'https://www.huxiu.com/rss/0.xml',         '#e67e22'),
    ('新智元',       'https://xinzhiyuan.com/feed',             '#8b5cf6'),
]

# 产品/设计关键词过滤
PRODUCT_KW = ['产品', '发布', '上线', '功能', '版本', '更新', 'launch', 'product', 'release', 'feature',
              'app', 'tool', '工具', 'API', 'GPT', 'Claude', 'Gemini', 'Copilot', 'Sora', 'Midjourney']
DESIGN_KW  = ['设计', '创作', '生图', '图像', 'design', 'creative', 'image', 'video', 'visual',
              'Runway', 'Midjourney', 'DALL', 'Stable Diffusion', 'Figma', 'UI', 'UX', '审美', 'art']


# ── 工具函数 ──────────────────────────────────────────
def now_iso():
    return datetime.now(timezone.utc).isoformat()

def parse_date(raw):
    if not raw:
        return None
    try:
        from dateutil import parser as dp
        dt = dp.parse(str(raw))
        return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt
    except Exception:
        return None

def safe_url(value):
    try:
        parsed = urlparse(str(value))
        return str(value) if parsed.scheme in ('https', 'http') and parsed.netloc and not parsed.username else ''
    except ValueError:
        return ''

def source_result(name, url, items, error=None):
    previous = SOURCE_CACHE.get(url, {})
    checked = now_iso()
    if items:
        SOURCE_CACHE[url] = {'name': name, 'checkedAt': checked, 'items': items}
    result = items or previous.get('items', [])
    SOURCE_HEALTH[url] = {
        'name': name, 'url': url, 'checkedAt': checked,
        'status': 'ok' if items else ('stale' if result else 'unavailable'),
        'count': len(items), 'cachedCount': len(result) if not items else 0,
        'lastSuccessAt': checked if items else previous.get('checkedAt'),
        'error': str(error or ('No usable entries' if not items else ''))[:240],
    }
    if not items:
        print(f'::warning::{name}: {SOURCE_HEALTH[url]["status"]}; {SOURCE_HEALTH[url]["error"]}')
    RUN_CACHE[url] = result
    return result

def extract_thumbnail(entry):
    """从 YouTube RSS entry 提取缩略图 URL"""
    # feedparser 把 media:thumbnail 放在 media_thumbnail
    thumbs = getattr(entry, 'media_thumbnail', None)
    if thumbs and isinstance(thumbs, list) and thumbs:
        return thumbs[0].get('url', '')
    # 备选：从 summary 里提取
    summary = entry.get('summary', '')
    m = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', summary)
    return m.group(1) if m else ''

def strip_html(text):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '', text or '')).strip()[:300]

def fetch_rss(name, url, color, limit=15):
    """拉取单个 RSS 源，返回 item 列表"""
    if url in RUN_CACHE:
        return [dict(item) for item in RUN_CACHE[url][:limit]]
    items, error = [], None
    try:
        response = requests.get(url, timeout=TIMEOUT, headers=HEADERS)
        response.raise_for_status()
        feed = feedparser.parse(response.content)
        if not feed.entries:
            raise ValueError('Invalid or empty RSS/Atom feed')
        is_yt = 'youtube.com' in url
        for e in feed.entries[:30]:
            title = e.get('title', '').strip()
            link  = safe_url(e.get('link', '').strip())
            if not title or not link:
                continue
            desc  = strip_html(e.get('summary', ''))
            pub   = parse_date(e.get('published', e.get('updated', '')))
            item  = {
                'title': title,
                'link': link,
                'description': desc,
                'pubDate': pub.isoformat() if pub else None,
                'source': name,
                'color': color,
            }
            if is_yt:
                item['image'] = extract_thumbnail(e)
                item['category'] = 'video'
            items.append(item)
    except Exception as ex:
        error = f'{type(ex).__name__}: {ex}'
    else:
        print(f'  ✓ {name}: {len(items)} 条')
    return [dict(item) for item in source_result(name, url, items, error)[:limit]]

def fetch_aihot(path='/items?mode=selected&take=30'):
    """从 AI HOT API 拉取精选内容"""
    items, error = [], None
    url = f'https://aihot.virxact.com/api/public{path}'
    try:
        r = requests.get(url,
                         timeout=TIMEOUT, headers=HEADERS)
        r.raise_for_status()
        data = r.json()
        entries = data.get('data', data) if isinstance(data, dict) else data
        if isinstance(entries, dict):
            entries = entries.get('items')
        if isinstance(entries, list):
            for e in entries:
                title = e.get('title') or e.get('name', '')
                link  = safe_url(e.get('url') or e.get('link', ''))
                desc  = e.get('description') or e.get('summary', '')
                pub   = parse_date(e.get('publishedAt') or e.get('created_at', ''))
                if title and link:
                    items.append({
                        'title': title,
                        'link': link,
                        'description': str(desc)[:300],
                        'pubDate': pub.isoformat() if pub else None,
                        'source': str(e.get('source') or 'AI HOT'),
                        'aggregator': 'AI HOT',
                        '_aiCat': e.get('category') if e.get('category') in ('industry', 'ai-products', 'tip', 'paper', 'funding', 'opensource', 'ai-models', 'design', 'video') else None,
                        'color': '#d01922',
                    })
        print(f'  ✓ AI HOT{path}: {len(items)} 条')
    except Exception as ex:
        error = f'{type(ex).__name__}: {ex}'
    return source_result('AI HOT', url, items, error)

def dedupe(items):
    seen, out = set(), []
    for item in items:
        key = item['link']
        if key not in seen:
            seen.add(key)
            out.append(item)
    return out

def sort_items(items):
    return sorted(items, key=lambda x: (parse_date(x.get('pubDate')) or datetime.min.replace(tzinfo=timezone.utc)).timestamp(), reverse=True)

def keyword_filter(items, keywords):
    """保留标题或描述包含关键词的条目"""
    result = []
    for item in items:
        text = (item.get('title', '') + ' ' + item.get('description', '')).lower()
        if any(kw.lower() in text for kw in keywords):
            result.append(item)
    return result

def save_json(filename, items):
    previous = read_json(filename, {})
    failed_names = {source['name'] for source in SOURCE_HEALTH.values() if source['status'] != 'ok'}
    preserved = [item for item in previous.get('items', []) if item.get('source') in failed_names]
    limit = max(len(items), len(previous.get('items', [])))
    if items and preserved:
        items = sort_items(dedupe(items + preserved))[:limit]
    # A failed run must not replace the last readable edition with an empty list.
    if not items:
        print(f'::warning::{filename}: no items; preserving previous snapshot')
        return previous.get('items', [])
    translate_items_en(items)
    path = os.path.join(DATA_DIR, filename)
    previous_items = previous.get('items', [])
    payload = {'updated': previous.get('updated') if previous_items == items else now_iso(), 'items': items,
               'degradedSources': sorted(failed_names)}
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    print(f'→ {filename}: {len(items)} 条')
    return items


# ── 各频道生成 ────────────────────────────────────────
def gen_official():
    print('\n[官方动态]')
    items = []
    for name, url, color in OFFICIAL_SOURCES:
        items.extend(fetch_rss(name, url, color, 8))
    items = sort_items(dedupe(items))[:40]
    save_json('official.json', items)
    return items

def gen_videos():
    print('\n[AI 视频]')
    items = []
    for name, url, color in VIDEO_SOURCES:
        items.extend(fetch_rss(name, url, color, 8))
    items = sort_items(dedupe(items))[:30]
    save_json('videos.json', items)
    return items

def gen_chinese_base():
    """中文媒体 + The Verge 基础数据（供多频道复用）"""
    items = []
    for name, url, color in CHINESE_SOURCES:
        items.extend(fetch_rss(name, url, color, 10))
    relevant = re.compile(r'\bAI\b|人工智能|大模型|机器学习|深度学习|生成式|智能体|OpenAI|ChatGPT|Claude|Gemini|DeepSeek|Grok|Qwen|通义|豆包|文心|Kimi|Midjourney|Copilot|Sora|Runway|提示词|生图|文生视频', re.I)
    return dedupe([item for item in items if relevant.search(item.get('title','') + ' ' + item.get('description',''))])

def gen_featured(chinese_base, aihot_items):
    print('\n[精选]')
    arxiv = []
    for name, url, color in ARXIV_SOURCES:
        arxiv.extend(fetch_rss(name, url, color, 5))
    yt = []
    for name, url, color in VIDEO_SOURCES:
        yt.extend(fetch_rss(name, url, color, 4))
    items = sort_items(dedupe(aihot_items + arxiv + yt + chinese_base))[:50]
    return save_json('featured.json', items)

def gen_all(chinese_base, aihot_items):
    print('\n[全部动态]')
    arxiv = []
    for name, url, color in ARXIV_SOURCES:
        arxiv.extend(fetch_rss(name, url, color, 8))
    yt = []
    for name, url, color in VIDEO_SOURCES:
        yt.extend(fetch_rss(name, url, color, 5))
    official = []
    for name, url, color in OFFICIAL_SOURCES:
        offi = fetch_rss(name, url, color, 5)
        for it in offi:
            it['official'] = True
        official.extend(offi)
    items = sort_items(dedupe(aihot_items + arxiv + yt + official + chinese_base))[:80]
    save_json('all.json', items)
    return items

def gen_products(chinese_base, aihot_items):
    print('\n[AI 产品]')
    filtered = keyword_filter(chinese_base + aihot_items, PRODUCT_KW)
    items = sort_items(dedupe(filtered))[:40]
    save_json('products.json', items)

def gen_design(chinese_base):
    print('\n[AI 设计]')
    yt = []
    for name, url, color in DESIGN_YT_SOURCES:
        yt.extend(fetch_rss(name, url, color, 6))
    filtered = keyword_filter(chinese_base, DESIGN_KW)
    items = sort_items(dedupe(yt + filtered))[:40]
    save_json('design.json', items)

DAILY_SOURCES = {'量子位', '爱范儿', '极客公园', '少数派', '36Kr', '机器之心'}

def gen_daily(chinese_base):
    print('\n[AI 日报]')
    items = [it for it in chinese_base if it.get('source') in DAILY_SOURCES]
    items = sort_items(items)[:60]
    save_json('daily.json', items)

def gen_rss_xml(featured_items):
    """生成 feed.xml（向后兼容）"""
    if not featured_items:
        return
    now_rfc = format_datetime(datetime.now(timezone.utc))
    rows = []
    for item in featured_items[:20]:
        rows.append(f"""    <item>
      <title>{escape(item['title'])}</title>
      <link>{escape(item['link'])}</link>
      <description>{escape(strip_html(item.get('description','')))}</description>
      {('<pubDate>' + format_datetime(parse_date(item.get('pubDate'))) + '</pubDate>') if parse_date(item.get('pubDate')) else ''}
      <guid isPermaLink="true">{escape(item['link'])}</guid>
      <source url="{escape(item['link'], {chr(34): '&quot;'})}">{escape(item['source'])}</source>
    </item>""")
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>飞翔的AI资讯站 · 每日精选</title>
    <link>{SITE_URL}</link>
    <description>每 2 小时自动更新的 AI 行业精选资讯</description>
    <language>zh-CN</language>
    <lastBuildDate>{now_rfc}</lastBuildDate>
    <atom:link href="{FEED_URL}" rel="self" type="application/rss+xml"/>
{chr(10).join(rows)}
  </channel>
</rss>"""
    path = os.path.join(ROOT, 'feed.xml')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(xml)
    print(f'\n→ feed.xml: {len(featured_items[:20])} 条')


# ── 主流程 ────────────────────────────────────────────
def main():
    print('=== 飞翔的AI资讯站 数据更新开始 ===')

    print('\n[AI HOT API]')
    aihot_featured = fetch_aihot('/items?mode=selected&take=30')
    aihot_all      = fetch_aihot('/items?mode=all&take=60')

    print('\n[中文媒体]')
    chinese_base = gen_chinese_base()
    print(f'  中文媒体合计: {len(chinese_base)} 条')

    gen_official()
    gen_videos()
    featured = gen_featured(chinese_base, aihot_featured)
    gen_all(chinese_base, aihot_all)
    gen_products(chinese_base, aihot_all)
    gen_design(chinese_base)
    gen_daily(chinese_base)
    gen_rss_xml(featured)

    for filename, payload in [('source-health.json', {'checkedAt': now_iso(), 'sources': list(SOURCE_HEALTH.values())}), ('source-cache.json', SOURCE_CACHE), ('translations.json', TRANSLATIONS)]:
        with open(os.path.join(DATA_DIR, filename), 'w', encoding='utf-8') as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(',', ':'))

    print('\n=== 完成 ===')

if __name__ == '__main__':
    main()
