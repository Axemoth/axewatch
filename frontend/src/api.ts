export interface Envelope<T> {
  kind: string;
  fetched_at: number;
  data: T;
}

export interface MarketStatus {
  marketState: {
    market: string;
    marketStatus: string;
    tradeDate: string;
    index: string;
    last: number;
    variation: number;
    percentChange: number;
  }[];
}

export interface IndexRow {
  index: string;
  last: number;
  open: number;
  high: number;
  low: number;
  percentChange: number;
}

export interface IndicesData {
  data: IndexRow[];
}

export interface MoverRow {
  symbol?: string;
  series?: string;
  identifier?: string;
  priority?: number;
  ltp?: number;
  open_price?: number;
  high_price?: number;
  low_price?: number;
  prev_price?: number;
  net_price?: number;
  perChange?: number;
  trade_quantity?: number;
  turnover?: number;
  meta?: Record<string, unknown>;
}

export interface IpoRow {
  symbol: string | null;
  name: string | null;
  series: string | null;
  status: string | null;
  open_date: string | null;
  close_date: string | null;
  price_band: string | null;
  issue_size_shares: number | null;
  total_x: number | null;
  bids_received: string | null;
}

export interface SubscriptionDetail {
  symbol: string;
  total_x: number | null;
  qib?: number | null;
  nii?: number | null;
  shni?: number | null;
  bhni?: number | null;
  rii?: number | null;
  employees?: number | null;
}

export interface SubscriptionHistoryPoint {
  t: number;
  total_x: number | null;
  qib: number | null;
  nii: number | null;
  rii: number | null;
}

export interface GmpRow {
  name?: string | null;
  gmp?: string | null;
  gmp_percent?: string | null;
  trend?: string | null;
  price?: string | null;
  est_listing?: string | null;
  dates?: string | null;
  sub_x?: string | null;
  type?: string | null;
  status?: string | null;
  updated?: string | null;
  source?: string | null;
}

export interface GmpPayload {
  rows: GmpRow[];
  source_used: string | null;
  count: number;
  fetched_at: string;
}

export interface PastIpoRow {
  symbol: string | null;
  name: string | null;
  open_date: string | null;
  close_date: string | null;
  listing_date: string | null;
  price_band: string | null;
  issue_price: number | null;
  gmp: string | null;
  listing_price: number | null;
  listing_gain_pct: number | null;
  sub: PastIpoSub | null;
  sub_asof: number | null;
}

export interface PastIpoSub {
  total_x: number | null;
  qib?: number | null;
  nii?: number | null;
  shni?: number | null;
  bhni?: number | null;
  rii?: number | null;
  employees?: number | null;
}

/** Best-effort join key between NSE IPO names ("AUGMONT ENTERPRISES LIMITED",
 *  "TEMPSENS INSTRUMENTS (INDIA) LIMITED") and GMP tracker names
 *  ("Augmont EnterprisesOPEN"). Strips corporate suffixes and glued-on status
 *  words, then compares the bare core. Applied to BOTH sides, so stripping
 *  is consistent even when it over-trims. Mirrors backend canon_ipo_name. */
export function normIpoName(name?: string | null): string {
  let s = (name ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]/g, "");
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s
      .replace(/(open|closed|upcoming|listed|live|active|forthcoming)$/, "")
      .replace(/(sme|ipo|limited|ltd|pvt|private|india)$/, "");
    if (s === before) break;
  }
  return s;
}

/** Lenient IPO-name match for NSE's truncated names ("Gaja Alternative" vs
 *  "Gaja Alternative Asset Management"). Exact norm match first; otherwise a
 *  containment that needs at least 10 shared characters to avoid collisions
 *  on short names. */
export function ipoNamesMatch(a?: string | null, b?: string | null): boolean {
  const na = normIpoName(a);
  const nb = normIpoName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const short = na.length < nb.length ? na : nb;
  const long = na.length < nb.length ? nb : na;
  return short.length >= 10 && long.includes(short);
}

