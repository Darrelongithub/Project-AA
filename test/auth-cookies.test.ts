import { describe, expect, it } from "vitest";
import { clearSessionCookie, sessionCookie } from "../src/web/auth";

describe("preview authentication cookies", () => {
  it("marks secure sessions SameSite=None and optionally partitioned", () => {
    expect(sessionCookie("sid-token", 3600, true)).toContain("SameSite=None; Secure;");
    expect(sessionCookie("sid-token", 3600, true, true)).toContain("SameSite=None; Secure; Partitioned;");
    expect(clearSessionCookie(true, true)).toContain("SameSite=None; Secure; Partitioned;");
  });

  it("retains SameSite=Lax for plain local HTTP", () => {
    for (const value of [sessionCookie("sid-token", 3600), clearSessionCookie()]) {
      expect(value).toContain("SameSite=Lax;");
      expect(value).not.toContain("Secure;");
      expect(value).not.toContain("Partitioned;");
    }
  });
});
