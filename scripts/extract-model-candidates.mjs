// 从最新日报的「模型发布」板块抽取时间线候选条目，写入 data/model-candidates.json 供人工审核
// 审核流程：把确认无误的条目移入 data/models.json（可让 Claude Code 代劳），然后从候选中删除

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import core from '../assets/station-core.js';

const models = JSON.parse(readFileSync('data/models.json', 'utf8'));
const candidates = existsSync('data/model-candidates.json')
  ? JSON.parse(readFileSync('data/model-candidates.json', 'utf8'))
  : [];

// 去重：候选标题里若包含任何已收录模型名（去空格小写），视为已覆盖
const flat = (s) => String(s || '').toLowerCase().replace(/[\s·（）()]/g, '');
const modelNames = models.entries.map((e) => flat(e.model)).filter((m) => m.length >= 4);
const seenTitles = new Set(candidates.map((c) => flat(c.title)));
const isKnown = (title) => {
  const t = flat(title);
  return seenTitles.has(t);
};

let added = 0;
const dates = readdirSync('data/daily').filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-3);
for (const f of dates) {
  const daily = JSON.parse(readFileSync(`data/daily/${f}`, 'utf8'));
  if (!core.validSnapshot(daily, f.slice(0, 10))) continue;
  for (const sec of daily.sections || []) {
    if (!/模型/.test(sec.label || '')) continue;
    for (const it of sec.items || []) {
      if (isKnown(it.title)) continue;
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
writeFileSync('data/model-candidates.json', JSON.stringify(candidates, null, 2) + '\n');
console.log(`candidates: +${added} new, ${candidates.length} total pending review`);
