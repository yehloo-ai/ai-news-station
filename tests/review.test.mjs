import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eventKey, validateApproved, legacyIssues, isModelCandidate} from '../scripts/review-policy.mjs';
import {readFileSync} from 'node:fs';
test('later funding rounds of one company are independent events', () => {
  assert.notEqual(eventKey({company:'Mistral',date:'2026-01-01',round:'B'},'funding'),eventKey({company:'Mistral',date:'2026-09-09',round:'D'},'funding'));
});
test('raw candidates cannot publish without an explicit evidence-backed review', () => {
  assert.equal(validateApproved({title:'Company raised 30 billion'},'funding'),'awaiting-review');
  const c={status:'approved',reviewedBy:'Editor',reviewedAt:'2026-09-16',evidence:'Official release',entry:{company:'Mistral',date:'2026-09-09',sourceUrl:'https://example.com/release',sourceName:'Official',round:'D',amount:'30亿',currency:'EUR'}};
  assert.equal(validateApproved(c,'funding'),'');
  c.entry.currency='';assert.equal(validateApproved(c,'funding'),'invalid-funding');
});
test('IPO filings and undisclosed acquisitions do not invent funding amounts', () => {
  const c={status:'approved',reviewedBy:'Editor',reviewedAt:'2026-11-03',evidence:'Official announcement',entry:{company:'Example',date:'2026-10-26',sourceUrl:'https://example.com/release',sourceName:'Official',round:'IPO 申请',eventType:'ipo',stage:'filed',amount:null,currency:null}};
  assert.equal(validateApproved(c,'funding'),'');
  c.entry.amount='10亿';c.entry.currency='USD';assert.equal(validateApproved(c,'funding'),'unpriced-ipo');
  c.entry.amount=null;c.entry.currency=null;c.entry.eventType='acquisition';c.entry.stage='completed';assert.equal(validateApproved(c,'funding'),'');
  c.entry.stage='filed';assert.equal(validateApproved(c,'funding'),'invalid-funding');
});
test('model extraction includes product sections but not generic product launches', () => {
  assert(isModelCandidate('产品发布/更新','Liquid 发布 LFM3 多模态模型'));
  assert(!isModelCandidate('产品发布/更新','Claude Max 套餐更名'));
  assert.notEqual(eventKey({company:'Mistral',date:'2026-10-06',model:'Large 4',eventType:'preview'},'models'),eventKey({company:'Mistral',date:'2026-10-29',model:'Large 4',eventType:'open-weights'},'models'));
});
test('verified review is published once and keeps evidence for every correction', () => {
  const review=JSON.parse(readFileSync(new URL('../data/review/timeline-2026-11-03.json',import.meta.url)));
  for(const kind of ['models','funding']) {
    const published=JSON.parse(readFileSync(new URL('../data/'+kind+'.json',import.meta.url))).entries;
    for(const entry of [...review[kind],...review.corrections.filter(c=>c.kind===kind).map(c=>c.entry)]) {
      const matches=published.filter(e=>eventKey(e,kind)===eventKey(entry,kind));
      assert.equal(matches.length,1);
      assert.equal(validateApproved({status:'approved',...matches[0],entry:matches[0]},kind),'');
    }
  }
});
test('known model extraction mistakes are quarantined', () => {
  assert.ok(legacyIssues({company:'OpenAI',model:'Claude Fable 5.1'}).length);
  assert.ok(legacyIssues({company:'深度求索',model:'SiliconFlow'}).length);
  assert.ok(legacyIssues({model:'DeepSeek V4.1',auto:true,highlight:'WorkBuddy 宣布已在其平台上线，免费试用'}).length);
});
