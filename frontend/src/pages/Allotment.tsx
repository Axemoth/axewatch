import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addPan,
  deletePan,
  fetchAllotIssues,
  fetchAllotJob,
  fetchAllotLinks,
  fetchAllotRegistrars,
  fetchAllotResults,
  fetchPans,
  fetchSourceHealth,
  logManualResult,
  clearManualResult,
  runAllotCheck,
  startAllotCheckAll,
  validPanFormat,
  type AllotIssue,
  type AllotResult,
  type AllotSourceResult,
} from "../api";
import { EmptyState, TableSkeleton } from "../components/ui";

function RegistrarChip({ registrar, size = "md" }: { registrar: string | null; size?: "md" | "sm" }) {
  const cls = size === "sm" ? "px-1.5 py-px text-[9px]" : "px-2 py-0.5 text-[10px]";
  if (registrar === "mufg")
    return (
      <span
        title="Handled by MUFG Intime — checked automatically"
        className={`shrink-0 rounded-full font-bold uppercase ${cls} bg-violet-500/10 text-violet-600 dark:text-violet-400`}
      >
        MUFG
      </span>
    );
  if (registrar === "bigshare")
    return (
      <span
        title="Handled by Bigshare — captcha required, manual check"
        className={`shrink-0 rounded-full font-bold uppercase ${cls} bg-amber-500/10 text-amber-600 dark:text-amber-400`}
      >
        Bigshare
      </span>
    );
  if (registrar === "kfin")
    return (
      <span
        title="Handled by KFintech — checked automatically"
        className={`shrink-0 rounded-full font-bold uppercase ${cls} bg-sky-500/10 text-sky-600 dark:text-sky-400`}
      >
        KFintech
      </span>
    );
  return (
    <span
      title="Registrar not mapped yet — MUFG + KFintech still attempt automatically"
      className={`shrink-0 rounded-full border border-dashed border-zinc-300 font-bold uppercase text-zinc-400 ${cls} dark:border-zinc-700 dark:text-zinc-500`}
    >
      registrar ?
    </span>
  );
}

const ALLOT_SOURCE_LABELS: Record<string, string> = {
  allot_mufg: "MUFG auto-check",
  allot_kfin: "KFintech auto-check",
  allot_bigshare: "Bigshare auto-check",
  allot_regdir: "Registrar directory",
};

