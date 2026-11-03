const {test} = require('node:test');
const assert = require('node:assert/strict');
const core = require('../assets/station-core.js');
const snapshot = {date:'2026-09-15',sections:[{label:'模型发布',items:[{title:'Release',summary:'Summary',sourceUrl:'https://example.com/news',sourceName:'Example'}]}]};
test('snapshots reject mismatched dates and unsafe sources', () => {
  assert.equal(core.validSnapshot(snapshot, '2026-09-15'), true);
  assert.equal(core.validSnapshot(snapshot, '2026-09-16'), false);
  assert.equal(core.validDate('2026-02-30'), false);
  for (const value of ['javascript:alert(1)', 'data:text/html,test', '//example.com', 'https://user:pass@example.com']) assert.equal(core.safeURL(value), '');
  assert.equal(core.beijingDate('2026-09-15T20:00:00Z'), '2026-09-16');
  assert.match(core.formatDate('2026-09-15'), /15/);
});
test('source schema and share selection preserve the snapshot', () => {
  assert.equal(core.normalizeItem({title:'News',link:'https://example.com',source:'Media',color:'#123456'})._feed.name, 'Media');
  assert.equal(core.shareSections(snapshot)[0].items[0].title, 'Release');
  assert.equal(core.snapshotSources(snapshot)[0].name, 'Example');
  assert.equal(core.escapeHTML('<"\'&>'), '&lt;&quot;&#39;&amp;&gt;');
});
test('failed refresh preserves cached content and concurrent reads share one request', async () => {
  let calls=0, fail=false;
  const client=core.createDataClient({storage:null,fetch:async()=>{calls++;await new Promise(r=>setTimeout(r,5));if(fail)throw Error('offline');return {ok:true,json:async()=>snapshot};}});
  const [a,b]=await Promise.all([client.get('daily'),client.get('daily')]);
  assert.deepEqual(a.data,b.data);assert.equal(calls,1);
  fail=true;
  const cached=await client.get('daily',{force:true});
  assert.equal(cached.stale,true);assert.equal(cached.data.date,snapshot.date);
  await assert.rejects(client.get('missing'));
});
test('first visit can read embedded data without network or storage', async () => {
  const client=core.createDataClient({storage:null,fallback:{daily:snapshot},fetch:async()=>{throw Error('offline');}});
  assert.equal(client.peek('daily',core.validSnapshot).checkedAt,0);
  const result=await client.get('daily',{validate:core.validSnapshot});
  assert.equal(result.stale,true);
  assert.deepEqual(result.data,snapshot);
  await assert.rejects(client.get('daily',{validate:d=>core.validSnapshot(d,'2026-09-16')}));
});
test('a newer embedded edition supersedes an older cache, never the reverse', () => {
  for (const [cachedDate,expected] of [['2026-09-14','2026-09-15'],['2026-09-16','2026-09-16']]) {
    const client=core.createDataClient({fallback:{daily:snapshot},storage:{getItem:()=>JSON.stringify({data:{...snapshot,date:cachedDate},checkedAt:1})},fetch:async()=>{}});
    assert.equal(client.peek('daily',core.validSnapshot).data.date,expected);
  }
});
test('one transient retry bypasses cached failures; 404 does not retry', async () => {
  const urls=[];
  const client=core.createDataClient({storage:null,fetch:async url=>{urls.push(url);if(urls.length===1)throw Error('network');return {ok:true,json:async()=>snapshot};}});
  assert.equal((await client.get('data/latest.json')).stale,false);
  assert.equal(urls.length,2);assert.match(urls[1],/latest.json\?_retry=\d+/);
  let calls=0;
  const missing=core.createDataClient({storage:null,fetch:async()=>{calls++;return {ok:false,status:404};}});
  await assert.rejects(missing.get('missing'));assert.equal(calls,1);
});
