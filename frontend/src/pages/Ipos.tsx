import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  fetchCurrentIpos,
  fetchGmpTrends,
  fetchPastIpos,
  fetchSubscription,
  fetchSubscriptionHistory,
  fetchUpcomingIpos,
  lookupNormMap,
  normIpoName,
  type IpoRow,
  type PastIpoRow,
  type PastIpoSub,
} from "../api";
import { Skeleton } from "../components/ui";

function parseDay(d?: string | null): number | null {
  if (!d) return null;
  const t = Date.parse(d);
  if (Number.isFinite(t)) return t;
  const m = d.match(/(\d{1,2})[^\d]+(\w+)[^\d]+(\d{2,4})/);
  if (!m) return null;
  const months: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const mi = months[m[2].slice(0, 3).toLowerCase()];
  if (mi == null) return null;
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  return new Date(year, mi, parseInt(m[1], 10)).getTime();
}

function openBadge(ip: IpoRow, upcoming?: boolean): { text: string; tone: string } | null {
  const now = Date.now();
  const day = 86400000;
  if (upcoming) {
    const t = parseDay(ip.open_date);
    if (t == null) return null;
    const d = Math.ceil((t - now) / day);
    if (d < 0) return null;
    if (d === 0) return { text: "Opens today", tone: "bg-amber-500/15 text-amber-600 dark:text-amber-400" };
    return { text: `Opens in ${d}d`, tone: "bg-sky-500/10 text-sky-600 dark:text-sky-400" };
  }
  const t = parseDay(ip.close_date);
  if (t == null) return null;
  const d = Math.ceil((t - now) / day);
  if (d < 0) return { text: "Closed", tone: "bg-zinc-500/10 text-zinc-500" };
  if (d === 0) return { text: "Closes today", tone: "bg-rose-500/10 text-rose-600 dark:text-rose-400" };
  return { text: `Closes in ${d}d`, tone: `bg-emerald-500/10 text-emerald-600 dark:text-emerald-400` };
}

const CATEGORY_INFO: Record<string, string> = {
  qib: "QIB — big institutions (mutual funds, banks, insurers)",
  nii: "NII — all non-institutional / HNI bidders combined",
  shni: "SHNI — Small HNI: bids above ₹2 lakh up to ₹10 lakh",
  bhni: "BHNI — Big HNI: bids above ₹10 lakh",
  rii: "Retail — individuals bidding up to ₹2 lakh",
  employees: "Employees — shares reserved for company staff",
};

export interface GmpSpot {
  gmp: number | null;
  first: number | null;
  trend: "up" | "down" | "flat";
}

/** GMP by normalized IPO name, shared by the IPO tables (one cached query). */
export function useGmpMap(): Map<string, GmpSpot> {
  const q = useQuery({ queryKey: ["gmp-trends"], queryFn: fetchGmpTrends, staleTime: 300_000 });
  return useMemo(() => {
    const map = new Map<string, GmpSpot>();
    for (const s of q.data?.data.series ?? []) {
      const key = normIpoName(s.name);
      if (key && !map.has(key)) map.set(key, { gmp: s.current, first: s.first, trend: s.trend });
    }
    return map;
  }, [q.data]);
}

export function GmpCell({ name, gmpMap }: { name?: string | null; gmpMap: Map<string, GmpSpot> }) {
  const spot = lookupNormMap(gmpMap, name);
  if (!spot || spot.gmp == null)
    return <span className="text-zinc-600">—</span>;
  const delta = spot.first != null ? spot.gmp - spot.first : null;
  const up = spot.trend === "up";
  return (
    <span title={delta ? `GMP moved ${delta > 0 ? "+" : ""}${delta.toFixed(0)} since first seen` : "Latest grey market premium"}>
      <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">₹{spot.gmp.toLocaleString("en-IN")}</span>
      {delta != null && delta !== 0 && (
        <span className={`ml-1 font-mono text-[10px] ${up ? "text-emerald-500" : "text-rose-400"}`}>
          {delta > 0 ? "+" : ""}{delta.toFixed(0)}
        </span>
      )}
    </span>
  );
}