function AllotHealthStrip() {
  const q = useQuery({
    queryKey: ["sources-health"],
    queryFn: fetchSourceHealth,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const rows = (q.data?.data.sources ?? []).filter((s) => s.name.startsWith("allot"));
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-2xl border border-zinc-200 bg-white px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/60">
      <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
        Check APIs
      </span>
      {rows.length === 0 && (
        <span className="text-xs text-zinc-500">
          No checks run yet this session — run one and each API reports its health here.
        </span>
      )}
      {rows.map((s) => (
        <span
          key={s.name}
          title={
            s.state === "cooling"
              ? `Cooling down after failures — back in ~${Math.ceil(s.cooldown_remaining_s / 60)}m. Checks using it report "cooling down" instead of failing.`
              : `${s.ok} ok · ${s.fail} failed · avg ${s.avg_latency_ms}ms`
          }
          className="tnum inline-flex cursor-help items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              s.state === "ok" ? "bg-emerald-400" : s.state === "degraded" ? "bg-amber-400" : "bg-rose-400"
            }`}
          />
          {ALLOT_SOURCE_LABELS[s.name] ?? s.name}
          <span className="text-[11px] text-zinc-500">
            {s.success_rate != null ? `${s.success_rate.toFixed(0)}%` : "—"}
            {s.state === "cooling" ? ` · cools ${Math.ceil(s.cooldown_remaining_s / 60)}m` : ""}
          </span>
        </span>
      ))}
    </div>
  );
}

// issues preselected for bulk checks: recently closed only. Active bids have
// no allotment to find yet, and older issues are long final — tick them in
// individually when needed.
const RECENT_CLOSE_DAYS = 14;

function closeAgeDays(close: string | null): number | null {
  if (!close) return null;
  const m = close.trim().match(/^(\d{1,2})-([A-Za-z]{3,9})-(\d{2,4})$/);
  if (!m) return null;
  const months: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const mi = months[m[2].slice(0, 3).toLowerCase()];
  if (mi == null) return null;
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  const ts = new Date(year, mi, parseInt(m[1], 10)).getTime();
  if (!Number.isFinite(ts)) return null;
  return (Date.now() - ts) / 86400000;
}

function defaultSelectedIssues(issues: AllotIssue[]): Set<string> {
  return new Set(
    issues
      .filter((i) => {
        if (i.state !== "closed") return false;
        const age = closeAgeDays(i.close_date);
        return age === null || age <= RECENT_CLOSE_DAYS;
      })
      .map((i) => i.key)
  );
}

const inputCls =
  "w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-zinc-400 focus:border-emerald-500 dark:border-zinc-800 dark:bg-zinc-950/70 dark:placeholder:text-zinc-600 dark:focus:border-emerald-500/50";

const SOURCE_LABELS: Record<string, string> = {
  mufg: "MUFG Intime",
  kfin: "KFintech",
  bigshare: "Bigshare",
  manual: "You",
};

function StatusBadge({ result }: { result: AllotResult }) {
  if (result.overall === "allotted")
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-2.5 py-1 text-xs font-bold text-emerald-600 dark:text-emerald-400">
        Allotted{result.shares_allotted ? ` · ${result.shares_allotted} shares` : ""}
      </span>
    );
  if (result.overall === "not_allotted")
    return (
      <span
        className="rounded-lg bg-amber-500/15 px-2.5 py-1 text-xs font-bold text-amber-600 dark:text-amber-400"
        title="Your application is on record but got zero shares (lottery loss)"
      >
        Not allotted{result.shares_applied ? ` · applied ${result.shares_applied}` : ""}
      </span>
    );
  if (result.overall === "error")
    return (
      <span className="rounded-lg bg-amber-500/15 px-2.5 py-1 text-xs font-bold text-amber-600 dark:text-amber-400">
        Check failed
      </span>
    );
  if (result.overall === "uncovered")
    return (
      <span
        className="rounded-lg bg-zinc-500/10 px-2.5 py-1 text-xs font-semibold text-zinc-500"
        title="This IPO could not be mapped to an automated registrar check"
      >
        Manual check
      </span>
    );
  return (
    <span
      className="rounded-lg bg-zinc-500/10 px-2.5 py-1 text-xs font-semibold text-zinc-500"
      title="No application found for this PAN at the automated registrars — either not applied here, handled by another registrar, or rotated off"
    >
      Not applied
    </span>
  );
}

function ManualLog({ panId, issueKey, manual }: { panId: number; issueKey: string; manual?: AllotSourceResult }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [shares, setShares] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["allot-results"] });
  };
  const logMut = useMutation({
    mutationFn: (args: { outcome: "allotted" | "not_allotted"; shares?: number }) =>
      logManualResult(panId, issueKey, args.outcome, args.shares),
    onSuccess: () => {
      setOpen(false);
      setShares("");
      setErr(null);
      refresh();
    },
    onError: (e: Error) => setErr(e.message.replace(/^\w+: \d+: /, "")),
  });
  const clearMut = useMutation({
    mutationFn: () => clearManualResult(panId, issueKey),
    onSuccess: refresh,
  });

  if (manual) {
    return (
      <div className="tnum mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
        <span>
          Logged by you:{" "}
          <span className={`font-mono font-bold ${manual.outcome === "allotted" ? "text-emerald-500" : "text-amber-500"}`}>
            {manual.outcome === "allotted" ? `allotted ${manual.shares_allotted} shares` : "not allotted"}
          </span>
        </span>
        <button
          type="button"
          onClick={() => clearMut.mutate()}
          disabled={clearMut.isPending}
          className="underline-offset-2 hover:text-rose-400 hover:underline disabled:opacity-40"
        >
          Clear
        </button>
      </div>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1.5 text-[11px] text-sky-600 underline-offset-2 hover:underline dark:text-sky-400"
      >
        Checked it on the registrar site? Log the result here
      </button>
    );
  }
  const n = parseInt(shares, 10);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-lg bg-sky-500/5 px-2 py-1.5 ring-1 ring-sky-500/20">
      <input
        value={shares}
        onChange={(e) => setShares(e.target.value.replace(/[^\d]/g, "").slice(0, 6))}
        placeholder="Shares"
        inputMode="numeric"
        aria-label="Shares allotted"
        className="w-20 rounded-md border border-zinc-300 bg-white px-2 py-1 font-mono text-xs outline-none focus:border-sky-500 dark:border-zinc-700 dark:bg-zinc-950"
      />
      <button
        type="button"
        disabled={logMut.isPending || !Number.isFinite(n) || n <= 0}
        onClick={() => logMut.mutate({ outcome: "allotted", shares: n })}
        className="rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-emerald-500 disabled:opacity-40"
      >
        Allotted
      </button>
      <button
        type="button"
        disabled={logMut.isPending}
        onClick={() => logMut.mutate({ outcome: "not_allotted" })}
        className="rounded-md bg-zinc-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-zinc-500 disabled:opacity-40"
      >
        Not allotted
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setErr(null);
        }}
        className="px-1 text-[11px] text-zinc-500 hover:text-zinc-300"
      >
        Cancel
      </button>
      {err && <span className="w-full text-[11px] text-rose-400">{err}</span>}
    </div>
  );
}

function ResultRow({
  result,
  checkable,
  bigshareUrl,
  onRecheck,
  rechecking,
}: {
  result: AllotResult;
  checkable: boolean;
  bigshareUrl: string | null;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  const [open, setOpen] = useState(false);
  const needsManual = result.overall !== "allotted" && result.registrar === "bigshare";
  const manualRow = result.sources.find((s) => s.source === "manual");
  const accent =
    result.overall === "allotted"
      ? "border-l-4 border-l-emerald-500"
      : result.overall === "not_allotted"
        ? "border-l-4 border-l-amber-500"
        : result.overall === "error"
          ? "border-l-4 border-l-rose-400"
          : "border-l-4 border-l-zinc-300 dark:border-l-zinc-700";
  return (
    <div className={`rounded-xl bg-zinc-50 px-3 py-2.5 ring-1 ring-zinc-200/70 dark:bg-zinc-950/60 dark:ring-zinc-800/60 ${accent}`}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((x) => !x)}
          aria-expanded={open}
          className="min-w-0 flex-1 text-left"
        >
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold">
              {result.issue_name ?? result.issue_key}
            </span>
            <RegistrarChip registrar={result.registrar} size="sm" />
          </span>
          <span className="tnum text-[11px] text-zinc-500">
            {result.close_date ? `closed ${result.close_date}` : result.state === "active" ? "bidding / recent" : ""}
            {result.expected_allotment ? ` · allotment ~${result.expected_allotment}` : ""}
          </span>
        </button>
        <StatusBadge result={result} />
        {checkable && (
          <button
            type="button"
            onClick={onRecheck}
            disabled={rechecking}
            title="Re-check this PAN against this issue right now"
            className="rounded-lg border border-zinc-300 px-2 py-1 text-[11px] font-medium text-zinc-500 transition-colors hover:border-emerald-500/50 hover:text-emerald-600 disabled:opacity-40 dark:border-zinc-700 dark:hover:text-emerald-400"
          >
            {rechecking ? "…" : "Recheck"}
          </button>
        )}
      </div>
      {result.note && <p className="mt-1 text-[11px] text-zinc-500">{result.note}</p>}
      {needsManual && bigshareUrl && (
        <a
          href={bigshareUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 flex items-center justify-between gap-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs font-semibold text-amber-700 ring-1 ring-amber-500/25 transition-colors hover:bg-amber-500/15 dark:text-amber-300"
        >
          <span>Handled by Bigshare — captcha required, one manual step</span>
          <span className="shrink-0 rounded-md bg-amber-500/15 px-2 py-0.5">Open Bigshare check →</span>
        </a>
      )}
      {needsManual && result.registrar_name && (
        <p className="tnum mt-1 text-[11px] text-zinc-500">
          On their page select “{result.registrar_name}” from the company list, then PAN search.
        </p>
      )}
      <ManualLog panId={result.pan_id} issueKey={result.issue_key} manual={manualRow} />
      {open && (
        <div className="mt-2 space-y-1 border-t border-zinc-200 pt-2 text-xs dark:border-zinc-800">
          {result.sources.map((s, i) => (
            <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-semibold text-zinc-600 dark:text-zinc-300">
                {SOURCE_LABELS[s.source] ?? s.source}
              </span>
              {s.outcome === "allotted" ? (
                <span className="tnum font-mono text-emerald-600 dark:text-emerald-400">
                  {s.shares_allotted} allotted{s.shares_applied ? ` of ${s.shares_applied} applied` : ""}
                  {s.applicant_mask ? ` · ${s.applicant_mask}` : ""}
                </span>
              ) : s.outcome === "not_allotted" ? (
                <span className="tnum font-mono text-amber-600 dark:text-amber-400">
                  applied {s.shares_applied ?? "—"} → 0 allotted
                </span>
              ) : s.outcome === "uncovered" ? (
                <span className="text-zinc-500">
                  {s.error ??
                    (s.source === "bigshare"
                      ? "manual CAPTCHA verification required"
                      : s.source === "kfin"
                        ? "no KFintech application found; registrar not verified"
                        : "not listed at this registrar right now")}
                </span>
              ) : s.outcome === "error" ? (
                <span className="text-amber-600 dark:text-amber-400">{s.error ?? "lookup failed"}</span>
              ) : (
                <span className="text-zinc-500">no application on record</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AllotmentPage() {
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [pan, setPan] = useState("");
  const [showPan, setShowPan] = useState(false);
  const [panErr, setPanErr] = useState<string | null>(null);
  const [selPans, setSelPans] = useState<Set<number> | null>(null);
  const [selIssues, setSelIssues] = useState<Set<string> | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [poll, setPoll] = useState(false);
  const [rechecking, setRechecking] = useState<string | null>(null);
  const [resultFilter, setResultFilter] = useState<"all" | "allotted" | "not_allotted" | "not_applied" | "uncovered" | "error">("all");

  const pansQ = useQuery({ queryKey: ["allot-pans"], queryFn: fetchPans });
  const issuesQ = useQuery({ queryKey: ["allot-issues"], queryFn: fetchAllotIssues, staleTime: 300_000 });
  const resultsQ = useQuery({ queryKey: ["allot-results"], queryFn: () => fetchAllotResults(), refetchInterval: 120_000 });
  const linksQ = useQuery({ queryKey: ["allot-links"], queryFn: fetchAllotLinks, staleTime: 3600_000 });
  const regQ = useQuery({ queryKey: ["allot-registrars"], queryFn: fetchAllotRegistrars, staleTime: 3600_000 });

  const pans = pansQ.data?.data.pans ?? [];
  const issues = issuesQ.data?.data.issues ?? [];
  const links = linksQ.data?.data.links ?? [];
  const regCount = regQ.data?.data.count ?? 0;
  const bigshareUrl = links.find((l) => l.label.toLowerCase().startsWith("bigshare"))?.url ?? null;

  useEffect(() => {
    if (selPans === null && pans.length > 0) setSelPans(new Set(pans.map((p) => p.id)));
  }, [pans, selPans]);
  useEffect(() => {
    if (selIssues === null && issues.length > 0) setSelIssues(defaultSelectedIssues(issues));
  }, [issues, selIssues]);

  const jobQ = useQuery({
    queryKey: ["allot-job", jobId],
    queryFn: () => fetchAllotJob(jobId!),
    enabled: jobId != null && poll,
    refetchInterval: 3000,
  });
  const job = jobQ.data?.data;
  const jobRunning = job?.state === "running";
  useEffect(() => {
    if (jobId && job && !jobRunning) {
      setPoll(false);
      qc.invalidateQueries({ queryKey: ["allot-results"] });
    }
  }, [jobId, job, jobRunning, qc]);

  const addMut = useMutation({
    mutationFn: () => addPan(label, pan.trim().toUpperCase()),
    onSuccess: () => {
      setLabel("");
      setPan("");
      setShowPan(false);
      setPanErr(null);
      setSelPans(null);
      qc.invalidateQueries({ queryKey: ["allot-pans"] });
    },
    onError: (e: Error) => setPanErr(e.message.replace(/^\w+: \d+: /, "")),
  });
  const delMut = useMutation({
    mutationFn: deletePan,
    onSuccess: () => {
      setSelPans(null);
      setJobId(null);
      setPoll(false);
      qc.invalidateQueries({ queryKey: ["allot-pans"] });
      qc.invalidateQueries({ queryKey: ["allot-results"] });
    },
  });
  const bulkMut = useMutation({
    mutationFn: () =>
      startAllotCheckAll(
        selPans && selPans.size > 0 ? [...selPans] : undefined,
        selIssues && selIssues.size !== issues.length ? [...selIssues] : undefined
      ),
    onSuccess: (res) => {
      setJobId(res.data.job_id);
      setPoll(true);
    },
  });

  const submitPan = () => {
    const v = pan.trim().toUpperCase();
    if (!validPanFormat(v)) return setPanErr("PAN looks invalid — format is ABCDE1234F (5 letters, 4 digits, 1 letter)");
    setPanErr(null);
    addMut.mutate();
  };

  const recheck = async (panId: number, issueKey: string) => {
    const k = `${panId}:${issueKey}`;
    setRechecking(k);
    try {
      await runAllotCheck(panId, issueKey);
      qc.invalidateQueries({ queryKey: ["allot-results"] });
    } catch {
      /* surfaced on next poll / results refresh */
    } finally {
      setRechecking(null);
    }
  };

  const cachedByPan = useMemo(() => {
    const map = new Map<number, AllotResult[]>();
    for (const r of resultsQ.data?.data.results ?? []) {
      if (!map.has(r.pan_id)) map.set(r.pan_id, []);
      map.get(r.pan_id)!.push(r);
    }
    return map;
  }, [resultsQ.data]);

  // live job results take precedence over cache while running/fresh
  const liveByPan = useMemo(() => {
    if (!job || job.results.length === 0) return null;
    const map = new Map<number, AllotResult[]>();
    for (const r of job.results) {
      if (!map.has(r.pan_id)) map.set(r.pan_id, []);
      map.get(r.pan_id)!.push(r);
    }
    return map;
  }, [job]);
  const shownByPan = liveByPan ?? cachedByPan;
  const issueKeys = useMemo(() => new Set(issues.map((i) => i.key)), [issues]);

  const toggle = <T,>(set: Set<T> | null, v: T, apply: (s: Set<T>) => void) => {
    const next = new Set<T>(set ?? []);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    apply(next);
  };

  const jobPct = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-xs leading-relaxed text-amber-700 ring-1 ring-amber-500/15 dark:text-amber-300">
        <span className="font-bold">Private by design.</span> PANs stay in this dashboard's local
        database and are sent only to the registrar being queried (MUFG Intime / KFintech) —
        the same lookup you would run by hand. They are never logged, never leave this machine
        otherwise, and always display masked. BSE / NSE / Bigshare need a captcha, so those open
        as manual links below with your issue context ready.
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.15)] sm:p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
          <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
            PAN numbers
          </h2>
          <p className="mb-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            Save every family member's PAN once — bulk checks run all selected PANs together.
          </p>
          <div className="mb-2 grid gap-2 sm:grid-cols-[1fr_160px_auto]">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label, e.g. Father"
              aria-label="PAN label"
              maxLength={40}
              className={inputCls}
            />
            <div className="relative">
              <input
                value={pan}
                onChange={(e) => {
                  setPan(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10));
                  setPanErr(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitPan();
                }}
                placeholder="ABCDE1234F"
                aria-label="PAN number"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                type={showPan ? "text" : "password"}
                className={`${inputCls} pr-9 font-mono font-semibold tracking-widest`}
              />
              <button
                type="button"
                onClick={() => setShowPan((x) => !x)}
                aria-label={showPan ? "Hide PAN" : "Show PAN"}
                title={showPan ? "Hide PAN" : "Show PAN"}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:text-zinc-200"
              >
                {showPan ? (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18M10.5 5.2A9.8 9.8 0 0112 5c7 0 10 7 10 7a17 17 0 01-2.9 3.9M6.6 6.6C3.6 8.2 2 12 2 12s3 7 10 7a9.6 9.6 0 004.4-1.1" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
            <button
              type="button"
              onClick={submitPan}
              disabled={addMut.isPending || pan.trim().length !== 10}
              className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-40"
            >
              {addMut.isPending ? "…" : "Add"}
            </button>
          </div>
          {panErr && <p className="mb-2 text-xs text-rose-500">{panErr}</p>}
          {pansQ.isLoading ? (
            <TableSkeleton rows={2} cols={2} />
          ) : pans.length === 0 ? (
            <EmptyState title="No PANs saved" hint="Add your first PAN above — it never leaves this machine except for the registrar lookup itself." />
          ) : (
            <ul className="space-y-1.5">
              {pans.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2 ring-1 ring-zinc-200/70 dark:bg-zinc-950/60 dark:ring-zinc-800/60"
                >
                  <input
                    type="checkbox"
                    checked={selPans?.has(p.id) ?? true}
                    onChange={() => selPans && toggle(selPans, p.id, setSelPans)}
                    aria-label={`Include ${p.label}`}
                    className="h-4 w-4 accent-emerald-500"
                  />
                  <span className="text-sm font-medium">{p.label}</span>
                  <span className="tnum font-mono text-sm text-zinc-500">{p.masked}</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`Delete ${p.label} (${p.masked}) and its saved results?`)) delMut.mutate(p.id);
                    }}
                    title="Delete PAN and its results"
                    className="ml-auto rounded px-1.5 text-zinc-400 hover:text-rose-400"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.15)] sm:p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
              Issues to check
            </h2>
            {issues.length > 0 && (
              <span className="tnum text-xs text-zinc-500">{selIssues?.size ?? issues.length} selected</span>
            )}
          </div>
          <p className="mb-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            Recently closed issues are preselected — active bids have no allotment to find yet,
            and older ones are long final. Tick anything else in for a one-off check.
          </p>
          {issuesQ.isLoading || !issuesQ.data ? (
            <TableSkeleton rows={4} cols={2} />
          ) : issues.length === 0 ? (
            <EmptyState title="No checkable issues" hint="The backend is still warming up its issue list — try again in a minute." />
          ) : (
            <ul className="nice-scroll max-h-64 space-y-1.5 overflow-auto pr-1">
              {issues.map((iss) => (
                <li key={iss.key}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2 ring-1 ring-zinc-200/70 transition-colors hover:ring-emerald-500/30 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
                    <input
                      type="checkbox"
                      checked={selIssues?.has(iss.key) ?? true}
                      onChange={() => selIssues && toggle(selIssues, iss.key, setSelIssues)}
                      className="h-4 w-4 shrink-0 accent-emerald-500"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{iss.name ?? iss.symbol}</span>
                      <span className="tnum text-[11px] text-zinc-500">
                        {iss.state === "active" ? "bidding open" : iss.close_date ? `closed ${iss.close_date}` : "recent"}
                        {iss.expected_allotment ? ` · allotment ~${iss.expected_allotment}` : ""}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                        iss.state === "active"
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : "bg-sky-500/10 text-sky-600 dark:text-sky-400"
                      }`}
                    >
                      {iss.state}
                    </span>
                    <RegistrarChip registrar={iss.registrar} />
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.15)] sm:p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={pans.length === 0 || issues.length === 0 || bulkMut.isPending || (job?.state === "running")}
            onClick={() => bulkMut.mutate()}
            className="rounded-xl bg-emerald-600 px-6 py-2.5 text-sm font-bold text-white shadow-sm transition-all hover:bg-emerald-500 disabled:opacity-40"
          >
            {job?.state === "running" ? `Checking… ${jobPct}%` : "Check allotment for all selected"}
          </button>
          {bulkMut.isError && (
            <span className="text-xs text-rose-500">
              {(bulkMut.error as Error).message.replace(/^\w+: \d+: /, "")}
            </span>
          )}
          {job?.state === "failed" && <span className="text-xs text-rose-500">{job.error ?? "bulk check failed"}</span>}
          <span className="tnum ml-auto text-[11px] text-zinc-500">
            {selPans?.size ?? pans.length} PAN{(selPans?.size ?? pans.length) === 1 ? "" : "s"} ·{" "}
            {selIssues?.size ?? 0} issues selected
          </span>
        </div>
        {job?.state === "running" && (
          <div className="mt-3">
            <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div className="h-full rounded-full bg-emerald-500 transition-all duration-500" style={{ width: `${jobPct}%` }} />
            </div>
            <p className="tnum mt-1 text-[11px] text-zinc-500">
              {job.done}/{job.total}{job.current ? ` · checking ${job.current}` : ""}
            </p>
          </div>
        )}
      </section>

      <AllotHealthStrip />

      {(liveByPan && liveByPan.size > 0) || (cachedByPan.size > 0) ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">Show</span>
            {(["all", "allotted", "not_allotted", "not_applied", "uncovered", "error"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setResultFilter(f)}
                aria-pressed={resultFilter === f}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize transition-colors ${
                  resultFilter === f
                    ? "bg-emerald-500/15 text-emerald-600 ring-1 ring-emerald-500/30 dark:text-emerald-400"
                    : "bg-zinc-100 text-zinc-500 hover:text-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-400 dark:hover:text-zinc-200"
                }`}
              >
                {f === "not_allotted" ? "not allotted" : f === "not_applied" ? "not applied" : f}
              </button>
            ))}
          </div>
          {[...shownByPan.entries()].map(([panId, rows]) => {
            const label = pans.find((p) => p.id === panId)?.label ?? `PAN ${panId}`;
            const mask = rows[0]?.pan_mask ?? "";
            const nAllotted = rows.filter((r) => r.overall === "allotted").length;
            const nLost = rows.filter((r) => r.overall === "not_allotted").length;
            const nNone = rows.filter((r) => r.overall === "not_applied").length;
            const nUncovered = rows.filter((r) => r.overall === "uncovered").length;
            const shown = resultFilter === "all" ? rows : rows.filter((r) => r.overall === resultFilter);
            if (shown.length === 0) return null;
            return (
              <section
                key={panId}
                className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.15)] sm:p-5 dark:border-zinc-800 dark:bg-zinc-900/60"
              >
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
                    {label} <span className="tnum ml-1 font-mono normal-case text-zinc-500">{mask}</span>
                  </h2>
                  <div className="tnum flex items-center gap-1.5 text-[11px] font-bold">
                    {nAllotted > 0 && (
                      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-600 dark:text-emerald-400">
                        {nAllotted} allotted
                      </span>
                    )}
                    {nLost > 0 && (
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-600 dark:text-amber-400">
                        {nLost} not allotted
                      </span>
                    )}
                    {nNone > 0 && (
                      <span className="rounded-full bg-zinc-500/10 px-2 py-0.5 text-zinc-500">
                        {nNone} not applied
                      </span>
                    )}
                    {nUncovered > 0 && (
                      <span
                        className="rounded-full bg-zinc-500/10 px-2 py-0.5 text-zinc-500"
                        title="No registrar made a definitive automated query for these — use the manual links or log a hand-checked result"
                      >
                        {nUncovered} manual check
                      </span>
                    )}
                  </div>
                  <span className="tnum ml-auto text-[11px] text-zinc-500">
                    {shown.length} of {rows.length} shown
                  </span>
                </div>
                <div className="grid gap-2 lg:grid-cols-2">
                  {shown.map((r) => (
                    <ResultRow
                      key={`${r.issue_key}`}
                      result={r}
                      checkable={issueKeys.has(r.issue_key)}
                      bigshareUrl={bigshareUrl}
                      rechecking={rechecking === `${panId}:${r.issue_key}`}
                      onRecheck={() => recheck(panId, r.issue_key)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        !resultsQ.isLoading && (
          <EmptyState
            title="No results yet"
            hint="Select PANs and issues above, then run a check. Allotted issues will also appear here automatically on your next visit."
          />
        )
      )}

      <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.15)] sm:p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
        <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
          Manual check — captcha-walled portals
        </h2>
        <p className="mb-3 max-w-2xl text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          BSE, NSE and Bigshare need an image captcha (and BSE/NSE block bots outright), so they
          cannot be queried automatically. If an issue shows Not applied above, it may simply be
          handled by one of these{regCount > 0 ? ` — the registrar directory currently maps ${regCount} issues to their handler` : ""} —
          open the portal, pick the company, enter the same PAN.
        </p>
        <p className="mb-3 max-w-2xl text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          For older IPOs that have rotated off every registrar site: your broker's order history
          (Zerodha Console, Groww, Upstox), CDSL Easiest / NSDL CAS statements, and the bank
          account's ASBA unblock history always show what happened.
        </p>
        <div className="flex flex-wrap gap-2">
          {links.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-xl border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:border-emerald-500/50 hover:text-emerald-600 dark:border-zinc-700 dark:text-zinc-300 dark:hover:text-emerald-400"
            >
              {l.label} →
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
