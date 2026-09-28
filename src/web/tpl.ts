/**
 * Minimal template layer: one escape helper, one auto-escaping `html` tag,
 * and the page partials with the highest duplication (badges, stat cells,
 * empty states, CSRF fields). Escape output matches the former views.esc
 * byte-for-byte — see the Phase 5 differential (commit message).
 */

/** Escape text for HTML element and double-quoted attribute positions. */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Pre-rendered HTML that `html` and the partials must not escape. */
export interface RawHtml {
  readonly html: string;
}

/** Mark a string as pre-rendered HTML (already escaped where needed). */
export function raw(html: string): RawHtml {
  return { html };
}

type Part = string | number | boolean | bigint | null | undefined | RawHtml | readonly Part[];

function renderPart(p: Part): string {
  if (p === null || p === undefined) return "";
  if (typeof p === "object") return "html" in p ? p.html : p.map(renderPart).join("");
  if (typeof p === "string") return esc(p);
  return String(p);
}

/**
 * Auto-escaping template tag. Interpolated strings are escaped; numbers and
 * booleans render as-is; null/undefined render as ""; RawHtml passes
 * through; arrays are rendered item by item and joined.
 */
export function html(chunks: TemplateStringsArray, ...parts: Part[]): string {
  let out = chunks[0];
  for (let i = 0; i < parts.length; i++) out += renderPart(parts[i]) + chunks[i + 1];
  return out;
}

export type BadgeTone = "gray" | "green" | "blue" | "orange" | "purple" | "red";

/** Status pill. Label parts are escaped (numbers render as-is). */
export function badge(tone: BadgeTone, ...label: Array<string | number | RawHtml>): string {
  return html`<span class="badge b-${tone}">${label}</span>`;
}

/** Dashboard stat cell: escaped label, escaped-or-raw value. */
export function statCell(label: string | number, value: string | number | RawHtml): string {
  return html`<div><span>${label}</span><b>${value}</b></div>`;
}

/**
 * Empty-state shell. `inner` is pre-rendered HTML (static markup plus
 * already-escaped interpolations) and passes through untouched.
 */
export function emptyState(inner: string): string {
  return `<div class="empty">${inner}</div>`;
}

/** Hidden CSRF field shared by every POST form. */
export function csrfField(token: string): string {
  return html`<input type="hidden" name="_csrf" value="${token}">`;
}
