/**
 * Server-rendered views + embedded design system. Zero external assets: the
 * whole UI is one self-contained HTML document per page (portable, preview-safe).
 *
 * v4 design: Riara University identity — white & purple, gold crest accents,
 * full dark mode, quiet top-header shell, splash entry, command palette, toasts.
 */
import { EMAIL_CATEGORY_LABELS, LIFECYCLE_LABELS, LIFECYCLE_ORDER, type EmailCategory, type LifecycleStage, type Priority, type StaffUser } from "../types";

export type Theme = "light" | "dark";

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-KE", { hour12: false, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso ?? "—";
  return d.toLocaleString("en-KE", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** SLA countdown text (feature 28). */
export function slaText(dueAt: string | null, handledAt: string | null): string {
  if (!dueAt) return "";
  if (handledAt) return "handled";
  const ms = new Date(dueAt).getTime() - Date.now();
  if (ms <= 0) {
    const over = Math.round(-ms / 60000);
    return over >= 60 ? `overdue ${Math.floor(over / 60)}h ${over % 60}m` : `overdue ${over}m`;
  }
  const mins = Math.round(ms / 60000);
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m left` : `${mins}m left`;
}

export function confidenceBadge(c: string): string {
  const cls = c === "high" ? "b-green" : c === "medium" ? "b-orange" : "b-red";
  return `<span class="badge ${cls}">${esc(c)}</span>`;
}

/** Numeric PDF readability (0-100) with a thin bar; >=75 is the auto-pass gate. */
export function readabilityScore(score: number | undefined, threshold = 75): string {
  const s = Math.max(0, Math.min(100, Math.round(score ?? 0)));
  const ok = s >= threshold;
  const cls = ok ? "b-green" : s >= 40 ? "b-orange" : "b-red";
  return `<span class="scorewrap"><span class="badge ${cls}">${s}% readable</span>
    <span class="scorebar" title="PDF readability ${s}% — automatic pass needs ${threshold}%"><span class="scorebar-fill ${ok ? "good" : "low"}" style="width:${s}%"></span></span></span>`;
}

export function triageBadge(t: string | null): string {
  if (!t) return `<span class="badge b-gray">—</span>`;
  const cls = t === "Green" ? "b-green" : t === "Orange" ? "b-orange" : "b-red";
  return `<span class="badge ${cls}"><span class="bdot">●</span>${esc(t)}</span>`;
}

export function priorityBadge(p: Priority): string {
  const cls = p === "urgent" ? "b-red" : p === "high" ? "b-orange" : "b-gray";
  return `<span class="badge ${cls}">${esc(p)}</span>`;
}

export function lifecycleBadge(l: LifecycleStage): string {
  const cls =
    l === "completed" ? "b-green" : l === "awaiting_review" ? "b-orange" : l === "verification" ? "b-blue" : "b-purple";
  return `<span class="badge ${cls}">${esc(LIFECYCLE_LABELS[l])}</span>`;
}

export function categoryBadge(c: EmailCategory | null): string {
  if (!c) return "";
  return `<span class="badge b-gray">${esc(EMAIL_CATEGORY_LABELS[c])}</span>`;
}

export function lifecycleStepper(current: LifecycleStage): string {
  const idx = LIFECYCLE_ORDER.indexOf(current);
  const steps = LIFECYCLE_ORDER.map((s, i) => {
    const cls = i < idx ? "step done" : i === idx ? "step current" : "step";
    return `<div class="${cls}"><span class="dot">${i < idx ? "✓" : i === idx ? "●" : ""}</span>${esc(LIFECYCLE_LABELS[s])}</div>`;
  });
  return `<div class="stepper">${steps.join('<div class="step-line"></div>')}</div>`;
}

/** Classy purple gauge: a 280° arc ring, the count centre-stage. Clicking it
 * opens that pipeline level in Admissions — the number is always a door. */
export function gauge(opts: { n: number; label: string; href: string; tone?: "purple" | "green" | "orange" | "blue" | "red"; caption?: string }): string {
  const tone = opts.tone ?? "purple";
  const n = Math.max(0, opts.n);
  // Ring progress: relative to a soft ceiling so small numbers still read;
  // the exact count always shows as a numeral, so the ring is a mood, not a lie.
  const ceiling = Math.max(10, Math.ceil(n * 1.35));
  const frac = n === 0 ? 0 : Math.max(0.06, Math.min(n / ceiling, 1));
  const R = 46;
  const CIRC = 2 * Math.PI * R;
  const ARC = 0.78 * CIRC; // 280° of the circle is the dial
  const filled = frac * ARC;
  return `<a class="gauge g-${tone}" href="${esc(opts.href)}" title="Open ${esc(opts.label)}">
    <span class="g-ring">
      <svg viewBox="0 0 110 110" width="118" height="118" aria-hidden="true">
        <circle class="g-track" cx="55" cy="55" r="${R}"/>
        <circle class="g-arc" cx="55" cy="55" r="${R}" stroke-dasharray="${ARC.toFixed(1)} ${CIRC.toFixed(1)}" stroke-dashoffset="${(ARC - filled).toFixed(1)}"/>
      </svg>
      <span class="g-n">${n}</span>
    </span>
    <span class="g-l">${esc(opts.label)}</span>
    ${opts.caption ? `<span class="g-c">${esc(opts.caption)}</span>` : ""}
  </a>`;
}

/** A row of gauges. */
export function gaugeRow(gauges: Array<Parameters<typeof gauge>[0]>): string {
  return `<div class="gauges">${gauges.map((g) => gauge(g)).join("")}</div>`;
}

/** The staff clock — big, top of the dashboard, ticking locally. */
export function heroClock(): string {
  return `<div class="clock" id="clock" aria-label="Current time">
    <span class="clock-time" id="clock-time">--:--:--</span>
    <span class="clock-date" id="clock-date"></span>
  </div>`;
}

/** Deterministic gradient initials avatar. */
export function avatar(name: string | null | undefined, size = 34): string {
  const n = String(name ?? "").trim() || "?";
  const initials =
    n
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => (w[0] ?? "").toUpperCase())
      .join("") || "?";
  const palette: Array<[string, string]> = [
    ["#6D28D9", "#A78BFA"],
    ["#4338CA", "#818CF8"],
    ["#0F766E", "#2DD4BF"],
    ["#B45309", "#F59E0B"],
    ["#BE123C", "#FB7185"],
    ["#1D4ED8", "#60A5FA"],
    ["#7E22CE", "#E879F9"],
  ];
  let h = 0;
  for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [c1, c2] = palette[h % palette.length];
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px;background:linear-gradient(135deg,${c1},${c2})">${esc(initials)}</span>`;
}

/** The official full Riara University logo; the image itself is served once
 * at /assets/logo and cached, pages only reference the path. The white
 * variant renders in dark mode so the mark blends with its background. */
export function crest(size = 40, variant: "auto" | "white" = "auto"): string {
  if (variant === "white") {
    return `<span class="crest" style="height:${size}px"><img src="/assets/logo-white" alt="Riara University"></span>`;
  }
  return `<span class="crest" style="height:${size}px"><img class="logo-c" src="/assets/logo" alt="Riara University"><img class="logo-w" src="/assets/logo-white" alt=""></span>`;
}

/** The signature motif: one thin flowing purple line — progress, connection. */
export function flowLine(width = 220, height = 34): string {
  return `<svg class="flowline" width="${width}" height="${height}" viewBox="0 0 220 34" fill="none" aria-hidden="true" preserveAspectRatio="xMinYMid meet"><path d="M2 28 C 42 28, 52 6, 92 6 S 150 30, 184 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="210" cy="9" r="2.6" fill="currentColor"/></svg>`;
}

export function flagLabel(t: string): string {
  const special: Record<string, string> = {
    name_mismatch: "Name mismatch",
    grade_below_requirement: "Grade below requirement",
    low_confidence: "Low confidence",
    watcher_flag: "Watcher flag",
    duplicate_submission: "Duplicate submission",
    identity_check: "Identity check",
    late_submission: "Late submission",
    anomaly: "Anomaly",
    wrong_document: "Wrong document",
  };
  if (special[t]) return special[t];
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const ICONS: Record<string, string> = {
  grid: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.8"/><rect x="14" y="3" width="7" height="7" rx="1.8"/><rect x="3" y="14" width="7" height="7" rx="1.8"/><rect x="14" y="14" width="7" height="7" rx="1.8"/></svg>`,
  inbox: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/></svg>`,
  users: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
  moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`,
  chart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15v3M12 10v8M17 6v12"/></svg>`,
  clip: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`,
  star: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 14.9 8.6 21.5 9.5 16.7 14.1 17.9 20.7 12 17.5 6.1 20.7 7.3 14.1 2.5 9.5 9.1 8.6 12 2.5z"/></svg>`,
  "star-o": `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 14.9 8.6 21.5 9.5 16.7 14.1 17.9 20.7 12 17.5 6.1 20.7 7.3 14.1 2.5 9.5 9.1 8.6 12 2.5z"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4 20-7z"/><path d="M22 2 11 13"/></svg>`,
  flag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>`,
};

export function icon(name: keyof typeof ICONS, size = 17): string {
  return `<span class="icn" style="width:${size}px;height:${size}px">${ICONS[name]}</span>`;
}

const CSS = `
@font-face { font-family: "Manrope"; font-style: normal; font-weight: 200 800; font-display: swap; src: url("/assets/fonts/manrope.woff2") format("woff2"); }
@font-face { font-family: "Instrument Serif"; font-style: normal; font-weight: 400; font-display: swap; src: url("/assets/fonts/instrument-serif.woff2") format("woff2"); }
@font-face { font-family: "Instrument Serif"; font-style: italic; font-weight: 400; font-display: swap; src: url("/assets/fonts/instrument-serif-italic.woff2") format("woff2"); }
:root {
  /* Warm editorial light theme — purple leads. */
  --bg: #F8F6FC; --card: #FFFFFF; --card2: #F5F2EE;
  --ink: #17151A; --muted: #6C6773; --line: #E6E0EE; --line2: #F0EBF4;
  --purple: #4B1FA6; --purple-hover: #3E1A8A; --purple2: #7C3AED; --purple3: #A78BFA;
  --lav: #EDE7F7; --lav-line: #DDD2F2;
  --magenta: #A02080; --magenta-bg: #F7EBF3; --magenta-line: #E8C9DF;
  --gold: #8A6A1F; --gold-bg: #F6EFD9;
  --green: #13795B; --green-bg: #E5F3EC; --green-line: #C4E4D3;
  --orange: #B45309; --orange-bg: #FAF0E1; --orange-line: #EBD6B4;
  --red: #B42318; --red-bg: #FAEAE7; --red-line: #EFC9C2;
  --blue: #1D4ED8; --blue-bg: #E9EEFA; --blue-line: #C9D5F0;
  --shadow: 0 1px 2px rgba(23,21,26,.04), 0 6px 20px -14px rgba(23,21,26,.16);
  --shadow-lg: 0 2px 6px rgba(23,21,26,.05), 0 22px 44px -20px rgba(23,21,26,.24);
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  --sans: "Manrope", system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  --display: "Instrument Serif", Georgia, "Times New Roman", serif;
}
[data-theme="dark"] {
  --bg: #131017; --card: #1C1824; --card2: #241F2E;
  --ink: #F3F1EA; --muted: #9C97A6; --line: #2E2839; --line2: #282233;
  --purple: #7C4DD8; --purple-hover: #8B5CF6; --purple2: #A78BFA; --purple3: #C4B5FD;
  --lav: #262138; --lav-line: #3A3155;
  --magenta: #E06BC0; --magenta-bg: #331430; --magenta-line: #5C2450;
  --gold: #D9B25F; --gold-bg: #2C2413;
  --green: #4ADE80; --green-bg: #13291C; --green-line: #1E4A2E;
  --orange: #FBBF24; --orange-bg: #33260F; --orange-line: #584315;
  --red: #FB7185; --red-bg: #351420; --red-line: #5B2136;
  --blue: #60A5FA; --blue-bg: #14243D; --blue-line: #1E3E6B;
  --shadow: 0 1px 2px rgba(0,0,0,.4), 0 10px 30px -14px rgba(0,0,0,.55);
  --shadow-lg: 0 2px 6px rgba(0,0,0,.5), 0 28px 60px -20px rgba(0,0,0,.7);
}
* { box-sizing: border-box; }
button:disabled, .btn[disabled] { opacity: .55; cursor: not-allowed; transform: none; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; clip: rect(0 0 0 0); overflow: hidden; }
a:focus-visible, button:focus-visible, .btn:focus-visible, .iconbtn:focus-visible,
.tabs a:focus-visible, .searchbtn:focus-visible, summary:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--purple2); outline-offset: 2px;
}
html { scroll-behavior: smooth; }
body {
  margin: 0; color: var(--ink);
  background:
    radial-gradient(1100px 360px at 88% -140px, color-mix(in srgb, var(--purple3) 30%, transparent), transparent 62%),
    radial-gradient(900px 320px at -8% -160px, color-mix(in srgb, var(--purple3) 16%, transparent), transparent 58%),
    var(--bg);
  background-attachment: fixed;
  font-family: var(--sans); font-size: 14.5px; line-height: 1.62;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
a { color: var(--purple2); text-decoration: none; }
a:hover { text-decoration: underline; }

/* Typography — serif does the editorial work, sans stays functional. */
h1 { font-family: var(--display); font-weight: 400; font-size: 38px; letter-spacing: -.01em; line-height: 1.12; margin: 0 0 10px; }
h2 { font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .12em; color: var(--purple2); margin: 0 0 14px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
h2 .small { font-weight: 600; text-transform: none; letter-spacing: 0; }
.kicker { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .18em; color: var(--purple2); margin-bottom: 10px; }
.lede { color: var(--muted); font-size: 15px; margin: 6px 0 0; max-width: 52ch; }
.sub { color: var(--muted); font-size: 13.5px; margin: 0 0 26px; }

/* Hero — greeting left, one quiet stat right. */
.hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 28px; margin: 8px 0 18px; padding: 26px 30px 22px; border: 1px solid var(--lav-line); border-radius: 12px; background: linear-gradient(115deg, color-mix(in srgb, var(--lav) 62%, var(--card)) 0%, var(--card) 52%, var(--card) 100%); box-shadow: var(--shadow); }
.hero h1 { margin-bottom: 4px; }
.hero .row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; min-width: 0; }
.hero.hero-center { flex-direction: column; align-items: center; text-align: center; }
.hero.hero-center .clock { border-left: none; padding-left: 0; text-align: center; margin-top: 16px; }
.herostat { text-align: right; border-left: 1px solid var(--line); padding-left: 28px; flex: none; }
.herostat .n { font-family: var(--display); font-size: 46px; line-height: 1; color: var(--ink); font-variant-numeric: tabular-nums; }
.herostat .l { color: var(--muted); font-size: 12px; letter-spacing: .06em; text-transform: uppercase; font-weight: 700; margin-top: 6px; }
.flowline { color: var(--purple2); display: block; margin: 14px 0 26px; }
.schoolrow td { background: var(--lav); color: var(--purple); font-size: 11px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; padding: 7px 12px; border-bottom: 1px solid var(--lav-line); border-top: 1px solid var(--lav-line); }
.flowline path { stroke-dasharray: 6 0; }
@media (max-width: 760px) { .hero { flex-direction: column; align-items: flex-start; } .herostat { border-left: none; padding-left: 0; text-align: left; } }

/* ── App shell: quiet top header, editorial content column ────────────── */
.app { min-height: 100vh; display: flex; flex-direction: column; }
.sitehead { position: sticky; top: 0; z-index: 40; background: color-mix(in srgb, var(--bg) 86%, transparent); backdrop-filter: blur(10px); border-bottom: 1px solid var(--lav-line); }
.sitehead::before { content: ""; display: block; height: 3px; background: linear-gradient(90deg, var(--purple) 0%, var(--purple2) 55%, var(--magenta) 100%); }
.head-in { max-width: 1480px; margin: 0 auto; padding: 0 36px; display: flex; align-items: center; gap: 26px; height: 64px; }
.head-brand { display: inline-flex; align-items: center; flex: none; line-height: 0; }
.head-brand .crest, .head-brand .crest img { display: inline-flex; align-items: center; vertical-align: middle; }
.head-nav { display: flex; align-items: center; gap: 4px; overflow-x: auto; scrollbar-width: none; }
.head-nav::-webkit-scrollbar { display: none; }
.head-nav a {
  position: relative; padding: 20px 12px 18px; color: var(--muted); font-weight: 600; font-size: 13.5px;
  text-decoration: none; white-space: nowrap; transition: color .15s;
}
.head-nav a:hover { color: var(--ink); text-decoration: none; }
.head-nav a.active { color: var(--ink); }
.head-nav a.active::after { content: ""; position: absolute; left: 12px; right: 12px; bottom: -1px; height: 2px; background: linear-gradient(90deg, var(--purple), var(--purple2)); border-radius: 2px; }
.head-nav a.active { color: var(--purple2); }
.head-right { margin-left: auto; display: flex; align-items: center; gap: 10px; flex: none; }
.userchip { display: flex; gap: 9px; align-items: center; padding-left: 12px; border-left: 1px solid var(--line); }
.userchip b { font-size: 13px; display: block; line-height: 1.25; }
.userchip small { color: var(--muted); font-size: 11px; text-transform: capitalize; }
.searchbtn {
  display: flex; align-items: center; gap: 8px; min-width: 200px; padding: 7px 11px;
  background: var(--card); border: 1px solid var(--line); border-radius: 8px; color: var(--muted);
  font-size: 12.5px; font-family: inherit; cursor: pointer; transition: border-color .15s;
}
.searchbtn:hover { border-color: var(--purple3); }
.searchbtn .kbd { margin-left: auto; }
.kbd { font-family: var(--mono); font-size: 10px; color: var(--muted); background: var(--card2); border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 5px; padding: 2px 6px; }
.iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--muted); cursor: pointer; position: relative; font-family: inherit; transition: color .15s, border-color .15s; }
.iconbtn:hover { color: var(--purple); border-color: var(--purple3); text-decoration: none; }
.iconbtn .icn svg { width: 16px; height: 16px; }
.iconbtn .pip { position: absolute; top: 6px; right: 7px; width: 7px; height: 7px; border-radius: 50%; background: var(--purple2); box-shadow: 0 0 0 2px var(--card); }
.wrap { padding: 44px 36px 88px; max-width: 1480px; width: 100%; margin: 0 auto; animation: rise .35s ease both; }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (max-width: 900px) { .head-in { padding: 0 16px; gap: 14px; } .searchbtn { min-width: 0; } .searchbtn span:not(.kbd) { display: none; } .wrap { padding: 24px 16px 56px; } }

