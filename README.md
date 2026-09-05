# Axewatch 🪓

Live NSE market data + Indian IPO subscription tracker + grey-market premium (GMP) dashboard.

> **Agents / contributors: read [AGENTS.md](AGENTS.md) before making any changes.**
> It documents the encoding rules, API contracts, rate-limit budget, and the
> mandatory verification gate that prevents the bugs this project already fixed once.

```
Axewatch/
├── backend/            FastAPI + APScheduler + SQLite
│   ├── main.py         API endpoints
│   ├── scheduler.py    refresh jobs (market 3min, GMP 30min)
│   ├── db.py           snapshot storage (SQLite)
│   └── fetchers/
│       ├── nse.py      cookie-warmed NSE session
│       ├── ipo.py      IPO list + QIB/NII/RII x-times
│       ├── mf.py       mutual-fund scheme master + NAV (mfapi.in)
│       ├── yahoo.py    stock price fallback (Yahoo chart API)
│       ├── news.py     per-stock news (Google News RSS)
│       └── gmp.py      GMP failover chain (IPOWatch -> IPOIndex -> InvestorGain)
└── frontend/           Vite + React + TS + Tailwind + TanStack Query
```

## Run it

Backend (terminal 1):

```powershell
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --port 8000 --reload
```

Frontend (terminal 2):

```powershell
cd frontend
npm install
npm run dev          # http://localhost:5173
```

Or run the whole stack in Docker (serves everything on one port):

```powershell
docker compose up -d --build   # http://localhost:3000
```

## API

| Endpoint | Data |
|---|---|
| `GET /api/market/status` | market open/close, NIFTY level |
| `GET /api/market/indices` | all sector indices |
| `GET /api/market/gainers` / `losers` | top NIFTY movers |
| `GET /api/index/{index}/stocks` | index constituents (60 s cache) |
| `GET /api/stock/{symbol}/quote` | per-stock OHLC / VWAP / 52w / volume (60 s cache; falls back to index-constituent scan when `quote-equity` is Akamai-blocked) |
| `GET /api/stock/{symbol}/outlook` | 10-day outlook: explainable technical score + trade plan (BUY/SELL/HOLD signal, ATR-based stop-loss, 1.5R/2.5R targets, historical timeframes) + two models (a global cross-sectional model trained in the background on ~100 NIFTY stocks x 5y over 52 features — walk-forward validated with calibration stats — plus a per-stock model) + news red flags (30 min cache) |
| `GET /api/outlook/model` | global model training status (stocks, samples, walk-forward accuracy, strong-BUY precision, pick spread, calibration buckets) |
| `GET /api/trades/ideas` | open model signals with live prices + quantities pre-sized to risk 0.5/1/2% of paper equity (90 s cache; SELL ideas are exit-only) |
| `GET/POST/DELETE /api/allotment/pans` | your saved PANs (local vault, always masked in responses) |
| `GET /api/allotment/issues` | check-worthy IPOs: active + closed in last 45 days with expected allotment dates |
| `POST /api/allotment/check` | check one PAN against one issue (or all) via MUFG Intime + KFintech; Bigshare uses its official manual CAPTCHA handoff |
| `POST /api/allotment/check-all` → `GET /api/allotment/job/{id}` | bulk check as a background job with progress |
| `GET /api/stock/{symbol}/news` | per-stock news feed via Google News RSS (15 min cache) |
| `GET/POST /api/portfolio/holdings` | your stock & mutual-fund holdings (local SQLite only) |
| `PUT /api/portfolio/holdings/{id}` | edit quantity / average price (e.g. after selling shares) |
| `DELETE /api/portfolio/holdings/{id}` | remove a holding |
| `GET /api/portfolio/stock/search?q=` | stock symbol autocomplete (NSE equity master, cached daily) |
| `POST /api/portfolio/import` | import stock holdings from CSV (Zerodha Console export or `symbol,quantity,avg_price`) |
| `GET /api/portfolio/mf/search?q=` | mutual-fund scheme search (mfapi.in master, cached daily) |
| `GET /api/mf/list?q=&page=` | all ~38k mutual fund schemes, 50 per page, fuzzy name search |
| `GET /api/mf/{code}/detail` | per-fund NAV (+1d change), category, fund house, asset mix equity/debt/cash, top holdings incl. debt instruments (5paisa), cached daily |
| `GET /api/portfolio/summary` | live valuation + allocation + auto-generated insights (60 s cache) |
| `GET /api/sources/health` | per-source scorecards: success rate, latency, circuit-breaker state, recent events |
| `GET /api/ipo/current` | active IPOs with total subscription x |
| `GET /api/ipo/upcoming` | upcoming IPOs |
| `GET /api/ipo/past` | past 60 days: issue/listing price, listing gain, plus the last recorded subscription split (QIB/SHNI/BHNI/NII/RII) per symbol |
| `GET /api/gmp` | live GMP table (auto-failover sources) |
| `GET /api/history/{kind}` | snapshot history for charts |
| `POST /api/admin/refresh` | force immediate refresh |

