/**
 * Server-rendered views + embedded design system. Zero external assets: the
 * whole UI is one self-contained HTML document per page (portable, preview-safe).
 *
 * v4 design: Riara University identity — white & purple, gold crest accents,
 * full dark mode, sidebar app shell, splash entry, command palette, toasts.
 */
import { EMAIL_CATEGORY_LABELS, LIFECYCLE_LABELS, LIFECYCLE_ORDER, type EmailCategory, type LifecycleStage, type Priority, type StaffUser } from "../types";
import { LOGO_BASE64 } from "./logo";

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

export function triageBadge(t: string | null): string {
  if (!t) return `<span class="badge b-gray">—</span>`;
  const cls = t === "Green" ? "b-green" : t === "Orange" ? "b-orange" : "b-red";
  const dot = t === "Green" ? "●" : t === "Orange" ? "●" : "●";
  return `<span class="badge ${cls}"><span class="bdot">${dot}</span>${esc(t)}</span>`;
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

/** The official full Riara University logo, on a white chip; the image itself
 * is served once at /assets/logo and cached, pages only reference the path. */
export function crest(size = 40): string {
  void LOGO_BASE64; // served via /assets/logo route; kept as the source of truth
  return `<span class="crest" style="height:${size}px"><img src="/assets/logo" alt="Riara University" style="height:100%;width:auto;display:block"></span>`;
}

/** Human-readable flag names: "name_mismatch" → "Name mismatch". */
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
};

export function icon(name: keyof typeof ICONS, size = 17): string {
  return `<span class="icn" style="width:${size}px;height:${size}px">${ICONS[name]}</span>`;
}