/* ── Cards ─────────────────────────────────────────────────────────────── */
.card { background: var(--card); border: 1px solid color-mix(in srgb, var(--lav-line) 55%, var(--line)); border-radius: 12px; padding: 28px 32px; margin-bottom: 28px; box-shadow: var(--shadow); }
.card.nopad { padding: 0; overflow: hidden; }
.card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 20px 24px 0; }
.card-head h2 { margin: 0; }
.card .kv { margin: 4px 0 0; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 36px; align-items: start; }
.cols.wide { grid-template-columns: 7fr 3fr; }
.cols > .card { margin-bottom: 24px; }
.cols3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 28px; align-items: start; }
@media (max-width: 1000px) { .cols3 { grid-template-columns: 1fr; } }
@media (max-width: 1000px) { .cols, .cols.wide { grid-template-columns: 1fr; } }

/* Key–value rows: the quiet replacement for stat-card grids. */
.kv { display: grid; gap: 0; font-size: 13.5px; }
.kv > div { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 9px 0; border-bottom: 1px solid var(--line2); }
.kv > div:last-child { border-bottom: none; }
.kv span { color: var(--muted); }
.kv b { font-weight: 700; text-align: right; font-variant-numeric: tabular-nums; }
.kv dt { color: var(--muted); font-weight: 600; } .kv dd { margin: 0; }
.stat { border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; background: var(--card); }
.stat .n { font-family: var(--display); font-size: 30px; line-height: 1.1; font-variant-numeric: tabular-nums; }
.stat .l { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .1em; margin-top: 4px; font-weight: 700; }
.stat.alert .n { color: var(--red); }
.grid.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 18px; }

