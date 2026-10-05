/**
 * Phase 18 hostile pass — attacks on the public ingest surface.
 *
 * This endpoint is the only place in the product where an unauthenticated
 * stranger can push data into a tenant's case file, so it gets its own
 * adversarial coverage rather than being assumed safe because the friendly
 * tests pass. Everything here is a payload a script kid would actually try:
 * prototype pollution, parser overflow, type confusion, transport tricks,
 * path tricks, log forging, invisible-character dedup evasion, and a key
 * guessing flood. The invariant in every case is the same two halves: a
 * *bounded, honest answer* and *no unexpected state written*.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "http";
import { request as httpRequest } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { configureTestOrganization, webLogin } from "./helpers";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { createApp } from "../src/web/server";
import { WEBHOOK_PATH_PREFIX, safeIpLabel, validateWebhookPayload } from "../src/web/webhook";
import { hashPassword } from "../src/util/password";

let server: Server;
let host = "127.0.0.1";
let port = 0;
let repo: Repo;
let key = "";

beforeAll(async () => {
  // The log-forgery case below needs req.ip to come from a header, because that
  // is the only way a caller can influence a log line at all — with this off,
  // req.ip is the socket address and the test would prove nothing.
  process.env.TRUST_PROXY = "1";
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
  repo.setSetting("webhook_rate_limit_per_minute", "5000");
  key = repo.webhookIngestKey(1)!;
  const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender(true) } };
  const app = createApp({ repo, ctx });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  delete process.env.TRUST_PROXY;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Raw, deliberately odd HTTP: hand-rolled requests, not fetch's conventions. */
function raw(opts: {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  chunked?: boolean;
}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host, port, method: opts.method ?? "POST", path: opts.path ?? `${WEBHOOK_PATH_PREFIX}${key}`, headers: opts.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const flat: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) flat[k] = Array.isArray(v) ? v.join(",") : String(v);
          resolve({ status: res.statusCode ?? 0, headers: flat, body: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    req.on("error", reject);
    // No content-length is set by hand: when the caller asks for chunked
    // transfer, Node frames it, which is the point of the test.
    req.end(opts.body);
  });
}

const postJson = (payload: unknown, headers: Record<string, string> = {}) =>
  raw({ headers: { "content-type": "application/json", ...headers }, body: typeof payload === "string" ? payload : JSON.stringify(payload) });

const jsonOf = (body: string): Record<string, unknown> => {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return { __unparsable: body.slice(0, 200) }; }
};

const tableCounts = () => ({
  applicants: (repo.db.prepare("SELECT COUNT(*) AS n FROM applicants").get() as { n: number }).n,
  caseTypes: (repo.db.prepare("SELECT COUNT(*) AS n FROM case_types").get() as { n: number }).n,
  emails: (repo.db.prepare("SELECT COUNT(*) AS n FROM emails").get() as { n: number }).n,
  claims: (repo.db.prepare("SELECT COUNT(*) AS n FROM webhook_claims").get() as { n: number }).n,
  settings: (repo.db.prepare("SELECT COUNT(*) AS n FROM settings").get() as { n: number }).n,
  staff: (repo.db.prepare("SELECT COUNT(*) AS n FROM staff_users").get() as { n: number }).n,
});

