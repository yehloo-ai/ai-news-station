import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eventKey, validateApproved, legacyIssues} from '../scripts/review-policy.mjs';
test('later funding rounds of one company are independent events', () => {
  assert.notEqual(eventKey({company:'Mistral',date:'2026-01-01',round:'B'},'funding'),eventKey({company:'Mistral',date:'2026-09-09',round:'D'},'funding'));
});
test('raw candidates cannot publish without structured human approval', () => {
  assert.equal(validateApproved({title:'Company raised 30 billion'},'funding'),'awaiting-review');
  const c={status:'approved',reviewedBy:'Editor',reviewedAt:'2026-09-16',evidence:'Official release',entry:{company:'Mistral',date:'2026-09-09',sourceUrl:'https://example.com/release',sourceName:'Official',round:'D',amount:'30亿',currency:'EUR'}};
  assert.equal(validateApproved(c,'funding'),'');
  c.entry.currency='';assert.equal(validateApproved(c,'funding'),'invalid-funding');
});
test('known model extraction mistakes are quarantined', () => {
  assert.ok(legacyIssues({company:'OpenAI',model:'Claude Fable 5.1'}).length);
  assert.ok(legacyIssues({company:'深度求索',model:'SiliconFlow'}).length);
  assert.ok(legacyIssues({model:'DeepSeek V4.1',auto:true,highlight:'WorkBuddy 宣布已在其平台上线，免费试用'}).length);
});