/* Attention list — numbers and words, no coloured tiles. */
.attn-row { display: flex; align-items: center; gap: 16px; padding: 12px 24px; border-bottom: 1px solid var(--line2); color: var(--ink); text-decoration: none; transition: background .12s; }
.attn-row:last-child { border-bottom: none; }
.attn-row:hover { background: var(--card2); text-decoration: none; }
.attn-row .n { font-family: var(--display); font-size: 24px; min-width: 44px; text-align: right; font-variant-numeric: tabular-nums; }
.attn-row .t-red { color: var(--red); } .attn-row .t-orange { color: var(--orange); }
.attn-row .t-blue { color: var(--blue); } .attn-row .t-green { color: var(--green); }
.attn-row .l { font-size: 13.5px; font-weight: 600; }
.attn-row .arrow { margin-left: auto; color: var(--muted); transition: transform .15s, color .15s; }
.attn-row:hover .arrow { transform: translateX(3px); color: var(--purple); }
/* legacy attention grid (kept for compatibility) */
.attn-banner { border-left: 2px solid var(--purple2); }
.attn-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(215px, 1fr)); gap: 10px; }
.attn { display: flex; gap: 10px; align-items: center; text-decoration: none; color: var(--ink); background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 11px 13px; font-size: 12.5px; font-weight: 600; transition: border-color .15s; }
.attn:hover { border-color: var(--purple3); text-decoration: none; }
.attn .n { font-size: 18px; font-weight: 800; font-variant-numeric: tabular-nums; min-width: 26px; text-align: center; }
.attn.b-red .n { color: var(--red); } .attn.b-orange .n { color: var(--orange); }
.attn.b-blue .n { color: var(--blue); } .attn.b-green .n { color: var(--green); }
.barwrap { background: var(--line2); border-radius: 99px; height: 8px; overflow: hidden; }
.bar { background: var(--purple2); height: 100%; border-radius: 99px; }

/* ── Tables ────────────────────────────────────────────────────────────── */
table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); font-weight: 800; padding: 12px 24px; border-bottom: 1px solid var(--line); }
td { padding: 12px 24px; border-bottom: 1px solid var(--line2); vertical-align: middle; }
.card:not(.nopad) th, .card:not(.nopad) td { padding-left: 0; padding-right: 14px; }
.card:not(.nopad) th:first-child, .card:not(.nopad) td:first-child { padding-left: 0; }
tr:last-child td { border-bottom: none; }
table tr { transition: background .12s; }
.card.nopad table tr:hover td { background: var(--card2); }
.card.nopad table { margin-top: 14px; }