describe("hostile pass: object-shaped payloads", () => {
  it("prototype-polluting keys pollute nothing and are not stored", async () => {
    const marker = "polluted_by_ingest";
    const before = tableCounts();
    const res = await postJson({
      email: "pp@example.org",
      message: "A service request.",
      case_type: "SERVICE_REQUEST",
      __proto__: { [marker]: marker, "outcome": "auto_approved" },
      constructor: { prototype: { [marker]: marker } },
      metadata: { "__proto__": { [marker]: marker }, "ok": "yes" },
    });
    expect([200, 202, 400]).toContain(res.status);
    expect((Object.prototype as unknown as Record<string, unknown>)[marker]).toBeUndefined();
    expect((({}) as Record<string, unknown>)[marker]).toBeUndefined();
    expect((repo as unknown as Record<string, unknown>)[marker]).toBeUndefined();
    // No forged field reached storage either: no outcome write, no new case type.
    expect(tableCounts().caseTypes).toBe(before.caseTypes);
    expect(repo.db.prepare("SELECT COUNT(*) AS n FROM applicants WHERE outcome = 'auto_approved'").get()).toEqual({ n: 0 });
    const meta = repo.db.prepare("SELECT metadata FROM webhook_deliveries ORDER BY id DESC LIMIT 1").get() as { metadata: string | null };
    expect(meta.metadata ?? "{}").not.toContain(marker);
    expect(JSON.parse(meta.metadata ?? "{}")).toEqual({ ok: "yes" });
  });

  it("survives a parse bomb of 20 000 nesting levels with a bounded answer", async () => {
    const deep = `${"[".repeat(20_000)}${"]".repeat(20_000)}`;
    const res = await raw({
      headers: { "content-type": "application/json" },
      body: `{"email":"x@example.org","message":${deep}}`,
    });
    // Either the parser refuses it or validation does — never a 500, and never a
    // stack trace fragment in the body.
    expect([400, 413, 415]).toContain(res.status);
    expect(res.body).not.toMatch(/RangeError|Maximum call stack|at .*\.js:\d+/);
    const parsed = jsonOf(res.body);
    expect(typeof parsed.error).toBe("string");
  });

  it("answers every type confusion with a field-naming refusal, not a crash", async () => {
    const before = tableCounts();
    const confusions: Array<[string, unknown]> = [
      ["email as array", { email: [], message: "x" }],
      ["email as object", { email: { value: "a@b.org" }, message: "x" }],
      ["email as number", { email: 42, message: "x" }],
      ["email as boolean", { email: true, message: "x" }],
      ["message as array", { email: "tc@example.org", message: ["a", "b"] }],
      ["case_type as array", { email: "tc@example.org", case_type: ["SERVICE_REQUEST"] }],
      ["external_id as object", { email: "tc@example.org", external_id: { id: 1 } }],
      ["metadata as number", { email: "tc@example.org", metadata: 7 }],
      ["top level as array", [1, 2, 3]],
      ["top level as number", 17],
      ["nested null everywhere", { email: null, message: null, metadata: null, case_type: null }],
    ];
    for (const [name, payload] of confusions) {
      const res = await postJson(payload);
      expect(res.status, name).toBe(400);
      const parsed = jsonOf(res.body);
      expect(typeof parsed.error, name).toBe("string");
      expect(parsed.__unparsable, name).toBeUndefined();
    }
    expect(tableCounts().applicants).toBe(before.applicants);
  });

  it("accepts harmless scalars by their string form and stores only strings", async () => {
    const res = await postJson({
      email: "scalars@example.org",
      message: "A service request.",
      case_type: "SERVICE_REQUEST",
      full_name: 12.5,
      metadata: { count: 3, flag: true, nothing: null, missing: undefined },
    });
    expect(res.status).toBe(200);
    const stored = repo.db.prepare("SELECT metadata FROM webhook_deliveries WHERE sender_email = 'scalars@example.org'").get() as { metadata: string | null };
    const parsed = JSON.parse(stored.metadata ?? "{}") as Record<string, unknown>;
    expect(parsed.count).toBe("3");
    expect(parsed.flag).toBe("true");
    expect(parsed.nothing).toBe("");
    expect(Object.values(parsed).every((v) => typeof v === "string")).toBe(true);
  });
});

