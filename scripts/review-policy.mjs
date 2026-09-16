import core from '../assets/station-core.js';
export const normalize = value => String(value || '').toLowerCase().replace(/[\s·（）()\-—、,，.。:：]/g, '');
export function eventKey(entry, kind) {
  return [normalize(entry.company), entry.date, normalize(kind === 'funding' ? entry.round : entry.model), entry.eventType || (kind === 'funding' ? 'funding' : 'release')].join('|');
}
export function validateApproved(candidate, kind) {
  const entry = candidate.entry;
  if (candidate.status !== 'approved' || !candidate.reviewedBy || !core.validDate(candidate.reviewedAt)) return 'awaiting-review';
  if (!entry || !core.validDate(entry.date) || !entry.company || !core.safeURL(entry.sourceUrl) || !entry.sourceName) return 'invalid-fields';
  if (!candidate.evidence || typeof candidate.evidence !== 'string') return 'missing-evidence';
  if (kind === 'funding' && (!entry.round || !entry.amount || !['USD', 'CNY', 'EUR', 'GBP', 'JPY', 'KRW'].includes(entry.currency))) return 'invalid-funding';
  if (kind === 'models' && (!entry.model || !entry.type || !['release', 'update'].includes(entry.eventType))) return 'invalid-model-event';
  return '';
}
export function legacyIssues(entry) {
  const issues = [];
  if (/claude/i.test(entry.model) && entry.company !== 'Anthropic') issues.push('company-model-mismatch');
  if (/^(siliconflow|agent|inkling)$/i.test(entry.model)) issues.push('unverified-model-identity');
  if (entry.auto && /上线.{0,8}平台|平台上线|上线硅基|上线其|接入|限时免费|免费试用/.test(entry.highlight)) issues.push('platform-availability-not-model-release');
  return issues;
}