/* ── Badges & avatars ──────────────────────────────────────────────────── */
.badge { display: inline-flex; align-items: center; gap: 5px; border-radius: 5px; padding: 2px 9px; font-size: 11px; font-weight: 800; letter-spacing: .03em; border: 1px solid transparent; white-space: nowrap; }
.b-red { background: var(--red-bg); color: var(--red); border-color: var(--red-line); }
.b-green { background: var(--green-bg); color: var(--green); border-color: var(--green-line); }
.b-orange { background: var(--orange-bg); color: var(--orange); border-color: var(--orange-line); }
.b-blue { background: var(--blue-bg); color: var(--blue); border-color: var(--blue-line); }
.b-gray { background: var(--card2); color: var(--muted); border-color: var(--line); }
.b-magenta { background: var(--magenta-bg); color: var(--magenta); border-color: var(--magenta-line); }
.b-purple { background: var(--lav); color: var(--purple); border-color: var(--lav-line); }
.bdot { font-size: 9px; line-height: 1; display: inline-block; transform: translateY(-.5px); }
.scorewrap { display: inline-flex; align-items: center; gap: 8px; }
.scorebar { display: inline-block; width: 74px; height: 6px; border-radius: 4px; background: var(--line); overflow: hidden; vertical-align: middle; }
.scorebar-fill { display: block; height: 100%; border-radius: 4px; }
.scorebar-fill.good { background: linear-gradient(90deg, var(--purple), #8B5CF6); }
.scorebar-fill.low { background: linear-gradient(90deg, var(--orange), #F59E0B); }
.avatar { border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; color: #fff; font-weight: 800; flex: none; letter-spacing: .02em; }
.nameline { display: flex; align-items: center; gap: 9px; }
.pill { background: var(--purple2); color: #fff; border-radius: 999px; padding: 1px 8px; font-size: 11px; font-weight: 800; margin-left: 8px; }

/* ── Buttons: boringly confident ───────────────────────────────────────── */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  background: linear-gradient(180deg, var(--purple2) 0%, var(--purple) 90%); color: #fff; border: 1px solid transparent; border-radius: 8px; box-shadow: 0 1px 2px color-mix(in srgb, var(--purple) 30%, transparent);
  padding: 9px 18px; font-family: inherit; font-size: 13px; font-weight: 700; letter-spacing: .01em;
  cursor: pointer; text-decoration: none; transition: background .16s, box-shadow .16s, transform .16s, border-color .16s, color .16s;
}
.btn:hover { background: var(--purple-hover); text-decoration: none; box-shadow: 0 3px 10px -4px color-mix(in srgb, var(--purple) 55%, transparent); transform: translateY(-1px); }
.btn:active { transform: none; box-shadow: none; }
.btn.ghost { background: transparent; color: var(--ink); border-color: var(--line); }
.btn.ghost:hover { border-color: var(--purple3); color: var(--purple); background: var(--lav); box-shadow: none; }
.btn.danger { background: var(--red); }
.btn.danger:hover { background: color-mix(in srgb, var(--red) 86%, black); }
.btn.ghost.danger { background: transparent; color: var(--red); border-color: var(--red-line); }
.btn.ghost.danger:hover { background: var(--red-bg); border-color: var(--red); }
.btn.small { padding: 5px 12px; font-size: 12px; border-radius: 7px; }

/* ── Forms ─────────────────────────────────────────────────────────────── */
label { display: block; font-size: 12px; font-weight: 700; color: var(--muted); margin: 12px 0 5px; letter-spacing: .02em; }
input, select, textarea {
  width: 100%; background: var(--card); border: 1px solid var(--line); border-radius: 8px;
  color: var(--ink); font-family: inherit; font-size: 13.5px; padding: 9px 12px; transition: border-color .15s, box-shadow .15s;
}
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--purple2); box-shadow: 0 0 0 3px color-mix(in srgb, var(--purple2) 18%, transparent); }
input::placeholder, textarea::placeholder { color: color-mix(in srgb, var(--muted) 70%, transparent); }
.formrow { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-end; }
.formrow > div { flex: 1; min-width: 150px; }
input[type="checkbox"] { width: auto; }

/* ── Tabs (filters) ────────────────────────────────────────────────────── */
.tabs { display: flex; gap: 8px; flex-wrap: wrap; margin: 6px 0 22px; }
.tabs a { padding: 7px 16px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--muted); font-weight: 700; font-size: 12.5px; text-decoration: none; transition: all .15s; }
.tabs a:hover { color: var(--purple); border-color: var(--purple3); text-decoration: none; }
.tabs a.on { background: linear-gradient(160deg, var(--purple2), var(--purple)); color: #fff; border-color: var(--purple2); box-shadow: 0 2px 8px -3px color-mix(in srgb, var(--purple2) 60%, transparent); }
.tabs a.on:hover { color: #fff; }

/* ── Gauges: the dashboard dials ───────────────────────────────────────── */
.gauges { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); gap: 14px; }
.gauge {
  display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center;
  background: var(--card); border: 1px solid color-mix(in srgb, var(--lav-line) 70%, var(--line)); border-radius: 12px;
  padding: 18px 10px 14px; text-decoration: none; box-shadow: var(--shadow);
  transition: transform .16s, box-shadow .16s, border-color .16s;
}
.gauge:hover { transform: translateY(-2px); border-color: var(--purple3); box-shadow: var(--shadow-lg); text-decoration: none; }
.g-ring { position: relative; display: inline-flex; width: 118px; height: 118px; }
.g-ring svg { transform: rotate(140deg); }
.g-ring circle { fill: none; stroke-width: 9; stroke-linecap: round; }
.g-track { stroke: color-mix(in srgb, var(--lav) 80%, var(--card2)); }
.g-arc { stroke: url(#gaugeGrad); transition: stroke-dashoffset .5s ease; }
.gauge .g-n {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-family: var(--display); font-size: 40px; color: var(--ink); font-variant-numeric: tabular-nums;
}
.gauge .g-l { font-size: 12px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); margin-top: 2px; }
.gauge .g-c { font-size: 11px; color: var(--muted); }
.gauge.g-green .g-n { color: var(--green); }
.gauge.g-orange .g-n { color: var(--orange); }
.gauge.g-red .g-n { color: var(--red); }
.gauge.g-blue .g-n { color: var(--blue); }
.gauge:hover .g-l { color: var(--purple2); }

/* ── The staff clock ───────────────────────────────────────────────────── */
.clock { text-align: right; flex: none; border-left: 1px solid var(--lav-line); padding-left: 28px; }
.clock-time { display: block; font-family: var(--display); font-size: 52px; line-height: 1; color: var(--purple2); font-variant-numeric: tabular-nums; letter-spacing: .01em; }
.clock-date { display: block; color: var(--muted); font-size: 12px; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; margin-top: 7px; }
@media (max-width: 760px) { .clock { text-align: left; border-left: none; padding-left: 0; } .clock-time { font-size: 40px; } }

/* Purple form controls & scrollbars */
input[type="checkbox"], input[type="radio"] { accent-color: var(--purple2); }
* { scrollbar-width: thin; scrollbar-color: var(--purple3) transparent; }
*::-webkit-scrollbar { width: 9px; height: 9px; }
*::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--purple3) 80%, transparent); border-radius: 99px; }
*::-webkit-scrollbar-thumb:hover { background: var(--purple2); }
*::-webkit-scrollbar-track { background: transparent; }
::selection { background: color-mix(in srgb, var(--purple2) 30%, transparent); }
summary { color: var(--purple2); }
input:checked + span, .chk { accent-color: var(--purple2); }
.tabs a .cnt { opacity: .7; font-weight: 800; margin-left: 6px; font-variant-numeric: tabular-nums; }

/* ── Round 18: queue tabs, chips, rule builder, evaluation panel ───────── */
.queue-tabs { display: flex; gap: 10px; flex-wrap: wrap; margin: 4px 0 18px; }
.stat-mini { flex: 1; min-width: 150px; border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; background: var(--card); text-decoration: none; color: inherit; transition: all .15s; }
.stat-mini:hover { border-color: var(--purple3); text-decoration: none; }
.stat-mini.sel { border-color: var(--purple2); background: var(--lav); box-shadow: 0 2px 8px -3px color-mix(in srgb, var(--purple2) 55%, transparent); }
.stat-mini .n { font-family: var(--display); font-size: 26px; line-height: 1.1; font-variant-numeric: tabular-nums; display: block; }
.stat-mini.sel .n { color: var(--purple); }
.stat-mini .l { display: block; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .09em; font-weight: 700; margin-top: 3px; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; padding: 14px 20px; border-bottom: 1px solid var(--line2); }
.chip { padding: 5px 13px; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--muted); font-weight: 700; font-size: 12px; text-decoration: none; }
.chip:hover { color: var(--purple); border-color: var(--purple3); text-decoration: none; }
.chip.sel { background: var(--purple); border-color: var(--purple); color: #fff; }
.inline { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 0 0 16px; }
.inline > input, .inline > select { width: auto; }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.ctr { text-align: center; }
.ruletable { width: 100%; border-collapse: collapse; margin-top: 8px; }
.ruletable th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .09em; color: var(--muted); font-weight: 800; padding: 6px 10px; border-bottom: 1px solid var(--line); }
.ruletable td { padding: 8px 10px; border-bottom: 1px solid var(--line2); font-size: 13.5px; }
.ruletable tr:last-child td { border-bottom: none; }
.mk { width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 800; flex: none; }
.mk.ok { background: var(--green-bg); color: var(--green); }
.mk.no { background: var(--red-bg); color: var(--red); }
.mk.opt { background: var(--card2); color: var(--muted); }
.routing-block { border-radius: 10px; padding: 14px 18px; border: 1px solid var(--line); font-size: 13.5px; }
.routing-block.b-green { background: var(--green-bg); border-color: var(--green-line); color: var(--green); }
.routing-block.b-orange { background: var(--orange-bg); border-color: var(--orange-line); color: var(--orange); }
.routing-block.b-blue { background: var(--blue-bg); border-color: var(--blue-line); color: var(--blue); }
.routing-block.b-red { background: var(--red-bg); border-color: var(--red-line); color: var(--red); }
.routing-block.b-purple { background: var(--lav); border-color: var(--lav-line); color: var(--purple); }
.routing-block .small, .routing-block .muted { color: inherit; opacity: .8; }
.decision-form { margin-top: 14px; border: 1px dashed var(--line); border-radius: 10px; padding: 16px 18px; }
.decision-form .row > select, .decision-form .row > input { width: auto; flex: 1; min-width: 180px; margin: 0; }
.btn.danger { background: var(--red); border-color: var(--red); color: #fff; }
.btn.danger:hover { filter: brightness(.94); color: #fff; }
.node-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 6px 0; border-bottom: 1px dashed var(--line2); }
.node-row select, .node-row input { width: auto; margin: 0; }
.node-add { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 6px 0; }

/* ── Activity / alert feeds ────────────────────────────────────────────── */
.feed { padding: 6px 0; }
.feed-row { display: flex; gap: 14px; align-items: baseline; padding: 9px 24px; border-bottom: 1px solid var(--line2); font-size: 13px; }
.feed-row:last-child { border-bottom: none; }
.feed-row.read { opacity: .6; }
.feed-when { color: var(--muted); font-size: 12px; min-width: 108px; flex: none; font-variant-numeric: tabular-nums; }
.feed-actor { min-width: 72px; flex: none; font-size: 12px; }
.feed-event { font-weight: 700; flex: none; }
.feed-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.feed-msg { flex: 1; }
.feed-row .badge { align-self: center; flex: none; }

/* ── Empty states ──────────────────────────────────────────────────────── */
.empty { padding: 40px 24px; text-align: center; color: var(--muted); }
.empty .flowline { margin: 0 auto 16px; }
.empty p { margin: 0 0 14px; font-size: 14px; }

/* ── Mail window (gmail folders) ─────────────────────────────────────────── */
.mail-wrap { display: flex; gap: 24px; align-items: flex-start; }
.mail-side { width: 216px; flex: 0 0 216px; position: sticky; top: 84px; }
.mail-fold { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 8px; font-size: 13.5px; color: var(--ink); margin-bottom: 1px; }
.mail-fold .icn { color: var(--muted); }
.mail-fold:hover { background: var(--card2); }
.mail-fold.active { background: var(--lav); color: var(--purple); font-weight: 700; }
.mail-fold.active .icn { color: var(--purple); }
.mail-count { margin-left: auto; font-size: 12px; font-family: var(--font-body); }
.starbtn { border: 0; background: none; padding: 2px; cursor: pointer; color: var(--lav-line); display: inline-flex; }
.starbtn:hover { color: var(--purple2); }
.starbtn.on { color: var(--purple); }
@media (max-width: 860px) { .mail-wrap { flex-direction: column; } .mail-side { width: 100%; flex: none; position: static; } }

/* ── Case file components ──────────────────────────────────────────────── */
.case-grid { display: grid; grid-template-columns: minmax(0, 13fr) minmax(300px, 7fr); gap: 32px; align-items: start; }
.case-main > .card { margin-bottom: 36px; padding: 32px 34px; }
.case-main .card h2 { margin-bottom: 18px; }
.case-main dl.kv { gap: 14px 28px; }
.case-side { position: sticky; top: 84px; max-height: calc(100vh - 104px); overflow-y: auto; padding: 2px 6px 24px 2px; }
.case-side .card { padding: 26px 28px; margin-bottom: 24px; }
.case-side .card h2 { margin-bottom: 16px; }
.actionlist { display: grid; gap: 9px; }
.actionlist .btn { width: 100%; justify-content: flex-start; text-align: left; }
@media (max-width: 1000px) { .case-grid { grid-template-columns: 1fr; } .case-side { position: static; max-height: none; overflow: visible; } }
dl.kv { display: grid; grid-template-columns: max-content 1fr; gap: 10px 26px; font-size: 13.5px; }
dl.kv dt { color: var(--muted); font-weight: 600; }
dl.kv dd { margin: 0; overflow-wrap: anywhere; }
.stepper { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; margin: 4px 0 18px; }
.stepper .step { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 700; color: var(--muted); }
.stepper .step .dot { width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--card2); font-size: 11px; font-weight: 800; }
.stepper .step.done { color: var(--green); }
.stepper .step.done .dot { background: var(--green-bg); color: var(--green); }
.stepper .step.current { color: var(--purple); }
.stepper .step.current .dot { background: var(--lav); color: var(--purple); box-shadow: 0 0 0 3px var(--lav-line); }
.stepper .step-line { width: 22px; height: 2px; background: var(--line); margin: 0 6px; border-radius: 2px; }
.checklist { display: grid; gap: 6px; font-size: 14px; }
.checklist .ok { color: var(--green); font-weight: 800; }
.checklist .no { color: var(--red); font-weight: 800; }
.emailcard { border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; background: var(--card2); }
.emailcard.out { background: var(--lav); border-color: var(--lav-line); }
.emailcard pre { white-space: pre-wrap; font-size: 12.5px; color: var(--muted); margin: 8px 0 0; font-family: inherit; }
.note { background: var(--gold-bg); border: 1px solid color-mix(in srgb, var(--gold) 30%, transparent); border-radius: 8px; padding: 10px 14px; margin-bottom: 8px; font-size: 13.5px; }
.note .meta { color: var(--muted); font-size: 12px; margin-top: 3px; }
.timeline .ev { padding: 9px 0; border-bottom: 1px dashed var(--line); font-size: 13px; }
.timeline .ev:last-child { border-bottom: none; }
.timeline .t { color: var(--muted); font-size: 11.5px; }
.excerpt summary { cursor: pointer; color: var(--purple); font-weight: 700; }
.excerpt pre { background: var(--card2); border: 1px solid var(--line); border-radius: 8px; padding: 10px; font-size: 11.5px; overflow-x: auto; max-height: 260px; }
.changed { background: var(--blue-bg); border: 1px solid var(--blue-line); border-radius: 10px; padding: 12px 16px; margin-bottom: 18px; font-size: 13.5px; }
.changed b { color: var(--blue); }
.taskrow { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px dashed var(--line); font-size: 13.5px; }
.taskrow.done span.t { text-decoration: line-through; color: var(--muted); }
.steps { list-style: none; margin: 0; padding: 0; }
.steps li { position: relative; padding: 0 0 20px 30px; border-left: 2px solid var(--line); margin-left: 10px; }
.steps li::before { content: ""; position: absolute; left: -7px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--purple2); box-shadow: 0 0 0 4px var(--lav); }
.steps li:last-child { border-left-color: transparent; }
.steps .k { font-weight: 800; font-size: 13.5px; }
.steps .d { font-size: 12.5px; color: var(--muted); white-space: pre-wrap; }
.steps li.flag::before { background: var(--orange); box-shadow: 0 0 0 4px var(--orange-bg); }
.steps li.verdict::before { background: var(--green); box-shadow: 0 0 0 4px var(--green-bg); }
.resp-preview { background: var(--card2); border: 1px dashed var(--line); border-radius: 8px; padding: 14px 16px; font-size: 13px; white-space: pre-wrap; max-height: 260px; overflow: auto; margin: 12px 0; }
.heldnote { display: inline-flex; align-items: center; gap: 6px; background: var(--orange-bg); color: var(--orange); border: 1px solid var(--orange-line); border-radius: 6px; padding: 2px 9px; font-size: 11.5px; font-weight: 800; }

