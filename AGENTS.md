# AGENTS.md — Axewatch Contributor & AI-Agent Guide

> **Read this file completely before changing anything.** Every rule below exists
> because a real bug was shipped, debugged, and fixed the hard way in this repo.
> If you skip a verification step in [§6](#6-mandatory-verification-gate-after-any-change),
> you will likely re-break something that was already fixed.

---

## 1. What this project is

Axewatch is a live dashboard for Indian market data:

| Feed | Source | Refresh |
|---|---|---|
| Market status, indices, gainers/losers | NSE internal JSON APIs (unofficial) | every **2 min** (APScheduler) |
| Active / upcoming IPOs + subscription x-times (QIB/NII/SHNI/BHNI/RII) | NSE `ipo-current-issue`, `all-upcoming-issues`, `ipo-detail` | every 2 min |
| Past IPOs with listing/opening price | NSE `public-past-issues` + IPOWatch performance table; `/api/ipo/past` attaches each symbol's latest `sub_{SYM}` snapshot (DB reads only, SME key variants tried) so closed issues show their recorded QIB/SHNI/BHNI/NII/RII split; IPO↔GMP join is client-side via `normIpoName` (strips corp suffixes + glued status words) | every 30 min |
| Grey Market Premium (GMP) | failover chain: **IPOWatch → IPOIndex → InvestorGain** | every 30 min |
| Index constituents (click an index card) | NSE `equity-stock-indices` (new endpoint; old `equity-stockIndices` is dead) | on demand, 60 s cache |
| Per-IPO subscription breakdown | NSE `ipo-detail` | on demand, 5 min cache |
| Per-stock quote (click any stock row) | NSE `quote-equity` single-shot (`equity_quote_light`); fallback scans major index constituents. Never route this through `get_json` retries — the re-prime cycle poisons the shared session cookies | on demand, 60 s cache |
| Per-stock news | Google News RSS (`fetchers/news.py`, NOT NSE, to spare the rate budget) | on demand, 15 min cache |
| Per-stock outlook | `backend/predict.py` + `fetchers/ta.py` (pure-python indicators, no numpy): explainable rule score + TWO models — a global cross-sectional logistic model trained in the background on ~100 NIFTY constituents x 5y of Yahoo bars (52 features: returns + relative-to-market + 60d beta/correlation, SMA-slope/RSI-slope/MACD-slope, stoch %D/cross, CCI/Williams/Donchian, gap/body/range-vs-ATR, ATR percentile, OBV/MFI/CMF/VWAP-distance/turnover-trend, up-day ratio/streak/skew; labels = beats NIFTY over next 10 days; walk-forward validated with embargo + calibration buckets, strong-BUY precision and pick-spread stats; weights persisted at `/data/outlook_model.json` with a feature-version guard that discards stale weights, retrained daily) and a per-stock model (3y slice). `_samples_from_bars` computes features via precomputed series (O(N)) — NEVER revert to per-bar slicing (O(N^2), stalled training once). Models only contribute when walk-forward accuracy >= 54%; the UI discloses actual accuracy. Trade plan (`_trade_plan`): signal = score bands (+/-20), stop = 2x ATR tightened to the 10-day floor with a max(1.2 ATR, 1.5%) minimum-risk floor, targets = 1.5R/2.5R, timeframes = median first-passage days from the stock's own history (`_first_passage_days`). News red flags via headline lexicon (resign/fired/probe/loss/downgrade/layoff/SEBI...); fundamentals intentionally absent (no reliable free source). Rendered in the stock modal's Outlook section | global: daily; outlook 30 min cache |
| Source health / circuit breaker | `fetchers/health.py` — all fetchers record ok/fail/latency; 3 consecutive transport failures = escalating cooldown (120 s ×2, cap 30 min, `Retry-After` honored); failover chains SKIP cooled sources but try anyway when ALL are cooled; "not found" (404/empty) is neutral, never a failure; one success clears the streak but NOT the escalation memory (flapping protection; memory decays after 30 min quiet) | live via `GET /api/sources/health` |
| Portfolio holdings + valuation | local SQLite `holdings` table (user data, NOT a snapshot kind); prices via Yahoo-first chain in `_stock_price_map` (`fetchers/yahoo.py`, throttled 0.4 s stagger — Yahoo 429s bursts), NSE index scan fallback; MF NAVs via mfapi (`fetchers/mf.py`, scheme master cached daily at `/data/mf_master.json`; note mfapi `/mf/search` matches whole words only, hence local master search); stock autocomplete via NSE `EQUITY_L.csv` master (`fetchers/nse.py`, cached daily at `/data/equity_master.csv`) with Yahoo search fallback | summary 60 s cache |
| Paper trading | local SQLite `paper_account` (cash, starts ₹10,00,000), `paper_positions`, `paper_orders`, `paper_limit_orders` tables; market orders fill instantly at the live `_stock_price_map` price; limit orders checked inside the 2-min market refresh (Yahoo chain per open order — no extra NSE calls); SELL realizes P&L into cash; `POST /api/paper/reset` wipes back to starting cash; `GET /api/trades/ideas` serves open model signals with live Yahoo-first prices + 0.5/1/2% risk-sized quantities for the Trades tab (SELL ideas are exit-only, capped at shares held; 90 s server cache) | account 30 s cache, invalidated on order |
| IPO allotment by PAN | `fetchers/allotment.py`: automated MUFG Intime (company list + AES-token PAN search, no captcha — verified live, incl. remembered company IDs: the dropdown rotates but SearchOnPan keeps answering old IDs, so lists merge into append-only `/data/mufg_company_ids.json`; one warmed session shared per PAN-run, one retry on transport blips only, never on throttle) and KFintech API (`?type=pan` with empty `client_id` exactly like their page; 200 = records / 400 = no record; success path inferred from their JS, label honestly). Bigshare, BSE and NSE stay as official manual links because their result searches require a user CAPTCHA. Outcomes distinguish `allotted` / `not_allotted` (applied, zero shares) / `not_applied` (no application on record) / `uncovered` (manual check needed). Registrar directory (MUFG API + public Bigshare dropdowns on all 3 mirror servers + ipomarket allotment tables for KFintech/SME registrars and declared allotment dates, 24 h cache) attributes each issue. IPO↔GMP name join: exact norm match, then ≥10-char substring fallback (`lookupNormMap`); `&` normalizes to "and" on both sides (backend + frontend must stay mirrors). Hand-checked results can be logged per row (`POST /api/allotment/manual`, source `manual`, user is ground truth) so captcha-walled issues resolve in the dashboard too. Live-audited: MUFG answers ~0.2s with PAN-specific records on all listed companies (differential-tested across PANs); KFintech stable (400 = no record, one retry on gateway wobbles); Bigshare captcha is server-enforced (dummy-token probe returns CAPTCHA error) — no bypass exists, attribution is the strategy. The Allotment tab shows a live Check-APIs health strip plus a registrar chip on every issue and result row. `pan_vault` + `allotment_results` tables; bulk checks run as background jobs (`POST /api/allotment/check-all` → poll `/api/allotment/job/{id}`); candidates = active + closed≤45d (6 h cache). **PII RULE: full PANs never appear in logs, API responses (masked only), or error messages — grep for this in review** | issues 6 h; directory 24 h; results persist (allotment is final); on-demand only, never scheduled |
| Signal tracker | every outlook BUY/SELL logged to `signal_log` (deduped per symbol; superseded on flip); scheduler resolves open signals hourly against real Yahoo bars once past horizon (stop/target first-touch, conservative same-bar = stop); win rate + R multiples at `GET /api/signals`; tracker card on Market tab | hourly job, 1 Yahoo call per open signal |
| Market page extras | Sector heat map (from cached allIndices, zero extra calls) · FII/DII card (`/api/fiidiiTradeNse` — found via the page's own `fii-dii.js`, old `/api/fiidii*` paths are 404) fetched 6-hourly into `fiidii` snapshots · candlestick charts (`/api/stock/{sym}/candles`, Yahoo OHLC, custom SVG renderer) · corporate announcements (`/api/corporate-announcements?index=equities&symbol=X`, 1 h cache) in the stock modal · "Take this trade" pre-fills a paper buy with the plan's stop/targets (BUY signals only) | fiidii 6 h; announcements 1 h; candles 5 min client cache |
| Live updates (SSE) | `GET /api/stream` pushes cached snapshot freshness every 12 s (reads SQLite MAX(fetched_at) — **zero extra NSE calls**); frontend EventSource hook invalidates TanStack Query keys per kind; polling stays as 60 s fallback; nginx needs `proxy_buffering off` on `/api/stream` (configured) | constant, DB reads only |
| Portfolio analytics | XIRR (bisection on holdings' created_at outflows + logged dividends + terminal value) and per-sector allocation in `/api/portfolio/summary`; sector via NSE quote-equity `industry` per symbol, persisted at `/data/sector_map.json` (≤12 NSE calls per rebuild for unknown symbols, throttled by the shared session); dividends CRUD at `/api/portfolio/dividends` | summary 60 s cache |
| Mutual fund explorer tab | `GET /api/mf/list` (master, 50/page, fuzzy search with partial-word fallback) + `GET /api/mf/{code}/detail`: NAV+prev via mfapi `/mf/{code}`; asset allocation (equity/debt/cash) parsed from moneycontrol fund page's embedded `__NEXT_DATA__`; TOP HOLDINGS from 5paisa fund pages — server-rendered HTML, slug derived from scheme name via `_name_to_slug` (`fetchers/mfholdings.py`), works for debt funds too (GSEC/TBILL/repo rows). Failed alternatives (all client-side-locked or Cloudflare-walled): Groww, ET Money API, Kuvera, ValueResearch, MC holdings tab. Detail disk-cached daily at `/data/mf_details/` (cache `_v: 2`) | list live; detail daily cache |

**Stack:** FastAPI + APScheduler + SQLite (backend) · Vite + React + TS + Tailwind v4 + TanStack Query + Recharts (frontend) · Docker Compose (nginx serves static frontend, proxies `/api`).

```
Axewatch/
├── backend/
│   ├── main.py            # ALL API endpoints. Envelope contract lives here (see §3)
│   ├── scheduler.py       # APScheduler jobs — DO NOT tighten intervals carelessly (§5)
│   ├── db.py              # SQLite snapshots; kind naming: "sub_{SYMBOL}", see §4. Also the `holdings` table (portfolio, user data)
│   └── fetchers/
│       ├── nse.py         # cookie-warmed NSE session (prime/retry/throttle). Shared by all NSE calls
│       ├── ipo.py         # IPO list + subscription parsing incl. SHNI/BHNI split (§7)
│       ├── mf.py          # mutual fund scheme master + NAV (mfapi.in; NOT NSE)
│       ├── yahoo.py       # stock price fallback (Yahoo chart API; 429-sensitive, stagger calls)
│       ├── news.py        # per-stock news (Google News RSS)
│       └── gmp.py         # GMP failover chain, status extraction, past-performance table
├── frontend/
│   ├── src/App.tsx        # tabs + theme toggle. ErrorBoundary wraps EVERY tab (do not remove)
│   ├── src/api.ts         # typed fetchers; Envelope<T> contract mirrors backend
│   ├── src/ErrorBoundary.tsx
│   ├── src/pages/{Market,Ipos,Gmp,Portfolio}.tsx
│   └── nginx.conf         # charset utf-8 is set here — keep it
└── docker-compose.yml     # port via AXEWATCH_PORT, default 3000
```

---

## 2. Rule #1 — FILE ENCODING (this broke the site twice)

**Never use PowerShell text pipelines (`Get-Content` / `Set-Content` / `-replace`) on any
source file in this repo.** Windows PowerShell 5.1 reads UTF-8-without-BOM as cp1252 and
writes it back silently corrupted. This converted every `₹`, `—`, `·`, `▲`, `▼`, `✕`, `ⓘ`
in JSX into mojibake (`â‚¹`, `â€"`, `Â·`, `â–²`…) that shipped to production twice.

**Allowed editing methods:**
- The code-aware Edit/Write tools, or
- Python scripts with explicit `open(path, encoding="utf-8")` read AND write.

**Non-ASCII whitelist for UI source files.** These are the ONLY non-ASCII characters
allowed in `frontend/src` (they are intentional UI glyphs):

```
₹ — – ‘ ’ “ ” … · ⓘ ▲ ▼ ▴ ▾ ✕ ☀ 🌙 → ×
```

If your edit introduces any other non-ASCII character, it is probably corruption.
Before finishing, audit with a script equivalent to:

```python
# every char > U+007F must be in the whitelist above; else fix by exact codepoint
ALLOWED = set("₹—–‘’“”…·ⓘ▲▼✕☀🌙")
bad = {c for c in open(fp, encoding="utf-8").read() if ord(c) > 0x7F and c not in ALLOWED}
```

Also: never write files with BOM (strip leading `\uFEFF`), and prefer `newline="\n"`.

**Symptom → cause cheat-sheet** (if you ever see these again):

| Rendered as | Actually is | UTF-8 bytes misread as cp1252 |
|---|---|---|
| `â‚¹` | ₹ | E2 82 B9 |
| `â€"` / `â€"` | — / ” | E2 80 94 / E2 80 9D |
| `â€“` | – | E2 80 93 |
| `â€¦` | … | E2 80 A6 |
| `â€“œ` style | “ “ quotes | E2 80 9C / variants |
| `â–²` / `â–¼` | ▲ / ▼ | E2 96 B2 / E2 96 BC |
| `âœ•` | ✕ | E2 9C 95 |
| `Â·` | · | C2 B7 |

The same hazard applies to **scrapers**: always set `r.encoding = "utf-8"` on every
`requests.get(...)` whose body you read as text (sites like IPOWatch omit charset headers;
`requests` then falls back to ISO-8859-1 and corrupts `₹` at scrape time). All fetchers in
`backend/fetchers/gmp.py` already do this — keep it that way for new sources.

---

## 3. Rule #2 — THE API ENVELOPE CONTRACT

Every `/api/*` endpoint MUST return:

```json
{ "kind": "<snake_case_name>", "fetched_at": <unix_seconds>, "data": { ... } }
```

Two endpoints once returned raw payloads (`{"count": ..., "series": ...}` without the
envelope). The frontend does `query.data.data.series` — the missing `.data` layer threw
`Cannot read properties of undefined`, React unmounted the entire app, and tab switching
white-screened the site.

Checklist when adding/modifying an endpoint:
1. Wrap payload under `"data"`.
2. Frontend fetcher in `api.ts`: type it as `Envelope<T>` and add a `.then()` fallback
   (`data: env.data ?? <empty default>`) so a bad payload can never crash a page.
3. Keep response field names matching the TS interfaces in `api.ts` exactly
   (`lastPrice`, `perChange`, etc. — a mismatch renders `—` instead of prices; this also
   happened once).
4. New snapshot kinds in SQLite follow existing naming: plain kinds
   (`market_status`, `all_indices`, `gainers`, `losers`, `gmp`, `ipo_current`,
   `ipo_upcoming`, `ipo_past_perf`) and per-symbol `sub_{SYMBOL}`.

---

## 4. Rule #3 — FRONTEND RESILIENCE

- `ErrorBoundary` wraps each of the three tabs in `App.tsx`. Never render a page outside
  it. A throw inside one section must degrade to an inline error card, never a white screen.
- All list rendering must guard optional fields (`x ?? "—"`) — GMP rows vary in shape per
  source (IPOWatch returns sparse rows; IPOIndex richer ones). The GMP table derives its
  columns from what actually has values.
- After ANY UI change: run the headless browser check (§6). Tab switching must produce
  **0 page errors**. This exact test caught the envelope bug above.

## 5. Rule #4 — NSE RATE LIMITS & ANTI-BOT ETIQUETTE

NSE blocks aggressively (Akamai). Current safe profile — do not exceed without thought:

- Scheduler: `refresh_market` every **2 min**, `refresh_gmp` every **30 min**
  (`backend/scheduler.py`).
- `NSESession` throttles to ≥6 s between requests, re-primes cookies on 401/403/429,
  and NEVER requests brotli (`accept-encoding: br`) because Python `requests` cannot
  decode it — responses come back as garbage. Keep those behaviors.
- Backend total load stays ~2 req/min against NSE's ~10 req/min bot threshold.
  If you add polling, account for it in that budget.
- The fetcher must run from an **Indian IP** (cloud ranges like AWS/GCP are usually blocked).
- Do not call NSE from browser/frontend code — CORS + IP bans. Frontend only talks to our API.
- On-demand caches: index stocks TTL 60 s, subscription TTL 300 s (in `main.py`). Don't lower them much.

## 6. MANDATORY VERIFICATION GATE (after ANY change)

Run all of these from the repo root before claiming done. Skipping steps = regressions.

```powershell
# 1. Typecheck + build frontend (catches contract drift)
cd frontend; npm run build; cd ..

# 2. Rebuild + restart stack
docker compose up -d --build

# 3. Headless browser: click through ALL tabs, count JS errors (must be 0),
#    scan rendered text for mojibake chars (â / Ã / U+201A), confirm ₹ renders,
#    exercise interactive bits you touched (tab switch, row click, sort header).
#    A ready-made script pattern exists in git history: frontend/repro.mts /
#    verify.mts (Playwright chromium is already installed in frontend/).
node frontend/verify.mts
```

For UI changes, additionally take a Playwright screenshot of the changed view and
actually LOOK at it (screenshots caught what DOM checks missed).

Then update docs if you touched contracts: README.md (user-facing), DEPLOY.md (ops),
and the tables in §1 of this file.

## 7. Reviewer checklist (for any agent reviewing an agent's work)

- [ ] No PowerShell-written source files (check `git diff` for mojibake sequences: `â € Â`)
- [ ] Non-ASCII audit passes on all touched `frontend/src` files
- [ ] New endpoints return the §3 envelope; `api.ts` types match field-for-field
- [ ] No full PANs in logs, responses, or errors (masked `AB*****F` only) if touching allotment
- [ ] ErrorBoundary still wraps all three tabs
- [ ] Scheduler intervals unchanged or justified against §5 budget
- [ ] Any new scraper sets `r.encoding = "utf-8"` and has a failover story
- [ ] `npm run build` clean under strict TS
- [ ] Headless tab-click test: 0 errors, ₹ present, no mojibake
- [ ] Screenshot reviewed for UI changes
- [ ] README/DEPLOY updated if behavior/ports/endpoints changed

## 8. Known-good facts (verify these if behavior seems off)

- Site: `http://localhost:3000` (compose default). Dev mode alternative: uvicorn :8000 + vite :5173 with vite proxy.
- NSE old IPO APIs (`ipo-central-*`, `equity-stockIndices`) are dead — current live
  endpoints are listed in §1 and implemented in `fetchers/nse.py` / `fetchers/ipo.py`.
- **NSE field values rarely match plain English — never filter on assumed strings.**
  Verified vocabulary (each mismatch here shipped a bug once):
  - IPO status (`all-upcoming-issues`): `Active`, `Closed`, **`Forthcoming`** (= not yet
    open; there is NO "Upcoming" value). Upcoming list = status contains "forthcom".
  - Endpoint naming flips casing randomly: `equity-stock-indices` (live) vs
    `equity-stockIndices` (dead); `/ipo-current-issue` (no "s", no "central").
  - Subscription categories in `ipo-detail.bidDetails` have NO space before `(Bid`
    and spell out amounts ("Bid amount of more than Ten Lakh Rupees") — match with
    regex on the lowercased string, and remember Ten Lakh = BHNI (big), Two-to-Ten
    Lakh = SHNI (small).
  - When adding any new NSE field filter, first dump one real response
    (`python -c "..."` against the live endpoint) and filter on observed values.
- SHNI/BHNI mapping (SEBI): Retail ≤ ₹2L; **SHNI > ₹2L up to ₹10L** ("more than Two Lakh…");
  **BHNI > ₹10L** ("more than Ten Lakh"). NSE category strings have NO space before `(Bid`,
  so parse with regex, not `startswith("... (")`.
- GMP ordering contract: Open → Upcoming → Closed → Listed, GMP descending inside groups;
  statuses parsed from a Status column OR name suffixes ("Augmont EnterprisesOPEN").
- `docker compose logs -f backend` shows refresh cycle health; DB lives in the named
  volume at `/data/axewatch.db` (env `AXEWATCH_DB`), survives rebuilds.
