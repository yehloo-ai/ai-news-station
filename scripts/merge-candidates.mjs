// 全自动把候选合并进正式时间线：model-candidates → models.json，funding-candidates → funding.json
// 由 GitHub Actions 每天多次运行；成功合并的候选会从候选池移除，避免重复。
// 字段为启发式解析，统一标 tier:"minor"（紧凑一行）与 auto:true，便于后续人工精修/校正。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const readJson = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d);
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
const flat = (s) => String(s || '').toLowerCase().replace(/[\s·（）()\-—、,，.。:：]/g, '');
const today = new Date().toISOString().slice(0, 10);
const firstClause = (s) => String(s || '').split(/[。\n]/)[0].trim().slice(0, 46);

// ── 公司归一词典（命中即用规范名；顺序 = 优先级，具体的在前）──
const COMPANY = [
  [/google\s*deepmind|deepmind|gemini|谷歌/i, 'Google DeepMind'],
  [/openai|(^|[^a-z])gpt|sora|dall[·\-]?e/i, 'OpenAI'],
  [/anthropic|claude/i, 'Anthropic'],
  [/microsoft|微软|copilot|phi-\d/i, 'Microsoft'],
  [/\bmeta\b|llama|扎克伯格/i, 'Meta'],
  [/深度求索|deepseek/i, '深度求索'],
  [/月之暗面|moonshot|kimi/i, '月之暗面'],
  [/智谱|glm|智谱清言/i, '智谱'],
  [/minimax|海螺/i, 'MiniMax'],
  [/快手|可灵|kling/i, '快手'],
  [/生数|vidu/i, '生数科技'],
  [/蚂蚁|百灵|ling-\d|bailing/i, '蚂蚁'],
  [/零一万物|01\.ai/i, '零一万物'],
  [/商汤|sensetime/i, '商汤'],
  [/阿里|通义|qwen|万相/i, '阿里巴巴'],
  [/字节|豆包|火山引擎|即梦|seedance|doubao/i, '字节跳动'],
  [/百度|文心|ernie/i, '百度'],
  [/腾讯|混元|hunyuan/i, '腾讯'],
  [/华为|盘古|pangu/i, '华为'],
  [/mistral/i, 'Mistral AI'],
  [/\bxai\b|grok/i, 'xAI'],
  [/midjourney/i, 'Midjourney'],
  [/black\s*forest|flux/i, 'Black Forest Labs'],
  [/stability|stable\s*diffusion/i, 'Stability AI'],
  [/runway/i, 'Runway'],
  [/\bpika\b/i, 'Pika'],
  [/cohere/i, 'Cohere'],
  [/nvidia|英伟达/i, 'NVIDIA'],
  [/\bapple\b|苹果/i, 'Apple'],
  [/amazon|亚马逊/i, 'Amazon'],
  [/suno/i, 'Suno'],
  [/elevenlabs/i, 'ElevenLabs'],
];
const RELEASE_VERB = /(正式)?(发布并开源|发布|推出|上线|开源|亮相|放出|升级至|更新至)/;
const MODEL_SUFFIX = 'Flash|Pro|Mini|Max|Ultra|Turbo|Lite|Air|Plus|Preview|Base|Chat|Instruct|Reasoner|Thinking|Coder|Code|Vision|Audio|Live|Work|Realtime|Embed|Nano|Omni';
// 英文模型名 + 版本：大写起头，可含空格/连字符/点/数字与常见后缀词（最多接 3 段）
const MODEL_TOKEN = new RegExp(
  `[A-Za-z][A-Za-z0-9]*(?:[.\\-][A-Za-z0-9]+)*(?:\\s+(?:[0-9][A-Za-z0-9.]*|v[0-9.]+|${MODEL_SUFFIX}|[A-Z][A-Za-z0-9.\\-]+)){0,3}`,
  'g'
);
const BAD_MODEL = /(博文|成果|方案|报告|消息|计划|战略|白皮书|发布会|开发者|一系列|多款|三款|两款)/;
// 单词孤立出现时不足以作为模型名的常见词/后缀词/架构词
const STOP = new Set(['pro','live','air','max','mini','flash','moe','plus','base','chat','ultra','turbo','lite',
  'token','bit','ai','api','gpu','llm','sdk','beta','alpha','edge','nano','omni','work','vision','audio','code',
  'coder','preview','reasoner','thinking','embed','realtime','hybrid','model','models','new','inc','labs','team']);