export function SubPill({ value }: { value?: number | null }) {
  if (value == null) return <span className="text-zinc-600">—</span>;
  return (
    <span
      className={`rounded-md px-2 py-0.5 font-mono text-xs font-semibold ${
        value >= 5
          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
          : value >= 1
            ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
            : "bg-zinc-500/10 text-zinc-400"
      }`}
    >
      {value.toFixed(2)}x
    </span>
  );
}

function SubBar({ label, value, max, hint }: { label: string; value: number | null; max: number; hint?: string }) {
  if (value == null) return null;
  const pct = Math.min(100, (value / Math.max(max, 0.01)) * 100);
  const color =
    value >= 5
      ? "bg-gradient-to-r from-emerald-500 to-emerald-400"
      : value >= 1
        ? "bg-gradient-to-r from-amber-500 to-amber-400"
        : "bg-gradient-to-r from-rose-500 to-rose-400";
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-zinc-600 dark:text-zinc-400" title={hint}>
          {label}
        </span>
        <span className="font-mono font-semibold">{value.toFixed(2)}x</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div className={`h-full rounded-full ${color} transition-all duration-700`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function IpoTimelineStepper({ openDate, closeDate }: { openDate?: string | null; closeDate?: string | null }) {
  const steps = [
    { label: "Bidding Opens", date: openDate ?? "—" },
    { label: "Bidding Closes", date: closeDate ?? "—" },
    { label: "Basis of Allotment", date: "~1-2 days after" },
    { label: "Exchange Listing", date: "~3 days after" },
  ];

  return (
    <div className="pt-1">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
        Issue Timeline
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {steps.map((s, idx) => (
          <div key={idx} className="rounded-lg bg-zinc-100/80 p-2 text-xs ring-1 ring-zinc-200/50 dark:bg-zinc-900/90 dark:ring-zinc-800/50">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-zinc-400">
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/15 text-[9px] font-bold text-emerald-600 dark:text-emerald-400">
                {idx + 1}
              </span>
              <span>Step {idx + 1}</span>
            </div>
            <div className="mt-1 font-medium text-zinc-800 dark:text-zinc-200">{s.label}</div>
            <div className="text-[11px] font-mono text-zinc-500">{s.date}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SubscriptionPanel({ ipo }: { ipo: IpoRow }) {
  const symbol = ipo.symbol ?? "";
  const subQ = useQuery({
    queryKey: ["sub", symbol],
    queryFn: () => fetchSubscription(symbol),
    refetchInterval: 30000,
  });
  const histQ = useQuery({
    queryKey: ["subhist", symbol],
    queryFn: () => fetchSubscriptionHistory(symbol),
  });

  const d = subQ.data?.data;
  const cats = ["qib", "shni", "bhni", "nii", "rii", "employees"].filter(
    (k) => d && (d as unknown as Record<string, number | null>)[k] != null
  );
  const maxVal = d
    ? Math.max(...cats.map((k) => (d as unknown as Record<string, number | null>)[k] ?? 0), 1)
    : 1;
  const histPoints = (histQ.data?.data?.points ?? []).filter((p) => p.total_x != null);

  return (
    <div className="space-y-4 rounded-lg bg-zinc-50 p-4 ring-1 ring-zinc-200 dark:bg-zinc-950/60 dark:ring-zinc-800">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-zinc-200 pb-3 dark:border-zinc-800">
        <div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">Overall demand</div>
          <div className="font-mono text-2xl font-bold">{d?.total_x != null ? `${d.total_x.toFixed(2)}x` : ipo.total_x != null ? `${ipo.total_x.toFixed(2)}x` : "—"}</div>
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          <div>Price band</div>
          <div className="font-mono text-sm text-zinc-800 dark:text-zinc-200">{ipo.price_band ?? "—"}</div>
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          <div>Bidding window</div>
          <div className="font-mono text-sm text-zinc-800 dark:text-zinc-200">{ipo.open_date} – {ipo.close_date}</div>
        </div>
        {ipo.bids_received && (
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            <div>Shares bid</div>
            <div className="font-mono text-sm text-zinc-800 dark:text-zinc-200">{Number(ipo.bids_received).toLocaleString("en-IN")}</div>
          </div>
        )}
      </div>

      {subQ.isLoading && <div className="text-sm text-zinc-500">fetching live subscription…</div>}
      {d && cats.length > 0 && (
        <div className="space-y-2.5">
          {cats.map((k) => (
            <SubBar
              key={k}
              label={k.toUpperCase()}
              value={(d as unknown as Record<string, number | null>)[k]}
              max={maxVal}
              hint={CATEGORY_INFO[k]}
            />
          ))}
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-600">
        x-times = how many times more shares were bid for than offered. Hover a category for what it means. Updates every 30s while open.
      </p>
      <IpoTimelineStepper openDate={ipo.open_date} closeDate={ipo.close_date} />
      {histPoints.length > 1 && (
        <div className="h-40">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={histPoints.map((p) => ({ ...p, time: new Date(p.t * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) }))}>
              <CartesianGrid stroke="#8884" strokeDasharray="3 3" />
              <XAxis dataKey="time" tick={{ fill: "#888", fontSize: 11 }} />
              <YAxis tick={{ fill: "#888", fontSize: 11 }} width={35} />
              <Tooltip contentStyle={{ background: "#18181b", border: "1px solid #555", borderRadius: 8 }} labelStyle={{ color: "#aaa" }} />
              <Line type="monotone" dataKey="total_x" name="Total x" stroke="#34d399" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function IpoTable({ upcoming, gmpMap }: { upcoming?: boolean; gmpMap: Map<string, GmpSpot> }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const q = useQuery({
    queryKey: [upcoming ? "ipo-upcoming" : "ipo-current"],
    queryFn: upcoming ? fetchUpcomingIpos : fetchCurrentIpos,
  });
  const all: IpoRow[] = q.data?.data.ipos ?? [];
  const needle = filter.trim().toLowerCase();
  const ipos = needle
    ? all.filter((ip) => `${ip.name ?? ""} ${ip.symbol ?? ""}`.toLowerCase().includes(needle))
    : all;

  if (!q.data)
    return (
      <div className="space-y-2" aria-label="Loading IPOs">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  if (ipos.length === 0)
    return (
      <div className="py-6 text-center text-sm text-zinc-500">
        {all.length === 0
          ? `No ${upcoming ? "upcoming" : "active"} IPOs right now.`
          : `No IPO matches “${filter}”.`}
      </div>
    );

  return (
    <div>
      {all.length > 4 && (
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter these IPOs…"
          aria-label="Filter IPOs"
          className="mb-2 w-full max-w-xs rounded-xl border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none placeholder:text-zinc-400 focus:border-emerald-500 dark:border-zinc-800 dark:bg-zinc-950/70 dark:placeholder:text-zinc-600 dark:focus:border-emerald-500/50"
        />
      )}
      <div className="nice-scroll overflow-x-auto">
        <table className="tnum w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              <th className="py-2 pr-4 font-medium">IPO</th>
              <th className="py-2 pr-4 font-medium">Price Band</th>
              <th className="py-2 pr-4 font-medium">Open–Close</th>
              <th className="py-2 pr-4 font-medium">Subscribed</th>
              <th className="py-2 pr-4 font-medium" title="Grey market premium, joined by issue name">GMP</th>
              <th className="py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {ipos.map((ip, i) => {
              const isOpen = !upcoming && expanded !== null && expanded === ip.symbol;
              return (
                <>
                  <tr
                    key={`${ip.symbol}-${i}`}
                    className={`border-b border-zinc-100 last:border-0 dark:border-zinc-800/50 ${
                      isOpen ? "bg-emerald-500/5" : ""
                    }`}
                  >
                    <td className="py-2 pr-4">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{ip.name ?? ip.symbol}</span>
                        {(() => {
                          const b = openBadge(ip, upcoming);
                          return b ? (
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${b.tone}`}>
                              {b.text}
                            </span>
                          ) : null;
                        })()}
                      </div>
                      <div className="tnum text-xs text-zinc-500">
                        {ip.symbol} · {ip.series ?? ""}
                      </div>
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">{ip.price_band}</td>
                    <td className="whitespace-nowrap py-2 pr-4 text-xs text-zinc-400">
                      {ip.open_date} – {ip.close_date}
                    </td>
                    <td className="py-2 pr-4">
                      <SubPill value={ip.total_x} />
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      <GmpCell name={ip.name ?? ip.symbol} gmpMap={gmpMap} />
                    </td>
                    <td className="py-2 text-right">
                      {!upcoming && ip.symbol && (
                        <button
                          type="button"
                          onClick={() => setExpanded((cur) => (cur === ip.symbol ? null : ip.symbol))}
                          className={`whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                            isOpen
                              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                              : "border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                          }`}
                        >
                          {isOpen ? "Hide details ▴" : "Show details ▾"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={`${ip.symbol}-detail-${i}`} className="border-b border-zinc-100 dark:border-zinc-800/50">
                      <td colSpan={6} className="p-0 pb-3">
                        <SubscriptionPanel ipo={ip} />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PastSubPanel({ ip }: { ip: PastIpoRow }) {
  const qc = useQueryClient();
  const symbol = ip.symbol ?? "";
  const histQ = useQuery({
    queryKey: ["subhist", symbol],
    queryFn: () => fetchSubscriptionHistory(symbol),
    enabled: !!symbol,
  });
  const [liveMsg, setLiveMsg] = useState<string | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);

  const sub: PastIpoSub | null = ip.sub ?? null;
  const cats = ["qib", "shni", "bhni", "nii", "rii", "employees"].filter(
    (k) => sub && (sub as unknown as Record<string, number | null>)[k] != null
  );
  const maxVal = sub
    ? Math.max(...cats.map((k) => (sub as unknown as Record<string, number | null>)[k] ?? 0), 1)
    : 1;
  const histPoints = (histQ.data?.data?.points ?? []).filter((p) => p.total_x != null);

  const loadLive = async () => {
    if (!symbol || liveBusy) return;
    setLiveBusy(true);
    setLiveMsg(null);
    try {
      await fetchSubscription(symbol);
      qc.invalidateQueries({ queryKey: ["ipo-past"] });
    } catch {
      setLiveMsg("NSE no longer publishes bidding detail for this issue.");
    } finally {
      setLiveBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl bg-zinc-50 p-4 ring-1 ring-zinc-200 dark:bg-zinc-950/60 dark:ring-zinc-800">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div>
          <div className="text-xs text-zinc-500">Final demand</div>
          <div className="font-mono text-2xl font-bold">
            {sub?.total_x != null ? `${sub.total_x.toFixed(2)}x` : "—"}
          </div>
        </div>
        {sub && (
          <div className="text-xs text-zinc-500">
            <div>Bidding detail recorded</div>
            <div className="font-mono text-sm text-zinc-700 dark:text-zinc-300">
              {ip.sub_asof ? new Date(ip.sub_asof * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—"}
            </div>
          </div>
        )}
        {ip.listing_gain_pct != null && (
          <div className="text-xs text-zinc-500">
            <div>Listing gain</div>
            <div className={`font-mono text-sm font-bold ${ip.listing_gain_pct >= 0 ? "text-emerald-500" : "text-rose-400"}`}>
              {ip.listing_gain_pct >= 0 ? "+" : ""}{ip.listing_gain_pct.toFixed(1)}%
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={loadLive}
          disabled={liveBusy || !symbol}
          title="Ask NSE for this issue's bidding detail right now (works for recently closed issues)"
          className="ml-auto rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:border-emerald-500/50 hover:text-emerald-600 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:text-emerald-400"
        >
          {liveBusy ? "Loading…" : sub ? "Refresh live" : "Load bidding detail"}
        </button>
      </div>

      {sub && cats.length > 0 && (
        <div className="space-y-2.5">
          {cats.map((k) => (
            <SubBar
              key={k}
              label={k.toUpperCase()}
              value={(sub as unknown as Record<string, number | null>)[k]}
              max={maxVal}
              hint={CATEGORY_INFO[k]}
            />
          ))}
        </div>
      )}
      {!sub && (
        <p className="text-xs leading-relaxed text-zinc-500">
          No bidding detail recorded for this issue yet — nobody opened its subscription view
          while NSE published it. {symbol ? "Try loading it live; recently closed issues usually still answer." : "This row has no NSE symbol, so there is nothing to look up."}
        </p>
      )}
      {liveMsg && <p className="text-xs text-amber-600 dark:text-amber-400">{liveMsg}</p>}

      {histPoints.length > 1 && (
        <div className="h-36">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={histPoints.map((p) => ({ ...p, time: new Date(p.t * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) }))}>
              <CartesianGrid stroke="#8884" strokeDasharray="3 3" />
              <XAxis dataKey="time" tick={{ fill: "#888", fontSize: 11 }} />
              <YAxis tick={{ fill: "#888", fontSize: 11 }} width={35} />
              <Tooltip contentStyle={{ background: "#18181b", border: "1px solid #555", borderRadius: 8 }} labelStyle={{ color: "#aaa" }} />
              <Line type="monotone" dataKey="total_x" name="Total x" stroke="#34d399" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-600">
        x-times = how many times more shares were bid for than offered. High retail + HNI
        demand often (not always) foreshadows a strong listing — compare with the gain above.
      </p>
    </div>
  );
}

function PastIposSection({ gmpMap }: { gmpMap: Map<string, GmpSpot> }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"recent" | "subscribed" | "gain">("recent");
  const q = useQuery({
    queryKey: ["ipo-past"],
    queryFn: fetchPastIpos,
    enabled: expanded,
    refetchInterval: 300000,
  });
  const all = q.data?.data.ipos ?? [];
  const withSub = all.filter((r) => r.sub?.total_x != null).length;

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = needle
      ? all.filter((r) => `${r.name ?? ""} ${r.symbol ?? ""}`.toLowerCase().includes(needle))
      : [...all];
    if (sort === "subscribed") list.sort((a, b) => (b.sub?.total_x ?? -1) - (a.sub?.total_x ?? -1));
    else if (sort === "gain")
      list.sort((a, b) => (b.listing_gain_pct ?? Number.NEGATIVE_INFINITY) - (a.listing_gain_pct ?? Number.NEGATIVE_INFINITY));
    return list;
  }, [all, search, sort]);
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.15)] sm:p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center justify-between text-left"
      >
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
            Old IPOs — Recently Listed
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-600">
            Past 60 days — issue price, listing pop, and recorded subscription demand per category
          </p>
        </div>
        <span className="tnum shrink-0 text-xs text-zinc-500">
          {q.data ? `${withSub}/${all.length} with demand` : expanded ? "▲ Hide" : "▼ Show"}
        </span>
      </button>

      {expanded && (
        <div className="mt-3">
          {!q.data ? (
            <div className="space-y-2" aria-label="Loading past IPOs">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : all.length === 0 ? (
            <div className="py-6 text-center text-sm text-zinc-500">No past IPOs found.</div>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search past IPOs…"
                  aria-label="Search past IPOs"
                  className="w-full max-w-xs rounded-xl border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none placeholder:text-zinc-400 focus:border-emerald-500 dark:border-zinc-800 dark:bg-zinc-950/70 dark:placeholder:text-zinc-600 dark:focus:border-emerald-500/50"
                />
                <div className="flex items-center gap-1 text-xs">
                  {( [["recent", "Latest"], ["subscribed", "Top demand"], ["gain", "Top gain"]] as const).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setSort(k)}
                      aria-pressed={sort === k}
                      className={`rounded-lg border px-2 py-1 font-medium transition-colors ${
                        sort === k
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : "border-zinc-200 text-zinc-500 hover:text-zinc-800 dark:border-zinc-800 dark:hover:text-zinc-200"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="tnum ml-auto text-[11px] text-zinc-500">{rows.length} issues</span>
              </div>
              {rows.length === 0 ? (
                <p className="rounded-lg bg-zinc-50 py-6 text-center text-sm text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
                  No past IPO matches “{search}”.
                </p>
              ) : (
              <div className="nice-scroll max-h-[480px] overflow-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
              <table className="tnum w-full text-left text-sm">
                <thead className="sticky top-0 bg-white dark:bg-zinc-900">
                  <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                    <th className="py-2 pl-3 pr-4 font-medium">IPO</th>
                    <th className="py-2 pr-4 font-medium">Closed</th>
                    <th className="py-2 pr-4 text-right font-medium" title="Recorded total subscription">Demand</th>
                    <th className="py-2 pr-4 text-right font-medium">Issue ₹</th>
                    <th className="py-2 pr-4 text-right font-medium">GMP</th>
                    <th className="py-2 pr-4 text-right font-medium">Listing ₹</th>
                    <th className="py-2 pr-4 text-right font-medium">Gain %</th>
                    <th className="py-2 pr-3 text-right font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((ip, i) => {
                    const key = `${ip.symbol ?? ip.name}-${i}`;
                    const open = detail === key;
                    return (
                      <>
                        <tr key={key} className={`border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/30 ${open ? "bg-emerald-500/5" : ""}`}>
                          <td className="py-2 pl-3 pr-4">
                            <div className="font-medium">{ip.name}</div>
                            {ip.symbol && <div className="font-mono text-[11px] text-zinc-500">{ip.symbol}</div>}
                          </td>
                          <td className="whitespace-nowrap py-2 pr-4 text-xs text-zinc-500 dark:text-zinc-400">
                            {ip.close_date ?? "—"}
                          </td>
                          <td className="py-2 pr-4 text-right">
                            <SubPill value={ip.sub?.total_x} />
                          </td>
                          <td className="py-2 pr-4 text-right font-mono text-xs">
                            {ip.issue_price != null ? `₹${ip.issue_price}` : ip.price_band ?? "—"}
                          </td>
                          <td className="py-2 pr-4 text-right font-mono text-xs text-zinc-500 dark:text-zinc-400">
                            {ip.gmp ?? <GmpCell name={ip.name ?? ip.symbol} gmpMap={gmpMap} />}
                          </td>
                          <td className="py-2 pr-4 text-right font-mono font-semibold">
                            {ip.listing_price != null ? `₹${ip.listing_price}` : "—"}
                          </td>
                          <td className={`py-2 pr-4 text-right font-mono text-xs ${(ip.listing_gain_pct ?? 0) >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                            {ip.listing_gain_pct != null
                              ? `${ip.listing_gain_pct >= 0 ? "+" : ""}${ip.listing_gain_pct.toFixed(2)}%`
                              : "—"}
                          </td>
                          <td className="py-2 pr-3 text-right">
                            <button
                              type="button"
                              onClick={() => setDetail((cur) => (cur === key ? null : key))}
                              aria-expanded={open}
                              className={`whitespace-nowrap rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                                open
                                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                  : "border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                              }`}
                            >
                              {open ? "Hide ▴" : "Demand ▾"}
                            </button>
                          </td>
                        </tr>
                        {open && (
                          <tr key={`${key}-detail`} className="border-b border-zinc-100 dark:border-zinc-800/50">
                            <td colSpan={8} className="p-0 pb-3 pl-3 pr-3">
                              <PastSubPanel ip={ip} />
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
              </div>
              )}
            </>
          )}
          <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-600">
            Listing price from the IPOWatch performance table where available; dates from NSE.
            Demand is the last bidding snapshot recorded while the issue was tracked — open any
            row to see the category split and load it live from NSE where still published.
          </p>
        </div>
      )}
    </section>
  );
}

export function IposPage() {
  const gmpMap = useGmpMap();
  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.15)] sm:p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
        <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">Active IPOs</h2>
        <p className="mb-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          Official NSE subscription data — how many times each issue was oversubscribed.
          GMP is joined by issue name so demand and grey-market price sit side by side.
        </p>
        <IpoTable gmpMap={gmpMap} />
      </section>
      <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.15)] sm:p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
        <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">Upcoming</h2>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">Issues opening soon on NSE</p>
        <IpoTable upcoming gmpMap={gmpMap} />
      </section>
      <PastIposSection gmpMap={gmpMap} />
    </div>
  );
}

