// Collect model candidates across sections. Observation dates are not release dates.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import core from '../assets/station-core.js';
import {isModelCandidate} from './review-policy.mjs';

const candidates = existsSync('data/model-candidates.json')
  ? JSON.parse(readFileSync('data/model-candidates.json', 'utf8'))
  : [];

// Deduplicate candidate titles, not model names: later versions remain eligible.
const flat = (s) => String(s || '').toLowerCase().replace(/[\s·（）()]/g, '');
const seenTitles = new Set(candidates.map((c) => flat(c.title)));
const isKnown = (title) => {
  const t = flat(title);
  return seenTitles.has(t);
};

let added = 0;
const dates = readdirSync('data/daily').filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-30);
for (const f of dates) {
  const daily = JSON.parse(readFileSync(`data/daily/${f}`, 'utf8'));
  if (!core.validSnapshot(daily, f.slice(0, 10))) continue;
  for (const sec of daily.sections || []) {
    for (const it of sec.items || []) {
      if (!isModelCandidate(sec.label, it.title)) continue;
      if (isKnown(it.title)) continue;
      seenTitles.add(flat(it.title));
      candidates.push({
        observedDate: daily.date,
        status: 'pending',
        reviewReason: 'event-date-and-source-unverified',
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
