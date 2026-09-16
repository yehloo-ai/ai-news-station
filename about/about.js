'use strict';
const button = document.getElementById('analytics');
function analyticsState() {
  try { return localStorage.getItem('ai_station_analytics') !== 'off'; } catch { return false; }
}
function renderPrivacy() { button.textContent = analyticsState() ? '关闭本浏览器的访问统计' : '开启本浏览器的访问统计'; }
button.addEventListener('click', () => {
  try { localStorage.setItem('ai_station_analytics', analyticsState() ? 'off' : 'on'); renderPrivacy(); document.getElementById('privacyStatus').textContent='偏好已保存，下次打开首页生效。'; }
  catch { document.getElementById('privacyStatus').textContent='浏览器禁止保存设置，未能更改。'; }
});
document.getElementById('clear').addEventListener('click', () => {
  try {
    for (const key of Object.keys(localStorage)) if ((key.startsWith('ai_station_') && key !== 'ai_station_analytics') || key.startsWith('ai_news_')) localStorage.removeItem(key);
    document.getElementById('privacyStatus').textContent='本站已读与缓存记录已清除。';
  } catch { document.getElementById('privacyStatus').textContent='浏览器禁止访问本地记录。'; }
});
renderPrivacy();
Station.createDataClient().get('../data/source-health.json', {validate:data => Array.isArray(data.sources)}).then(({data, stale}) => {
  document.getElementById('checked').textContent=(stale ? '已保存的检查结果：' : '最近检查：') + Station.formatUpdated(data.checkedAt);
  document.getElementById('sourceList').innerHTML=data.sources.map(source =>
    '<li><strong><a target="_blank" rel="noopener noreferrer" href="' + Station.escapeHTML(Station.safeURL(source.url)) + '">' + Station.escapeHTML(source.name) +
    '</a> · ' + ({ok:'正常',stale:'使用缓存',unavailable:'暂不可用'}[source.status] || '未检查') + '</strong><span class="muted">' +
    (source.status === 'ok' ? source.count + ' 条有效内容' : (source.cachedCount || 0) + ' 条缓存内容') +
    (source.lastSuccessAt ? ' · 最近成功 ' + Station.formatUpdated(source.lastSuccessAt) : '') + '</span></li>').join('');
}).catch(() => { document.getElementById('checked').textContent='暂无可用的采集检查记录，不能据此判断各来源正常。'; });
