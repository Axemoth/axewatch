import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { fetchCurrentIpos, fetchGmp, fetchGmpTrends, fetchPastIpos, fetchSourceHealth, lookupNormMap, normIpoName, type GmpTrendSeries } from "../api";

function Spark({ series, up }: { series: GmpTrendSeries; up: boolean }) {
  const pts = series.points.slice(-24);
  if (pts.length < 2)
    return <div className="h-10 w-28 text-right text-xs leading-10 text-zinc-600">no history yet</div>;
  return (
    <div className="h-10 w-28">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={pts.map((p) => ({ v: p.value }))} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`g-${series.name.replace(/\W/g, "")}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={up ? "#34d399" : "#fb7185"} stopOpacity={0.4} />
              <stop offset="100%" stopColor={up ? "#34d399" : "#fb7185"} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Tooltip
            contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8 }}
            labelStyle={{ display: "none" }}
            formatter={(v) => [`₹${Number(v)}`, "GMP"] as [string, string]}
          />
          <Area
            type="monotone"
            dataKey="v"
            stroke={up ? "#34d399" : "#fb7185"}
            strokeWidth={1.5}
            fill={`url(#g-${series.name.replace(/\W/g, "")})`}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  nse: "NSE market data",
  yahoo: "Yahoo Finance (stock prices)",
  mfapi: "mfapi.in (fund NAVs)",
  google_news: "Google News",
  gmp_ipowatch: "IPOWatch (GMP)",
  gmp_ipoindex: "IPOIndex (GMP)",
  gmp_investorgain: "InvestorGain (GMP)",
  ipowatch_past: "IPOWatch (past IPOs)",
};

function SourcesCard() {
  const q = useQuery({
    queryKey: ["sources-health"],
    queryFn: fetchSourceHealth,
    refetchInterval: 60_000,
  });
  const sources = q.data?.data.sources ?? [];
  if (sources.length === 0) return null;
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.15)] sm:p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
        Data Sources
      </h2>
      <p className="mb-3 text-xs text-zinc-600">
        Every scraper is health-tracked. When one starts failing it is skipped and given an
        escalating cooldown, so data keeps flowing from the alternatives.
      </p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {sources.map((s) => (
          <div
            key={s.name}
            className="rounded-lg bg-zinc-50 px-3 py-2 ring-1 ring-zinc-200 dark:bg-zinc-950/60 dark:ring-zinc-800/60"
            title={s.last_error ?? undefined}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-medium">
                {SOURCE_LABELS[s.name] ?? s.name}
              </span>
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                  s.state === "ok"
                    ? "bg-emerald-500/10 text-emerald-500"
                    : s.state === "degraded"
                      ? "bg-amber-500/10 text-amber-500"
                      : "bg-rose-500/10 text-rose-400"
                }`}
              >
                {s.state === "cooling" ? `cooling ${Math.ceil(s.cooldown_remaining_s / 60)}m` : s.state}
              </span>
            </div>
            <div className="mt-1 font-mono text-[10px] text-zinc-500">
              {s.success_rate != null ? `${s.success_rate.toFixed(0)}% ok` : "no data"}
              {" · "}
              {s.avg_latency_ms > 0 ? `${s.avg_latency_ms.toFixed(0)}ms` : "—"}
              {s.last_ok_ts ? ` · ${new Date(s.last_ok_ts * 1000).toLocaleTimeString("en-IN")}` : ""}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function parseEstimatedListing(gmpStr?: string | null, priceStr?: string | null): { estListing: number; gainPct: number } | null {
  if (!gmpStr || !priceStr) return null;
  const priceMatches = priceStr.match(/\d+(?:\.\d+)?/g);
  const gmpMatches = gmpStr.match(/\d+(?:\.\d+)?/g);
  if (!priceMatches || !gmpMatches) return null;
  const basePrice = parseFloat(priceMatches[priceMatches.length - 1]);
  const gmp = parseFloat(gmpMatches[0]);
  if (!basePrice || !gmp) return null;
  const estListing = basePrice + gmp;
  const gainPct = (gmp / basePrice) * 100;
  return { estListing, gainPct };
}

export function GmpPage() {
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"trends" | "table">("trends");
  const [status, setStatus] = useState<"All" | "Open" | "Upcoming" | "Closed" | "Allotted" | "Listed">("All");
  const [sort, setSort] = useState<"gmp" | "momentum" | "name">("gmp");
  const trendsQ = useQuery({ queryKey: ["gmp-trends"], queryFn: fetchGmpTrends });
  const tableQ = useQuery({ queryKey: ["gmp"], queryFn: fetchGmp });
  const curQ = useQuery({ queryKey: ["ipo-current"], queryFn: fetchCurrentIpos, staleTime: 120_000 });
  const pastQ = useQuery({ queryKey: ["ipo-past"], queryFn: fetchPastIpos, staleTime: 300_000 });

  // subscription demand by normalized issue name (live issues first, past snapshots after)
  const demandMap = useMemo(() => {
    const map = new Map<string, { sub_x: number; live: boolean }>();
    for (const ip of pastQ.data?.data.ipos ?? []) {
      const key = normIpoName(ip.name ?? ip.symbol);
      const x = ip.sub?.total_x;
      if (key && x != null && !map.has(key)) map.set(key, { sub_x: x, live: false });
    }
    for (const ip of curQ.data?.data.ipos ?? []) {
      const key = normIpoName(ip.name ?? ip.symbol);
      if (key && ip.total_x != null) map.set(key, { sub_x: ip.total_x, live: true });
    }
    return map;
  }, [curQ.data, pastQ.data]);

  const filtered = useMemo(() => {
    const all = trendsQ.data?.data.series ?? [];
    const s = search.trim().toLowerCase();
    let list = s ? all.filter((x) => x.name.toLowerCase().includes(s)) : [...all];
    if (status !== "All") list = list.filter((x) => (x.status ?? "") === status);
    const delta = (x: GmpTrendSeries) =>
      x.current != null && x.first != null ? x.current - x.first : 0;
    return list.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "momentum") return delta(b) - delta(a);
      return (b.current ?? 0) - (a.current ?? 0);
    });
  }, [trendsQ.data, search, status, sort]);

  const tableRows = useMemo(() => {
    const rows = tableQ.data?.data.rows ?? [];
    const s = search.trim().toLowerCase();
    return s ? rows.filter((r) => (r.name ?? "").toLowerCase().includes(s)) : rows;
  }, [tableQ.data, search]);

  const GROUP_ORDER = ["Open", "Upcoming", "Closed", "Allotted", "Listed"];
  const groups = useMemo(() => {
    const byStatus = new Map<string, typeof filtered>();
    for (const s of filtered) {
      const st = s.status ?? "Other";
      if (!byStatus.has(st)) byStatus.set(st, []);
      byStatus.get(st)!.push(s);
    }
    const ordered = GROUP_ORDER.filter((g) => byStatus.has(g)).map((g) => ({ status: g, items: byStatus.get(g)! }));
    for (const [st, items] of byStatus) {
      if (!GROUP_ORDER.includes(st)) ordered.push({ status: st, items });
    }
    return ordered;
  }, [filtered]);

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.15)] sm:p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">Grey Market Premium</h2>
          <span
            className="cursor-help text-zinc-500"
            title="GMP is the unofficial premium traders pay for IPO shares before listing. Higher GMP usually signals stronger listing gains — but it is unregulated and can change any time."
          >
            ⓘ
          </span>
          <div className="ml-auto flex gap-1 rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-800">
            {(["trends", "table"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize ${
                  view === v ? "bg-emerald-500/15 text-emerald-400" : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search grey market by IPO name — try “Augmont” or “Symbiotec”"
          aria-label="Search grey market by IPO name"
          className="mb-2.5 w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-zinc-500 focus:border-emerald-500 dark:border-zinc-800 dark:bg-zinc-950/70 dark:placeholder:text-zinc-500 dark:focus:border-emerald-500/50"
        />

        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {(["All", "Open", "Upcoming", "Closed", "Allotted", "Listed"] as const).map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatus(st)}
              aria-pressed={status === st}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                status === st
                  ? "bg-emerald-500/15 text-emerald-600 ring-1 ring-emerald-500/30 dark:text-emerald-400"
                  : "bg-zinc-100 text-zinc-500 hover:text-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
            >
              {st}
            </button>
          ))}
          <span className="mx-1 text-zinc-300 dark:text-zinc-700">·</span>
          {( (["gmp", "momentum", "name"] as const).map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => setSort(o)}
              aria-pressed={sort === o}
              title={o === "gmp" ? "Highest GMP first" : o === "momentum" ? "Biggest rise since first seen" : "Alphabetical"}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium capitalize transition-colors ${
                sort === o
                  ? "bg-sky-500/15 text-sky-600 ring-1 ring-sky-500/30 dark:text-sky-400"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
            >
              {o === "gmp" ? "Top GMP" : o}
            </button>
          )))}
          <span className="tnum ml-auto text-[11px] text-zinc-500">{filtered.length} IPOs</span>
        </div>

        {view === "trends" ? (
          <>
            <p className="mb-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              GMP movement over time — built from every snapshot Axewatch has stored. Hover a chart for values.
              The blue chip is recorded subscription demand (live while bidding, last snapshot after) — strong demand with a rising GMP is the classic strong-listing setup.
            </p>
            {!trendsQ.data ? (
              <div className="space-y-2" aria-label="Loading trends">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 rounded-lg px-2 py-1.5">
                    <div className="h-4 flex-1 rounded bg-zinc-200/70 dark:bg-zinc-800/70" />
                    <div className="h-10 w-28 rounded bg-zinc-200/70 dark:bg-zinc-800/70" />
                    <div className="h-4 w-20 rounded bg-zinc-200/70 dark:bg-zinc-800/70" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-4">
                {groups.map((g) => (
                  <div key={g.status}>
                    <div className="mb-1 flex items-center gap-2 px-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                        {g.status}
                      </span>
                      <span className="tnum rounded-full bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                        {g.items.length}
                      </span>
                      <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" aria-hidden="true" />
                    </div>
                    <div className="space-y-1">
                      {g.items.map((s) => {
                        const up = s.trend === "up";
                        const delta = s.current != null && s.first != null ? s.current - s.first : null;
                        const demand = lookupNormMap(demandMap, s.name);
                        return (
                          <div
                            key={s.name}
                            className="flex items-center gap-3 rounded-xl px-2 py-1.5 ring-1 ring-transparent transition-all hover:bg-zinc-100 hover:ring-zinc-200 dark:hover:bg-zinc-800/40 dark:hover:ring-zinc-800"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium">{s.name}</span>
                                {demand && (
                                  <span
                                    title={demand.live ? "Live NSE subscription" : "Last recorded subscription"}
                                    className="tnum shrink-0 rounded-md bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-sky-600 dark:text-sky-400"
                                  >
                                    {demand.sub_x.toFixed(1)}x{demand.live ? "" : " ·"}
                                  </span>
                                )}
                              </div>
                              <div className="tnum text-[11px] text-zinc-500 dark:text-zinc-600">
                                {s.points.length} data points
                                {demand && !demand.live ? " · sub recorded earlier" : ""}
                              </div>
                            </div>
                            <Spark series={s} up={up} />
                            <div className="tnum w-20 text-right">
                              <div className="font-mono text-sm font-semibold">₹{s.current}</div>
                              {delta != null && delta !== 0 && (
                                <div className={`font-mono text-[11px] ${up ? "text-emerald-500 dark:text-emerald-400" : "text-rose-500 dark:text-rose-400"}`}>
                                  {delta > 0 ? "+" : ""}
                                  {delta.toFixed(0)}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {filtered.length === 0 && (
                  <div className="py-6 text-center text-sm text-zinc-500">No IPO matches “{search}”.</div>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            {!tableQ.data ? (
              <div className="py-6 text-center text-sm text-zinc-500">loading table…</div>
            ) : (
              <>
                {(() => {
                  const has = (k: string) => tableRows.some((r) => (r as Record<string, unknown>)[k]);
                  const cols = [
                    { key: "gmp", label: "GMP", show: true },
                    { key: "gmp_percent", label: "GMP %", show: has("gmp_percent") },
                    { key: "est_listing", label: "Est. Listing", show: true },
                    { key: "price", label: "Price Band", show: has("price") },
                    { key: "demand", label: "Demand", show: true },
                    { key: "sub_x", label: "Subscription", show: has("sub_x") },
                    { key: "dates", label: "Dates", show: has("dates") || has("updated") },
                    { key: "type", label: "Type", show: has("type") || has("status") },
                  ].filter((c) => c.show);
                  return (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                            <th className="py-2 pr-4 font-medium">IPO</th>
                            {cols.map((c) => (
                              <th key={c.key} className="py-2 pr-4 font-medium">
                                {c.label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {tableRows.slice(0, 30).map((r, i) => (
                            <tr key={i} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/30">
                              <td className="py-2 pr-4 font-medium">{r.name ?? "—"}</td>
                              {cols.map((c) => {
                                if (c.key === "demand") {
                                  const d = lookupNormMap(demandMap, r.name);
                                  return (
                                    <td key={c.key} className="py-2 pr-4" title={d ? (d.live ? "Live NSE subscription" : "Last recorded subscription") : "No demand data for this issue"}>
                                      {d ? (
                                        <span className="rounded-md bg-sky-500/10 px-1.5 py-0.5 font-mono text-xs font-bold text-sky-600 dark:text-sky-400">
                                          {d.sub_x.toFixed(1)}x
                                        </span>
                                      ) : (
                                        <span className="text-xs text-zinc-600">—</span>
                                      )}
                                    </td>
                                  );
                                }
                                if (c.key === "est_listing") {
                                  const est = parseEstimatedListing(r.gmp, r.price);
                                  return (
                                    <td key={c.key} className="py-2 pr-4 font-mono text-xs">
                                      {est ? (
                                        <span className="font-semibold text-emerald-400">
                                          ₹{est.estListing.toLocaleString("en-IN")} ({est.gainPct >= 0 ? "+" : ""}{est.gainPct.toFixed(1)}%)
                                        </span>
                                      ) : (
                                        "—"
                                      )}
                                    </td>
                                  );
                                }
                                const raw = r as unknown as Record<string, string | null | undefined>;
                                const val =
                                  c.key === "dates"
                                    ? raw.dates ?? raw.updated
                                    : c.key === "type"
                                      ? raw.type ?? raw.status
                                      : raw[c.key];
                                const isGmp = c.key === "gmp";
                                return (
                                  <td
                                    key={c.key}
                                    className={`py-2 pr-4 ${isGmp ? "font-mono font-semibold text-emerald-400" : c.key === "gmp_percent" || c.key === "price" || c.key === "sub_x" ? "font-mono text-xs" : "whitespace-nowrap text-xs text-zinc-400"}`}
                                  >
                                    {val ?? "—"}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
                <div className="mt-2 text-right text-[11px] text-zinc-600">
                  source: {tableQ.data.data.source_used} ·{" "}
                  {new Date(tableQ.data.data.fetched_at).toLocaleTimeString("en-IN")}
                </div>
              </>
            )}
          </>
        )}
      </section>
      <SourcesCard />
    </div>
  );
}