describe("hostile pass: transport and path", () => {
  it("a body with no content-type is refused, not parsed into a case", async () => {
    const res = await raw({ headers: {}, body: JSON.stringify({ email: "noct@example.org", case_type: "SERVICE_REQUEST", message: "sneak in" }) });
    expect(res.status).toBe(400);
    expect(jsonOf(res.body).error).toMatch(/email is required|not readable/);
  });

  it("an unsupported encoding is refused without decompressing anything", async () => {
    const res = await raw({
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00]),
    });
    expect(res.status).toBe(400);
    expect(res.body).not.toMatch(/zlib|invalid stored block|unexpected token/i);
  });

  it("a chunked body is accepted under the same cap, and a huge one is refused", async () => {
    const small = JSON.stringify({ email: "chunked@example.org", message: "A service request.", case_type: "SERVICE_REQUEST" });
    const ok = await raw({ chunked: true, headers: { "content-type": "application/json", "transfer-encoding": "chunked" }, body: small });
    expect(ok.status).toBe(200);
    expect(String(jsonOf(ok.body).ref_number)).toMatch(/^ORG-/);
    // No Content-Length to check up front: the parser must still stop a runaway
    // body mid-stream rather than buffering it.
    const huge = await raw({
      chunked: true,
      headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      body: `{"email":"big@example.org","message":"${"Z".repeat(200_000)}"}`,
    });
    expect(huge.status).toBe(413);
  });

  it("path tricks never reach another route and never leak the key format", async () => {
    const paths = [
      `${WEBHOOK_PATH_PREFIX}..%2F..%2Fadmin`,
      `${WEBHOOK_PATH_PREFIX}../../admin`,
      `${WEBHOOK_PATH_PREFIX}${key}/`,
      `${WEBHOOK_PATH_PREFIX}${key}/rotate`,
      `${WEBHOOK_PATH_PREFIX.replace(/\/$/, "")}`,
      `${WEBHOOK_PATH_PREFIX}${key}%20`,
    ];
    for (const path of paths) {
      const res = await raw({ path, headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "path@example.org", message: "x", case_type: "SERVICE_REQUEST" }) });
      // Express routing ignores a trailing slash, so that one path is the SAME
      // endpoint and answers normally. Everything else is a miss. What must
      // never happen is a match with a different meaning — no rotate, no admin
      // page, no 500, no HTML, and no route reached by an encoded separator.
      const trailingSlashOnly = path === `${WEBHOOK_PATH_PREFIX}${key}/`;
      expect(res.status, path).toBe(trailingSlashOnly ? 200 : 404);
      expect(res.body, path).not.toMatch(/<html|rotate|key is live/i);
    }
    // Routing is case-insensitive in Express, so an uppercase path is the SAME
    // endpoint — and it must still be under this endpoint's own byte cap rather
    // than the console form parsers' looser one.
    const upper = await raw({
      path: `/API/V1/INGEST/${key}`,
      headers: { "content-type": "application/json" },
      body: `{"email":"upper@example.org","message":"${"Q".repeat(200_000)}"}`,
    });
    expect(upper.status).toBe(413);
    // The exact path still works, so this is a routing refusal, not a broken app.
    const good = await postJson({ email: "path-ok@example.org", message: "A service request.", case_type: "SERVICE_REQUEST" });
    expect(good.status).toBe(200);
  });

  it("the key in the path is answered identically for a GET, and never echoed", async () => {
    const get = await raw({ path: `${WEBHOOK_PATH_PREFIX}${key}`, method: "GET", headers: {} });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST");
    expect(get.body).not.toContain(key);
    expect(get.headers["cache-control"]).toMatch(/no-store/);
  });

  it("mints no session state for an anonymous caller", async () => {
    const res = await postJson({ email: "cookie@example.org", message: "x" });
    expect([200, 202, 400]).toContain(res.status);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["cache-control"]).toMatch(/no-store/);
  });
});