/** Map lookup with the same lenient fallback (for pre-indexed norm maps). */
export function lookupNormMap<T>(map: Map<string, T>, name?: string | null): T | undefined {
  const key = normIpoName(name);
  const exact = map.get(key);
  if (exact !== undefined || !key) return exact;
  for (const [k, v] of map) {
    if (k.length >= 10 && key.length >= 10 && (k.includes(key) || key.includes(k))) return v;
  }
  return undefined;
}

export interface GmpTrendSeries {
  name: string;
  status?: string | null;
  current: number | null;
  first: number | null;
  trend: "up" | "down" | "flat";
  points: { t: number; value: number }[];
}

export interface IndexStockRow {
  symbol: string;
  identifier?: string;
  lastPrice?: number;
  pChange?: number;
  change?: number;
  open?: number;
  dayHigh?: number;
  dayLow?: number;
  previousClose?: number;
  yearHigh?: number;
  yearLow?: number;
  totalTradedVolume?: number;
  perChange30d?: number;
}

export interface IndexStocksData {
  data: IndexStockRow[];
  timestamp?: string;
  marketStatus?: unknown;
}

export interface StockQuote {
  symbol: string;
  name?: string | null;
  series?: string | null;
  isin?: string | null;
  last_updated?: string | null;
  last_price?: number | null;
  change?: number | null;
  p_change?: number | null;
  open?: number | null;
  day_high?: number | null;
  day_low?: number | null;
  prev_close?: number | null;
  vwap?: number | null;
  week_high?: number | null;
  week_low?: number | null;
  total_traded_volume?: number | null;
}

export interface NewsItem {
  title: string;
  link: string;
  published?: string | null;
  source?: string | null;
}

export interface StockNewsData {
  symbol: string;
  items: NewsItem[];
}

export interface OutlookFactor {
  category: string;
  label: string;
  contribution: number;
  detail: string;
}

export interface OutlookCategory {
  name: string;
  score: number;
}

export interface OutlookModel {
  prob_up: number | null;
  walk_forward_accuracy?: number | null;
  walk_forward_auc?: number | null;
  test_accuracy?: number | null;
  test_auc?: number | null;
  n_samples?: number;
  n_test?: number | null;
  buckets?: ModelBucket[] | null;
  long_precision?: number | null;
  long_n?: number | null;
  spread_bps?: number | null;
  base_rate?: number | null;
  n_train?: number;
  has_edge: boolean;
  horizon_days: number;
  note: string | null;
}

export interface NewsFlag extends NewsItem {
  why: string;
}

export interface OutlookSentiment {
  score: number;
  positive_count: number;
  negative_count: number;
  red_flags: NewsFlag[];
  positives: NewsFlag[];
}

export interface GlobalModelStatus {
  status: string;
  training: boolean;
  n_stocks: number | null;
  n_samples: number | null;
  walk_forward_accuracy: number | null;
  walk_forward_auc: number | null;
  feature_version: number | null;
  n_features: number | null;
  n_test: number | null;
  buckets: ModelBucket[];
  long_precision: number | null;
  long_n: number | null;
  spread_bps: number | null;
  base_rate: number | null;
  has_edge: boolean;
  trained_at: number | null;
  error: string | null;
}

export interface ModelBucket {
  lo: number;
  hi: number;
  n: number;
  acc: number | null;
}

export interface TradePlan {
  signal: "BUY" | "SELL" | "HOLD";
  no_trade: boolean;
  direction: string | null;
  strength: number;
  entry: number;
  stop: number | null;
  stop_pct: number | null;
  target_1: number | null;
  target_1_pct: number | null;
  target_2: number | null;
  target_2_pct: number | null;
  reward_risk: number | null;
  target_days: number | null;
  stop_days: number | null;
  risk_per_share?: number | null;
  suggested_qty_per_1k_risk?: number | null;
  suggested_qty_1pct_paper?: number | null;
  nearest_sr?: number | null;
  reason?: string;
  method: string;
  note: string;
}