const CSS = `
:root {
  --bg: #F6F4FB; --card: #FFFFFF; --card2: #FBFAFE;
  --ink: #201A33; --muted: #6E6787; --line: #E8E3F4; --line2: #F0ECF9;
  --purple: #5B3BD6; --purple2: #7C5CF0; --purple3: #A794FB;
  --purple-bg: #F1EDFC; --purple-line: #DCD2F7;
  --magenta: #A2157F; --magenta-bg: #FBEAF5; --magenta-line: #EFC4E2;
  --gold: #B98A2F; --gold-bg: #F8F0DD;
  --green: #2E8B3A; --green-bg: #E7F6EC; --green-line: #C4E8D0;
  --orange: #B45309; --orange-bg: #FDF1E2; --orange-line: #F3D9B4;
  --red: #BE123C; --red-bg: #FDE8ED; --red-line: #F5C2D0;
  --blue: #1D4ED8; --blue-bg: #E7EEFD; --blue-line: #C6D6F8;
  --side1: #2A1B66; --side2: #150C38; --side-ink: #CBC2E6; --side-active: #FFFFFF;
  --shadow: 0 1px 2px rgba(41,23,86,.05), 0 8px 24px -12px rgba(76,29,149,.14);
  --shadow-lg: 0 2px 6px rgba(41,23,86,.06), 0 24px 48px -18px rgba(76,29,149,.22);
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  --sans: "Inter", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
}
[data-theme="dark"] {
  --bg: #0F0C1A; --card: #191429; --card2: #1F1934;
  --ink: #EFEBFA; --muted: #9C94BC; --line: #2C2447; --line2: #251D3D;
  --purple: #A794FB; --purple2: #8F73F5; --purple3: #C4B5FD;
  --purple-bg: #2A2050; --purple-line: #3D2F6E;
  --magenta: #E06BC0; --magenta-bg: #3A1531; --magenta-line: #6B2458;
  --gold: #D9B25F; --gold-bg: #332A17;
  --green: #4ADE80; --green-bg: #13291C; --green-line: #1E4A2E;
  --orange: #FBBF24; --orange-bg: #33260F; --orange-line: #584315;
  --red: #FB7185; --red-bg: #351420; --red-line: #5B2136;
  --blue: #60A5FA; --blue-bg: #14243D; --blue-line: #1E3E6B;
  --side1: #1B1430; --side2: #0C0917; --side-ink: #A79CCB;
  --shadow: 0 1px 2px rgba(0,0,0,.4), 0 10px 30px -12px rgba(0,0,0,.5);
  --shadow-lg: 0 2px 6px rgba(0,0,0,.5), 0 28px 60px -18px rgba(0,0,0,.65);
}
* { box-sizing: border-box; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; clip: rect(0 0 0 0); overflow: hidden; }
/* Visible keyboard focus on every interactive control (accessibility). */
a:focus-visible, button:focus-visible, .btn:focus-visible, .iconbtn:focus-visible,
.tabs a:focus-visible, .searchbtn:focus-visible, summary:focus-visible {
  outline: 2px solid var(--purple2); outline-offset: 2px; border-radius: 6px;
}
html { scroll-behavior: smooth; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font-family: var(--sans); font-size: 15px; line-height: 1.62;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
a { color: var(--purple); text-decoration: none; }
a:hover { text-decoration: underline; }
h1 { font-size: 26px; font-weight: 800; letter-spacing: -.02em; margin: 0 0 8px; }
h2 { font-size: 15.5px; font-weight: 750; letter-spacing: -.01em; margin: 0 0 16px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
h2 .small { font-weight: 500; }
.sub { color: var(--muted); font-size: 13.5px; margin: 0 0 24px; }

/* ── App shell ─────────────────────────────────────────────────────────── */
.app { display: grid; grid-template-columns: 248px 1fr; min-height: 100vh; }
.sidebar {
  position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column;
  background: linear-gradient(175deg, var(--side1), var(--side2) 70%);
  padding: 20px 14px 14px; overflow-y: auto;
}
.brand { display: flex; gap: 11px; align-items: center; padding: 4px 8px 18px; border-bottom: 1px solid rgba(255,255,255,.09); }
.brand .crest { filter: drop-shadow(0 3px 8px rgba(139,92,246,.45)); flex: none; }
.brand b { color: #fff; font-size: 14.5px; letter-spacing: .01em; display: block; line-height: 1.25; }
.brand small { color: #9E93C6; font-size: 10.5px; text-transform: uppercase; letter-spacing: .16em; }
nav.side { margin: 16px 0; display: flex; flex-direction: column; gap: 2px; flex: 1; }
nav.side a {
  display: flex; align-items: center; gap: 11px; padding: 10px 14px; border-radius: 10px;
  color: var(--side-ink); font-weight: 600; font-size: 13.5px; text-decoration: none;
  transition: background .15s, color .15s;
}
nav.side a:hover { background: rgba(255,255,255,.07); color: #fff; text-decoration: none; }
nav.side a.active { background: linear-gradient(90deg, rgba(139,92,246,.32), rgba(139,92,246,.12)); color: #fff; box-shadow: inset 0 0 0 1px rgba(167,139,250,.35); }
nav.side .icn svg { width: 17px; height: 17px; }
.pill { background: var(--purple2); color: #fff; border-radius: 999px; padding: 1px 8px; font-size: 11.5px; font-weight: 700; margin-left: auto; }
.side-foot { border-top: 1px solid rgba(255,255,255,.09); padding-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.userchip { display: flex; gap: 10px; align-items: center; padding: 4px 8px; }
.userchip b { color: #fff; font-size: 13px; display: block; line-height: 1.3; }
.userchip small { color: #9E93C6; font-size: 11.5px; }
.userchip form { margin-left: auto; }

.main { min-width: 0; display: flex; flex-direction: column; }
.topbar {
  position: sticky; top: 0; z-index: 40; display: flex; align-items: center; gap: 12px;
  padding: 14px 34px; background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: blur(12px); border-bottom: 1px solid var(--line);
}
.searchbtn {
  display: flex; align-items: center; gap: 9px; min-width: 280px; padding: 8px 12px;
  background: var(--card); border: 1px solid var(--line); border-radius: 10px; color: var(--muted);
  font-size: 13px; cursor: pointer; box-shadow: var(--shadow);
}
.searchbtn:hover { border-color: var(--purple3); }
.searchbtn .kbd { margin-left: auto; }
.kbd { font-family: var(--mono); font-size: 10.5px; color: var(--muted); background: var(--card2); border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 6px; padding: 2px 6px; }
.top-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--muted); cursor: pointer; position: relative; box-shadow: var(--shadow); }
.iconbtn:hover { color: var(--purple); border-color: var(--purple3); text-decoration: none; }
.iconbtn .icn svg { width: 17px; height: 17px; }
.iconbtn .pip { position: absolute; top: 7px; right: 8px; width: 8px; height: 8px; border-radius: 50%; background: var(--red); box-shadow: 0 0 0 2px var(--card); }
.wrap { padding: 34px 36px; max-width: 1280px; width: 100%; margin: 0 auto; animation: rise .35s ease both; }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

/* ── Cards & stats ─────────────────────────────────────────────────────── */
.card { background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 24px 26px; box-shadow: var(--shadow); margin-bottom: 22px; }
.card.nopad { padding: 0; overflow: hidden; }
.grid.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 18px; }
.stat { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; box-shadow: var(--shadow); position: relative; overflow: hidden; }
.stat::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 3px; background: linear-gradient(180deg, var(--purple2), transparent); opacity: .85; }
.stat .n { font-size: 26px; font-weight: 800; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.stat .l { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .12em; margin-top: 3px; font-weight: 600; }
.stat.alert .n { color: var(--red); }
.stat.alert::before { background: linear-gradient(180deg, var(--red), transparent); }

.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.cols > .card { margin-bottom: 18px; }
@media (max-width: 1000px) { .cols { grid-template-columns: 1fr; } .app { grid-template-columns: 1fr; } .sidebar { position: static; height: auto; } .searchbtn { min-width: 0; } }

/* ── Attention banner ──────────────────────────────────────────────────── */
.attn-banner { border-left: 4px solid var(--purple2); background: linear-gradient(90deg, var(--purple-bg), var(--card) 45%); }
.attn-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(215px, 1fr)); gap: 10px; }
.attn { display: flex; gap: 10px; align-items: center; text-decoration: none; color: var(--ink); background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 11px 13px; font-size: 12.5px; font-weight: 550; transition: .15s; box-shadow: var(--shadow); }
.attn:hover { border-color: var(--purple3); transform: translateY(-1px); box-shadow: var(--shadow-lg); text-decoration: none; }
.attn .n { font-size: 19px; font-weight: 800; font-variant-numeric: tabular-nums; min-width: 26px; text-align: center; }
.attn.b-red .n { color: var(--red); } .attn.b-orange .n { color: var(--orange); }
.attn.b-blue .n { color: var(--blue); } .attn.b-green .n { color: var(--green); }
.barwrap { background: var(--line2); border-radius: 99px; height: 10px; overflow: hidden; }
.bar { background: linear-gradient(90deg, var(--purple2), var(--purple)); height: 100%; border-radius: 99px; }

/* ── Tables ────────────────────────────────────────────────────────────── */
table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); font-weight: 700; padding: 11px 14px; border-bottom: 1px solid var(--line); }
td { padding: 12px 14px; border-bottom: 1px solid var(--line2); vertical-align: middle; }
tr:last-child td { border-bottom: none; }
tbody tr, table tr { transition: background .12s; }
table tr:hover td { background: var(--card2); }

/* ── Badges, avatars, chips ────────────────────────────────────────────── */
.badge { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; padding: 2.5px 10px; font-size: 11.5px; font-weight: 700; letter-spacing: .02em; border: 1px solid transparent; white-space: nowrap; }
.bdot { font-size: 8px; line-height: 1; }
.b-green { background: var(--green-bg); color: var(--green); border-color: var(--green-line); }
.b-orange { background: var(--orange-bg); color: var(--orange); border-color: var(--orange-line); }
.b-red { background: var(--red-bg); color: var(--red); border-color: var(--red-line); }
.b-blue { background: var(--blue-bg); color: var(--blue); border-color: var(--blue-line); }
.b-purple { background: var(--purple-bg); color: var(--purple); border-color: var(--purple-line); }
.b-gray { background: var(--line2); color: var(--muted); border-color: var(--line); }
.avatar { display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; color: #fff; font-weight: 700; flex: none; letter-spacing: .02em; box-shadow: inset 0 0 0 2px rgba(255,255,255,.25), 0 2px 6px rgba(76,29,149,.25); }
.nameline { display: flex; gap: 10px; align-items: center; }

/* ── Forms & buttons ───────────────────────────────────────────────────── */
label { display: block; font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .09em; color: var(--muted); margin: 12px 0 5px; }
input[type="text"], input[type="email"], input[type="password"], input[type="date"], input[type="number"], select, textarea {
  width: 100%; padding: 9px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--card);
  color: var(--ink); font-family: inherit; font-size: 14px; outline: none; transition: border .15s, box-shadow .15s;
}
input:focus, select:focus, textarea:focus { border-color: var(--purple2); box-shadow: 0 0 0 3px color-mix(in srgb, var(--purple2) 22%, transparent); }
textarea { resize: vertical; }
.formrow { display: flex; gap: 12px; flex-wrap: wrap; align-items: stretch; }
.formrow > div { flex: 1; min-width: 160px; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  background: linear-gradient(135deg, var(--purple2), var(--purple)); color: #fff; border: 1px solid transparent;
  padding: 9px 16px; border-radius: 10px; font-family: inherit; font-size: 13.5px; font-weight: 700; cursor: pointer;
  box-shadow: 0 6px 16px -6px color-mix(in srgb, var(--purple) 55%, transparent); transition: .15s; text-decoration: none;
}
.btn:hover { filter: brightness(1.08); transform: translateY(-1px); text-decoration: none; }
.btn:active { transform: none; }
.btn.ghost { background: var(--card); color: var(--purple); border-color: var(--purple-line); box-shadow: none; }
.btn.ghost:hover { background: var(--purple-bg); }
.btn.danger, .btn.ghost.danger { background: var(--red-bg); color: var(--red); border-color: var(--red-line); box-shadow: none; }
.btn.small { padding: 6px 11px; font-size: 12.5px; border-radius: 8px; }
.btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }

/* ── Case page bits ────────────────────────────────────────────────────── */
.hero { background: linear-gradient(120deg, var(--purple-bg), var(--card) 55%); border: 1px solid var(--purple-line); border-radius: 18px; padding: 20px 22px; margin-bottom: 18px; box-shadow: var(--shadow); }
.hero .row { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
.stepper { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; padding: 12px 14px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); }
.stepper .step { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--muted); font-weight: 600; }
.stepper .step .dot { width: 18px; height: 18px; border-radius: 50%; background: var(--line2); display: inline-flex; align-items: center; justify-content: center; font-size: 9px; color: var(--muted); }
.stepper .step.done { color: var(--green); } .stepper .step.done .dot { background: var(--green-bg); color: var(--green); }
.stepper .step.current { color: var(--purple); } .stepper .step.current .dot { background: var(--purple-bg); color: var(--purple); box-shadow: 0 0 0 3px var(--purple-line); }
.stepper .step-line { width: 22px; height: 2px; background: var(--line); margin: 0 6px; border-radius: 2px; }
.kv { display: grid; grid-template-columns: 168px 1fr; gap: 6px 14px; font-size: 13.5px; }
.kv dt { color: var(--muted); font-weight: 600; } .kv dd { margin: 0; }
.checklist { display: grid; gap: 6px; font-size: 14px; }
.checklist .ok { color: var(--green); font-weight: 800; }
.checklist .no { color: var(--red); font-weight: 800; }
.emailcard { border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; margin-bottom: 12px; background: var(--card2); }
.emailcard.out { background: var(--purple-bg); border-color: var(--purple-line); }
.emailcard pre { white-space: pre-wrap; font-size: 12.5px; color: var(--muted); margin: 8px 0 0; font-family: inherit; }
.note { background: var(--gold-bg); border: 1px solid color-mix(in srgb, var(--gold) 35%, transparent); border-radius: 12px; padding: 10px 14px; margin-bottom: 8px; font-size: 13.5px; }
.note .meta { color: var(--muted); font-size: 12px; margin-top: 3px; }
.timeline .ev { padding: 9px 0; border-bottom: 1px dashed var(--line); font-size: 13px; }
.timeline .ev:last-child { border-bottom: none; }
.timeline .t { color: var(--muted); font-size: 11.5px; }
.excerpt summary { cursor: pointer; color: var(--purple); font-weight: 600; }
.excerpt pre { background: var(--card2); border: 1px solid var(--line); border-radius: 10px; padding: 10px; font-size: 11.5px; overflow-x: auto; max-height: 260px; }
.changed { background: var(--blue-bg); border: 1px solid var(--blue-line); border-radius: 14px; padding: 12px 16px; margin-bottom: 18px; font-size: 13.5px; box-shadow: var(--shadow); }
.changed b { color: var(--blue); }
.taskrow { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px dashed var(--line); font-size: 13.5px; }
.taskrow.done span.t { text-decoration: line-through; color: var(--muted); }

/* ── Replay steps ──────────────────────────────────────────────────────── */
.steps { list-style: none; margin: 0; padding: 0; }
.steps li { position: relative; padding: 0 0 20px 30px; border-left: 2px solid var(--line); margin-left: 10px; }
.steps li::before { content: ""; position: absolute; left: -7px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--purple2); box-shadow: 0 0 0 4px var(--purple-bg); }
.steps li:last-child { border-left-color: transparent; }
.steps .k { font-weight: 750; font-size: 13.5px; }
.steps .d { font-size: 12.5px; color: var(--muted); white-space: pre-wrap; }
.steps li.flag::before { background: var(--orange); box-shadow: 0 0 0 4px var(--orange-bg); }
.steps li.verdict::before { background: var(--green); box-shadow: 0 0 0 4px var(--green-bg); }

/* ── Portal & auth ─────────────────────────────────────────────────────── */
.loginbox { max-width: 420px; margin: 10vh auto; }
.loginbox .crest { display: block; margin: 0 auto 14px; filter: drop-shadow(0 8px 20px rgba(109,40,217,.35)); }
.publicbar { display: flex; align-items: center; gap: 14px; padding: 16px 28px; border-bottom: 1px solid var(--line); background: var(--card); }
.publicbar .brand { border: none; padding: 0; }
.publicbar .brand b { color: var(--ink); } .publicbar .brand small { color: var(--muted); }
.publicbar nav { margin-left: auto; display: flex; gap: 16px; align-items: center; font-size: 13.5px; font-weight: 600; }
.otpbox { font-size: 30px; letter-spacing: 12px; font-weight: 800; text-align: center; background: var(--purple-bg); border: 1.5px dashed var(--purple-line); border-radius: 14px; padding: 16px; margin: 16px 0; color: var(--purple); font-variant-numeric: tabular-nums; }
.uploadzone { border: 2px dashed var(--purple-line); border-radius: 16px; padding: 26px; text-align: center; background: var(--card2); transition: .15s; }
.uploadzone:hover { border-color: var(--purple3); background: var(--purple-bg); }

/* ── Toast (flash messages) ────────────────────────────────────────────── */
.flash {
  position: fixed; top: 18px; right: 18px; z-index: 120; max-width: 380px;
  background: var(--card); color: var(--ink); border: 1px solid var(--green-line); border-left: 4px solid var(--green);
  border-radius: 12px; padding: 12px 16px; font-size: 13.5px; font-weight: 600; box-shadow: var(--shadow-lg);
  animation: toastIn .3s cubic-bezier(.2,.9,.3,1.2) both; cursor: pointer;
}
.flash.err { border-color: var(--red-line); border-left-color: var(--red); }
@keyframes toastIn { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: none; } }
.flash.bye { opacity: 0; transform: translateX(24px); transition: .3s; }

/* ── Command palette ───────────────────────────────────────────────────── */
.palette { position: fixed; inset: 0; z-index: 200; display: none; align-items: flex-start; justify-content: center; background: rgba(18,12,36,.5); backdrop-filter: blur(4px); padding-top: 12vh; }
.palette.open { display: flex; }
.palette-box { width: min(620px, 92vw); background: var(--card); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow-lg); overflow: hidden; animation: rise .18s ease both; }
.palette-box input { border: none; border-radius: 0; padding: 16px 18px; font-size: 15.5px; background: transparent; box-shadow: none; }
.palette-box input:focus { box-shadow: none; }
#palette-res { border-top: 1px solid var(--line); max-height: 330px; overflow-y: auto; }
.pal-item { display: flex; gap: 12px; align-items: center; padding: 11px 16px; cursor: pointer; border-bottom: 1px solid var(--line2); font-size: 13.5px; }
.pal-item:hover, .pal-item.sel { background: var(--purple-bg); }
.pal-item .hint { margin-left: auto; color: var(--muted); font-size: 11.5px; }
.palette-keys { display: flex; gap: 14px; padding: 9px 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11.5px; background: var(--card2); }

/* ── Splash ────────────────────────────────────────────────────────────── */
#splash { position: fixed; inset: 0; z-index: 500; display: flex; flex-direction: column; gap: 12px; align-items: center; justify-content: center; background: var(--bg); animation: splashOut .45s ease .75s forwards; }
#splash .crest { animation: pulse 1.1s ease infinite alternate; }
#splash .s-name { font-weight: 800; letter-spacing: .01em; font-size: 15px; }
#splash .s-sub { color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: .24em; }
#splash .s-bar { width: 120px; height: 3px; border-radius: 99px; background: var(--line); overflow: hidden; }
#splash .s-bar span { display: block; height: 100%; width: 40%; border-radius: 99px; background: linear-gradient(90deg, var(--purple2), var(--purple)); animation: slide 1s ease infinite; }
@keyframes pulse { from { transform: scale(1); } to { transform: scale(1.06); } }
@keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
@keyframes splashOut { to { opacity: 0; visibility: hidden; } }

/* ── Misc ──────────────────────────────────────────────────────────────── */
.mono { font-family: var(--mono); font-size: .95em; }
.muted { color: var(--muted); } .small { font-size: 12.5px; } .right { text-align: right; } .nowrap { white-space: nowrap; }
.overdue { color: var(--red); font-weight: 700; }
.center { text-align: center; }
.icn { display: inline-flex; } .icn svg { width: 100%; height: 100%; }
details > summary { list-style: none; } details > summary::-webkit-details-marker { display: none; }
::selection { background: color-mix(in srgb, var(--purple2) 30%, transparent); }
@media (max-width: 760px) { .wrap { padding: 16px; } .topbar { padding: 10px 16px; } .kv { grid-template-columns: 120px 1fr; } }
.mailmock { background: var(--gold-bg); color: var(--gold); border-bottom: 1px solid var(--gold); font-size: 12.5px; font-weight: 600; padding: 7px 34px; text-align: center; }

/* ── Brand chip + tab pills ────────────────────────────────────────────── */
.crest { display: inline-flex; align-items: center; background: #fff; border-radius: 10px; padding: 4px 7px; box-shadow: 0 1px 4px rgba(20,8,60,.25); flex: none; }
.publicbar .crest { box-shadow: 0 1px 4px rgba(20,8,60,.14); }
.tabs { display: flex; gap: 8px; flex-wrap: wrap; margin: 6px 0 22px; }
.tabs a {
  padding: 9px 18px; border-radius: 999px; border: 1px solid var(--line);
  background: var(--card); color: var(--muted); font-weight: 650; font-size: 13px;
  text-decoration: none; box-shadow: var(--shadow); transition: all .15s;
}
.tabs a:hover { color: var(--purple); border-color: var(--purple3); text-decoration: none; }
.tabs a.on { background: linear-gradient(120deg, var(--purple), var(--purple2)); color: #fff; border-color: transparent; box-shadow: 0 6px 16px -8px color-mix(in srgb, var(--purple) 70%, transparent); }
.tabs a .cnt { opacity: .75; font-weight: 700; margin-left: 6px; font-variant-numeric: tabular-nums; }
.b-magenta { background: var(--magenta-bg); color: var(--magenta); border: 1px solid var(--magenta-line); }
.resp-preview { background: var(--card2); border: 1px dashed var(--line); border-radius: 12px; padding: 14px 16px; font-size: 13px; white-space: pre-wrap; max-height: 260px; overflow: auto; margin: 12px 0; }
.heldnote { display: inline-flex; align-items: center; gap: 6px; background: var(--orange-bg); color: var(--orange); border: 1px solid var(--orange-line); border-radius: 8px; padding: 3px 10px; font-size: 12px; font-weight: 650; }
@media print {
  .sidebar, .topbar, .no-print, .flash, .palette, #splash { display: none !important; }
  .app { display: block; } body { background: #fff; }
  .card, .hero { box-shadow: none; border-color: #ccc; break-inside: avoid; }
}
`;