/* ── Login ─────────────────────────────────────────────────────────────── */
.loginbox { max-width: 400px; margin: 9vh auto; border-radius: 12px; position: relative; overflow: hidden; }
.loginbox::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: linear-gradient(90deg, var(--purple), var(--purple2), var(--magenta)); }
.loginbox .crest { display: flex; justify-content: center; margin: 4px auto 18px; }
.loginbox h1 { font-size: 32px; }
.publicbar { display: flex; align-items: center; gap: 14px; padding: 16px 32px; border-bottom: 1px solid var(--line); }
.publicbar .brand { display: flex; align-items: center; gap: 12px; }
.publicbar nav { margin-left: auto; display: flex; gap: 14px; align-items: center; }

/* ── Toast (flash messages) ────────────────────────────────────────────── */
.flash {
  position: fixed; top: 18px; right: 18px; z-index: 120; max-width: 380px;
  background: var(--card); color: var(--ink); border: 1px solid var(--green-line); border-left: 3px solid var(--green);
  border-radius: 10px; padding: 12px 16px; font-size: 13.5px; font-weight: 600; box-shadow: var(--shadow-lg);
  animation: toastIn .3s cubic-bezier(.2,.9,.3,1.15) both; cursor: pointer;
}
.flash.err { border-color: var(--red-line); border-left-color: var(--red); }
@keyframes toastIn { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: none; } }
.flash.bye { opacity: 0; transform: translateX(24px); transition: .3s; }

