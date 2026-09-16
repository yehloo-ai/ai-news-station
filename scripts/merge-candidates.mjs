// Only explicitly reviewed, structured events may enter the published timelines.
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {eventKey, validateApproved} from './review-policy.mjs';
const read = (file, fallback) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
for (const [kind, candidateFile] of [['models', 'model-candidates'], ['funding', 'funding-candidates']]) {
  const data = read(`data/${kind}.json`, {entries: []});
  const candidates = read(`data/${candidateFile}.json`, []);
  const known = new Set(data.entries.map(entry => eventKey(entry, kind)));
  const pending = [];
  let added = 0;
  for (const candidate of candidates) {
    const reason = validateApproved(candidate, kind);
    if (reason) { pending.push({...candidate, reviewReason: reason}); continue; }
    const key = eventKey(candidate.entry, kind);
    if (known.has(key)) { pending.push({...candidate, reviewReason: 'duplicate-event'}); continue; }
    data.entries.push({...candidate.entry, auto: false, reviewedAt: candidate.reviewedAt, reviewedBy: candidate.reviewedBy});
    known.add(key);
    added++;
  }
  if (added) {
    data.updatedAt = new Date().toISOString().slice(0, 10);
    data.entries.sort((a, b) => b.date.localeCompare(a.date));
    write(`data/${kind}.json`, data);
  }
  write(`data/${candidateFile}.json`, pending);
  console.log(`${kind}: ${added} reviewed events published, ${pending.length} candidates retained`);
}
