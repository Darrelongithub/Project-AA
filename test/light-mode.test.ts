/**
 * Light mode — nothing may stay dark-on-dark or vanish light-on-paper.
 *
 * v5: light is the default. Cards use clean soft shadows (no heavy bevel).
 * Dark mode remains fully supported via [data-theme="dark"].
 * This suite pins the structure so light text never becomes invisible
 * and theme variables stay the single source of truth.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(__dirname, "..", "src", "web", "views.ts"), "utf8");
const css = source.match(/const CSS = `([\s\S]*?)`;/)?.[1] ?? "";

describe("light mode theme coverage", () => {
  it("no hard near-black inset shadows remain in the design system", () => {
    expect(css).not.toMatch(/inset 0 -2px 0 rgba\(0,0,0/);
  });

  it("light theme (or :root default) defines paper-friendly slab tokens", () => {
    // Either :root or the explicit light block must define soft paper values
    const hasPaperSlab =
      css.includes("--slab-inner: rgba(59,29,95") ||
      css.includes("--slab-inner: rgba(74,53,98");
    expect(hasPaperSlab).toBe(true);
    expect(css).toContain("--slab-lip: rgba(255,255,255");
  });

  it("register-flow labels and rules get light-theme overrides (readable on paper)", () => {
    for (const rule of [
      '[data-theme="light"] .flow-heading { border-bottom-color: var(--line); }',
      '[data-theme="light"] .flow-link { border-color: var(--plum-line); color: var(--plum-mid); }',
      '[data-theme="light"] .band-label b { color: var(--ink); }',
      '[data-theme="light"] .gauge-band { border-bottom-color: var(--line); }',
    ]) {
      expect(css).toContain(rule);
    }
  });

  it("dark mode keeps purple-noir values and the dark mast base", () => {
    expect(css).toMatch(/\[data-theme="dark"\]\s*\{[^}]*--bg: #0a0810/);
    expect(css).toMatch(/\.overview-mast \{[^}]*background:#100c18/);
    // shell variable still exists for the sidebar
    expect(css).toMatch(/--shell-bg:/);
  });

  it("light mode has explicit overrides for the home mast", () => {
    expect(css).toContain('[data-theme="light"] .overview-mast');
    expect(css).toContain('[data-theme="light"] .overview-mast h1');
  });

  it("display font is Manrope (no Instrument Serif)", () => {
    expect(css).not.toMatch(/font-family:\s*"Instrument Serif"/);
    expect(css).toMatch(/--font-display:\s*"Manrope"/);
  });
});