## Portfolio tracking

The **Portfolio** tab lets you track what you own and get automatic insights:

- **Stocks** — add by NSE symbol, or import your broker's holdings CSV
  (Zerodha Console's `Instrument,Qty.,Avg. cost` export works as-is, or a plain
  `symbol,quantity,avg_price` layout).
- **Mutual funds** — search ~38,000 schemes by name (fuzzy, handles renamed
  funds), add units + average NAV; valued at the latest NAV.
- **Insights** — live total P&L and today's move, stock-vs-fund allocation,
  per-holding weight, concentration warnings (top-5 share, single-stock risk),
  best/worst performers and daily movers.

## Paper trading & Trades

The **Trades** tab turns model signals into one-click paper orders: every open
BUY/SELL shows a live price, stop/targets and a quantity pre-sized so a
stopped-out trade costs 0.5%, 1% or 2% of your paper equity (your pick).
SELL ideas only exit shares you hold — paper accounts cannot short. The
**Portfolio** tab's paper-trading card holds the unified order ticket (market
or limit, same risk sizing), positions, equity curve and order history.
Starts at ₹10,00,000 of fake money; reset anytime.

## IPO allotment check

The **Allotment** tab checks whether your PAN got shares, without retyping it on
five different sites. Save each family member's PAN once (masked everywhere,
stored only in your local database), pick the issues, and run one bulk check:

- **Automated**: MUFG Intime and KFintech, queried directly. Each result is
  explicitly classified as **Allotted**, **Not allotted** (an application was
  found but received zero shares), **Not applied**, **Manual check**, or a
  temporary source error.
- **Manual fallbacks**: BSE, NSE and Bigshare all require image captchas (and
  block bots), so those open as guided deep links instead.
- Allotment is final once declared, so results are cached; recheck any row
  individually anytime.

**PAN privacy:** saved PANs live only in your local SQLite database, display
masked everywhere (`AB*****F`), are never written to logs, and are sent only
to the registrar being queried. The input masks typing by default. Before
publishing this code anywhere, note that `*.db`, local debug snapshots
(`mfd.json`, `sum_tmp.json`, …) and dev screenshots are already git-ignored —
never force-add them.

**Security model:** Axewatch never asks for your demat login, password, PIN or
OTP — there is no way to pull holdings directly from a demat account without a
regulated broker-API integration, and anything that asks for those credentials
should not be trusted. Instead you import a CSV export or add holdings manually.
Everything is stored in the local SQLite database inside your own Docker volume
(`/data/axewatch.db`) and is never sent to any third party. Prices are fetched
from public endpoints (NSE index data, Yahoo Finance, mfapi.in) — those requests
contain only symbols, never your quantities or identity.

## How the anti-bot layer works

- **Adaptive source health** (`fetchers/health.py`): every scraper records
  ok/fail/latency. Three consecutive transport failures put a source in an
  escalating cooldown (2 min doubling to 30 min) so failover chains route around
  it; a single success must not whitewash a flapping source (escalation memory
  decays only after 30 min quiet). If every source is cooling down, they are
  tried anyway — a slow retry beats no data. Visible on the GMP tab's
  "Data Sources" card and via `GET /api/sources/health`.

- One persistent `requests.Session`; homepage warm-up collects Akamai cookies (`nsit`, `ak_bmsc`)
- Browser-matching headers + per-endpoint `Referer`
- Min 6s between requests; exponential backoff + session re-prime on 401/403/429
- `content-type` check before JSON parse (maintenance pages return 200+HTML)
- No brotli encoding requested (`requests` cannot decode it)

**Deploy note:** run the backend from an Indian IP (your PC is fine; cloud VMs like AWS/GCP are usually blocked by NSE). The frontend can be hosted anywhere (Vercel/Cloudflare Pages) since it only talks to your API.

Data is for research only. Not investment advice.
