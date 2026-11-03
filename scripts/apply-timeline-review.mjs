import {readFileSync, writeFileSync} from 'node:fs';
import {eventKey, validateApproved} from './review-policy.mjs';
const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/apply-timeline-review.mjs data/review/review.json');
const review = JSON.parse(readFileSync(file, 'utf8'));
const outputs = [];
for (const kind of ['models', 'funding']) {
  const target = `data/${kind}.json`;
  const data = JSON.parse(readFileSync(target, 'utf8'));
  const corrections = (review.corrections || []).filter(c => c.kind === kind);
  const entries = [...review[kind], ...corrections.map(c => c.entry)];
  for (const entry of entries) {
    const reason = validateApproved({status:'approved', reviewedAt:review.reviewedAt, reviewedBy:review.reviewedBy, evidence:entry.evidence, entry}, kind);
    if (reason) throw new Error(`${kind}: ${entry.model || entry.company}: ${reason}`);
  }
  let changed = false;
  for (const correction of corrections) {
    for (const match of correction.match) {
      const index = data.entries.findIndex(e => Object.entries(match).every(([key,value]) => e[key] === value));
      if (index < 0) {
        if (!data.entries.some(e => eventKey(e,kind) === eventKey(correction.entry,kind))) throw new Error('Correction target missing: ' + JSON.stringify(match));
        continue;
      }
      data.entries.splice(index, 1);
      changed = true;
    }
  }
  const known = new Set(data.entries.map(e => eventKey(e,kind)));
  let added = 0;
  for (const entry of entries) {
    const key = eventKey(entry,kind);
    if (known.has(key)) continue;
    data.entries.push({...entry, tier:'normal', auto:false, reviewedAt:review.reviewedAt, reviewedBy:review.reviewedBy});
    known.add(key);
    changed = true;
    added++;
  }
  if (changed) {
    data.updatedAt = review.reviewedAt;
    data.entries.sort((a,b) => b.date.localeCompare(a.date));
    outputs.push([target, JSON.stringify(data,null,2)+'\n']);
  }
  console.log(`${kind}: ${added} verified records applied; ${data.entries.length} total`);
}
// Validate the whole review before writing either timeline; reruns are idempotent.
for (const [target, data] of outputs) writeFileSync(target,data);