describe("hostile pass: what the endpoint repeats back", () => {
  it("escapes caller text in the operator's pages and bounds it in storage", async () => {
    // Short enough to survive the field cap, because the refusal ECHOES the
    // offending value — that echo is the part an operator later reads in a
    // table, and it is written by a stranger.
    const nastiest = `<img src=x onerror=alert(1)>"'<&>`;
    const res = await postJson({ email: "xss@example.org", message: "hi", case_type: nastiest });
    expect(res.status).toBe(400);
    // The response is JSON, so the browser needs no escaping to be safe…
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toContain("is not configured for this organization");
    // …but the operator's console does, because that text is stored and listed.
    const { cookie } = await webLogin(`http://${host}:${port}`, "admin", "admin123");
    const page = await (await fetch(`http://${host}:${port}/settings`, { headers: { cookie } })).text();
    expect(page).not.toContain("<img src=x onerror=alert(1)>");
    expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
    const row = repo.db.prepare("SELECT detail, length(detail) AS len FROM webhook_deliveries ORDER BY id DESC LIMIT 1").get() as { detail: string; len: number };
    expect(row.len).toBeLessThanOrEqual(500);
    expect(row.detail).toContain("is not configured for this organization");
    // The over-long value never reaches storage at all — it is refused on length
    // first, so 400 characters of script cannot be filed anywhere.
    const long = await postJson({ email: "xss@example.org", message: "hi", case_type: "y".repeat(400) });
    expect(jsonOf(long.body).error).toMatch(/longer than 40 characters/);
  });

  it("cannot forge a line into the process log, whatever the payload contains", async () => {
    const forged = "[2099-01-01T00:00:00.000Z] ERROR FORGED-BY-ATTACKER approved a case";
    const writes: string[] = [];
    const record = (chunk: unknown) => { writes.push(String(chunk)); return true; };
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { void record(args.join(" ")); });
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { void record(args.join(" ")); });
    try {
      // Caller text: inside a field the endpoint echoes. Caller address: inside
      // the one header that becomes req.ip under TRUST_PROXY.
      await postJson({ email: "log@example.org", message: `x\n${forged}` });
      await raw({
        path: `${WEBHOOK_PATH_PREFIX}nope-nope-nope-nope-nope-12345`,
        headers: { "content-type": "application/json", "x-forwarded-for": `1.2.3.4] ${forged}` },
        body: JSON.stringify({ email: "log@example.org" }),
      });
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
    const captured = writes.join("\n");
    const webhookLines = captured.split("\n").filter((l) => l.includes(" webhook: "));
    expect(webhookLines.length).toBeGreaterThan(0);
    // Every line this surface writes is single-line, printable, free of the
    // attacker's text and free of the key.
    for (const line of webhookLines) {
      expect(line).not.toContain("FORGED-BY-ATTACKER");
      expect(line).not.toContain(key);
      expect(line).not.toMatch(/^\s/);
      expect(line).not.toContain("\r");
    }
    expect(webhookLines.some((l) => /refused an unrecognized ingest key/.test(l))).toBe(true);
    // The header-supplied address appears in that line only in its sanitized
    // form: printable, and never as the second half of a forged log entry.
    const ipLine = webhookLines.find((l) => l.includes("refused an unrecognized ingest key")) ?? "";
    expect(ipLine).toContain("an unrecognized address");
    expect(ipLine.length).toBeLessThan(240);
  });
});

