import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";
export function Button({
  children,
  className = "",
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
}) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 ${variant === "primary" ? "bg-emerald-300 text-slate-950 hover:bg-emerald-200" : variant === "danger" ? "border border-red-900/60 bg-red-950/50 text-red-300 hover:bg-red-950" : "border border-white/10 bg-white/[.045] text-slate-200 hover:bg-white/[.085]"} ${className}`}
    >
      {children}
    </button>
  );
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border border-white/10 bg-[#11151a] px-3 py-2.5 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-emerald-400/60 ${props.className ?? ""}`}
    />
  );
}
export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-white/[.08] bg-[#101317] ${className}`}
    >
      {children}
    </div>
  );
}
export function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "good" | "bad" | "warn" | "neutral";
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${tone === "good" ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300" : tone === "bad" ? "border-red-400/20 bg-red-400/10 text-red-300" : tone === "warn" ? "border-amber-400/20 bg-amber-400/10 text-amber-300" : "border-white/10 bg-white/5 text-slate-400"}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${tone === "good" ? "bg-emerald-300" : tone === "bad" ? "bg-red-300" : tone === "warn" ? "bg-amber-300" : "bg-slate-500"}`}
      />
      {children}
    </span>
  );
}
export function SectionHead({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && (
          <p className="mb-2 text-xs font-semibold uppercase tracking-[.18em] text-emerald-300/80">
            {eyebrow}
          </p>
        )}
        <h1 className="text-3xl font-semibold tracking-tight text-white">
          {title}
        </h1>
        {description && (
          <p className="mt-2 text-sm text-slate-400">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
