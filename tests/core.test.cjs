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