const PALETTE_JS = `
(function () {
  var pal = document.getElementById('palette');
  if (!pal) return;
  var q = document.getElementById('palette-q');
  var res = document.getElementById('palette-res');
  var sel = 0; var items = []; var timer = null;

  var LINKS = [
    { label: 'Command Center', hint: 'home', href: '/', keys: 'dashboard home overview' },
    { label: 'Human review queue', hint: 'queue', href: '/queue', keys: 'queue review human' },
    { label: 'Applicants', hint: 'search', href: '/applicants', keys: 'applicants cases search list' },
    { label: 'Settings & automation', hint: 'config', href: '/settings', keys: 'settings automation templates rules' },
    { label: 'Alerts & notifications', hint: 'alerts', href: '/notifications', keys: 'alerts notifications bell' }
  ];

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

export function layout(opts: {
  title: string;
  content: string;
  user?: StaffUser;
  unread?: number;
  active?: string;
  publicPage?: boolean;
  csrf?: string;
  theme?: Theme;
  /** Institution name from Settings — drives all branding text. */
  institution?: string;
  /** True when outgoing mail is simulated (no Gmail connected) — shown to staff. */
  mailMock?: boolean;
}): string {
  const theme: Theme = opts.theme === "dark" ? "dark" : "light";
  const otherTheme = theme === "dark" ? "light" : "dark";
  const inst = opts.institution ?? "Riara University";

  const themeBtn = `<form method="post" action="/theme" style="display:inline">
      <button class="iconbtn" title="Switch to ${otherTheme} mode">${icon(theme === "dark" ? "sun" : "moon")}</button>
    </form>`;

  let shell: string;
  if (opts.user) {
    const nav = [
      { href: "/", label: "Command Center", icon: "grid", active: "dashboard" },
      { href: "/queue", label: "Review Queue", icon: "inbox", active: "queue" },
      { href: "/applicants", label: "Applicants", icon: "users", active: "applicants" },
      ...(opts.user.role === "admin" || opts.user.role === "manager" ? [{ href: "/team", label: "Team", icon: "chart", active: "team" }] : []),
      ...(opts.user.role !== "officer" ? [{ href: "/settings", label: "Settings", icon: "gear", active: "settings" }] : []),
      ...(opts.user.role === "admin" ? [{ href: "/staff", label: "Staff", icon: "shield", active: "staff" }] : []),
    ];
    shell = `