function detectCompany(title) {
  for (const [re, name] of COMPANY) if (re.test(title)) return name;
  const m = title.match(/^\s*([^\s，。、：:（(]{2,12}?)\s*(?:正式)?(?:发布|推出|上线|开源|亮相)/);
  return m ? m[1] : '';
}

// 在一段文本中挑最像「模型型号」的英文 token（含数字/连字符/多词者优先）
function bestToken(text, comp) {
  let best = '', score = -1;
  for (const tok of text.match(MODEL_TOKEN) || []) {
    const t = tok.trim();
    const tf = flat(t);
    if (tf.length < 2 || tf === comp) continue;
    const words = t.split(/\s+/);
    const lone = words.length === 1 && !/[0-9]/.test(t) && !/[.\-]/.test(t);
    if (lone && (/^[a-z]/.test(t) || STOP.has(t.toLowerCase()))) continue; // 跳过孤立的常见词/后缀词
    const sc = t.length + (/[0-9]/.test(t) ? 20 : 0) + (/[.\-]/.test(t) ? 8 : 0) + (words.length >= 2 ? 6 : 0);
    if (sc > score) { score = sc; best = t; }
  }
  return best;
}

function detectModel(title, company) {
  const norm = title.replace(/[‑–—]/g, '-'); // 统一连字符，避免 "GPT‑Live" 被截断
  const comp = flat(company);
  const m = norm.match(RELEASE_VERB);
  if (m) {
    // "{公司} 发布 {模型}" 优先取动词之后；"{模型} 发布：…" 则回退到动词之前
    const best = bestToken(norm.slice(m.index + m[0].length), comp) || bestToken(norm.slice(0, m.index), comp);
    if (best) return best.slice(0, 28);
    // 中文模型名回退
    const seg = norm.slice(m.index + m[0].length)
      .replace(/^[了的]?\s*(全新|最新|新一代|新款|一款|多款|首款|开源|正式)?\s*/, '')
      .split(/[，。、：:；;（(！!？?]/)[0].trim();
    return seg.slice(0, 20);
  }
  const best = bestToken(norm, comp);
  return best ? best.slice(0, 28) : norm.split(/[，。、：:；;（(！!？?]/)[0].trim().slice(0, 20);
}

// 模型名可信度：含字母/数字，或较短的中文产品名；排除明显是「新闻/文案」的词
function validModel(model) {
  if (!model || BAD_MODEL.test(model)) return false;
  if (/[A-Za-z0-9]/.test(model)) return true;
  return model.length >= 2 && model.length <= 8;
}

// 模态分类（与前端/静态页色卡对齐：语言/视频/图像/语音/多模态/专用）
function detectType(text) {
  if (/多模态|全模态|统一.*(图像|视频|音频)/.test(text)) return '多模态';
  if (/视频|文生视频|图生视频/.test(text)) return '视频';
  if (/图像|文生图|图片|绘图|绘画/.test(text)) return '图像';
  if (/语音|音频|音乐|配音|\bTTS\b/i.test(text)) return '语音';
  if (/\bOCR\b|文档理解|嵌入|\bembed/i.test(text)) return '专用';
  if (/语言|对话|通用|推理|reasoning|编程|coding|\bcode\b/i.test(text)) return '语言';
  return '语言'; // 默认按语言模型处理（蓝色主色，AI 大模型主流）
}

// 关键规格：从摘要抽取参数量 / 上下文 / 开源 / 模态等，供普通级与里程碑卡片展示信息密度
function detectSpecs(text) {
  const s = [];
  let m;
  if ((m = text.match(/([\d.]+\s*万亿|[\d.]+\s*[BT]\b|[\d.]+\s*亿)\s*(?:总)?参数/i))) s.push(m[0].replace(/\s+/g, ''));
  else if ((m = text.match(/(?:总)?参数[量]?[约为:：\s]*([\d.]+\s*(?:[BT]|亿|万亿))/i))) s.push('参数 ' + m[1].replace(/\s+/g, ''));
  if (/百万\s*token|1M\s*token|百万上下文|百万\s*上下文/i.test(text)) s.push('百万 token 上下文');
  else if ((m = text.match(/([\d.]+\s*[kKmM万]?\s*token(?:\s*(?:上下文|窗口))?)/))) s.push(m[1].replace(/\s+/g, ''));
  if (/开源|开放权重/.test(text)) s.push('开源');
  if (/实时|全双工/.test(text)) s.push('实时');
  if (/端侧|设备端|手机上运行|本地运行/.test(text)) s.push('端侧');
  return [...new Set(s)].slice(0, 3);
}

// 权重分级：主流实验室的旗舰型号 → 里程碑；知名厂商或有硬规格 → 普通级（完整卡片）；其余 → 次要（一行）
const MAJOR_LAB = /openai|anthropic|google\s*deepmind|deepmind|\bmeta\b|深度求索|deepseek|月之暗面|阿里|字节|\bxai\b|智谱|腾讯|百度|快手|minimax|蚂蚁|nvidia/i;
const NOTABLE = /openai|anthropic|google|deepmind|\bmeta\b|deepseek|深度求索|月之暗面|kimi|阿里|通义|qwen|字节|豆包|\bxai\b|grok|智谱|\bglm\b|腾讯|混元|百度|文心|快手|可灵|kling|minimax|海螺|蚂蚁|nvidia|mistral|midjourney|black\s*forest|flux|stability|runway|\bpika\b|生数|面壁|商汤/i;
const FLAGSHIP = /claude\s*opus|gpt-?[56]\b|gpt\b.*\b[56]\b|gemini\s*[0-9]|deepseek\s*[vr]?[0-9]|llama\s*[0-9]|grok\s*[0-9]|kimi\s*k[0-9]|qwen[0-9\s-]*max|文心\s*[0-9]|ernie\s*[0-9]/i;

function decideTier(company, model, specs) {
  const hay = `${company} ${model}`;
  if (MAJOR_LAB.test(company) && FLAGSHIP.test(hay)) return 'milestone';
  if (NOTABLE.test(company) || NOTABLE.test(model) || specs.length >= 1) return 'normal';
  return 'minor';
}

// ── 合并模型候选（较宽松：来源已是日报「模型发布」板块的精选内容）──
function mergeModels() {
  const models = readJson('data/models.json', { updatedAt: today, entries: [] });
  const cands = readJson('data/model-candidates.json', []);
  const known = new Set(models.entries.map((e) => flat(e.model)).filter((m) => m.length >= 3));
  const keep = [];
  let added = 0;
  for (const c of cands) {
    const company = detectCompany(c.title);
    const model = detectModel(c.title, company);
    const mf = flat(model);
    if (!company || !validModel(model) || known.has(mf)) { keep.push(c); continue; }
    known.add(mf);
    const text = `${c.title} ${c.summary}`;
    const specs = detectSpecs(text);
    const tier = decideTier(company, model, specs);
    const entry = {
      date: c.date,
      company,
      model,
      type: detectType(text),
      specs: tier === 'minor' ? [] : specs, // 次要级压成一行，不展示规格
      highlight: firstClause(c.summary),
      sourceUrl: c.sourceUrl || '',
      sourceName: c.sourceName || '',
      tier,
      auto: true,
    };
    models.entries.push(entry);
    added++;
  }
  if (added) {
    models.updatedAt = today;
    models.entries.sort((a, b) => b.date.localeCompare(a.date));
    writeJson('data/models.json', models);
    writeJson('data/model-candidates.json', keep);
  }
  console.log(`models merged: +${added}, ${keep.length} left pending`);
}

// ── 合并融资候选（严格门槛：候选是关键词匹配、噪音多，必须同时具备 轮次 + 金额 + 公司）──
const AMOUNT = /(?:[\$￥]\s*)?[\d.]+\s*(?:亿|万)\s*(?:美元|美金|元|人民币)?/;
const ROUND = /(?:种子|天使|战略)\s*轮|Pre-?[A-F]\s*轮|[A-F]\+?\s*轮|Series\s*[A-Z]/i;

function detectFundCompany(title) {
  const m = title.match(/^\s*([^\s，。、：:（(]{2,16}?)\s*(?:近日|日前)?\s*(?:宣布|已)?\s*(?:完成|获得|获|新一?轮)?\s*(?:融资|募资|领投|获投)/);
  if (m) return m[1];
  for (const [re, name] of COMPANY) if (re.test(title)) return name;
  return '';
}
function detectSector(text) {
  if (/芯片|算力|GPU|数据中心|光模块/i.test(text)) return '芯片算力';
  if (/具身|机器人|人形/.test(text)) return '具身智能';
  if (/大模型|基础模型|foundation/i.test(text)) return '大模型';
  if (/数据|标注|向量|数据库/.test(text)) return '数据基础设施';
  if (/应用|助手|搜索|编程|视频|图像|音乐|Agent|智能体/i.test(text)) return '应用';
  return '其他';
}

function mergeFunding() {
  const fund = readJson('data/funding.json', { updatedAt: today, entries: [] });
  const cands = readJson('data/funding-candidates.json', []);
  const known = new Set(fund.entries.map((e) => flat(e.company)).filter((m) => m.length >= 2));
  const keep = [];
  let added = 0;
  for (const c of cands) {
    const text = `${c.title} ${c.summary}`;
    const amtM = text.match(AMOUNT);
    const roundM = c.title.match(ROUND) || c.summary.match(ROUND);
    const company = detectFundCompany(c.title);
    if (!amtM || !roundM || !company || known.has(flat(company))) { keep.push(c); continue; }
    known.add(flat(company));
    const valM = text.match(/估值\s*(?:[\$￥]\s*)?[\d.]+\s*(?:亿|万)?\s*(?:美元|元)?/);
    fund.entries.push({
      date: c.date,
      company,
      sector: detectSector(text),
      round: roundM[0].trim(),
      amount: amtM[0].trim(),
      valuation: valM ? valM[0].trim() : '',
      specs: [],
      highlight: firstClause(c.summary),
      tier: 'minor',
      auto: true,
      sourceName: c.sourceName || '',
      sourceUrl: c.sourceUrl || '',
    });
    added++;
  }
  if (added) {
    fund.updatedAt = today;
    fund.entries.sort((a, b) => b.date.localeCompare(a.date));
    writeJson('data/funding.json', fund);
    writeJson('data/funding-candidates.json', keep);
  }
  console.log(`funding merged: +${added}, ${keep.length} left pending`);
}

mergeModels();
mergeFunding();
