// 从最新日报的各板块按「融资关键词」抽取资本动态候选，写入 data/funding-candidates.json 供人工审核
// 审核流程：把确认无误的条目整理并移入 data/funding.json（可让 Claude Code 代劳），然后从候选中删除
// 日报没有独立「融资」板块，故走关键词匹配（候选宁多勿漏，人工过滤）

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import core from '../assets/station-core.js';

const funding = JSON.parse(readFileSync('data/funding.json', 'utf8'));
const candidates = existsSync('data/funding-candidates.json')
  ? JSON.parse(readFileSync('data/funding-candidates.json', 'utf8'))
  : [];

// 融资类关键词（命中标题即视为候选）
const FUND_RE = /融资|领投|跟投|估值|募资|收购|并购|\bIPO\b|上市|Series\s*[A-Z]|(种子|天使|[A-F]\+?|Pre-?[A-F])\s*轮|[\d.]+\s*亿\s*(美元|元)?\s*(融资|投资|轮)/i;

// 去重：候选标题若与已收录条目（公司+日期）或已存在候选重复，则跳过
const flat = (s) => String(s || '').toLowerCase().replace(/[\s·（）()]/g, '');
const knownCompanies = funding.entries.map((e) => flat(e.company)).filter((m) => m.length >= 2);
const seenTitles = new Set(candidates.map((c) => flat(c.title)));
const isDup = (title) => {
  const t = flat(title);
  return seenTitles.has(t);
};

let added = 0;
const dates = readdirSync('data/daily').filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-3);
for (const f of dates) {
  const daily = JSON.parse(readFileSync(`data/daily/${f}`, 'utf8'));
  if (!core.validSnapshot(daily, f.slice(0, 10))) continue;
  for (const sec of daily.sections || []) {
    for (const it of sec.items || []) {
      const text = `${it.title || ''} ${it.summary || ''}`;
      if (!FUND_RE.test(text)) continue;
      if (isDup(it.title)) continue;
      seenTitles.add(flat(it.title));
      candidates.push({
        date: daily.date,
        title: it.title,
        summary: (it.summary || '').slice(0, 200),
        sourceUrl: it.sourceUrl || '',
        sourceName: it.sourceName || '',
      });
      added++;
    }
  }
}

// Pending candidates are retained until an explicit review decision.
writeFileSync('data/funding-candidates.json', JSON.stringify(candidates, null, 2) + '\n');
console.log(`funding candidates: +${added} new, ${candidates.length} total pending review`);