/* ── Command palette ───────────────────────────────────────────────────── */
.palette { position: fixed; inset: 0; z-index: 200; display: none; align-items: flex-start; justify-content: center; background: rgba(19,17,23,.45); backdrop-filter: blur(4px); padding-top: 12vh; }
.palette.open { display: flex; }
.palette-box { width: min(620px, 92vw); background: var(--card); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow-lg); overflow: hidden; animation: rise .18s ease both; }
.palette-box input { border: none; border-radius: 0; padding: 16px 18px; font-size: 15px; background: transparent; box-shadow: none; }
.palette-box input:focus { box-shadow: none; }
#palette-res { border-top: 1px solid var(--line); max-height: 330px; overflow-y: auto; }
.pal-item { display: flex; gap: 12px; align-items: center; padding: 11px 16px; cursor: pointer; border-bottom: 1px solid var(--line2); font-size: 13.5px; }
.pal-item:hover, .pal-item.sel { background: var(--lav); }
.pal-item .hint { margin-left: auto; color: var(--muted); font-size: 11.5px; }
.palette-keys { display: flex; gap: 14px; padding: 9px 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11.5px; background: var(--card2); }

/* ── Splash ────────────────────────────────────────────────────────────── */
#splash { position: fixed; inset: 0; z-index: 500; display: flex; flex-direction: column; gap: 16px; align-items: center; justify-content: center; background: var(--bg); animation: splashOut .45s ease .8s forwards; }
#splash .flowline { margin: 0; width: 160px; }
#splash .flowline path { stroke-dasharray: 260; stroke-dashoffset: 260; animation: draw 1.1s ease forwards; }
#splash .s-sub { color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: .24em; font-weight: 700; }
@keyframes draw { to { stroke-dashoffset: 0; } }
@keyframes splashOut { to { opacity: 0; visibility: hidden; } }

/* ── Misc ──────────────────────────────────────────────────────────────── */
.mono { font-family: var(--mono); font-size: .95em; }
.muted { color: var(--muted); } .small { font-size: 12.5px; } .right { text-align: right; } .nowrap { white-space: nowrap; }
td, dd { overflow-wrap: break-word; }
.overdue { color: var(--red); font-weight: 700; }
.center { text-align: center; }
.icn { display: inline-flex; } .icn svg { width: 100%; height: 100%; }
details > summary { list-style: none; } details > summary::-webkit-details-marker { display: none; }
::selection { background: color-mix(in srgb, var(--purple2) 25%, transparent); }
.crest { display: inline-flex; align-items: center; flex: none; }
.crest img { height: 100%; width: auto; display: block; }
.crest .logo-w { display: none; }
[data-theme="dark"] .crest .logo-c { display: none; }
[data-theme="dark"] .crest .logo-w { display: block; }
/* OR-3: wide content (tables, strips) scrolls INSIDE its own container —
   the page itself never grows horizontal scrollbars. */
section, .card, .loginbox { max-width: 100%; overflow-x: auto; }
table { max-width: 100%; }
select, input[type="text"], input[type="password"], input[type="email"], textarea { max-width: 100%; }
.case-grid > * { min-width: 0; }
@media (max-width: 900px) { .card table { display: block; overflow-x: auto; } }
@media (max-width: 480px) {
  .wrap { padding: 18px 12px 48px; }
  .head-in { padding: 0 12px; gap: 10px; }
  .userchip div { display: none; }
  .kbd { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  /* Honour the OS setting: no splash theatre, no animated entrances. */
  *, *::before, *::after { animation-duration: .01ms !important; animation-delay: 0ms !important; transition-duration: .01ms !important; }
  html { scroll-behavior: auto; }
  #splash { display: none !important; }
}
/* ── Case file: premium admissions operations dashboard ─────────────────── */
/* Identity header — the applicant is unmistakable in two seconds. */
.case-head { display: flex; align-items: flex-start; gap: 20px; flex-wrap: wrap; padding: 26px 30px; margin: 8px 0 16px; border: 1px solid var(--lav-line); border-radius: 14px; background: linear-gradient(115deg, color-mix(in srgb, var(--lav) 52%, var(--card)) 0%, var(--card) 58%); box-shadow: var(--shadow); }
.case-head .who { display: flex; gap: 18px; align-items: center; min-width: 0; flex: 1; }
.case-head .ident { min-width: 0; }
.case-head h1 { margin: 0 0 7px; font-size: 31px; line-height: 1.08; }
.case-head .ref-line { display: flex; gap: 7px; flex-wrap: wrap; align-items: center; color: var(--muted); font-size: 13px; margin: 0 0 11px; }
.case-head .ref-line .sep { color: var(--line); }
.case-head .state-row { display: flex; gap: 7px; flex-wrap: wrap; align-items: center; }
.case-head .head-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-left: auto; }
.case-head .head-actions .btn { white-space: nowrap; }

/* Horizontal lifecycle stepper — progress at a glance, not a wall of buttons. */
.stepper-band { background: var(--card); border: 1px solid color-mix(in srgb, var(--lav-line) 55%, var(--line)); border-radius: 12px; padding: 20px 26px 18px; margin-bottom: 26px; box-shadow: var(--shadow); }
.stepper-band .stepper { margin: 0; justify-content: space-between; }
.stepper .step { font-size: 12px; font-weight: 700; color: color-mix(in srgb, var(--muted) 55%, transparent); }
.stepper .step .dot { width: 26px; height: 26px; background: var(--card2); color: var(--muted); border: 1px solid var(--line); transition: all .2s; }
.stepper .step.done { color: var(--muted); }
.stepper .step.done .dot { background: var(--green-bg); color: var(--green); border-color: var(--green-line); }
.stepper .step.current { color: var(--purple); font-weight: 800; }
.stepper .step.current .dot { background: linear-gradient(160deg, var(--purple2), var(--purple)); color: #fff; border-color: transparent; box-shadow: 0 0 0 4px var(--lav), 0 2px 8px -2px color-mix(in srgb, var(--purple2) 60%, transparent); }
.stepper .step-line { flex: 1; min-width: 14px; height: 2px; background: var(--line); margin: 0 10px; }
@media (max-width: 760px) { .stepper-band .stepper { justify-content: flex-start; } .stepper .step-line { min-width: 8px; margin: 0 5px; } }

/* Section shells — page → section → content, no card-in-card nesting. */
.sec { background: var(--card); border: 1px solid color-mix(in srgb, var(--lav-line) 55%, var(--line)); border-radius: 13px; padding: 26px 30px; margin-bottom: 26px; box-shadow: var(--shadow); }
.sec > .sec-head { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
.sec > .sec-head h2 { margin: 0; }
.sec .sec-sub { color: var(--muted); font-size: 12.5px; margin: -10px 0 16px; }
.case-main .sec.tight { padding: 22px 26px; }

/* Enterprise metadata grid — labels above values, never a form. */
.meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(215px, 1fr)); gap: 20px 34px; }
.meta-grid .field .lbl { display: block; font-size: 10.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .13em; color: var(--muted); margin-bottom: 5px; }
.meta-grid .field .val { font-size: 14px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.meta-grid .field .val .sub { display: block; color: var(--muted); font-weight: 500; font-size: 12.5px; margin-top: 2px; }
.op-strip { display: flex; gap: 30px; flex-wrap: wrap; margin-top: 22px; padding-top: 20px; border-top: 1px dashed var(--line); }
.op-strip .op .lbl { display: block; font-size: 10.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .13em; color: var(--muted); margin-bottom: 4px; }
.op-strip .op .val { font-size: 13.5px; font-weight: 600; }

/* Admission requirements summary. */
.req-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; }
@media (max-width: 700px) { .req-cols { grid-template-columns: 1fr; } }
.req-list { margin: 0; padding: 0; list-style: none; }
.req-list li { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line2); font-size: 13.5px; font-weight: 600; }
.req-list li:last-child { border-bottom: none; }
.req-list .mk { width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 800; flex: none; }
.req-list .mk.ok { background: var(--green-bg); color: var(--green); }
.req-list .mk.no { background: var(--red-bg); color: var(--red); }
.req-list .mk.opt { background: var(--card2); color: var(--muted); }
.req-list .rule { color: var(--muted); font-weight: 500; font-size: 12px; margin-left: auto; text-align: right; }
.req-progress { display: flex; align-items: center; gap: 16px; padding: 16px 20px; border-radius: 10px; background: var(--lav); border: 1px solid var(--lav-line); margin-top: 20px; }
.req-progress .big { font-family: var(--display); font-size: 30px; line-height: 1; color: var(--purple); font-variant-numeric: tabular-nums; }
.req-progress .cap { font-size: 12.5px; font-weight: 600; color: var(--purple); }
.req-progress.full .big { color: var(--green); }
.req-progress.full { background: var(--green-bg); border-color: var(--green-line); }
.req-progress.full .cap { color: var(--green); }

