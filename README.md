# AI News Station

**Live →** [yehloolau-afk.github.io/ai-news-station/](https://yehloolau-afk.github.io/ai-news-station/)

**📊 Dashboard →** [admin.html](https://yehloolau-afk.github.io/ai-news-station/admin.html) (owner-only, passcode protected)

**📰 AI Daily archive →** [daily/](https://yehloolau-afk.github.io/ai-news-station/daily/) (static pages crawlable by search & AI engines, rebuilt 3×/day via Actions)

**🕐 AI model release timeline →** [timeline/](https://yehloolau-afk.github.io/ai-news-station/timeline/) (who, which model, when, key specs — auto-merged from the daily digest and weight-tiered)

**💰 AI funding timeline →** [funding/](https://yehloolau-afk.github.io/ai-news-station/funding/) (who raised, which round, how much, valuation — from 2023 onward)

**🧰 AI tools directory →** [tools/](https://yehloolau-afk.github.io/ai-news-station/tools/) (curated AI tools by scenario, filterable, CN + overseas, crawlable SEO page)

**📡 RSS →** [feed.xml](https://yehloolau-afk.github.io/ai-news-station/feed.xml)

An AI news aggregator built for design teams. Pulls from 20+ Chinese and English sources, auto-translates, and updates every hour via GitHub Actions. Content is organized into three sidebar groups — **Daily Brief**, **Milestones** (model + funding timelines), and **Tools** — with priority-weighted timeline cards.

---

## Structure

The sidebar is organized into three groups:

| Group | Channel | What you get |
|---|---|---|
| **Daily Brief** | Daily Brief (日报速览) | Today's digest — 2-minute read |
| | Featured | Curated highlights worth your attention |
| | All Updates (全部动态) | Every article, cross-filterable by source × topic |
| **Milestones** | Model Releases | AI model release timeline — who, which model, when, key specs |
| | Funding | AI funding timeline — who raised, which round, how much, valuation |
| **Tools** | AI Tools Directory | Curated AI tools by scenario, filterable, CN + overseas |

**Priority-weighted cards** — timeline and funding entries render at one of three visual weights (milestone / normal / minor) based on the lab's prominence, whether it's a flagship release, and how much structured detail (params, context window, open-source, deal size) is available, so headline events stand out and minor ones stay compact.

**Static, crawlable pages** — `daily/`, `timeline/`, `funding/`, and `tools/` are pre-generated as standalone HTML with JSON-LD and are listed in `sitemap.xml`, so search and AI engines can index the content directly.

---

## Sources

**Chinese media (auto-translated):** Quantum Bit · Aifaner · Geek Park · Sspai · Synced · Huxiu · 36Kr

**English media:** The Verge · TechCrunch · Wired · VentureBeat · OpenAI Blog · Anthropic · Google DeepMind · MIT Technology Review

---

## How it works

- GitHub Actions fetches and processes articles every hour
- Single HTML file reads the generated JSON data — no server needed
- Chinese articles are auto-translated via language detection

```
GitHub Actions (hourly) → fetch RSS/APIs → process + translate → write JSON → static site serves it
```

### Data pipelines (all run as Actions in this repo)

| Workflow | Frequency | Output |
|---|---|---|
| Update channel data | Hourly | `data/{featured,all,official,products,design,videos}.json` + `feed.xml` (same-origin fast data layer for first paint) |
| Build daily static pages | 3×/day | Permanent `daily/*.html` archive + `sitemap.xml` (GEO/SEO crawl layer, reused by the in-app Daily channel). Also extracts model-release / funding candidates from the daily digest, **auto-merges** them into `data/models.json` & `data/funding.json` (`scripts/merge-candidates.mjs` — heuristic company/model/spec parsing + weight tiering; models merged liberally, funding gated on round + amount), then rebuilds the `timeline/`, `funding/`, and `tools/` static pages |
| Update analytics | 2×/day | `data/stats.json` (dashboard) |

### Loading strategy

- First paint uses `<link rel="preload">` for the Featured data — one same-origin JSON request, no CORS proxy dependency
- Stale-while-revalidate when static data is expired: show cached content first, refresh in the background via the RSS proxy path
- Desktop prefetches all channels in the background; mobile does a light prefetch (same-origin static JSON + today's daily only, no proxy, saves bandwidth)
- The Daily channel reads historical dates straight from the in-repo permanent archive, unaffected by the upstream API's 10-day retention limit

### Mobile

- Bottom tab navigation (Daily · Featured · Updates · Model Releases · More) + a "More" sheet (AI Tools Directory + entries for Daily archive / newsletter / dashboard)
- Translation is deferred so it never blocks first paint; Phase 2 payload is halved

---

## Stack

- Single HTML file — no framework, no backend
- GitHub Actions for scheduled data updates
- Deployed on GitHub Pages

`Claude Code` · `Vanilla HTML / CSS / JS` · `GitHub Actions` · `GitHub Pages`

---

## Analytics & dashboard

The site wires in two analytics providers and ships a self-hosted aggregated dashboard.

### Dashboard

- URL: [yehloolau-afk.github.io/ai-news-station/admin.html](https://yehloolau-afk.github.io/ai-news-station/admin.html) (a small "📊 Site data" entry sits at the bottom of the sidebar; the page is set to `noindex`)
- Requires a passcode. The passcode itself is **not** committed — only its SHA-256 hash lives in `PASS_HASH` inside `admin.html`, and it only keeps casual visitors out.
- One screen: today / last-30-day visitors and pageviews, 30-day trend chart, domestic vs. overseas split, referrers, and domestic referrer types (Baidu Tongji, pending).

**Change the passcode** — run this in the browser console:
`crypto.subtle.digest('SHA-256', new TextEncoder().encode('new-passcode')).then(b=>console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))`
Replace `PASS_HASH` in `admin.html` with the output.

### Pipeline

```
GitHub Actions (daily, 09:30 / 21:30 Beijing time)
  → scripts/fetch-stats.mjs pulls from Umami / Baidu Tongji
  → writes data/stats.json and commits
  → admin.html reads and renders
```

- Manual refresh: repo Actions tab → "Update analytics" → Run workflow
- Umami uses the read-only share-link endpoint (the free plan has no API key); the share ID is stored in the repo secret `UMAMI_SHARE_ID`
- ⚠️ If the site's Share link is deleted in the Umami dashboard, the pull will fail. Recreate the Share and update the secret with `gh secret set UMAMI_SHARE_ID` (the new share ID is the segment after `/share/` in the link).

### The two analytics backends

| Backend | Purpose | Entry |
|---|---|---|
| Umami | All visitors worldwide: trend, country distribution, referrers | https://cloud.umami.is |
| Baidu Tongji | Domestic channel detail: Baidu Search, WeChat, Zhihu, etc. | https://tongji.baidu.com |

Both tracking scripts sit just before `</head>` in `index.html`.

### Wiring up the Baidu Tongji API (TODO)

The dashboard's "domestic referrer types" panel shows "not configured" because Baidu's Data Export Service has a gate: **the site's previous-day PV must exceed 100**. Once traffic clears that bar:

1. Baidu Tongji → Settings → Other Settings → **Data Export Service** → enable, and get an API Key + Secret Key
2. Open the authorization URL in a browser to obtain a code:
   `http://openapi.baidu.com/oauth/2.0/authorize?response_type=code&client_id={API_KEY}&redirect_uri=oob&scope=basic&display=popup`
3. Exchange the code for a refresh token:
   `http://openapi.baidu.com/oauth/2.0/token?grant_type=authorization_code&code={CODE}&client_id={API_KEY}&client_secret={SECRET_KEY}&redirect_uri=oob`
4. Set three repo secrets: `BAIDU_API_KEY`, `BAIDU_SECRET_KEY`, `BAIDU_REFRESH_TOKEN` (the refresh token is valid for ten years)

`scripts/fetch-stats.mjs` already contains the Baidu fetch logic — once the secrets are set it takes effect on the next run, no code change needed.

---

Star this if it is useful to you.
