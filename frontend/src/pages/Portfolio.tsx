import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addDividend,
  addHolding,
  cancelLimitOrder,
  deleteDividend,
  deleteHolding,
  fetchDividends,
  fetchPaperAccount,
  fetchPortfolioSummary,
  importHoldingsCsv,
  mfSearch,
  resetPaperAccount,
  stockSearch,
  updateHolding,
  fetchPaperEquityHistory,
  type MfScheme,
  type SummaryRow,
  type PaperOrder,
} from "../api";
import { OrderTicket } from "../components/OrderTicket";
import { EmptyState, Skeleton, TableSkeleton } from "../components/ui";

function downloadCsv(filename: string, csvContent: string) {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function exportHoldingsCsv(rows: SummaryRow[]) {
  const headers = ["Symbol", "Name", "Type", "Quantity", "Avg Price", "Current Price", "Invested", "Current Value", "P&L", "P&L %"];
  const lines = rows.map((r) => [
    `"${r.symbol}"`,
    `"${(r.name || r.symbol).replace(/"/g, '""')}"`,
    r.asset_type,
    r.quantity,
    r.avg_price,
    r.last_price ?? "",
    r.invested ?? (r.quantity * r.avg_price),
    r.value ?? "",
    r.pnl ?? "",
    r.pnl_pct ?? "",
  ].join(","));
  downloadCsv(`axewatch_holdings_${new Date().toISOString().slice(0, 10)}.csv`, [headers.join(","), ...lines].join("\n"));
}

function exportOrdersCsv(orders: PaperOrder[]) {
  const headers = ["Order ID", "Date", "Side", "Symbol", "Quantity", "Price", "Value", "Realized P&L"];
  const lines = orders.map((o) => [
    o.id,
    `"${new Date(o.ts * 1000).toLocaleString("en-IN")}"`,
    o.side,
    `"${o.symbol}"`,
    o.quantity,
    o.price,
    o.value,
    o.realized_pnl ?? "",
  ].join(","));
  downloadCsv(`axewatch_paper_orders_${new Date().toISOString().slice(0, 10)}.csv`, [headers.join(","), ...lines].join("\n"));
}

function PaperEquityCurve() {
  const q = useQuery({
    queryKey: ["paper-equity-history"],
    queryFn: fetchPaperEquityHistory,
    refetchInterval: 30_000,
  });
  const points = q.data?.data.points ?? [];
  if (points.length < 2) return null;

  const W = 560;
  const H = 80;
  const PAD_L = 10;
  const PAD_R = 10;
  const PAD_T = 10;
  const PAD_B = 14;

  const lo = Math.min(...points.map((p) => p.equity));
  const hi = Math.max(...points.map((p) => p.equity));
  const span = hi - lo || 1000;
  const getY = (v: number) => PAD_T + ((hi - v) / span) * (H - PAD_T - PAD_B);
  const getX = (i: number) => PAD_L + (i / (points.length - 1)) * (W - PAD_L - PAD_R);

  let pathD = "";
  points.forEach((p, i) => {
    const x = getX(i);
    const y = getY(p.equity);
    pathD += i === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  const areaD = `${pathD} L ${getX(points.length - 1)} ${H - PAD_B} L ${getX(0)} ${H - PAD_B} Z`;

  const isUp = points[points.length - 1].equity >= points[0].equity;
  const strokeColor = isUp ? "#10b981" : "#f43f5e";
  const fillColor = isUp ? "rgba(16, 185, 129, 0.1)" : "rgba(244, 63, 94, 0.1)";

  return (
    <div className="mb-4 rounded-lg bg-zinc-50 p-2.5 ring-1 ring-zinc-200 dark:bg-zinc-950/60 dark:ring-zinc-800">
      <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-zinc-500">
        <span className="uppercase tracking-wide">Paper Equity Curve</span>
        <span className="font-mono">
          ₹{inr(points[0].equity, 0)} → <span className={isUp ? "text-emerald-500 font-bold" : "text-rose-400 font-bold"}>₹{inr(points[points.length - 1].equity, 0)}</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none overflow-visible">
        <path d={areaD} fill={fillColor} />
        <path d={pathD} fill="none" stroke={strokeColor} strokeWidth="1.5" />
      </svg>
    </div>
  );
}

function inr(n?: number | null, frac = 2) {
  return n != null && Number.isFinite(n)
    ? n.toLocaleString("en-IN", { maximumFractionDigits: frac })
    : "—";
}

function Card({
  title,
  hint,
  meta,
  children,
}: {
  title: string;
  hint?: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="animate-fade-up rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.15)] sm:p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
          {title}
        </h2>
        {meta && <span className="tnum text-xs text-zinc-500">{meta}</span>}
      </div>
      {hint && <p className="mb-3 max-w-2xl text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{hint}</p>}
      {!hint && <div className="mb-3" />}
      {children}
    </section>
  );
}

const inputCls =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none placeholder:text-zinc-400 focus:border-emerald-500 dark:border-zinc-800 dark:bg-zinc-950/70 dark:placeholder:text-zinc-600 dark:focus:border-emerald-500/50";

const dropdownCls =
  "absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900";

const SECTOR_COLORS = [
  "bg-sky-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-violet-500",
  "bg-rose-500",
  "bg-teal-500",
  "bg-orange-500",
  "bg-indigo-500",
  "bg-lime-500",
  "bg-fuchsia-500",
];

function StockSymbolInput({
  symbol,
  onPick,
  onText,
}: {
  symbol: string;
  onPick: (s: string) => void;
  onText: (s: string) => void;
}) {
  const [text, setText] = useState(symbol);
  const [debounced, setDebounced] = useState(symbol);
  const [open, setOpen] = useState(false);

  useEffect(() => setText(symbol), [symbol]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim().toUpperCase()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const q = useQuery({
    queryKey: ["stockSearch", debounced],
    queryFn: () => stockSearch(debounced),
    enabled: debounced.length >= 2,
    staleTime: 60_000,
  });
  const results = q.data?.data.results ?? [];

  return (
    <div className="relative">
      <input
        value={text}
        onChange={(e) => {
          const v = e.target.value.toUpperCase();
          setText(v);
          onText(v);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="SYMBOL"
        className={inputCls}
      />
      {open && debounced.length >= 2 && results.length > 0 && (
        <div className={dropdownCls}>
          {results.map((r) => (
            <button
              key={r.symbol}
              type="button"
              onClick={() => {
                onPick(r.symbol);
                setOpen(false);
              }}
              className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs hover:bg-emerald-500/10"
            >
              <span className="font-semibold">{r.symbol}</span>
              <span className="truncate text-zinc-500">{r.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type StockFormRow = { key: number; symbol: string; qty: string; avg: string };

function AddHoldingCard() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"stock" | "mf">("stock");
  const [qty, setQty] = useState("");
  const [avg, setAvg] = useState("");
  const [scheme, setScheme] = useState<MfScheme | null>(null);
  const [mfQuery, setMfQuery] = useState("");
  const [showResults, setShowResults] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stockRows, setStockRows] = useState<StockFormRow[]>([{ key: 0, symbol: "", qty: "", avg: "" }]);
  const rowKey = useRef(1);

  const searchQ = useQuery({
    queryKey: ["mfSearch", mfQuery],
    queryFn: () => mfSearch(mfQuery),
    enabled: mode === "mf" && mfQuery.trim().length >= 3,
    staleTime: 60_000,
  });

  const add = useMutation({
    mutationFn: addHolding,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["portfolio"] }),
  });

  const setRow = (key: number, patch: Partial<StockFormRow>) =>
    setStockRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submitStocks = async () => {
    const filled = stockRows.filter((r) => r.symbol.trim() || r.qty.trim() || r.avg.trim());
    if (filled.length === 0) return setErr("Enter a symbol, quantity and average price");
    for (const r of filled) {
      const quantity = Number(r.qty);
      const avgPrice = Number(r.avg);
      if (!r.symbol.trim()) return setErr("Every row needs a symbol");
      if (!Number.isFinite(quantity) || quantity <= 0)
        return setErr(`Invalid quantity for ${r.symbol}`);
      if (!Number.isFinite(avgPrice) || avgPrice < 0)
        return setErr(`Invalid average price for ${r.symbol}`);
    }
    setErr(null);
    try {
      for (const r of filled) {
        await add.mutateAsync({
          asset_type: "stock",
          symbol: r.symbol.trim(),
          quantity: Number(r.qty),
          avg_price: Number(r.avg),
        });
      }
      setStockRows([{ key: rowKey.current++, symbol: "", qty: "", avg: "" }]);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const submitMf = () => {
    const quantity = Number(qty);
    const avgPrice = Number(avg);
    if (!Number.isFinite(quantity) || quantity <= 0) return setErr("Enter a valid quantity");
    if (!Number.isFinite(avgPrice) || avgPrice < 0) return setErr("Enter a valid average price");
    if (!scheme) return setErr("Pick a scheme from the search results");
    setErr(null);
    add.mutate(
      { asset_type: "mf", symbol: scheme.code, name: scheme.name, quantity, avg_price: avgPrice },
      {
        onSuccess: () => {
          setQty("");
          setAvg("");
          setScheme(null);
          setMfQuery("");
          setErr(null);
        },
        onError: (e: Error) => setErr(e.message),
      },
    );
  };

  const results = searchQ.data?.data.results ?? [];
  const filledCount = stockRows.filter((r) => r.symbol.trim() && r.qty.trim()).length;

  return (
    <Card title="Add holdings" hint="Stocks come with symbol suggestions · add several at once · mutual funds by scheme name">
      <div className="mb-3 inline-flex rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-800">
        {(["stock", "mf"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setErr(null);
            }}
            className={`rounded-md px-3 py-1 text-xs font-medium ${
              mode === m
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            }`}
          >
            {m === "stock" ? "Stocks" : "Mutual Fund"}
          </button>
        ))}
      </div>

      {mode === "stock" ? (
        <div className="space-y-2">
          {stockRows.map((r) => (
            <div key={r.key} className="grid grid-cols-[1.4fr_0.8fr_1fr_auto] items-center gap-2">
              <StockSymbolInput
                symbol={r.symbol}
                onPick={(s) => setRow(r.key, { symbol: s })}
                onText={(s) => setRow(r.key, { symbol: s })}
              />
              <input
                value={r.qty}
                onChange={(e) => setRow(r.key, { qty: e.target.value })}
                placeholder="Qty"
                inputMode="decimal"
                className={inputCls}
              />
              <input
                value={r.avg}
                onChange={(e) => setRow(r.key, { avg: e.target.value })}
                placeholder="Avg price ₹"
                inputMode="decimal"
                className={inputCls}
              />
              <button
                type="button"
                title="Remove row"
                onClick={() =>
                  setStockRows((rs) =>
                    rs.length > 1
                      ? rs.filter((x) => x.key !== r.key)
                      : [{ key: rowKey.current++, symbol: "", qty: "", avg: "" }],
                  )
                }
                className={`rounded px-2 py-1 text-sm text-zinc-400 ${stockRows.length > 1 ? "hover:text-rose-400" : "opacity-30"}`}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => setStockRows((rs) => [...rs, { key: rowKey.current++, symbol: "", qty: "", avg: "" }])}
              className="rounded-lg border border-dashed border-zinc-300 px-3 py-1.5 text-xs text-zinc-500 hover:border-emerald-500/50 hover:text-emerald-500 dark:border-zinc-700"
            >
              + Add another stock
            </button>
            <button
              type="button"
              onClick={submitStocks}
              disabled={add.isPending}
              className="ml-auto rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              {add.isPending ? "Adding…" : filledCount > 1 ? `Add ${filledCount} holdings` : "Add"}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="relative">
            <input
              value={scheme ? scheme.name : mfQuery}
              onChange={(e) => {
                setScheme(null);
                setShowResults(true);
                setMfQuery(e.target.value);
              }}
              onFocus={() => setShowResults(true)}
              placeholder="Search scheme, e.g. Parag Parikh Flexi Cap"
              className={inputCls}
            />
            {showResults && !scheme && mfQuery.trim().length >= 3 && (
              <div className={dropdownCls}>
                {searchQ.isLoading && <div className="p-2 text-xs text-zinc-500">searching…</div>}
                {!searchQ.isLoading && results.length === 0 && (
                  <div className="p-2 text-xs text-zinc-500">no schemes found</div>
                )}
                {results.map((r) => (
                  <button
                    key={r.code}
                    type="button"
                    onClick={() => {
                      setScheme(r);
                      setShowResults(false);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-xs hover:bg-emerald-500/10"
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="Units"
              inputMode="decimal"
              className={inputCls}
            />
            <input
              value={avg}
              onChange={(e) => setAvg(e.target.value)}
              placeholder="Avg NAV ₹"
              inputMode="decimal"
              className={inputCls}
            />
          </div>
          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={submitMf}
              disabled={add.isPending}
              className="rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              {add.isPending ? "Adding…" : "Add"}
            </button>
          </div>
        </div>
      )}

      {err && <p className="mt-2 text-xs text-rose-400">{err}</p>}
    </Card>
  );
}


function ImportCard() {
  const qc = useQueryClient();
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const imp = useMutation({
    mutationFn: importHoldingsCsv,
    onSuccess: (env) => {
      qc.invalidateQueries({ queryKey: ["portfolio"] });
      const d = env.data;
      setResult(
        `Added ${d.added} stock${d.added === 1 ? "" : "s"}` +
          (d.skipped.length ? ` · skipped ${d.skipped.length} row(s): ${d.skipped.slice(0, 3).join(", ")}` : ""),
      );
      setCsv("");
      if (fileRef.current) fileRef.current.value = "";
    },
    onError: (e: Error) => setResult(`Import failed: ${e.message}`),
  });

  return (
    <Card
      title="Import from broker CSV"
      hint="Zerodha Console holdings export or a plain symbol,quantity,avg_price CSV — everything stays on your machine"
    >
      <div className="space-y-2">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setCsv(await f.text());
          }}
          className="w-full text-xs text-zinc-500 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-100 file:px-3 file:py-1.5 file:text-xs dark:file:bg-zinc-800"
        />
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={"…or paste CSV rows here\nInstrument,Qty.,Avg. cost\nRELIANCE,10,1250"}
          rows={4}
          className={`${inputCls} font-mono text-xs`}
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => csv.trim() && imp.mutate(csv)}
            disabled={imp.isPending || !csv.trim()}
            className="rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            {imp.isPending ? "Importing…" : "Import"}
          </button>
          {result && <span className="text-xs text-zinc-600">{result}</span>}
        </div>
      </div>
    </Card>
  );
}

function HoldingsTable({ rows }: { rows: SummaryRow[] }) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: deleteHolding,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["portfolio"] }),
  });
  const [editId, setEditId] = useState<number | null>(null);
  const [editQty, setEditQty] = useState("");
  const [editAvg, setEditAvg] = useState("");
  const [editErr, setEditErr] = useState<string | null>(null);
  const upd = useMutation({
    mutationFn: (h: { id: number; quantity: number; avg_price: number }) =>
      updateHolding(h.id, { quantity: h.quantity, avg_price: h.avg_price }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["portfolio"] });
      setEditId(null);
      setEditErr(null);
    },
    onError: (e: Error) => setEditErr(e.message),
  });

  const startEdit = (r: SummaryRow) => {
    setEditId(r.id);
    setEditQty(String(r.quantity));
    setEditAvg(String(r.avg_price));
    setEditErr(null);
  };

  const saveEdit = () => {
    const quantity = Number(editQty);
    const avgPrice = Number(editAvg);
    if (!Number.isFinite(quantity) || quantity <= 0) return setEditErr("Quantity must be > 0");
    if (!Number.isFinite(avgPrice) || avgPrice < 0) return setEditErr("Avg price must be 0 or more");
    if (editId == null) return;
    upd.mutate({ id: editId, quantity, avg_price: avgPrice });
  };

  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<"value" | "pnl_pct" | "weight" | "symbol">("value");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = needle
      ? rows.filter((r) => `${r.symbol} ${r.name ?? ""}`.toLowerCase().includes(needle))
      : [...rows];
    const val = (r: SummaryRow): number | string => {
      if (sortKey === "symbol") return r.symbol;
      if (sortKey === "pnl_pct") return r.pnl_pct ?? Number.NEGATIVE_INFINITY;
      if (sortKey === "weight") return r.weight_pct ?? Number.NEGATIVE_INFINITY;
      return r.value ?? Number.NEGATIVE_INFINITY;
    };
    return list.sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (typeof av === "string" || typeof bv === "string")
        return sortDir * String(av).localeCompare(String(bv));
      return sortDir * ((av as number) - (bv as number));
    });
  }, [rows, filter, sortKey, sortDir]);

  const toggleSort = (k: typeof sortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(k);
      setSortDir(k === "symbol" ? 1 : -1);
    }
  };

  if (rows.length === 0)
    return <EmptyState title="No holdings yet" hint="Add one above, or import your broker CSV — everything stays on this machine." />;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter holdings…"
          aria-label="Filter holdings"
          className="w-44 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none placeholder:text-zinc-400 focus:border-emerald-500 dark:border-zinc-800 dark:bg-zinc-950/70 dark:placeholder:text-zinc-600 dark:focus:border-emerald-500/50"
        />
        <span className="tnum text-xs text-zinc-500">{shown.length} of {rows.length}</span>
        <div className="flex items-center gap-1 text-xs">
          {( [["value", "Value"], ["pnl_pct", "P&L %"], ["weight", "Weight"], ["symbol", "A–Z"]] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => toggleSort(k)}
              aria-pressed={sortKey === k}
              className={`rounded-lg border px-2 py-1 font-medium transition-colors ${
                sortKey === k
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "border-zinc-200 text-zinc-500 hover:text-zinc-800 dark:border-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              {label}{sortKey === k ? (sortDir === 1 ? " ▴" : " ▾") : ""}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => exportHoldingsCsv(rows)}
          className="ml-auto rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Export Holdings (CSV)
        </button>
      </div>
      {shown.length === 0 && (
        <p className="rounded-lg bg-zinc-50 py-6 text-center text-sm text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
          No holdings match “{filter}”.
        </p>
      )}
      {shown.length > 0 && (
      <div className="nice-scroll overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
      <table className="tnum w-full text-left text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
            <th className="py-2 pl-3 pr-4 font-medium">Holding</th>
            <th className="py-2 pr-4 text-right font-medium">Qty</th>
            <th className="py-2 pr-4 text-right font-medium">Avg</th>
            <th className="py-2 pr-4 text-right font-medium">LTP / NAV</th>
            <th className="py-2 pr-4 text-right font-medium">Value</th>
            <th className="py-2 pr-4 text-right font-medium">P&L</th>
            <th className="py-2 pr-4 text-right font-medium">Day</th>
            <th className="py-2 pr-4 text-right font-medium">Weight</th>
            <th className="py-2 pr-3" />
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const pnlUp = (r.pnl ?? 0) >= 0;
            const dayUp = (r.day_change_pct ?? 0) >= 0;
            const editing = editId === r.id;
            return (
              <tr key={r.id} className={`border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/30 ${editing ? "bg-emerald-500/5" : ""}`}>
                <td className="py-2 pl-3 pr-4">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                        r.asset_type === "stock"
                          ? "bg-sky-500/10 text-sky-500"
                          : "bg-violet-500/10 text-violet-500"
                      }`}
                    >
                      {r.asset_type === "stock" ? "EQ" : "MF"}
                    </span>
                    <div className="min-w-0">
                      <div className="truncate font-medium" title={r.name || r.symbol}>
                        {r.asset_type === "stock" ? r.symbol : r.name || r.symbol}
                      </div>
                      {r.asset_type === "mf" && <div className="text-[10px] text-zinc-500">{r.symbol}</div>}
                    </div>
                  </div>
                </td>
                {editing ? (
                  <>
                    <td className="py-2 pr-4">
                      <input
                        value={editQty}
                        onChange={(e) => setEditQty(e.target.value)}
                        inputMode="decimal"
                        title="New quantity (e.g. after selling shares)"
                        className="w-20 rounded border border-emerald-500/40 bg-white px-2 py-1 text-right font-mono text-sm outline-none dark:bg-zinc-950"
                      />
                    </td>
                    <td className="py-2 pr-4">
                      <input
                        value={editAvg}
                        onChange={(e) => setEditAvg(e.target.value)}
                        inputMode="decimal"
                        title="New average price"
                        className="w-24 rounded border border-emerald-500/40 bg-white px-2 py-1 text-right font-mono text-sm outline-none dark:bg-zinc-950"
                      />
                    </td>
                  </>
                ) : (
                  <>
                    <td className="py-2 pr-4 text-right font-mono text-zinc-400">{inr(r.quantity, 4)}</td>
                    <td className="py-2 pr-4 text-right font-mono text-zinc-400">₹{inr(r.avg_price)}</td>
                  </>
                )}
                <td className="py-2 pr-4 text-right font-mono">{r.last_price != null ? `₹${inr(r.last_price)}` : "—"}</td>
                <td className="py-2 pr-4 text-right font-mono">{r.value != null ? `₹${inr(r.value, 0)}` : "—"}</td>
                <td className={`py-2 pr-4 text-right font-mono ${r.pnl != null ? (pnlUp ? "text-emerald-400" : "text-rose-400") : "text-zinc-400"}`}>
                  {r.pnl != null ? `${pnlUp ? "+" : "-"}₹${inr(Math.abs(r.pnl), 0)}` : "—"}
                  {r.pnl_pct != null && <span className="ml-1 text-[11px] opacity-70">{r.pnl_pct >= 0 ? "+" : ""}{r.pnl_pct.toFixed(1)}%</span>}
                </td>
                <td className={`py-2 pr-4 text-right font-mono ${r.day_change_pct != null ? (dayUp ? "text-emerald-400" : "text-rose-400") : "text-zinc-400"}`}>
                  {r.day_change_pct != null ? `${dayUp ? "+" : ""}${r.day_change_pct.toFixed(2)}%` : "—"}
                </td>
                <td className="py-2 pr-4 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <span className="font-mono text-xs text-zinc-400">{r.weight_pct != null ? `${r.weight_pct.toFixed(1)}%` : "—"}</span>
                    <div className="h-1.5 w-12 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                      <div
                        className={`h-full rounded-full ${r.asset_type === "stock" ? "bg-sky-500" : "bg-violet-500"}`}
                        style={{ width: `${Math.min(100, r.weight_pct ?? 0)}%` }}
                      />
                    </div>
                  </div>
                </td>
                <td className="py-2 pr-3 text-right whitespace-nowrap">
                  {editing ? (
                    <span className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={saveEdit}
                        disabled={upd.isPending}
                        className="rounded bg-emerald-500 px-2 py-0.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                      >
                        {upd.isPending ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditId(null)}
                        className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:text-zinc-300"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        title="Edit quantity / average price"
                        onClick={() => startEdit(r)}
                        className="rounded px-1.5 text-xs text-zinc-400 hover:text-emerald-500"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        title="Remove holding"
                        onClick={() => del.mutate(r.id)}
                        className="rounded px-1.5 text-zinc-400 hover:text-rose-400"
                      >
                        ✕
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {editErr && <p className="px-3 py-2 text-xs text-rose-400">{editErr}</p>}
      </div>
      )}
    </div>
  );
}

function PaperTradeCard() {
  const qc = useQueryClient();
  const [ticket, setTicket] = useState<{ symbol: string; side: "BUY" | "SELL"; qty?: number; heldQty?: number } | null>(null);
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  const acctQ = useQuery({
    queryKey: ["paper", "account"],
    queryFn: fetchPaperAccount,
    refetchInterval: 30_000,
  });
  const acct = acctQ.data?.data;

  const resetMut = useMutation({
    mutationFn: resetPaperAccount,
    onSuccess: () => {
      setResetMsg("Paper account reset to ₹10,00,000");
      qc.invalidateQueries({ queryKey: ["paper"] });
      qc.invalidateQueries({ queryKey: ["trade-ideas"] });
    },
  });

  return (
    <section className="relative rounded-2xl border-2 border-dashed border-violet-400/60 bg-violet-500/[0.03] p-4 sm:p-5 dark:border-violet-500/40">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">
            Paper Trading
          </h2>
          <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-600 ring-1 ring-violet-500/30 dark:text-violet-400">
            Simulation
          </span>
        </div>
        <button
          type="button"
          onClick={() => {
            if (window.confirm("Reset paper account to ₹10,00,000 and clear all positions/orders?")) resetMut.mutate();
          }}
          className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-700 hover:underline dark:hover:text-zinc-300"
        >
          Reset
        </button>
      </div>
      <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-600">
        Fake money, live prices — practice here without risk. This stays fully separate from your real holdings below.
      </p>
      {resetMsg && <p className="mb-2 text-xs text-emerald-600 dark:text-emerald-400">{resetMsg}</p>}
      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <div className="overflow-hidden rounded-xl bg-zinc-50 ring-1 ring-zinc-200/70 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
          <div className="h-0.5 bg-gradient-to-r from-zinc-400 to-zinc-300 dark:from-zinc-600 dark:to-zinc-700" />
          <div className="px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Cash</div>
            <div className="tnum font-mono text-lg font-bold">₹{inr(acct?.cash, 0)}</div>
          </div>
        </div>
        <div className="overflow-hidden rounded-xl bg-zinc-50 ring-1 ring-zinc-200/70 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
          <div className="h-0.5 bg-gradient-to-r from-sky-500 to-sky-300" />
          <div className="px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Positions</div>
            <div className="tnum font-mono text-lg font-bold">{acct ? `₹${inr(acct.positions_value, 0)}` : "…"}</div>
          </div>
        </div>
        <div className="overflow-hidden rounded-xl bg-zinc-50 ring-1 ring-zinc-200/70 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
          <div className="h-0.5 bg-gradient-to-r from-violet-500 to-violet-300" />
          <div className="px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Equity</div>
            <div className="tnum font-mono text-lg font-bold">{acct ? `₹${inr(acct.equity, 0)}` : "…"}</div>
          </div>
        </div>
        <div className="overflow-hidden rounded-xl bg-zinc-50 ring-1 ring-zinc-200/70 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
          <div className={`h-0.5 bg-gradient-to-r ${(acct?.total_return_pct ?? 0) >= 0 ? "from-emerald-500 to-emerald-300" : "from-rose-500 to-rose-300"}`} />
          <div className="px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Total return</div>
            <div
              className={`tnum font-mono text-lg font-bold ${
                (acct?.total_return_pct ?? 0) >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
              }`}
            >
              {acct ? `${acct.total_return_pct >= 0 ? "+" : ""}${acct.total_return_pct.toFixed(2)}%` : "…"}
            </div>
          </div>
        </div>
      </div>

      <PaperEquityCurve />

      <button
        type="button"
        onClick={() => setTicket({ symbol: "", side: "BUY" })}
        className="mb-4 flex w-full items-center justify-center gap-2 rounded-xl bg-violet-600 py-2.5 text-sm font-bold text-white shadow-sm transition-all hover:bg-violet-500"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
          <path strokeLinecap="round" d="M12 5v14M5 12h14" />
        </svg>
        Place order — market or limit, sized by risk
      </button>

      {acct && acct.limit_orders.filter((o) => o.status === "OPEN").length > 0 && (
        <div className="mb-4">
          <div className="mb-1.5 text-[11px] uppercase tracking-wide text-zinc-500">Open limit orders</div>
          <div className="space-y-1">
            {acct.limit_orders
              .filter((o) => o.status === "OPEN")
              .map((o) => (
                <LimitOrderRow key={o.id} order={o} />
              ))}
          </div>
        </div>
      )}

      {acct && acct.positions.length > 0 && (
        <div className="tnum mt-4 overflow-x-auto">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Positions
          </div>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                <th className="py-2 pr-4 font-medium">Symbol</th>
                <th className="py-2 pr-4 text-right font-medium">Qty</th>
                <th className="py-2 pr-4 text-right font-medium">Avg ₹</th>
                <th className="py-2 pr-4 text-right font-medium">LTP ₹</th>
                <th className="py-2 pr-4 text-right font-medium">Value</th>
                <th className="py-2 pr-4 text-right font-medium">P&L</th>
                <th className="py-2 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {acct.positions.map((p) => (
                <tr key={p.symbol} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                  <td className="py-2 pr-4 font-medium">{p.symbol}</td>
                  <td className="py-2 pr-4 text-right font-mono text-xs">{p.quantity % 1 === 0 ? p.quantity : p.quantity.toFixed(2)}</td>
                  <td className="py-2 pr-4 text-right font-mono text-xs">{inr(p.avg_price)}</td>
                  <td className="py-2 pr-4 text-right font-mono text-xs">{p.last_price != null ? inr(p.last_price) : "—"}</td>
                  <td className="py-2 pr-4 text-right font-mono text-xs">{p.value != null ? `₹${inr(p.value)}` : "—"}</td>
                  <td className={`py-2 pr-4 text-right font-mono text-xs ${(p.pnl ?? 0) >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                    {p.pnl != null ? `${p.pnl >= 0 ? "+" : "-"}₹${inr(Math.abs(p.pnl))} (${p.pnl_pct?.toFixed(2)}%)` : "—"}
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        title="Buy more"
                        onClick={() => setTicket({ symbol: p.symbol, side: "BUY", heldQty: p.quantity })}
                        className="rounded-md border border-emerald-500/40 px-2 py-0.5 text-[11px] font-medium text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
                      >
                        Add
                      </button>
                      <button
                        type="button"
                        title="Sell whole position"
                        onClick={() => setTicket({ symbol: p.symbol, side: "SELL", qty: p.quantity, heldQty: p.quantity })}
                        className="rounded-md border border-zinc-300 px-2 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      >
                        Close
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {acct && acct.orders.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wide text-zinc-500">Recent orders</span>
            <button
              type="button"
              onClick={() => exportOrdersCsv(acct.orders)}
              className="text-[11px] text-violet-600 hover:underline dark:text-violet-400"
            >
              Export Orders (CSV)
            </button>
          </div>
          <div className="space-y-1">
            {acct.orders.slice(0, 6).map((o) => (
              <div key={o.id} className="flex items-center gap-2 text-xs">
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${
                    o.side === "BUY" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                  }`}
                >
                  {o.side}
                </span>
                <span className="font-medium">{o.symbol}</span>
                <span className="font-mono text-zinc-500">
                  {o.quantity % 1 === 0 ? o.quantity : o.quantity.toFixed(2)} @ ₹{o.price.toLocaleString("en-IN")}
                </span>
                {o.realized_pnl != null && (
                  <span className={`font-mono ${o.realized_pnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                    {o.realized_pnl >= 0 ? "+" : "-"}₹{inr(Math.abs(o.realized_pnl), 0)} realized
                  </span>
                )}
                <span className="ml-auto text-zinc-400">{new Date(o.ts * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {ticket && (
        <OrderTicket
          initialSymbol={ticket.symbol}
          initialSide={ticket.side}
          initialQty={ticket.qty}
          heldQty={ticket.heldQty}
          onClose={() => setTicket(null)}
        />
      )}
    </section>
  );
}

function LimitOrderRow({ order: o }: { order: import("../api").LimitOrderRow }) {
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => cancelLimitOrder(o.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["paper"] }),
  });
  return (
    <div className="flex items-center gap-2 rounded-lg bg-zinc-50 px-2.5 py-1.5 text-xs ring-1 ring-zinc-200 dark:bg-zinc-950/60 dark:ring-zinc-800">
      <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${o.side === "BUY" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-rose-500/10 text-rose-600 dark:text-rose-400"}`}>
        {o.side}
      </span>
      <span className="font-medium">{o.symbol}</span>
      <span className="font-mono text-zinc-500">
        {o.quantity % 1 === 0 ? o.quantity : o.quantity.toFixed(2)} @ limit ₹{o.limit_price.toLocaleString("en-IN")}
      </span>
      <button
        type="button"
        onClick={() => cancel.mutate()}
        disabled={cancel.isPending}
        className="ml-auto text-[11px] text-zinc-500 underline-offset-2 hover:text-rose-500 hover:underline"
      >
        Cancel
      </button>
    </div>
  );
}

export function PortfolioPage() {
  const qc = useQueryClient();
  const sumQ = useQuery({
    queryKey: ["portfolio", "summary"],
    queryFn: fetchPortfolioSummary,
    refetchInterval: 120_000,
  });
  const divQ = useQuery({
    queryKey: ["dividends"],
    queryFn: fetchDividends,
  });
  const [divSym, setDivSym] = useState("");
  const [divAmt, setDivAmt] = useState("");
  const divMut = useMutation({
    mutationFn: addDividend,
    onSuccess: () => {
      setDivAmt("");
      qc.invalidateQueries({ queryKey: ["dividends"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
    },
  });
  const divDel = useMutation({
    mutationFn: (id: number) => deleteDividend(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dividends"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
    },
  });
  const d = sumQ.data?.data;
  const totals = d?.totals;
  const sectors = Object.entries(d?.sector_alloc ?? {});
  const sectorTotal = sectors.reduce((s, [, v]) => s + v, 0);
  const dividends = divQ.data?.data.dividends ?? [];

  const sorted = useMemo(
    () => [...(d?.holdings ?? [])].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
    [d],
  );
  const stockVal = totals?.by_type?.stock ?? 0;
  const mfVal = totals?.by_type?.mf ?? 0;
  const totalVal = stockVal + mfVal;

  return (
    <div className="space-y-4">
      <PaperTradeCard />
      <Card
        title="Your Portfolio"
        hint="Live valuation of everything you hold — stocks priced via NSE/Yahoo, funds via latest NAV"
        meta={sumQ.isFetching ? <span>refreshing…</span> : undefined}
      >
        <div className="tnum grid grid-cols-2 gap-2.5 sm:grid-cols-5">
          <div className="overflow-hidden rounded-xl bg-zinc-50 ring-1 ring-zinc-200/70 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
            <div className="h-0.5 bg-gradient-to-r from-zinc-400 to-zinc-300 dark:from-zinc-600 dark:to-zinc-700" />
            <div className="px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Invested</div>
            <div className="font-mono text-xl font-bold">{sumQ.isLoading ? <Skeleton className="mt-1 h-6 w-24" /> : `₹${inr(totals?.invested, 0)}`}</div>
            </div>
          </div>
          <div className="overflow-hidden rounded-xl bg-zinc-50 ring-1 ring-zinc-200/70 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
            <div className="h-0.5 bg-gradient-to-r from-sky-500 to-sky-300" />
            <div className="px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Current Value</div>
            <div className="font-mono text-xl font-bold">
              {sumQ.isLoading ? <Skeleton className="mt-1 h-6 w-24" /> : totals?.value != null ? `₹${inr(totals.value, 0)}` : "—"}
            </div>
            </div>
          </div>
          <div className="overflow-hidden rounded-xl bg-zinc-50 ring-1 ring-zinc-200/70 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
            <div className={`h-0.5 bg-gradient-to-r ${(totals?.pnl ?? 0) >= 0 ? "from-emerald-500 to-emerald-300" : "from-rose-500 to-rose-300"}`} />
            <div className="px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Total P&L</div>
            <div
              className={`font-mono text-xl font-bold ${
                (totals?.pnl ?? 0) >= 0 ? "text-emerald-500 dark:text-emerald-400" : "text-rose-500 dark:text-rose-400"
              }`}
            >
              {sumQ.isLoading ? <Skeleton className="mt-1 h-6 w-24" /> : totals?.pnl != null
                ? `${totals.pnl >= 0 ? "+" : "-"}₹${inr(Math.abs(totals.pnl), 0)} (${totals.pnl_pct != null ? `${totals.pnl_pct >= 0 ? "+" : ""}${totals.pnl_pct.toFixed(1)}%` : "—"})`
                : "—"}
            </div>
            </div>
          </div>
          <div className="overflow-hidden rounded-xl bg-zinc-50 ring-1 ring-zinc-200/70 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
            <div className={`h-0.5 bg-gradient-to-r ${(totals?.xirr_pct ?? 0) >= 0 ? "from-violet-500 to-violet-300" : "from-rose-500 to-rose-300"}`} />
            <div className="px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">XIRR</div>
            <div
              className={`font-mono text-xl font-bold ${
                (totals?.xirr_pct ?? 0) >= 0 ? "text-emerald-500 dark:text-emerald-400" : "text-rose-500 dark:text-rose-400"
              }`}
              title="Annualized money-weighted return, including dividends you logged"
            >
              {sumQ.isLoading ? <Skeleton className="mt-1 h-6 w-16" /> : totals?.xirr_pct != null ? `${totals.xirr_pct >= 0 ? "+" : ""}${totals.xirr_pct.toFixed(1)}%` : "—"}
            </div>
            </div>
          </div>
          <div className="overflow-hidden rounded-xl bg-zinc-50 ring-1 ring-zinc-200/70 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
            <div className="h-0.5 bg-gradient-to-r from-amber-500 to-amber-300" />
            <div className="px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Dividends</div>
            <div className="font-mono text-xl font-bold text-sky-600 dark:text-sky-400">
              {sumQ.isLoading ? <Skeleton className="mt-1 h-6 w-16" /> : totals?.dividends_total ? `₹${inr(totals.dividends_total, 0)}` : "—"}
            </div>
            </div>
          </div>
        </div>

        {totalVal > 0 && (
          <div className="tnum mt-4 flex items-center gap-4">
            <svg
              viewBox="0 0 42 42"
              className="h-20 w-20 shrink-0"
              role="img"
              aria-label={`Stocks ${((stockVal / totalVal) * 100).toFixed(0)} percent, mutual funds ${((mfVal / totalVal) * 100).toFixed(0)} percent`}
            >
              <circle cx="21" cy="21" r="15.9155" fill="transparent" strokeWidth="6" className="stroke-zinc-200 dark:stroke-zinc-800" />
              <circle
                cx="21" cy="21" r="15.9155" fill="transparent" stroke="#0ea5e9" strokeWidth="6"
                strokeDasharray={`${((stockVal / totalVal) * 100).toFixed(1)} 100`} strokeDashoffset="25" strokeLinecap="round"
              />
              <circle
                cx="21" cy="21" r="15.9155" fill="transparent" stroke="#8b5cf6" strokeWidth="6"
                strokeDasharray={`${((mfVal / totalVal) * 100).toFixed(1)} 100`} strokeDashoffset={`${25 - (stockVal / totalVal) * 100}`} strokeLinecap="round"
              />
              <text x="21" y="22.5" textAnchor="middle" fontSize="7" fontWeight="700" className="fill-zinc-700 dark:fill-zinc-200">
                {((stockVal / totalVal) * 100).toFixed(0)}% EQ
              </text>
            </svg>
            <div className="min-w-0 flex-1">
              <div className="mb-1.5 space-y-1 text-xs">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-sky-500" aria-hidden="true" />
                  <span className="text-zinc-500">Stocks</span>
                  <span className="ml-auto font-mono font-semibold">₹{inr(stockVal, 0)}</span>
                  <span className="w-10 text-right font-mono text-zinc-400">{((stockVal / totalVal) * 100).toFixed(0)}%</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-violet-500" aria-hidden="true" />
                  <span className="text-zinc-500">Mutual Funds</span>
                  <span className="ml-auto font-mono font-semibold">₹{inr(mfVal, 0)}</span>
                  <span className="w-10 text-right font-mono text-zinc-400">{((mfVal / totalVal) * 100).toFixed(0)}%</span>
                </div>
              </div>
              <div className="flex h-2.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div className="h-full bg-sky-500" style={{ width: `${(stockVal / totalVal) * 100}%` }} />
                <div className="h-full bg-violet-500" style={{ width: `${(mfVal / totalVal) * 100}%` }} />
              </div>
            </div>
          </div>
        )}

        {sectors.length > 0 && sectorTotal > 0 && (
          <div className="mt-4">
            <div className="mb-1.5 text-[11px] uppercase tracking-wide text-zinc-500">Stock allocation by sector</div>
            <div className="mb-2 flex h-2.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              {sectors.map(([sec, val], i) => (
                <div
                  key={sec}
                  title={`${sec}: ₹${inr(val, 0)} (${((val / sectorTotal) * 100).toFixed(1)}%)`}
                  className={`h-full ${SECTOR_COLORS[i % SECTOR_COLORS.length]}`}
                  style={{ width: `${(val / sectorTotal) * 100}%` }}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {sectors.map(([sec, val], i) => (
                <span key={sec} className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
                  <span className={`inline-block h-2 w-2 rounded-sm ${SECTOR_COLORS[i % SECTOR_COLORS.length]}`} />
                  {sec} {((val / sectorTotal) * 100).toFixed(0)}%
                </span>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card
        title="Dividends"
        hint="Log payouts you actually received — they feed the XIRR above"
      >
        <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_130px_auto]">
          <StockSymbolInput
            symbol={divSym}
            onPick={(s) => setDivSym(s)}
            onText={(s) => setDivSym(s)}
          />
          <input
            value={divAmt}
            onChange={(e) => setDivAmt(e.target.value.replace(/[^\d.]/g, ""))}
            placeholder="Amount ₹"
            inputMode="decimal"
            className={inputCls}
          />
          <button
            type="button"
            onClick={() => {
              const amt = parseFloat(divAmt);
              if (!divSym.trim()) return;
              if (!Number.isFinite(amt) || amt <= 0) return;
              divMut.mutate({ symbol: divSym.trim().toUpperCase(), amount_total: amt });
            }}
            disabled={divMut.isPending || !divSym.trim() || !divAmt}
            className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
          >
            {divMut.isPending ? "…" : "Log"}
          </button>
        </div>
        {dividends.length === 0 ? (
          <p className="text-xs text-zinc-500">No dividends logged yet.</p>
        ) : (
          <div className="space-y-1">
            {dividends.slice(0, 8).map((dv) => (
              <div key={dv.id} className="flex items-center gap-2 text-xs">
                <span className="font-medium">{dv.symbol}</span>
                <span className="font-mono text-sky-500">+₹{inr(dv.amount_total)}</span>
                {dv.note && <span className="truncate text-zinc-500">{dv.note}</span>}
                <span className="ml-auto text-zinc-400">{new Date(dv.ts * 1000).toLocaleDateString("en-IN")}</span>
                <button
                  type="button"
                  onClick={() => divDel.mutate(dv.id)}
                  className="text-zinc-400 hover:text-rose-500"
                  title="Delete"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <AddHoldingCard />
        <ImportCard />
      </div>

      <Card
        title="Holdings"
        hint="Sorted by current value · weight is each holding's share of your portfolio"
      >
        {sumQ.isLoading ? (
          <TableSkeleton rows={6} cols={5} />
        ) : sumQ.isError ? (
          <div className="py-6 text-center text-sm text-rose-400">failed to load portfolio summary</div>
        ) : (
          <HoldingsTable rows={sorted} />
        )}
      </Card>

      {d && d.insights.length > 0 && (
        <Card title="Insights" hint="Automatically generated from your holdings — not investment advice">
          <ul className="space-y-2">
            {d.insights.map((ins, i) => (
              <li
                key={i}
                className={`rounded-lg px-3 py-2 text-sm ring-1 ${
                  ins.kind === "concentration"
                    ? "bg-amber-500/10 text-amber-600 ring-amber-500/20 dark:text-amber-400"
                    : "bg-zinc-50 text-zinc-700 ring-zinc-200 dark:bg-zinc-950/60 dark:text-zinc-300 dark:ring-zinc-800"
                }`}
              >
                {ins.text}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-zinc-500">
            Your holdings are stored only in this dashboard's local database — never uploaded anywhere.
            Never share your demat password or OTP with any website or app.
          </p>
        </Card>
      )}
    </div>
  );
}