export interface StockOutlook {
  symbol: string;
  horizon_days: number;
  verdict: { label: string; color: string; score: number; confidence: number };
  trade_plan: TradePlan | null;
  model: OutlookModel | null;
  global_model: GlobalModelStatus | null;
  model_note: string | null;
  rule: { score: number; factors: OutlookFactor[]; categories: OutlookCategory[] };
  sentiment: OutlookSentiment | null;
  market: Record<string, number | null>;
  features: Record<string, number | null>;
  disclaimer: string;
}

export interface Holding {
  id: number;
  asset_type: "stock" | "mf";
  symbol: string;
  name: string;
  quantity: number;
  avg_price: number;
}

export interface SummaryRow extends Holding {
  last_price?: number | null;
  prev_price?: number | null;
  day_high?: number | null;
  day_low?: number | null;
  week_high?: number | null;
  week_low?: number | null;
  price_source?: string | null;
  invested?: number;
  value?: number | null;
  pnl?: number | null;
  pnl_pct?: number | null;
  day_pnl?: number | null;
  day_change_pct?: number | null;
  weight_pct?: number | null;
}

export interface PortfolioTotals {
  invested: number;
  value: number | null;
  pnl: number | null;
  pnl_pct: number | null;
  day_pnl: number | null;
  by_type: Record<string, number>;
  count: number;
  xirr_pct?: number | null;
  dividends_total?: number;
}

export interface PortfolioInsight {
  kind: string;
  text: string;
}

export interface PortfolioSummary {
  holdings: SummaryRow[];
  totals: PortfolioTotals;
  insights: PortfolioInsight[];
  sector_alloc?: Record<string, number>;
}

export interface CandleBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface SignalRow {
  id: number;
  symbol: string;
  signal: "BUY" | "SELL";
  score: number;
  entry: number;
  stop: number | null;
  target_1: number | null;
  target_2: number | null;
  horizon_days: number;
  planned_at: number;
  resolved: number;
  outcome: string | null;
  exit_price: number | null;
  r_multiple: number | null;
  resolved_at: number | null;
}

export interface SignalsPayload {
  open: SignalRow[];
  recent: SignalRow[];
  stats: {
    resolved: number;
    wins: number;
    losses: number;
    expired: number;
    win_rate_pct: number | null;
    total_r: number | null;
    avg_r: number | null;
    profit_factor?: number | null;
    avg_win_r?: number | null;
    avg_loss_r?: number | null;
  };
}

export interface FiiDiiRow {
  category: string;
  date: string;
  buyValue: string;
  sellValue: string;
  netValue: string;
}

export interface AnnouncementRow {
  date: string | null;
  headline: string;
  file: string | null;
}

export interface DividendRow {
  id: number;
  symbol: string;
  amount_total: number;
  ex_date: string | null;
  note: string | null;
  ts: number;
}

export interface LimitOrderRow {
  id: number;
  side: "BUY" | "SELL";
  symbol: string;
  name: string;
  quantity: number;
  limit_price: number;
  status: "OPEN" | "FILLED" | "CANCELLED";
  created_at: number;
  filled_at: number | null;
  filled_price: number | null;
  note: string | null;
}

export interface MfScheme {
  code: string;
  name: string;
}

export interface StockSuggestion {
  symbol: string;
  name: string;
}

export interface SourceHealthRow {
  name: string;
  state: "ok" | "degraded" | "cooling";
  ok: number;
  fail: number;
  neutral: number;
  success_rate: number | null;
  avg_latency_ms: number;
  consecutive_failures: number;
  cooldown_remaining_s: number;
  last_error: string | null;
  last_ok_ts: number | null;
}

export interface SourceHealthData {
  sources: SourceHealthRow[];
  events: {
    ts: number;
    source: string;
    ok: boolean;
    neutral?: boolean;
    status?: number | null;
    latency_ms: number;
    error: string | null;
  }[];
}

