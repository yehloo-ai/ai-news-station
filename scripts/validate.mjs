import {readFileSync,readdirSync,existsSync,statSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import core from '../assets/station-core.js';
const read = path => JSON.parse(readFileSync(path,'utf8'));
const dates = read('data/daily-index.json');
assert(dates.length > 0);
for (const entry of dates) {
  const data=read('data/daily/' + entry.date + '.json');
  assert(core.validSnapshot(data,entry.date), 'Invalid date snapshot: ' + entry.date);
  assert.equal(entry.count,data.sections.reduce((sum,s)=>sum+s.items.length,0));
  assert(existsSync('daily/' + entry.date + '.html'));
}
assert.deepEqual(read('data/daily-latest.json'),read('data/daily/' + dates[0].date + '.json'));
for (const file of ['featured','all']) {
  const payload=read('data/' + file + '.json');
  assert(payload.items.length);
  for (const item of payload.items) assert(core.normalizeItem(item),file + ': invalid item');
}
for (const file of ['models','funding']) {
  for (const entry of read('data/' + file + '.json').entries) {
    assert(core.validDate(entry.date),file + ': invalid date');
    assert(core.safeURL(entry.sourceUrl),file + ': invalid source URL');
  }
}
assert.equal(read('data/stats.json').public,false);
for (const category of read('data/tools.json').categories) {
  assert(/^[a-z0-9-]+$/.test(category.id));
  for (const tool of category.tools) assert(core.safeURL(tool.url),'Invalid tool URL');
}
let htmlCount=0, linkCount=0;
function check(directory) {
  for (const name of readdirSync(directory)) {
    if (name.startsWith('.') || ['node_modules','test-results','data'].includes(name)) continue;
    const path=join(directory,name);
    if (statSync(path).isDirectory()) { check(path); continue; }
    if (path.startsWith('assets/') && name.endsWith('.js')) new vm.Script(readFileSync(path,'utf8'), {filename:path});
    if (!name.endsWith('.html')) continue;
    const html=readFileSync(path,'utf8'); htmlCount++;
    for (const script of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/src=/.test(script[1])) continue;
      if (/application\/ld\+json/.test(script[1])) JSON.parse(script[2]);
      else new vm.Script(script[2], {filename:path});
    }
    for (const tag of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      let url=tag[1].replaceAll('&amp;','&');
      if (/^(#|data:|mailto:|tel:)/.test(url)) continue;
      if (/^https?:/.test(url)) {
        if (!url.startsWith('https://yehloo-ai.github.io/ai-news-station/')) continue;
        url='/' + url.slice('https://yehloo-ai.github.io/ai-news-station/'.length);
      }
      if (url.includes('${')) continue;
      const local=decodeURIComponent(url.split(/[?#]/)[0]).replace(/^\/ai-news-station\//,'/');
      const target=local.startsWith('/') ? resolve('.' + local) : resolve(dirname(path),local || name);
      assert(existsSync(target),'Broken local reference: ' + path + ' -> ' + url); linkCount++;
    }
  }
}
check('.');
console.log('Validated ' + dates.length + ' editions, ' + htmlCount + ' HTML pages, ' + linkCount + ' internal references');
