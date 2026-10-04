/**
 * Light mode — nothing may stay dark-on-dark or vanish light-on-paper.
 *
 * History: the register-flow band (`.flow-link`, `.band-label`) was drawn
 * against the dark masthead palette — bone-white text (#eadfe2) and pale-pink
 * links sat directly on the light page background (invisible), with near-black
 * rules (#40101a / #29151b) cutting across paper. The beveled-slab card
 * shadows also baked in hard `rgba(0,0,0,.52)` inner lines that stayed dark in
 * light mode. Everything now routes through theme variables with explicit
 * `[data-theme="light"]` overrides; this suite pins that structure.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(__dirname, "..", "src", "web", "views.ts"), "utf8");
const css = source.match(/const CSS = `([\s\S]*?)`;/)?.[1] ?? "";

describe("light mode theme coverage", () => {
  it("slab shadows are variable-driven — no hard near-black inner lines remain", () => {
    expect(css).not.toMatch(/inset 0 -2px 0 rgba\(0,0,0/);
    expect((css.match(/var\(--slab-inner\)/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it("the light theme redefines the slab shadows with paper values", () => {
    const light = css.match(/\[data-theme="light"\]\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(light).toContain("--slab-inner: rgba(74,53,98,");
    expect(light).toContain("--slab-lip: rgba(255,255,255,");
    expect(light).not.toContain("rgba(0,0,0,.52)");
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

  it("dark mode keeps the purple-noir values", () => {
    const root = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(root).toContain("--slab-inner: rgba(0,0,0,.52)");
    expect(root).toContain("--slab-cast: rgba(0,0,0,.58)");
    // the dark masthead and rail are unchanged, self-consistent surfaces
    expect(css).toMatch(/\.overview-mast \{[^}]*background:#100c18/);
    // the rail keeps its noir surface via the shell variable so the light theme can swap it
    expect(root).toContain("--shell-bg: #070507");
    expect(css).toMatch(/\.sitehead\.sidebar \{[^}]*background:var\(--shell-bg\)/);
  });
});
