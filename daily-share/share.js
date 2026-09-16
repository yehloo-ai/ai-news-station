'use strict';
const client = Station.createDataClient();
const byId = id => document.getElementById(id);
let snapshot, sections, imageBlob, shareText, shareURL;
const hint = message => { byId('hint').textContent = message; };

async function initShare() {
  const requested = new URLSearchParams(location.search).get('date');
  if (requested && !Station.validDate(requested)) throw new Error('日期格式无效');
  const resource = requested ? '../data/daily/' + requested + '.json' : '../data/daily-latest.json';
  const result = await client.get(resource, {validate: data => Station.validSnapshot(data, requested)});
  snapshot = result.data;
  sections = Station.shareSections(snapshot);
  const total = snapshot.sections.reduce((sum, section) => sum + section.items.length, 0);
  const displayed = sections.reduce((sum, section) => sum + section.items.length, 0);
  shareURL = new URL('?date=' + snapshot.date, location.href).href;
  shareText = '飞翔的AI资讯站｜' + snapshot.date + ' AI 日报速览\n' + shareURL;
  document.title = snapshot.date + ' 日报分享 · 飞翔的AI资讯站';
  byId('datePill').textContent = Station.formatDate(snapshot.date);
  byId('countText').textContent = '全期 ' + total + ' 条 · 本图 ' + displayed + ' 条';
  byId('editionInfo').textContent = snapshot.date + ' 日报 · 每个板块最多 3 条';
  byId('editionLink').href = '../?date=' + snapshot.date;
  byId('timeline').innerHTML = sections.map((section, index) =>
    '<section class="section"><div class="section-head"><span class="section-num">' +
    String(index + 1).padStart(2, '0') + '</span><h2 class="section-title">' +
    Station.escapeHTML(section.title) + '</h2></div><ul class="story-list">' +
    section.items.map(item => '<li class="story"><span><a target="_blank" rel="noopener noreferrer" href="' +
      Station.escapeHTML(Station.safeURL(item.sourceUrl)) + '">' + Station.escapeHTML(item.title) +
      '</a><span class="story-source">' + Station.escapeHTML(item.sourceName || '来源未标注') +
      '</span></span></li>').join('') + '</ul></section>').join('');
  if (result.stale) hint('网络暂不可用，展示已保存的本期日报。');
  for (const id of ['copyBtn', 'downloadBtn', 'shareBtn']) byId(id).disabled = false;
  // Prepare the file before the share gesture; Safari requires user activation.
  imageBlob = await renderPNG();
}

function renderPNG() {
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
  const width = 720, pad = 40, font = '"PingFang SC","Microsoft YaHei",sans-serif';
  const ops = [];
  let y = 48;
  function line(text, x, size, color, weight = 400, maxWidth = width - pad * 2) {
    ctx.font = weight + ' ' + size + 'px ' + font;
    let current = '';
    for (const char of String(text)) {
      if (current && ctx.measureText(current + char).width > maxWidth) {
        ops.push({text:current, x, y, size, color, weight}); y += size * 1.5; current = '';
      }
      current += char;
    }
    if (current) { ops.push({text:current, x, y, size, color, weight}); y += size * 1.5; }
  }
  line('飞翔的AI资讯站', pad, 18, '#111827', 700); y += 12;
  line('AI 日报速览', pad, 30, '#d01922', 700); y += 6;
  const dateY = y;
  line(Station.formatDate(snapshot.date), pad + 10, 14, '#111111', 500);
  ops.push({box:true, x:pad, y:dateY - 6, w:310, h:30});
  y += 20;
  line(byId('countText').textContent, pad, 14, '#4b5563'); y += 20;
  const railStart = y + 10;
  for (const [index, section] of sections.entries()) {
    ops.push({dot:true, x:pad + 3, y:y + 10});
    line(String(index + 1).padStart(2, '0') + '  ' + section.title, pad + 28, 18, '#d01922', 700, width - pad * 2 - 28);
    y += 8;
    for (const item of section.items) {
      line(item.title, pad + 28, 18, '#111827', 600, width - pad * 2 - 28);
      line(item.sourceName || '来源未标注', pad + 28, 13, '#6b7280', 400, width - pad * 2 - 28);
      y += 12;
    }
    y += 18;
  }
  const railEnd = y - 24;
  line('完整日报：', pad, 15, '#111827', 600);
  line('yehloo-ai.github.io/ai-news-station/daily/' + snapshot.date + '.html', pad, 13, '#4b5563');
  canvas.width = width * 2; canvas.height = Math.ceil(y + 30) * 2;
  ctx.scale(2,2); ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,width,canvas.height / 2);
  ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = .5;
  ctx.beginPath(); ctx.moveTo(pad + 3,railStart); ctx.lineTo(pad + 3,railEnd); ctx.stroke();
  for (const op of ops) {
    if (op.box) { ctx.strokeStyle='#111111'; ctx.lineWidth=1; ctx.strokeRect(op.x,op.y,op.w,op.h); continue; }
    if (op.dot) { ctx.fillStyle='#d01922'; ctx.beginPath(); ctx.arc(op.x,op.y,3,0,Math.PI*2); ctx.fill(); continue; }
    ctx.font = op.weight + ' ' + op.size + 'px ' + font;
    ctx.fillStyle=op.color; ctx.textBaseline='top'; ctx.fillText(op.text,op.x,op.y);
  }
  return new Promise((resolve,reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片生成失败')), 'image/png'));
}
byId('copyBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(shareText); hint('分享文案已复制'); }
  catch { hint(shareText); }
});
byId('downloadBtn').addEventListener('click', async () => {
  try {
    imageBlob ||= await renderPNG();
    const url = URL.createObjectURL(imageBlob), link = document.createElement('a');
    link.href=url; link.download='AI日报-' + snapshot.date + '.png'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    hint('长图已生成；手机浏览器也可使用系统分享保存图片。');
  } catch { hint('图片生成失败，请重试或复制分享链接。'); }
});
byId('shareBtn').addEventListener('click', async () => {
  if (!navigator.share) { hint('当前浏览器不支持系统分享，请下载图片或复制文案。'); return; }
  try {
    const file = imageBlob && new File([imageBlob], 'AI日报-' + snapshot.date + '.png', {type:'image/png'});
    if (file && navigator.canShare?.({files:[file]})) await navigator.share({files:[file],title:document.title});
    else await navigator.share({title:document.title,text:shareText,url:shareURL});
  } catch (error) { if (error.name !== 'AbortError') hint('系统分享未完成，请下载图片或复制文案。'); }
});
initShare().catch(() => {
  byId('datePill').textContent='本期暂不可用';
  byId('editionInfo').textContent='未找到日期一致的日报存档';
  byId('timeline').textContent='请返回资讯站选择已有日期，不会以其他日期的新闻替代本期。';
  hint('网络异常时可稍后重试。');
});