describe("hostile pass: idempotency and budget abuse", () => {
  it("invisible characters do not evade the external_id claim", async () => {
    const plain = await postJson({ email: "zw@example.org", message: "A service request.", case_type: "SERVICE_REQUEST", external_id: "ZW-1" });
    expect(plain.status).toBe(200);
    expect(jsonOf(plain.body).deduplicated).toBe(false);
    for (const variant of ["ZW\u200b-1", "\u2063ZW-1", "ZW-\u200d1", "ZW\u00ad-1", " ZW-1 ", "ZW-\uFEFF1"]) {
      const res = await postJson({ email: "zw@example.org", message: "A service request.", case_type: "SERVICE_REQUEST", external_id: variant });
      expect(jsonOf(res.body).deduplicated, JSON.stringify(variant)).toBe(true);
      expect(jsonOf(res.body).ref_number).toBe(jsonOf(plain.body).ref_number);
    }
    expect(tableCounts().claims).toBe(1);
  });

  it("unicode composition does not double a claim either", async () => {
    const composed = await postJson({ email: "nfc@example.org", message: "A service request.", case_type: "SERVICE_REQUEST", external_id: "caf\u00e9-1" });
    expect(composed.status).toBe(200);
    // Same letters, same look, different bytes: e + combining acute.
    const decomposed = await postJson({ email: "nfc@example.org", message: "A service request.", case_type: "SERVICE_REQUEST", external_id: "cafe\u0301-1" });
    expect(jsonOf(decomposed.body).deduplicated).toBe(true);
  });

  it("a blank external_id claims nothing, so it cannot lock an id out", async () => {
    const claimsBefore = tableCounts().claims;
    const first = await postJson({ email: "blank-id@example.org", message: "A service request.", case_type: "SERVICE_REQUEST", external_id: "   " });
    const second = await postJson({ email: "blank-id@example.org", message: "A service request.", case_type: "SERVICE_REQUEST" });
    expect(first.status).toBe(200);
    expect(jsonOf(first.body).deduplicated).toBe(false);
    expect(jsonOf(second.body).deduplicated).toBe(false);
    expect(tableCounts().claims).toBe(claimsBefore);
  });

  it("a key-guessing flood is answered and writes nothing", async () => {
    const before = tableCounts();
    const deliveriesBefore = (repo.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").get() as { n: number }).n;
    const guesses = Array.from({ length: 60 }, (_, i) => raw({
      path: `${WEBHOOK_PATH_PREFIX}guess${i}${"0".repeat(24)}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "flood@example.org", message: "x" }),
    }));
    const results = await Promise.allSettled(guesses);
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : 0));
    expect(statuses.every((s) => s === 404 || s === 429)).toBe(true);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    // …and the tenant's real work is untouched by it: no rows, and the good key
    // still functions afterwards.
    expect(tableCounts()).toEqual(before);
    expect((repo.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").get() as { n: number }).n).toBe(deliveriesBefore);
    expect((await postJson({ email: "after-flood@example.org", message: "A service request.", case_type: "SERVICE_REQUEST" })).status).toBe(200);
  });

  it("safeIpLabel names an address and refuses to quote anything else", () => {
    expect(safeIpLabel("203.0.113.9")).toBe("203.0.113.9");
    expect(safeIpLabel("2001:db8::1")).toBe("2001:db8::1");
    expect(safeIpLabel("[::1]")).toBe("[::1]");
    expect(safeIpLabel("::1%9")).toBe("::1%9");
    // Text, escapes and a forged log tail never reach the line at all.
    expect(safeIpLabel("1.2.3.4] FORGE\u001b[31m\u0000\nsecond line")).toBe("an unrecognized address");
    expect(safeIpLabel("a\u2028b")).toBe("an unrecognized address");
    expect(safeIpLabel("<script>")).toBe("an unrecognized address");
    expect(safeIpLabel("\n\r\u0000")).toBe("an unrecognized address");
    // An address-shaped flood is still bounded to one short line.
    expect(safeIpLabel(`1.2.3.4${"5".repeat(500)}`)).toHaveLength(64);
  });
});

describe("hostile pass: the validator alone", () => {
  it("refuses a payload that is 40 top-level keys of junk without hanging", () => {
    const body: Record<string, unknown> = { email: "junk@example.org" };
    for (let i = 0; i < 45; i++) body[`field_${i}`] = { nested: [1, 2, { deep: true }] };
    const res = validateWebhookPayload(body, repo, 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });

  it("treats a lone tab or newline in email as invalid, not as a valid address", () => {
    for (const email of ["\t", "\n", "a\n@b.org", "a@b\t.org", ""]) {
      const res = validateWebhookPayload({ email, message: "x" }, repo, 1);
      expect(res.ok, JSON.stringify(email)).toBe(false);
    }
  });
});