<div class="app">
  <aside class="sidebar">
    <div class="brand">${crest(44)}<div><b class="sr-only">${esc(inst)}</b><small>Automated admissions</small></div></div>
    <nav class="side">
      ${nav
        .map((n) => `<a href="${n.href}" class="${opts.active === n.active ? "active" : ""}">${icon(n.icon as never)}${n.label}</a>`)
        .join("")}
      <a href="/notifications" class="${opts.active === "notifications" ? "active" : ""}">${icon("bell")}Alerts${opts.unread ? `<span class="pill">${opts.unread}</span>` : ""}</a>
    </nav>
    <div class="side-foot">
      <div class="userchip">
        ${avatar(opts.user.display_name, 34)}
        <div><b>${esc(opts.user.display_name)}</b><small>${esc(opts.user.role)}</small></div>
        <form method="post" action="/logout"><button class="iconbtn" title="Sign out" style="background:transparent;border-color:rgba(255,255,255,.14);color:#9E93C6">⎋</button></form>
      </div>
    </div>
  </aside>
  <div class="main">
    ${opts.user && opts.mailMock ? `<div class="mailmock">🧪 Demo mode — outgoing mail is simulated, not delivered. Connect Gmail in Settings to fetch and send real mail.</div>` : ""}
    <header class="topbar">
      <button class="searchbtn" id="searchbtn">${icon("search")}<span>Search applicants, refs, pages…</span><span class="kbd">Ctrl K</span></button>
      <div class="top-right">
        ${themeBtn}
        <a class="iconbtn" href="/notifications" title="Alerts">${icon("bell")}${opts.unread ? `<span class="pip"></span>` : ""}</a>
      </div>
    </header>
    <main class="wrap">
