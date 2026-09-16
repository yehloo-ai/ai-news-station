import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {legacyIssues} from './review-policy.mjs';
const data = JSON.parse(readFileSync('data/models.json', 'utf8'));
const file = 'data/review/models.json';
mkdirSync('data/review', {recursive:true});
const review = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
const retained = [];
for (const entry of data.entries) {
  const reasons = legacyIssues(entry);
  if (reasons.length) { review.push({entry, reasons, status:'pending'}); continue; }
  if (entry.company === 'Suno' && /音乐|歌曲/.test(entry.highlight)) entry.type = '语音';
  retained.push(entry);
}
if (retained.length !== data.entries.length) {
  data.entries = retained;
  data.correctedAt = new Date().toISOString().slice(0,10);
}
writeFileSync('data/models.json', JSON.stringify(data, null, 2) + '\n');
writeFileSync(file, JSON.stringify(review, null, 2) + '\n');
console.log(`${review.length} suspect records preserved in review; ${retained.length} published records retained`);
