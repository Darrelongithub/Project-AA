/**
 * assets routes. Extracted verbatim from server.ts createApp;
 * shared closure state arrives via RouteCtx — behavior unchanged.
 */
import { FAVICON_BASE64, LOGO_BASE64, LOGO_WHITE_BASE64 } from "../logo";
import { FONT_INSTRUMENT_SERIF_ITALIC_WOFF2, FONT_INSTRUMENT_SERIF_WOFF2, FONT_MANROPE_WOFF2 } from "../fonts";
import express , { type Express } from "express";
import { csrfCheck, requireLogin, requireRole } from "../auth";
import { emailBanner } from "../../branding";
import type { RouteCtx } from "./ctx";

export function registerAssets(app: Express, rt: RouteCtx): void {
  // ── Auth ─────────────────────────────────────────────────────────────────

  // Organization-neutral SVG identity assets, served once and cached.
  // Page shells render the token-aware monogram inline; these URLs remain for
  // integrations and legacy asset slots without a baked PNG dependency.
  app.get("/assets/logo", (_req, res) => {
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(LOGO_BASE64, "base64"));
  });
  app.get("/assets/logo-white", (_req, res) => {
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(LOGO_WHITE_BASE64, "base64"));
  });

  // Browser-tab mark: the a² SVG; organization logos remain stored on their organization row.
  app.get("/assets/favicon", (_req, res) => {
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=604800");
    res.send(Buffer.from(FAVICON_BASE64, "base64"));
  });

  // Self-hosted typefaces (no CDN): Manrope variable font for the full interface.
  const fontRoutes: Array<[string, string]> = [
    ["/assets/fonts/manrope.woff2", FONT_MANROPE_WOFF2],
    ["/assets/fonts/instrument-serif.woff2", FONT_INSTRUMENT_SERIF_WOFF2],
    ["/assets/fonts/instrument-serif-italic.woff2", FONT_INSTRUMENT_SERIF_ITALIC_WOFF2],
  ];
  for (const [path, b64] of fontRoutes) {
    app.get(path, (_req, res) => {
      res.setHeader("Content-Type", "font/woff2");
      res.setHeader("Cache-Control", "public, max-age=604800");
      res.send(Buffer.from(b64, "base64"));
    });
  }

  /** Current email banner (used by the Configuration preview). */
  app.get("/assets/email-banner", requireLogin, (req, res) => {
    const b = emailBanner(rt.repo, rt.organizationId(req));
    if (!b) return res.status(404).send("No banner configured.");
    res.setHeader("Content-Type", b.mime);
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(b.base64, "base64"));
  });

  /** Replace the email banner — raw image bytes in the request body. */
  app.post(
    "/config/branding/banner",
    requireLogin,
    requireRole("admin"),
    csrfCheck,
    express.raw({ type: ["image/jpeg", "image/png"], limit: "8mb" }), // phone photos run 3–8 MB
    (req, res) => {
      const back = (m: string) => `/config?tab=replies&msg=${encodeURIComponent(m)}#branding`;
      const buf = req.body as Buffer;
      if (!Buffer.isBuffer(buf) || buf.length < 1024) return res.redirect(back("Banner image missing or too small."));
      if (buf.length > 900 * 1024) return res.redirect(back("Banner too large — keep it under 900 KB."));
      // Trust the BYTES, not the Content-Type header: JPEG/PNG magic only.
      const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.subarray(4, 8).toString("hex") === "0d0a1a0a";
      if (!isJpeg && !isPng) return res.redirect(back("That file is not a JPEG or PNG image — banner unchanged."));
      const mime = isPng ? "image/png" : "image/jpeg";
      rt.repo.setSetting("email_banner", buf.toString("base64"));
      rt.repo.setSetting("email_banner_mime", mime);
      rt.repo.audit(null, req.staff!.username, "email_banner_changed", `${(buf.length / 1024).toFixed(0)} KB ${mime}`);
      res.redirect(back("Email banner updated — every outgoing email now carries it."));
    }
  );

  /** Organization-owned logo upload; the bytes are stored in the tenant row,
   * never read from a bundled institution asset. */
  app.post(
    "/config/organization/logo",
    requireLogin,
    requireRole("admin"),
    csrfCheck,
    express.raw({ type: ["image/jpeg", "image/png", "image/svg+xml"], limit: "2mb" }),
    (req, res) => {
      const buf = req.body as Buffer;
      if (!Buffer.isBuffer(buf) || buf.length < 16) return res.status(400).send("Logo missing");
      const png = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.subarray(4, 8).toString("hex") === "0d0a1a0a";
      const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      const svg = String(buf.subarray(0, 256)).trimStart().startsWith("<svg");
      if (!png && !jpg && !svg) return res.status(415).send("Logo must be PNG, JPEG or SVG");
      rt.repo.updateOrganization(rt.organizationId(req), { logo: `data:${png ? "image/png" : jpg ? "image/jpeg" : "image/svg+xml"};base64,${buf.toString("base64")}` });
      rt.repo.audit(null, req.staff!.username, "organization_logo_changed", `${buf.length} bytes`);
      res.status(204).end();
    }
  );
}
