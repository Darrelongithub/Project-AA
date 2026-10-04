/**
 * Express 4 does not forward a rejected promise from an async handler to the
 * error middleware — the client hangs instead of getting a response. Every
 * async route the console registers is wrapped so a throw always becomes a
 * logged 500. This pins the safety net itself.
 */
import { describe, expect, it } from "vitest";
import express, { type Express } from "express";
import { guardAsyncRoutes } from "../src/web/server";

function boot(register: (app: Express) => void): { app: Express } {
  const app = express();
  register(app);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: unknown) => {
    res.status(500).json({ ok: false, error: (err as Error).message });
  });
  guardAsyncRoutes(app);
  return { app };
}

describe("async route guard", () => {
  it("a throwing async route answers 500 instead of hanging", async () => {
    const { app } = boot((a) => {
      a.get("/boom", async () => { throw new Error("kaboom"); });
    });
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const res = await fetch(`${base}/boom`, { signal: AbortSignal.timeout(5000) });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ ok: false, error: "kaboom" });
    } finally {
      server.close();
    }
  });

  it("a throwing async middleware is caught too, and error handlers stay intact", async () => {
    const { app } = boot((a) => {
      a.use(async () => { throw new Error("middleware-boom"); });
      a.get("/never", (_req, res) => res.send("unreachable"));
      // A four-argument error handler must NOT be wrapped away.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      a.use((err: unknown, _req: express.Request, res: express.Response, _next: unknown) => {
        res.status(503).send(`handled: ${(err as Error).message}`);
      });
    });
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const res = await fetch(`${base}/never`, { signal: AbortSignal.timeout(5000) });
      expect(res.status).toBe(503);
      expect(await res.text()).toBe("handled: middleware-boom");
    } finally {
      server.close();
    }
  });
});