/* Document checklist table — the evidence at the centre of the page. */
.doctable { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.doctable th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); font-weight: 800; padding: 10px 14px 12px; border-bottom: 1px solid var(--line); }
.doctable td { padding: 13px 14px; border-bottom: 1px solid var(--line2); vertical-align: middle; }
.doctable tr.doc-main { cursor: pointer; transition: background .12s; }
.doctable tr.doc-main:hover td { background: var(--card2); }
.doctable .doc-name { font-weight: 700; display: flex; align-items: center; gap: 10px; }
.doctable .chev { color: var(--muted); transition: transform .18s; flex: none; }
.doctable tr.open .chev { transform: rotate(90deg); color: var(--purple); }
.doctable tr.doc-detail { display: none; }
.doctable tr.doc-detail.on { display: table-row; }
.doctable tr.doc-detail td { background: var(--card2); padding: 18px 22px; border-bottom: 1px solid var(--line); }
.doc-detail .kv2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px 24px; margin-bottom: 14px; }
.doc-detail .kv2 .k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .11em; color: var(--muted); font-weight: 800; margin-bottom: 3px; }
.doc-detail .kv2 .v { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.doc-detail .raw { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; font-size: 11.5px; color: var(--muted); white-space: pre-wrap; max-height: 220px; overflow: auto; margin: 0; font-family: var(--mono); }
@media (max-width: 700px) { .doctable th:nth-child(5), .doctable td:nth-child(5) { display: none; } }

/* Communication timeline. */
.mail-item { border: 1px solid var(--line); border-radius: 10px; margin-bottom: 12px; background: var(--card); overflow: hidden; }
.mail-item.out { background: color-mix(in srgb, var(--lav) 40%, var(--card)); border-color: var(--lav-line); }
.mail-item > summary { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 13px 16px; cursor: pointer; list-style: none; }
.mail-item > summary::-webkit-details-marker { display: none; }
.mail-item > summary:hover { background: var(--card2); }
.mail-item .m-sub { font-weight: 700; font-size: 13.5px; flex: 1; min-width: 160px; }
.mail-item .m-when { color: var(--muted); font-size: 12px; white-space: nowrap; }
.mail-item .m-body { padding: 4px 16px 16px; }
.mail-item .m-body pre { white-space: pre-wrap; font-size: 12.5px; color: var(--ink); background: var(--card2); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin: 0; font-family: inherit; line-height: 1.6; max-height: 340px; overflow: auto; }

/* Activity tabs (Activity / Status history / Audit log). */
.mini-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 18px; }
.mini-tabs button { background: none; border: none; border-bottom: 2px solid transparent; padding: 9px 14px; font-family: inherit; font-size: 12.5px; font-weight: 700; color: var(--muted); cursor: pointer; letter-spacing: .02em; }
.mini-tabs button:hover { color: var(--ink); }
.mini-tabs button.on { color: var(--purple); border-bottom-color: var(--purple2); }
.tabpane { display: none; }
.tabpane.on { display: block; }

/* Right-column operations. */
.ops-card { background: var(--card); border: 1px solid color-mix(in srgb, var(--lav-line) 55%, var(--line)); border-radius: 13px; padding: 22px 24px; margin-bottom: 22px; box-shadow: var(--shadow); }
.ops-card h2 { margin-bottom: 14px; }
.ops-card .ops-sub { color: var(--muted); font-size: 12px; margin: -8px 0 14px; }
.ops-primary .btn { width: 100%; justify-content: flex-start; }
.ops-secondary { display: grid; gap: 8px; margin-top: 10px; }
.ops-secondary .btn { width: 100%; justify-content: flex-start; }
.ops-divider { border: none; border-top: 1px dashed var(--line); margin: 16px 0; }
.ops-inline { display: flex; gap: 8px; align-items: center; }
.ops-inline select { flex: 1; }

/* Flags — visible, not dominating. */
.flag-item { display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; border-radius: 9px; border: 1px solid var(--orange-line); background: var(--orange-bg); margin-bottom: 10px; }
.flag-item.red { border-color: var(--red-line); background: var(--red-bg); }
.flag-item .fd { font-size: 13px; line-height: 1.5; }
.flag-item .fd .human { display: block; color: var(--muted); font-size: 11.5px; margin-top: 3px; font-weight: 600; }

/* Draft held for approval — obviously unsent. */
.draft-card { border-left: 4px solid var(--orange); }
.draft-card .heldnote { margin-left: 8px; }

/* Internal notes — the boundary with the applicant is unmistakable. */
.note-banner { display: inline-flex; align-items: center; gap: 7px; background: var(--gold-bg); color: var(--gold); border: 1px solid color-mix(in srgb, var(--gold) 35%, transparent); border-radius: 6px; padding: 3px 10px; font-size: 10.5px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 12px; }

