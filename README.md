# 飞翔的 AI 资讯站

[线上网站](https://yehloo-ai.github.io/ai-news-station/) · [日报归档](https://yehloo-ai.github.io/ai-news-station/daily/) · [来源与纠错](https://yehloo-ai.github.io/ai-news-station/about/) · [RSS](https://yehloo-ai.github.io/ai-news-station/feed.xml)

静态资讯站，保留 PC 侧栏与移动端五个入口：日报、精选、动态、大事记、工具库。不需要数据库或浏览器端跨域代理。

## 数据与更新

- 日报的唯一来源是 `data/daily/YYYY-MM-DD.json`。首页的 `daily-latest.json`、HTML 归档和分享图都由同一份快照生成。上游返回的日期必须与请求一致。
- 日报每天计划抓取三次；资讯频道每小时计划抓取。GitHub Actions 排程与上游发布均可能延迟，不承诺实时或准点。
- 精选是自动汇总，不代表逐条人工推荐。英文标题与摘要在构建端离线翻译成中文，按原文哈希缓存；卡片标注“机译”，保留原文字段与来源链接。翻译失败保留内容并标注“待翻译”，不把错误响应当译文。浏览器不发翻译请求。
- 抓取使用明确超时与 HTTP 检查，RSS/API 结构不符会记录失败；每个源保留上次有效结果。状态保存在 `data/source-health.json`，原始缓存保存在 `data/source-cache.json`。
- 数据源返回错误、HTML 或空结果不会被当成有效新资讯覆盖旧频道；故障可能影响覆盖范围，不代表网站已获得所有来源的最新内容。
- 工具价格和地区信息不是实时计费查询，以官网为准。未核验的字段不要填写虚假的核验时间。

## 审核流程

模型、融资的自动抽取只进入 `data/model-candidates.json`、`data/funding-candidates.json`，不会自动发布。

审核候选时需要提供 `status: "approved"`、`reviewedBy`、`reviewedAt`（YYYY-MM-DD）、原文证据 `evidence`，以及规范化的 `entry`。模型需要公司、型号、日期、类型、事件类型（release/update）、信源名称与 URL；融资需要公司、日期、轮次、金额、币种、信源名称与 URL。估值与融资金额不得混用。

`node scripts/merge-candidates.mjs` 只接受上述字段齐全的记录。按事件而不是只按公司去重；同公司的后续轮次可以新增。没有被接收的记录保留原因，不自动丢弃旧候选。

历史明显错配记录保存在 `data/review/`；其他历史自动记录显示待复核，不再自动标成里程碑。修正记录时应回到原文核对，不能仅凭标题猜测。

## 开发与检查

Node 22、Python 3.11。依赖版本在 lockfile / requirements.txt 中固定。

```sh
npm ci
python -m pip install -r requirements.txt
npm test
python -m unittest discover -s tests -p '*_test.py'
npx playwright install chromium webkit
TEST_WEBKIT=1 npm run test:browser
npm run build
python -m http.server 8765
```

打开 http://localhost:8765/。请通过 HTTP 服务预览；直接双击 `index.html` 的 file URL 不适用于 JSON fetch。

测试覆盖日期一致性、同源请求缓存、失败刷新、候选审核、跨时区排序、内部链接、PC/窄屏布局、快速日期切换、筛选恢复、返回导航、PNG 导出。浏览器测试默认屏蔽第三方请求，不能代替真实网络、微信或邮件送达测试。

## 文件结构

频道工作流安装 `requirements-translation.txt`，下载并校验固定版本 Argos en-zh 1.9 模型，再用 CTranslate2 在 CPU 上生成中文。约 68 MB 的模型保存在专用 GitHub Release 与 Actions 缓存，不进入源码历史、不增加网页下载体积。依赖或模型不可用时，现有译文仍从 `data/translations.json` 复用；模型准备失败会让任务明确报错，不把缓存回退冒充翻译服务正常。

本地回填已有频道（保留原 `updated` 时间）：

```sh
python -m pip install -r requirements-translation.txt
export TRANSLATE_MODEL_DIR=/tmp/ai-station-en-zh
python scripts/setup_translation.py
python scripts/translate_channels.py
```

模型来源：[Argos Translate](https://github.com/argosopentech/argos-translate)；推理方式：[CTranslate2](https://opennmt.net/CTranslate2/quickstart.html)。模型原样再分发，原始 OPUS 模型采用 CC-BY 4.0；保留包内署名以及 Release 中对 Jorg Tiedemann 和 Santhosh Thottingal、EAMT 2020 论文的归属说明。机器翻译可能误译术语，不等同于内容事实审核；纠正译文时同时更新原文哈希对应的缓存。

- `index.html`：静态壳、预渲染日报、元信息。
- `assets/station-core.js`：前后端共享的 schema、安全输出、日期和缓存工具。
- `assets/app.js`：现有导航、视图与交互。历史隐藏频道尚未删除，避免破坏旧依赖。
- `assets/station-base.css`、`station.css`：原有样式及修复层，可分别缓存。
- `daily-share/`：按日期读取快照，导出 PNG，按浏览器能力提供系统分享。
- `scripts/`：采集、构建、审核合并、验证与受控提交。
- `tests/`：Node/Python 单元测试和 Playwright 回归。

## 发布与统计

写回数据的工作流使用同一并发组、明确的文件范围、发布前验证和非强制 rebase/push。人工代码提交触发回归检查；GitHub Pages 的实际部署结果以 Actions 为准。

`admin.html` 仅链接到 Umami/百度统计的真实登录页。前端口令不构成权限保护，`data/stats.json` 不再包含统计数据，定时公开导出已停止。手动统计脚本要求输出到仓库外，切勿提交到公开站点。此前已公开的历史提交不会因这次修改自动消失；需要单独评估历史清理和服务商分享权限。

[本次修复记录与边界](docs/REPAIR-2026-09-16.md)