${opts.content}
    </main>
  </div>
</div>
<div class="palette" id="palette">
  <div class="palette-box">
    <input id="palette-q" type="text" placeholder="Jump to a case, applicant or page…" autocomplete="off" spellcheck="false">
    <div id="palette-res"></div>
    <div class="palette-keys"><span><span class="kbd">↑↓</span> navigate</span><span><span class="kbd">↵</span> open</span><span><span class="kbd">esc</span> close</span><span style="margin-left:auto">${inst === "Riara University" ? `${inst} · Nurturing Innovations` : `${inst} · Automated admissions`}</span></div>
  </div>
</div>`;
  } else {
    shell = `
<div class="publicbar">
  <div class="brand">${crest(40)}<div><b class="sr-only">${esc(inst)}</b><small>Automated admissions</small></div></div>
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
${opts.user ? `<meta name="csrf" content="${esc(opts.csrf ?? "")}">` : ""}
<title>${esc(opts.title)}</title>
<style>${CSS}</style>
</head>
<body>
<div id="splash" aria-hidden="true">${crest(64)}<div class="s-sub">Nurturing Innovations · Automated admissions</div><div class="s-bar"><span></span></div></div>
${shell}
<script>${PALETTE_JS}${TOAST_JS}</script>
</body>
</html>`;
}