export interface MfListData {
  items: MfScheme[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

export interface MfAlloc {
  equity: number | null;
  debt: number | null;
  cash: number | null;
  other: number | null;
  category?: string | null;
  sub_category?: string | null;
}

export interface MfHolding {
  name: string;
  pct: number;
}

export interface MfDetail {
  code: string;
  name: string | null;
  category: string | null;
  fund_house: string | null;
  nav: number | null;
  nav_prev: number | null;
  nav_date: string | null;
  alloc: MfAlloc | null;
  alloc_source: string | null;
  top_holdings: MfHolding[] | null;
  holdings_source: string | null;
}

async function get<T>(url: string): Promise<Envelope<T>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

export const fetchMarketStatus = () => get<MarketStatus>("/api/market/status");
export const fetchIndices = () => get<IndicesData>("/api/market/indices");
export const fetchGainers = () => get<Record<string, { data: MoverRow[] }>>("/api/market/gainers");
export const fetchLosers = () => get<Record<string, { data: MoverRow[] }>>("/api/market/losers");
export const fetchCurrentIpos = () => get<{ ipos: IpoRow[] }>("/api/ipo/current");
export const fetchUpcomingIpos = () => get<{ ipos: IpoRow[] }>("/api/ipo/upcoming");
export const fetchPastIpos = () =>
  get<{ count: number; ipos: PastIpoRow[] }>("/api/ipo/past").then((env) => ({
    ...env,
    data: env.data ?? { count: 0, ipos: [] as PastIpoRow[] },
  }));
export const fetchSubscription = (symbol: string) =>
  get<SubscriptionDetail>(`/api/ipo/subscription/${symbol}`);
export const fetchSubscriptionHistory = (symbol: string) =>
  get<{ symbol: string; points: SubscriptionHistoryPoint[] }>(
    `/api/ipo/${symbol}/history`
  ).then((env) => ({
    ...env,
    data: env.data ?? { symbol, points: [] as SubscriptionHistoryPoint[] },
  }));
export const fetchGmpTrends = () =>
  get<{ count: number; series: GmpTrendSeries[] }>("/api/gmp/trends").then(
    (env) => ({
      ...env,
      data: env.data ?? { count: 0, series: [] as GmpTrendSeries[] },
    })
  );
export const fetchGmp = () => get<GmpPayload>("/api/gmp");
export const fetchIndexStocks = (index: string) =>
  get<IndexStocksData>(`/api/index/${encodeURIComponent(index)}/stocks`);
export const fetchStockQuote = (symbol: string) =>
  get<StockQuote>(`/api/stock/${encodeURIComponent(symbol)}/quote`).then((env) => ({
    ...env,
    data: env.data ?? { symbol },
  }));
export const fetchStockNews = (symbol: string) =>
  get<StockNewsData>(`/api/stock/${encodeURIComponent(symbol)}/news`).then((env) => ({
    ...env,
    data: env.data ?? { symbol, items: [] as NewsItem[] },
  }));

export const fetchStockOutlook = (symbol: string) =>
  get<StockOutlook>(`/api/stock/${encodeURIComponent(symbol)}/outlook`);

const EMPTY_SUMMARY: PortfolioSummary = {
  holdings: [],
  totals: { invested: 0, value: null, pnl: null, pnl_pct: null, day_pnl: null, by_type: {}, count: 0 },
  insights: [],
};

export const fetchPortfolioSummary = () =>
  get<PortfolioSummary>("/api/portfolio/summary").then((env) => ({
    ...env,
    data: env.data ?? EMPTY_SUMMARY,
  }));

async function send<T>(url: string, method: string, body?: unknown): Promise<Envelope<T>> {
  const res = await fetch(url, {
    method,
    headers: body != null ? { "Content-Type": "application/json" } : undefined,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

export const addHolding = (h: {
  asset_type: "stock" | "mf";
  symbol: string;
  name?: string;
  quantity: number;
  avg_price: number;
}) => send<Holding>("/api/portfolio/holdings", "POST", h);

export const deleteHolding = (id: number) =>
  send<{ id: number }>(`/api/portfolio/holdings/${id}`, "DELETE");

export const updateHolding = (id: number, h: { quantity: number; avg_price: number }) =>
  send<Holding>(`/api/portfolio/holdings/${id}`, "PUT", h);

export const stockSearch = (q: string) =>
  get<{ results: StockSuggestion[] }>(
    `/api/portfolio/stock/search?q=${encodeURIComponent(q)}`,
  ).then((env) => ({ ...env, data: env.data ?? { results: [] as StockSuggestion[] } }));

export const fetchSourceHealth = () =>
  get<SourceHealthData>("/api/sources/health").then((env) => ({
    ...env,
    data: env.data ?? { sources: [] as SourceHealthRow[], events: [] },
  }));

export const fetchMfList = (q: string | null, page: number) =>
  get<MfListData>(
    `/api/mf/list?page=${page}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
  ).then((env) => ({
    ...env,
    data: env.data ?? { items: [], total: 0, page, per_page: 50, pages: 1 },
  }));

export const fetchMfDetail = (code: string) =>
  get<MfDetail>(`/api/mf/${encodeURIComponent(code)}/detail`);

export const importHoldingsCsv = (csv: string) =>
  send<{ added: number; holdings: Holding[]; skipped: string[] }>(
    "/api/portfolio/import",
    "POST",
    { csv },
  );

export const mfSearch = (q: string) =>
  get<{ results: MfScheme[] }>(
    `/api/portfolio/mf/search?q=${encodeURIComponent(q)}`,
  ).then((env) => ({ ...env, data: env.data ?? { results: [] as MfScheme[] } }));

// ---- paper trading ----

export interface PaperPosition {
  symbol: string;
  name: string;
  quantity: number;
  avg_price: number;
  realized_pnl: number;
  updated_at: number;
  last_price: number | null;
  value: number | null;
  pnl: number | null;
  pnl_pct: number | null;
  day_change_pct: number | null;
}

export interface PaperOrder {
  id: number;
  side: "BUY" | "SELL";
  symbol: string;
  quantity: number;
  price: number;
  value: number;
  realized_pnl: number | null;
  ts: number;
}

export interface PaperAccount {
  cash: number;
  starting_cash: number;
  invested: number;
  positions_value: number;
  equity: number;
  total_return_pct: number;
  realized_pnl: number;
  positions: PaperPosition[];
  orders: PaperOrder[];
  limit_orders: LimitOrderRow[];
}

export const fetchPaperAccount = () =>
  get<PaperAccount>("/api/paper/account").then((env) => ({
    ...env,
    data:
      env.data ??
      {
        cash: 0,
        starting_cash: 1_000_000,
        invested: 0,
        positions_value: 0,
        equity: 0,
        total_return_pct: 0,
        realized_pnl: 0,
        positions: [] as PaperPosition[],
        orders: [] as PaperOrder[],
        limit_orders: [] as LimitOrderRow[],
      },
  }));

export const placePaperOrder = (o: {
  side: "BUY" | "SELL";
  symbol: string;
  name?: string;
  quantity: number;
}) => send<{ order: PaperOrder; cash: number }>("/api/paper/order", "POST", o);

export const resetPaperAccount = () =>
  send<{ cash: number }>("/api/paper/reset", "POST");

export const placeLimitOrder = (o: {
  side: "BUY" | "SELL";
  symbol: string;
  name?: string;
  quantity: number;
  limit_price: number;
}) => send<LimitOrderRow>("/api/paper/limit-order", "POST", o);

export const cancelLimitOrder = (id: number) =>
  send<{ id: number }>(`/api/paper/limit-order/${id}`, "DELETE");

export interface PaperEquityPoint {
  equity: number;
  cash: number;
  positions_value: number;
  ts: number;
}

export const fetchPaperEquityHistory = () =>
  get<{ points: PaperEquityPoint[] }>("/api/paper/equity-history").then((env) => ({
    ...env,
    data: env.data ?? { points: [] as PaperEquityPoint[] },
  }));

// ---- signals / candles / announcements / fii-dii / dividends ----

export const fetchSignals = () =>
  get<SignalsPayload>("/api/signals").then((env) => ({
    ...env,
    data:
      env.data ??
      {
        open: [] as SignalRow[],
        recent: [] as SignalRow[],
        stats: { resolved: 0, wins: 0, losses: 0, expired: 0, win_rate_pct: null, total_r: null, avg_r: null },
      },
  }));

// ---- trade ideas (model signals + live price + risk sizing) ----

export interface TradeTier {
  risk_pct: number;
  qty: number;
  notional: number | null;
  max_loss: number | null;
}

export interface TradeIdea {
  symbol: string;
  signal: "BUY" | "SELL";
  score: number | null;
  entry: number;
  live: number | null;
  drift_pct: number | null;
  stop: number | null;
  stop_pct: number | null;
  target_1: number | null;
  target_2: number | null;
  reward_risk: number | null;
  risk_per_share: number | null;
  horizon_days: number;
  planned_at: number;
  age_days: number;
  price_source: string | null;
  held_qty: number;
  held_avg: number | null;
  tiers: TradeTier[];
  can_trade: boolean;
  block_reason: string | null;
}

export interface TradeIdeasPayload {
  equity: number;
  cash: number;
  starting_cash: number;
  risk_tiers: number[];
  count: number;
  ideas: TradeIdea[];
}

export const fetchTradeIdeas = () =>
  get<TradeIdeasPayload>("/api/trades/ideas").then((env) => ({
    ...env,
    data:
      env.data ?? {
        equity: 0,
        cash: 0,
        starting_cash: 1_000_000,
        risk_tiers: [0.5, 1, 2],
        count: 0,
        ideas: [] as TradeIdea[],
      },
  }));

export const fetchOutlookModel = () =>
  get<GlobalModelStatus>("/api/outlook/model").then((env) => ({
    ...env,
    data:
      env.data ?? {
        status: "untrained",
        training: false,
        n_stocks: null,
        n_samples: null,
        walk_forward_accuracy: null,
        walk_forward_auc: null,
        feature_version: null,
        n_features: null,
        n_test: null,
        buckets: [] as ModelBucket[],
        long_precision: null,
        long_n: null,
        spread_bps: null,
        base_rate: null,
        has_edge: false,
        trained_at: null,
        error: null,
      },
  }));

// ---- IPO allotment (PAN vault + registrar checks) ----

export interface PanEntry {
  id: number;
  label: string;
  masked: string;
  created_at: number;
}

export interface AllotIssue {
  key: string;
  symbol: string | null;
  name: string | null;
  registrar: string | null;
  registrar_name: string | null;
  open_date: string | null;
  close_date: string | null;
  expected_allotment: string | null;
  state: "active" | "closed";
}

export interface AllotSourceResult {
  source: string;
  outcome: "allotted" | "not_allotted" | "not_applied" | "uncovered" | "error";
  shares_applied: number | null;
  shares_allotted: number | null;
  applicant_mask: string | null;
  error: string | null;
  checked_at: number | null;
}

export interface AllotResult {
  pan_id: number;
  pan_mask: string;
  issue_key: string;
  issue_name: string | null;
  symbol: string | null;
  registrar: string | null;
  registrar_name: string | null;
  close_date: string | null;
  expected_allotment: string | null;
  state: "active" | "closed" | null;
  overall: "allotted" | "not_allotted" | "not_applied" | "uncovered" | "error";
  shares_allotted: number | null;
  shares_applied: number | null;
  note: string | null;
  sources: AllotSourceResult[];
}

export interface AllotJob {
  state: "running" | "done" | "failed";
  total: number;
  done: number;
  current: string | null;
  results: AllotResult[];
  error: string | null;
  started_at: number;
}

const EMPTY_JOB: AllotJob = {
  state: "running", total: 0, done: 0, current: null, results: [], error: null, started_at: 0,
};

export const fetchPans = () =>
  get<{ pans: PanEntry[] }>("/api/allotment/pans").then((env) => ({
    ...env,
    data: env.data ?? { pans: [] as PanEntry[] },
  }));

export const addPan = (label: string, pan: string) =>
  send<PanEntry>("/api/allotment/pans", "POST", { label, pan });

export const deletePan = (id: number) =>
  send<{ id: number }>(`/api/allotment/pans/${id}`, "DELETE");

export const fetchAllotIssues = () =>
  get<{ count: number; issues: AllotIssue[] }>("/api/allotment/issues").then((env) => ({
    ...env,
    data: env.data ?? { count: 0, issues: [] as AllotIssue[] },
  }));

export const fetchAllotResults = (panId?: number) =>
  get<{ results: AllotResult[] }>(
    `/api/allotment/results${panId != null ? `?pan_id=${panId}` : ""}`
  ).then((env) => ({ ...env, data: env.data ?? { results: [] as AllotResult[] } }));

export const fetchAllotLinks = () =>
  get<{ links: { label: string; url: string }[] }>("/api/allotment/links").then((env) => ({
    ...env,
    data: env.data ?? { links: [] as { label: string; url: string }[] },
  }));

export const fetchAllotRegistrars = () =>
  get<{ count: number; by_registrar: Record<string, number> }>("/api/allotment/registrars").then((env) => ({
    ...env,
    data: env.data ?? { count: 0, by_registrar: {} as Record<string, number> },
  }));

export const startAllotCheckAll = (panIds?: number[], issueKeys?: string[]) =>
  send<{ job_id: string; total: number }>("/api/allotment/check-all", "POST", {
    pan_ids: panIds ?? null,
    issue_keys: issueKeys ?? null,
  });

export const fetchAllotJob = (jobId: string) =>
  get<AllotJob>(`/api/allotment/job/${jobId}`).then((env) => ({
    ...env,
    data: env.data ?? EMPTY_JOB,
  }));

export const runAllotCheck = (panId: number, issueKey?: string) =>
  send<{ results: AllotResult[] }>("/api/allotment/check", "POST", {
    pan_id: panId,
    issue_key: issueKey ?? null,
  });

export const logManualResult = (panId: number, issueKey: string, outcome: "allotted" | "not_allotted", shares?: number) =>
  send<{ result: AllotResult }>("/api/allotment/manual", "POST", {
    pan_id: panId,
    issue_key: issueKey,
    outcome,
    shares: shares ?? null,
  });

export const clearManualResult = (panId: number, issueKey: string) =>
  send<{ result: AllotResult }>(
    `/api/allotment/manual?pan_id=${panId}&issue_key=${encodeURIComponent(issueKey)}`,
    "DELETE"
  );

export function validPanFormat(pan: string): boolean {
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan.trim().toUpperCase());
}

export const fetchCandles = (symbol: string, range: string) =>
  get<{ symbol: string; range: string; bars: CandleBar[] }>(
    `/api/stock/${encodeURIComponent(symbol)}/candles?range=${range}`
  ).then((env) => ({ ...env, data: env.data ?? { symbol, range, bars: [] as CandleBar[] } }));

export const fetchAnnouncements = (symbol: string) =>
  get<AnnouncementRow[]>(`/api/stock/${encodeURIComponent(symbol)}/announcements`).then(
    (env) => ({ ...env, data: env.data ?? [] as AnnouncementRow[] })
  );

export const fetchFiidii = () =>
  get<{ rows: FiiDiiRow[]; fetched_at?: string }>("/api/fiidii").then((env) => ({
    ...env,
    data: env.data ?? { rows: [] as FiiDiiRow[] },
  }));

export const fetchDividends = () =>
  get<{ dividends: DividendRow[] }>("/api/portfolio/dividends").then((env) => ({
    ...env,
    data: env.data ?? { dividends: [] as DividendRow[] },
  }));

export const addDividend = (d: { symbol: string; amount_total: number; ex_date?: string; note?: string }) =>
  send<DividendRow>("/api/portfolio/dividends", "POST", d);

export const deleteDividend = (id: number) =>
  send<{ id: number }>(`/api/portfolio/dividends/${id}`, "DELETE");