@media print {
  .sitehead, .no-print, .flash, .palette, #splash { display: none !important; }
  body { background: #fff; }
  .card { box-shadow: none; border-color: #ccc; break-inside: avoid; }
  .sec, .ops-card, .stepper-band, .case-head { box-shadow: none; border-color: #ccc; break-inside: avoid; }
}

`;

const PALETTE_JS = `
(function () {
  var pal = document.getElementById('palette');
  if (!pal) return;
  var q = document.getElementById('palette-q');
  var res = document.getElementById('palette-res');
  var sel = 0; var items = []; var timer = null;

  var LINKS = __PALETTE_LINKS__;

  function close() { pal.classList.remove('open'); q.value = ''; render([]); }
  function open() { pal.classList.add('open'); sel = 0; setTimeout(function(){ q.focus(); }, 10); run(); }
  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function render(list) {
    items = list;
    res.innerHTML = list.length ? list.map(function (it, i) {
      return '<div class="pal-item' + (i === sel ? ' sel' : '') + '" data-i="' + i + '">' +
        (it.avatar || '') + '<span>' + esc(it.label) + (it.sub ? ' <span class="muted small">' + esc(it.sub) + '</span>' : '') + '</span>' +
        '<span class="hint">' + esc(it.hint || '') + '</span></div>';
    }).join('') : '<div class="pal-item muted">No matches.</div>';
    Array.prototype.forEach.call(res.querySelectorAll('.pal-item[data-i]'), function (el) {
      el.addEventListener('click', function () { go(Number(el.dataset.i)); });
    });
  }
  function go(i) { if (items[i]) location.href = items[i].href; }

  function run() {
    var term = q.value.trim();
    if (!term) { sel = 0; render(LINKS); return; }
    var links = LINKS.filter(function (l) { return (l.label + ' ' + l.keys).toLowerCase().indexOf(term.toLowerCase()) >= 0; });
    res.innerHTML = '<div class="pal-item muted">Searching…</div>';
    clearTimeout(timer);
    timer = setTimeout(function () {
      fetch('/api/search?q=' + encodeURIComponent(term), { headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var out = (j.applicants || []).map(function (a) {
            return { label: a.ref_number, sub: a.name + ' · ' + a.email, hint: a.lifecycle.replace(/_/g,' '), href: '/case/' + a.id, avatar: a.avatar };
          });
          sel = 0; render(out.concat(links));
        })
        .catch(function () { sel = 0; render(links); });
    }, 140);
  }

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); pal.classList.contains('open') ? close() : open(); }
    if (!pal.classList.contains('open')) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); render(items); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(items); }
    if (e.key === 'Enter') { e.preventDefault(); go(sel); }
  });
  var sb = document.getElementById('searchbtn');
  if (sb) sb.addEventListener('click', open);
  pal.addEventListener('click', function (e) { if (e.target === pal) close(); });
  q.addEventListener('input', function () { sel = 0; run(); });
})();
`;

const TOAST_JS = `
(function () {
  var t = document.querySelector('.flash');
  if (!t) return;
  t.addEventListener('click', function () { t.remove(); });
  setTimeout(function () { t.classList.add('bye'); setTimeout(function () { t.remove(); }, 350); }, 5200);
  document.querySelectorAll('[data-rel]').forEach(function (el) {
    var ts = new Date(el.getAttribute('data-rel')).getTime();
    if (isNaN(ts)) return;
    var diff = Date.now() - ts;
    var txt;
    if (diff < 90e3) txt = 'just now';
    else if (diff < 3600e3) txt = Math.round(diff / 60e3) + 'm ago';
    else if (diff < 86400e3) txt = Math.round(diff / 3600e3) + 'h ago';
    else if (diff < 7 * 86400e3) txt = Math.round(diff / 86400e3) + 'd ago';
    else return;
    el.textContent = txt;
  });
})();
`;

const CLOCK_JS = `
(function () {
  var t = document.getElementById('clock-time');
  if (!t) return;
  var d = document.getElementById('clock-date');
  function tick() {
    var now = new Date();
    var h = now.getHours(), m = now.getMinutes(), sec = now.getSeconds();
    var ampm = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    t.textContent = (h12 < 10 ? ' ' : '') + h12 + ':' + (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec + ' ' + ampm;
    if (d) d.textContent = now.toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  tick();
  setInterval(tick, 1000);
})();
`;

export function layout(opts: {
  title: string;
  content: string;
  user?: StaffUser;
  unread?: number;
  active?: string;
  publicPage?: boolean;
  csrf?: string;
  theme?: Theme;
  /** Brand name — fixed to the institution; there is no settings field for it. */
  institution?: string;
}): string {
  const theme: Theme = opts.theme === "dark" ? "dark" : "light";
  const otherTheme = theme === "dark" ? "light" : "dark";
  const inst = opts.institution ?? "Riara University";

  const themeBtn = `<form method="post" action="/theme" style="display:inline">
      <button class="iconbtn" title="Switch to ${otherTheme} mode">${icon(theme === "dark" ? "sun" : "moon")}</button>
    </form>`;

  // Ctrl+K palette links follow the same role separation as the navigation.
  const paletteLinks: Array<{ label: string; hint: string; href: string; keys: string }> = [];
  if (opts.user) {
    paletteLinks.push({ label: "Overview", hint: "home", href: "/", keys: "dashboard home overview" });
    paletteLinks.push({ label: "Admissions", hint: "pipeline stages", href: "/admissions", keys: "admissions applications pipeline levels received checked review completed" });
    paletteLinks.push({ label: "Queues", hint: "queues", href: "/applicants", keys: "queues cases review waiting documents human decision enquiries applicants" });
    if (opts.user.role === "admin") {
      paletteLinks.push(
        { label: "Staff Configuration", hint: "team", href: "/staff", keys: "staff team accounts performance courses ownership" },
        { label: "Configuration", hint: "setup", href: "/config", keys: "courses requirements gmail templates intakes" },
        { label: "Settings", hint: "app", href: "/settings", keys: "settings automation targets retention" }
      );
    }
    paletteLinks.push({ label: "Alerts", hint: "alerts", href: "/#alerts", keys: "alerts notifications bell" });
    paletteLinks.push({ label: "Account", hint: "profile", href: "/account", keys: "account profile username password theme dark light appearance" });
    if (opts.user?.role === "admin") paletteLinks.push({ label: "Templates", hint: "email templates", href: "/templates", keys: "templates emails replies placeholders pack reset" });
  }
  const paletteJs = PALETTE_JS.replace("__PALETTE_LINKS__", JSON.stringify(paletteLinks));

  let shell: string;
  if (opts.user) {
    const role = opts.user.role;
    // Role-separated navigation: admins administer, officers/IT work cases.
    // Round 3: Mail and Compose open in the SAME tab — the app never opens
    // a new browser window (owner requirement).
    const nav: Array<{ href: string; label: string; active: string }> = [
      { href: "/", label: "Overview", active: "dashboard" },
      { href: "/admissions", label: "Admissions", active: "admissions" },
      { href: "/applicants", label: "Queues", active: "applicants" },
      { href: "/mail", label: "Mail", active: "mail" },
      { href: "/compose", label: "Compose", active: "compose" },
      ...(role === "admin"
        ? [
            { href: "/staff", label: "Staff Configuration", active: "staff" },
            { href: "/config", label: "Configuration", active: "config" },
            { href: "/templates", label: "Templates", active: "templates" },
            { href: "/settings", label: "Settings", active: "settings" },
          ]
        : []),
      { href: "/account", label: "Account", active: "account" },
    ];
    shell = `
<div class="app">
  <header class="sitehead">
    <div class="head-in">
      <a class="head-brand" href="/">${crest(27)}<span class="sr-only">${esc(inst)} — automated admissions</span></a>
      <nav class="head-nav">
        ${nav.map((n) => `<a href="${n.href}" class="${opts.active === n.active ? "active" : ""}">${n.label}</a>`).join("")}
      </nav>
      <div class="head-right">
        <button class="searchbtn" id="searchbtn">${icon("search", 15)}<span>Search…</span><span class="kbd">Ctrl K</span></button>
        ${themeBtn}
        <a class="iconbtn" href="/#alerts" title="Alerts">${icon("bell", 16)}${opts.unread ? `<span class="pip"></span>` : ""}</a>
        <div class="userchip">
          ${avatar(opts.user.display_name, 30)}
          <div><b>${esc(opts.user.display_name)}</b><small>${esc(opts.user.role)}</small></div>
        </div>
        <form method="post" action="/logout" style="margin:0"><input type="hidden" name="_csrf" value="${esc(opts.csrf)}"><button class="iconbtn" title="Sign out"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg></button></form>
      </div>
    </div>
  </header>
  <main class="wrap">
${opts.content}
  </main>
</div>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <linearGradient id="gaugeGrad" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#8B5CF6"/><stop offset="55%" stop-color="#7C3AED"/><stop offset="100%" stop-color="#4B1FA6"/>
  </linearGradient>
</defs></svg>
<div class="palette" id="palette">
  <div class="palette-box">
    <input id="palette-q" type="text" placeholder="Jump to a case, applicant or page…" autocomplete="off" spellcheck="false">
    <div id="palette-res"></div>
    <div class="palette-keys"><span><span class="kbd">↑↓</span> navigate</span><span><span class="kbd">↵</span> open</span><span><span class="kbd">esc</span> close</span><span style="margin-left:auto">Riara University · Nurturing Innovations</span></div>
  </div>
</div>`;
  } else {
    shell = `
<div class="publicbar">
  <div class="brand">${crest(30)}<span class="sr-only">${esc(inst)} — automated admissions</span></div>
  <nav>
    ${themeBtn}
  </nav>
</div>
<div class="wrap" style="max-width:960px">
${opts.content}
</div>`;
  }

  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/assets/favicon?v=3">
${opts.user ? `<meta name="csrf" content="${esc(opts.csrf ?? "")}">` : ""}
<title>${esc(opts.title)}</title>
<style>${CSS}</style>
</head>
<body>
<div id="splash" aria-hidden="true">${crest(54)}${flowLine(160, 30)}<div class="s-sub">Nurturing Innovations</div></div>
<script>
  // The greeting shield plays once per tab session. Reloads, back/forward and
  // every later page load remove it instantly so navigation never feels stuck.
  (function () {
    var sp = document.getElementById("splash");
    if (!sp) return;
    try {
      if (sessionStorage.getItem("riara.seen")) { sp.remove(); return; }
      sessionStorage.setItem("riara.seen", "1");
    } catch (e) {}
    setTimeout(function () { if (sp.parentNode) sp.remove(); }, 1600);
  })();
</script>
${shell}
<script>${paletteJs}${TOAST_JS}${CLOCK_JS}</script>
</body>
</html>`;
}
