import type { ReactNode } from "react";

type Tone = "emerald" | "rose" | "amber" | "sky" | "violet" | "zinc";

const BADGE_TONES: Record<Tone, string> = {
  emerald: "bg-emerald-500/10 text-emerald-600 ring-emerald-500/30 dark:text-emerald-400",
  rose: "bg-rose-500/10 text-rose-600 ring-rose-500/30 dark:text-rose-400",
  amber: "bg-amber-500/10 text-amber-600 ring-amber-500/30 dark:text-amber-400",
  sky: "bg-sky-500/10 text-sky-600 ring-sky-500/30 dark:text-sky-400",
  violet: "bg-violet-500/10 text-violet-600 ring-violet-500/30 dark:text-violet-400",
  zinc: "bg-zinc-500/10 text-zinc-500 ring-zinc-500/30 dark:text-zinc-400",
};

export function Badge({
  tone = "zinc",
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Card({
  title,
  hint,
  meta,
  action,
  children,
  className = "",
}: {
  title: string;
  hint?: string;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.15)] sm:p-5 dark:border-zinc-800 dark:bg-zinc-900/60 dark:shadow-[0_8px_32px_-16px_rgb(0_0_0/0.6)] ${className}`}
    >
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
          {title}
        </h2>
        <div className="flex items-center gap-2">
          {action}
          {meta && <span className="text-xs text-zinc-500">{meta}</span>}
        </div>
      </div>
      {hint && <p className="mb-3 max-w-2xl text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{hint}</p>}
      {!hint && <div className="mb-3" />}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "zinc",
  title,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  const valueColor =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "rose"
        ? "text-rose-600 dark:text-rose-400"
        : tone === "sky"
          ? "text-sky-600 dark:text-sky-400"
          : tone === "amber"
            ? "text-amber-600 dark:text-amber-400"
            : "";
  return (
    <div
      title={title}
      className="rounded-xl bg-zinc-50 px-3 py-2.5 ring-1 ring-zinc-200/70 dark:bg-zinc-950/60 dark:ring-zinc-800/60"
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`tnum font-mono text-lg font-bold leading-tight ${valueColor}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-zinc-500">{sub}</div>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton rounded-lg ${className}`} />;
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-2">
          {Array.from({ length: cols }).map((_, j) => (
            <Skeleton key={j} className={`h-8 ${j === 0 ? "flex-[2]" : "flex-1"}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center dark:border-zinc-700">
      <div className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{title}</div>
      {hint && <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-zinc-500">{hint}</p>}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

export function Seg<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label ?? "View"}
      className="inline-flex gap-0.5 rounded-xl border border-zinc-200 p-0.5 dark:border-zinc-800"
    >
      {options.map((o) => (
        <button
          key={o}
          role="tab"
          aria-selected={value === o}
          type="button"
          onClick={() => onChange(o)}
          className={`rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
            value === o
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}
